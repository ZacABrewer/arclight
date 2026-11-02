// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.Collections.Generic;
using Jellyfin.Plugin.Arclight.Arclight;

namespace Jellyfin.Plugin.Arclight.Events;

/// <summary>
/// Decides what gets queued: applies the feature toggles, progress throttling, itemAdded deferral and
/// user-event de-duplication. Free of Jellyfin types so it is unit tested directly.
/// </summary>
public sealed class EventIngest
{
    /// <summary>How long an itemAdded waits for metadata before being sent without ids.</summary>
    public static readonly TimeSpan PendingMaxAge = TimeSpan.FromMinutes(10);

    private readonly EventQueue _queue;
    private readonly IArclightSettings _settings;
    private readonly ProgressThrottle _throttle = new();
    private readonly PendingItems _pending = new();
    private readonly TimeProvider _time;
    private readonly object _userLock = new();
    private readonly Dictionary<string, DateTimeOffset> _recentUserEvents = new(StringComparer.Ordinal);

    /// <summary>Initializes a new instance of the <see cref="EventIngest"/> class.</summary>
    /// <param name="queue">Queue.</param>
    /// <param name="settings">Settings.</param>
    /// <param name="time">Clock (tests).</param>
    public EventIngest(EventQueue queue, IArclightSettings settings, TimeProvider? time = null)
    {
        _queue = queue;
        _settings = settings;
        _time = time ?? TimeProvider.System;
    }

    /// <summary>Gets the pending-item tracker (diagnostics/tests).</summary>
    public PendingItems Pending => _pending;

    /// <summary>Gets the progress throttle (diagnostics/tests).</summary>
    public ProgressThrottle Throttle => _throttle;

    private bool Forwarding => _settings.Config.EnableEventForwarding && ArclightClient.TryBuildBase(_settings.ArclightUrl, out _) && _settings.ApiKey.Length > 0;

    /// <summary>Handles playback start.</summary>
    /// <param name="snapshot">Snapshot.</param>
    public void PlaybackStart(PlaybackSnapshot snapshot)
    {
        if (!Forwarding || !_settings.Config.EnablePlaybackEvents || snapshot.Item is null)
        {
            return;
        }

        var now = _time.GetUtcNow();
        _throttle.OnStart(snapshot.SessionId, snapshot.Item.Id, now);
        _queue.Enqueue(EventMapper.FromPlayback(EventTypes.PlaybackStart, snapshot, now));
    }

    /// <summary>Handles playback progress (throttled).</summary>
    /// <param name="snapshot">Snapshot.</param>
    public void PlaybackProgress(PlaybackSnapshot snapshot)
    {
        if (!Forwarding || !_settings.Config.EnablePlaybackEvents || snapshot.Item is null)
        {
            return;
        }

        var now = _time.GetUtcNow();
        var interval = TimeSpan.FromSeconds(Math.Clamp(_settings.Config.ProgressThrottleSeconds, 10, 600));
        if (_throttle.ShouldForward(snapshot.SessionId, snapshot.Item.Id, snapshot.IsPaused, now, interval))
        {
            _queue.Enqueue(EventMapper.FromPlayback(EventTypes.PlaybackProgress, snapshot, now));
        }
    }

    /// <summary>Handles playback stop.</summary>
    /// <param name="snapshot">Snapshot.</param>
    public void PlaybackStop(PlaybackSnapshot snapshot)
    {
        if (snapshot.Item is not null)
        {
            _throttle.OnStop(snapshot.SessionId, snapshot.Item.Id);
        }

        if (!Forwarding || !_settings.Config.EnablePlaybackEvents || snapshot.Item is null)
        {
            return;
        }

        _queue.Enqueue(EventMapper.FromPlayback(EventTypes.PlaybackStop, snapshot, _time.GetUtcNow()));
    }

    /// <summary>Handles a user-data save.</summary>
    /// <param name="reason">UserDataSaveReason name.</param>
    /// <param name="userId">User id.</param>
    /// <param name="userName">User name.</param>
    /// <param name="item">Item.</param>
    /// <param name="data">User data.</param>
    public void UserDataSaved(string reason, Guid userId, string? userName, EventItem item, UserDataSnapshot data)
    {
        if (!Forwarding || !_settings.Config.EnableUserDataEvents || !EventMapper.ShouldForwardUserData(reason) || userId == Guid.Empty)
        {
            return;
        }

        _queue.Enqueue(EventMapper.FromUserData(userId, userName, item, data, _time.GetUtcNow()));
    }

    /// <summary>Whether itemAdded events are wanted at all (lets the caller skip describing items).</summary>
    /// <param name="kind">Item kind name.</param>
    /// <param name="isVirtual">Virtual (missing) item.</param>
    /// <returns>True when the item would be forwarded.</returns>
    public bool WantsItemAdded(string kind, bool isVirtual) =>
        Forwarding && _settings.Config.EnableLibraryEvents && !isVirtual && ForwardedKinds.ItemAdded.Contains(kind);

    /// <summary>Handles a library item being added.</summary>
    /// <param name="itemId">Item id.</param>
    /// <param name="item">Description.</param>
    public void ItemAdded(Guid itemId, EventItem item)
    {
        if (!WantsItemAdded(item.Type, false))
        {
            return;
        }

        var now = _time.GetUtcNow();
        if (!EventMapper.HasMatchableIds(item) && _pending.Add(itemId, now))
        {
            return; // wait for metadata
        }

        _queue.Enqueue(EventMapper.FromItemAdded(item, now));
    }

    /// <summary>Handles an item update: releases a pending itemAdded once ids are known.</summary>
    /// <param name="itemId">Item id.</param>
    /// <param name="describe">Lazily describes the item.</param>
    public void ItemUpdated(Guid itemId, Func<EventItem> describe)
    {
        if (!_pending.Contains(itemId))
        {
            return;
        }

        var item = describe();
        if (EventMapper.HasMatchableIds(item) && _pending.Remove(itemId) && WantsItemAdded(item.Type, false))
        {
            _queue.Enqueue(EventMapper.FromItemAdded(item, _time.GetUtcNow()));
        }
    }

    /// <summary>Sends itemAdded for items that waited too long for metadata.</summary>
    /// <param name="describe">Describes an item by id (null when it no longer exists).</param>
    /// <returns>Number of events queued.</returns>
    public int ReleaseExpired(Func<Guid, EventItem?> describe)
    {
        var count = 0;
        var now = _time.GetUtcNow();
        foreach (var id in _pending.TakeExpired(now, PendingMaxAge))
        {
            if (describe(id) is { } item && WantsItemAdded(item.Type, false))
            {
                _queue.Enqueue(EventMapper.FromItemAdded(item, now));
                count++;
            }
        }

        return count;
    }

    /// <summary>Handles user created/updated/deleted. Duplicate notifications within 2 s are merged.</summary>
    /// <param name="type">Event type.</param>
    /// <param name="userId">User id.</param>
    /// <param name="userName">User name.</param>
    public void User(string type, Guid userId, string? userName)
    {
        if (!Forwarding || !_settings.Config.EnableUserEvents || userId == Guid.Empty)
        {
            return;
        }

        var now = _time.GetUtcNow();
        var key = type + "|" + userId.ToString("N");
        lock (_userLock)
        {
            if (_recentUserEvents.TryGetValue(key, out var last) && now - last < TimeSpan.FromSeconds(2))
            {
                return;
            }

            _recentUserEvents[key] = now;
            if (_recentUserEvents.Count > 500)
            {
                _recentUserEvents.Clear();
                _recentUserEvents[key] = now;
            }
        }

        _queue.Enqueue(EventMapper.FromUser(type, userId, userName, now));
    }
}

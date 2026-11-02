// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Events;
using Jellyfin.Plugin.Arclight.Arclight;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using JellyfinUser = Jellyfin.Database.Implementations.Entities.User;

namespace Jellyfin.Plugin.Arclight.Events;

/// <summary>
/// Subscribes to Jellyfin's session, user-data, library and user events, converts them to snapshots
/// and hands them to <see cref="EventIngest"/>. Every handler is wrapped so nothing ever throws back
/// into Jellyfin, and nothing here does I/O: delivery happens on the <see cref="EventSender"/> task.
/// </summary>
public sealed class EventForwarder : IHostedService, IDisposable
{
    private readonly ISessionManager _sessions;
    private readonly IUserDataManager _userData;
    private readonly ILibraryManager _library;
    private readonly IUserManager _users;
    private readonly EventIngest _ingest;
    private readonly EventSender _sender;
    private readonly EventQueue _queue;
    private readonly IArclightSettings _settings;
    private readonly ILogger<EventForwarder> _logger;
    private Timer? _expiryTimer;

    /// <summary>Initializes a new instance of the <see cref="EventForwarder"/> class.</summary>
    /// <param name="sessions">Session manager.</param>
    /// <param name="userData">User data manager.</param>
    /// <param name="library">Library manager.</param>
    /// <param name="users">User manager.</param>
    /// <param name="ingest">Ingest.</param>
    /// <param name="sender">Sender.</param>
    /// <param name="queue">Queue.</param>
    /// <param name="settings">Settings.</param>
    /// <param name="logger">Logger.</param>
    public EventForwarder(
        ISessionManager sessions,
        IUserDataManager userData,
        ILibraryManager library,
        IUserManager users,
        EventIngest ingest,
        EventSender sender,
        EventQueue queue,
        IArclightSettings settings,
        ILogger<EventForwarder> logger)
    {
        _sessions = sessions;
        _userData = userData;
        _library = library;
        _users = users;
        _ingest = ingest;
        _sender = sender;
        _queue = queue;
        _settings = settings;
        _logger = logger;
    }

    /// <inheritdoc />
    public Task StartAsync(CancellationToken cancellationToken)
    {
        _sessions.PlaybackStart += OnPlaybackStart;
        _sessions.PlaybackProgress += OnPlaybackProgress;
        _sessions.PlaybackStopped += OnPlaybackStopped;
        _userData.UserDataSaved += OnUserDataSaved;
        _library.ItemAdded += OnItemAdded;
        _library.ItemUpdated += OnItemUpdated;
        _users.OnUserUpdated += OnUserUpdated;
        _queue.Capacity = Math.Clamp(_settings.Config.MaxQueueSize, 500, 50000);
        if (Plugin.Instance is { } plugin)
        {
            plugin.ConfigurationChanged += OnConfigurationChanged;
        }

        _expiryTimer = new Timer(_ => Safe("expiry", ReleaseExpired), null, TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(30));
        _sender.Start();
        _logger.LogInformation("Arclight event forwarder started");
        return Task.CompletedTask;
    }

    /// <inheritdoc />
    public async Task StopAsync(CancellationToken cancellationToken)
    {
        _sessions.PlaybackStart -= OnPlaybackStart;
        _sessions.PlaybackProgress -= OnPlaybackProgress;
        _sessions.PlaybackStopped -= OnPlaybackStopped;
        _userData.UserDataSaved -= OnUserDataSaved;
        _library.ItemAdded -= OnItemAdded;
        _library.ItemUpdated -= OnItemUpdated;
        _users.OnUserUpdated -= OnUserUpdated;
        if (Plugin.Instance is { } plugin)
        {
            plugin.ConfigurationChanged -= OnConfigurationChanged;
        }

        if (_expiryTimer is not null)
        {
            await _expiryTimer.DisposeAsync().ConfigureAwait(false);
            _expiryTimer = null;
        }

        await _sender.StopAsync().ConfigureAwait(false);
    }

    /// <inheritdoc />
    public void Dispose()
    {
        _expiryTimer?.Dispose();
    }

    private static PlaybackSnapshot Snapshot(PlaybackProgressEventArgs e)
    {
        var users = (e.Users ?? new List<JellyfinUser>())
            .Where(u => u is not null)
            .Select(u => (u.Id, u.Username ?? string.Empty))
            .ToList();
        if (users.Count == 0 && e.Session is { } s && s.UserId != Guid.Empty)
        {
            users.Add((s.UserId, s.UserName ?? string.Empty));
        }

        return new PlaybackSnapshot
        {
            SessionId = e.Session?.Id,
            Users = users,
            Item = e.Item is null ? null : ItemDescriber.Describe(e.Item),
            PositionTicks = e.PlaybackPositionTicks,
            IsPaused = e.IsPaused,
            Client = e.ClientName ?? e.Session?.Client,
            DeviceName = e.DeviceName ?? e.Session?.DeviceName,
            PlayMethod = e.Session?.PlayState?.PlayMethod?.ToString(),
            PlayedToCompletion = e is PlaybackStopEventArgs stop ? stop.PlayedToCompletion : null,
        };
    }

    private void OnConfigurationChanged(object? sender, MediaBrowser.Model.Plugins.BasePluginConfiguration e) => Safe("config", () =>
    {
        _queue.Capacity = Math.Clamp(_settings.Config.MaxQueueSize, 500, 50000);
        _sender.Signal();
    });

    private void OnPlaybackStart(object? sender, PlaybackProgressEventArgs e) => Safe("playbackStart", () => _ingest.PlaybackStart(Snapshot(e)));

    private void OnPlaybackProgress(object? sender, PlaybackProgressEventArgs e) => Safe("playbackProgress", () => _ingest.PlaybackProgress(Snapshot(e)));

    private void OnPlaybackStopped(object? sender, PlaybackStopEventArgs e) => Safe("playbackStop", () => _ingest.PlaybackStop(Snapshot(e)));

    private void OnUserDataSaved(object? sender, UserDataSaveEventArgs e) => Safe("userDataSaved", () =>
    {
        if (e.Item is null || e.UserData is null)
        {
            return;
        }

        var reason = e.SaveReason.ToString();
        if (!EventMapper.ShouldForwardUserData(reason))
        {
            return;
        }

        var user = _users.GetUserById(e.UserId);
        var data = new UserDataSnapshot(e.UserData.Played, e.UserData.PlayCount, e.UserData.IsFavorite, e.UserData.PlaybackPositionTicks);
        _ingest.UserDataSaved(reason, e.UserId, user?.Username, ItemDescriber.Describe(e.Item), data);
    });

    private void OnItemAdded(object? sender, ItemChangeEventArgs e) => Safe("itemAdded", () =>
    {
        if (e.Item is not { } item || !_ingest.WantsItemAdded(item.GetBaseItemKind().ToString(), item.IsVirtualItem))
        {
            return;
        }

        _ingest.ItemAdded(item.Id, ItemDescriber.Describe(item));
    });

    private void OnItemUpdated(object? sender, ItemChangeEventArgs e) => Safe("itemUpdated", () =>
    {
        if (e.Item is { } item)
        {
            _ingest.ItemUpdated(item.Id, () => ItemDescriber.Describe(item));
        }
    });

    private void OnUserUpdated(object? sender, GenericEventArgs<JellyfinUser> e) => Safe("userUpdated", () =>
    {
        if (e.Argument is { } u)
        {
            _ingest.User(EventTypes.UserUpdated, u.Id, u.Username);
        }
    });

    private void ReleaseExpired()
    {
        if (_ingest.Pending.Count == 0)
        {
            return;
        }

        _ingest.ReleaseExpired(id => _library.GetItemById(id) is BaseItem item ? ItemDescriber.Describe(item) : null);
    }

    private void Safe(string what, Action action)
    {
        try
        {
            action();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Arclight: failed to handle {Event}", what);
        }
    }
}

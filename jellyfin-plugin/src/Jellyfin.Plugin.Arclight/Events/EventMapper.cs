// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.Collections.Generic;
using System.Globalization;

namespace Jellyfin.Plugin.Arclight.Events;

/// <summary>Turns Jellyfin-side snapshots into Arclight events. Pure functions; unit tested.</summary>
public static class EventMapper
{
    /// <summary>Formats a timestamp as ISO-8601 UTC with millisecond precision.</summary>
    /// <param name="at">Time.</param>
    /// <returns>e.g. 2026-11-01T12:00:00.000Z.</returns>
    public static string FormatTime(DateTimeOffset at) => at.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    /// <summary>Normalises a Jellyfin play method name to the contract values.</summary>
    /// <param name="playMethod">Jellyfin enum name.</param>
    /// <returns>DirectPlay, DirectStream, Transcode, or null.</returns>
    public static string? NormalizePlayMethod(string? playMethod) => playMethod switch
    {
        "DirectPlay" => "DirectPlay",
        "DirectStream" => "DirectStream",
        "Transcode" => "Transcode",
        _ => null,
    };

    /// <summary>Keeps non-empty provider ids only (a copy, so later metadata edits do not leak in).</summary>
    /// <param name="providerIds">Jellyfin provider ids.</param>
    /// <returns>Cleaned dictionary.</returns>
    public static Dictionary<string, string> CleanProviderIds(IReadOnlyDictionary<string, string>? providerIds)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        if (providerIds is null)
        {
            return result;
        }

        foreach (var (key, value) in providerIds)
        {
            if (!string.IsNullOrWhiteSpace(key) && !string.IsNullOrWhiteSpace(value) && key.Length <= 64 && value.Length <= 256)
            {
                result[key] = value.Trim();
            }
        }

        return result;
    }

    /// <summary>Whether an item has at least one id Arclight can match on (for itemAdded deferral).</summary>
    /// <param name="item">Item.</param>
    /// <returns>True when Tmdb/Tvdb/Imdb is known (for episodes/seasons: on the series).</returns>
    public static bool HasMatchableIds(EventItem item)
    {
        static bool Has(Dictionary<string, string>? ids) => ids is not null && (ids.ContainsKey("Tmdb") || ids.ContainsKey("Tvdb") || ids.ContainsKey("Imdb"));
        return item.Type is "Episode" or "Season" ? Has(item.SeriesProviderIds) : Has(item.ProviderIds);
    }

    /// <summary>Builds one event per watching user from a playback snapshot.</summary>
    /// <param name="type">playbackStart, playbackProgress or playbackStop.</param>
    /// <param name="snapshot">Snapshot.</param>
    /// <param name="at">Event time.</param>
    /// <returns>Events (empty when there is no user or no item).</returns>
    public static List<ArclightEvent> FromPlayback(string type, PlaybackSnapshot snapshot, DateTimeOffset at)
    {
        var list = new List<ArclightEvent>();
        if (snapshot.Item is null)
        {
            return list;
        }

        foreach (var (id, name) in snapshot.Users)
        {
            if (id == Guid.Empty)
            {
                continue;
            }

            list.Add(new ArclightEvent
            {
                Type = type,
                At = FormatTime(at),
                JellyfinUserId = id.ToString("N"),
                UserName = string.IsNullOrEmpty(name) ? null : name,
                Item = snapshot.Item,
                PositionTicks = snapshot.PositionTicks,
                Played = type == EventTypes.PlaybackStop ? snapshot.PlayedToCompletion : null,
                Client = snapshot.Client,
                DeviceName = snapshot.DeviceName,
                PlayMethod = NormalizePlayMethod(snapshot.PlayMethod),
                SessionId = snapshot.SessionId,
            });
        }

        return list;
    }

    /// <summary>Builds a userDataSaved event.</summary>
    /// <param name="userId">User id.</param>
    /// <param name="userName">User name.</param>
    /// <param name="item">Item.</param>
    /// <param name="data">User data.</param>
    /// <param name="at">Event time.</param>
    /// <returns>The event.</returns>
    public static ArclightEvent FromUserData(Guid userId, string? userName, EventItem item, UserDataSnapshot data, DateTimeOffset at) => new()
    {
        Type = EventTypes.UserDataSaved,
        At = FormatTime(at),
        JellyfinUserId = userId.ToString("N"),
        UserName = string.IsNullOrEmpty(userName) ? null : userName,
        Item = item,
        PositionTicks = data.PositionTicks,
        Played = data.Played,
        PlayCount = data.PlayCount,
        IsFavorite = data.IsFavorite,
    };

    /// <summary>Whether a Jellyfin user-data save reason should be forwarded.</summary>
    /// <param name="reason">The UserDataSaveReason name.</param>
    /// <returns>False for reasons already covered by playback events.</returns>
    public static bool ShouldForwardUserData(string reason) => reason is "TogglePlayed" or "UpdateUserRating" or "PlaybackFinished" or "UpdateUserData" or "Import";

    /// <summary>Builds an itemAdded event.</summary>
    /// <param name="item">Item.</param>
    /// <param name="at">Event time.</param>
    /// <returns>The event.</returns>
    public static ArclightEvent FromItemAdded(EventItem item, DateTimeOffset at) => new()
    {
        Type = EventTypes.ItemAdded,
        At = FormatTime(at),
        Item = item,
    };

    /// <summary>Builds a user lifecycle event.</summary>
    /// <param name="type">userCreated, userUpdated or userDeleted.</param>
    /// <param name="userId">User id.</param>
    /// <param name="userName">User name.</param>
    /// <param name="at">Event time.</param>
    /// <returns>The event.</returns>
    public static ArclightEvent FromUser(string type, Guid userId, string? userName, DateTimeOffset at) => new()
    {
        Type = type,
        At = FormatTime(at),
        JellyfinUserId = userId.ToString("N"),
        UserName = string.IsNullOrEmpty(userName) ? null : userName,
    };
}

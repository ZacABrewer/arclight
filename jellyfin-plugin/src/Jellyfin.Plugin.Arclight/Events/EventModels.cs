// SPDX-License-Identifier: GPL-3.0-or-later
using System.Collections.Generic;

namespace Jellyfin.Plugin.Arclight.Events;

/// <summary>Event type names exactly as Arclight expects them.</summary>
public static class EventTypes
{
    /// <summary>Playback started.</summary>
    public const string PlaybackStart = "playbackStart";

    /// <summary>Playback progress (throttled).</summary>
    public const string PlaybackProgress = "playbackProgress";

    /// <summary>Playback stopped.</summary>
    public const string PlaybackStop = "playbackStop";

    /// <summary>Played/favourite/position changed outside playback.</summary>
    public const string UserDataSaved = "userDataSaved";

    /// <summary>Library item added.</summary>
    public const string ItemAdded = "itemAdded";

    /// <summary>User created.</summary>
    public const string UserCreated = "userCreated";

    /// <summary>User updated.</summary>
    public const string UserUpdated = "userUpdated";

    /// <summary>User deleted.</summary>
    public const string UserDeleted = "userDeleted";
}

/// <summary>An item as described to Arclight.</summary>
public sealed class EventItem
{
    /// <summary>Gets or sets the Jellyfin item id (Guid "N" format).</summary>
    public string Id { get; set; } = string.Empty;

    /// <summary>Gets or sets the Jellyfin item kind (Movie, Series, Season, Episode, ...).</summary>
    public string Type { get; set; } = string.Empty;

    /// <summary>Gets or sets the item name.</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>Gets or sets provider ids as Jellyfin stores them (keys such as Tmdb, Tvdb, Imdb).</summary>
    public Dictionary<string, string> ProviderIds { get; set; } = new();

    /// <summary>Gets or sets the series provider ids (seasons and episodes).</summary>
    public Dictionary<string, string>? SeriesProviderIds { get; set; }

    /// <summary>Gets or sets the season number (seasons and episodes).</summary>
    public int? SeasonNumber { get; set; }

    /// <summary>Gets or sets the episode number (episodes).</summary>
    public int? EpisodeNumber { get; set; }

    /// <summary>Gets or sets the runtime in ticks (100 ns).</summary>
    public long? RunTimeTicks { get; set; }
}

/// <summary>One event in a batch posted to <c>/api/v1/jellyfin/events</c>.</summary>
public sealed class ArclightEvent
{
    /// <summary>Gets or sets the event type (see <see cref="EventTypes"/>).</summary>
    public string Type { get; set; } = string.Empty;

    /// <summary>Gets or sets the ISO-8601 UTC timestamp.</summary>
    public string At { get; set; } = string.Empty;

    /// <summary>Gets or sets the Jellyfin user id (Guid "N" format).</summary>
    public string? JellyfinUserId { get; set; }

    /// <summary>Gets or sets the Jellyfin user name.</summary>
    public string? UserName { get; set; }

    /// <summary>Gets or sets the item.</summary>
    public EventItem? Item { get; set; }

    /// <summary>Gets or sets the playback position in ticks.</summary>
    public long? PositionTicks { get; set; }

    /// <summary>Gets or sets whether the item is played.</summary>
    public bool? Played { get; set; }

    /// <summary>Gets or sets the play count.</summary>
    public int? PlayCount { get; set; }

    /// <summary>Gets or sets whether the item is a favourite.</summary>
    public bool? IsFavorite { get; set; }

    /// <summary>Gets or sets the client name.</summary>
    public string? Client { get; set; }

    /// <summary>Gets or sets the device name.</summary>
    public string? DeviceName { get; set; }

    /// <summary>Gets or sets the play method (DirectPlay, DirectStream, Transcode).</summary>
    public string? PlayMethod { get; set; }

    /// <summary>Gets or sets the Jellyfin session id.</summary>
    public string? SessionId { get; set; }
}

/// <summary>The batch body.</summary>
public sealed class EventBatch
{
    /// <summary>Gets or sets the Jellyfin server id.</summary>
    public string ServerId { get; set; } = string.Empty;

    /// <summary>Gets or sets the events (at most 500).</summary>
    public IReadOnlyList<ArclightEvent> Events { get; set; } = new List<ArclightEvent>();
}

/// <summary>A snapshot of the Jellyfin user-data fields that matter to Arclight.</summary>
/// <param name="Played">Played flag.</param>
/// <param name="PlayCount">Play count.</param>
/// <param name="IsFavorite">Favourite flag.</param>
/// <param name="PositionTicks">Resume position.</param>
public sealed record UserDataSnapshot(bool Played, int PlayCount, bool IsFavorite, long PositionTicks);

/// <summary>A snapshot of a playback event, decoupled from Jellyfin types so it can be unit tested.</summary>
public sealed class PlaybackSnapshot
{
    /// <summary>Gets or sets the session id.</summary>
    public string? SessionId { get; set; }

    /// <summary>Gets or sets the users watching (id, name).</summary>
    public IReadOnlyList<(System.Guid Id, string Name)> Users { get; set; } = System.Array.Empty<(System.Guid, string)>();

    /// <summary>Gets or sets the item.</summary>
    public EventItem? Item { get; set; }

    /// <summary>Gets or sets the position.</summary>
    public long? PositionTicks { get; set; }

    /// <summary>Gets or sets a value indicating whether playback is paused.</summary>
    public bool IsPaused { get; set; }

    /// <summary>Gets or sets the client name.</summary>
    public string? Client { get; set; }

    /// <summary>Gets or sets the device name.</summary>
    public string? DeviceName { get; set; }

    /// <summary>Gets or sets the play method.</summary>
    public string? PlayMethod { get; set; }

    /// <summary>Gets or sets a value indicating whether the stop was played to completion.</summary>
    public bool? PlayedToCompletion { get; set; }
}

/// <summary>Kinds of items whose addition is forwarded.</summary>
public static class ForwardedKinds
{
    /// <summary>Item kinds forwarded for <c>itemAdded</c>.</summary>
    public static readonly IReadOnlySet<string> ItemAdded = new HashSet<string>(System.StringComparer.Ordinal)
    {
        "Movie", "Series", "Season", "Episode", "MusicAlbum", "AudioBook", "Book",
    };
}

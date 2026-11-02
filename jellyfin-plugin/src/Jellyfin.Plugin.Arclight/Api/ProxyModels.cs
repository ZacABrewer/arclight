// SPDX-License-Identifier: GPL-3.0-or-later
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.Arclight.Api;

/// <summary>Browser body for POST /Arclight/Request.</summary>
public sealed class RequestBody
{
    /// <summary>Gets or sets "movie" or "series".</summary>
    [JsonPropertyName("mediaType")]
    public string? MediaType { get; set; }

    /// <summary>Gets or sets the TMDB id.</summary>
    [JsonPropertyName("tmdbId")]
    public int TmdbId { get; set; }

    /// <summary>Gets or sets seasons: an array of numbers or the string "all" (series only).</summary>
    [JsonPropertyName("seasons")]
    public JsonElement? Seasons { get; set; }

    /// <summary>Gets or sets whether to request the 4K version.</summary>
    [JsonPropertyName("is4k")]
    public bool? Is4k { get; set; }

    /// <summary>Gets or sets a quality profile (Arclight honours it only for users allowed advanced requests).</summary>
    [JsonPropertyName("qualityProfileId")]
    public int? QualityProfileId { get; set; }
}

/// <summary>Browser body for POST /Arclight/LanguageRequest.</summary>
public sealed class LanguageRequestBody
{
    /// <summary>Gets or sets "subtitle" or "audio".</summary>
    [JsonPropertyName("kind")]
    public string? Kind { get; set; }

    /// <summary>Gets or sets "movie" or "series".</summary>
    [JsonPropertyName("mediaType")]
    public string? MediaType { get; set; }

    /// <summary>Gets or sets the TMDB id.</summary>
    [JsonPropertyName("tmdbId")]
    public int TmdbId { get; set; }

    /// <summary>Gets or sets the season (series only, optional).</summary>
    [JsonPropertyName("seasonNumber")]
    public int? SeasonNumber { get; set; }

    /// <summary>Gets or sets the language (code or name).</summary>
    [JsonPropertyName("language")]
    public string? Language { get; set; }
}

/// <summary>Browser body for POST /Arclight/Issue.</summary>
public sealed class IssueBody
{
    /// <summary>Gets or sets "movie" or "series".</summary>
    [JsonPropertyName("mediaType")]
    public string? MediaType { get; set; }

    /// <summary>Gets or sets the TMDB id.</summary>
    [JsonPropertyName("tmdbId")]
    public int TmdbId { get; set; }

    /// <summary>Gets or sets the season.</summary>
    [JsonPropertyName("seasonNumber")]
    public int? SeasonNumber { get; set; }

    /// <summary>Gets or sets the episode.</summary>
    [JsonPropertyName("episodeNumber")]
    public int? EpisodeNumber { get; set; }

    /// <summary>Gets or sets the issue type (video, audio, subtitles, other).</summary>
    [JsonPropertyName("type")]
    public string? Type { get; set; }

    /// <summary>Gets or sets the message.</summary>
    [JsonPropertyName("message")]
    public string? Message { get; set; }
}

/// <summary>Browser body for POST /Arclight/Watchlist.</summary>
public sealed class WatchlistBody
{
    /// <summary>Gets or sets "movie" or "series".</summary>
    [JsonPropertyName("mediaType")]
    public string? MediaType { get; set; }

    /// <summary>Gets or sets the TMDB id.</summary>
    [JsonPropertyName("tmdbId")]
    public int TmdbId { get; set; }
}

/// <summary>Browser body for POST /Arclight/Status.</summary>
public sealed class StatusBody
{
    /// <summary>Gets or sets Jellyfin item ids (at most 100).</summary>
    [JsonPropertyName("itemIds")]
    public List<string>? ItemIds { get; set; }
}

/// <summary>Admin body for POST /Arclight/Admin/ApiKey.</summary>
public sealed class ApiKeyBody
{
    /// <summary>Gets or sets the new key (empty clears it).</summary>
    [JsonPropertyName("apiKey")]
    public string? ApiKey { get; set; }
}

/// <summary>Admin body for POST /Arclight/Admin/TestConnection.</summary>
public sealed class TestConnectionBody
{
    /// <summary>Gets or sets a URL to test instead of the saved one.</summary>
    [JsonPropertyName("url")]
    public string? Url { get; set; }

    /// <summary>Gets or sets a key to test instead of the saved one.</summary>
    [JsonPropertyName("apiKey")]
    public string? ApiKey { get; set; }
}

/// <summary>Item descriptor sent to Arclight's /status (exact contract).</summary>
/// <param name="Id">Jellyfin item id ("N" format).</param>
/// <param name="Type">Jellyfin item kind.</param>
/// <param name="ProviderIds">Provider ids.</param>
public sealed record StatusItem(
    string Id,
    string Type,
    Dictionary<string, string> ProviderIds,
    Dictionary<string, string>? SeriesProviderIds = null,
    int? SeasonNumber = null,
    int? EpisodeNumber = null);

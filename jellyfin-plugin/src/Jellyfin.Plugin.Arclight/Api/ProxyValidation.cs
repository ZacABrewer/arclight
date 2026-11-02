// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Text.Json;

namespace Jellyfin.Plugin.Arclight.Api;

/// <summary>
/// Validates browser input and rebuilds the bodies sent to Arclight from known fields only (nothing
/// the browser sends is passed through verbatim). Pure; unit tested.
/// </summary>
public static class ProxyValidation
{
    /// <summary>Maximum search query length.</summary>
    public const int MaxQueryLength = 200;

    /// <summary>Maximum issue message length.</summary>
    public const int MaxMessageLength = 5000;

    private static readonly HashSet<string> IssueTypes = new(StringComparer.Ordinal) { "video", "audio", "subtitles", "other" };

    /// <summary>Whether a media type is valid for title-level calls.</summary>
    /// <param name="mediaType">Value.</param>
    /// <returns>True for movie/series.</returns>
    public static bool IsMediaType(string? mediaType) => mediaType is "movie" or "series";

    /// <summary>Whether a TMDB id is plausible.</summary>
    /// <param name="tmdbId">Value.</param>
    /// <returns>True when positive.</returns>
    public static bool IsTmdbId(int tmdbId) => tmdbId > 0;

    /// <summary>Builds the Arclight search path, or null when the input is invalid.</summary>
    /// <param name="q">Query.</param>
    /// <param name="type">movie, series or all (default all).</param>
    /// <param name="page">Page (default 1).</param>
    /// <returns>Relative path with query string, or null.</returns>
    public static string? SearchPath(string? q, string? type, int? page)
    {
        var query = (q ?? string.Empty).Trim();
        if (query.Length == 0 || query.Length > MaxQueryLength)
        {
            return null;
        }

        var t = string.IsNullOrEmpty(type) ? "all" : type;
        if (t is not ("movie" or "series" or "all"))
        {
            return null;
        }

        var p = page ?? 1;
        if (p is < 1 or > 500)
        {
            return null;
        }

        return "search?q=" + Uri.EscapeDataString(query) + "&type=" + t + "&page=" + p.ToString(CultureInfo.InvariantCulture);
    }

    /// <summary>Builds the Arclight request body.</summary>
    /// <param name="body">Browser body.</param>
    /// <param name="result">Arclight body.</param>
    /// <param name="error">Error code.</param>
    /// <returns>Whether valid.</returns>
    public static bool TryBuildRequest(RequestBody? body, out Dictionary<string, object> result, out string error)
    {
        result = new Dictionary<string, object>();
        error = string.Empty;
        if (body is null || !IsMediaType(body.MediaType) || !IsTmdbId(body.TmdbId))
        {
            error = "invalid_title";
            return false;
        }

        result["mediaType"] = body.MediaType!;
        result["tmdbId"] = body.TmdbId;
        if (body.Seasons is { } seasons && seasons.ValueKind is not (JsonValueKind.Null or JsonValueKind.Undefined))
        {
            if (body.MediaType != "series")
            {
                error = "seasons_series_only";
                return false;
            }

            if (seasons.ValueKind == JsonValueKind.String && seasons.GetString() == "all")
            {
                result["seasons"] = "all";
            }
            else if (seasons.ValueKind == JsonValueKind.Array)
            {
                var list = new SortedSet<int>();
                foreach (var s in seasons.EnumerateArray())
                {
                    if (s.ValueKind != JsonValueKind.Number || !s.TryGetInt32(out var n) || n < 0 || n > 1000 || list.Count >= 200)
                    {
                        error = "invalid_seasons";
                        return false;
                    }

                    list.Add(n);
                }

                if (list.Count == 0)
                {
                    error = "invalid_seasons";
                    return false;
                }

                result["seasons"] = new List<int>(list);
            }
            else
            {
                error = "invalid_seasons";
                return false;
            }
        }

        if (body.Is4k == true)
        {
            result["is4k"] = true;
        }

        if (body.QualityProfileId is { } profile)
        {
            if (profile <= 0)
            {
                error = "invalid_profile";
                return false;
            }

            result["qualityProfileId"] = profile;
        }

        return true;
    }

    /// <summary>Builds the Arclight language-request body.</summary>
    /// <param name="body">Browser body.</param>
    /// <param name="result">Arclight body.</param>
    /// <param name="error">Error code.</param>
    /// <returns>Whether valid.</returns>
    public static bool TryBuildLanguageRequest(LanguageRequestBody? body, out Dictionary<string, object> result, out string error)
    {
        result = new Dictionary<string, object>();
        error = string.Empty;
        if (body is null || !IsMediaType(body.MediaType) || !IsTmdbId(body.TmdbId))
        {
            error = "invalid_title";
            return false;
        }

        if (body.Kind is not ("subtitle" or "audio"))
        {
            error = "invalid_kind";
            return false;
        }

        var language = (body.Language ?? string.Empty).Trim();
        if (language.Length is < 2 or > 64 || !IsPlainText(language))
        {
            error = "invalid_language";
            return false;
        }

        result["kind"] = body.Kind;
        result["mediaType"] = body.MediaType!;
        result["tmdbId"] = body.TmdbId;
        result["language"] = language;
        if (body.SeasonNumber is { } season)
        {
            if (body.MediaType != "series" || season is < 0 or > 1000)
            {
                error = "invalid_season";
                return false;
            }

            result["seasonNumber"] = season;
        }

        return true;
    }

    /// <summary>Builds the Arclight issue body.</summary>
    /// <param name="body">Browser body.</param>
    /// <param name="result">Arclight body.</param>
    /// <param name="error">Error code.</param>
    /// <returns>Whether valid.</returns>
    public static bool TryBuildIssue(IssueBody? body, out Dictionary<string, object> result, out string error)
    {
        result = new Dictionary<string, object>();
        error = string.Empty;
        if (body is null || !IsMediaType(body.MediaType) || !IsTmdbId(body.TmdbId))
        {
            error = "invalid_title";
            return false;
        }

        if (body.Type is null || !IssueTypes.Contains(body.Type))
        {
            error = "invalid_type";
            return false;
        }

        var message = (body.Message ?? string.Empty).Trim();
        if (message.Length is 0 or > MaxMessageLength)
        {
            error = "invalid_message";
            return false;
        }

        result["mediaType"] = body.MediaType!;
        result["tmdbId"] = body.TmdbId;
        result["type"] = body.Type;
        result["message"] = message;
        if (body.SeasonNumber is { } season)
        {
            if (body.MediaType != "series" || season is < 0 or > 1000)
            {
                error = "invalid_season";
                return false;
            }

            result["seasonNumber"] = season;
        }

        if (body.EpisodeNumber is { } episode)
        {
            if (body.MediaType != "series" || body.SeasonNumber is null || episode is < 0 or > 100000)
            {
                error = "invalid_episode";
                return false;
            }

            result["episodeNumber"] = episode;
        }

        return true;
    }

    /// <summary>Parses up to 100 Jellyfin item ids.</summary>
    /// <param name="ids">Raw ids.</param>
    /// <param name="result">Parsed ids (deduplicated).</param>
    /// <returns>Whether valid.</returns>
    public static bool TryParseItemIds(IReadOnlyList<string>? ids, out List<Guid> result)
    {
        result = new List<Guid>();
        if (ids is null || ids.Count is 0 or > 100)
        {
            return false;
        }

        var seen = new HashSet<Guid>();
        foreach (var raw in ids)
        {
            if (!Guid.TryParse(raw, out var id) || id == Guid.Empty)
            {
                return false;
            }

            if (seen.Add(id))
            {
                result.Add(id);
            }
        }

        return true;
    }

    /// <summary>
    /// Makes an upstream body safe to return: JSON passes through, anything else becomes a generic
    /// JSON error (never reflect an HTML error page from a reverse proxy).
    /// </summary>
    /// <param name="status">Upstream status (0 = unreachable).</param>
    /// <param name="body">Upstream body.</param>
    /// <returns>Status and body for the browser.</returns>
    public static (int Status, string Body) ToBrowser(int status, string body)
    {
        // 401 from Arclight means the plugin's API key is wrong. Never hand a 401 to Jellyfin Web:
        // clients treat 401 as "your Jellyfin session expired".
        var mapped = status switch
        {
            0 => 502,
            401 => 502,
            _ => status,
        };

        var trimmed = body.AsSpan().TrimStart();
        var isJson = trimmed.Length > 0 && (trimmed[0] == '{' || trimmed[0] == '[');
        if (isJson)
        {
            try
            {
                using var _ = JsonDocument.Parse(body);
            }
            catch (JsonException)
            {
                isJson = false;
            }
        }

        if (status == 401)
        {
            return (mapped, "{\"code\":\"arclight_auth_failed\"}");
        }

        if (!isJson)
        {
            if (status is >= 200 and < 300 && body.Length == 0)
            {
                return (status == 204 ? 200 : status, "{}");
            }

            return (mapped, "{\"code\":\"upstream_error\",\"status\":" + status.ToString(CultureInfo.InvariantCulture) + "}");
        }

        return (mapped, body);
    }

    private static bool IsPlainText(string value)
    {
        foreach (var r in value.EnumerateRunes())
        {
            if (Rune.IsControl(r))
            {
                return false;
            }
        }

        return true;
    }
}

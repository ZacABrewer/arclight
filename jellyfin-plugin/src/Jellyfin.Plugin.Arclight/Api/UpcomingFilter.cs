// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json.Nodes;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.Arclight.Api;

/// <summary>
/// "Coming soon" lists what is not here yet. Arclight already leaves out releases it has on disk;
/// this also drops anything this Jellyfin already holds (files added outside Arclight, or a disc
/// release of a movie that is already in the library).
/// </summary>
public static class UpcomingFilter
{
    /// <summary>Removes items the library already has from Arclight's upcoming response.</summary>
    /// <param name="json">The `/upcoming` response body: <c>{ days, items: [...] }</c>.</param>
    /// <param name="hasMovie">True when the library has the movie with this TMDB id.</param>
    /// <param name="hasEpisode">True when the library has this episode (series TMDB id, season, episode).</param>
    /// <returns>The filtered body, or the input unchanged when it is not the expected shape.</returns>
    public static string Filter(string json, Func<int, bool> hasMovie, Func<int, int, int, bool> hasEpisode)
    {
        if (JsonNode.Parse(json) is not JsonObject root || root["items"] is not JsonArray items)
        {
            return json;
        }

        var keep = new JsonArray();
        foreach (var node in items.ToList())
        {
            items.Remove(node);
            if (node is JsonObject item && !Present(item, hasMovie, hasEpisode))
            {
                keep.Add(item);
            }
        }

        root["items"] = keep;
        return root.ToJsonString();
    }

    private static bool Present(JsonObject item, Func<int, bool> hasMovie, Func<int, int, int, bool> hasEpisode)
    {
        var tmdb = Int(item["tmdbId"]);
        if (tmdb is null)
        {
            return false;
        }

        return (string?)item["kind"] switch
        {
            "movie" => hasMovie(tmdb.Value),
            "episode" => Int(item["seasonNumber"]) is { } s && Int(item["episodeNumber"]) is { } e && hasEpisode(tmdb.Value, s, e),
            _ => false,
        };
    }

    private static int? Int(JsonNode? node)
        => node is JsonValue v && v.TryGetValue<int>(out var i) ? i : null;
}

/// <summary>TMDB ids of the movies and series in the Jellyfin library, refreshed every few minutes (singleton).</summary>
public sealed class LibraryTmdbIndex
{
    private static readonly TimeSpan MaxAge = TimeSpan.FromMinutes(10);
    private readonly ILibraryManager _library;
    private readonly object _gate = new();
    private DateTime _builtAt = DateTime.MinValue;
    private HashSet<int> _movies = new();
    private Dictionary<int, List<Series>> _series = new();

    /// <summary>Initializes a new instance of the <see cref="LibraryTmdbIndex"/> class.</summary>
    /// <param name="library">Jellyfin library manager.</param>
    public LibraryTmdbIndex(ILibraryManager library) => _library = library;

    /// <summary>True when a real (not virtual) movie with this TMDB id is in the library.</summary>
    /// <param name="tmdbId">TMDB id.</param>
    /// <returns>Whether the library has it.</returns>
    public bool HasMovie(int tmdbId)
    {
        Refresh();
        return _movies.Contains(tmdbId);
    }

    /// <summary>True when the series with this TMDB id has this episode as a real file.</summary>
    /// <param name="seriesTmdbId">Series TMDB id.</param>
    /// <param name="season">Season number.</param>
    /// <param name="episode">Episode number.</param>
    /// <returns>Whether the library has it.</returns>
    public bool HasEpisode(int seriesTmdbId, int season, int episode)
    {
        Refresh();
        if (!_series.TryGetValue(seriesTmdbId, out var shows))
        {
            return false;
        }

        // Missing episodes Jellyfin shows as placeholders are virtual items, so they still count as coming soon.
        return shows.Any(show => show
            .GetRecursiveChildren(i => i is Episode ep && !ep.IsVirtualItem && ep.ParentIndexNumber == season && ep.IndexNumber == episode)
            .Count > 0);
    }

    private void Refresh()
    {
        lock (_gate)
        {
            if (DateTime.UtcNow - _builtAt < MaxAge)
            {
                return;
            }

            var movies = new HashSet<int>();
            var series = new Dictionary<int, List<Series>>();
            // One indexed database query (BaseItemKind lives in Jellyfin.Data.Enums on 10.11 and 12.x alike).
            var query = new InternalItemsQuery
            {
                IncludeItemTypes = new[] { BaseItemKind.Movie, BaseItemKind.Series },
                Recursive = true,
                IsVirtualItem = false,
                HasTmdbId = true,
            };
            foreach (var item in _library.GetItemList(query))
            {
                if (item.IsVirtualItem || TmdbOf(item) is not { } id)
                {
                    continue;
                }

                if (item is Movie)
                {
                    movies.Add(id);
                }
                else if (item is Series show)
                {
                    if (!series.TryGetValue(id, out var list))
                    {
                        series[id] = list = new List<Series>();
                    }

                    list.Add(show);
                }
            }

            _movies = movies;
            _series = series;
            _builtAt = DateTime.UtcNow;
        }
    }

    private static int? TmdbOf(BaseItem item)
        => item.ProviderIds is { } ids && ids.TryGetValue("Tmdb", out var raw) && int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var id) ? id : null;
}

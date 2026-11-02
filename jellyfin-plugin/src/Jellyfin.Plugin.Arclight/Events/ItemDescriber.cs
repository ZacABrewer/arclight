// SPDX-License-Identifier: GPL-3.0-or-later
using System.Collections.Generic;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;

namespace Jellyfin.Plugin.Arclight.Events;

/// <summary>Builds the Arclight description of a Jellyfin library item.</summary>
public static class ItemDescriber
{
    /// <summary>Describes an item, including the series provider ids for seasons and episodes.</summary>
    /// <param name="item">Jellyfin item.</param>
    /// <returns>The description.</returns>
    public static EventItem Describe(BaseItem item)
    {
        var result = new EventItem
        {
            Id = item.Id.ToString("N"),
            Type = item.GetBaseItemKind().ToString(),
            Name = item.Name ?? string.Empty,
            ProviderIds = EventMapper.CleanProviderIds(item.ProviderIds),
            RunTimeTicks = item.RunTimeTicks,
        };

        switch (item)
        {
            case Episode episode:
                result.SeasonNumber = episode.ParentIndexNumber ?? episode.Season?.IndexNumber;
                result.EpisodeNumber = episode.IndexNumber;
                result.SeriesProviderIds = SeriesIds(episode.Series);
                break;
            case Season season:
                result.SeasonNumber = season.IndexNumber;
                result.SeriesProviderIds = SeriesIds(season.Series);
                result.RunTimeTicks = null;
                break;
        }

        return result;
    }

    /// <summary>Maps a Jellyfin item kind to Arclight's media type.</summary>
    /// <param name="item">Item.</param>
    /// <returns>"movie", "series", or null for anything else.</returns>
    public static string? MediaTypeOf(BaseItem item) => item switch
    {
        MediaBrowser.Controller.Entities.Movies.Movie => "movie",
        Series or Season or Episode => "series",
        _ => null,
    };

    /// <summary>The TMDB id Arclight uses for the title this item belongs to.</summary>
    /// <param name="item">Item.</param>
    /// <returns>TMDB id or null.</returns>
    public static int? TmdbIdOf(BaseItem item)
    {
        BaseItem? owner = item switch
        {
            Episode e => e.Series,
            Season s => s.Series,
            _ => item,
        };

        if (owner?.ProviderIds is { } ids && ids.TryGetValue("Tmdb", out var raw) && int.TryParse(raw, out var tmdb) && tmdb > 0)
        {
            return tmdb;
        }

        return null;
    }

    private static Dictionary<string, string>? SeriesIds(Series? series)
        => series is null ? null : EventMapper.CleanProviderIds(series.ProviderIds);
}

// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.Text.Json.Nodes;

namespace Jellyfin.Plugin.Arclight.Api;

/// <summary>
/// Adds <c>jellyfinId</c> to Arclight titles that this Jellyfin already has, so the web UI opens
/// Jellyfin's own item page for them instead of the plugin's title page. Pure; unit tested.
/// </summary>
public static class LibraryLinks
{
    /// <summary>
    /// Annotates a search/discover page (<c>results</c>), a title (root + <c>recommendations</c>), a watchlist or
    /// Leaving Soon (<c>items</c>), or playback stats / Year in review (<c>topMovies</c>, <c>topSeries</c>).
    /// </summary>
    /// <param name="json">Arclight response body.</param>
    /// <param name="itemId">Looks up the Jellyfin item for (mediaType, tmdbId).</param>
    /// <returns>The annotated body, or the input unchanged when it is not JSON of the expected shape.</returns>
    public static string Annotate(string json, Func<string, int, Guid?> itemId)
    {
        JsonNode? root;
        try
        {
            root = JsonNode.Parse(json);
        }
        catch (System.Text.Json.JsonException)
        {
            return json;
        }

        if (root is not JsonObject obj)
        {
            return json;
        }

        var changed = Mark(obj, itemId);
        foreach (var key in new[] { "results", "recommendations", "items", "topMovies", "topSeries" })
        {
            if (obj[key] is JsonArray array)
            {
                foreach (var node in array)
                {
                    if (node is JsonObject item)
                    {
                        changed |= Mark(item, itemId);
                    }
                }
            }
        }

        return changed ? obj.ToJsonString() : json;
    }

    private static bool Mark(JsonObject item, Func<string, int, Guid?> itemId)
    {
        if (item["tmdbId"] is not JsonValue tv || !tv.TryGetValue<int>(out var tmdb) || tmdb <= 0)
        {
            return false;
        }

        var type = item["mediaType"] is JsonValue mv && mv.TryGetValue<string>(out var m) ? m : null;
        if (type is not ("movie" or "series"))
        {
            return false;
        }

        if (itemId(type, tmdb) is not { } id)
        {
            return false;
        }

        item["jellyfinId"] = id.ToString("N");
        return true;
    }
}

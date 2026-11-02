// SPDX-License-Identifier: GPL-3.0-or-later
using System.Text.Json.Nodes;
using Jellyfin.Plugin.Arclight.Api;
using Xunit;

namespace Jellyfin.Plugin.Arclight.Tests;

public class UpcomingFilterTests
{
    private const string Body = """
        { "days": 30, "items": [
          { "kind": "movie", "tmdbId": 1, "title": "Have it" },
          { "kind": "movie", "tmdbId": 2, "title": "Coming" },
          { "kind": "episode", "tmdbId": 10, "seasonNumber": 2, "episodeNumber": 3, "title": "Show" },
          { "kind": "episode", "tmdbId": 10, "seasonNumber": 2, "episodeNumber": 4, "title": "Show" },
          { "kind": "movie", "tmdbId": null, "title": "No id" }
        ] }
        """;

    [Fact]
    public void DropsWhatTheLibraryAlreadyHas()
    {
        var result = UpcomingFilter.Filter(Body, tmdb => tmdb == 1, (series, s, e) => series == 10 && s == 2 && e == 3);
        var items = JsonNode.Parse(result)!["items"]!.AsArray();
        Assert.Equal(3, items.Count);
        Assert.Equal("Coming", (string?)items[0]!["title"]);
        Assert.Equal(4, (int?)items[1]!["episodeNumber"]);
        Assert.Equal("No id", (string?)items[2]!["title"]);
        Assert.Equal(30, (int?)JsonNode.Parse(result)!["days"]);
    }

    [Fact]
    public void LeavesOtherShapesAlone()
    {
        Assert.Equal("{\"code\":\"x\"}", UpcomingFilter.Filter("{\"code\":\"x\"}", _ => true, (_, _, _) => true));
    }
}

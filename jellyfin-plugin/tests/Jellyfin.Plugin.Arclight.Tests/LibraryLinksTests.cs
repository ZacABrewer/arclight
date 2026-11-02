// SPDX-License-Identifier: GPL-3.0-or-later
using System.Text.Json.Nodes;
using Jellyfin.Plugin.Arclight.Api;
using Xunit;

namespace Jellyfin.Plugin.Arclight.Tests;

public class LibraryLinksTests
{
    private static readonly Guid Movie550 = Guid.Parse("c459f404-48f8-4fd1-05b9-3b19a4430799");
    private static readonly Guid Show1396 = Guid.Parse("11111111-2222-3333-4444-555555555555");

    private static Guid? Lookup(string type, int tmdb) => (type, tmdb) switch
    {
        ("movie", 550) => Movie550,
        ("series", 1396) => Show1396,
        _ => null,
    };

    [Fact]
    public void Search_results_get_jellyfin_ids_for_library_titles_only()
    {
        const string body = """{"page":1,"results":[{"tmdbId":550,"mediaType":"movie"},{"tmdbId":603,"mediaType":"movie"},{"tmdbId":1396,"mediaType":"series"},{"tmdbId":550,"mediaType":"series"}]}""";
        var results = JsonNode.Parse(LibraryLinks.Annotate(body, Lookup))!["results"]!.AsArray();
        Assert.Equal(Movie550.ToString("N"), (string?)results[0]!["jellyfinId"]);
        Assert.Null(results[1]!["jellyfinId"]);
        Assert.Equal(Show1396.ToString("N"), (string?)results[2]!["jellyfinId"]);
        Assert.Null(results[3]!["jellyfinId"]); // same id, other media type
    }

    [Fact]
    public void Title_and_its_recommendations_are_marked()
    {
        const string body = """{"tmdbId":550,"mediaType":"movie","title":"Fight Club","recommendations":[{"tmdbId":1396,"mediaType":"series"},{"tmdbId":7,"mediaType":"movie"}]}""";
        var root = JsonNode.Parse(LibraryLinks.Annotate(body, Lookup))!;
        Assert.Equal(Movie550.ToString("N"), (string?)root["jellyfinId"]);
        Assert.Equal(Show1396.ToString("N"), (string?)root["recommendations"]![0]!["jellyfinId"]);
        Assert.Null(root["recommendations"]![1]!["jellyfinId"]);
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("[1,2]")]
    [InlineData("""{"results":[{"tmdbId":"550","mediaType":"movie"}]}""")]
    public void Unexpected_shapes_pass_through_unchanged(string body) => Assert.Equal(body, LibraryLinks.Annotate(body, Lookup));

    [Fact]
    public void Nothing_to_mark_keeps_the_original_text()
    {
        const string body = """{ "results": [ { "tmdbId": 9, "mediaType": "movie" } ] }""";
        Assert.Same(body, LibraryLinks.Annotate(body, Lookup));
    }
}

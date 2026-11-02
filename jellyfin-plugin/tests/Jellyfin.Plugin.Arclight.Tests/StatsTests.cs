// SPDX-License-Identifier: GPL-3.0-or-later
using System.Net;
using System.Security.Claims;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.Arclight.Api;
using Jellyfin.Plugin.Arclight.Arclight;
using Jellyfin.Plugin.Arclight.Configuration;
using Jellyfin.Plugin.Arclight.Events;
using Jellyfin.Plugin.Arclight.Web;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Net;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using Xunit;

namespace Jellyfin.Plugin.Arclight.Tests;

public class StatsTests
{
    private static readonly Guid UserId = Guid.Parse("6f9619ff-8b86-d011-b42d-00c04fc964ff");
    private const string UserHeader = "6f9619ff8b86d011b42d00c04fc964ff";

    private readonly FakeSettings _settings = new();
    private readonly RecordingHandler _handler = new();
    private readonly IAuthorizationContext _auth = Substitute.For<IAuthorizationContext>();

    private ArclightController Controller(bool withUser = true)
    {
        var client = new ArclightClient(_settings, new HttpClient(_handler));
        var queue = new EventQueue(100);
        var controller = new ArclightController(
            client,
            _settings,
            Substitute.For<ILibraryManager>(),
            Substitute.For<IUserManager>(),
            _auth,
            queue,
            new EventSender(queue, client, _settings, () => "s", NullLogger.Instance),
            new InjectionStatus(),
            new Jellyfin.Plugin.Arclight.Labels.LabelService(Substitute.For<ILibraryManager>(), Substitute.For<IMediaSourceManager>()),
            new ThemeCache(),
            new LibraryTmdbIndex(Substitute.For<ILibraryManager>()));
        var claims = new List<Claim> { new(ClaimTypes.Role, "User") };
        if (withUser)
        {
            claims.Add(new Claim("Jellyfin-UserId", UserId.ToString()));
        }

        controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity(claims, "Test")) },
        };
        return controller;
    }

    private (HttpRequestMessage Request, string Body) Sent()
    {
        var sent = Assert.Single(_handler.Requests);
        Assert.Equal(UserHeader, sent.Request.Headers.GetValues("X-Arclight-Jellyfin-User").Single());
        return sent;
    }

    private static void AssertStatus(int expected, ActionResult result)
    {
        var status = result switch
        {
            ContentResult c => c.StatusCode,
            ObjectResult o => o.StatusCode,
            _ => null,
        };
        Assert.Equal(expected, status);
    }

    private static string Code(ActionResult result)
    {
        var obj = Assert.IsAssignableFrom<ObjectResult>(result);
        return JsonDocument.Parse(JsonSerializer.Serialize(obj.Value)).RootElement.GetProperty("code").GetString()!;
    }

    [Theory]
    [InlineData(null, "/api/v1/jellyfin/stats/me?days=30")]
    [InlineData(7, "/api/v1/jellyfin/stats/me?days=7")]
    [InlineData(3650, "/api/v1/jellyfin/stats/me?days=3650")]
    public async Task My_stats_forward_days_and_the_user(int? days, string expected)
    {
        _handler.Respond = (_, _) => RecordingHandler.Json(HttpStatusCode.OK, "{\"totals\":{\"plays\":1}}");
        var result = await Controller().GetMyStats(days, CancellationToken.None);
        AssertStatus(200, result);
        var (request, _) = Sent();
        Assert.Equal(HttpMethod.Get, request.Method);
        Assert.Equal(expected, request.RequestUri!.PathAndQuery);
    }

    [Fact]
    public async Task Server_stats_forward_days_and_the_user()
    {
        _handler.Respond = (_, _) => RecordingHandler.Json(HttpStatusCode.OK, "{\"totals\":{\"plays\":1}}");
        AssertStatus(200, await Controller().GetServerStats(90, CancellationToken.None));
        Assert.Equal("/api/v1/jellyfin/stats/server?days=90", Sent().Request.RequestUri!.PathAndQuery);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-5)]
    [InlineData(3651)]
    public async Task Out_of_range_days_are_refused_without_a_call(int days)
    {
        var me = await Controller().GetMyStats(days, CancellationToken.None);
        var server = await Controller().GetServerStats(days, CancellationToken.None);
        AssertStatus(400, me);
        AssertStatus(400, server);
        Assert.Equal("invalid_days", Code(me));
        Assert.Empty(_handler.Requests);
    }

    [Theory]
    [InlineData(null, "/api/v1/jellyfin/wrapped")]
    [InlineData(2025, "/api/v1/jellyfin/wrapped?year=2025")]
    [InlineData(2000, "/api/v1/jellyfin/wrapped?year=2000")]
    [InlineData(2100, "/api/v1/jellyfin/wrapped?year=2100")]
    public async Task Wrapped_forwards_the_year(int? year, string expected)
    {
        _handler.Respond = (_, _) => RecordingHandler.Json(HttpStatusCode.OK, "{\"year\":2025,\"plays\":3}");
        AssertStatus(200, await Controller().GetWrapped(year, CancellationToken.None));
        Assert.Equal(expected, Sent().Request.RequestUri!.PathAndQuery);
    }

    [Fact]
    public async Task Wrapped_image_forwards_and_returns_the_svg_json()
    {
        _handler.Respond = (_, _) => RecordingHandler.Json(HttpStatusCode.OK, "{\"svg\":\"<svg xmlns='http://www.w3.org/2000/svg'/>\",\"fileName\":\"wrapped-2025.svg\"}");
        var result = Assert.IsType<ContentResult>(await Controller().GetWrappedImage(2025, CancellationToken.None));
        Assert.Equal(200, result.StatusCode);
        Assert.Equal("/api/v1/jellyfin/wrapped/image?year=2025", Sent().Request.RequestUri!.PathAndQuery);
        Assert.Equal("wrapped-2025.svg", JsonDocument.Parse(result.Content!).RootElement.GetProperty("fileName").GetString());
    }

    [Theory]
    [InlineData(1999)]
    [InlineData(2101)]
    public async Task Out_of_range_years_are_refused_without_a_call(int year)
    {
        var c = Controller();
        var wrapped = await c.GetWrapped(year, CancellationToken.None);
        AssertStatus(400, wrapped);
        Assert.Equal("invalid_year", Code(wrapped));
        AssertStatus(400, await c.GetWrappedImage(year, CancellationToken.None));
        AssertStatus(400, await c.ShareWrapped(new WrappedShareBody { Year = year }, CancellationToken.None));
        Assert.Empty(_handler.Requests);
    }

    [Fact]
    public async Task Share_needs_a_year()
    {
        AssertStatus(400, await Controller().ShareWrapped(null, CancellationToken.None));
        AssertStatus(400, await Controller().ShareWrapped(new WrappedShareBody(), CancellationToken.None));
        Assert.Empty(_handler.Requests);
    }

    [Fact]
    public async Task Share_body_is_rebuilt_from_known_fields()
    {
        _handler.Respond = (_, _) => RecordingHandler.Json(HttpStatusCode.Created, "{\"id\":1,\"year\":2025,\"path\":\"/api/v1/share/wrapped/abc\",\"url\":null}");
        var body = JsonSerializer.Deserialize<WrappedShareBody>("{\"year\":2025,\"userId\":7}")!;
        var result = await Controller().ShareWrapped(body, CancellationToken.None);
        AssertStatus(201, result);
        var (request, sent) = Sent();
        Assert.Equal(HttpMethod.Post, request.Method);
        Assert.Equal("/api/v1/jellyfin/wrapped/share", request.RequestUri!.AbsolutePath);
        using var doc = JsonDocument.Parse(sent);
        Assert.Equal(2025, doc.RootElement.GetProperty("year").GetInt32());
        Assert.False(doc.RootElement.TryGetProperty("userId", out _));
    }

    [Fact]
    public async Task Leaving_soon_forwards_with_the_user()
    {
        _handler.Respond = (_, _) => RecordingHandler.Json(HttpStatusCode.OK, "{\"name\":\"Leaving Soon\",\"days\":14,\"items\":[]}");
        AssertStatus(200, await Controller().GetLeavingSoon(CancellationToken.None));
        Assert.Equal("/api/v1/jellyfin/leaving-soon", Sent().Request.RequestUri!.PathAndQuery);
    }

    [Fact]
    public async Task Arclight_disabled_403_is_passed_through()
    {
        _handler.Respond = (_, _) => RecordingHandler.Json(HttpStatusCode.Forbidden, "{\"code\":\"disabled\",\"error\":\"off\"}");
        var result = Assert.IsType<ContentResult>(await Controller().GetServerStats(null, CancellationToken.None));
        Assert.Equal(403, result.StatusCode);
        Assert.Contains("disabled", result.Content);
    }

    [Fact]
    public async Task Callers_without_a_user_are_refused()
    {
        _auth.GetAuthorizationInfo(Arg.Any<HttpContext>()).Returns(new AuthorizationInfo { IsApiKey = true, IsAuthenticated = true });
        var c = Controller(withUser: false);
        AssertStatus(403, await c.GetStatsAccess(CancellationToken.None));
        AssertStatus(403, await c.GetMyStats(null, CancellationToken.None));
        AssertStatus(403, await c.ShareWrapped(new WrappedShareBody { Year = 2025 }, CancellationToken.None));
        Assert.Empty(_handler.Requests);
    }

    [Fact]
    public async Task Turned_off_features_make_no_call()
    {
        _settings.Config = new PluginConfiguration { EnableMyStats = false, EnableWrapped = false, EnableServerStats = false, EnableLeavingSoon = false };
        var c = Controller();
        foreach (var result in new[]
        {
            await c.GetStatsAccess(CancellationToken.None),
            await c.GetMyStats(null, CancellationToken.None),
            await c.GetServerStats(null, CancellationToken.None),
            await c.GetWrapped(null, CancellationToken.None),
            await c.GetWrappedImage(null, CancellationToken.None),
            await c.ShareWrapped(new WrappedShareBody { Year = 2025 }, CancellationToken.None),
            await c.GetLeavingSoon(CancellationToken.None),
        })
        {
            AssertStatus(404, result);
            Assert.Equal("feature_disabled", Code(result));
        }

        Assert.Empty(_handler.Requests);
    }

    [Fact]
    public async Task Access_is_narrowed_by_the_plugin_toggles()
    {
        _settings.Config = new PluginConfiguration { EnableServerStats = false, EnableWrapped = false };
        _handler.Respond = (_, _) => RecordingHandler.Json(HttpStatusCode.OK, "{\"myStats\":true,\"wrapped\":true,\"serverStats\":true,\"shareLinks\":true,\"leavingSoon\":true,\"isAdmin\":true}");
        var result = Assert.IsType<ContentResult>(await Controller().GetStatsAccess(CancellationToken.None));
        Assert.Equal(200, result.StatusCode);
        Assert.Equal("/api/v1/jellyfin/stats/access", Sent().Request.RequestUri!.PathAndQuery);
        var root = JsonNode.Parse(result.Content!)!;
        Assert.True((bool)root["myStats"]!);
        Assert.False((bool)root["wrapped"]!);
        Assert.False((bool)root["shareLinks"]!);
        Assert.False((bool)root["serverStats"]!);
        Assert.True((bool)root["leavingSoon"]!);
        Assert.True((bool)root["isAdmin"]!);
    }

    [Fact]
    public void Apply_toggles_forces_missing_or_odd_values_to_false()
    {
        var json = ProxyValidation.ApplyStatsToggles("{\"myStats\":\"yes\",\"wrapped\":1,\"extra\":true}", new PluginConfiguration());
        var root = JsonNode.Parse(json)!;
        foreach (var key in new[] { "myStats", "wrapped", "serverStats", "shareLinks", "leavingSoon", "isAdmin" })
        {
            Assert.False((bool)root[key]!);
        }
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("not json")]
    [InlineData("\"text\"")]
    public void Apply_toggles_leaves_non_objects_alone(string body) => Assert.Equal(body, ProxyValidation.ApplyStatsToggles(body, new PluginConfiguration()));

    [Fact]
    public void New_toggles_default_on()
    {
        var c = new PluginConfiguration();
        Assert.True(c.EnableMyStats);
        Assert.True(c.EnableWrapped);
        Assert.True(c.EnableServerStats);
        Assert.True(c.EnableLeavingSoon);
    }

    [Theory]
    [InlineData(1999, false)]
    [InlineData(2000, true)]
    [InlineData(2100, true)]
    [InlineData(2101, false)]
    public void Year_range(int year, bool ok) => Assert.Equal(ok, ProxyValidation.IsYear(year));

    [Fact]
    public void Stats_path_rejects_unknown_scopes()
    {
        Assert.Null(ProxyValidation.StatsPath("everyone", 30));
        Assert.Equal("stats/server?days=1", ProxyValidation.StatsPath("server", 1));
    }

    [Fact]
    public void Ping_features_are_read_and_bounded()
    {
        var names = ArclightClient.ParseFeatures("{\"ok\":true,\"features\":[\"events\",\"stats\",\"\",5,\"" + new string('x', 65) + "\",\"leavingSoon\"]}");
        Assert.Equal(new[] { "events", "stats", "leavingSoon" }, names);
        Assert.Null(ArclightClient.ParseFeatures("{\"ok\":true}"));
        Assert.Null(ArclightClient.ParseFeatures("<html>"));
        var many = "{\"features\":[" + string.Join(",", Enumerable.Range(0, 300).Select(i => "\"f" + i + "\"")) + "]}";
        Assert.Equal(200, ArclightClient.ParseFeatures(many)!.Count);
    }

    [Fact]
    public async Task Features_are_cached_between_calls()
    {
        _handler.Respond = (_, _) => RecordingHandler.Json(HttpStatusCode.OK, "{\"features\":[\"stats\",\"wrapped\"]}");
        var client = new ArclightClient(_settings, new HttpClient(_handler));
        Assert.Equal(new[] { "stats", "wrapped" }, await client.GetFeaturesAsync(CancellationToken.None));
        Assert.Equal(new[] { "stats", "wrapped" }, await client.GetFeaturesAsync(CancellationToken.None));
        var (request, _) = Assert.Single(_handler.Requests);
        Assert.Equal("/api/v1/jellyfin/ping", request.RequestUri!.AbsolutePath);
    }

    [Fact]
    public async Task Client_config_reports_the_arclight_features_and_toggles()
    {
        _handler.Respond = (_, _) => RecordingHandler.Json(HttpStatusCode.OK, "{\"features\":[\"stats\",\"wrapped\",\"leavingSoon\"]}");
        _settings.Config = new PluginConfiguration { EnableServerStats = false };
        var result = Assert.IsType<OkObjectResult>(await Controller().GetClientConfig(CancellationToken.None));
        var root = JsonNode.Parse(JsonSerializer.Serialize(result.Value))!;
        Assert.Equal(3, root["arclightFeatures"]!.AsArray().Count);
        Assert.True((bool)root["features"]!["myStats"]!);
        Assert.False((bool)root["features"]!["serverStats"]!);
        Assert.True((bool)root["features"]!["leavingSoon"]!);
    }

    [Fact]
    public void Stats_top_titles_get_jellyfin_ids()
    {
        var movie = Guid.Parse("c459f404-48f8-4fd1-05b9-3b19a4430799");
        const string body = """{"totals":{"plays":2},"topMovies":[{"tmdbId":550,"mediaType":"movie"},{"tmdbId":null,"mediaType":"other"}],"topSeries":[{"tmdbId":550,"mediaType":"series"}]}""";
        var root = JsonNode.Parse(LibraryLinks.Annotate(body, (type, tmdb) => type == "movie" && tmdb == 550 ? movie : null))!;
        Assert.Equal(movie.ToString("N"), (string?)root["topMovies"]![0]!["jellyfinId"]);
        Assert.Null(root["topMovies"]![1]!["jellyfinId"]);
        Assert.Null(root["topSeries"]![0]!["jellyfinId"]);
    }

    [Fact]
    public void Script_has_the_new_pages()
    {
        using var stream = typeof(ArclightController).Assembly.GetManifestResourceStream(
            typeof(ArclightController).Assembly.GetManifestResourceNames().Single(n => n.EndsWith("arclight.js", StringComparison.Ordinal)))!;
        var js = new StreamReader(stream).ReadToEnd();
        Assert.Contains("arclight === 'stats'", js.Replace("arclightPage", "arclight", StringComparison.Ordinal), StringComparison.Ordinal);
        Assert.Contains("'Wrapped/Share'", js, StringComparison.Ordinal);
        Assert.Contains("'LeavingSoon'", js, StringComparison.Ordinal);
        Assert.Contains("URL.revokeObjectURL", js, StringComparison.Ordinal);
    }
}

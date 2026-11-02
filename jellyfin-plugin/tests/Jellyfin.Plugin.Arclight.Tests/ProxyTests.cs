// SPDX-License-Identifier: GPL-3.0-or-later
using System.Net;
using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Plugin.Arclight.Api;
using Jellyfin.Plugin.Arclight.Arclight;
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

public class ProxyTests
{
    private static readonly Guid UserId = Guid.Parse("6f9619ff-8b86-d011-b42d-00c04fc964ff");

    private readonly FakeSettings _settings = new();
    private readonly RecordingHandler _handler = new();
    private readonly IAuthorizationContext _auth = Substitute.For<IAuthorizationContext>();

    private ArclightController Controller(Guid? claimUser = null, bool useClaim = true)
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
        if (useClaim)
        {
            claims.Add(new Claim("Jellyfin-UserId", (claimUser ?? UserId).ToString()));
        }

        controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity(claims, "Test")) },
        };
        return controller;
    }

    private static ContentResult AsContent(ActionResult r) => Assert.IsType<ContentResult>(r);

    [Fact]
    public async Task Search_forwards_with_api_key_and_user_header_in_N_format()
    {
        _handler.Respond = (_, _) => RecordingHandler.Json(HttpStatusCode.OK, "{\"results\":[],\"page\":1,\"totalPages\":0}");
        var result = AsContent(await Controller().Search("the matrix & co", "movie", 2, CancellationToken.None));

        Assert.Equal(200, result.StatusCode);
        var (request, _) = Assert.Single(_handler.Requests);
        Assert.Equal(HttpMethod.Get, request.Method);
        Assert.Equal("/api/v1/jellyfin/search", request.RequestUri!.AbsolutePath);
        Assert.Equal("?q=the%20matrix%20%26%20co&type=movie&page=2", request.RequestUri.Query);
        Assert.Equal("secret-key-1234", request.Headers.GetValues("X-Api-Key").Single());
        Assert.Equal("6f9619ff8b86d011b42d00c04fc964ff", request.Headers.GetValues("X-Arclight-Jellyfin-User").Single());
        Assert.DoesNotContain("secret-key-1234", result.Content);
    }

    [Fact]
    public async Task User_id_falls_back_to_the_authorization_context()
    {
        var user = new Jellyfin.Database.Implementations.Entities.User("bob", "Default", "Default");
        var other = user.Id;
        Assert.NotEqual(Guid.Empty, other);
        _auth.GetAuthorizationInfo(Arg.Any<HttpContext>()).Returns(new AuthorizationInfo { User = user, IsAuthenticated = true });
        await Controller(useClaim: false).GetWatchlist(CancellationToken.None);
        Assert.Equal(other.ToString("N"), _handler.Requests.Single().Request.Headers.GetValues("X-Arclight-Jellyfin-User").Single());
    }

    [Fact]
    public async Task Api_key_callers_without_a_user_are_refused()
    {
        _auth.GetAuthorizationInfo(Arg.Any<HttpContext>()).Returns(new AuthorizationInfo { IsApiKey = true, IsAuthenticated = true });
        var result = await Controller(useClaim: false).GetWatchlist(CancellationToken.None);
        var obj = Assert.IsType<ObjectResult>(result);
        Assert.Equal(403, obj.StatusCode);
        Assert.Empty(_handler.Requests);
    }

    [Fact]
    public async Task Request_body_is_rebuilt_from_known_fields()
    {
        var body = JsonSerializer.Deserialize<RequestBody>("{\"mediaType\":\"series\",\"tmdbId\":1396,\"seasons\":[3,1,1],\"is4k\":true,\"userId\":99}")!;
        await Controller().CreateRequest(body, CancellationToken.None);

        var (request, sent) = Assert.Single(_handler.Requests);
        Assert.Equal("/api/v1/jellyfin/request", request.RequestUri!.AbsolutePath);
        using var doc = JsonDocument.Parse(sent);
        Assert.Equal("series", doc.RootElement.GetProperty("mediaType").GetString());
        Assert.Equal(1396, doc.RootElement.GetProperty("tmdbId").GetInt32());
        Assert.Equal(new[] { 1, 3 }, doc.RootElement.GetProperty("seasons").EnumerateArray().Select(e => e.GetInt32()));
        Assert.True(doc.RootElement.GetProperty("is4k").GetBoolean());
        Assert.False(doc.RootElement.TryGetProperty("userId", out _));
    }

    [Fact]
    public async Task Not_linked_403_is_passed_through()
    {
        _handler.Respond = (_, _) => RecordingHandler.Json(HttpStatusCode.Forbidden, "{\"code\":\"not_linked\"}");
        var result = AsContent(await Controller().GetWatchlist(CancellationToken.None));
        Assert.Equal(403, result.StatusCode);
        Assert.Contains("not_linked", result.Content);
    }

    [Fact]
    public async Task Arclight_401_never_reaches_the_browser_as_401()
    {
        _handler.Respond = (_, _) => RecordingHandler.Json(HttpStatusCode.Unauthorized, "{\"message\":\"bad key secret-key-1234\"}");
        var result = AsContent(await Controller().GetWatchlist(CancellationToken.None));
        Assert.Equal(502, result.StatusCode);
        Assert.Equal("{\"code\":\"arclight_auth_failed\"}", result.Content);
    }

    [Fact]
    public async Task Disabled_features_do_not_call_arclight()
    {
        _settings.Config.EnableSearch = false;
        var result = await Controller().Search("x", null, null, CancellationToken.None);
        Assert.Equal(404, Assert.IsType<ObjectResult>(result).StatusCode);
        Assert.Empty(_handler.Requests);
    }

    [Theory]
    [InlineData("", "all", 1)]
    [InlineData("x", "music", 1)]
    [InlineData("x", "all", 0)]
    [InlineData("x", "all", 501)]
    public void Invalid_search_input_is_rejected(string q, string type, int page) => Assert.Null(ProxyValidation.SearchPath(q, type, page));

    [Fact]
    public void Overlong_query_is_rejected() => Assert.Null(ProxyValidation.SearchPath(new string('a', 201), null, null));

    [Theory]
    [InlineData("{\"mediaType\":\"tv\",\"tmdbId\":1}", "invalid_title")]
    [InlineData("{\"mediaType\":\"movie\",\"tmdbId\":0}", "invalid_title")]
    [InlineData("{\"mediaType\":\"movie\",\"tmdbId\":1,\"seasons\":\"all\"}", "seasons_series_only")]
    [InlineData("{\"mediaType\":\"series\",\"tmdbId\":1,\"seasons\":[]}", "invalid_seasons")]
    [InlineData("{\"mediaType\":\"series\",\"tmdbId\":1,\"seasons\":[-1]}", "invalid_seasons")]
    [InlineData("{\"mediaType\":\"series\",\"tmdbId\":1,\"seasons\":\"some\"}", "invalid_seasons")]
    public void Invalid_requests_are_rejected(string json, string code)
    {
        Assert.False(ProxyValidation.TryBuildRequest(JsonSerializer.Deserialize<RequestBody>(json), out _, out var error));
        Assert.Equal(code, error);
    }

    [Fact]
    public void Quality_profile_is_forwarded_when_positive()
    {
        Assert.True(ProxyValidation.TryBuildRequest(JsonSerializer.Deserialize<RequestBody>("{\"mediaType\":\"movie\",\"tmdbId\":1,\"qualityProfileId\":4}"), out var body, out _));
        Assert.Equal(4, body["qualityProfileId"]);
        Assert.False(ProxyValidation.TryBuildRequest(JsonSerializer.Deserialize<RequestBody>("{\"mediaType\":\"movie\",\"tmdbId\":1,\"qualityProfileId\":0}"), out _, out var error));
        Assert.Equal("invalid_profile", error);
    }

    [Fact]
    public void Seasons_all_is_accepted()
    {
        Assert.True(ProxyValidation.TryBuildRequest(JsonSerializer.Deserialize<RequestBody>("{\"mediaType\":\"series\",\"tmdbId\":1,\"seasons\":\"all\"}"), out var body, out _));
        Assert.Equal("all", body["seasons"]);
        Assert.False(body.ContainsKey("is4k"));
    }

    [Fact]
    public void Issue_and_language_validation()
    {
        Assert.True(ProxyValidation.TryBuildIssue(new IssueBody { MediaType = "series", TmdbId = 1, Type = "audio", Message = " out of sync ", SeasonNumber = 1, EpisodeNumber = 2 }, out var issue, out _));
        Assert.Equal("out of sync", issue["message"]);
        Assert.False(ProxyValidation.TryBuildIssue(new IssueBody { MediaType = "movie", TmdbId = 1, Type = "smell", Message = "x" }, out _, out var e1));
        Assert.Equal("invalid_type", e1);
        Assert.False(ProxyValidation.TryBuildIssue(new IssueBody { MediaType = "series", TmdbId = 1, Type = "video", Message = "x", EpisodeNumber = 2 }, out _, out var e2));
        Assert.Equal("invalid_episode", e2);
        Assert.False(ProxyValidation.TryBuildIssue(new IssueBody { MediaType = "movie", TmdbId = 1, Type = "video", Message = new string('x', 5001) }, out _, out _));

        Assert.True(ProxyValidation.TryBuildLanguageRequest(new LanguageRequestBody { Kind = "subtitle", MediaType = "series", TmdbId = 1, SeasonNumber = 2, Language = "es" }, out var lang, out _));
        Assert.Equal(2, lang["seasonNumber"]);
        Assert.False(ProxyValidation.TryBuildLanguageRequest(new LanguageRequestBody { Kind = "video", MediaType = "movie", TmdbId = 1, Language = "es" }, out _, out _));
        Assert.False(ProxyValidation.TryBuildLanguageRequest(new LanguageRequestBody { Kind = "audio", MediaType = "movie", TmdbId = 1, Language = "e" }, out _, out _));
        Assert.False(ProxyValidation.TryBuildLanguageRequest(new LanguageRequestBody { Kind = "audio", MediaType = "movie", TmdbId = 1, SeasonNumber = 1, Language = "es" }, out _, out _));
    }

    [Fact]
    public void Item_ids_are_limited_and_validated()
    {
        Assert.True(ProxyValidation.TryParseItemIds(new[] { Guid.NewGuid().ToString("N"), Guid.NewGuid().ToString() }, out var ok));
        Assert.Equal(2, ok.Count);
        Assert.False(ProxyValidation.TryParseItemIds(Enumerable.Range(0, 101).Select(_ => Guid.NewGuid().ToString()).ToList(), out _));
        Assert.False(ProxyValidation.TryParseItemIds(new[] { "../../etc" }, out _));
        Assert.False(ProxyValidation.TryParseItemIds(Array.Empty<string>(), out _));
    }

    [Theory]
    [InlineData(0, "", 502)]
    [InlineData(200, "<html>proxy</html>", 200)]
    [InlineData(500, "<html>oops</html>", 500)]
    [InlineData(204, "", 200)]
    public void Upstream_bodies_are_sanitised(int status, string body, int expected)
    {
        var (code, text) = ProxyValidation.ToBrowser(status, body);
        Assert.Equal(expected, code);
        Assert.DoesNotContain("<html>", text);
        JsonDocument.Parse(text).Dispose();
    }

    [Fact]
    public async Task New_endpoints_forward_with_the_user()
    {
        _settings.Config.ProvidersRegion = "gb";
        var c = Controller();
        await c.Discover("popularMovies", 2, CancellationToken.None);
        await c.Upcoming(14, CancellationToken.None);
        await c.Providers("movie", 550, CancellationToken.None);
        await c.MyRequests(null, null, CancellationToken.None);
        await c.CancelRequest(7, "language", CancellationToken.None);
        var sent = _handler.Requests.Select(r => r.Request.Method + " " + r.Request.RequestUri!.PathAndQuery).ToList();
        Assert.Equal(new[]
        {
            "GET /api/v1/jellyfin/discover?category=popularMovies&page=2",
            "GET /api/v1/jellyfin/upcoming?days=14",
            "GET /api/v1/jellyfin/providers/movie/550?region=GB",
            "GET /api/v1/jellyfin/requests?take=20&skip=0",
            "DELETE /api/v1/jellyfin/requests/7?kind=language",
        }, sent);
        Assert.All(_handler.Requests, r => Assert.Equal("6f9619ff8b86d011b42d00c04fc964ff", r.Request.Headers.GetValues("X-Arclight-Jellyfin-User").Single()));
    }

    [Fact]
    public async Task New_endpoints_validate_and_respect_toggles()
    {
        var c = Controller();
        Assert.IsType<BadRequestObjectResult>(await c.Discover("hacked", 1, CancellationToken.None));
        Assert.IsType<BadRequestObjectResult>(await c.Upcoming(91, CancellationToken.None));
        Assert.IsType<BadRequestObjectResult>(await c.CancelRequest(5, "other", CancellationToken.None));
        _settings.Config.EnableDiscover = false;
        Assert.Equal(404, Assert.IsType<ObjectResult>(await c.Discover("trending", 1, CancellationToken.None)).StatusCode);
        Assert.Empty(_handler.Requests);
    }

    [Theory]
    [InlineData("us", "US")]
    [InlineData(" de ", "DE")]
    [InlineData("usa", "US")]
    [InlineData("1x", "US")]
    [InlineData(null, "US")]
    public void Region_is_normalised(string? input, string expected) => Assert.Equal(expected, ArclightController.NormalizeRegion(input));

    [Fact]
    public async Task Theme_resources_reject_bad_ids_without_calling_arclight()
    {
        var c = Controller();
        Assert.IsType<NotFoundResult>(await c.ThemeCss("../secret", CancellationToken.None));
        Assert.IsType<NotFoundResult>(await c.ThemeFont("abyss", "../../x.woff2", CancellationToken.None));
        Assert.IsType<NotFoundResult>(await c.ThemeFont("abyss", "font.ttf", CancellationToken.None));
        Assert.Empty(_handler.Requests);
    }

    [Fact]
    public async Task Theme_css_is_fetched_with_the_key_and_served_with_its_etag()
    {
        _handler.Respond = (_, _) =>
        {
            var r = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(":root{--al-void:#000}", System.Text.Encoding.UTF8, "text/css") };
            r.Headers.ETag = new System.Net.Http.Headers.EntityTagHeaderValue("\"v1\"");
            return r;
        };
        var c = Controller();
        var file = Assert.IsType<FileContentResult>(await c.ThemeCss("abyss", CancellationToken.None));
        Assert.StartsWith("text/css", file.ContentType);
        Assert.Equal("\"v1\"", c.Response.Headers.ETag.ToString());
        var (request, _) = Assert.Single(_handler.Requests);
        Assert.Equal("/api/v1/jellyfin/theme/abyss.css", request.RequestUri!.AbsolutePath);
        Assert.Equal("secret-key-1234", request.Headers.GetValues("X-Api-Key").Single());
        Assert.False(request.Headers.Contains("X-Arclight-Jellyfin-User"));
    }

    [Fact]
    public void Status_is_picked_by_item_id()
    {
        var id = "0123456789abcdef0123456789abcdef";
        var picked = ArclightController.PickStatus("{\"items\":[{\"id\":\"ffffffffffffffffffffffffffffffff\",\"inLibrary\":false},{\"id\":\"01234567-89ab-cdef-0123-456789abcdef\",\"inLibrary\":true}]}", id);
        var element = Assert.IsType<JsonElement>(picked);
        Assert.True(element.GetProperty("inLibrary").GetBoolean());
        var fromArray = Assert.IsType<JsonElement>(ArclightController.PickStatus("[{\"id\":\"" + id + "\",\"monitored\":true}]", id));
        Assert.True(fromArray.GetProperty("monitored").GetBoolean());
    }
}

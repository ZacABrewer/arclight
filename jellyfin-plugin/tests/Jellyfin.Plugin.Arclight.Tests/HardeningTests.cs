// SPDX-License-Identifier: GPL-3.0-or-later
using System.Net;
using System.Security.Claims;
using System.Text;
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

/// <summary>Anonymous theme routes, Test connection, the key file and response size limits.</summary>
public class HardeningTests
{
    private const string Catalogue = "{\"defaultTheme\":null,\"themes\":[{\"id\":\"abyss\",\"name\":\"Abyss\"}]}";
    private const string AbyssCss = "@font-face { font-family: \"Abyss\"; src: url(\"theme-fonts/abyss/abyss-sans.woff2\") format(\"woff2\"); }";

    private readonly FakeSettings _settings = new();
    private readonly RecordingHandler _handler = new();
    private readonly ManualTime _time = new();

    private ArclightController Controller(ThemeCache cache)
    {
        var client = new ArclightClient(_settings, new HttpClient(_handler));
        var queue = new EventQueue(100);
        var controller = new ArclightController(
            client,
            _settings,
            Substitute.For<ILibraryManager>(),
            Substitute.For<IUserManager>(),
            Substitute.For<IAuthorizationContext>(),
            queue,
            new EventSender(queue, client, _settings, () => "s", NullLogger.Instance),
            new InjectionStatus(),
            new Jellyfin.Plugin.Arclight.Labels.LabelService(Substitute.For<ILibraryManager>(), Substitute.For<IMediaSourceManager>()),
            cache,
            new LibraryTmdbIndex(Substitute.For<ILibraryManager>()));
        controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity()) },
        };
        return controller;
    }

    private static HttpResponseMessage Bytes(HttpStatusCode code, string body, string type)
        => new(code) { Content = new StringContent(body, Encoding.UTF8, type) };

    private void ServeArclight(string? cssType = "text/css", HttpStatusCode cssStatus = HttpStatusCode.OK)
    {
        _handler.Respond = (req, _) => req.RequestUri!.AbsolutePath switch
        {
            "/api/v1/jellyfin/themes" => RecordingHandler.Json(HttpStatusCode.OK, Catalogue),
            "/api/v1/jellyfin/theme/abyss.css" => Bytes(cssStatus, AbyssCss, cssType ?? "text/css"),
            "/api/v1/jellyfin/theme-fonts/abyss/abyss-sans.woff2" => Bytes(HttpStatusCode.OK, "wOF2", "text/html"),
            _ => RecordingHandler.Json(HttpStatusCode.NotFound, "{}"),
        };
    }

    private int Fetches(string path) => _handler.Requests.Count(r => r.Request.RequestUri!.AbsolutePath == "/api/v1/jellyfin/" + path);

    // ------------------------------------------------------------ CLI-20: anonymous theme routes

    [Fact]
    public async Task Ids_missing_from_the_catalogue_never_reach_arclight()
    {
        ServeArclight();
        var cache = new ThemeCache(_time);
        for (var i = 0; i < 50; i++)
        {
            Assert.IsType<NotFoundResult>(await Controller(cache).ThemeCss("random-" + i, CancellationToken.None));
            Assert.IsType<NotFoundResult>(await Controller(cache).ThemeFont("random-" + i, "x.woff2", CancellationToken.None));
        }

        Assert.Equal(1, Fetches("themes"));
        Assert.Single(_handler.Requests);
        Assert.Equal(0, cache.Count);

        // An unlisted id refreshes the catalogue at most once a minute (a pack installed moments ago).
        _time.Advance(TimeSpan.FromSeconds(61));
        Assert.IsType<NotFoundResult>(await Controller(cache).ThemeCss("random-x", CancellationToken.None));
        Assert.Equal(2, Fetches("themes"));
    }

    [Fact]
    public async Task Listed_packs_use_the_catalogue_for_ten_minutes()
    {
        ServeArclight();
        var cache = new ThemeCache(_time);
        Assert.IsType<FileContentResult>(await Controller(cache).ThemeCss("abyss", CancellationToken.None));
        _time.Advance(TimeSpan.FromMinutes(5));
        Assert.IsType<FileContentResult>(await Controller(cache).ThemeCss("abyss", CancellationToken.None));
        Assert.Equal(1, Fetches("themes"));
        Assert.Equal(1, Fetches("theme/abyss.css"));
        _time.Advance(TimeSpan.FromMinutes(6));
        Assert.IsType<FileContentResult>(await Controller(cache).ThemeCss("abyss", CancellationToken.None));
        Assert.Equal(2, Fetches("themes"));
    }

    [Fact]
    public async Task Upstream_content_type_is_never_passed_through()
    {
        ServeArclight(cssType: "text/html");
        var cache = new ThemeCache(_time);
        var c = Controller(cache);
        var css = Assert.IsType<FileContentResult>(await c.ThemeCss("abyss", CancellationToken.None));
        Assert.Equal("text/css; charset=utf-8", css.ContentType);
        Assert.Equal("nosniff", c.Response.Headers["X-Content-Type-Options"].ToString());

        var f = Controller(cache);
        var font = Assert.IsType<FileContentResult>(await f.ThemeFont("abyss", "abyss-sans.woff2", CancellationToken.None));
        Assert.Equal("font/woff2", font.ContentType);
        Assert.Equal("nosniff", f.Response.Headers["X-Content-Type-Options"].ToString());
    }

    [Fact]
    public async Task Only_fonts_the_stylesheet_links_are_fetched()
    {
        ServeArclight();
        var cache = new ThemeCache(_time);
        for (var i = 0; i < 20; i++)
        {
            Assert.IsType<NotFoundResult>(await Controller(cache).ThemeFont("abyss", "guess-" + i + ".woff2", CancellationToken.None));
        }

        Assert.Equal(0, _handler.Requests.Count(r => r.Request.RequestUri!.AbsolutePath.Contains("theme-fonts", StringComparison.Ordinal)));
        Assert.Equal(1, Fetches("theme/abyss.css"));
        Assert.True(ArclightController.StylesheetLinksFont(Encoding.UTF8.GetBytes(AbyssCss), "abyss", "abyss-sans.woff2"));
        Assert.False(ArclightController.StylesheetLinksFont(Encoding.UTF8.GetBytes(AbyssCss), "abyss", "sans.woff2"));
    }

    [Fact]
    public async Task Misses_and_failures_are_cached_briefly()
    {
        ServeArclight(cssStatus: HttpStatusCode.NotFound);
        var cache = new ThemeCache(_time);
        Assert.IsType<NotFoundResult>(await Controller(cache).ThemeCss("abyss", CancellationToken.None));
        Assert.IsType<NotFoundResult>(await Controller(cache).ThemeCss("abyss", CancellationToken.None));
        Assert.Equal(1, Fetches("theme/abyss.css"));
        _time.Advance(ThemeCache.MissTtl + TimeSpan.FromSeconds(1));
        Assert.IsType<NotFoundResult>(await Controller(cache).ThemeCss("abyss", CancellationToken.None));
        Assert.Equal(2, Fetches("theme/abyss.css"));

        // Arclight erroring with nothing cached: 502, remembered for FailureTtl.
        ServeArclight(cssStatus: HttpStatusCode.InternalServerError);
        _time.Advance(ThemeCache.MissTtl + TimeSpan.FromSeconds(1));
        Assert.Equal(502, Assert.IsType<StatusCodeResult>(await Controller(cache).ThemeCss("abyss", CancellationToken.None)).StatusCode);
        Assert.Equal(502, Assert.IsType<StatusCodeResult>(await Controller(cache).ThemeCss("abyss", CancellationToken.None)).StatusCode);
        Assert.Equal(3, Fetches("theme/abyss.css"));
        _time.Advance(ThemeCache.FailureTtl + TimeSpan.FromSeconds(1));
        await Controller(cache).ThemeCss("abyss", CancellationToken.None);
        Assert.Equal(4, Fetches("theme/abyss.css"));
    }

    [Fact]
    public async Task Last_good_stylesheet_is_served_while_arclight_is_down()
    {
        ServeArclight();
        var cache = new ThemeCache(_time);
        Assert.IsType<FileContentResult>(await Controller(cache).ThemeCss("abyss", CancellationToken.None));
        _handler.Respond = (_, _) => throw new HttpRequestException("down");
        _time.Advance(TimeSpan.FromHours(2));
        var file = Assert.IsType<FileContentResult>(await Controller(cache).ThemeCss("abyss", CancellationToken.None));
        Assert.Equal(AbyssCss, Encoding.UTF8.GetString(file.FileContents));
    }

    [Fact]
    public void Cache_evicts_least_recently_used_instead_of_clearing()
    {
        var cache = new ThemeCache(_time);
        var e = new ThemeCache.Entry(200, Array.Empty<byte>(), null, null, _time.GetUtcNow());
        for (var i = 0; i < ThemeCache.MaxEntries; i++)
        {
            cache.Set("k" + i, e);
        }

        Assert.NotNull(cache.Get("k0")); // touch: k1 is now the oldest
        cache.Set("new", e);
        Assert.Equal(ThemeCache.MaxEntries, cache.Count);
        Assert.NotNull(cache.Get("k0"));
        Assert.Null(cache.Get("k1"));
        Assert.NotNull(cache.Get("k2"));
        Assert.NotNull(cache.Get("new"));
    }

    [Fact]
    public void Catalogue_parsing_keeps_valid_ids_only()
    {
        Assert.Equal(new[] { "abyss", "neon-2" }, ThemeCache.ParseCatalogue("{\"themes\":[{\"id\":\"abyss\"},{\"id\":\"../x\"},{\"id\":5},{\"id\":\"neon-2\"}]}"));
        Assert.Null(ThemeCache.ParseCatalogue("[]"));
        Assert.Null(ThemeCache.ParseCatalogue("not json"));
    }

    // ------------------------------------------------------------ CLI-19: Test connection

    [Theory]
    [InlineData(null, null, "http://arclight.test:7000", "saved", null)]
    [InlineData("http://ARCLIGHT.test:7000/", null, "http://arclight.test:7000", "saved", null)]
    [InlineData("http://listener.example.com", null, "http://listener.example.com", "", "api_key_required")]
    [InlineData("http://arclight.test:7001", null, "http://arclight.test:7001", "", "api_key_required")]
    [InlineData("http://arclight.test:7000/other", null, "http://arclight.test:7000/other", "", "api_key_required")]
    [InlineData("http://listener.example.com", "typed-key", "http://listener.example.com", "typed-key", null)]
    [InlineData("ftp://x", null, "ftp://x", "", "invalid_url")]
    public void Saved_key_is_only_sent_to_the_saved_url(string? bodyUrl, string? bodyKey, string expectedUrl, string expectedKey, string? error)
    {
        var (url, key, err) = ArclightController.ResolveTestTarget(bodyUrl, bodyKey, "http://arclight.test:7000", "saved");
        Assert.Equal(error, err);
        Assert.Equal(expectedKey, key);
        Assert.Equal(expectedUrl.TrimEnd('/'), url.TrimEnd('/'), StringComparer.OrdinalIgnoreCase);
    }

    [Fact]
    public void Missing_key_with_nothing_saved_is_reported()
    {
        Assert.Equal("missing_api_key", ArclightController.ResolveTestTarget(null, null, "http://arclight.test:7000", string.Empty).Error);
        Assert.Equal("invalid_url", ArclightController.ResolveTestTarget(null, null, string.Empty, "saved").Error);
    }

    // ------------------------------------------------------------ CLI-18: links in the web script

    [Fact]
    public async Task Web_script_url_guard_passes_its_node_tests()
    {
        var root = AppContext.BaseDirectory;
        while (root is not null && !File.Exists(Path.Combine(root, "Arclight.Jellyfin.sln")))
        {
            root = Path.GetDirectoryName(root);
        }

        Assert.NotNull(root);
        var js = File.ReadAllText(Path.Combine(root!, "src", "Jellyfin.Plugin.Arclight", "Web", "arclight.js"));
        Assert.Contains("isHttpUrl(data.link)", js, StringComparison.Ordinal);
        Assert.Contains("var safe = safeUrl(v);", js, StringComparison.Ordinal);

        System.Diagnostics.Process? node;
        try
        {
            node = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("node", "--test tests/web/url-guard.test.mjs")
            {
                WorkingDirectory = root,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            });
        }
        catch (System.ComponentModel.Win32Exception)
        {
            return; // node not installed: the static checks above still ran
        }

        Assert.NotNull(node);
        using (node)
        {
            var output = node.StandardOutput.ReadToEndAsync();
            var errors = await node.StandardError.ReadToEndAsync();
            await node.WaitForExitAsync();
            Assert.True(node.ExitCode == 0, await output + errors);
        }
    }

    // ------------------------------------------------------------ CLI-21: key file permissions

    [Fact]
    public void Key_temp_file_is_owner_only_from_creation_and_leftovers_are_replaced()
    {
        var dir = Directory.CreateTempSubdirectory("arclight-secret-");
        try
        {
            var tmp = Path.Combine(dir.FullName, "k.tmp");
            File.WriteAllText(tmp, "leftover-from-a-crash");
            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(tmp, (UnixFileMode)0b110_100_100); // 0644
            }

            SecretStore.WritePrivate(tmp, "new-key");
            Assert.Equal("new-key", File.ReadAllText(tmp));
            if (!OperatingSystem.IsWindows())
            {
                Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(tmp));
            }

            var store = new SecretStore(dir.FullName);
            store.Set("abcdefghijklmnop");
            Assert.Equal("abcdefghijklmnop", new SecretStore(dir.FullName).ApiKey);
            Assert.False(File.Exists(Path.Combine(dir.FullName, "Jellyfin.Plugin.Arclight.apikey.tmp")));
        }
        finally
        {
            dir.Delete(true);
        }
    }

    // ------------------------------------------------------------ CLI-22: bounded responses

    private sealed class EndlessContent : HttpContent
    {
        public long Served { get; private set; }

        protected override async Task SerializeToStreamAsync(Stream stream, TransportContext? context)
        {
            var chunk = new byte[64 * 1024];
            Array.Fill(chunk, (byte)'a');
            for (var i = 0; i < 1024; i++)
            {
                await stream.WriteAsync(chunk);
                Served += chunk.Length;
            }
        }

        protected override Task<Stream> CreateContentReadStreamAsync() => Task.FromResult<Stream>(new EndlessStream(this));

        protected override bool TryComputeLength(out long length)
        {
            length = -1;
            return false;
        }

        private sealed class EndlessStream(EndlessContent owner) : Stream
        {
            public override bool CanRead => true;

            public override bool CanSeek => false;

            public override bool CanWrite => false;

            public override long Length => throw new NotSupportedException();

            public override long Position { get => owner.Served; set => throw new NotSupportedException(); }

            public override int Read(byte[] buffer, int offset, int count)
            {
                Array.Fill(buffer, (byte)'a', offset, count);
                owner.Served += count;
                return count;
            }

            public override void Flush()
            {
            }

            public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

            public override void SetLength(long value) => throw new NotSupportedException();

            public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        }
    }

    [Fact]
    public async Task Declared_oversize_body_is_refused_before_reading()
    {
        var content = new ByteArrayContent(new byte[16]);
        content.Headers.ContentLength = 100L * 1024 * 1024;
        Assert.Null(await ArclightClient.ReadBoundedAsync(content, ArclightClient.MaxJsonBytes, CancellationToken.None));
    }

    [Fact]
    public async Task Unbounded_body_is_cut_off_at_the_limit()
    {
        var content = new EndlessContent();
        Assert.Null(await ArclightClient.ReadBoundedAsync(content, ArclightClient.MaxJsonBytes, CancellationToken.None));
        Assert.InRange(content.Served, ArclightClient.MaxJsonBytes, ArclightClient.MaxJsonBytes + (128 * 1024));
    }

    [Fact]
    public async Task Small_bodies_are_read_whole_and_large_json_is_rejected()
    {
        Assert.Equal("hello"u8.ToArray(), await ArclightClient.ReadBoundedAsync(new StringContent("hello"), 10, CancellationToken.None));
        Assert.Equal(new byte[10], await ArclightClient.ReadBoundedAsync(new ByteArrayContent(new byte[10]), 10, CancellationToken.None));
        Assert.Null(await ArclightClient.ReadBoundedAsync(new ByteArrayContent(new byte[11]), 10, CancellationToken.None));

        _handler.Respond = (_, _) => new HttpResponseMessage(HttpStatusCode.OK) { Content = new EndlessContent() };
        using var client = new ArclightClient(_settings, new HttpClient(_handler));
        var r = await client.SendAsync(HttpMethod.Get, "ping", null, null, CancellationToken.None);
        Assert.Equal(502, r.StatusCode);
        Assert.Contains("response_too_large", r.Body, StringComparison.Ordinal);

        _handler.Respond = (_, _) => RecordingHandler.Json(HttpStatusCode.OK, "{\"ok\":\"é\"}");
        var ok = await client.SendAsync(HttpMethod.Get, "ping", null, null, CancellationToken.None);
        Assert.Equal("{\"ok\":\"é\"}", ok.Body);
    }
}

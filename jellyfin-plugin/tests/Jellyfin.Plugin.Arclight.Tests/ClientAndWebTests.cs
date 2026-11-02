// SPDX-License-Identifier: GPL-3.0-or-later
using Jellyfin.Plugin.Arclight.Arclight;
using Jellyfin.Plugin.Arclight.Configuration;
using Jellyfin.Plugin.Arclight.Web;
using Xunit;

namespace Jellyfin.Plugin.Arclight.Tests;

public class ClientAndWebTests
{
    [Theory]
    [InlineData("https://arclight.example.com/", true, "https://arclight.example.com")]
    [InlineData("http://10.0.0.5:7878/arclight/", true, "http://10.0.0.5:7878/arclight")]
    [InlineData("ftp://x", false, "")]
    [InlineData("arclight.local", false, "")]
    [InlineData("https://user:pass@host", false, "")]
    [InlineData("https://host/?a=1", false, "")]
    [InlineData("", false, "")]
    public void Base_url_validation(string url, bool ok, string expected)
    {
        Assert.Equal(ok, ArclightClient.TryBuildBase(url, out var baseUrl));
        Assert.Equal(expected, baseUrl);
    }

    [Fact]
    public void Requests_carry_key_user_and_json_body()
    {
        var user = Guid.Parse("6F9619FF-8B86-D011-B42D-00C04FC964FF");
        using var req = ArclightClient.BuildRequest("http://a:1/base", "k", HttpMethod.Post, "status", new { items = Array.Empty<object>() }, user);
        Assert.Equal("http://a:1/base/api/v1/jellyfin/status", req.RequestUri!.ToString());
        Assert.Equal("k", req.Headers.GetValues("X-Api-Key").Single());
        Assert.Equal("6f9619ff8b86d011b42d00c04fc964ff", req.Headers.GetValues("X-Arclight-Jellyfin-User").Single());
        Assert.Equal("application/json", req.Content!.Headers.ContentType!.MediaType);
        Assert.StartsWith("Arclight-Jellyfin/", req.Headers.UserAgent.ToString());
    }

    [Fact]
    public void Server_level_requests_have_no_user_header()
    {
        using var req = ArclightClient.BuildRequest("http://a", "k", HttpMethod.Get, "ping", null, null);
        Assert.False(req.Headers.Contains("X-Arclight-Jellyfin-User"));
        Assert.Null(req.Content);
    }

    [Fact]
    public void Injection_is_idempotent_and_reversible()
    {
        const string html = "<html><head></head><body><div id=\"reactRoot\"></div></body></html>";
        var once = IndexHtmlInjector.Inject(html, "/jellyfin/");
        Assert.Contains("src=\"/jellyfin/Arclight/web/arclight.js?v=", once);
        Assert.True(once.IndexOf(IndexHtmlInjector.BeginMarker, StringComparison.Ordinal) < once.IndexOf("</body>", StringComparison.Ordinal));
        Assert.Equal(once, IndexHtmlInjector.Inject(once, "/"));
        Assert.Equal(html, IndexHtmlInjector.Remove(once));
    }

    [Theory]
    [InlineData("/web/index.html", true, "/")]
    [InlineData("/web/", true, "/")]
    [InlineData("/jellyfin/web/index.html", true, "/jellyfin/")]
    [InlineData("/Web/Index.html", true, "/")]
    [InlineData("/web/main.bundle.js", false, "/")]
    [InlineData("/web", false, "/")]
    [InlineData("/a\"b/web/", false, "/")]
    [InlineData(null, false, "/")]
    public void Index_paths(string? path, bool match, string prefix)
    {
        Assert.Equal(match, IndexHtmlInjector.IsIndexPath(path, out var p));
        Assert.Equal(prefix, p);
    }

    [Fact]
    public void Disk_patch_roundtrip()
    {
        var dir = Directory.CreateTempSubdirectory("arclight-web-");
        try
        {
            var file = Path.Combine(dir.FullName, "index.html");
            File.WriteAllText(file, "<html><body></body></html>");
            Assert.StartsWith("patched", IndexFilePatcher.TryPatchOnDisk(dir.FullName, null));
            Assert.Contains("../Arclight/web/arclight.js", File.ReadAllText(file));
            Assert.StartsWith("patched", IndexFilePatcher.TryPatchOnDisk(dir.FullName, null)); // re-patch keeps one tag
            Assert.Single(System.Text.RegularExpressions.Regex.Matches(File.ReadAllText(file), "arclight-jellyfin:begin"));
            Assert.Equal("removed", IndexFilePatcher.TryRemoveFromDisk(dir.FullName, null));
            Assert.Equal("<html><body></body></html>", File.ReadAllText(file));
        }
        finally
        {
            dir.Delete(true);
        }
    }

    [Fact]
    public void Secret_store_keeps_the_key_out_of_the_config_and_hints_only_the_tail()
    {
        var dir = Directory.CreateTempSubdirectory("arclight-secret-");
        try
        {
            var store = new SecretStore(dir.FullName);
            Assert.Equal(string.Empty, store.ApiKey);
            store.Set("  abcdefghijklmnop  ");
            Assert.Equal("abcdefghijklmnop", new SecretStore(dir.FullName).ApiKey);
            Assert.Equal("...mnop", store.Hint);
            store.Set(string.Empty);
            Assert.Equal(string.Empty, new SecretStore(dir.FullName).ApiKey);

            var xml = new System.Xml.Serialization.XmlSerializer(typeof(PluginConfiguration));
            using var sw = new StringWriter();
            xml.Serialize(sw, new PluginConfiguration());
            Assert.DoesNotContain("ApiKey", sw.ToString());
        }
        finally
        {
            dir.Delete(true);
        }
    }
}

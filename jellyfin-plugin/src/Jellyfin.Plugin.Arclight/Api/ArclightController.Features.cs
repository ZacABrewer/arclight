// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.Arclight.Labels;
using Jellyfin.Plugin.Arclight.Web;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.Arclight.Api;

/// <summary>Discover, upcoming, providers, my requests, labels and themes.</summary>
public partial class ArclightController
{
    private static readonly string[] DiscoverCategories =
    {
        "recommended", "trending", "trendingDay", "trendingWeek", "popularMovies", "popularSeries", "topRatedMovies", "topRatedSeries",
        "nowPlaying", "upcomingMovies", "upcomingSeries", "airingToday", "onTheAir",
    };

    private static readonly string[] GenreSorts = { "popularity", "rating", "releaseDate", "title" };

    /// <summary>A Discover row (same item shape as search).</summary>
    /// <param name="category">trending, popularMovies, popularSeries, upcomingMovies or upcomingSeries.</param>
    /// <param name="page">Page (1-500).</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>Arclight page.</returns>
    [HttpGet("Discover")]
    [Authorize]
    public async Task<ActionResult> Discover([FromQuery] string? category, [FromQuery] int? page, CancellationToken ct)
    {
        if (!_settings.Config.EnableDiscover)
        {
            return Disabled();
        }

        var p = page ?? 1;
        if (category is null || !DiscoverCategories.Contains(category, StringComparer.Ordinal) || p is < 1 or > 500)
        {
            return Invalid("invalid_query");
        }

        return await ForwardLinked(HttpMethod.Get, "discover?category=" + category + "&page=" + p.ToString(CultureInfo.InvariantCulture), ct).ConfigureAwait(false);
    }

    /// <summary>TMDB genres for movies or series.</summary>
    /// <param name="mediaType">movie or series.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>Arclight response.</returns>
    [HttpGet("Genres/{mediaType}")]
    [Authorize]
    public async Task<ActionResult> Genres([FromRoute] string mediaType, CancellationToken ct)
    {
        if (!_settings.Config.EnableDiscover)
        {
            return Disabled();
        }

        return ProxyValidation.IsMediaType(mediaType)
            ? await Forward(HttpMethod.Get, "genres/" + mediaType, null, ct).ConfigureAwait(false)
            : Invalid("invalid_media_type");
    }

    /// <summary>Browse one genre.</summary>
    /// <param name="mediaType">movie or series.</param>
    /// <param name="genreId">TMDB genre id.</param>
    /// <param name="sort">popularity, rating, releaseDate or title.</param>
    /// <param name="page">Page (1-500).</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>Arclight page.</returns>
    [HttpGet("DiscoverGenre/{mediaType}/{genreId:int}")]
    [Authorize]
    public async Task<ActionResult> DiscoverGenre([FromRoute] string mediaType, [FromRoute] int genreId, [FromQuery] string? sort, [FromQuery] int? page, CancellationToken ct)
    {
        if (!_settings.Config.EnableDiscover)
        {
            return Disabled();
        }

        var s = string.IsNullOrEmpty(sort) ? "popularity" : sort;
        var p = page ?? 1;
        if (!ProxyValidation.IsMediaType(mediaType) || genreId <= 0 || !GenreSorts.Contains(s, StringComparer.Ordinal) || p is < 1 or > 500)
        {
            return Invalid("invalid_query");
        }

        return await ForwardLinked(
            HttpMethod.Get,
            "discover/genre/" + mediaType + "/" + genreId.ToString(CultureInfo.InvariantCulture) + "?sort=" + s + "&page=" + p.ToString(CultureInfo.InvariantCulture),
            ct).ConfigureAwait(false);
    }

    /// <summary>Forwards a GET and marks titles this Jellyfin has with their item id.</summary>
    internal async Task<ActionResult> ForwardLinked(HttpMethod method, string path, CancellationToken ct)
    {
        var userId = await CurrentUserIdAsync().ConfigureAwait(false);
        if (userId == Guid.Empty)
        {
            return StatusCode(StatusCodes.Status403Forbidden, new { code = "user_required" });
        }

        var response = await _client.SendAsync(method, path, null, userId, ct).ConfigureAwait(false);
        var (status, text) = ProxyValidation.ToBrowser(response.StatusCode, response.Body);
        if (status is >= 200 and < 300)
        {
            text = LibraryLinks.Annotate(text, LibraryItemId);
        }

        return new ContentResult { StatusCode = status, Content = text, ContentType = "application/json" };
    }

    private Guid? LibraryItemId(string mediaType, int tmdbId)
        => mediaType == "movie" ? _upcomingIndex.MovieItemId(tmdbId) : _upcomingIndex.SeriesItemId(tmdbId);

    /// <summary>Upcoming releases ("Coming soon").</summary>
    /// <param name="days">1-90 (default 30).</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>Arclight response.</returns>
    [HttpGet("Upcoming")]
    [Authorize]
    public async Task<ActionResult> Upcoming([FromQuery] int? days, CancellationToken ct)
    {
        if (!_settings.Config.EnableUpcoming)
        {
            return Disabled();
        }

        var d = days ?? 30;
        if (d is < 1 or > 90)
        {
            return Invalid("invalid_days");
        }

        var userId = await CurrentUserIdAsync().ConfigureAwait(false);
        if (userId == Guid.Empty)
        {
            return StatusCode(StatusCodes.Status403Forbidden, new { code = "user_required" });
        }

        var response = await _client.SendAsync(HttpMethod.Get, "upcoming?days=" + d.ToString(CultureInfo.InvariantCulture), null, userId, ct).ConfigureAwait(false);
        var (status, text) = ProxyValidation.ToBrowser(response.StatusCode, response.Body);
        if (status is >= 200 and < 300)
        {
            // Not "coming soon" if this Jellyfin already has it.
            text = UpcomingFilter.Filter(text, _upcomingIndex.HasMovie, _upcomingIndex.HasEpisode);
        }

        return new ContentResult { StatusCode = status, Content = text, ContentType = "application/json" };
    }

    /// <summary>Where else the title streams (TMDB watch providers, data from JustWatch).</summary>
    /// <param name="mediaType">movie or series.</param>
    /// <param name="tmdbId">TMDB id.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>Arclight response.</returns>
    [HttpGet("Providers/{mediaType}/{tmdbId:int}")]
    [Authorize]
    public async Task<ActionResult> Providers([FromRoute] string mediaType, [FromRoute] int tmdbId, CancellationToken ct)
    {
        if (!_settings.Config.EnableProviders)
        {
            return Disabled();
        }

        if (!ProxyValidation.IsMediaType(mediaType) || !ProxyValidation.IsTmdbId(tmdbId))
        {
            return Invalid("invalid_title");
        }

        var region = NormalizeRegion(_settings.Config.ProvidersRegion);
        return await Forward(HttpMethod.Get, "providers/" + mediaType + "/" + tmdbId.ToString(CultureInfo.InvariantCulture) + "?region=" + region, null, ct).ConfigureAwait(false);
    }

    /// <summary>The caller's own requests.</summary>
    /// <param name="take">1-100.</param>
    /// <param name="skip">Offset.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>Arclight response.</returns>
    [HttpGet("Requests")]
    [Authorize]
    public async Task<ActionResult> MyRequests([FromQuery] int? take, [FromQuery] int? skip, CancellationToken ct)
    {
        if (!_settings.Config.EnableMyRequests)
        {
            return Disabled();
        }

        var t = take ?? 20;
        var s = skip ?? 0;
        if (t is < 1 or > 100 || s is < 0 or > 100000)
        {
            return Invalid("invalid_query");
        }

        return await ForwardLinked(HttpMethod.Get, "requests?take=" + t.ToString(CultureInfo.InvariantCulture) + "&skip=" + s.ToString(CultureInfo.InvariantCulture), ct).ConfigureAwait(false);
    }

    /// <summary>Cancels one of the caller's own pending requests (when Arclight allows it).</summary>
    /// <param name="id">Request id.</param>
    /// <param name="kind">media or language.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>Arclight response.</returns>
    [HttpDelete("Requests/{id:int}")]
    [Authorize]
    public async Task<ActionResult> CancelRequest([FromRoute] int id, [FromQuery] string? kind, CancellationToken ct)
    {
        if (!_settings.Config.EnableMyRequests)
        {
            return Disabled();
        }

        var k = string.IsNullOrEmpty(kind) ? "media" : kind;
        if (id <= 0 || k is not ("media" or "language"))
        {
            return Invalid("invalid_request");
        }

        return await Forward(HttpMethod.Delete, "requests/" + id.ToString(CultureInfo.InvariantCulture) + "?kind=" + k, null, ct).ConfigureAwait(false);
    }

    /// <summary>Quality/audio labels for up to 100 items, from Jellyfin's own media info (no Arclight call).</summary>
    /// <param name="ids">Comma-separated item ids.</param>
    /// <returns><c>{ items: [...] }</c>.</returns>
    [HttpGet("Labels")]
    [Authorize]
    public async Task<ActionResult> GetLabels([FromQuery] string? ids)
    {
        if (!_settings.Config.EnableLabels)
        {
            return Disabled();
        }

        var raw = (ids ?? string.Empty).Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (!ProxyValidation.TryParseItemIds(raw, out var parsed))
        {
            return Invalid("invalid_items");
        }

        var user = await CurrentUserAsync().ConfigureAwait(false);
        if (user is null)
        {
            return StatusCode(StatusCodes.Status403Forbidden, new { code = "user_required" });
        }

        Response.Headers.CacheControl = "private, max-age=60";
        return Ok(new { items = _labels.Get(parsed, user) });
    }

    /// <summary>Installed Arclight theme packs, the admin default and the caller's choice.</summary>
    /// <param name="ct">Cancellation token.</param>
    /// <returns><c>{ allowChoice, defaultChoice, choice, effective, themes }</c>.</returns>
    [HttpGet("Themes")]
    [Authorize]
    public async Task<ActionResult> GetThemes(CancellationToken ct)
    {
        var userId = await CurrentUserIdAsync().ConfigureAwait(false);
        if (userId == Guid.Empty)
        {
            return StatusCode(StatusCodes.Status403Forbidden, new { code = "user_required" });
        }

        var config = _settings.Config;
        var list = await _client.SendAsync(HttpMethod.Get, "themes", null, null, ct).ConfigureAwait(false);
        object? themes = null;
        if (list.IsSuccess)
        {
            try
            {
                themes = JsonSerializer.Deserialize<JsonElement>(list.Body);
            }
            catch (JsonException)
            {
                themes = null;
            }
        }

        var choice = ThemeChoices.EffectiveChoice(config, userId);
        var effective = choice == ThemeChoices.Follow ? await FollowedThemeAsync(userId, ct).ConfigureAwait(false) : choice == ThemeChoices.Off ? null : choice;
        return Ok(new
        {
            allowChoice = config.LetUsersChooseTheme,
            defaultChoice = ThemeChoices.DefaultChoice(config),
            choice = config.LetUsersChooseTheme ? ThemeChoices.StoredChoice(config, userId) : null,
            effective,
            themes,
        });
    }

    /// <summary>Saves the caller's theme choice ("off", "follow", a pack id, or "" to use the default).</summary>
    /// <param name="body">Choice.</param>
    /// <returns>204.</returns>
    [HttpPost("Themes/Choice")]
    [Authorize]
    public async Task<ActionResult> SetThemeChoice([FromBody] ThemeChoiceBody body)
    {
        var userId = await CurrentUserIdAsync().ConfigureAwait(false);
        if (userId == Guid.Empty)
        {
            return StatusCode(StatusCodes.Status403Forbidden, new { code = "user_required" });
        }

        var plugin = Plugin.Instance;
        if (plugin is null || !plugin.Configuration.LetUsersChooseTheme)
        {
            return StatusCode(StatusCodes.Status403Forbidden, new { code = "theme_choice_disabled" });
        }

        string? choice = null;
        if (!string.IsNullOrWhiteSpace(body?.Choice))
        {
            choice = ThemeChoices.Normalize(body!.Choice);
            if (choice is null)
            {
                return Invalid("invalid_theme");
            }
        }

        lock (ThemeLock)
        {
            ThemeChoices.SetChoice(plugin.Configuration, userId, choice);
            plugin.SaveConfiguration();
        }

        return NoContent();
    }

    /// <summary>
    /// The generated Jellyfin stylesheet for an Arclight pack. Anonymous because &lt;link&gt; tags carry no
    /// token; it contains no secrets, ids are validated and responses are cached, so Arclight sees at
    /// most one request per pack per hour.
    /// </summary>
    /// <param name="theme">Pack id.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>CSS.</returns>
    [HttpGet("Theme.css")]
    [AllowAnonymous]
    [Produces("text/css")]
    public Task<ActionResult> ThemeCss([FromQuery] string? theme, CancellationToken ct)
    {
        if (!ThemeChoices.IsPackId(theme))
        {
            return Task.FromResult<ActionResult>(NotFound());
        }

        return CachedThemeResource("theme/" + theme + ".css", TimeSpan.FromHours(1), "text/css; charset=utf-8", "no-cache", ct);
    }

    /// <summary>A font file a pack ships (referenced relatively by the stylesheet).</summary>
    /// <param name="themeId">Pack id.</param>
    /// <param name="file">File name (.woff2).</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>Font.</returns>
    [HttpGet("theme-fonts/{themeId}/{file}")]
    [AllowAnonymous]
    public Task<ActionResult> ThemeFont([FromRoute] string themeId, [FromRoute] string file, CancellationToken ct)
    {
        if (!ThemeChoices.IsPackId(themeId) || !FontFile().IsMatch(file ?? string.Empty))
        {
            return Task.FromResult<ActionResult>(NotFound());
        }

        return CachedThemeResource("theme-fonts/" + themeId + "/" + file, TimeSpan.FromDays(1), "font/woff2", "public, max-age=604800", ct);
    }

    internal static string NormalizeRegion(string? region)
    {
        var r = (region ?? string.Empty).Trim().ToUpperInvariant();
        return r.Length == 2 && r.All(char.IsAsciiLetterUpper) ? r : "US";
    }

    private static readonly object ThemeLock = new();

    [GeneratedRegex("^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\\.woff2$")]
    private static partial Regex FontFile();

    private async Task<string?> FollowedThemeAsync(Guid userId, CancellationToken ct)
    {
        var r = await _client.SendAsync(HttpMethod.Get, "userconfig", null, userId, ct).ConfigureAwait(false);
        if (!r.IsSuccess)
        {
            return null;
        }

        try
        {
            using var doc = JsonDocument.Parse(r.Body);
            return doc.RootElement.TryGetProperty("theme", out var t) && t.ValueKind == JsonValueKind.String && ThemeChoices.IsPackId(t.GetString()) ? t.GetString() : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private async Task<ActionResult> CachedThemeResource(string path, TimeSpan maxAge, string fallbackType, string cacheControl, CancellationToken ct)
    {
        if (!_themeCache.TryGetFresh(path, maxAge, out var entry))
        {
            var stale = _themeCache.Get(path);
            var (status, body, type, etag) = await _client.GetBytesAsync(path, stale?.ETag, ct).ConfigureAwait(false);
            if (status == 304 && stale is not null)
            {
                entry = stale with { FetchedAt = DateTimeOffset.UtcNow };
            }
            else if (status is 200 or 404)
            {
                entry = new ThemeCache.Entry(status, status == 200 ? body : Array.Empty<byte>(), type, etag, DateTimeOffset.UtcNow);
            }
            else if (stale is not null)
            {
                entry = stale; // Arclight unreachable: keep serving the last good copy
            }
            else
            {
                return StatusCode(StatusCodes.Status502BadGateway);
            }

            _themeCache.Set(path, entry);
        }

        if (entry.Status != 200)
        {
            return NotFound();
        }

        var tag = entry.ETag ?? "\"" + Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(entry.Body))[..16] + "\"";
        if (Request.Headers.IfNoneMatch.Any(v => v == tag))
        {
            return StatusCode(StatusCodes.Status304NotModified);
        }

        Response.Headers.ETag = tag;
        // Stylesheets revalidate on every load (a cheap 304 from the plugin cache) so pack or
        // generator updates show at once; font files never change under the same name.
        Response.Headers.CacheControl = cacheControl;
        Response.Headers["X-Content-Type-Options"] = "nosniff";
        return File(entry.Body, entry.ContentType ?? fallbackType);
    }
}

/// <summary>Body for POST /Arclight/Themes/Choice.</summary>
public sealed class ThemeChoiceBody
{
    /// <summary>Gets or sets "off", "follow", a pack id, or empty for the admin default.</summary>
    [System.Text.Json.Serialization.JsonPropertyName("choice")]
    public string? Choice { get; set; }
}

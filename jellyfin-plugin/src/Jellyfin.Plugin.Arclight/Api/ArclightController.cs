// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Mime;
using System.Security.Claims;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.Arclight.Arclight;
using Jellyfin.Plugin.Arclight.Events;
using Jellyfin.Plugin.Arclight.Web;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Net;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using JellyfinUser = Jellyfin.Database.Implementations.Entities.User;

namespace Jellyfin.Plugin.Arclight.Api;

/// <summary>
/// Endpoints under <c>/Arclight</c>. Browser calls are authorised with the Jellyfin user's own token;
/// the plugin adds the Arclight API key and the Jellyfin user id server-side and forwards to Arclight.
/// The API key never appears in any response.
/// </summary>
[ApiController]
[Route("Arclight")]
[Produces(MediaTypeNames.Application.Json)]
public partial class ArclightController : ControllerBase
{
    private const string UserIdClaim = "Jellyfin-UserId";

    private readonly ArclightClient _client;
    private readonly IArclightSettings _settings;
    private readonly ILibraryManager _library;
    private readonly IUserManager _users;
    private readonly IAuthorizationContext _authContext;
    private readonly EventQueue _queue;
    private readonly EventSender _sender;
    private readonly InjectionStatus _injection;
    private readonly Labels.LabelService _labels;
    private readonly ThemeCache _themeCache;
    private readonly LibraryTmdbIndex _upcomingIndex;

    /// <summary>Initializes a new instance of the <see cref="ArclightController"/> class.</summary>
    /// <param name="client">Arclight client.</param>
    /// <param name="settings">Settings.</param>
    /// <param name="library">Library manager.</param>
    /// <param name="users">User manager.</param>
    /// <param name="authContext">Authorization context.</param>
    /// <param name="queue">Event queue.</param>
    /// <param name="sender">Event sender.</param>
    /// <param name="injection">Injection status.</param>
    /// <param name="labels">Label service.</param>
    /// <param name="themeCache">Theme cache.</param>
    /// <param name="upcomingIndex">Library index for "Coming soon".</param>
    public ArclightController(
        ArclightClient client,
        IArclightSettings settings,
        ILibraryManager library,
        IUserManager users,
        IAuthorizationContext authContext,
        EventQueue queue,
        EventSender sender,
        InjectionStatus injection,
        Labels.LabelService labels,
        ThemeCache themeCache,
        LibraryTmdbIndex upcomingIndex)
    {
        _client = client;
        _settings = settings;
        _library = library;
        _users = users;
        _authContext = authContext;
        _queue = queue;
        _sender = sender;
        _injection = injection;
        _labels = labels;
        _themeCache = themeCache;
        _upcomingIndex = upcomingIndex;
    }

    // ---------------------------------------------------------------- static web assets (anonymous)

    /// <summary>The Jellyfin Web script. Contains no secrets, so it is served anonymously.</summary>
    /// <returns>JavaScript.</returns>
    [HttpGet("web/arclight.js")]
    [AllowAnonymous]
    [Produces("application/javascript")]
    public ActionResult GetScript()
    {
        _injection.LastScriptServed = DateTimeOffset.UtcNow;
        return Resource("arclight.js", "application/javascript; charset=utf-8");
    }

    /// <summary>The Jellyfin Web stylesheet.</summary>
    /// <returns>CSS.</returns>
    [HttpGet("web/arclight.css")]
    [AllowAnonymous]
    [Produces("text/css")]
    public ActionResult GetStyles() => Resource("arclight.css", "text/css; charset=utf-8");

    // ---------------------------------------------------------------- per-user proxy

    /// <summary>Which UI features are enabled (no secrets).</summary>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>Feature flags, plus the features the connected Arclight advertises (null when unknown).</returns>
    [HttpGet("ClientConfig")]
    [Authorize]
    public async Task<ActionResult> GetClientConfig(CancellationToken ct)
    {
        var c = _settings.Config;
        var arclightFeatures = _client.IsConfigured ? await _client.GetFeaturesAsync(ct).ConfigureAwait(false) : null;
        return Ok(new
        {
            configured = _client.IsConfigured,
            version = IndexHtmlInjector.Version,
            arclightFeatures,
            features = new
            {
                search = c.EnableSearch,
                requests = c.EnableRequests,
                badges = c.EnableItemBadges,
                watchlist = c.EnableWatchlist,
                issues = c.EnableIssues,
                languageRequests = c.EnableLanguageRequests,
                discover = c.EnableDiscover,
                upcoming = c.EnableUpcoming,
                providers = c.EnableProviders,
                myRequests = c.EnableMyRequests,
                labels = c.EnableLabels,
                themes = c.LetUsersChooseTheme || ThemeChoices.DefaultChoice(c) != ThemeChoices.Off,
                themeChoice = c.LetUsersChooseTheme,
                myStats = c.EnableMyStats,
                wrapped = c.EnableWrapped,
                serverStats = c.EnableServerStats,
                leavingSoon = c.EnableLeavingSoon,
            },
        });
    }

    /// <summary>Searches Arclight for titles.</summary>
    /// <param name="q">Query.</param>
    /// <param name="type">movie, series or all.</param>
    /// <param name="page">Page.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>Arclight search results.</returns>
    [HttpGet("Search")]
    [Authorize]
    public async Task<ActionResult> Search([FromQuery] string? q, [FromQuery] string? type, [FromQuery] int? page, CancellationToken ct)
    {
        if (!_settings.Config.EnableSearch)
        {
            return Disabled();
        }

        var path = ProxyValidation.SearchPath(q, type, page);
        return path is null ? Invalid("invalid_query") : await ForwardLinked(HttpMethod.Get, path, ct).ConfigureAwait(false);
    }

    /// <summary>Title details (seasons, request options, languages).</summary>
    /// <param name="mediaType">movie or series.</param>
    /// <param name="tmdbId">TMDB id.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>Arclight title details.</returns>
    [HttpGet("Title/{mediaType}/{tmdbId:int}")]
    [Authorize]
    public async Task<ActionResult> Title([FromRoute] string mediaType, [FromRoute] int tmdbId, CancellationToken ct)
    {
        if (!ProxyValidation.IsMediaType(mediaType) || !ProxyValidation.IsTmdbId(tmdbId))
        {
            return Invalid("invalid_title");
        }

        return await ForwardLinked(HttpMethod.Get, "title/" + mediaType + "/" + tmdbId.ToString(CultureInfo.InvariantCulture), ct).ConfigureAwait(false);
    }

    /// <summary>Requests a title.</summary>
    /// <param name="body">Request.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>Arclight response.</returns>
    [HttpPost("Request")]
    [Authorize]
    public async Task<ActionResult> CreateRequest([FromBody] RequestBody body, CancellationToken ct)
    {
        if (!_settings.Config.EnableRequests)
        {
            return Disabled();
        }

        return ProxyValidation.TryBuildRequest(body, out var payload, out var error)
            ? await Forward(HttpMethod.Post, "request", payload, ct).ConfigureAwait(false)
            : Invalid(error);
    }

    /// <summary>Requests a subtitle or audio language.</summary>
    /// <param name="body">Request.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>Arclight response.</returns>
    [HttpPost("LanguageRequest")]
    [Authorize]
    public async Task<ActionResult> CreateLanguageRequest([FromBody] LanguageRequestBody body, CancellationToken ct)
    {
        if (!_settings.Config.EnableLanguageRequests)
        {
            return Disabled();
        }

        return ProxyValidation.TryBuildLanguageRequest(body, out var payload, out var error)
            ? await Forward(HttpMethod.Post, "language-request", payload, ct).ConfigureAwait(false)
            : Invalid(error);
    }

    /// <summary>Reports a problem.</summary>
    /// <param name="body">Issue.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>Arclight response.</returns>
    [HttpPost("Issue")]
    [Authorize]
    public async Task<ActionResult> CreateIssue([FromBody] IssueBody body, CancellationToken ct)
    {
        if (!_settings.Config.EnableIssues)
        {
            return Disabled();
        }

        return ProxyValidation.TryBuildIssue(body, out var payload, out var error)
            ? await Forward(HttpMethod.Post, "issue", payload, ct).ConfigureAwait(false)
            : Invalid(error);
    }

    /// <summary>Lists the user's Arclight watchlist.</summary>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>Arclight response.</returns>
    [HttpGet("Watchlist")]
    [Authorize]
    public async Task<ActionResult> GetWatchlist(CancellationToken ct)
        => _settings.Config.EnableWatchlist ? await Forward(HttpMethod.Get, "watchlist", null, ct).ConfigureAwait(false) : Disabled();

    /// <summary>Adds a title to the watchlist.</summary>
    /// <param name="body">Title.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>Arclight response.</returns>
    [HttpPost("Watchlist")]
    [Authorize]
    public async Task<ActionResult> AddToWatchlist([FromBody] WatchlistBody body, CancellationToken ct)
    {
        if (!_settings.Config.EnableWatchlist)
        {
            return Disabled();
        }

        if (body is null || !ProxyValidation.IsMediaType(body.MediaType) || !ProxyValidation.IsTmdbId(body.TmdbId))
        {
            return Invalid("invalid_title");
        }

        return await Forward(HttpMethod.Post, "watchlist", new { mediaType = body.MediaType, tmdbId = body.TmdbId }, ct).ConfigureAwait(false);
    }

    /// <summary>Removes a title from the watchlist.</summary>
    /// <param name="mediaType">movie or series.</param>
    /// <param name="tmdbId">TMDB id.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>Arclight response.</returns>
    [HttpDelete("Watchlist")]
    [Authorize]
    public async Task<ActionResult> RemoveFromWatchlist([FromQuery] string? mediaType, [FromQuery] int tmdbId, CancellationToken ct)
    {
        if (!_settings.Config.EnableWatchlist)
        {
            return Disabled();
        }

        if (!ProxyValidation.IsMediaType(mediaType) || !ProxyValidation.IsTmdbId(tmdbId))
        {
            return Invalid("invalid_title");
        }

        return await Forward(HttpMethod.Delete, "watchlist?mediaType=" + mediaType + "&tmdbId=" + tmdbId.ToString(CultureInfo.InvariantCulture), null, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Arclight status for one Jellyfin item, plus what the UI needs to act on it (media type, TMDB id,
    /// season/episode numbers). The item must be visible to the calling user.
    /// </summary>
    /// <param name="itemId">Jellyfin item id.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns><c>{ item, status }</c>.</returns>
    [HttpGet("Item/{itemId}")]
    [Authorize]
    public async Task<ActionResult> GetItemStatus([FromRoute] string itemId, CancellationToken ct)
    {
        if (!Guid.TryParse(itemId, out var id) || id == Guid.Empty)
        {
            return Invalid("invalid_item");
        }

        var user = await CurrentUserAsync().ConfigureAwait(false);
        if (user is null)
        {
            return Unauthorized();
        }

        var item = _library.GetItemById(id);
        if (item is null || !item.IsVisibleStandalone(user))
        {
            return NotFound(new { code = "item_not_found" });
        }

        var described = ItemDescriber.Describe(item);
        var info = new
        {
            id = described.Id,
            type = described.Type,
            name = described.Name,
            mediaType = ItemDescriber.MediaTypeOf(item),
            tmdbId = ItemDescriber.TmdbIdOf(item),
            seasonNumber = described.SeasonNumber,
            episodeNumber = described.EpisodeNumber,
        };

        if (!_settings.Config.EnableItemBadges || info.mediaType is null)
        {
            return Ok(new { item = info, status = (object?)null });
        }

        var response = await _client.SendAsync(HttpMethod.Post, "status", new { items = new[] { ToStatusItem(item) } }, user.Id, ct).ConfigureAwait(false);
        if (!response.IsSuccess)
        {
            var (code, text) = ProxyValidation.ToBrowser(response.StatusCode, response.Body);
            return new ContentResult { StatusCode = code, Content = text, ContentType = "application/json" };
        }

        return Ok(new { item = info, status = PickStatus(response.Body, described.Id) });
    }

    /// <summary>Arclight status for up to 100 Jellyfin items visible to the calling user.</summary>
    /// <param name="body">Item ids.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>Arclight response.</returns>
    [HttpPost("Status")]
    [Authorize]
    public async Task<ActionResult> GetStatuses([FromBody] StatusBody body, CancellationToken ct)
    {
        if (!_settings.Config.EnableItemBadges)
        {
            return Disabled();
        }

        if (!ProxyValidation.TryParseItemIds(body?.ItemIds, out var ids))
        {
            return Invalid("invalid_items");
        }

        var user = await CurrentUserAsync().ConfigureAwait(false);
        if (user is null)
        {
            return Unauthorized();
        }

        var items = ids
            .Select(i => _library.GetItemById(i))
            .Where(i => i is not null && i.IsVisibleStandalone(user))
            .Select(i => ToStatusItem(i!))
            .ToList();
        return await Forward(HttpMethod.Post, "status", new { items }, ct).ConfigureAwait(false);
    }

    // ---------------------------------------------------------------- admin

    /// <summary>Plugin health for the configuration page (admin only).</summary>
    /// <returns>Status.</returns>
    [HttpGet("Admin/Status")]
    [Authorize]
    public async Task<ActionResult> GetAdminStatus()
    {
        if (!await IsAdminAsync().ConfigureAwait(false))
        {
            return Forbid();
        }

        var secrets = Plugin.Instance?.Secrets;
        return Ok(new
        {
            version = IndexHtmlInjector.Version,
            hasApiKey = (secrets?.ApiKey.Length ?? 0) > 0,
            apiKeyHint = secrets?.Hint ?? string.Empty,
            configured = _client.IsConfigured,
            queue = new { pending = _queue.Count, dropped = _queue.Dropped, delivered = _sender.Delivered },
            lastSuccess = _sender.LastSuccess,
            lastError = _sender.LastError,
            backoffSeconds = (int)_sender.Backoff.TotalSeconds,
            injection = new
            {
                lastInjected = _injection.LastInjected,
                lastScriptServed = _injection.LastScriptServed,
                diskPatch = _injection.DiskPatch,
                lastError = _injection.LastError,
            },
        });
    }

    /// <summary>Sets or clears the Arclight API key (admin only). The key is never returned.</summary>
    /// <param name="body">Key.</param>
    /// <returns>204.</returns>
    [HttpPost("Admin/ApiKey")]
    [Authorize]
    public async Task<ActionResult> SetApiKey([FromBody] ApiKeyBody body)
    {
        if (!await IsAdminAsync().ConfigureAwait(false))
        {
            return Forbid();
        }

        var key = (body?.ApiKey ?? string.Empty).Trim();
        if (key.Length > 512 || key.Any(char.IsControl))
        {
            return Invalid("invalid_api_key");
        }

        Plugin.Instance?.Secrets.Set(key);
        _sender.Signal();
        return NoContent();
    }

    /// <summary>Calls Arclight's ping with the given or saved settings (admin only).</summary>
    /// <param name="body">Optional URL/key to test before saving.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns><c>{ ok, status, ping }</c>.</returns>
    [HttpPost("Admin/TestConnection")]
    [Authorize]
    public async Task<ActionResult> TestConnection([FromBody] TestConnectionBody? body, CancellationToken ct)
    {
        if (!await IsAdminAsync().ConfigureAwait(false))
        {
            return Forbid();
        }

        var url = string.IsNullOrWhiteSpace(body?.Url) ? _settings.ArclightUrl : body!.Url!;
        var key = string.IsNullOrWhiteSpace(body?.ApiKey) ? _settings.ApiKey : body!.ApiKey!.Trim();
        if (!ArclightClient.TryBuildBase(url, out _))
        {
            return Ok(new { ok = false, status = 0, error = "invalid_url" });
        }

        if (key.Length == 0)
        {
            return Ok(new { ok = false, status = 0, error = "missing_api_key" });
        }

        var response = await _client.SendAsync(url, key, HttpMethod.Get, "ping", null, null, ct).ConfigureAwait(false);
        object? ping = null;
        if (response.IsSuccess)
        {
            try
            {
                ping = JsonSerializer.Deserialize<JsonElement>(response.Body);
            }
            catch (JsonException)
            {
                return Ok(new { ok = false, status = response.StatusCode, error = "not_arclight" });
            }
        }

        string? error = response.IsSuccess ? null : response.StatusCode switch
        {
            0 => "unreachable",
            401 or 403 => "bad_api_key",
            404 => "not_arclight_or_too_old",
            _ => "http_" + response.StatusCode.ToString(CultureInfo.InvariantCulture),
        };
        return Ok(new { ok = response.IsSuccess, status = response.StatusCode, error, ping });
    }

    // ---------------------------------------------------------------- helpers

    internal static object? PickStatus(string body, string itemId)
    {
        try
        {
            var root = JsonSerializer.Deserialize<JsonElement>(body);
            var array = root.ValueKind == JsonValueKind.Array ? root
                : root.ValueKind == JsonValueKind.Object && root.TryGetProperty("items", out var items) && items.ValueKind == JsonValueKind.Array ? items
                : default;
            if (array.ValueKind != JsonValueKind.Array)
            {
                return root;
            }

            foreach (var element in array.EnumerateArray())
            {
                if (element.ValueKind == JsonValueKind.Object && element.TryGetProperty("id", out var idProp)
                    && idProp.ValueKind == JsonValueKind.String && Guid.TryParse(idProp.GetString(), out var g) && g.ToString("N") == itemId)
                {
                    return element;
                }
            }

            return array.GetArrayLength() == 1 ? array[0] : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    // Seasons and episodes carry their series' ids and numbers so Arclight can find the show.
    private static StatusItem ToStatusItem(BaseItem item)
    {
        var d = ItemDescriber.Describe(item);
        return new(d.Id, d.Type, d.ProviderIds, d.SeriesProviderIds, d.SeasonNumber, d.EpisodeNumber);
    }

    private ActionResult Resource(string name, string contentType)
    {
        var stream = typeof(ArclightController).Assembly.GetManifestResourceStream("Jellyfin.Plugin.Arclight.Web." + name);
        if (stream is null)
        {
            return NotFound();
        }

        Response.Headers.CacheControl = "public, max-age=3600";
        Response.Headers["X-Content-Type-Options"] = "nosniff";
        return File(stream, contentType);
    }

    private ObjectResult Disabled() => StatusCode(StatusCodes.Status404NotFound, new { code = "feature_disabled" });

    private BadRequestObjectResult Invalid(string code) => BadRequest(new { code });

    private async Task<Guid> CurrentUserIdAsync()
    {
        var claim = User.FindFirst(UserIdClaim)?.Value;
        if (Guid.TryParse(claim, out var id) && id != Guid.Empty)
        {
            return id;
        }

        var info = await _authContext.GetAuthorizationInfo(HttpContext).ConfigureAwait(false);
        return info.IsApiKey ? Guid.Empty : info.UserId;
    }

    private async Task<JellyfinUser?> CurrentUserAsync()
    {
        var id = await CurrentUserIdAsync().ConfigureAwait(false);
        return id == Guid.Empty ? null : _users.GetUserById(id);
    }

    private async Task<bool> IsAdminAsync()
    {
        if (User.IsInRole("Administrator"))
        {
            return true;
        }

        var user = await CurrentUserAsync().ConfigureAwait(false);
        return user?.HasPermission(PermissionKind.IsAdministrator) == true;
    }

    private async Task<ActionResult> Forward(HttpMethod method, string path, object? body, CancellationToken ct)
    {
        var userId = await CurrentUserIdAsync().ConfigureAwait(false);
        if (userId == Guid.Empty)
        {
            // API keys have no Jellyfin user; per-user Arclight calls need one.
            return StatusCode(StatusCodes.Status403Forbidden, new { code = "user_required" });
        }

        var response = await _client.SendAsync(method, path, body, userId, ct).ConfigureAwait(false);
        var (status, text) = ProxyValidation.ToBrowser(response.StatusCode, response.Body);
        return new ContentResult { StatusCode = status, Content = text, ContentType = "application/json" };
    }
}

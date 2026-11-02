// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.Arclight.Api;

/// <summary>
/// Playback stats, Year in review and Leaving Soon. Arclight decides who may see what (Settings &gt;
/// Stats &amp; collections); the plugin toggles can only hide more.
/// </summary>
public partial class ArclightController
{
    /// <summary>What the caller may see: <c>{ myStats, wrapped, serverStats, shareLinks, leavingSoon, isAdmin }</c>.</summary>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>Arclight's answer narrowed by the plugin toggles.</returns>
    [HttpGet("Stats/Access")]
    [Authorize]
    public async Task<ActionResult> GetStatsAccess(CancellationToken ct)
    {
        var c = _settings.Config;
        if (!c.EnableMyStats && !c.EnableWrapped && !c.EnableServerStats && !c.EnableLeavingSoon)
        {
            return Disabled();
        }

        var userId = await CurrentUserIdAsync().ConfigureAwait(false);
        if (userId == Guid.Empty)
        {
            return StatusCode(StatusCodes.Status403Forbidden, new { code = "user_required" });
        }

        var response = await _client.SendAsync(HttpMethod.Get, "stats/access", null, userId, ct).ConfigureAwait(false);
        var (status, text) = ProxyValidation.ToBrowser(response.StatusCode, response.Body);
        if (status is >= 200 and < 300)
        {
            text = ProxyValidation.ApplyStatsToggles(text, c);
        }

        return new ContentResult { StatusCode = status, Content = text, ContentType = "application/json" };
    }

    /// <summary>The caller's own playback stats.</summary>
    /// <param name="days">Window in days, 1-3650 (default 30).</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>Arclight's PlaybackStats, top titles marked with <c>jellyfinId</c>.</returns>
    [HttpGet("Stats/Me")]
    [Authorize]
    public async Task<ActionResult> GetMyStats([FromQuery] int? days, CancellationToken ct)
    {
        if (!_settings.Config.EnableMyStats)
        {
            return Disabled();
        }

        var path = ProxyValidation.StatsPath("me", days);
        return path is null ? Invalid("invalid_days") : await ForwardLinked(HttpMethod.Get, path, ct).ConfigureAwait(false);
    }

    /// <summary>Server-wide playback stats (Arclight answers 403 unless the caller may see them).</summary>
    /// <param name="days">Window in days, 1-3650 (default 30).</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>Arclight's PlaybackStats.</returns>
    [HttpGet("Stats/Server")]
    [Authorize]
    public async Task<ActionResult> GetServerStats([FromQuery] int? days, CancellationToken ct)
    {
        if (!_settings.Config.EnableServerStats)
        {
            return Disabled();
        }

        var path = ProxyValidation.StatsPath("server", days);
        return path is null ? Invalid("invalid_days") : await ForwardLinked(HttpMethod.Get, path, ct).ConfigureAwait(false);
    }

    /// <summary>The caller's Year in review.</summary>
    /// <param name="year">2000-2100 (default: the current year).</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>Arclight's Wrapped.</returns>
    [HttpGet("Wrapped")]
    [Authorize]
    public async Task<ActionResult> GetWrapped([FromQuery] int? year, CancellationToken ct)
    {
        if (!_settings.Config.EnableWrapped)
        {
            return Disabled();
        }

        var path = ProxyValidation.WrappedPath(false, year);
        return path is null ? Invalid("invalid_year") : await ForwardLinked(HttpMethod.Get, path, ct).ConfigureAwait(false);
    }

    /// <summary>The caller's Year in review card as SVG markup.</summary>
    /// <param name="year">2000-2100 (default: the current year).</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns><c>{ svg, fileName }</c>.</returns>
    [HttpGet("Wrapped/Image")]
    [Authorize]
    public async Task<ActionResult> GetWrappedImage([FromQuery] int? year, CancellationToken ct)
    {
        if (!_settings.Config.EnableWrapped)
        {
            return Disabled();
        }

        var path = ProxyValidation.WrappedPath(true, year);
        return path is null ? Invalid("invalid_year") : await Forward(HttpMethod.Get, path, null, ct).ConfigureAwait(false);
    }

    /// <summary>Creates an expiring share link to the caller's Year in review (when Arclight allows share links).</summary>
    /// <param name="body">Year.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>201 with Arclight's WrappedShare.</returns>
    [HttpPost("Wrapped/Share")]
    [Authorize]
    public async Task<ActionResult> ShareWrapped([FromBody] WrappedShareBody? body, CancellationToken ct)
    {
        if (!_settings.Config.EnableWrapped)
        {
            return Disabled();
        }

        if (body?.Year is not { } year || !ProxyValidation.IsYear(year))
        {
            return Invalid("invalid_year");
        }

        return await Forward(HttpMethod.Post, "wrapped/share", new { year }, ct).ConfigureAwait(false);
    }

    /// <summary>Titles Arclight's retention rules will remove soon (the "Leaving Soon" row).</summary>
    /// <param name="ct">Cancellation token.</param>
    /// <returns><c>{ name, days, items }</c>, items marked with <c>jellyfinId</c>.</returns>
    [HttpGet("LeavingSoon")]
    [Authorize]
    public async Task<ActionResult> GetLeavingSoon(CancellationToken ct)
        => _settings.Config.EnableLeavingSoon ? await ForwardLinked(HttpMethod.Get, "leaving-soon", ct).ConfigureAwait(false) : Disabled();
}

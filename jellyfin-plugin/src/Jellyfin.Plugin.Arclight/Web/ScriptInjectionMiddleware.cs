// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using Jellyfin.Plugin.Arclight.Arclight;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Arclight.Web;

/// <summary>Tracks whether the web script has actually been injected (shown on the config page).</summary>
public sealed class InjectionStatus
{
    /// <summary>Gets or sets the last time index.html was served with the script.</summary>
    public DateTimeOffset? LastInjected { get; set; }

    /// <summary>Gets or sets the last time the script itself was requested by a browser.</summary>
    public DateTimeOffset? LastScriptServed { get; set; }

    /// <summary>Gets or sets the on-disk patch state message.</summary>
    public string? DiskPatch { get; set; }

    /// <summary>Gets or sets the last injection error.</summary>
    public string? LastError { get; set; }
}

/// <summary>
/// Adds a middleware in front of Jellyfin's pipeline (via <see cref="IStartupFilter"/>) that rewrites
/// the Jellyfin Web entry document on the fly to include the Arclight script. Nothing on disk changes,
/// so it works with read-only web folders and survives Jellyfin upgrades; when the plugin is removed
/// the tag disappears with it.
/// </summary>
public sealed class ScriptInjectionStartupFilter : IStartupFilter
{
    private const int MaxDocumentBytes = 2 * 1024 * 1024;
    private readonly IArclightSettings _settings;
    private readonly InjectionStatus _status;
    private readonly ILogger<ScriptInjectionStartupFilter> _logger;

    /// <summary>Initializes a new instance of the <see cref="ScriptInjectionStartupFilter"/> class.</summary>
    /// <param name="settings">Settings.</param>
    /// <param name="status">Status tracker.</param>
    /// <param name="logger">Logger.</param>
    public ScriptInjectionStartupFilter(IArclightSettings settings, InjectionStatus status, ILogger<ScriptInjectionStartupFilter> logger)
    {
        _settings = settings;
        _status = status;
        _logger = logger;
    }

    /// <inheritdoc />
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
    {
        return app =>
        {
            app.Use(InvokeAsync);
            next(app);
        };
    }

    private async Task InvokeAsync(HttpContext context, Func<Task> next)
    {
        var request = context.Request;
        if (!HttpMethods.IsGet(request.Method)
            || !_settings.Config.EnableWebInjection
            || !IndexHtmlInjector.IsIndexPath(request.PathBase + request.Path, out var prefix))
        {
            await next().ConfigureAwait(false);
            return;
        }

        // Ask the rest of the pipeline for an uncompressed, unconditional copy we can edit.
        request.Headers.Remove("Accept-Encoding");
        request.Headers.Remove("If-None-Match");
        request.Headers.Remove("If-Modified-Since");
        request.Headers.Remove("Range");

        var originalBody = context.Response.Body;
        await using var buffer = new MemoryStream();
        context.Response.Body = buffer;
        try
        {
            await next().ConfigureAwait(false);
        }
        finally
        {
            context.Response.Body = originalBody;
        }

        buffer.Position = 0;
        var response = context.Response;
        var isHtml = response.ContentType?.StartsWith("text/html", StringComparison.OrdinalIgnoreCase) == true;
        if (response.StatusCode == StatusCodes.Status200OK && isHtml && !response.Headers.ContainsKey("Content-Encoding") && buffer.Length < MaxDocumentBytes)
        {
            try
            {
                var html = Encoding.UTF8.GetString(buffer.GetBuffer(), 0, (int)buffer.Length);
                var injected = IndexHtmlInjector.Inject(html, prefix);
                var bytes = Encoding.UTF8.GetBytes(injected);
                response.Headers.Remove("ETag");
                response.Headers.Remove("Last-Modified");
                response.Headers.CacheControl = "no-cache";
                response.ContentLength = bytes.Length;
                await originalBody.WriteAsync(bytes, context.RequestAborted).ConfigureAwait(false);
                _status.LastInjected = DateTimeOffset.UtcNow;
                return;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _status.LastError = ex.Message;
                _logger.LogWarning(ex, "Arclight: could not inject the web script; serving index.html unchanged");
                buffer.Position = 0;
                response.ContentLength = buffer.Length;
            }
        }

        await buffer.CopyToAsync(originalBody, context.RequestAborted).ConfigureAwait(false);
    }
}

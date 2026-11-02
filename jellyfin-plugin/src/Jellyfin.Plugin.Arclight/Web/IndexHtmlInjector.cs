// SPDX-License-Identifier: GPL-3.0-or-later
using System;

namespace Jellyfin.Plugin.Arclight.Web;

/// <summary>Inserts / removes the Arclight script tag in Jellyfin Web's index.html. Pure; unit tested.</summary>
public static class IndexHtmlInjector
{
    /// <summary>Start marker; its presence makes injection idempotent.</summary>
    public const string BeginMarker = "<!-- arclight-jellyfin:begin -->";

    /// <summary>End marker.</summary>
    public const string EndMarker = "<!-- arclight-jellyfin:end -->";

    /// <summary>Plugin version used for cache busting.</summary>
    public static readonly string Version = typeof(IndexHtmlInjector).Assembly.GetName().Version?.ToString() ?? "1";

    /// <summary>Builds the tag block for a given script URL prefix.</summary>
    /// <param name="prefix">URL prefix ending before "Arclight/", e.g. "/" or "/jellyfin/" or "../".</param>
    /// <returns>The block.</returns>
    public static string Block(string prefix)
        => BeginMarker + "<script defer src=\"" + prefix + "Arclight/web/arclight.js?v=" + Version + "\"></script>" + EndMarker;

    /// <summary>Whether the document already contains the block.</summary>
    /// <param name="html">Document.</param>
    /// <returns>True when injected.</returns>
    public static bool IsInjected(string html) => html.Contains(BeginMarker, StringComparison.Ordinal);

    /// <summary>Injects the block before &lt;/body&gt; (or &lt;/head&gt;, or at the end).</summary>
    /// <param name="html">Document.</param>
    /// <param name="prefix">URL prefix.</param>
    /// <returns>The modified document, or the original when already injected.</returns>
    public static string Inject(string html, string prefix)
    {
        if (IsInjected(html))
        {
            return html;
        }

        var block = Block(prefix);
        var at = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        if (at < 0)
        {
            at = html.LastIndexOf("</head>", StringComparison.OrdinalIgnoreCase);
        }

        return at < 0 ? html + block : html.Insert(at, block);
    }

    /// <summary>Removes a previously injected block.</summary>
    /// <param name="html">Document.</param>
    /// <returns>The document without the block.</returns>
    public static string Remove(string html)
    {
        var start = html.IndexOf(BeginMarker, StringComparison.Ordinal);
        if (start < 0)
        {
            return html;
        }

        var end = html.IndexOf(EndMarker, start, StringComparison.Ordinal);
        return end < 0 ? html : html.Remove(start, end + EndMarker.Length - start);
    }

    /// <summary>
    /// Whether a request path is Jellyfin Web's entry document, and if so the URL prefix that leads to
    /// the server root (handles a configured base URL such as /jellyfin).
    /// </summary>
    /// <param name="path">Request path (including any base URL).</param>
    /// <param name="prefix">Prefix such as "/" or "/jellyfin/".</param>
    /// <returns>True for .../web/, .../web/index.html.</returns>
    public static bool IsIndexPath(string? path, out string prefix)
    {
        prefix = "/";
        if (string.IsNullOrEmpty(path))
        {
            return false;
        }

        string root;
        if (path.EndsWith("/web/index.html", StringComparison.OrdinalIgnoreCase))
        {
            root = path[..^"web/index.html".Length];
        }
        else if (path.EndsWith("/web/", StringComparison.OrdinalIgnoreCase))
        {
            root = path[..^"web/".Length];
        }
        else
        {
            return false;
        }

        // Only accept a sane base URL ("/", "/jellyfin/", "/media/jf/").
        if (root.Length > 128 || root.Contains("..", StringComparison.Ordinal) || root.Contains("//", StringComparison.Ordinal) || root.Contains('"') || root.Contains('<'))
        {
            return false;
        }

        prefix = root;
        return true;
    }
}

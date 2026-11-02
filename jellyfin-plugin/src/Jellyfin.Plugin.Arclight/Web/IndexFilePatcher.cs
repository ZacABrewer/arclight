// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.IO;
using System.Text;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Arclight.Web;

/// <summary>
/// Optional fallback: writes the script tag into Jellyfin Web's index.html on disk. Only used when the
/// admin enables it (for setups where something other than Jellyfin serves the web client files, or a
/// proxy caches index.html). Removed again when disabled or when the plugin is uninstalled.
/// </summary>
public static class IndexFilePatcher
{
    /// <summary>Adds the tag to index.html under <paramref name="webPath"/>.</summary>
    /// <param name="webPath">Jellyfin Web folder.</param>
    /// <param name="logger">Logger.</param>
    /// <returns>A status message.</returns>
    public static string TryPatchOnDisk(string? webPath, ILogger? logger)
    {
        var file = IndexFile(webPath);
        if (file is null)
        {
            return "index.html not found (web client hosted elsewhere?)";
        }

        try
        {
            var html = File.ReadAllText(file, Encoding.UTF8);
            if (IndexHtmlInjector.IsInjected(html))
            {
                // Re-write if the version changed.
                html = IndexHtmlInjector.Remove(html);
            }

            File.WriteAllText(file, IndexHtmlInjector.Inject(html, "../"), new UTF8Encoding(false));
            return "patched " + file;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger?.LogWarning("Arclight: cannot patch {File}: {Message}", file, ex.Message);
            return "not writable: " + ex.Message;
        }
    }

    /// <summary>Removes the tag from index.html on disk, if present.</summary>
    /// <param name="webPath">Jellyfin Web folder.</param>
    /// <param name="logger">Logger.</param>
    /// <returns>A status message.</returns>
    public static string TryRemoveFromDisk(string? webPath, ILogger? logger)
    {
        var file = IndexFile(webPath);
        if (file is null)
        {
            return "index.html not found";
        }

        try
        {
            var html = File.ReadAllText(file, Encoding.UTF8);
            if (!IndexHtmlInjector.IsInjected(html))
            {
                return "not patched";
            }

            File.WriteAllText(file, IndexHtmlInjector.Remove(html), new UTF8Encoding(false));
            return "removed";
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger?.LogWarning("Arclight: cannot unpatch {File}: {Message}", file, ex.Message);
            return "not writable: " + ex.Message;
        }
    }

    private static string? IndexFile(string? webPath)
    {
        if (string.IsNullOrEmpty(webPath))
        {
            return null;
        }

        var file = Path.Combine(webPath, "index.html");
        return File.Exists(file) ? file : null;
    }
}

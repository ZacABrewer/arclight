// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.Arclight.Configuration;

namespace Jellyfin.Plugin.Arclight.Web;

/// <summary>Theme choice rules (pure; unit tested).</summary>
public static partial class ThemeChoices
{
    /// <summary>No theme.</summary>
    public const string Off = "off";

    /// <summary>Follow the user's Arclight theme.</summary>
    public const string Follow = "follow";

    /// <summary>Whether a value is a plausible Arclight pack id.</summary>
    /// <param name="value">Value.</param>
    /// <returns>True for 1-64 lowercase letters, digits and dashes.</returns>
    public static bool IsPackId(string? value) => value is not null && PackId().IsMatch(value);

    /// <summary>Normalises a stored or submitted choice.</summary>
    /// <param name="value">Raw value.</param>
    /// <returns>"off", "follow", a pack id, or null when invalid.</returns>
    public static string? Normalize(string? value)
    {
        var v = (value ?? string.Empty).Trim().ToLowerInvariant();
        if (v.Length == 0 || v == Off)
        {
            return Off;
        }

        return v == Follow || IsPackId(v) ? v : null;
    }

    /// <summary>The admin default as a choice ("off" when empty).</summary>
    /// <param name="config">Configuration.</param>
    /// <returns>Choice.</returns>
    public static string DefaultChoice(PluginConfiguration config) => Normalize(config.DefaultTheme) ?? Off;

    /// <summary>The user's stored choice, or null when they never picked one.</summary>
    /// <param name="config">Configuration.</param>
    /// <param name="userId">Jellyfin user id.</param>
    /// <returns>Choice or null.</returns>
    public static string? StoredChoice(PluginConfiguration config, Guid userId)
    {
        var key = userId.ToString("N");
        var entry = config.UserThemes.FirstOrDefault(u => string.Equals(u.UserId, key, StringComparison.OrdinalIgnoreCase));
        return entry is null ? null : Normalize(entry.Theme);
    }

    /// <summary>The choice that applies: the user's own when allowed and set, else the admin default.</summary>
    /// <param name="config">Configuration.</param>
    /// <param name="userId">Jellyfin user id.</param>
    /// <returns>"off", "follow" or a pack id.</returns>
    public static string EffectiveChoice(PluginConfiguration config, Guid userId)
        => (config.LetUsersChooseTheme ? StoredChoice(config, userId) : null) ?? DefaultChoice(config);

    /// <summary>Stores (or clears, with null) a user's choice.</summary>
    /// <param name="config">Configuration.</param>
    /// <param name="userId">Jellyfin user id.</param>
    /// <param name="choice">Normalised choice, or null to fall back to the default.</param>
    public static void SetChoice(PluginConfiguration config, Guid userId, string? choice)
    {
        var key = userId.ToString("N");
        config.UserThemes.RemoveAll(u => string.Equals(u.UserId, key, StringComparison.OrdinalIgnoreCase));
        if (choice is not null)
        {
            config.UserThemes.Add(new UserThemeChoice { UserId = key, Theme = choice });
        }
    }

    [GeneratedRegex("^[a-z0-9][a-z0-9-]{0,63}$")]
    private static partial Regex PackId();
}

/// <summary>In-memory cache of theme stylesheets and fonts fetched from Arclight.</summary>
public sealed class ThemeCache
{
    private const int MaxEntries = 200;
    private readonly ConcurrentDictionary<string, Entry> _entries = new(StringComparer.Ordinal);

    /// <summary>Gets a cached entry younger than <paramref name="maxAge"/>.</summary>
    /// <param name="key">Cache key.</param>
    /// <param name="maxAge">Maximum age.</param>
    /// <param name="entry">Entry.</param>
    /// <returns>True on a fresh hit.</returns>
    public bool TryGetFresh(string key, TimeSpan maxAge, out Entry entry)
        => _entries.TryGetValue(key, out entry!) && DateTimeOffset.UtcNow - entry.FetchedAt < maxAge;

    /// <summary>Gets any cached entry (for revalidation).</summary>
    /// <param name="key">Cache key.</param>
    /// <returns>Entry or null.</returns>
    public Entry? Get(string key) => _entries.TryGetValue(key, out var e) ? e : null;

    /// <summary>Stores an entry.</summary>
    /// <param name="key">Cache key.</param>
    /// <param name="entry">Entry.</param>
    public void Set(string key, Entry entry)
    {
        if (_entries.Count >= MaxEntries)
        {
            _entries.Clear();
        }

        _entries[key] = entry;
    }

    /// <summary>A cached upstream response.</summary>
    /// <param name="Status">HTTP status.</param>
    /// <param name="Body">Body.</param>
    /// <param name="ContentType">Content type.</param>
    /// <param name="ETag">ETag.</param>
    /// <param name="FetchedAt">When fetched.</param>
    public sealed record Entry(int Status, byte[] Body, string? ContentType, string? ETag, DateTimeOffset FetchedAt);
}

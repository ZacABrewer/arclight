// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.Collections.Generic;
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

/// <summary>
/// In-memory cache of theme stylesheets and fonts fetched from Arclight, plus the installed pack
/// catalogue the anonymous theme routes check ids against. Bounded: least recently used entries are
/// evicted one at a time, and misses (404s, upstream failures) are remembered briefly so the same
/// bad request does not reach Arclight again and again.
/// </summary>
public sealed class ThemeCache
{
    /// <summary>Most cached resources.</summary>
    internal const int MaxEntries = 200;

    /// <summary>How long a 404 from Arclight is remembered.</summary>
    internal static readonly TimeSpan MissTtl = TimeSpan.FromMinutes(5);

    /// <summary>How long a failed fetch (Arclight unreachable or erroring) is remembered.</summary>
    internal static readonly TimeSpan FailureTtl = TimeSpan.FromSeconds(30);

    /// <summary>How long a fetched catalogue is trusted.</summary>
    internal static readonly TimeSpan CatalogueTtl = TimeSpan.FromMinutes(10);

    /// <summary>
    /// Minimum gap between catalogue fetches: a failed fetch, or an id the catalogue does not list (a
    /// pack installed moments ago), refreshes it at most this often.
    /// </summary>
    internal static readonly TimeSpan CatalogueRetry = TimeSpan.FromMinutes(1);

    private readonly object _lock = new();
    private readonly Dictionary<string, LinkedListNode<(string Key, Entry Entry)>> _entries = new(StringComparer.Ordinal);
    private readonly LinkedList<(string Key, Entry Entry)> _order = new();
    private readonly TimeProvider _time;
    private (HashSet<string>? Ids, DateTimeOffset At)? _catalogue;

    /// <summary>Initializes a new instance of the <see cref="ThemeCache"/> class.</summary>
    public ThemeCache()
        : this(TimeProvider.System)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="ThemeCache"/> class (tests).</summary>
    /// <param name="time">Clock.</param>
    internal ThemeCache(TimeProvider time)
    {
        _time = time;
    }

    /// <summary>Gets the current time on the cache's clock.</summary>
    public DateTimeOffset Now => _time.GetUtcNow();

    /// <summary>Gets the number of cached resources.</summary>
    public int Count
    {
        get
        {
            lock (_lock)
            {
                return _entries.Count;
            }
        }
    }

    /// <summary>
    /// Gets a cached entry that is still fresh: a 200 younger than <paramref name="maxAge"/>, a 404
    /// younger than <see cref="MissTtl"/>, a failure younger than <see cref="FailureTtl"/>.
    /// </summary>
    /// <param name="key">Cache key.</param>
    /// <param name="maxAge">Maximum age of a good copy.</param>
    /// <param name="entry">Entry.</param>
    /// <returns>True on a fresh hit.</returns>
    public bool TryGetFresh(string key, TimeSpan maxAge, out Entry entry)
    {
        var found = Get(key);
        entry = found!;
        if (found is null)
        {
            return false;
        }

        var ttl = found.Status switch
        {
            200 => maxAge,
            404 => MissTtl < maxAge ? MissTtl : maxAge,
            _ => FailureTtl,
        };
        return Now - found.FetchedAt < ttl;
    }

    /// <summary>Gets any cached entry (for revalidation) and marks it recently used.</summary>
    /// <param name="key">Cache key.</param>
    /// <returns>Entry or null.</returns>
    public Entry? Get(string key)
    {
        lock (_lock)
        {
            if (!_entries.TryGetValue(key, out var node))
            {
                return null;
            }

            _order.Remove(node);
            _order.AddFirst(node);
            return node.Value.Entry;
        }
    }

    /// <summary>Stores an entry, evicting the least recently used one when full.</summary>
    /// <param name="key">Cache key.</param>
    /// <param name="entry">Entry.</param>
    public void Set(string key, Entry entry)
    {
        lock (_lock)
        {
            if (_entries.TryGetValue(key, out var existing))
            {
                _order.Remove(existing);
                _entries.Remove(key);
            }

            while (_entries.Count >= MaxEntries && _order.Last is { } oldest)
            {
                _order.RemoveLast();
                _entries.Remove(oldest.Value.Key);
            }

            _entries[key] = _order.AddFirst((key, entry));
        }
    }

    /// <summary>
    /// Gets the cached catalogue of installed pack ids.
    /// </summary>
    /// <param name="ids">Known ids, or null when the last fetch failed and nothing was known before.</param>
    /// <param name="age">Age of the catalogue.</param>
    /// <returns>False when no catalogue was ever fetched.</returns>
    public bool TryGetCatalogue(out IReadOnlySet<string>? ids, out TimeSpan age)
    {
        lock (_lock)
        {
            ids = _catalogue?.Ids;
            age = _catalogue is { } c ? Now - c.At : TimeSpan.MaxValue;
            return _catalogue is not null;
        }
    }

    /// <summary>Stores a fetched catalogue; null (a failed fetch) keeps the previous ids but restarts the retry timer.</summary>
    /// <param name="ids">Installed pack ids, or null.</param>
    public void SetCatalogue(IEnumerable<string>? ids)
    {
        lock (_lock)
        {
            var set = ids is null ? _catalogue?.Ids : new HashSet<string>(ids, StringComparer.Ordinal);
            _catalogue = (set, Now);
        }
    }

    /// <summary>Reads the pack ids from Arclight's <c>GET /jellyfin/themes</c> body.</summary>
    /// <param name="body">JSON body.</param>
    /// <returns>Valid pack ids, or null when the body is not a catalogue.</returns>
    public static IReadOnlyList<string>? ParseCatalogue(string body)
    {
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(body);
            if (doc.RootElement.ValueKind != System.Text.Json.JsonValueKind.Object
                || !doc.RootElement.TryGetProperty("themes", out var list)
                || list.ValueKind != System.Text.Json.JsonValueKind.Array)
            {
                return null;
            }

            var ids = new List<string>();
            foreach (var t in list.EnumerateArray())
            {
                if (t.ValueKind == System.Text.Json.JsonValueKind.Object
                    && t.TryGetProperty("id", out var id)
                    && id.ValueKind == System.Text.Json.JsonValueKind.String
                    && ThemeChoices.IsPackId(id.GetString())
                    && ids.Count < 500)
                {
                    ids.Add(id.GetString()!);
                }
            }

            return ids;
        }
        catch (System.Text.Json.JsonException)
        {
            return null;
        }
    }

    /// <summary>A cached upstream response.</summary>
    /// <param name="Status">HTTP status (200, 404, or 502 for a failed fetch).</param>
    /// <param name="Body">Body.</param>
    /// <param name="ContentType">Content type (informational only; responses use a fixed type).</param>
    /// <param name="ETag">ETag.</param>
    /// <param name="FetchedAt">When fetched.</param>
    public sealed record Entry(int Status, byte[] Body, string? ContentType, string? ETag, DateTimeOffset FetchedAt);
}

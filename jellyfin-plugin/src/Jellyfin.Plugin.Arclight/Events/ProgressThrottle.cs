// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.Collections.Generic;

namespace Jellyfin.Plugin.Arclight.Events;

/// <summary>
/// Lets through at most one progress event per session+item per interval. A pause/resume change is
/// always let through so Arclight sees state changes promptly. Thread-safe.
/// </summary>
public sealed class ProgressThrottle
{
    private readonly object _lock = new();
    private readonly Dictionary<string, (DateTimeOffset At, bool Paused)> _last = new(StringComparer.Ordinal);

    /// <summary>Gets the number of tracked sessions (tests/diagnostics).</summary>
    public int Count
    {
        get
        {
            lock (_lock)
            {
                return _last.Count;
            }
        }
    }

    /// <summary>Records a playback start so the first progress event waits a full interval.</summary>
    /// <param name="sessionId">Session id.</param>
    /// <param name="itemId">Item id.</param>
    /// <param name="now">Current time.</param>
    public void OnStart(string? sessionId, string itemId, DateTimeOffset now)
    {
        lock (_lock)
        {
            _last[Key(sessionId, itemId)] = (now, false);
            Prune(now);
        }
    }

    /// <summary>Decides whether a progress event should be forwarded, and records it if so.</summary>
    /// <param name="sessionId">Session id.</param>
    /// <param name="itemId">Item id.</param>
    /// <param name="isPaused">Paused flag.</param>
    /// <param name="now">Current time.</param>
    /// <param name="interval">Minimum interval.</param>
    /// <returns>True to forward.</returns>
    public bool ShouldForward(string? sessionId, string itemId, bool isPaused, DateTimeOffset now, TimeSpan interval)
    {
        var key = Key(sessionId, itemId);
        lock (_lock)
        {
            if (_last.TryGetValue(key, out var last) && last.Paused == isPaused && now - last.At < interval)
            {
                return false;
            }

            _last[key] = (now, isPaused);
            return true;
        }
    }

    /// <summary>Forgets a session+item when playback stops.</summary>
    /// <param name="sessionId">Session id.</param>
    /// <param name="itemId">Item id.</param>
    public void OnStop(string? sessionId, string itemId)
    {
        lock (_lock)
        {
            _last.Remove(Key(sessionId, itemId));
        }
    }

    private static string Key(string? sessionId, string itemId) => (sessionId ?? string.Empty) + "|" + itemId;

    private void Prune(DateTimeOffset now)
    {
        if (_last.Count < 1000)
        {
            return;
        }

        var stale = new List<string>();
        foreach (var (k, v) in _last)
        {
            if (now - v.At > TimeSpan.FromHours(12))
            {
                stale.Add(k);
            }
        }

        foreach (var k in stale)
        {
            _last.Remove(k);
        }
    }
}

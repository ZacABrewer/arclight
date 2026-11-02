// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.Collections.Generic;

namespace Jellyfin.Plugin.Arclight.Events;

/// <summary>
/// Jellyfin raises ItemAdded before metadata (and so provider ids) is fetched. Items added without
/// matchable ids wait here until an ItemUpdated brings ids, or until they expire, then are sent anyway.
/// </summary>
public sealed class PendingItems
{
    private const int MaxPending = 20000;
    private readonly object _lock = new();
    private readonly Dictionary<Guid, DateTimeOffset> _pending = new();

    /// <summary>Gets the number of waiting items.</summary>
    public int Count
    {
        get
        {
            lock (_lock)
            {
                return _pending.Count;
            }
        }
    }

    /// <summary>Starts waiting for an item.</summary>
    /// <param name="id">Item id.</param>
    /// <param name="now">Current time.</param>
    /// <returns>False when the tracker is full (caller should send immediately).</returns>
    public bool Add(Guid id, DateTimeOffset now)
    {
        lock (_lock)
        {
            if (_pending.Count >= MaxPending && !_pending.ContainsKey(id))
            {
                return false;
            }

            _pending.TryAdd(id, now);
            return true;
        }
    }

    /// <summary>Whether an item is waiting.</summary>
    /// <param name="id">Item id.</param>
    /// <returns>True when pending.</returns>
    public bool Contains(Guid id)
    {
        lock (_lock)
        {
            return _pending.ContainsKey(id);
        }
    }

    /// <summary>Stops waiting for an item.</summary>
    /// <param name="id">Item id.</param>
    /// <returns>True when it was pending.</returns>
    public bool Remove(Guid id)
    {
        lock (_lock)
        {
            return _pending.Remove(id);
        }
    }

    /// <summary>Removes and returns items older than <paramref name="maxAge"/>.</summary>
    /// <param name="now">Current time.</param>
    /// <param name="maxAge">Maximum wait.</param>
    /// <returns>Expired ids.</returns>
    public List<Guid> TakeExpired(DateTimeOffset now, TimeSpan maxAge)
    {
        var result = new List<Guid>();
        lock (_lock)
        {
            foreach (var (id, at) in _pending)
            {
                if (now - at >= maxAge)
                {
                    result.Add(id);
                }
            }

            foreach (var id in result)
            {
                _pending.Remove(id);
            }
        }

        return result;
    }
}

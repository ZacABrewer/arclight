// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.Collections.Generic;

namespace Jellyfin.Plugin.Arclight.Events;

/// <summary>
/// Bounded in-memory FIFO of pending events. Enqueue never blocks for long and never throws.
/// When full, the oldest <c>playbackProgress</c> event is dropped first (they are superseded by later
/// ones anyway); only if none is queued is the oldest event of any type dropped.
/// </summary>
public sealed class EventQueue
{
    private readonly object _lock = new();
    private readonly LinkedList<ArclightEvent> _items = new();
    private int _capacity;

    /// <summary>Initializes a new instance of the <see cref="EventQueue"/> class.</summary>
    /// <param name="capacity">Maximum queued events.</param>
    public EventQueue(int capacity)
    {
        _capacity = Math.Max(1, capacity);
    }

    /// <summary>Raised (outside the lock) when the queue reaches the flush threshold.</summary>
    public event EventHandler? ThresholdReached;

    /// <summary>Gets or sets the number of events that triggers an early flush.</summary>
    public int FlushThreshold { get; set; } = 200;

    /// <summary>Gets the number of events dropped because the queue was full.</summary>
    public long Dropped { get; private set; }

    /// <summary>Gets the number of queued events.</summary>
    public int Count
    {
        get
        {
            lock (_lock)
            {
                return _items.Count;
            }
        }
    }

    /// <summary>Gets or sets the capacity (shrinking drops events by the overflow policy).</summary>
    public int Capacity
    {
        get
        {
            lock (_lock)
            {
                return _capacity;
            }
        }

        set
        {
            lock (_lock)
            {
                _capacity = Math.Max(1, value);
                while (_items.Count > _capacity)
                {
                    DropOne();
                }
            }
        }
    }

    /// <summary>Adds events at the back.</summary>
    /// <param name="events">Events.</param>
    public void Enqueue(IEnumerable<ArclightEvent> events)
    {
        bool signal;
        lock (_lock)
        {
            foreach (var e in events)
            {
                if (_items.Count >= _capacity)
                {
                    // A new progress event is the least valuable thing we could keep.
                    if (e.Type == EventTypes.PlaybackProgress && !HasProgress())
                    {
                        Dropped++;
                        continue;
                    }

                    DropOne();
                }

                _items.AddLast(e);
            }

            signal = _items.Count >= FlushThreshold;
        }

        if (signal)
        {
            ThresholdReached?.Invoke(this, EventArgs.Empty);
        }
    }

    /// <summary>Adds one event at the back.</summary>
    /// <param name="e">Event.</param>
    public void Enqueue(ArclightEvent e) => Enqueue(new[] { e });

    /// <summary>Removes up to <paramref name="max"/> events from the front.</summary>
    /// <param name="max">Batch size.</param>
    /// <returns>The batch (possibly empty).</returns>
    public List<ArclightEvent> TakeBatch(int max)
    {
        var batch = new List<ArclightEvent>(Math.Min(max, 512));
        lock (_lock)
        {
            while (batch.Count < max && _items.First is { } node)
            {
                batch.Add(node.Value);
                _items.RemoveFirst();
            }
        }

        return batch;
    }

    /// <summary>Puts a failed batch back at the front, preserving order, within capacity.</summary>
    /// <param name="batch">Batch returned by <see cref="TakeBatch"/>.</param>
    public void Requeue(IReadOnlyList<ArclightEvent> batch)
    {
        lock (_lock)
        {
            for (var i = batch.Count - 1; i >= 0; i--)
            {
                if (_items.Count >= _capacity)
                {
                    // Make room by the normal policy; if the event being re-added is itself progress, just drop it.
                    if (batch[i].Type == EventTypes.PlaybackProgress)
                    {
                        Dropped++;
                        continue;
                    }

                    DropOne();
                }

                _items.AddFirst(batch[i]);
            }
        }
    }

    private bool HasProgress()
    {
        for (var n = _items.First; n is not null; n = n.Next)
        {
            if (n.Value.Type == EventTypes.PlaybackProgress)
            {
                return true;
            }
        }

        return false;
    }

    private void DropOne()
    {
        for (var n = _items.First; n is not null; n = n.Next)
        {
            if (n.Value.Type == EventTypes.PlaybackProgress)
            {
                _items.Remove(n);
                Dropped++;
                return;
            }
        }

        if (_items.First is not null)
        {
            _items.RemoveFirst();
            Dropped++;
        }
    }
}

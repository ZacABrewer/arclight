// SPDX-License-Identifier: GPL-3.0-or-later
using Jellyfin.Plugin.Arclight.Events;
using Xunit;

namespace Jellyfin.Plugin.Arclight.Tests;

public class QueueAndThrottleTests
{
    private static readonly DateTimeOffset T0 = new(2026, 11, 1, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Throttle_allows_one_progress_per_interval()
    {
        var throttle = new ProgressThrottle();
        var interval = TimeSpan.FromSeconds(60);
        throttle.OnStart("s", "i", T0);

        Assert.False(throttle.ShouldForward("s", "i", false, T0.AddSeconds(10), interval));
        Assert.False(throttle.ShouldForward("s", "i", false, T0.AddSeconds(59), interval));
        Assert.True(throttle.ShouldForward("s", "i", false, T0.AddSeconds(60), interval));
        Assert.False(throttle.ShouldForward("s", "i", false, T0.AddSeconds(90), interval));
        Assert.True(throttle.ShouldForward("s", "i", false, T0.AddSeconds(121), interval));
    }

    [Fact]
    public void Throttle_lets_pause_changes_through_and_tracks_sessions_separately()
    {
        var throttle = new ProgressThrottle();
        var interval = TimeSpan.FromSeconds(60);
        throttle.OnStart("s", "i", T0);

        Assert.True(throttle.ShouldForward("s", "i", true, T0.AddSeconds(5), interval));   // paused
        Assert.False(throttle.ShouldForward("s", "i", true, T0.AddSeconds(10), interval));
        Assert.True(throttle.ShouldForward("s", "i", false, T0.AddSeconds(12), interval)); // resumed
        Assert.True(throttle.ShouldForward("other", "i", false, T0.AddSeconds(12), interval));

        throttle.OnStop("s", "i");
        throttle.OnStop("other", "i");
        Assert.Equal(0, throttle.Count);
    }

    [Fact]
    public void Queue_overflow_drops_progress_first()
    {
        var q = new EventQueue(3);
        q.Enqueue(Samples.Event(EventTypes.PlaybackStart));
        q.Enqueue(Samples.Event(EventTypes.PlaybackProgress));
        q.Enqueue(Samples.Event(EventTypes.PlaybackStop));
        q.Enqueue(Samples.Event(EventTypes.ItemAdded)); // full: the progress event goes

        var batch = q.TakeBatch(10);
        Assert.Equal(new[] { "playbackStart", "playbackStop", "itemAdded" }, batch.Select(e => e.Type));
        Assert.Equal(1, q.Dropped);
    }

    [Fact]
    public void Queue_overflow_without_progress_drops_oldest_and_rejects_new_progress()
    {
        var q = new EventQueue(2);
        q.Enqueue(Samples.Event(EventTypes.UserCreated));
        q.Enqueue(Samples.Event(EventTypes.ItemAdded));
        q.Enqueue(Samples.Event(EventTypes.PlaybackProgress)); // dropped itself
        q.Enqueue(Samples.Event(EventTypes.PlaybackStop));     // evicts the oldest (userCreated)

        Assert.Equal(new[] { "itemAdded", "playbackStop" }, q.TakeBatch(10).Select(e => e.Type));
        Assert.Equal(2, q.Dropped);
    }

    [Fact]
    public void Requeue_restores_order_at_the_front()
    {
        var q = new EventQueue(10);
        for (var i = 0; i < 5; i++)
        {
            q.Enqueue(new ArclightEvent { Type = EventTypes.ItemAdded, At = i.ToString() });
        }

        var batch = q.TakeBatch(3);
        q.Enqueue(new ArclightEvent { Type = EventTypes.ItemAdded, At = "5" });
        q.Requeue(batch);

        Assert.Equal(new[] { "0", "1", "2", "3", "4", "5" }, q.TakeBatch(10).Select(e => e.At));
    }

    [Fact]
    public void Threshold_raises_signal()
    {
        var q = new EventQueue(1000) { FlushThreshold = 3 };
        var signals = 0;
        q.ThresholdReached += (_, _) => signals++;
        q.Enqueue(Samples.Event(EventTypes.ItemAdded));
        q.Enqueue(Samples.Event(EventTypes.ItemAdded));
        Assert.Equal(0, signals);
        q.Enqueue(Samples.Event(EventTypes.ItemAdded));
        Assert.Equal(1, signals);
    }

    [Fact]
    public void Shrinking_capacity_applies_the_drop_policy()
    {
        var q = new EventQueue(10);
        q.Enqueue(Samples.Event(EventTypes.PlaybackProgress));
        q.Enqueue(Samples.Event(EventTypes.ItemAdded));
        q.Enqueue(Samples.Event(EventTypes.PlaybackProgress));
        q.Capacity = 1;
        Assert.Equal(new[] { "itemAdded" }, q.TakeBatch(10).Select(e => e.Type));
    }
}

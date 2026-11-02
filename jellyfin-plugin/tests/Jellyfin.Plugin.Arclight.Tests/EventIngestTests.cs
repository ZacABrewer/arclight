// SPDX-License-Identifier: GPL-3.0-or-later
using Jellyfin.Plugin.Arclight.Events;
using Xunit;

namespace Jellyfin.Plugin.Arclight.Tests;

public class EventIngestTests
{
    private readonly FakeSettings _settings = new();
    private readonly ManualTime _time = new();
    private readonly EventQueue _queue = new(1000);
    private readonly EventIngest _ingest;

    public EventIngestTests()
    {
        _ingest = new EventIngest(_queue, _settings, _time);
    }

    private PlaybackSnapshot Snap(bool paused = false) => new()
    {
        SessionId = "s1",
        Users = new[] { (Guid.NewGuid(), "alice") },
        Item = Samples.Movie(),
        IsPaused = paused,
    };

    [Fact]
    public void Progress_is_throttled_per_configured_interval()
    {
        _settings.Config.ProgressThrottleSeconds = 60;
        var snap = Snap();
        _ingest.PlaybackStart(snap);
        for (var i = 0; i < 12; i++)
        {
            _time.Advance(TimeSpan.FromSeconds(10)); // Jellyfin Web reports every ~10 s
            _ingest.PlaybackProgress(snap);
        }

        _ingest.PlaybackStop(snap);
        var types = _queue.TakeBatch(100).Select(e => e.Type).ToList();
        Assert.Equal(new[] { "playbackStart", "playbackProgress", "playbackProgress", "playbackStop" }, types);
    }

    [Fact]
    public void Nothing_is_queued_when_unconfigured_or_disabled()
    {
        _settings.ApiKey = string.Empty;
        _ingest.PlaybackStart(Snap());
        Assert.Equal(0, _queue.Count);

        _settings.ApiKey = "k";
        _settings.Config.EnablePlaybackEvents = false;
        _ingest.PlaybackStart(Snap());
        Assert.Equal(0, _queue.Count);

        _settings.Config.EnablePlaybackEvents = true;
        _settings.Config.EnableEventForwarding = false;
        _ingest.PlaybackStart(Snap());
        _ingest.User(EventTypes.UserCreated, Guid.NewGuid(), "x");
        Assert.Equal(0, _queue.Count);
    }

    [Fact]
    public void Item_added_without_ids_waits_for_metadata()
    {
        var id = Guid.NewGuid();
        var bare = new EventItem { Id = id.ToString("N"), Type = "Movie", Name = "New" };
        _ingest.ItemAdded(id, bare);
        Assert.Equal(0, _queue.Count);
        Assert.Equal(1, _ingest.Pending.Count);

        // An update that still has no ids keeps waiting.
        _ingest.ItemUpdated(id, () => bare);
        Assert.Equal(0, _queue.Count);

        var withIds = new EventItem { Id = bare.Id, Type = "Movie", Name = "New", ProviderIds = new() { ["Tmdb"] = "1" } };
        _ingest.ItemUpdated(id, () => withIds);
        var e = Assert.Single(_queue.TakeBatch(10));
        Assert.Equal("itemAdded", e.Type);
        Assert.Equal("1", e.Item!.ProviderIds["Tmdb"]);
        Assert.Equal(0, _ingest.Pending.Count);
    }

    [Fact]
    public void Item_added_is_sent_anyway_after_the_wait_expires()
    {
        var id = Guid.NewGuid();
        _ingest.ItemAdded(id, new EventItem { Id = id.ToString("N"), Type = "Movie", Name = "Obscure" });
        _time.Advance(TimeSpan.FromMinutes(5));
        Assert.Equal(0, _ingest.ReleaseExpired(_ => new EventItem { Type = "Movie" }));
        _time.Advance(TimeSpan.FromMinutes(6));
        Assert.Equal(1, _ingest.ReleaseExpired(_ => new EventItem { Id = id.ToString("N"), Type = "Movie", Name = "Obscure" }));
        Assert.Equal("itemAdded", Assert.Single(_queue.TakeBatch(10)).Type);
    }

    [Fact]
    public void Item_added_with_ids_is_sent_immediately_and_kinds_are_filtered()
    {
        _ingest.ItemAdded(Guid.NewGuid(), Samples.Movie());
        _ingest.ItemAdded(Guid.NewGuid(), new EventItem { Type = "Folder", ProviderIds = new() { ["Tmdb"] = "1" } });
        Assert.Single(_queue.TakeBatch(10));
        Assert.False(_ingest.WantsItemAdded("Episode", isVirtual: true));
        Assert.True(_ingest.WantsItemAdded("Episode", isVirtual: false));
    }

    [Fact]
    public void Duplicate_user_events_within_two_seconds_are_merged()
    {
        var uid = Guid.NewGuid();
        _ingest.User(EventTypes.UserUpdated, uid, "a");
        _ingest.User(EventTypes.UserUpdated, uid, "a");
        _time.Advance(TimeSpan.FromSeconds(3));
        _ingest.User(EventTypes.UserUpdated, uid, "a");
        _ingest.User(EventTypes.UserDeleted, uid, "a");
        Assert.Equal(new[] { "userUpdated", "userUpdated", "userDeleted" }, _queue.TakeBatch(10).Select(e => e.Type));
    }

    [Fact]
    public void User_data_filters_progress_reasons()
    {
        var uid = Guid.NewGuid();
        _ingest.UserDataSaved("PlaybackProgress", uid, "a", Samples.Movie(), new UserDataSnapshot(false, 0, false, 10));
        _ingest.UserDataSaved("TogglePlayed", uid, "a", Samples.Movie(), new UserDataSnapshot(true, 1, false, 0));
        var e = Assert.Single(_queue.TakeBatch(10));
        Assert.True(e.Played);
        Assert.Equal(1, e.PlayCount);
    }
}

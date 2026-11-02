// SPDX-License-Identifier: GPL-3.0-or-later
using System.Text.Json;
using Jellyfin.Plugin.Arclight.Arclight;
using Jellyfin.Plugin.Arclight.Events;
using Xunit;

namespace Jellyfin.Plugin.Arclight.Tests;

public class EventMappingTests
{
    private static readonly DateTimeOffset At = new(2026, 11, 1, 12, 34, 56, 789, TimeSpan.Zero);

    [Fact]
    public void Playback_creates_one_event_per_user_with_session_details()
    {
        var a = Guid.Parse("11111111-2222-3333-4444-555555555555");
        var b = Guid.Parse("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        var snap = new PlaybackSnapshot
        {
            SessionId = "sess-1",
            Users = new[] { (a, "alice"), (b, "bob"), (Guid.Empty, "ghost") },
            Item = Samples.Episode(),
            PositionTicks = 600_000_000,
            Client = "Jellyfin Web",
            DeviceName = "Firefox",
            PlayMethod = "Transcode",
        };

        var events = EventMapper.FromPlayback(EventTypes.PlaybackStart, snap, At);

        Assert.Equal(2, events.Count);
        Assert.Equal("11111111222233334444555555555555", events[0].JellyfinUserId);
        Assert.Equal("alice", events[0].UserName);
        Assert.Equal("aaaaaaaabbbbccccddddeeeeeeeeeeee", events[1].JellyfinUserId);
        Assert.All(events, e =>
        {
            Assert.Equal("playbackStart", e.Type);
            Assert.Equal("2026-11-01T12:34:56.789Z", e.At);
            Assert.Equal("sess-1", e.SessionId);
            Assert.Equal("Transcode", e.PlayMethod);
            Assert.Equal(600_000_000, e.PositionTicks);
            Assert.Null(e.Played);
        });
    }

    [Fact]
    public void Playback_stop_carries_played_to_completion()
    {
        var snap = new PlaybackSnapshot { Users = new[] { (Guid.NewGuid(), "u") }, Item = Samples.Movie(), PlayedToCompletion = true };
        var e = Assert.Single(EventMapper.FromPlayback(EventTypes.PlaybackStop, snap, At));
        Assert.True(e.Played);
    }

    [Fact]
    public void Playback_without_item_is_ignored()
    {
        var snap = new PlaybackSnapshot { Users = new[] { (Guid.NewGuid(), "u") } };
        Assert.Empty(EventMapper.FromPlayback(EventTypes.PlaybackStart, snap, At));
    }

    [Theory]
    [InlineData("DirectPlay", "DirectPlay")]
    [InlineData("DirectStream", "DirectStream")]
    [InlineData("Transcode", "Transcode")]
    [InlineData("Something", null)]
    [InlineData(null, null)]
    public void Play_method_is_normalised(string? input, string? expected) => Assert.Equal(expected, EventMapper.NormalizePlayMethod(input));

    [Fact]
    public void Provider_ids_drop_empty_values()
    {
        var ids = EventMapper.CleanProviderIds(new Dictionary<string, string> { ["Tmdb"] = " 550 ", ["Imdb"] = "", ["Tvdb"] = "  " });
        Assert.Equal(new Dictionary<string, string> { ["Tmdb"] = "550" }, ids);
    }

    [Theory]
    [InlineData("TogglePlayed", true)]
    [InlineData("UpdateUserRating", true)]
    [InlineData("PlaybackFinished", true)]
    [InlineData("UpdateUserData", true)]
    [InlineData("Import", true)]
    [InlineData("PlaybackProgress", false)]
    [InlineData("PlaybackStart", false)]
    public void User_data_reasons_filtered(string reason, bool forwarded) => Assert.Equal(forwarded, EventMapper.ShouldForwardUserData(reason));

    [Fact]
    public void Matchable_ids_use_series_ids_for_episodes()
    {
        Assert.True(EventMapper.HasMatchableIds(Samples.Movie()));
        Assert.True(EventMapper.HasMatchableIds(Samples.Episode(true)));
        Assert.False(EventMapper.HasMatchableIds(Samples.Episode(false)));
        Assert.False(EventMapper.HasMatchableIds(new EventItem { Type = "Movie" }));
    }

    [Fact]
    public void Batch_serialises_to_the_contract_shape()
    {
        var uid = Guid.Parse("11111111-2222-3333-4444-555555555555");
        var batch = new EventBatch
        {
            ServerId = "srv",
            Events = new[]
            {
                EventMapper.FromUserData(uid, "alice", Samples.Episode(), new UserDataSnapshot(true, 2, false, 0), At),
                EventMapper.FromUser(EventTypes.UserCreated, uid, "alice", At),
            },
        };

        var json = JsonSerializer.Serialize(batch, ArclightClient.JsonOptions);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        Assert.Equal("srv", root.GetProperty("serverId").GetString());
        var first = root.GetProperty("events")[0];
        Assert.Equal("userDataSaved", first.GetProperty("type").GetString());
        Assert.Equal("11111111222233334444555555555555", first.GetProperty("jellyfinUserId").GetString());
        Assert.True(first.GetProperty("played").GetBoolean());
        Assert.Equal(2, first.GetProperty("playCount").GetInt32());
        var item = first.GetProperty("item");
        Assert.Equal("Episode", item.GetProperty("type").GetString());
        Assert.Equal("81189", item.GetProperty("seriesProviderIds").GetProperty("Tvdb").GetString());
        Assert.Equal(1, item.GetProperty("seasonNumber").GetInt32());
        Assert.Equal(1, item.GetProperty("episodeNumber").GetInt32());

        var second = root.GetProperty("events")[1];
        Assert.Equal("userCreated", second.GetProperty("type").GetString());
        Assert.False(second.TryGetProperty("item", out _)); // nulls omitted
    }
}

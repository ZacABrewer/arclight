// SPDX-License-Identifier: GPL-3.0-or-later
using Jellyfin.Plugin.Arclight.Configuration;
using Jellyfin.Plugin.Arclight.Intro;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.Arclight.Tests;

public class IntroTests
{
    private static readonly DateTimeOffset T0 = new(2026, 11, 1, 20, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Off_by_default()
    {
        Assert.False(new IntroPolicy().ShouldPlay(new PluginConfiguration(), "movie", Guid.NewGuid(), T0));
    }

    [Fact]
    public void Movies_always_episodes_only_when_enabled()
    {
        var policy = new IntroPolicy();
        var config = new PluginConfiguration { EnableIntro = true };
        var user = Guid.NewGuid();
        Assert.True(policy.ShouldPlay(config, "movie", user, T0));
        Assert.True(policy.ShouldPlay(config, "movie", user, T0.AddMinutes(5))); // movies are not session-limited
        Assert.False(policy.ShouldPlay(config, "episode", user, T0));
        Assert.False(policy.ShouldPlay(config, "other", user, T0));
        config.IntroBeforeMovies = false;
        Assert.False(policy.ShouldPlay(config, "movie", user, T0));
    }

    [Fact]
    public void Only_the_first_episode_of_a_session()
    {
        var policy = new IntroPolicy();
        var config = new PluginConfiguration { EnableIntro = true, IntroBeforeEpisodes = true };
        var user = Guid.NewGuid();
        Assert.True(policy.ShouldPlay(config, "episode", user, T0));
        Assert.False(policy.ShouldPlay(config, "episode", user, T0.AddMinutes(45)));
        Assert.False(policy.ShouldPlay(config, "episode", user, T0.AddHours(2.9)));
        Assert.True(policy.ShouldPlay(config, "episode", user, T0.AddHours(3.1)));
        Assert.True(policy.ShouldPlay(config, "episode", Guid.NewGuid(), T0.AddMinutes(1))); // per user

        config.IntroFirstEpisodeOnly = false;
        Assert.True(policy.ShouldPlay(config, "episode", user, T0.AddHours(3.2)));
    }

    [Fact]
    public void Skipped_users_never_get_it()
    {
        var user = Guid.NewGuid();
        var config = new PluginConfiguration { EnableIntro = true, IntroSkipUsers = { user.ToString("D").ToUpperInvariant() } };
        Assert.False(new IntroPolicy().ShouldPlay(config, "movie", user, T0));
        Assert.True(new IntroPolicy().ShouldPlay(config, "movie", Guid.NewGuid(), T0));
    }

    [Fact]
    public void Bundled_videos_are_extracted_once_and_recognised()
    {
        var dir = Path.Combine(Path.GetTempPath(), "arclight-intro-" + Guid.NewGuid().ToString("N"));
        try
        {
            var assets = new IntroAssets(dir, NullLogger<IntroAssets>.Instance);
            var hd = assets.PathFor("1080p");
            Assert.NotNull(hd);
            Assert.True(new FileInfo(hd!).Length > 1_000_000);
            var sd = assets.PathFor("720P");
            Assert.EndsWith("arclight-intro-720p.mp4", sd);
            Assert.EndsWith("arclight-intro-1080p.mp4", assets.PathFor("4k")); // unknown -> 1080p
            Assert.True(assets.IsIntro(hd));
            Assert.False(assets.IsIntro("/media/movies/Fight Club.mkv"));
            Assert.False(assets.IsIntro(null));
            Assert.Equal(typeof(IntroAssets).Assembly.GetName().Version!.ToString(), File.ReadAllText(Path.Combine(dir, ".version")));
        }
        finally
        {
            if (Directory.Exists(dir))
            {
                Directory.Delete(dir, true);
            }
        }
    }
}

// SPDX-License-Identifier: GPL-3.0-or-later
using Jellyfin.Plugin.Arclight.Configuration;
using Jellyfin.Plugin.Arclight.Labels;
using Jellyfin.Plugin.Arclight.Web;
using Xunit;

namespace Jellyfin.Plugin.Arclight.Tests;

public class LabelsAndThemeTests
{
    private static StreamFacts Video(int w, int h, string range = "SDR") => new("Video", "hevc", "Main 10", null, w, h, null, null, true, range);

    private static StreamFacts Audio(string codec, int ch, string? lang, bool def = false, string? profile = null, string? title = null)
        => new("Audio", codec, profile, title, null, null, ch, lang, def, null);

    [Theory]
    [InlineData(3840, 2160, "4K")]
    [InlineData(3840, 1600, "4K")]
    [InlineData(1920, 800, "1080p")]
    [InlineData(1920, 1080, "1080p")]
    [InlineData(1280, 720, "720p")]
    [InlineData(720, 480, "SD")]
    public void Resolution_classes(int w, int h, string expected) => Assert.Equal(expected, MediaLabels.Resolution(w, h));

    [Theory]
    [InlineData("DOVIWithHDR10", "DV")]
    [InlineData("DOVI", "DV")]
    [InlineData("HDR10Plus", "HDR10+")]
    [InlineData("HDR10", "HDR")]
    [InlineData("HLG", "HLG")]
    [InlineData("SDR", null)]
    [InlineData(null, null)]
    public void Hdr_classes(string? range, string? expected) => Assert.Equal(expected, MediaLabels.Hdr(range));

    [Fact]
    public void Full_label_set_uses_the_default_audio_stream()
    {
        var labels = MediaLabels.Compute("id1", new[]
        {
            Video(3840, 2160, "DOVIWithHDR10"),
            Audio("ac3", 2, "spa"),
            Audio("truehd", 8, "eng", def: true, profile: "Dolby TrueHD + Dolby Atmos"),
            Audio("aac", 2, "eng"),
            new StreamFacts("Subtitle", "srt", null, null, null, null, null, "fre", false, null),
        }, 50_000_000_000);

        Assert.Equal("4K", labels.Resolution);
        Assert.Equal("DV", labels.Hdr);
        Assert.Equal("TrueHD Atmos", labels.Audio);
        Assert.Equal("7.1", labels.Channels);
        Assert.Equal(new[] { "spa", "eng" }, labels.AudioLanguages);
        Assert.Equal(50_000_000_000, labels.Size);
    }

    [Theory]
    [InlineData("dts", "DTS-HD MA", null, "DTS-HD MA")]
    [InlineData("dts", "DTS:X", null, "DTS:X")]
    [InlineData("dts", null, null, "DTS")]
    [InlineData("eac3", null, "English Atmos", "DD+ Atmos")]
    [InlineData("eac3", null, null, "DD+")]
    [InlineData("pcm_s24le", null, null, "PCM")]
    public void Audio_formats(string codec, string? profile, string? title, string expected)
        => Assert.Equal(expected, MediaLabels.AudioFormat(new StreamFacts("Audio", codec, profile, title, null, null, 6, null, true, null)));

    [Fact]
    public void Items_without_streams_have_empty_labels()
    {
        var labels = MediaLabels.Compute("x", Array.Empty<StreamFacts>(), 0);
        Assert.Null(labels.Resolution);
        Assert.Null(labels.Audio);
        Assert.Null(labels.Size);
        Assert.Empty(labels.AudioLanguages);
    }

    [Fact]
    public void Theme_choice_rules()
    {
        var config = new PluginConfiguration { DefaultTheme = "abyss", LetUsersChooseTheme = true };
        var u = Guid.NewGuid();
        Assert.Equal("abyss", ThemeChoices.EffectiveChoice(config, u));
        ThemeChoices.SetChoice(config, u, "follow");
        Assert.Equal("follow", ThemeChoices.EffectiveChoice(config, u));
        ThemeChoices.SetChoice(config, u, "off");
        Assert.Equal("off", ThemeChoices.EffectiveChoice(config, u));
        Assert.Single(config.UserThemes);
        config.LetUsersChooseTheme = false;
        Assert.Equal("abyss", ThemeChoices.EffectiveChoice(config, u));
        config.LetUsersChooseTheme = true;
        ThemeChoices.SetChoice(config, u, null);
        Assert.Empty(config.UserThemes);
        Assert.Equal("abyss", ThemeChoices.EffectiveChoice(config, u));
        config.DefaultTheme = string.Empty;
        Assert.Equal("off", ThemeChoices.EffectiveChoice(config, u));
    }

    [Theory]
    [InlineData("Abyss", "abyss")]
    [InlineData("", "off")]
    [InlineData("FOLLOW", "follow")]
    [InlineData("../x", null)]
    [InlineData("a b", null)]
    public void Theme_choice_normalisation(string input, string? expected) => Assert.Equal(expected, ThemeChoices.Normalize(input));
}

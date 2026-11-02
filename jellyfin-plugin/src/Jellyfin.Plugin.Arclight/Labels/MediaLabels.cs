// SPDX-License-Identifier: GPL-3.0-or-later
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.Arclight.Labels;

/// <summary>A media stream reduced to what the labels need (decoupled from Jellyfin types for tests).</summary>
/// <param name="Kind">"Video", "Audio", "Subtitle", ...</param>
/// <param name="Codec">Codec name (e.g. hevc, eac3, truehd).</param>
/// <param name="Profile">Codec profile (e.g. "DTS-HD MA", "Dolby TrueHD + Dolby Atmos").</param>
/// <param name="Title">Stream title.</param>
/// <param name="Width">Video width.</param>
/// <param name="Height">Video height.</param>
/// <param name="Channels">Audio channel count.</param>
/// <param name="Language">ISO 639-2 language.</param>
/// <param name="IsDefault">Default stream flag.</param>
/// <param name="RangeType">Jellyfin VideoRangeType name (SDR, HDR10, HDR10Plus, HLG, DOVI, DOVIWithHDR10, ...).</param>
public sealed record StreamFacts(string Kind, string? Codec, string? Profile, string? Title, int? Width, int? Height, int? Channels, string? Language, bool IsDefault, string? RangeType);

/// <summary>Compact quality labels for one item.</summary>
public sealed class MediaLabelSet
{
    /// <summary>Gets or sets the Jellyfin item id ("N" format).</summary>
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    /// <summary>Gets or sets 4K, 1080p, 720p or SD (null when there is no video).</summary>
    [JsonPropertyName("resolution")]
    public string? Resolution { get; set; }

    /// <summary>Gets or sets DV, HDR10+, HDR or HLG (null for SDR).</summary>
    [JsonPropertyName("hdr")]
    public string? Hdr { get; set; }

    /// <summary>Gets or sets the main audio format, e.g. "TrueHD Atmos", "DD+", "DTS-HD MA", "AAC".</summary>
    [JsonPropertyName("audio")]
    public string? Audio { get; set; }

    /// <summary>Gets or sets the main audio channel layout, e.g. "7.1", "5.1", "2.0".</summary>
    [JsonPropertyName("channels")]
    public string? Channels { get; set; }

    /// <summary>Gets or sets the distinct audio languages (ISO 639-2, in stream order).</summary>
    [JsonPropertyName("audioLanguages")]
    public List<string> AudioLanguages { get; set; } = new();

    /// <summary>Gets or sets the file size in bytes.</summary>
    [JsonPropertyName("size")]
    public long? Size { get; set; }
}

/// <summary>Computes labels from streams. Pure; unit tested.</summary>
public static class MediaLabels
{
    /// <summary>Computes the labels.</summary>
    /// <param name="id">Item id.</param>
    /// <param name="streams">Streams of the primary media source.</param>
    /// <param name="size">Size in bytes.</param>
    /// <returns>The labels.</returns>
    public static MediaLabelSet Compute(string id, IReadOnlyList<StreamFacts> streams, long? size)
    {
        var result = new MediaLabelSet { Id = id, Size = size is > 0 ? size : null };
        var video = streams.FirstOrDefault(s => s.Kind == "Video" && s.Width is > 0);
        if (video is not null)
        {
            result.Resolution = Resolution(video.Width ?? 0, video.Height ?? 0);
            result.Hdr = Hdr(video.RangeType);
        }

        var audios = streams.Where(s => s.Kind == "Audio").ToList();
        var main = audios.FirstOrDefault(a => a.IsDefault) ?? audios.FirstOrDefault();
        if (main is not null)
        {
            result.Audio = AudioFormat(main);
            result.Channels = ChannelLayout(main.Channels);
        }

        foreach (var a in audios)
        {
            var lang = (a.Language ?? string.Empty).Trim().ToLowerInvariant();
            if (lang.Length is >= 2 and <= 8 && lang != "und" && !result.AudioLanguages.Contains(lang))
            {
                result.AudioLanguages.Add(lang);
            }
        }

        return result;
    }

    /// <summary>Resolution class from frame size (tolerates cropped/scope encodes).</summary>
    /// <param name="width">Width.</param>
    /// <param name="height">Height.</param>
    /// <returns>Label.</returns>
    public static string Resolution(int width, int height)
    {
        if (width >= 3200 || height >= 1800)
        {
            return "4K";
        }

        if (width >= 1800 || height >= 1000)
        {
            return "1080p";
        }

        if (width >= 1200 || height >= 700)
        {
            return "720p";
        }

        return "SD";
    }

    /// <summary>HDR class from Jellyfin's VideoRangeType.</summary>
    /// <param name="rangeType">Range type name.</param>
    /// <returns>Label or null.</returns>
    public static string? Hdr(string? rangeType)
    {
        if (string.IsNullOrEmpty(rangeType))
        {
            return null;
        }

        if (rangeType.StartsWith("DOVI", StringComparison.OrdinalIgnoreCase))
        {
            return "DV";
        }

        return rangeType switch
        {
            "HDR10Plus" => "HDR10+",
            "HDR10" => "HDR",
            "HLG" => "HLG",
            _ => null,
        };
    }

    /// <summary>Main audio format label.</summary>
    /// <param name="a">Audio stream.</param>
    /// <returns>Label or null.</returns>
    public static string? AudioFormat(StreamFacts a)
    {
        var codec = (a.Codec ?? string.Empty).ToLowerInvariant();
        var hint = ((a.Profile ?? string.Empty) + " " + (a.Title ?? string.Empty)).ToLowerInvariant();
        var atmos = hint.Contains("atmos", StringComparison.Ordinal);
        string? baseName = codec switch
        {
            "truehd" => "TrueHD",
            "eac3" => "DD+",
            "ac3" => "DD",
            "dts" => hint.Contains("dts:x", StringComparison.Ordinal) || hint.Contains("dts-x", StringComparison.Ordinal) ? "DTS:X"
                : hint.Contains("ma", StringComparison.Ordinal) && hint.Contains("hd", StringComparison.Ordinal) ? "DTS-HD MA"
                : "DTS",
            "aac" => "AAC",
            "flac" => "FLAC",
            "opus" => "Opus",
            "mp3" => "MP3",
            "vorbis" => "Vorbis",
            "alac" => "ALAC",
            _ when codec.StartsWith("pcm", StringComparison.Ordinal) => "PCM",
            _ => codec.Length is > 0 and <= 12 ? codec.ToUpperInvariant() : null,
        };

        if (atmos && baseName is "TrueHD" or "DD+")
        {
            return baseName + " Atmos";
        }

        return baseName;
    }

    /// <summary>Channel count as a layout label.</summary>
    /// <param name="channels">Channel count.</param>
    /// <returns>Label or null.</returns>
    public static string? ChannelLayout(int? channels) => channels switch
    {
        null or <= 0 => null,
        1 => "1.0",
        2 => "2.0",
        3 => "2.1",
        6 => "5.1",
        7 => "6.1",
        8 => "7.1",
        _ => channels.Value + "ch",
    };
}

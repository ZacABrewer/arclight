package com.moviemethat.arclight.video;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.media.MediaCodecInfo.CodecProfileLevel;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import org.junit.Test;

public class VideoProfileTest {

    private static Set<String> set(String... s) {
        return new HashSet<>(Arrays.asList(s));
    }

    @Test
    public void hevcMain10() {
        assertTrue(VideoProfile.isHevcMain10(CodecProfileLevel.HEVCProfileMain10));
        assertTrue(VideoProfile.isHevcMain10(CodecProfileLevel.HEVCProfileMain10HDR10));
        assertFalse(VideoProfile.isHevcMain10(CodecProfileLevel.HEVCProfileMain));
    }

    @Test
    public void videoCodecs() {
        assertEquals(Arrays.asList("h264", "hevc", "av1", "vp9"),
                VideoProfile.videoCodecs(set("video/avc", "video/hevc", "video/av01", "video/x-vnd.on2.vp9", "video/mp4v-es")));
        assertEquals(Collections.singletonList("h264"), VideoProfile.videoCodecs(set()));
    }

    @Test
    public void audioCodecs() {
        assertEquals(Arrays.asList("aac", "mp3", "opus", "flac"),
                VideoProfile.audioCodecs(set("audio/mpeg", "audio/opus", "audio/flac"), false, false, false, false));
        assertEquals(Arrays.asList("aac", "ac3", "eac3", "dts", "truehd"),
                VideoProfile.audioCodecs(set(), true, true, true, true));
        assertEquals(Arrays.asList("aac", "ac3", "eac3"),
                VideoProfile.audioCodecs(set("audio/ac3", "audio/eac3-joc"), false, false, false, false));
    }

    @Test
    public void hdr() {
        assertEquals(Collections.emptyList(), VideoProfile.hdr(new int[] {1, 2, 3}, false, true));
        assertEquals(Arrays.asList("hdr10", "hlg"), VideoProfile.hdr(new int[] {1, 2, 3}, true, false));
        assertEquals(Arrays.asList("hdr10", "hlg", "dv"), VideoProfile.hdr(new int[] {3, 1, 2}, true, true));
        assertEquals(Collections.emptyList(), VideoProfile.hdr(new int[0], true, true));
    }

    @Test
    public void audioChannels() {
        assertEquals(2, VideoProfile.maxAudioChannels(false, 8, true));
        assertEquals(2, VideoProfile.maxAudioChannels(true, 2, false));
        assertEquals(6, VideoProfile.maxAudioChannels(true, 2, true));
        assertEquals(8, VideoProfile.maxAudioChannels(true, 12, false));
    }
}

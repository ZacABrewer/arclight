package com.moviemethat.arclight.video;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.json.JSONObject;
import org.junit.Test;

public class VideoHlsTest {

    private static final String HLS = "\"delivery\":\"hls\",\"sessionId\":\"s1\",\"hls\":{"
            + "\"masterUrl\":\"https://example.com/hls/s1/master.m3u8\",\"startRung\":\"1080\","
            + "\"healthUrl\":\"https://example.com/hls/s1/health\",\"rungs\":["
            + "{\"id\":\"src\",\"height\":2160,\"videoKbps\":40000,\"codec\":\"copy\",\"range\":\"hdr10\",\"level\":0},"
            + "{\"id\":\"1080\",\"height\":1080,\"videoKbps\":8000,\"codec\":\"hevc\",\"range\":\"hdr10\",\"level\":1},"
            + "{\"id\":\"720\",\"height\":720,\"videoKbps\":4000,\"codec\":\"h264\",\"range\":\"sdr\",\"level\":2},"
            + "{\"height\":1}]}";

    private static VideoRequest request(String extra) throws Exception {
        return VideoRequest.parse(new JSONObject("{\"itemKey\":\"movie:1\",\"url\":\"https://example.com/hls/s1/master.m3u8\","
                + "\"mimeType\":\"application/vnd.apple.mpegurl\",\"streamStartMs\":0,\"startPositionMs\":0,\"durationMs\":1000,"
                + "\"subtitles\":[],\"audioTracks\":[]" + extra + "}"));
    }

    @Test
    public void parsesTheHlsSession() throws Exception {
        VideoRequest r = request("," + HLS + ",\"quality\":\"720p\",\"bandwidthKbps\":12000");
        assertTrue(r.isHls());
        // HLS always seeks in the player, whatever "seekable" said.
        assertTrue(r.seekable);
        assertFalse(r.directPlay());
        assertEquals("720p", r.quality);
        assertEquals(12_000, r.bandwidthKbps);
        assertEquals("s1", r.hls.sessionId);
        assertEquals("1080", r.hls.startRung);
        assertEquals("https://example.com/hls/s1/health", r.hls.healthUrl);
        // The rung without an id is dropped.
        assertEquals(3, r.hls.rungs.size());
        assertEquals("copy", r.hls.rung("src").codec);
        assertEquals(2, r.hls.rung("720").level);
        assertNull(r.hls.rung("480"));
    }

    @Test
    public void progressiveHasNoHls() throws Exception {
        VideoRequest r = request(",\"seekable\":true");
        assertFalse(r.isHls());
        assertTrue(r.directPlay());
        assertNull(r.quality);
        assertEquals(0, r.bandwidthKbps);
        VideoRequest legacy = request(",\"seekable\":false,\"delivery\":\"progressive\"");
        assertFalse(legacy.isHls());
        assertFalse(legacy.directPlay());
    }

    @Test
    public void replaceStreamSwitchesDelivery() throws Exception {
        VideoRequest r = request(",\"seekable\":true");
        r.apply(VideoRequest.Stream.parse(new JSONObject("{\"url\":\"https://example.com/hls/s2/master.m3u8\",\"positionMs\":5000," + HLS + "}")));
        assertTrue(r.isHls());
        assertTrue(r.seekable);
        assertFalse(r.directPlay());
        r.apply(VideoRequest.Stream.parse(new JSONObject("{\"url\":\"https://example.com/file.mkv\",\"seekable\":true}")));
        assertFalse(r.isHls());
        assertTrue(r.directPlay());
    }

    @Test
    public void autoAdaptsAndPinsLock() {
        assertTrue(VideoHls.adaptive(null));
        assertTrue(VideoHls.adaptive("auto"));
        assertTrue(VideoHls.adaptive("bogus"));
        assertFalse(VideoHls.adaptive("original"));
        assertFalse(VideoHls.adaptive("1080p"));

        List<VideoHls.Variant> v = Arrays.asList(new VideoHls.Variant(2160, 40_000_000), new VideoHls.Variant(1080, 8_000_000),
                new VideoHls.Variant(1080, 6_000_000), new VideoHls.Variant(720, 4_000_000));
        assertEquals(-1, VideoHls.pinnedVariant(v, "auto"));
        assertEquals(0, VideoHls.pinnedVariant(v, "original"));
        assertEquals(1, VideoHls.pinnedVariant(v, "1080p"));
        assertEquals(3, VideoHls.pinnedVariant(v, "720p"));
        // Nothing at or under 480: the smallest there is.
        assertEquals(3, VideoHls.pinnedVariant(v, "480p"));
        assertEquals(-1, VideoHls.pinnedVariant(Collections.emptyList(), "1080p"));
    }

    @Test
    public void adviceCapsTheHeight() throws Exception {
        VideoRequest r = request("," + HLS);
        assertEquals(Integer.MAX_VALUE, VideoHls.capHeight(r.hls.rungs, null));
        assertEquals(1080, VideoHls.capHeight(r.hls.rungs, "1080"));
        assertEquals(Integer.MAX_VALUE, VideoHls.capHeight(r.hls.rungs, "360"));

        assertEquals("720", VideoHls.adviceFrom("{\"encodeSpeed\":0.8,\"aheadSec\":4,\"maxSustainableRung\":\"720\",\"hwaccel\":\"none\"}"));
        assertNull(VideoHls.adviceFrom("{\"encodeSpeed\":null,\"aheadSec\":0,\"maxSustainableRung\":null,\"hwaccel\":\"qsv\"}"));
        assertNull(VideoHls.adviceFrom("not json"));
        assertNull(VideoHls.adviceFrom(null));

        assertEquals("720", VideoHls.adviceFromHeader("speed=0.92;advice=720"));
        assertEquals("1080", VideoHls.adviceFromHeader(" advice=1080 ; speed=1.4"));
        assertNull(VideoHls.adviceFromHeader("speed=2.1"));
        assertNull(VideoHls.adviceFromHeader("advice="));
        assertNull(VideoHls.adviceFromHeader(null));
    }

    @Test
    public void retriesAndStartEstimate() throws Exception {
        assertEquals(1_000, VideoHls.retryAfterMs(null));
        assertEquals(1_000, VideoHls.retryAfterMs("0"));
        assertEquals(2_000, VideoHls.retryAfterMs(" 2 "));
        assertEquals(5_000, VideoHls.retryAfterMs("60"));
        assertEquals(1_000, VideoHls.retryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT"));
        assertTrue(VideoHls.MIN_RETRIES >= 8);

        VideoRequest r = request("," + HLS);
        assertEquals(12_000_000, VideoHls.initialEstimateBps(12_000, r.hls));
        // No hint: the start rung with headroom, so the first variant is the server's pick.
        assertEquals(12_000_000, VideoHls.initialEstimateBps(0, r.hls));
        assertEquals(0, VideoHls.initialEstimateBps(0, null));
        assertEquals(5_000_000, VideoHls.initialEstimateBps(5_000, null));
    }

    @Test
    public void deviceTakesHls() {
        assertEquals(Arrays.asList("hls", "progressive"), VideoProfile.deliveries());
    }

    @Test
    public void m3u8MimeIsRecognised() {
        assertNotNull(VideoActivity.containerMime("application/vnd.apple.mpegurl"));
        assertEquals(VideoActivity.containerMime("application/x-mpegURL"), VideoActivity.containerMime("application/vnd.apple.mpegurl"));
    }
}

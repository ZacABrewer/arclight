package com.moviemethat.arclight.video;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

public class VideoRequestTest {

    private static JSONObject full() throws Exception {
        return new JSONObject("{"
                + "\"itemKey\":\"episode:42\",\"url\":\"https://example.com/v/42/stream.mp4\","
                + "\"headers\":{\"Authorization\":\"Bearer x\"},\"mimeType\":\"video/mp4\","
                + "\"streamStartMs\":0,\"startPositionMs\":120000,\"seekable\":true,\"durationMs\":2520000,"
                + "\"title\":\"Pilot\",\"subtitle\":\"Series S01 E01\",\"streamInfo\":\"DIRECT PLAY 1080p\","
                + "\"subtitles\":[{\"id\":\"s1\",\"url\":\"https://example.com/s1.vtt\",\"label\":\"English\",\"language\":\"en\",\"default\":true},"
                + "{\"id\":\"s2\",\"url\":\"https://example.com/s2.vtt\",\"label\":\"Deutsch\",\"language\":null,\"forced\":true},"
                + "{\"url\":\"https://example.com/broken.vtt\"}],"
                + "\"selectedSubtitle\":\"s2\",\"audioTracks\":[{\"index\":0,\"label\":\"English 5.1\"},{\"index\":1}],\"selectedAudio\":1,"
                + "\"segments\":[{\"type\":\"intro\",\"startMs\":1000,\"endMs\":60000},{\"type\":\"bogus\",\"startMs\":1,\"endMs\":2},"
                + "{\"type\":\"recap\",\"startMs\":5,\"endMs\":5}],"
                + "\"next\":{\"itemKey\":\"episode:43\",\"title\":\"Second\"}}");
    }

    @Test
    public void parsesEverything() throws Exception {
        VideoRequest r = VideoRequest.parse(full());
        assertEquals("episode:42", r.itemKey);
        assertEquals("Bearer x", r.headers.get("Authorization"));
        assertEquals(120_000, r.startPositionMs);
        assertEquals(2_520_000, r.durationMs);
        assertTrue(r.seekable);
        assertEquals(2, r.subtitles.size());
        assertNull(r.subtitles.get(1).language);
        assertTrue(r.subtitles.get(0).isDefault);
        assertTrue(r.subtitles.get(1).forced);
        assertEquals("s2", r.selectedSubtitle);
        assertEquals("#2", r.audioTracks.get(1).label);
        assertEquals(Integer.valueOf(1), r.selectedAudio);
        assertEquals(1, r.segments.size());
        assertEquals("episode:43", r.next.itemKey);
        assertNull(r.next.subtitle);
    }

    @Test(expected = IllegalArgumentException.class)
    public void urlRequired() throws Exception {
        VideoRequest.parse(new JSONObject("{\"itemKey\":\"movie:1\"}"));
    }

    @Test(expected = IllegalArgumentException.class)
    public void itemKeyRequired() throws Exception {
        VideoRequest.parse(new JSONObject("{\"url\":\"https://example.com/a.mkv\"}"));
    }

    @Test
    public void replaceStreamAndTimeMapping() throws Exception {
        VideoRequest r = VideoRequest.parse(full());
        VideoRequest.Stream s = VideoRequest.Stream.parse(new JSONObject(
                "{\"url\":\"https://example.com/v/42/remux.mp4\",\"mimeType\":\"\",\"streamStartMs\":600000,"
                        + "\"seekable\":false,\"positionMs\":600000,\"subtitles\":[{\"id\":\"s1\",\"url\":\"https://example.com/s1.vtt\"}],"
                        + "\"selectedAudio\":null}"));
        assertNull(s.selectedAudio);
        r.apply(s);
        assertEquals("https://example.com/v/42/remux.mp4", r.url);
        assertEquals("video/mp4", r.mimeType);
        assertFalse(r.seekable);
        assertEquals(Integer.valueOf(1), r.selectedAudio);
        // s2 is no longer offered: the selection is dropped.
        assertNull(r.selectedSubtitle);
        assertEquals("s1", r.subtitles.get(0).label);
        assertEquals(0, r.toPlayerMs(500_000));
        assertEquals(15_000, r.toPlayerMs(615_000));
        assertEquals(615_000, r.toMediaMs(15_000));
        assertEquals(600_000, r.toMediaMs(-3));
    }

    @Test
    public void containerMime() {
        assertEquals("video/x-matroska", VideoActivity.containerMime("video/x-matroska"));
        assertEquals("video/x-matroska", VideoActivity.containerMime("video/mkv"));
        assertEquals("video/webm", VideoActivity.containerMime("video/webm"));
        assertEquals("video/mp4", VideoActivity.containerMime("video/mp4; codecs=\"avc1\""));
        assertEquals("video/mp4", VideoActivity.containerMime("video/quicktime"));
        assertNull(VideoActivity.containerMime(""));
        assertNull(VideoActivity.containerMime("application/octet-stream"));
    }
}

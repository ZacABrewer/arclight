package com.moviemethat.arclight.player;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.Arrays;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class QueueModelTest {

    static JSONObject track(String id, String url) throws Exception {
        return new JSONObject().put("id", id).put("url", url).put("title", "T " + id);
    }

    static TrackInfo t(String id) throws Exception {
        return TrackInfo.fromJson(track(id, "https://server.example/stream/" + id));
    }

    @Test
    public void parsesTrackWithHeadersAndKind() throws Exception {
        JSONObject o = track("a", "https://server.example/a")
                .put("kind", "audiobook")
                .put("durationMs", 1234)
                .put("headers", new JSONObject().put("Authorization", "Bearer x"));
        TrackInfo t = TrackInfo.fromJson(o);
        assertEquals("a", t.id);
        assertTrue(t.isAudiobook());
        assertTrue(t.isRemote());
        assertEquals(1234, t.durationMs);
        assertEquals("Bearer x", t.headers.get("Authorization"));
        assertNull(t.artist);
    }

    @Test
    public void rejectsTrackWithoutIdOrUrl() throws Exception {
        try {
            TrackInfo.fromJson(new JSONObject().put("url", "https://x.example/"));
            fail();
        } catch (IllegalArgumentException expected) {
            // ok
        }
        try {
            TrackInfo.fromJson(new JSONObject().put("id", "a"));
            fail();
        } catch (IllegalArgumentException expected) {
            // ok
        }
    }

    @Test
    public void trackRoundTripsThroughJson() throws Exception {
        TrackInfo a = TrackInfo.fromJson(track("a", "/data/x.mp3").put("artist", "Ar").put("album", "Al"));
        TrackInfo b = TrackInfo.fromJson(a.toJson());
        assertEquals(a.id, b.id);
        assertEquals(a.url, b.url);
        assertEquals("Ar", b.artist);
        assertEquals("Al", b.album);
        assertFalse(b.isRemote());
    }

    @Test
    public void parseTracksMapsArray() throws Exception {
        JSONArray a = new JSONArray().put(track("a", "https://x.example/a")).put(track("b", "https://x.example/b"));
        List<TrackInfo> l = QueueModel.parseTracks(a);
        assertEquals(2, l.size());
        assertEquals("b", l.get(1).id);
    }

    @Test
    public void replaceUpcomingKeepsCurrentAndBefore() throws Exception {
        QueueModel q = new QueueModel();
        q.replace(Arrays.asList(t("a"), t("b"), t("c"), t("d")));
        int from = q.replaceUpcoming(1, Arrays.asList(t("x"), t("y")));
        assertEquals(2, from);
        assertEquals(4, q.size());
        assertEquals("b", q.get(1).id);
        assertEquals("x", q.get(2).id);
        assertEquals(3, q.indexOfId("y"));
    }

    @Test
    public void replaceUpcomingWithNothingCurrent() throws Exception {
        QueueModel q = new QueueModel();
        q.replace(Arrays.asList(t("a")));
        assertEquals(0, q.replaceUpcoming(-1, Arrays.asList(t("x"))));
        assertEquals(1, q.size());
        assertEquals("x", q.get(0).id);
    }

    @Test
    public void clampStart() {
        assertEquals(0, QueueModel.clampStart(5, 0));
        assertEquals(0, QueueModel.clampStart(-3, 4));
        assertEquals(3, QueueModel.clampStart(9, 4));
        assertEquals(2, QueueModel.clampStart(2, 4));
    }

    @Test
    public void fallbackNext() {
        assertEquals(1, QueueModel.fallbackNextIndex(0, 3, "off"));
        assertEquals(-1, QueueModel.fallbackNextIndex(2, 3, "off"));
        assertEquals(0, QueueModel.fallbackNextIndex(2, 3, "all"));
        assertEquals(-1, QueueModel.fallbackNextIndex(0, 0, "all"));
    }

    @Test
    public void fallbackPrevious() {
        assertEquals(2, QueueModel.fallbackPreviousIndex(2, 3, 5000, "off"));
        assertEquals(1, QueueModel.fallbackPreviousIndex(2, 3, 1000, "off"));
        assertEquals(0, QueueModel.fallbackPreviousIndex(0, 3, 1000, "off"));
        assertEquals(2, QueueModel.fallbackPreviousIndex(0, 3, 1000, "all"));
    }

    @Test
    public void playableUri() {
        assertEquals("https://x.example/a?b=1", QueueModel.playableUri("https://x.example/a?b=1"));
        assertEquals("file:///data/user/0/app/files/My%20Song%20%231.mp3",
                QueueModel.playableUri("/data/user/0/app/files/My Song #1.mp3"));
        assertEquals("file:///x/a.mp3", QueueModel.playableUri("file:///x/a.mp3"));
        assertNull(QueueModel.playableUri("relative/a.mp3"));
        assertNull(QueueModel.playableUri("  "));
    }
}

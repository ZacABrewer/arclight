package com.moviemethat.arclight.cast;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.moviemethat.arclight.player.TrackInfo;
import java.util.Arrays;
import java.util.List;
import org.json.JSONObject;
import org.junit.Test;

public class CastQueueMapperTest {

    static TrackInfo remote(String id) throws Exception {
        return TrackInfo.fromJson(new JSONObject().put("id", id).put("url", "https://server.example/" + id));
    }

    static TrackInfo local(String id) throws Exception {
        return TrackInfo.fromJson(new JSONObject().put("id", id).put("url", "/data/files/" + id + ".mp3"));
    }

    @Test
    public void keepsRemoteTracksAndExactStart() throws Exception {
        List<TrackInfo> q = Arrays.asList(remote("a"), local("b"), remote("c"), remote("d"));
        CastQueueMapper.Plan p = CastQueueMapper.plan(q, 2);
        assertEquals(3, p.tracks.size());
        assertEquals(1, p.startIndex);
        assertTrue(p.startIsExact);
        assertEquals("c", p.tracks.get(p.startIndex).id);
    }

    @Test
    public void localStartMovesToNextCastable() throws Exception {
        List<TrackInfo> q = Arrays.asList(remote("a"), local("b"), remote("c"));
        CastQueueMapper.Plan p = CastQueueMapper.plan(q, 1);
        assertEquals("c", p.tracks.get(p.startIndex).id);
        assertFalse(p.startIsExact);
    }

    @Test
    public void localTailFallsBackToPreviousCastable() throws Exception {
        List<TrackInfo> q = Arrays.asList(remote("a"), remote("b"), local("c"));
        CastQueueMapper.Plan p = CastQueueMapper.plan(q, 2);
        assertEquals("b", p.tracks.get(p.startIndex).id);
        assertFalse(p.startIsExact);
    }

    @Test
    public void nothingCastable() throws Exception {
        CastQueueMapper.Plan p = CastQueueMapper.plan(Arrays.asList(local("a")), 0);
        assertEquals(0, p.tracks.size());
        assertEquals(-1, p.startIndex);
    }

    @Test
    public void statusNames() {
        assertEquals("error", CastQueueMapper.statusName(true, false, false, false, false, true));
        assertEquals("playing", CastQueueMapper.statusName(true, false, false, false, false, false));
        assertEquals("paused", CastQueueMapper.statusName(false, true, false, false, false, false));
        assertEquals("ended", CastQueueMapper.statusName(false, false, false, false, true, false));
        assertEquals("idle", CastQueueMapper.statusName(false, false, false, false, false, false));
    }
}

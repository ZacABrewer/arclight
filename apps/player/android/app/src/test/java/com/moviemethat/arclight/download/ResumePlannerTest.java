package com.moviemethat.arclight.download;

import static com.moviemethat.arclight.download.ResumePlanner.Action.APPEND;
import static com.moviemethat.arclight.download.ResumePlanner.Action.COMPLETE;
import static com.moviemethat.arclight.download.ResumePlanner.Action.DISCARD_AND_RETRY;
import static com.moviemethat.arclight.download.ResumePlanner.Action.FAIL_PERMANENT;
import static com.moviemethat.arclight.download.ResumePlanner.Action.FAIL_RETRY;
import static com.moviemethat.arclight.download.ResumePlanner.Action.RESTART;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ResumePlannerTest {

    @Test
    public void rangeHeader() {
        assertNull(ResumePlanner.rangeHeader(0));
        assertEquals("bytes=1000-", ResumePlanner.rangeHeader(1000));
    }

    @Test
    public void partialContentAppendsWhenStartMatches() {
        ResumePlanner.Decision d = ResumePlanner.decide(1000, 206, "bytes 1000-4999/5000", 4000);
        assertEquals(APPEND, d.action);
        assertEquals(5000, d.totalBytes);
        ResumePlanner.Decision unknownTotal = ResumePlanner.decide(1000, 206, "bytes 1000-4999/*", 4000);
        assertEquals(APPEND, unknownTotal.action);
        assertEquals(-1, unknownTotal.totalBytes);
    }

    @Test
    public void partialContentWithWrongStartOrHeaderIsDiscarded() {
        assertEquals(DISCARD_AND_RETRY, ResumePlanner.decide(1000, 206, "bytes 0-4999/5000", 5000).action);
        assertEquals(DISCARD_AND_RETRY, ResumePlanner.decide(1000, 206, null, 5000).action);
        assertEquals(DISCARD_AND_RETRY, ResumePlanner.decide(1000, 206, "garbage", 5000).action);
    }

    @Test
    public void fullResponseRestarts() {
        ResumePlanner.Decision d = ResumePlanner.decide(1000, 200, null, 5000);
        assertEquals(RESTART, d.action);
        assertEquals(5000, d.totalBytes);
        assertEquals(-1, ResumePlanner.decide(0, 200, null, -1).totalBytes);
    }

    @Test
    public void rangeNotSatisfiable() {
        assertEquals(COMPLETE, ResumePlanner.decide(5000, 416, "bytes */5000", -1).action);
        assertEquals(DISCARD_AND_RETRY, ResumePlanner.decide(4000, 416, "bytes */5000", -1).action);
        assertEquals(DISCARD_AND_RETRY, ResumePlanner.decide(4000, 416, null, -1).action);
    }

    @Test
    public void errors() {
        assertEquals(FAIL_RETRY, ResumePlanner.decide(0, 503, null, -1).action);
        assertEquals(FAIL_RETRY, ResumePlanner.decide(0, 429, null, -1).action);
        assertEquals(FAIL_RETRY, ResumePlanner.decide(0, 408, null, -1).action);
        assertEquals(FAIL_PERMANENT, ResumePlanner.decide(0, 404, null, -1).action);
        assertEquals(FAIL_PERMANENT, ResumePlanner.decide(0, 401, null, -1).action);
    }

    @Test
    public void lengthMatches() {
        assertTrue(ResumePlanner.lengthMatches(10, -1));
        assertTrue(ResumePlanner.lengthMatches(10, 10));
        assertFalse(ResumePlanner.lengthMatches(9, 10));
    }
}

package com.moviemethat.arclight.video;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class StallTrackerTest {

    @Test
    public void startupIsOpenToFirstFrameOnce() {
        StallTracker s = new StallTracker();
        assertEquals(-1, s.startupMs());
        s.open(1_000);
        // Buffering before the first frame is startup, not a stall.
        s.buffering(1_100, true);
        s.resumed(2_000);
        s.firstFrame(2_400);
        assertEquals(1_400, s.startupMs());
        s.firstFrame(9_000);
        assertEquals(1_400, s.startupMs());
        assertEquals(0, s.stalls());
    }

    @Test
    public void countsRebuffersButNotSeeksPausesOrBlips() {
        StallTracker s = started();
        s.buffering(10_000, true);
        s.resumed(11_200);
        assertEquals(1, s.stalls());
        assertEquals(1_200, s.stallMs());
        // Shorter than 500 ms: not counted.
        s.buffering(20_000, true);
        s.resumed(20_300);
        assertEquals(1, s.stalls());
        // A seek's buffering.
        s.seek();
        s.buffering(30_000, true);
        s.resumed(35_000);
        assertEquals(1, s.stalls());
        // Paused (the user does not want playback): not a stall.
        s.buffering(40_000, false);
        s.resumed(45_000);
        assertEquals(1, s.stalls());
        // A seek inside the buffer (no buffering at all) leaves no mark behind.
        s.seek();
        s.resumed(50_000);
        s.buffering(60_000, true);
        assertTrue(s.stalling());
        s.resumed(61_000);
        assertEquals(2, s.stalls());
        assertEquals(2_200, s.stallMs());
    }

    @Test
    public void reopenResets() {
        StallTracker s = started();
        s.buffering(10_000, true);
        s.resumed(12_000);
        s.open(100_000);
        assertEquals(0, s.stalls());
        assertEquals(0, s.stallMs());
        assertEquals(-1, s.startupMs());
    }

    @Test
    public void fallbackOnTwoStallsWithinAMinute() {
        StallTracker s = started();
        s.buffering(10_000, true);
        s.resumed(11_000);
        assertFalse(s.fallbackDue(11_000));
        s.buffering(70_000, true);
        s.resumed(71_000);
        assertTrue(s.fallbackDue(71_000));
        // Once per item.
        assertFalse(s.fallbackDue(72_000));
    }

    @Test
    public void noFallbackForStallsFarApart() {
        StallTracker s = started();
        s.buffering(10_000, true);
        s.resumed(11_000);
        s.buffering(80_000, true);
        s.resumed(81_000);
        assertFalse(s.fallbackDue(81_000));
    }

    @Test
    public void fallbackOnOneLongStallEvenWhileRunning() {
        StallTracker s = started();
        s.buffering(10_000, true);
        assertFalse(s.fallbackDue(12_000));
        assertTrue(s.fallbackDue(13_500));

        StallTracker t = started();
        t.buffering(10_000, true);
        t.resumed(14_000);
        assertTrue(t.fallbackDue(14_000));
    }

    private static StallTracker started() {
        StallTracker s = new StallTracker();
        s.open(0);
        s.firstFrame(1_000);
        return s;
    }
}

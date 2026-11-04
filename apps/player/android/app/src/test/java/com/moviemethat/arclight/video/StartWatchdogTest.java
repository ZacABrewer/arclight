package com.moviemethat.arclight.video;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.moviemethat.arclight.video.StartWatchdog.Action;

import org.junit.Test;

public class StartWatchdogTest {

    /** Ticks every 250 ms from {@code from} to {@code to}; the last verdict that was not NONE. */
    private static Action run(StartWatchdog w, long from, long to, boolean wantsPlay, boolean buffering, boolean awaitingJs) {
        Action last = Action.NONE;
        for (long t = from; t <= to; t += 250) {
            Action a = w.check(t, wantsPlay, buffering, awaitingJs, true, true);
            if (a != Action.NONE) return a;
        }
        return last;
    }

    @Test
    public void directPlayWithoutPictureFallsBackOnceThenFails() {
        StartWatchdog w = new StartWatchdog();
        w.open();
        w.stream(true);
        assertEquals(Action.NONE, run(w, 0, StartWatchdog.DIRECT_START_MS, true, true, false));
        assertEquals(Action.FALLBACK, run(w, StartWatchdog.DIRECT_START_MS, StartWatchdog.DIRECT_START_MS + 1_000, true, true, false));
        // The verdict alone does not use it up: the player takes it when it sends the request.
        assertFalse(w.fallbackUsed());
        assertTrue(w.takeFallback(true));
        assertTrue(w.fallbackUsed());
        // The converted stream shows nothing either: fail, never a second fallback.
        w.stream(false);
        long t = 100_000;
        assertEquals(Action.NONE, run(w, t, t + StartWatchdog.CONVERTED_START_MS, true, true, false));
        assertEquals(Action.FAIL, run(w, t + StartWatchdog.CONVERTED_START_MS, t + StartWatchdog.CONVERTED_START_MS + 1_000, true, true, false));
    }

    @Test
    public void aConvertedStreamGetsLongerToStart() {
        StartWatchdog w = new StartWatchdog();
        w.open();
        w.stream(false);
        assertEquals(Action.NONE, run(w, 0, 40_000, true, true, false));
        w.firstFrame();
        assertTrue(w.started());
        assertEquals(Action.NONE, run(w, 40_000, 200_000, true, false, false));
    }

    @Test
    public void pausedTimeAndWaitingOnJsDoNotCountAsStartup() {
        StartWatchdog w = new StartWatchdog();
        w.open();
        w.stream(true);
        // Paused before the picture came (or the screen left the front).
        assertEquals(Action.NONE, run(w, 0, 300_000, false, true, false));
        assertEquals(Action.NONE, run(w, 300_000, 310_000, true, true, false));
        // A seek asked of JS: its wait restarts the startup clock.
        assertEquals(Action.NONE, run(w, 310_000, 330_000, true, true, true));
        assertEquals(Action.NONE, run(w, 330_000, 350_000, true, true, false));
    }

    @Test
    public void stuckBufferingAfterTheStart() {
        StartWatchdog w = new StartWatchdog();
        w.open();
        w.stream(false);
        w.check(0, true, true, false, true, true);
        w.firstFrame();
        // Rebuffers that end are fine, however many.
        for (int i = 0; i < 10; i++) {
            long t = i * 100_000L;
            assertEquals(Action.NONE, run(w, t, t + 50_000, true, true, false));
            assertEquals(Action.NONE, run(w, t + 50_000, t + 100_000 - 250, true, false, false));
        }
        // Paused while buffering: not stuck.
        assertEquals(Action.NONE, run(w, 1_000_000, 1_200_000, false, true, false));
        assertEquals(Action.FALLBACK, run(w, 1_200_000, 1_300_000, true, true, false));
        assertTrue(w.takeFallback(true));
        w.stream(false);
        w.firstFrame();
        assertEquals(Action.FAIL, run(w, 2_000_000, 2_100_000, true, true, false));
    }

    @Test
    public void anUnansweredRequestFailsWithoutAFallback() {
        StartWatchdog w = new StartWatchdog();
        w.open();
        w.stream(true);
        assertEquals(Action.NONE, run(w, 0, StartWatchdog.ANSWER_MS, true, true, true));
        assertEquals(Action.FAIL, run(w, StartWatchdog.ANSWER_MS, StartWatchdog.ANSWER_MS + 1_000, true, true, true));
        assertFalse(w.fallbackUsed());
    }

    @Test
    public void theAnswerWaitPausesWhileTheScreenIsAway() {
        StartWatchdog w = new StartWatchdog();
        w.open();
        w.stream(true);
        for (long t = 0; t <= 600_000; t += 250) assertEquals(Action.NONE, w.check(t, false, true, true, false, true));
    }

    @Test
    public void withoutJsListeningItFailsInsteadOfFallingBack() {
        StartWatchdog w = new StartWatchdog();
        w.open();
        w.stream(true);
        Action a = Action.NONE;
        for (long t = 0; t <= 30_000 && a == Action.NONE; t += 250) a = w.check(t, true, true, false, true, false);
        assertEquals(Action.FAIL, a);
        assertFalse(w.takeFallback(false));
    }

    @Test
    public void aNewItemGetsItsOwnFallback() {
        StartWatchdog w = new StartWatchdog();
        w.open();
        assertTrue(w.takeFallback(true));
        assertFalse(w.takeFallback(true));
        w.open();
        assertTrue(w.takeFallback(true));
    }

    @Test
    public void retryableErrors() {
        assertTrue(StartWatchdog.retryable("unsupported", 0, false));
        assertTrue(StartWatchdog.retryable("unknown", 0, false));
        assertTrue(StartWatchdog.retryable("network", 500, true));
        assertFalse(StartWatchdog.retryable("network", 500, false));
        assertFalse(StartWatchdog.retryable("busy", 503, true));
        assertFalse(StartWatchdog.retryable("auth", 403, true));
        assertFalse(StartWatchdog.retryable("network", 0, true));
    }
}

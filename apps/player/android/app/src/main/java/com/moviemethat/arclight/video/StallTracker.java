package com.moviemethat.arclight.video;

/**
 * Playback health of one item, from the player's state changes (playback design §4.8, §8.3):
 *
 * <ul>
 *   <li><b>startup</b>: from the open to the first rendered frame (once per item).</li>
 *   <li><b>stalls</b>: rebuffers after startup while the user wants playback, not caused by a
 *       seek or a stream change. Shorter than {@link #MIN_STALL_MS} is not counted.</li>
 *   <li><b>direct-play guard</b>: in direct play, two stalls within 60 s or one longer than 3 s
 *       mean the link cannot carry the file; {@link #fallbackDue} then says so once per item and
 *       the player asks for a converted (HLS) stream at the current position.</li>
 * </ul>
 *
 * Times are {@code SystemClock.elapsedRealtime()} values passed in; no Android types (JVM tests).
 */
public final class StallTracker {

    /** Rebuffers shorter than this are not counted (§8.3). */
    static final long MIN_STALL_MS = 500;
    static final long FALLBACK_WINDOW_MS = 60_000;
    static final long FALLBACK_LONG_STALL_MS = 3_000;

    private long openedAt = -1;
    private long startupMs = -1;
    private boolean started;
    /** The next buffering comes from a seek / new stream (not a stall). */
    private boolean seeking;
    private long stallStart = -1;
    private int stalls;
    private long stallMs;
    /** End time of the previous counted stall, for the two-in-60-s rule. */
    private long lastStallEnd = -1;
    private boolean twoClose;
    private boolean fallbackFired;

    /** A new item is opening. */
    public void open(long now) {
        openedAt = now;
        startupMs = -1;
        started = false;
        seeking = false;
        stallStart = -1;
        stalls = 0;
        stallMs = 0;
        lastStallEnd = -1;
        twoClose = false;
        fallbackFired = false;
    }

    /** The first frame of the item (or of a new stream) is on screen. */
    public void firstFrame(long now) {
        if (openedAt >= 0 && startupMs < 0) startupMs = Math.max(0, now - openedAt);
        started = true;
        seeking = false;
    }

    /** A seek or a stream change: the buffering that follows is not a stall. */
    public void seek() {
        seeking = true;
        stallStart = -1;
    }

    /** The player went to BUFFERING (playWhenReady: the user wants it playing). */
    public void buffering(long now, boolean playWhenReady) {
        if (!started || seeking || !playWhenReady || stallStart >= 0) return;
        stallStart = now;
    }

    /** The player is READY again, or paused / ended / stopped: a running stall ends. */
    public void resumed(long now) {
        seeking = false;
        if (stallStart < 0) return;
        long d = Math.max(0, now - stallStart);
        stallStart = -1;
        if (d < MIN_STALL_MS) return;
        stalls++;
        stallMs += d;
        if (lastStallEnd >= 0 && now - d - lastStallEnd <= FALLBACK_WINDOW_MS) twoClose = true;
        if (d > FALLBACK_LONG_STALL_MS) twoClose = true;
        lastStallEnd = now;
    }

    /** Stalls counted so far (a running one is not counted yet). */
    public int stalls() {
        return stalls;
    }

    public long stallMs() {
        return stallMs;
    }

    /** Open to first frame; -1 before the first frame. */
    public long startupMs() {
        return startupMs;
    }

    public boolean stalling() {
        return stallStart >= 0;
    }

    /**
     * True once per item when direct play should give way to a converted stream: two stalls
     * within 60 s, or one (finished or still running) longer than 3 s.
     */
    public boolean fallbackDue(long now) {
        if (fallbackFired) return false;
        boolean longRunning = stallStart >= 0 && now - stallStart > FALLBACK_LONG_STALL_MS;
        if (!twoClose && !longRunning) return false;
        fallbackFired = true;
        return true;
    }
}

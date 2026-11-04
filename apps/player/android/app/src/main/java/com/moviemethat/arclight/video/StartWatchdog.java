package com.moviemethat.arclight.video;

/**
 * Keeps a stream from spinning forever (playback design §4.8 fallback rules, extended):
 *
 * <ul>
 *   <li><b>start</b>: a stream that shows no picture within {@link #DIRECT_START_MS} (direct
 *       play) or {@link #CONVERTED_START_MS} (a conversion, whose first segment can take a while)
 *       of wanted playback.</li>
 *   <li><b>stuck</b>: after the start, {@link #STUCK_MS} of one unbroken rebuffer.</li>
 *   <li><b>answer</b>: JS was asked for a stream (seek, audio change, fallback, next item) and has
 *       not answered within {@link #ANSWER_MS} while the screen is in front.</li>
 * </ul>
 *
 * The first two fall back once per item to a safe converted stream ({@link Action#FALLBACK}),
 * then fail; a missing answer fails at once. The clocks only run while the viewer wants
 * playback (not paused, screen in front) and nothing waits on JS. {@link #retryable} says which
 * player errors take the same single fallback instead of closing.
 *
 * Times are {@code SystemClock.elapsedRealtime()} values passed in; no Android types (JVM tests).
 */
public final class StartWatchdog {

    static final long DIRECT_START_MS = 25_000;
    /** Longer than the stream's read timeout (45 s), which covers a slow first segment. */
    static final long CONVERTED_START_MS = 60_000;
    static final long STUCK_MS = 60_000;
    static final long ANSWER_MS = 45_000;

    public enum Action { NONE, FALLBACK, FAIL }

    private boolean direct;
    private boolean started;
    private boolean fallbackUsed;
    private long lastCheck = -1;
    private long startWaitMs;
    private long stuckMs;
    private long answerWaitMs;

    /** A new item is opening: its one fallback is available again. */
    public void open() {
        fallbackUsed = false;
    }

    /** A stream (the first, or a replacement) starts loading. */
    public void stream(boolean directPlay) {
        direct = directPlay;
        started = false;
        startWaitMs = 0;
        stuckMs = 0;
        answerWaitMs = 0;
        lastCheck = -1;
    }

    /** The stream's first frame is on screen. */
    public void firstFrame() {
        started = true;
        startWaitMs = 0;
    }

    /**
     * One look at the player (every tick).
     *
     * @param wantsPlay   play is wanted (playWhenReady) and the screen is in front
     * @param buffering   the player is BUFFERING
     * @param awaitingJs  a stream or the next item was asked of JS
     * @param foreground  the screen is in front (JS answers may be held back while it is not)
     * @param canFallback JS listens for stream requests
     */
    public Action check(long now, boolean wantsPlay, boolean buffering, boolean awaitingJs, boolean foreground, boolean canFallback) {
        long dt = lastCheck < 0 ? 0 : Math.max(0, now - lastCheck);
        lastCheck = now;
        if (awaitingJs) {
            startWaitMs = 0;
            stuckMs = 0;
            if (foreground) answerWaitMs += dt;
            return answerWaitMs > ANSWER_MS ? Action.FAIL : Action.NONE;
        }
        answerWaitMs = 0;
        if (!started) {
            if (wantsPlay) startWaitMs += dt;
            if (startWaitMs > (direct ? DIRECT_START_MS : CONVERTED_START_MS)) return giveUp(canFallback);
            return Action.NONE;
        }
        if (wantsPlay && buffering) stuckMs += dt;
        else stuckMs = 0;
        return stuckMs > STUCK_MS ? giveUp(canFallback) : Action.NONE;
    }

    /** Takes the item's one fallback; false when it was used (or JS cannot answer). */
    public boolean takeFallback(boolean canFallback) {
        if (fallbackUsed || !canFallback) return false;
        fallbackUsed = true;
        startWaitMs = 0;
        stuckMs = 0;
        return true;
    }

    /** The current stream showed its first frame. */
    public boolean started() {
        return started;
    }

    public boolean fallbackUsed() {
        return fallbackUsed;
    }

    /** FALLBACK leaves the fallback to the caller's {@link #takeFallback} (which sends the request). */
    private Action giveUp(boolean canFallback) {
        return !fallbackUsed && canFallback ? Action.FALLBACK : Action.FAIL;
    }

    /**
     * Whether a player error (its PlaybackMapping code and HTTP status, 0 = none) may be fixed by a
     * safe converted stream: the device could not decode or parse it, or an HLS conversion broke
     * on the server (5xx other than busy). Sign-in, busy and network failures close as before.
     */
    public static boolean retryable(String code, int httpStatus, boolean hls) {
        if ("unsupported".equals(code) || "unknown".equals(code)) return true;
        return hls && httpStatus >= 500 && httpStatus != 503;
    }
}

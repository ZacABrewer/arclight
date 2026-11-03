package com.moviemethat.arclight.video;

import androidx.annotation.Nullable;
import java.util.List;

/**
 * Pure timing rules of the video player (media time throughout): which skip button shows,
 * when the up-next card appears, what counts as "completed", how far a held D-pad key seeks,
 * and the clock labels. No Android types, so it is JVM unit-testable.
 */
public final class VideoTimeline {

    private VideoTimeline() {}

    /** Up-next card length (the countdown). */
    public static final long UP_NEXT_COUNTDOWN_MS = 10_000;
    /** Without a credits segment the card shows this long before the end. */
    static final long UP_NEXT_LEAD_MS = 20_000;
    /** A skip button hides this close to the segment's end (seeking there would be pointless). */
    static final long SKIP_TAIL_MS = 1_500;

    /**
     * The segment whose skip button shows at {@code positionMs}: intro / recap always; credits
     * only when there is no next item (with one, the up-next card covers the credits).
     */
    @Nullable
    public static VideoRequest.Segment activeSkip(List<VideoRequest.Segment> segments, long positionMs, boolean hasNext) {
        for (VideoRequest.Segment s : segments) {
            if (positionMs < s.startMs || positionMs >= s.endMs - SKIP_TAIL_MS) continue;
            if (s.type.equals("credits") && hasNext) continue;
            return s;
        }
        return null;
    }

    /** The credits segment starting in the second half, if any. */
    @Nullable
    static VideoRequest.Segment credits(List<VideoRequest.Segment> segments, long durationMs) {
        for (VideoRequest.Segment s : segments) {
            if (s.type.equals("credits") && (durationMs <= 0 || s.startMs >= durationMs / 2)) return s;
        }
        return null;
    }

    /**
     * Media time at which the up-next card appears: the credits start, else 20 s before the end.
     * -1 when unknown (no duration and no credits) or the item is shorter than a minute.
     */
    public static long upNextAtMs(long durationMs, List<VideoRequest.Segment> segments) {
        VideoRequest.Segment c = credits(segments, durationMs);
        if (c != null) return c.startMs;
        if (durationMs < 60_000) return -1;
        return durationMs - UP_NEXT_LEAD_MS;
    }

    /** Watched to the end: inside the credits, or within the last 5 %. */
    public static boolean completed(long positionMs, long durationMs, List<VideoRequest.Segment> segments) {
        VideoRequest.Segment c = credits(segments, durationMs);
        if (c != null && positionMs >= c.startMs) return true;
        return durationMs > 0 && positionMs >= durationMs * 95 / 100;
    }

    /**
     * Seek step for a held D-pad left/right: 10 s for the first presses, then 30 s, then 60 s so a
     * long film can be crossed in a few seconds.
     */
    public static long seekStepMs(int repeatCount) {
        if (repeatCount < 6) return 10_000;
        if (repeatCount < 16) return 30_000;
        return 60_000;
    }

    /** Clamps a seek target to [0, duration - 1 s] (or just >= 0 when the duration is unknown). */
    public static long clampSeek(long targetMs, long durationMs) {
        long t = Math.max(0, targetMs);
        if (durationMs > 0) t = Math.min(t, Math.max(0, durationMs - 1000));
        return t;
    }

    /** "1:02:03" / "2:03". */
    public static String clock(long ms) {
        long total = Math.max(0, ms) / 1000;
        long h = total / 3600;
        long m = (total / 60) % 60;
        long s = total % 60;
        if (h > 0) return String.format(java.util.Locale.ROOT, "%d:%02d:%02d", h, m, s);
        return String.format(java.util.Locale.ROOT, "%d:%02d", m, s);
    }

    // ---- redesign --------------------------------------------------------------------------

    /** The pause screen shows after this long paused with no input. */
    public static final long PAUSE_INFO_DELAY_MS = 6_000;
    /** The controls hide after this long idle while playing. */
    public static final long CONTROLS_IDLE_MS = 5_000;

    /**
     * Whether the pause screen is due: paused ({@code pausedSinceMs} >= 0) and neither the pause
     * nor the last input is less than {@link #PAUSE_INFO_DELAY_MS} old.
     */
    public static boolean pauseInfoDue(long pausedSinceMs, long lastInputMs, long nowMs) {
        if (pausedSinceMs < 0) return false;
        return nowMs - Math.max(pausedSinceMs, lastInputMs) >= PAUSE_INFO_DELAY_MS;
    }

    /** Preview step while scrubbing the focused bar with a held key: 10 s, 30 s after 1.5 s, 60 s after 3 s. */
    public static long scrubStepMs(long heldMs) {
        if (heldMs < 1_500) return 10_000;
        if (heldMs < 3_000) return 30_000;
        return 60_000;
    }

    /** Skipping the credits with nothing next ends playback (counted as completed). */
    public static boolean skipEndsPlayback(@Nullable VideoRequest.Segment s, boolean hasNext) {
        return s != null && s.type.equals("credits") && !hasNext;
    }

    /**
     * The intro to auto-skip at {@code positionMs} when the "Skip intros" pref is on: once per play,
     * intro only (a recap is never skipped automatically), and not in its last {@link #SKIP_TAIL_MS}.
     */
    @Nullable
    public static VideoRequest.Segment autoSkip(List<VideoRequest.Segment> segments, long positionMs, boolean enabled,
            boolean alreadySkipped) {
        if (!enabled || alreadySkipped) return null;
        for (VideoRequest.Segment s : segments) {
            if (!s.type.equals("intro")) continue;
            if (positionMs >= s.startMs && positionMs < s.endMs - SKIP_TAIL_MS) return s;
        }
        return null;
    }

    public enum EndAction { NEXT, CLOSE }

    /** What happens when the item ends: the next item only with one, not cancelled, and autoplay on. */
    public static EndAction endAction(boolean hasNext, boolean cancelled, boolean autoplayNext) {
        return hasNext && !cancelled && autoplayNext ? EndAction.NEXT : EndAction.CLOSE;
    }

    /** Caption size in stage px for the subtitle-size pref (small / medium / large). */
    public static int captionSize(String pref) {
        if ("small".equals(pref)) return 22;
        if ("large".equals(pref)) return 36;
        return 28;
    }

    /** Title of the chapter playing at {@code positionMs}, or null. Chapters are sorted by start. */
    @Nullable
    public static String chapterAt(List<VideoRequest.Chapter> chapters, long positionMs) {
        String title = null;
        for (VideoRequest.Chapter c : chapters) {
            if (c.startMs <= positionMs) title = c.title;
            else break;
        }
        return title == null || title.isEmpty() ? null : title;
    }
}

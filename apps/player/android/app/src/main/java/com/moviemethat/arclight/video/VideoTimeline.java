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

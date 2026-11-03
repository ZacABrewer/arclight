package com.moviemethat.arclight.cast;

import com.moviemethat.arclight.player.TrackInfo;
import java.util.ArrayList;
import java.util.List;

/**
 * Which part of the native queue a Cast receiver can play: only http(s) links (a receiver cannot
 * open the phone's downloaded files). Pure Java (unit tested).
 */
public final class CastQueueMapper {

    /** The castable tracks and where to start among them. */
    public static final class Plan {
        public final List<TrackInfo> tracks;
        /** Index into {@link #tracks}; -1 when nothing is castable. */
        public final int startIndex;
        /** Whether the requested start track itself was castable (else the position is dropped). */
        public final boolean startIsExact;

        Plan(List<TrackInfo> tracks, int startIndex, boolean startIsExact) {
            this.tracks = tracks;
            this.startIndex = startIndex;
            this.startIsExact = startIsExact;
        }
    }

    private CastQueueMapper() {}

    /**
     * Keeps the remote tracks; the start becomes the requested track, or the next castable one
     * after it (or, failing that, the last castable one before it).
     */
    public static Plan plan(List<TrackInfo> queue, int requestedIndex) {
        List<TrackInfo> out = new ArrayList<>();
        int start = -1;
        boolean exact = false;
        int lastBefore = -1;
        for (int i = 0; i < queue.size(); i++) {
            TrackInfo t = queue.get(i);
            if (!t.isRemote()) continue;
            if (i < requestedIndex) lastBefore = out.size();
            if (start < 0 && i >= requestedIndex) {
                start = out.size();
                exact = i == requestedIndex;
            }
            out.add(t);
        }
        if (start < 0) start = lastBefore;
        return new Plan(out, start, exact);
    }

    /** Media3-style status name for a Cast MediaStatus player state (constants passed in). */
    public static String statusName(boolean playing, boolean paused, boolean buffering, boolean loading, boolean finished, boolean error) {
        if (error) return "error";
        if (playing) return "playing";
        if (paused) return "paused";
        if (buffering) return "buffering";
        if (loading) return "loading";
        if (finished) return "ended";
        return "idle";
    }
}

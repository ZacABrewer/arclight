package com.moviemethat.arclight;

import androidx.annotation.Nullable;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * Cold-launch info for the launch intro (consumeLaunchInfo, §6). MainActivity records how the
 * first activity of this process was started; the first {@link #consume} reports coldStart true,
 * every later one false. {@link #classify} is pure (plain strings), so it is JVM unit-testable.
 */
public final class LaunchInfo {

    /** Intent extra that names the source when an intent cannot say it itself (e.g. the notification). */
    public static final String EXTRA_SOURCE = "arclight.launchSource";

    static final String ACTION_MAIN = "android.intent.action.MAIN";
    static final String ACTION_VIEW = "android.intent.action.VIEW";
    static final String ACTION_MEDIA_BUTTON = "android.intent.action.MEDIA_BUTTON";
    static final String CATEGORY_LAUNCHER = "android.intent.category.LAUNCHER";
    static final String CATEGORY_LEANBACK_LAUNCHER = "android.intent.category.LEANBACK_LAUNCHER";
    static final String CATEGORY_CAR_MODE = "android.intent.category.CAR_MODE";

    private static final Set<String> SOURCES =
            new HashSet<>(Arrays.asList("launcher", "deep-link", "notification", "media-button", "car", "other"));

    public final boolean coldStart;
    public final String source;
    public final boolean systemReducedMotion;

    LaunchInfo(boolean coldStart, String source, boolean systemReducedMotion) {
        this.coldStart = coldStart;
        this.source = source;
        this.systemReducedMotion = systemReducedMotion;
    }

    private static final Object LOCK = new Object();
    @Nullable private static String recorded;
    private static boolean consumed;

    /**
     * The launch source of an intent: an explicit {@link #EXTRA_SOURCE}, a VIEW with data (deep
     * link), MAIN from a launcher, a media button, a car-mode launch, else "other" (also for an
     * activity recreated from saved state).
     */
    public static String classify(@Nullable String action, @Nullable Set<String> categories, boolean hasData,
            @Nullable String extraSource, boolean restored) {
        if (extraSource != null && SOURCES.contains(extraSource)) return extraSource;
        if (restored) return "other";
        boolean hasCat = categories != null;
        if (hasCat && categories.contains(CATEGORY_CAR_MODE)) return "car";
        if (ACTION_VIEW.equals(action) && hasData) return "deep-link";
        if (ACTION_MEDIA_BUTTON.equals(action)) return "media-button";
        if (ACTION_MAIN.equals(action)
                && (!hasCat || categories.contains(CATEGORY_LAUNCHER) || categories.contains(CATEGORY_LEANBACK_LAUNCHER))) {
            return "launcher";
        }
        return "other";
    }

    /** Records the first activity launch of this process; later calls are ignored. */
    public static void record(String source) {
        synchronized (LOCK) {
            if (recorded == null) recorded = source;
        }
    }

    /** coldStart is true for the first call in this process only. */
    public static LaunchInfo consume(boolean systemReducedMotion) {
        synchronized (LOCK) {
            boolean cold = !consumed;
            consumed = true;
            return new LaunchInfo(cold, recorded == null ? "other" : recorded, systemReducedMotion);
        }
    }

    /** Tests only. */
    static void reset() {
        synchronized (LOCK) {
            recorded = null;
            consumed = false;
        }
    }
}

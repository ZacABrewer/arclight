package com.moviemethat.arclight.video;

import androidx.annotation.Nullable;
import java.util.Collections;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The overlay's strings: the ones JS translated (PlayVideoOptions.strings, NativeVideoString keys)
 * win, else the app's own resource fallbacks (passed in by VideoActivity). Pure.
 */
public final class OverlayStrings {

    private static final Pattern NUMBERED = Pattern.compile("^\\s*\\d+\\s*[.:)]\\s*");

    private final Map<String, String> js;
    private final Map<String, String> fallback;

    public OverlayStrings(@Nullable Map<String, String> js, @Nullable Map<String, String> fallback) {
        this.js = js == null ? Collections.emptyMap() : js;
        this.fallback = fallback == null ? Collections.emptyMap() : fallback;
    }

    public String get(String key) {
        String v = js.get(key);
        if (v != null && !v.isEmpty()) return v;
        v = fallback.get(key);
        return v == null ? key : v;
    }

    /** "Next episode in 8s". */
    public String nextIn(long seconds) {
        return get("nextIn").replace("{s}", String.valueOf(Math.max(0, seconds)));
    }

    /** "Up next in 12" (the card's label). */
    public String upNextIn(long seconds) {
        return get("upNextIn").replace("{s}", String.valueOf(Math.max(0, seconds)));
    }

    /** "Ember County · 3 episodes played in a row." */
    public String stillWatchingBody(String title, int episodes) {
        return get("stillWatchingBody").replace("{title}", title).replace("{n}", String.valueOf(episodes));
    }

    /** "Error network · 21:14:07 · stopped at 19:12". */
    public String errorDetail(String code, String time, String position) {
        return get("errorDetail").replace("{code}", code).replace("{time}", time).replace("{position}", position);
    }

    /** "Ends at 9:42 PM". */
    public String endsAt(String time) {
        return get("endsAt").replace("{time}", time);
    }

    /**
     * The episodes-panel row title "E5 · The Long Meridian" from NativeEpisode's "5. The Long
     * Meridian" (a leading "5. " is dropped; a title without one is kept as is).
     */
    public static String rowTitle(int episodeNumber, String title) {
        String t = title == null ? "" : title.trim();
        Matcher m = NUMBERED.matcher(t);
        if (m.find()) t = t.substring(m.end());
        return t.isEmpty() ? "E" + episodeNumber : "E" + episodeNumber + " · " + t;
    }
}

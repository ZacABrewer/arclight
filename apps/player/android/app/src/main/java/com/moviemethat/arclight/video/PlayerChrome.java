package com.moviemethat.arclight.video;

import androidx.annotation.Nullable;
import java.util.ArrayList;
import java.util.List;

/**
 * Text of the player's chrome that is worked out, not translated (the template's S16 top-right
 * line, the S18 cause). Pure.
 */
public final class PlayerChrome {

    private PlayerChrome() {}

    /** Autoplayed episodes in a row without any input before "Are you still watching?" (S19). */
    public static final int STILL_WATCHING_AFTER = 3;

    /** The top-right line: the badges ("4K HDR10", "5.1") and the delivery ("Direct play"). */
    public static final class Info {
        public final List<String> badges;
        @Nullable public final String method;

        Info(List<String> badges, @Nullable String method) {
            this.badges = badges;
            this.method = method;
        }
    }

    /**
     * From JS's streamInfo ("Direct play · 4K HDR10": the delivery, then the picture) and the
     * playing audio's channel count.
     */
    public static Info info(@Nullable String streamInfo, @Nullable Integer channels) {
        List<String> badges = new ArrayList<>();
        String method = null;
        if (streamInfo != null) {
            String[] parts = streamInfo.split("\\s+·\\s+");
            for (int i = 0; i < parts.length; i++) {
                String p = parts[i].trim();
                if (p.isEmpty()) continue;
                if (i == 0) method = p;
                else badges.add(p);
            }
        }
        String ch = channelsBadge(channels);
        if (ch != null) badges.add(ch);
        return new Info(badges, method);
    }

    /** "5.1" / "7.1" for surround (6 / 8 channels); null for stereo, mono or unknown. */
    @Nullable
    public static String channelsBadge(@Nullable Integer channels) {
        if (channels == null || channels <= 2) return null;
        if (channels == 6) return "5.1";
        if (channels == 8) return "7.1";
        if (channels == 7) return "6.1";
        return channels + "ch";
    }

    /** The overlay string key of the S18 cause for a close code (PlaybackMapping.errorCode, "timeout"). */
    public static String errorMessageKey(@Nullable String code) {
        if (code == null) return "errorLoad";
        switch (code) {
            case "auth":
                return "errorForbidden";
            case "network":
            case "file":
                return "errorNetwork";
            case "unsupported":
            case "decoder":
                return "errorUnsupported";
            case "busy":
                return "errorBusy";
            case "timeout":
                return "errorTimeout";
            default:
                return "errorLoad";
        }
    }

    /** Whether to ask before the next autoplay: {@code autoplays} in a row already went by untouched. */
    public static boolean askStillWatching(int autoplays) {
        return autoplays >= STILL_WATCHING_AFTER;
    }
}

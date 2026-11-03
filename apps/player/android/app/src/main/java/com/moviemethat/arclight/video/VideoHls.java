package com.moviemethat.arclight.video;

import androidx.annotation.Nullable;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The HLS side of a video session (0.24, VideoHlsInfo in packages/shared/src/video-hls.ts): the
 * ladder rungs the master playlist lists, the rung to start on, the signed health link, and the
 * pure rules the player applies to them: which variant a pinned quality locks to, and how far the
 * server's "cannot sustain" advice caps the adaptive choice. No Android types (JVM unit tests).
 */
public final class VideoHls {

    /** One ladder rung (VideoHlsRung). */
    public static final class Rung {
        /** '360' | '480' | '720' | '1080' | '2160' | 'src'. */
        public final String id;
        public final int height;
        public final int videoKbps;
        /** 'h264' | 'hevc' | 'copy'. */
        public final String codec;
        /** 'sdr' | 'hdr10' | 'hlg'. */
        public final String range;
        /** Index of its EXT-X-STREAM-INF in the master playlist. */
        public final int level;

        public Rung(String id, int height, int videoKbps, String codec, String range, int level) {
            this.id = id;
            this.height = height;
            this.videoKbps = videoKbps;
            this.codec = codec;
            this.range = range;
            this.level = level;
        }
    }

    /** A variant as the player sees it (Format.height, Format.bitrate; <= 0 when unknown). */
    public static final class Variant {
        public final int height;
        public final int bitrate;

        public Variant(int height, int bitrate) {
            this.height = height;
            this.bitrate = bitrate;
        }
    }

    public final String sessionId;
    public final List<Rung> rungs;
    @Nullable public final String startRung;
    @Nullable public final String healthUrl;

    VideoHls(String sessionId, List<Rung> rungs, @Nullable String startRung, @Nullable String healthUrl) {
        this.sessionId = sessionId;
        this.rungs = rungs;
        this.startRung = startRung;
        this.healthUrl = healthUrl;
    }

    /**
     * The HLS part of playVideo / replaceVideoStream options ({@code delivery: 'hls'},
     * {@code sessionId}, {@code hls}); null when the stream is progressive.
     */
    @Nullable
    static VideoHls parse(JSONObject o) {
        if (!"hls".equals(o.optString("delivery", ""))) return null;
        JSONObject h = o.optJSONObject("hls");
        String id = VideoRequest.optString(o, "sessionId");
        List<Rung> rungs = h == null ? Collections.emptyList() : parseRungs(h.optJSONArray("rungs"));
        return new VideoHls(id == null ? "" : id, rungs, h == null ? null : VideoRequest.optString(h, "startRung"),
                h == null ? null : VideoRequest.optString(h, "healthUrl"));
    }

    static List<Rung> parseRungs(@Nullable JSONArray arr) {
        List<Rung> out = new ArrayList<>();
        if (arr == null) return out;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject r = arr.optJSONObject(i);
            String id = r == null ? null : VideoRequest.optString(r, "id");
            if (id == null) continue;
            out.add(new Rung(id, Math.max(0, r.optInt("height", 0)), Math.max(0, r.optInt("videoKbps", 0)),
                    r.optString("codec", ""), r.optString("range", "sdr"), r.optInt("level", i)));
        }
        return out;
    }

    @Nullable
    public Rung rung(@Nullable String id) {
        if (id == null) return null;
        for (Rung r : rungs) if (r.id.equals(id)) return r;
        return null;
    }

    // ---- pure rules -------------------------------------------------------------------------------

    /** Retries for a segment that answers 503 (encoder restarting after a far seek). */
    static final int MIN_RETRIES = 8;
    static final long DEFAULT_RETRY_MS = 1_000;
    static final long MAX_RETRY_MS = 5_000;

    /** The wait before retrying a 503: its Retry-After seconds (1..5 s), else 1 s. */
    static long retryAfterMs(@Nullable String retryAfter) {
        if (retryAfter == null) return DEFAULT_RETRY_MS;
        try {
            long s = Long.parseLong(retryAfter.trim());
            return Math.max(DEFAULT_RETRY_MS, Math.min(MAX_RETRY_MS, s * 1000));
        } catch (NumberFormatException e) {
            return DEFAULT_RETRY_MS;
        }
    }

    /**
     * The bandwidth meter's starting estimate in bit/s: the last throughput measured on this
     * network (JS keeps it), else the start rung's bitrate with headroom so the first variant is
     * the one the server picked; 0 leaves Media3's default.
     */
    static long initialEstimateBps(long hintKbps, @Nullable VideoHls hls) {
        if (hintKbps > 0) return hintKbps * 1000;
        if (hls == null) return 0;
        Rung start = hls.rung(hls.startRung);
        if (start == null || start.videoKbps <= 0) return 0;
        return (long) start.videoKbps * 1000 * 3 / 2;
    }

    /** The height a pinned quality ('1080p', '720p', '480p') stands for; 0 for auto / original. */
    static int qualityHeight(@Nullable String quality) {
        if (quality == null) return 0;
        switch (quality) {
            case "1080p":
                return 1080;
            case "720p":
                return 720;
            case "480p":
                return 480;
            default:
                return 0;
        }
    }

    /** Auto (or no setting): the player adapts across the ladder. */
    public static boolean adaptive(@Nullable String quality) {
        return quality == null || quality.equals("auto") || (!quality.equals("original") && qualityHeight(quality) == 0);
    }

    /**
     * The variant a pinned quality locks to, or -1 to adapt. Original: the best one (tallest, then
     * highest bitrate). A height: the tallest variant at or under it (the best bitrate among
     * equals), else the smallest one there is.
     */
    public static int pinnedVariant(List<Variant> variants, @Nullable String quality) {
        if (adaptive(quality) || variants.isEmpty()) return -1;
        int limit = "original".equals(quality) ? Integer.MAX_VALUE : qualityHeight(quality);
        int best = -1;
        for (int i = 0; i < variants.size(); i++) {
            Variant v = variants.get(i);
            if (v.height > limit) continue;
            if (best < 0 || better(v, variants.get(best))) best = i;
        }
        if (best >= 0) return best;
        int smallest = 0;
        for (int i = 1; i < variants.size(); i++) {
            Variant v = variants.get(i);
            Variant s = variants.get(smallest);
            if (v.height < s.height || (v.height == s.height && v.bitrate < s.bitrate)) smallest = i;
        }
        return smallest;
    }

    private static boolean better(Variant a, Variant b) {
        return a.height > b.height || (a.height == b.height && a.bitrate > b.bitrate);
    }

    /**
     * The largest video height adaptive playback may pick after the server said the encoder
     * cannot keep up above {@code maxSustainableRung} (VideoHlsHealth): that rung's height, or
     * {@link Integer#MAX_VALUE} for no cap (no advice, or a rung this session does not list).
     */
    public static int capHeight(List<Rung> rungs, @Nullable String maxSustainableRung) {
        if (maxSustainableRung == null) return Integer.MAX_VALUE;
        for (Rung r : rungs) {
            if (r.id.equals(maxSustainableRung) && r.height > 0) return r.height;
        }
        return Integer.MAX_VALUE;
    }

    /** {@code maxSustainableRung} from a VideoHlsHealth body; null when absent or unreadable. */
    @Nullable
    public static String adviceFrom(@Nullable String healthJson) {
        if (healthJson == null || healthJson.isEmpty()) return null;
        try {
            return VideoRequest.optString(new JSONObject(healthJson), "maxSustainableRung");
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * The rung named in an {@code X-Arclight-Encode} header ("speed=0.92;advice=720"); null when
     * the header carries no advice.
     */
    @Nullable
    public static String adviceFromHeader(@Nullable String header) {
        if (header == null) return null;
        for (String part : header.split(";")) {
            String p = part.trim();
            if (p.startsWith("advice=")) {
                String v = p.substring("advice=".length()).trim();
                return v.isEmpty() ? null : v;
            }
        }
        return null;
    }
}

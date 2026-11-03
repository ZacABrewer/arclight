package com.moviemethat.arclight.video;

import androidx.annotation.Nullable;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The parsed {@code playVideo} options (PlayVideoOptions in src/native/definitions.ts) plus the
 * stream parts {@code replaceVideoStream} swaps. Plain data parsed from org.json, so it is JVM
 * unit-testable. All times are media time (absolute) unless named otherwise.
 */
public final class VideoRequest {

    public static final class Subtitle {
        public final String id;
        public final String url;
        public final String label;
        @Nullable public final String language;
        public final boolean isDefault;
        public final boolean forced;

        Subtitle(String id, String url, String label, @Nullable String language, boolean isDefault, boolean forced) {
            this.id = id;
            this.url = url;
            this.label = label;
            this.language = language;
            this.isDefault = isDefault;
            this.forced = forced;
        }
    }

    public static final class AudioTrack {
        public final int index;
        public final String label;

        AudioTrack(int index, String label) {
            this.index = index;
            this.label = label;
        }
    }

    public static final class Chapter {
        public final String title;
        public final long startMs;

        Chapter(String title, long startMs) {
            this.title = title;
            this.startMs = startMs;
        }
    }

    public static final class Segment {
        /** "intro", "credits" or "recap". */
        public final String type;
        public final long startMs;
        public final long endMs;

        public Segment(String type, long startMs, long endMs) {
            this.type = type;
            this.startMs = startMs;
            this.endMs = endMs;
        }
    }

    public static final class Next {
        public final String itemKey;
        public final String title;
        @Nullable public final String subtitle;
        @Nullable public final String artworkUrl;

        Next(String itemKey, String title, @Nullable String subtitle, @Nullable String artworkUrl) {
            this.itemKey = itemKey;
            this.title = title;
            this.subtitle = subtitle;
            this.artworkUrl = artworkUrl;
        }
    }

    /** The parts of a request that {@code replaceVideoStream} replaces. */
    public static final class Stream {
        public final String url;
        public final String mimeType;
        public final long streamStartMs;
        public final boolean seekable;
        /** Where to continue (media time). */
        public final long positionMs;
        /** Null = keep the current subtitle links. */
        @Nullable public final List<Subtitle> subtitles;
        /** Null = unchanged. */
        @Nullable public final Integer selectedAudio;
        /** The "Direct play · 1080p" line for the new stream; null = unchanged. */
        @Nullable public final String streamInfo;

        Stream(String url, String mimeType, long streamStartMs, boolean seekable, long positionMs,
                @Nullable List<Subtitle> subtitles, @Nullable Integer selectedAudio) {
            this(url, mimeType, streamStartMs, seekable, positionMs, subtitles, selectedAudio, null);
        }

        Stream(String url, String mimeType, long streamStartMs, boolean seekable, long positionMs,
                @Nullable List<Subtitle> subtitles, @Nullable Integer selectedAudio, @Nullable String streamInfo) {
            this.url = url;
            this.mimeType = mimeType;
            this.streamStartMs = streamStartMs;
            this.seekable = seekable;
            this.positionMs = positionMs;
            this.subtitles = subtitles;
            this.selectedAudio = selectedAudio;
            this.streamInfo = streamInfo;
        }

        public static Stream parse(JSONObject o) {
            String url = requireString(o, "url");
            List<Subtitle> subs = o.has("subtitles") && !o.isNull("subtitles") ? parseSubtitles(o.optJSONArray("subtitles")) : null;
            Integer audio = o.has("selectedAudio") && !o.isNull("selectedAudio") ? o.optInt("selectedAudio") : null;
            return new Stream(url, o.optString("mimeType", ""), nonNegative(o, "streamStartMs"), o.optBoolean("seekable", false),
                    nonNegative(o, "positionMs"), subs, audio, optString(o, "streamInfo"));
        }
    }

    public final String itemKey;
    public final Map<String, String> headers;
    public final String title;
    @Nullable public final String subtitle;
    /** Replaced with the stream (see {@link Stream#streamInfo}). */
    @Nullable public String streamInfo;
    @Nullable public final String artworkUrl;
    @Nullable public final String backdropUrl;
    public final long durationMs;
    public final long startPositionMs;
    public final List<AudioTrack> audioTracks;
    public final List<Chapter> chapters;
    public final List<Segment> segments;
    @Nullable public final Next next;

    // Mutable: replaced by replaceVideoStream / the pickers.
    public String url;
    public String mimeType;
    public long streamStartMs;
    public boolean seekable;
    public List<Subtitle> subtitles;
    /** Subtitle id shown, null = off. */
    @Nullable public String selectedSubtitle;
    /** Audio ordinal, null = the stream's default. */
    @Nullable public Integer selectedAudio;

    private VideoRequest(JSONObject o) {
        itemKey = requireString(o, "itemKey");
        url = requireString(o, "url");
        mimeType = o.optString("mimeType", "");
        streamStartMs = nonNegative(o, "streamStartMs");
        startPositionMs = nonNegative(o, "startPositionMs");
        seekable = o.optBoolean("seekable", false);
        durationMs = nonNegative(o, "durationMs");
        title = o.optString("title", "");
        subtitle = optString(o, "subtitle");
        streamInfo = optString(o, "streamInfo");
        artworkUrl = optString(o, "artworkUrl");
        backdropUrl = optString(o, "backdropUrl");
        headers = parseHeaders(o.optJSONObject("headers"));
        subtitles = parseSubtitles(o.optJSONArray("subtitles"));
        selectedSubtitle = optString(o, "selectedSubtitle");
        if (selectedSubtitle != null && findSubtitle(selectedSubtitle) == null) selectedSubtitle = null;
        audioTracks = parseAudio(o.optJSONArray("audioTracks"));
        selectedAudio = o.has("selectedAudio") && !o.isNull("selectedAudio") ? o.optInt("selectedAudio") : null;
        chapters = parseChapters(o.optJSONArray("chapters"));
        segments = parseSegments(o.optJSONArray("segments"));
        JSONObject n = o.optJSONObject("next");
        next = n == null || optString(n, "itemKey") == null
                ? null
                : new Next(n.optString("itemKey"), n.optString("title", ""), optString(n, "subtitle"), optString(n, "artworkUrl"));
    }

    /** Parses PlayVideoOptions. Throws IllegalArgumentException for a missing itemKey / url. */
    public static VideoRequest parse(JSONObject o) {
        return new VideoRequest(o);
    }

    /** Applies a replaceVideoStream update. */
    public void apply(Stream s) {
        url = s.url;
        if (!s.mimeType.isEmpty()) mimeType = s.mimeType;
        streamStartMs = s.streamStartMs;
        seekable = s.seekable;
        if (s.subtitles != null) {
            subtitles = s.subtitles;
            if (selectedSubtitle != null && findSubtitle(selectedSubtitle) == null) selectedSubtitle = null;
        }
        if (s.selectedAudio != null) selectedAudio = s.selectedAudio;
        if (s.streamInfo != null) streamInfo = s.streamInfo;
    }

    @Nullable
    public Subtitle findSubtitle(String id) {
        for (Subtitle s : subtitles) if (s.id.equals(id)) return s;
        return null;
    }

    /** Player position (inside the current stream) for a media time, clamped at 0. */
    public long toPlayerMs(long mediaMs) {
        return Math.max(0, mediaMs - streamStartMs);
    }

    public long toMediaMs(long playerMs) {
        return Math.max(0, playerMs) + streamStartMs;
    }

    // ---- parsing helpers ----------------------------------------------------------------------

    static String requireString(JSONObject o, String key) {
        String v = optString(o, key);
        if (v == null || v.isEmpty()) throw new IllegalArgumentException(key + " is required");
        return v;
    }

    @Nullable
    static String optString(JSONObject o, String key) {
        if (o == null || !o.has(key) || o.isNull(key)) return null;
        String v = o.optString(key, null);
        return v == null || v.isEmpty() ? null : v;
    }

    static long nonNegative(JSONObject o, String key) {
        double d = o.optDouble(key, 0);
        return Double.isNaN(d) || d < 0 ? 0 : Math.round(d);
    }

    static Map<String, String> parseHeaders(@Nullable JSONObject h) {
        if (h == null) return Collections.emptyMap();
        Map<String, String> out = new HashMap<>();
        Iterator<String> keys = h.keys();
        while (keys.hasNext()) {
            String k = keys.next();
            String v = h.optString(k, null);
            if (v != null) out.put(k, v);
        }
        return out;
    }

    static List<Subtitle> parseSubtitles(@Nullable JSONArray arr) {
        List<Subtitle> out = new ArrayList<>();
        if (arr == null) return out;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject s = arr.optJSONObject(i);
            if (s == null) continue;
            String id = optString(s, "id");
            String url = optString(s, "url");
            if (id == null || url == null) continue;
            String label = optString(s, "label");
            out.add(new Subtitle(id, url, label == null ? id : label, optString(s, "language"),
                    s.optBoolean("default", false), s.optBoolean("forced", false)));
        }
        return out;
    }

    static List<AudioTrack> parseAudio(@Nullable JSONArray arr) {
        List<AudioTrack> out = new ArrayList<>();
        if (arr == null) return out;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject a = arr.optJSONObject(i);
            if (a == null || !a.has("index")) continue;
            int index = a.optInt("index", i);
            String label = optString(a, "label");
            out.add(new AudioTrack(index, label == null ? "#" + (index + 1) : label));
        }
        return out;
    }

    static List<Chapter> parseChapters(@Nullable JSONArray arr) {
        List<Chapter> out = new ArrayList<>();
        if (arr == null) return out;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject c = arr.optJSONObject(i);
            if (c == null) continue;
            out.add(new Chapter(c.optString("title", ""), nonNegative(c, "startMs")));
        }
        out.sort((a, b) -> Long.compare(a.startMs, b.startMs));
        return out;
    }

    static List<Segment> parseSegments(@Nullable JSONArray arr) {
        List<Segment> out = new ArrayList<>();
        if (arr == null) return out;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject s = arr.optJSONObject(i);
            if (s == null) continue;
            String type = s.optString("type", "");
            long start = nonNegative(s, "startMs");
            long end = nonNegative(s, "endMs");
            if (end <= start) continue;
            if (!type.equals("intro") && !type.equals("credits") && !type.equals("recap")) continue;
            out.add(new Segment(type, start, end));
        }
        return out;
    }
}

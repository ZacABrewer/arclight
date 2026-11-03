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
        /** As tagged in the file (ISO 639-2, "eng"); null when untagged or not sent. */
        @Nullable public final String language;
        /** ffprobe codec name ("eac3"); null when not sent. */
        @Nullable public final String codec;
        @Nullable public final Integer channels;
        /** The stream's own title tag. */
        @Nullable public final String title;

        AudioTrack(int index, String label) {
            this(index, label, null, null, null, null);
        }

        AudioTrack(int index, String label, @Nullable String language, @Nullable String codec, @Nullable Integer channels, @Nullable String title) {
            this.index = index;
            this.label = label;
            this.language = language;
            this.codec = codec;
            this.channels = channels;
            this.title = title;
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

    // ---- redesign: pause screen, scrub thumbnails, episodes, prefs ----------------------------

    /** One piece of the pause screen's meta line (NativePauseInfo.meta). */
    public static final class MetaPiece {
        public final String text;
        /** The certification, drawn in a box. */
        public final boolean boxed;
        /** A media chip (resolution, HDR, audio...). */
        public final boolean chip;

        MetaPiece(String text, boolean boxed, boolean chip) {
            this.text = text;
            this.boxed = boxed;
            this.chip = chip;
        }
    }

    /** NativePauseInfo: already-translated strings built in JS. */
    public static final class Pause {
        public final String title;
        @Nullable public final String episodeLine;
        public final List<MetaPiece> meta;
        @Nullable public final String overview;
        @Nullable public final String logoUrl;
        @Nullable public final String backdropUrl;

        Pause(String title, @Nullable String episodeLine, List<MetaPiece> meta, @Nullable String overview,
                @Nullable String logoUrl, @Nullable String backdropUrl) {
            this.title = title;
            this.episodeLine = episodeLine;
            this.meta = meta;
            this.overview = overview;
            this.logoUrl = logoUrl;
            this.backdropUrl = backdropUrl;
        }
    }

    /** NativeTrickplay: sprite sheets of scrub thumbnails (see {@link TrickplayMath}). */
    public static final class Trickplay {
        public final long intervalMs;
        public final int tileWidth;
        public final int tileHeight;
        public final int columns;
        public final int rows;
        public final int tileCount;
        public final List<String> sheets;

        public Trickplay(long intervalMs, int tileWidth, int tileHeight, int columns, int rows, int tileCount, List<String> sheets) {
            this.intervalMs = intervalMs;
            this.tileWidth = tileWidth;
            this.tileHeight = tileHeight;
            this.columns = columns;
            this.rows = rows;
            this.tileCount = tileCount;
            this.sheets = sheets;
        }
    }

    /** NativeEpisode (the episodes panel). */
    public static final class Episode {
        public final String itemKey;
        public final int episodeNumber;
        /** "5. The Long Meridian". */
        public final String title;
        @Nullable public final String runtime;
        @Nullable public final String overview;
        @Nullable public final String thumbUrl;
        /** 0..1, or null when unplayed. */
        @Nullable public final Float progress;
        public final boolean played;

        Episode(String itemKey, int episodeNumber, String title, @Nullable String runtime, @Nullable String overview,
                @Nullable String thumbUrl, @Nullable Float progress, boolean played) {
            this.itemKey = itemKey;
            this.episodeNumber = episodeNumber;
            this.title = title;
            this.runtime = runtime;
            this.overview = overview;
            this.thumbUrl = thumbUrl;
            this.progress = progress;
            this.played = played;
        }
    }

    public static final class Season {
        public final int seasonNumber;
        public final String title;
        public final List<Episode> episodes;

        Season(int seasonNumber, String title, List<Episode> episodes) {
            this.seasonNumber = seasonNumber;
            this.title = title;
            this.episodes = episodes;
        }
    }

    /** NativeVideoPrefs, with the profile defaults when JS sends none. */
    public static final class Prefs {
        /** 'small' | 'medium' | 'large'. */
        public final String subtitleSize;
        public final boolean skipIntros;
        public final boolean autoplayNext;
        /** 'white-frame' | 'cyan-glow'. */
        public final String focusStyle;
        public final boolean reduceMotion;

        Prefs(String subtitleSize, boolean skipIntros, boolean autoplayNext, String focusStyle, boolean reduceMotion) {
            this.subtitleSize = subtitleSize;
            this.skipIntros = skipIntros;
            this.autoplayNext = autoplayNext;
            this.focusStyle = focusStyle;
            this.reduceMotion = reduceMotion;
        }

        public boolean cyanGlow() {
            return "cyan-glow".equals(focusStyle);
        }

        static final Prefs DEFAULT = new Prefs("medium", false, true, "white-frame", false);

        static Prefs parse(@Nullable JSONObject o) {
            if (o == null) return DEFAULT;
            String size = o.optString("subtitleSize", "medium");
            if (!size.equals("small") && !size.equals("large")) size = "medium";
            String focus = "cyan-glow".equals(o.optString("focusStyle")) ? "cyan-glow" : "white-frame";
            return new Prefs(size, o.optBoolean("skipIntros", false), o.optBoolean("autoplayNext", true), focus,
                    o.optBoolean("reduceMotion", false));
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
    /** Pause screen; null: built from the title / subtitle. */
    @Nullable public final Pause pause;
    /** Scrub thumbnails; null: time and chapter only. */
    @Nullable public final Trickplay trickplay;
    /** Episodes panel (episodes only); empty: no panel. */
    public final List<Season> seasons;
    /** The season of the playing episode (the panel opens on it); null: the one holding it. */
    @Nullable public final Integer currentSeason;
    public final Prefs prefs;
    /** NativeVideoTheme as sent (parsed by OverlayTheme); null: the cinema defaults. */
    @Nullable public final JSONObject theme;
    /** Overlay strings translated in JS (NativeVideoString keys). */
    public final Map<String, String> strings;

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
        pause = parsePause(o.optJSONObject("pause"));
        trickplay = parseTrickplay(o.optJSONObject("trickplay"));
        seasons = parseSeasons(o.optJSONArray("seasons"));
        currentSeason = o.has("currentSeason") && !o.isNull("currentSeason") ? o.optInt("currentSeason") : null;
        prefs = Prefs.parse(o.optJSONObject("prefs"));
        theme = o.optJSONObject("theme");
        strings = parseHeaders(o.optJSONObject("strings"));
    }

    /** The season the episodes panel opens on: {@link #currentSeason}, else the one holding this item, else the first. */
    @Nullable
    public Season panelSeason() {
        if (seasons.isEmpty()) return null;
        if (currentSeason != null) for (Season s : seasons) if (s.seasonNumber == currentSeason) return s;
        for (Season s : seasons) for (Episode e : s.episodes) if (e.itemKey.equals(itemKey)) return s;
        return seasons.get(0);
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
            Integer channels = a.has("channels") && !a.isNull("channels") ? a.optInt("channels") : null;
            out.add(new AudioTrack(index, label == null ? "#" + (index + 1) : label,
                    optString(a, "language"), optString(a, "codec"), channels, optString(a, "title")));
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

    @Nullable
    static Pause parsePause(@Nullable JSONObject p) {
        if (p == null) return null;
        String title = optString(p, "title");
        if (title == null) return null;
        List<MetaPiece> meta = new ArrayList<>();
        JSONArray arr = p.optJSONArray("meta");
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject m = arr.optJSONObject(i);
                String text = m == null ? null : optString(m, "text");
                if (text == null) continue;
                meta.add(new MetaPiece(text, m.optBoolean("boxed", false), m.optBoolean("chip", false)));
            }
        }
        return new Pause(title, optString(p, "episodeLine"), meta, optString(p, "overview"), optString(p, "logoUrl"),
                optString(p, "backdropUrl"));
    }

    /** Null unless every dimension is positive and there is at least one sheet. */
    @Nullable
    static Trickplay parseTrickplay(@Nullable JSONObject t) {
        if (t == null) return null;
        long interval = nonNegative(t, "intervalMs");
        int w = t.optInt("tileWidth", 0);
        int h = t.optInt("tileHeight", 0);
        int cols = t.optInt("columns", 0);
        int rows = t.optInt("rows", 0);
        int count = t.optInt("tileCount", 0);
        List<String> sheets = new ArrayList<>();
        JSONArray arr = t.optJSONArray("sheets");
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                String u = arr.optString(i, "");
                if (!u.isEmpty()) sheets.add(u);
            }
        }
        if (interval <= 0 || w <= 0 || h <= 0 || cols <= 0 || rows <= 0 || count <= 0 || sheets.isEmpty()) return null;
        return new Trickplay(interval, w, h, cols, rows, count, sheets);
    }

    static List<Season> parseSeasons(@Nullable JSONArray arr) {
        List<Season> out = new ArrayList<>();
        if (arr == null) return out;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject s = arr.optJSONObject(i);
            if (s == null) continue;
            List<Episode> eps = new ArrayList<>();
            JSONArray ea = s.optJSONArray("episodes");
            if (ea != null) {
                for (int j = 0; j < ea.length(); j++) {
                    JSONObject e = ea.optJSONObject(j);
                    String key = e == null ? null : optString(e, "itemKey");
                    if (key == null) continue;
                    Float progress = null;
                    if (e.has("progress") && !e.isNull("progress")) {
                        double d = e.optDouble("progress", 0);
                        if (!Double.isNaN(d)) progress = (float) Math.max(0, Math.min(1, d));
                    }
                    eps.add(new Episode(key, e.optInt("episodeNumber", j + 1), e.optString("title", ""), optString(e, "runtime"),
                            optString(e, "overview"), optString(e, "thumbUrl"), progress, e.optBoolean("played", false)));
                }
            }
            if (eps.isEmpty()) continue;
            int number = s.optInt("seasonNumber", i + 1);
            String title = optString(s, "title");
            out.add(new Season(number, title == null ? String.valueOf(number) : title, eps));
        }
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

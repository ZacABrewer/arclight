package com.moviemethat.arclight.video;

import androidx.annotation.Nullable;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.MissingResourceException;

/**
 * Maps one of the file's own audio tracks as ExoPlayer lists them (direct play) to the matching
 * entry of the request's {@link VideoRequest#audioTracks}, so the index sent back to JS is the
 * JS-side ordinal and never ExoPlayer's track-group position. Pure Java (tested on the JVM).
 *
 * <p>A match must be confident: language, codec family and channel count must not contradict,
 * and among several compatible JS tracks the one with the same title, or the same position among
 * the tracks of that language, is taken. Anything less returns null, and the caller reports
 * nothing rather than a track that may be in another language.
 */
public final class TrackMatch {

    private TrackMatch() {}

    /** What ExoPlayer knows about one audio track group (from its first Format). */
    public static final class FileTrack {
        @Nullable public final String language;
        @Nullable public final String label;
        /** sampleMimeType ("audio/eac3") or null. */
        @Nullable public final String mimeType;
        /** Channel count, or a value &lt;= 0 when unknown. */
        public final int channels;

        public FileTrack(@Nullable String language, @Nullable String label, @Nullable String mimeType, int channels) {
            this.language = language;
            this.label = label;
            this.mimeType = mimeType;
            this.channels = channels;
        }
    }

    /** The JS-side index for file track {@code which}, or null without a confident match. */
    @Nullable
    public static Integer jsIndexFor(List<VideoRequest.AudioTrack> js, List<FileTrack> file, int which) {
        if (which < 0 || which >= file.size() || js.isEmpty()) return null;
        // Same count and every position agrees: the lists are in the same order.
        if (js.size() == file.size()) {
            boolean aligned = true;
            for (int i = 0; i < js.size() && aligned; i++) aligned = compatible(js.get(i), file.get(i));
            if (aligned && informative(js.get(which), file.get(which), js.size())) return js.get(which).index;
        }
        FileTrack f = file.get(which);
        List<VideoRequest.AudioTrack> candidates = new ArrayList<>();
        for (VideoRequest.AudioTrack a : js) if (compatible(a, f)) candidates.add(a);
        if (candidates.isEmpty()) return null;
        String lang = language(f.language);
        // One compatible track: taken when something positively agrees (every other one contradicts).
        if (candidates.size() == 1) {
            VideoRequest.AudioTrack only = candidates.get(0);
            return agrees(only, f) ? Integer.valueOf(only.index) : null;
        }
        // Several: the one with the same title.
        if (f.label != null && !f.label.trim().isEmpty()) {
            VideoRequest.AudioTrack titled = null;
            int n = 0;
            for (VideoRequest.AudioTrack a : candidates) {
                if (a.title != null && a.title.trim().equalsIgnoreCase(f.label.trim())) {
                    titled = a;
                    n++;
                }
            }
            if (n == 1 && lang != null && lang.equals(language(titled.language))) return titled.index;
        }
        // Else the same position among the tracks of that language, when both sides have as many.
        if (lang == null) return null;
        List<VideoRequest.AudioTrack> jsSame = new ArrayList<>();
        for (VideoRequest.AudioTrack a : js) if (lang.equals(language(a.language))) jsSame.add(a);
        int rank = -1;
        int fileSame = 0;
        for (int i = 0; i < file.size(); i++) {
            if (!lang.equals(language(file.get(i).language))) continue;
            if (i == which) rank = fileSame;
            fileSame++;
        }
        if (rank < 0 || fileSame != jsSame.size()) return null;
        VideoRequest.AudioTrack ranked = jsSame.get(rank);
        return compatible(ranked, f) ? Integer.valueOf(ranked.index) : null;
    }

    /**
     * The file track for JS index {@code jsIndex}: the one that confidently maps to it, else the
     * same position (the usual case: both lists follow the container's order).
     */
    public static int groupFor(List<VideoRequest.AudioTrack> js, List<FileTrack> file, int jsIndex) {
        for (int i = 0; i < file.size(); i++) {
            Integer m = jsIndexFor(js, file, i);
            if (m != null && m == jsIndex) return i;
        }
        return jsIndex;
    }

    /**
     * An aligned position is trusted when the language is known on both sides and equal, or when
     * there is only one track (nothing to confuse it with).
     */
    private static boolean informative(VideoRequest.AudioTrack a, FileTrack f, int count) {
        if (count == 1) return true;
        String la = language(a.language);
        return la != null && la.equals(language(f.language));
    }

    /** Language, codec family or channel count is known on both sides and equal. */
    private static boolean agrees(VideoRequest.AudioTrack a, FileTrack f) {
        String la = language(a.language);
        if (la != null && la.equals(language(f.language))) return true;
        String ca = codecFamily(a.codec);
        if (ca != null && ca.equals(mimeFamily(f.mimeType))) return true;
        return a.channels != null && a.channels > 0 && a.channels == f.channels;
    }

    /** Nothing known about the two contradicts. */
    static boolean compatible(VideoRequest.AudioTrack a, FileTrack f) {
        String la = language(a.language);
        String lf = language(f.language);
        if (la != null && lf != null && !la.equals(lf)) return false;
        String ca = codecFamily(a.codec);
        String cf = mimeFamily(f.mimeType);
        if (ca != null && cf != null && !ca.equals(cf)) return false;
        return a.channels == null || a.channels <= 0 || f.channels <= 0 || a.channels == f.channels;
    }

    private static final Map<String, String> BIBLIOGRAPHIC = new HashMap<>();

    static {
        String[] pairs = {
            "alb", "sqi", "arm", "hye", "baq", "eus", "bur", "mya", "chi", "zho", "cze", "ces", "dut", "nld",
            "fre", "fra", "geo", "kat", "ger", "deu", "gre", "ell", "ice", "isl", "mac", "mkd", "mao", "mri",
            "may", "msa", "per", "fas", "rum", "ron", "slo", "slk", "tib", "bod", "wel", "cym",
        };
        for (int i = 0; i < pairs.length; i += 2) BIBLIOGRAPHIC.put(pairs[i], pairs[i + 1]);
    }

    /**
     * A language tag as a 3-letter ISO 639-2/T code ("en", "en-US", "eng", "ger" all compare), or
     * null when unknown or undetermined.
     */
    @Nullable
    static String language(@Nullable String tag) {
        if (tag == null) return null;
        String t = tag.trim().toLowerCase(Locale.ROOT);
        int cut = t.indexOf('-');
        if (cut < 0) cut = t.indexOf('_');
        if (cut >= 0) t = t.substring(0, cut);
        if (t.isEmpty() || t.equals("und") || t.equals("unk") || t.equals("mul") || t.equals("zxx")) return null;
        if (t.length() == 2) {
            try {
                String iso3 = new Locale(t).getISO3Language();
                if (iso3 != null && !iso3.isEmpty()) t = iso3;
            } catch (MissingResourceException e) {
                return t;
            }
        }
        String terminology = BIBLIOGRAPHIC.get(t);
        return terminology != null ? terminology : t;
    }

    /** ffprobe codec name to a family, or null when unknown. */
    @Nullable
    static String codecFamily(@Nullable String codec) {
        if (codec == null) return null;
        String c = codec.trim().toLowerCase(Locale.ROOT);
        if (c.isEmpty()) return null;
        if (c.startsWith("pcm_")) return "pcm";
        switch (c) {
            case "ac3":
            case "eac3":
            case "aac":
            case "opus":
            case "flac":
            case "truehd":
            case "mp3":
            case "vorbis":
            case "alac":
                return c;
            case "dts":
            case "dca":
                return "dts";
            case "mp2":
                return "mp3";
            default:
                return null;
        }
    }

    /** ExoPlayer sample MIME type to the same families, or null when unknown. */
    @Nullable
    static String mimeFamily(@Nullable String mime) {
        if (mime == null) return null;
        switch (mime.toLowerCase(Locale.ROOT)) {
            case "audio/ac3":
                return "ac3";
            case "audio/eac3":
            case "audio/eac3-joc":
                return "eac3";
            case "audio/mp4a-latm":
            case "audio/aac":
                return "aac";
            case "audio/opus":
                return "opus";
            case "audio/flac":
                return "flac";
            case "audio/true-hd":
                return "truehd";
            case "audio/mpeg":
            case "audio/mpeg-l1":
            case "audio/mpeg-l2":
                return "mp3";
            case "audio/vorbis":
                return "vorbis";
            case "audio/alac":
                return "alac";
            case "audio/raw":
                return "pcm";
            case "audio/vnd.dts":
            case "audio/vnd.dts.hd":
            case "audio/vnd.dts.hd;profile=lbr":
            case "audio/vnd.dts.uhd;profile=p2":
                return "dts";
            default:
                return null;
        }
    }
}

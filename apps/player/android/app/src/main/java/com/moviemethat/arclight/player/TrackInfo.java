package com.moviemethat.arclight.player;

import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * One playable file, as described by {@code NativeTrack} in apps/player/src/native/definitions.ts.
 * Pure Java (org.json only) so it can be unit tested on the JVM.
 */
public final class TrackInfo {

    public final String id;
    public final String itemKey;
    /** "track" or "audiobook". */
    public final String kind;
    public final int partIndex;
    public final long itemOffsetMs;
    public final String url;
    public final Map<String, String> headers;
    public final String mimeType;
    public final long durationMs;
    public final String title;
    public final String artist;
    public final String album;
    public final String artworkUrl;
    public final Map<String, String> artworkHeaders;

    private TrackInfo(JSONObject o) {
        this.id = o.optString("id", "");
        this.itemKey = o.optString("itemKey", "");
        this.kind = "audiobook".equals(o.optString("kind")) ? "audiobook" : "track";
        this.partIndex = o.optInt("partIndex", 0);
        this.itemOffsetMs = o.optLong("itemOffsetMs", 0);
        this.url = o.optString("url", "");
        this.headers = readHeaders(o.optJSONObject("headers"));
        this.mimeType = optNonEmpty(o, "mimeType");
        this.durationMs = Math.max(0, o.optLong("durationMs", 0));
        this.title = o.optString("title", "");
        this.artist = optNonEmpty(o, "artist");
        this.album = optNonEmpty(o, "album");
        this.artworkUrl = optNonEmpty(o, "artworkUrl");
        this.artworkHeaders = readHeaders(o.optJSONObject("artworkHeaders"));
    }

    /**
     * Parses one NativeTrack.
     *
     * @throws IllegalArgumentException when {@code id} or {@code url} is missing.
     */
    public static TrackInfo fromJson(JSONObject o) {
        if (o == null) throw new IllegalArgumentException("track is null");
        TrackInfo t = new TrackInfo(o);
        if (t.id.isEmpty()) throw new IllegalArgumentException("track.id is required");
        if (t.url.isEmpty()) throw new IllegalArgumentException("track.url is required (" + t.id + ")");
        return t;
    }

    public boolean isAudiobook() {
        return "audiobook".equals(kind);
    }

    /** True for http(s) URLs (stream links); false for downloaded files. */
    public boolean isRemote() {
        String u = url.toLowerCase(java.util.Locale.ROOT);
        return u.startsWith("http://") || u.startsWith("https://");
    }

    public JSONObject toJson() {
        JSONObject o = new JSONObject();
        try {
            o.put("id", id);
            o.put("itemKey", itemKey);
            o.put("kind", kind);
            o.put("partIndex", partIndex);
            o.put("itemOffsetMs", itemOffsetMs);
            o.put("url", url);
            if (!headers.isEmpty()) o.put("headers", new JSONObject(headers));
            if (mimeType != null) o.put("mimeType", mimeType);
            o.put("durationMs", durationMs);
            o.put("title", title);
            if (artist != null) o.put("artist", artist);
            if (album != null) o.put("album", album);
            if (artworkUrl != null) o.put("artworkUrl", artworkUrl);
            if (!artworkHeaders.isEmpty()) o.put("artworkHeaders", new JSONObject(artworkHeaders));
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
        return o;
    }

    static String optNonEmpty(JSONObject o, String key) {
        if (o == null || !o.has(key) || o.isNull(key)) return null;
        String v = o.optString(key, "");
        return v.isEmpty() ? null : v;
    }

    /** A JSON object of string values as an ordered, unmodifiable map (non-strings are skipped). */
    public static Map<String, String> readHeaders(JSONObject o) {
        if (o == null || o.length() == 0) return Collections.emptyMap();
        Map<String, String> out = new LinkedHashMap<>();
        Iterator<String> keys = o.keys();
        while (keys.hasNext()) {
            String k = keys.next();
            Object v = o.opt(k);
            if (v instanceof String && !k.isEmpty()) out.put(k, (String) v);
        }
        return Collections.unmodifiableMap(out);
    }
}

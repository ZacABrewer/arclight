package com.moviemethat.arclight.car;

import com.moviemethat.arclight.player.TrackInfo;
import java.util.Collections;
import java.util.Map;
import org.json.JSONException;
import org.json.JSONObject;

/** One car browse row ({@code BrowseNode} in definitions.ts). Pure Java. */
public final class BrowseNodeInfo {

    public final String id;
    public final String title;
    public final String subtitle;
    public final String artworkUrl;
    public final Map<String, String> artworkHeaders;
    public final boolean browsable;
    public final boolean playable;
    /** 0..1, or null when not given. */
    public final Double progress;

    public BrowseNodeInfo(String id, String title, String subtitle, String artworkUrl, Map<String, String> artworkHeaders,
            boolean browsable, boolean playable, Double progress) {
        this.id = id;
        this.title = title == null ? "" : title;
        this.subtitle = subtitle;
        this.artworkUrl = artworkUrl;
        this.artworkHeaders = artworkHeaders == null ? Collections.emptyMap() : artworkHeaders;
        this.browsable = browsable;
        this.playable = playable;
        this.progress = progress;
    }

    /** @throws IllegalArgumentException when the node has no id */
    public static BrowseNodeInfo fromJson(JSONObject o) {
        if (o == null) throw new IllegalArgumentException("node is null");
        String id = o.optString("id", "");
        if (id.isEmpty()) throw new IllegalArgumentException("node.id is required");
        Double progress = null;
        if (o.has("progress") && !o.isNull("progress")) {
            double p = o.optDouble("progress", Double.NaN);
            if (!Double.isNaN(p)) progress = Math.min(1.0, Math.max(0.0, p));
        }
        return new BrowseNodeInfo(
                id,
                o.optString("title", ""),
                opt(o, "subtitle"),
                opt(o, "artworkUrl"),
                TrackInfo.readHeaders(o.optJSONObject("artworkHeaders")),
                o.optBoolean("browsable", false),
                o.optBoolean("playable", false),
                progress);
    }

    public JSONObject toJson() {
        JSONObject o = new JSONObject();
        try {
            o.put("id", id);
            o.put("title", title);
            if (subtitle != null) o.put("subtitle", subtitle);
            if (artworkUrl != null) o.put("artworkUrl", artworkUrl);
            if (!artworkHeaders.isEmpty()) o.put("artworkHeaders", new JSONObject(artworkHeaders));
            o.put("browsable", browsable);
            o.put("playable", playable);
            if (progress != null) o.put("progress", (double) progress);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
        return o;
    }

    private static String opt(JSONObject o, String key) {
        if (!o.has(key) || o.isNull(key)) return null;
        String v = o.optString(key, "");
        return v.isEmpty() ? null : v;
    }
}

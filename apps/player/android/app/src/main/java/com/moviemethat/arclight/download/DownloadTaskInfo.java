package com.moviemethat.arclight.download;

import com.moviemethat.arclight.player.TrackInfo;
import java.util.Collections;
import java.util.Map;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * One download native knows about: the request from JS plus its bookkeeping. Mutable; guarded
 * by {@link DownloadStore}'s lock. Pure Java.
 */
public final class DownloadTaskInfo {

    public static final String QUEUED = "queued";
    public static final String WAITING = "waiting";
    public static final String RUNNING = "running";
    public static final String PAUSED = "paused";
    public static final String COMPLETED = "completed";
    public static final String FAILED = "failed";

    public final String id;
    public final String url;
    public final Map<String, String> headers;
    public final String destName;
    public boolean wifiOnly;
    public final String title;
    public final long expectedBytes;

    public String status = QUEUED;
    public long bytesWritten;
    public long totalBytes = -1;
    public String path;
    public String reason;
    /** ETag or Last-Modified of the first response, sent back as If-Range when resuming. */
    public String validator;
    public int httpStatus;
    public boolean retryable;

    public DownloadTaskInfo(String id, String url, Map<String, String> headers, String destName, boolean wifiOnly, String title, long expectedBytes) {
        this.id = id;
        this.url = url;
        this.headers = headers == null ? Collections.emptyMap() : headers;
        this.destName = destName;
        this.wifiOnly = wifiOnly;
        this.title = title;
        this.expectedBytes = expectedBytes;
        if (expectedBytes > 0) this.totalBytes = expectedBytes;
    }

    /** From a DownloadRequest. @throws IllegalArgumentException on missing / bad fields */
    public static DownloadTaskInfo fromRequest(JSONObject o) {
        String id = o.optString("id", "");
        String url = o.optString("url", "");
        String dest = o.optString("destName", "");
        if (id.isEmpty()) throw new IllegalArgumentException("id is required");
        String lower = url.toLowerCase(java.util.Locale.ROOT);
        if (!lower.startsWith("http://") && !lower.startsWith("https://")) throw new IllegalArgumentException("url must be http(s)");
        DownloadPaths.validateDestName(dest);
        String title = o.has("title") && !o.isNull("title") ? o.optString("title", null) : null;
        return new DownloadTaskInfo(id, url, TrackInfo.readHeaders(o.optJSONObject("headers")), dest,
                o.optBoolean("wifiOnly", false), title, o.optLong("expectedBytes", -1));
    }

    public boolean isActive() {
        return QUEUED.equals(status) || WAITING.equals(status) || RUNNING.equals(status);
    }

    /** The contract's DownloadTask. */
    public JSONObject toContract() {
        JSONObject o = new JSONObject();
        try {
            o.put("id", id);
            o.put("status", status);
            o.put("destName", destName);
            o.put("bytesWritten", bytesWritten);
            o.put("totalBytes", totalBytes);
            if (path != null) o.put("path", path);
            if (reason != null) o.put("reason", reason);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
        return o;
    }

    /** Everything, for the persisted store. */
    public JSONObject toJson() {
        JSONObject o = toContract();
        try {
            o.put("url", url);
            if (!headers.isEmpty()) o.put("headers", new JSONObject(headers));
            o.put("wifiOnly", wifiOnly);
            if (title != null) o.put("title", title);
            o.put("expectedBytes", expectedBytes);
            if (validator != null) o.put("validator", validator);
            if (httpStatus > 0) o.put("httpStatus", httpStatus);
            o.put("retryable", retryable);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
        return o;
    }

    public static DownloadTaskInfo fromJson(JSONObject o) {
        DownloadTaskInfo t = new DownloadTaskInfo(
                o.optString("id"), o.optString("url"), TrackInfo.readHeaders(o.optJSONObject("headers")),
                o.optString("destName"), o.optBoolean("wifiOnly"),
                o.has("title") ? o.optString("title", null) : null, o.optLong("expectedBytes", -1));
        t.status = o.optString("status", QUEUED);
        t.bytesWritten = o.optLong("bytesWritten", 0);
        t.totalBytes = o.optLong("totalBytes", -1);
        t.path = o.has("path") ? o.optString("path", null) : null;
        t.reason = o.has("reason") ? o.optString("reason", null) : null;
        t.validator = o.has("validator") ? o.optString("validator", null) : null;
        t.httpStatus = o.optInt("httpStatus", 0);
        t.retryable = o.optBoolean("retryable", false);
        return t;
    }
}

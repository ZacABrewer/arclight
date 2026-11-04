package com.moviemethat.arclight.video;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import androidx.annotation.MainThread;
import androidx.annotation.Nullable;
import androidx.media3.common.util.UnstableApi;
import com.moviemethat.arclight.player.EventSink;
import com.moviemethat.arclight.player.PlaybackHub;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Between the plugin (JS) and the full-screen {@link VideoActivity}: holds the request the
 * activity plays, forwards {@code replaceVideoStream} / {@code closeVideo} to it and sends its
 * events (videoProgress, videoSeekRequest, videoNext, videoClosed) to the plugin. One video at a
 * time; a new {@code playVideo} while the screen is open replaces the item in place (up next).
 *
 * <p>Threading: main thread only.
 */
@UnstableApi
public final class VideoController {

    private static VideoController instance;

    public static synchronized VideoController get() {
        if (instance == null) instance = new VideoController();
        return instance;
    }

    @Nullable private EventSink sink;
    @Nullable private VideoRequest pending;
    @Nullable private VideoActivity activity;

    private VideoController() {}

    public void setSink(@Nullable EventSink sink) {
        this.sink = sink;
    }

    public void clearSink(EventSink s) {
        if (sink == s) sink = null;
    }

    /** Opens the video screen for {@code request} (or loads it into the open one). */
    @MainThread
    public void play(Context context, @Nullable Activity from, VideoRequest request) {
        // Movies take over from music / audiobooks: pause the audio player (it stays loaded).
        PlaybackHub.get(context).pause();
        VideoActivity open = activity;
        if (open != null && !open.isFinishing()) {
            open.load(request);
            return;
        }
        pending = request;
        Intent intent = new Intent(context, VideoActivity.class);
        if (from == null) {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
        } else {
            from.startActivity(intent);
            from.overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out);
        }
    }

    /** {@code replaceVideoStream}: false when no video is open. */
    @MainThread
    public boolean replace(VideoRequest.Stream stream) {
        VideoActivity open = activity;
        if (open != null && !open.isFinishing()) {
            open.replaceStream(stream);
            return true;
        }
        VideoRequest p = pending;
        if (p != null) {
            // The screen is still starting: start it on the new stream.
            p.apply(stream);
            return true;
        }
        return false;
    }

    @MainThread
    public void close() {
        pending = null;
        VideoActivity open = activity;
        if (open != null && !open.isFinishing()) open.closeFromJs();
    }

    // ---- activity side ---------------------------------------------------------------------------

    /** The request a starting activity plays (once). */
    @Nullable
    VideoRequest takePending() {
        VideoRequest r = pending;
        pending = null;
        return r;
    }

    void attach(VideoActivity a) {
        activity = a;
    }

    void detach(VideoActivity a) {
        if (activity == a) activity = null;
    }

    // ---- events ----------------------------------------------------------------------------------

    void progress(String itemKey, long positionMs, long durationMs, boolean paused) {
        progress(itemKey, positionMs, durationMs, paused, null, 0);
    }

    /**
     * A progress report with the item's playback health: rebuffers after startup, their total
     * time, open to first frame ({@code stats}), and the bandwidth meter's estimate (kbit/s, 0 =
     * none) that JS keeps as the next session's hint.
     */
    void progress(String itemKey, long positionMs, long durationMs, boolean paused, @Nullable StallTracker stats, long bandwidthKbps) {
        JSONObject o = new JSONObject();
        put(o, "itemKey", itemKey);
        put(o, "positionMs", positionMs);
        put(o, "durationMs", durationMs);
        put(o, "paused", paused);
        putStats(o, stats, bandwidthKbps);
        emit("videoProgress", o, false);
    }

    void seekRequest(String itemKey, long positionMs, @Nullable Integer audioTrack, @Nullable String subtitle) {
        seekRequest(itemKey, positionMs, audioTrack, subtitle, false);
    }

    /**
     * {@code avoidDirect}: direct play kept stalling (StallTracker.fallbackDue); JS asks for a
     * converted (HLS) stream at {@code positionMs} and answers with replaceVideoStream, or not at
     * all when the quality is pinned. The player keeps playing meanwhile.
     */
    void seekRequest(String itemKey, long positionMs, @Nullable Integer audioTrack, @Nullable String subtitle, boolean avoidDirect) {
        seekRequest(itemKey, positionMs, audioTrack, subtitle, avoidDirect, false);
    }

    /**
     * {@code failed}: the current stream failed, showed no picture in time or stayed buffering
     * (StartWatchdog); JS answers with a safe converted stream whatever the quality, or the
     * player closes with an error when no answer comes.
     */
    void seekRequest(String itemKey, long positionMs, @Nullable Integer audioTrack, @Nullable String subtitle, boolean avoidDirect, boolean failed) {
        JSONObject o = new JSONObject();
        put(o, "itemKey", itemKey);
        put(o, "positionMs", positionMs);
        if (audioTrack != null) put(o, "audioTrack", audioTrack);
        put(o, "subtitle", subtitle == null ? JSONObject.NULL : subtitle);
        if (avoidDirect) put(o, "avoidDirect", true);
        if (failed) put(o, "failed", true);
        emit("videoSeekRequest", o, false);
    }

    private static void putStats(JSONObject o, @Nullable StallTracker stats, long bandwidthKbps) {
        if (stats != null) {
            put(o, "stalls", stats.stalls());
            put(o, "stallMs", stats.stallMs());
            if (stats.startupMs() >= 0) put(o, "startupMs", stats.startupMs());
        }
        if (bandwidthKbps > 0) put(o, "bandwidthKbps", bandwidthKbps);
    }

    void next(String nextItemKey, boolean completed) {
        JSONObject o = new JSONObject();
        put(o, "itemKey", nextItemKey);
        put(o, "completed", completed);
        emit("videoNext", o, true);
    }

    void closed(String itemKey, long positionMs, long durationMs, boolean completed, @Nullable String error) {
        closed(itemKey, positionMs, durationMs, completed, error, null, 0);
    }

    void closed(String itemKey, long positionMs, long durationMs, boolean completed, @Nullable String error,
            @Nullable StallTracker stats, long bandwidthKbps) {
        JSONObject o = new JSONObject();
        put(o, "itemKey", itemKey);
        put(o, "positionMs", positionMs);
        put(o, "durationMs", durationMs);
        put(o, "completed", completed);
        if (error != null) put(o, "error", error);
        putStats(o, stats, bandwidthKbps);
        emit("videoClosed", o, true);
    }

    /** The user picked another episode in the episodes panel; JS answers with playVideo. */
    void pickItem(String itemKey, String fromItemKey, long positionMs) {
        JSONObject o = new JSONObject();
        put(o, "itemKey", itemKey);
        put(o, "fromItemKey", fromItemKey);
        put(o, "positionMs", positionMs);
        emit("videoPickItem", o, true);
    }

    /** A track pick in the Audio & Subtitles panel (JS saves it to the per-item prefs). */
    void tracksChanged(String itemKey, @Nullable Integer audioTrack, @Nullable String subtitle) {
        JSONObject o = new JSONObject();
        put(o, "itemKey", itemKey);
        put(o, "audioTrack", audioTrack == null ? JSONObject.NULL : audioTrack);
        put(o, "subtitle", subtitle == null ? JSONObject.NULL : subtitle);
        emit("videoTracksChanged", o, false);
    }

    /** The caption size picked in the Audio & Subtitles panel (JS saves it to the profile). */
    void prefsChanged(String itemKey, String subtitleSize) {
        JSONObject o = new JSONObject();
        put(o, "itemKey", itemKey);
        put(o, "subtitleSize", subtitleSize);
        emit("videoPrefsChanged", o, false);
    }

    /** Whether JS listens for {@code event} (seek requests are pointless without an answer). */
    boolean listens(String event) {
        EventSink s = sink;
        return s != null && s.hasListenersFor(event);
    }

    private void emit(String event, JSONObject data, boolean retain) {
        EventSink s = sink;
        if (s != null) s.emit(event, data, retain);
    }

    private static void put(JSONObject o, String k, Object v) {
        try {
            o.put(k, v);
        } catch (JSONException ignored) {
            // Keys are constants and values plain types.
        }
    }
}

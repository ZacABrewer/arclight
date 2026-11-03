package com.moviemethat.arclight;

import android.Manifest;
import android.app.Activity;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.media3.common.util.UnstableApi;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.moviemethat.arclight.car.BrowseCache;
import com.moviemethat.arclight.car.CarLibrary;
import com.moviemethat.arclight.cast.CastController;
import com.moviemethat.arclight.download.DownloadCenter;
import com.moviemethat.arclight.download.DownloadTaskInfo;
import com.moviemethat.arclight.player.EventSink;
import com.moviemethat.arclight.player.PlaybackHub;
import com.moviemethat.arclight.player.QueueModel;
import com.moviemethat.arclight.player.TrackInfo;
import com.moviemethat.arclight.video.VideoController;
import com.moviemethat.arclight.video.VideoProfile;
import com.moviemethat.arclight.video.VideoRequest;
import java.util.List;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Native side of the "ArclightPlayer" Capacitor plugin. The contract (methods, options, results
 * and events) is apps/player/src/native/definitions.ts; method names here must stay in sync.
 *
 * <ul>
 *   <li>Audio: {@link PlaybackHub} (Media3 ExoPlayer) inside {@code PlaybackService}
 *       (MediaLibraryService: notification, lock screen, headsets, Android Auto).</li>
 *   <li>Downloads: {@link DownloadCenter} (WorkManager, HTTP Range resume).</li>
 *   <li>Car: {@link CarLibrary} (browse requests to JS, cached tree otherwise).</li>
 *   <li>Cast: {@link CastController} (Google Cast, optional at runtime).</li>
 *   <li>Video: {@link VideoController} (full-screen Media3 player activity, movies / TV).</li>
 * </ul>
 *
 * This instance lives as long as the WebView; the player, downloads and car keep running
 * without it and events resume when a new instance attaches.
 */
@UnstableApi
@CapacitorPlugin(
        name = "ArclightPlayer",
        permissions = {@Permission(alias = "notifications", strings = {Manifest.permission.POST_NOTIFICATIONS})})
public class ArclightPlayerPlugin extends Plugin implements EventSink {

    private static final String TAG = "ArclightPlayerPlugin";
    private static final String VERSION = "1.0.0 (media3)";

    private final Handler main = new Handler(Looper.getMainLooper());
    private PlaybackHub hub;

    @Override
    public void load() {
        hub = PlaybackHub.get(getContext());
        hub.setSink(this);
        VideoController.get().setSink(this);
        main.post(() -> CastController.init(getContext()));
    }

    @Override
    protected void handleOnDestroy() {
        if (hub != null) hub.clearSink(this);
        VideoController.get().clearSink(this);
        super.handleOnDestroy();
    }

    // ---- EventSink ---------------------------------------------------------------------------

    @Override
    public void emit(String event, JSONObject data, boolean retain) {
        try {
            notifyListeners(event, JSObject.fromJSONObject(data), retain);
        } catch (JSONException e) {
            Log.w(TAG, "Could not send " + event, e);
        }
    }

    @Override
    public boolean hasListenersFor(String event) {
        return hasListeners(event);
    }

    // ---- helpers -----------------------------------------------------------------------------

    private interface MainTask {
        void run() throws Exception;
    }

    /** Runs on the player's thread and resolves (or rejects with a contract error code). */
    private void onMain(PluginCall call, MainTask task) {
        main.post(() -> {
            try {
                task.run();
                if (!call.isReleased()) call.resolve();
            } catch (Exception e) {
                reject(call, e);
            }
        });
    }

    private static void reject(PluginCall call, Exception e) {
        String code = e instanceof IllegalArgumentException || e instanceof IndexOutOfBoundsException || e instanceof JSONException
                ? "invalid" : "unknown";
        String msg = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
        call.reject(msg, code, e);
    }

    private static long optLong(PluginCall call, String key, long fallback) {
        Double d = call.getDouble(key);
        return d == null || d.isNaN() ? fallback : Math.round(d);
    }

    private static boolean castSupported(android.content.Context ctx) {
        try {
            return GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(ctx) == ConnectionResult.SUCCESS;
        } catch (RuntimeException | LinkageError e) {
            return false;
        }
    }

    // ---- info ----------------------------------------------------------------------------------

    @PluginMethod
    public void getInfo(PluginCall call) {
        JSObject features = new JSObject();
        features.put("audio", true);
        features.put("downloads", true);
        features.put("car", true);
        features.put("cast", castSupported(getContext()));
        features.put("sleepTimer", true);
        features.put("video", true);
        JSObject o = new JSObject();
        o.put("platform", "android");
        o.put("version", VERSION);
        o.put("features", features);
        call.resolve(o);
    }

    // ---- app ---------------------------------------------------------------------------------

    @PluginMethod
    public void consumeLaunchInfo(PluginCall call) {
        boolean reduced = Build.VERSION.SDK_INT >= 26 && !android.animation.ValueAnimator.areAnimatorsEnabled();
        LaunchInfo info = LaunchInfo.consume(reduced);
        JSObject o = new JSObject();
        o.put("coldStart", info.coldStart);
        o.put("source", info.source);
        o.put("systemReducedMotion", info.systemReducedMotion);
        call.resolve(o);
    }

    // ---- video (movies & TV) ----------------------------------------------------------------------

    @PluginMethod
    public void getDeviceInfo(PluginCall call) {
        try {
            call.resolve(JSObject.fromJSONObject(VideoProfile.deviceInfo(getContext())));
        } catch (Exception e) {
            reject(call, e);
        }
    }

    @PluginMethod
    public void playVideo(PluginCall call) {
        final VideoRequest request;
        try {
            request = VideoRequest.parse(call.getData());
        } catch (IllegalArgumentException e) {
            reject(call, e);
            return;
        }
        onMain(call, () -> {
            Activity activity = getActivity();
            VideoController.get().play(getContext(), activity, request);
        });
    }

    @PluginMethod
    public void replaceVideoStream(PluginCall call) {
        final VideoRequest.Stream stream;
        try {
            stream = VideoRequest.Stream.parse(call.getData());
        } catch (IllegalArgumentException e) {
            reject(call, e);
            return;
        }
        onMain(call, () -> {
            if (!VideoController.get().replace(stream)) throw new IllegalStateException("No video is playing");
        });
    }

    @PluginMethod
    public void closeVideo(PluginCall call) {
        onMain(call, () -> VideoController.get().close());
    }

    // ---- audio ---------------------------------------------------------------------------------

    @PluginMethod
    public void load(PluginCall call) {
        final List<TrackInfo> tracks;
        try {
            JSArray arr = call.getArray("tracks");
            if (arr == null) throw new IllegalArgumentException("tracks is required");
            tracks = QueueModel.parseTracks(arr);
        } catch (IllegalArgumentException e) {
            reject(call, e);
            return;
        }
        final int startIndex = call.getInt("startIndex", 0);
        final long startMs = optLong(call, "startMs", 0);
        final boolean autoplay = call.getBoolean("autoplay", true);
        final Double rate = call.getDouble("rate");
        onMain(call, () -> hub.load(tracks, startIndex, startMs, autoplay, rate == null ? null : rate.floatValue()));
    }

    @PluginMethod
    public void setUpcoming(PluginCall call) {
        final List<TrackInfo> tracks;
        try {
            JSArray arr = call.getArray("tracks");
            tracks = QueueModel.parseTracks(arr);
        } catch (IllegalArgumentException e) {
            reject(call, e);
            return;
        }
        onMain(call, () -> hub.setUpcoming(tracks));
    }

    @PluginMethod
    public void play(PluginCall call) {
        onMain(call, () -> hub.play());
    }

    @PluginMethod
    public void pause(PluginCall call) {
        onMain(call, () -> hub.pause());
    }

    @PluginMethod
    public void seek(PluginCall call) {
        final long pos = optLong(call, "positionMs", -1);
        if (pos < 0) {
            call.reject("positionMs is required", "invalid");
            return;
        }
        onMain(call, () -> hub.seek(pos));
    }

    @PluginMethod
    public void skipTo(PluginCall call) {
        Integer index = call.getInt("index");
        if (index == null) {
            call.reject("index is required", "invalid");
            return;
        }
        final long pos = optLong(call, "positionMs", 0);
        onMain(call, () -> hub.skipTo(index, pos));
    }

    @PluginMethod
    public void setRate(PluginCall call) {
        Double rate = call.getDouble("rate");
        if (rate == null) {
            call.reject("rate is required", "invalid");
            return;
        }
        onMain(call, () -> hub.setRate(rate.floatValue()));
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        Double volume = call.getDouble("volume");
        if (volume == null) {
            call.reject("volume is required", "invalid");
            return;
        }
        onMain(call, () -> hub.setVolume(volume.floatValue()));
    }

    @PluginMethod
    public void setRepeat(PluginCall call) {
        final String mode = call.getString("mode", "off");
        onMain(call, () -> hub.setRepeat(mode));
    }

    @PluginMethod
    public void setShuffle(PluginCall call) {
        // JS owns the shuffle order and sends tracks already shuffled.
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        onMain(call, () -> hub.stop());
    }

    @PluginMethod
    public void getState(PluginCall call) {
        main.post(() -> {
            try {
                call.resolve(JSObject.fromJSONObject(hub.snapshot()));
            } catch (Exception e) {
                reject(call, e);
            }
        });
    }

    @PluginMethod
    public void configureRemote(PluginCall call) {
        final String mode = call.getString("mode", "music");
        final long back = optLong(call, "skipBackMs", 0);
        final long forward = optLong(call, "skipForwardMs", 0);
        onMain(call, () -> hub.configureRemote(mode, back, forward));
    }

    @PluginMethod
    public void setNowPlayingExtra(PluginCall call) {
        final String chapter = call.getData().isNull("chapterTitle") ? null : call.getString("chapterTitle");
        onMain(call, () -> hub.setNowPlayingExtra(chapter));
    }

    @PluginMethod
    public void setSleepTimer(PluginCall call) {
        final JSONObject timer = call.getData().optJSONObject("timer");
        onMain(call, () -> hub.setSleepTimer(timer));
    }

    // ---- downloads -----------------------------------------------------------------------------

    @PluginMethod
    public void enqueueDownload(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && getPermissionState("notifications") == PermissionState.PROMPT) {
            // First download: ask once for the progress notification, then enqueue either way.
            requestPermissionForAlias("notifications", call, "afterNotificationPermission");
            return;
        }
        doEnqueue(call);
    }

    @PermissionCallback
    private void afterNotificationPermission(PluginCall call) {
        doEnqueue(call);
    }

    private void doEnqueue(PluginCall call) {
        try {
            DownloadTaskInfo t = DownloadCenter.get(getContext()).enqueue(call.getData());
            JSObject o = new JSObject();
            o.put("task", JSObject.fromJSONObject(t.toContract()));
            call.resolve(o);
        } catch (Exception e) {
            reject(call, e);
        }
    }

    @PluginMethod
    public void pauseDownload(PluginCall call) {
        try {
            DownloadCenter.get(getContext()).pause(requireId(call));
            call.resolve();
        } catch (Exception e) {
            reject(call, e);
        }
    }

    @PluginMethod
    public void resumeDownload(PluginCall call) {
        try {
            DownloadCenter.get(getContext()).resume(requireId(call));
            call.resolve();
        } catch (Exception e) {
            reject(call, e);
        }
    }

    @PluginMethod
    public void cancelDownload(PluginCall call) {
        try {
            DownloadCenter.get(getContext()).cancel(requireId(call));
            call.resolve();
        } catch (Exception e) {
            reject(call, e);
        }
    }

    @PluginMethod
    public void listDownloads(PluginCall call) {
        try {
            JSArray tasks = new JSArray();
            for (DownloadTaskInfo t : DownloadCenter.get(getContext()).list()) tasks.put(t.toContract());
            JSObject o = new JSObject();
            o.put("tasks", tasks);
            call.resolve(o);
        } catch (Exception e) {
            reject(call, e);
        }
    }

    @PluginMethod
    public void deleteDownload(PluginCall call) {
        try {
            String dest = call.getString("destName");
            if (dest == null || dest.isEmpty()) throw new IllegalArgumentException("destName is required");
            DownloadCenter.get(getContext()).delete(dest);
            call.resolve();
        } catch (Exception e) {
            reject(call, e);
        }
    }

    @PluginMethod
    public void getStorageInfo(PluginCall call) {
        DownloadCenter c = DownloadCenter.get(getContext());
        JSObject o = new JSObject();
        o.put("usedBytes", c.usedBytes());
        o.put("freeBytes", c.freeBytes());
        call.resolve(o);
    }

    @PluginMethod
    public void setDownloadPolicy(PluginCall call) {
        try {
            DownloadCenter.get(getContext()).setWifiOnly(call.getBoolean("wifiOnly", false));
            call.resolve();
        } catch (Exception e) {
            reject(call, e);
        }
    }

    private static String requireId(PluginCall call) {
        String id = call.getString("id");
        if (id == null || id.isEmpty()) throw new IllegalArgumentException("id is required");
        return id;
    }

    // ---- car (Android Auto) ------------------------------------------------------------------

    @PluginMethod
    public void setBrowseTree(PluginCall call) {
        try {
            CarLibrary.get(getContext()).broker().setTree(call.getData());
            call.resolve();
        } catch (Exception e) {
            reject(call, e);
        }
    }

    @PluginMethod
    public void answerBrowse(PluginCall call) {
        String requestId = call.getString("requestId");
        if (requestId == null) {
            call.reject("requestId is required", "invalid");
            return;
        }
        JSArray items = call.getArray("items");
        CarLibrary.get(getContext()).broker().answer(requestId, BrowseCache.parseList(items));
        // A late answer (after the timeout) is not an error for JS.
        call.resolve();
    }

    // ---- cast ------------------------------------------------------------------------------------

    @PluginMethod
    public void getCastState(PluginCall call) {
        main.post(() -> {
            try {
                call.resolve(JSObject.fromJSONObject(CastController.init(getContext()).state()));
            } catch (Exception e) {
                reject(call, e);
            }
        });
    }

    @PluginMethod
    public void showRoutePicker(PluginCall call) {
        main.post(() -> {
            Activity activity = getActivity();
            CastController cast = CastController.init(getContext());
            if (activity == null || !cast.available()) {
                call.unavailable("Google Cast is not available on this device.");
                return;
            }
            try {
                cast.showRoutePicker(activity);
                call.resolve();
            } catch (Exception e) {
                reject(call, e);
            }
        });
    }

    @PluginMethod
    public void endCastSession(PluginCall call) {
        main.post(() -> {
            CastController.init(getContext()).endSession();
            call.resolve();
        });
    }
}

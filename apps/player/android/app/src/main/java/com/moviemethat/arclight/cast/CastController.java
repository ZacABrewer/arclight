package com.moviemethat.arclight.cast;

import android.app.Activity;
import android.content.Context;
import android.net.Uri;
import androidx.annotation.MainThread;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;
import androidx.media3.common.util.UnstableApi;
import androidx.mediarouter.app.MediaRouteChooserDialog;
import androidx.mediarouter.app.MediaRouteControllerDialog;
import androidx.mediarouter.media.MediaRouteSelector;
import com.google.android.gms.cast.MediaInfo;
import com.google.android.gms.cast.MediaLoadRequestData;
import com.google.android.gms.cast.MediaMetadata;
import com.google.android.gms.cast.MediaQueueData;
import com.google.android.gms.cast.MediaQueueItem;
import com.google.android.gms.cast.MediaSeekOptions;
import com.google.android.gms.cast.MediaStatus;
import com.google.android.gms.cast.framework.CastContext;
import com.google.android.gms.cast.framework.CastSession;
import com.google.android.gms.cast.framework.CastState;
import com.google.android.gms.cast.framework.CastStateListener;
import com.google.android.gms.cast.framework.SessionManagerListener;
import com.google.android.gms.cast.framework.media.RemoteMediaClient;
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.android.gms.common.images.WebImage;
import com.moviemethat.arclight.SafeLog;
import com.moviemethat.arclight.player.PlaybackHub;
import com.moviemethat.arclight.player.QueueModel;
import com.moviemethat.arclight.player.TrackInfo;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executor;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Google Cast for the player (Default Media Receiver). Optional at runtime: without Google Play
 * services (or when the Cast framework fails to start) everything reports "unavailable" and the
 * app plays locally. When a session starts, the current queue (signed http links, metadata,
 * artwork) goes to the receiver and local playback pauses; when it ends, local playback picks up
 * where the receiver was.
 */
@UnstableApi
public final class CastController implements PlaybackHub.CastBridge {

    private static final String TAG = "ArclightCast";
    private static final long PROGRESS_INTERVAL_MS = 1000;

    @Nullable private static CastController instance;

    /** Starts Cast once (main thread). Safe to call when Play services are missing. */
    @MainThread
    public static CastController init(Context context) {
        if (instance == null) {
            instance = new CastController(context.getApplicationContext());
            instance.start();
        }
        return instance;
    }

    private final Context app;
    private final PlaybackHub hub;
    @Nullable private CastContext castContext;
    @Nullable private CastSession session;
    @Nullable private RemoteMediaClient client;
    private boolean failed;

    // Last known receiver state (to hand back to local playback when the session ends).
    @Nullable private String lastTrackId;
    private long lastPositionMs;
    private boolean lastPlaying;
    @Nullable private String lastStatus;
    private boolean endedSent;

    private CastController(Context app) {
        this.app = app;
        this.hub = PlaybackHub.get(app);
    }

    private void start() {
        try {
            int gms = GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(app);
            if (gms != ConnectionResult.SUCCESS) {
                failed = true;
                return;
            }
            Executor main = ContextCompat.getMainExecutor(app);
            CastContext.getSharedInstance(app, main)
                    .addOnSuccessListener(main, this::attach)
                    .addOnFailureListener(main, e -> {
                        SafeLog.i(TAG, "Cast is not available: " + e.getMessage());
                        failed = true;
                        emitState();
                    });
        } catch (RuntimeException | LinkageError e) {
            SafeLog.i(TAG, "Cast is not available: " + e.getMessage());
            failed = true;
        }
    }

    private void attach(CastContext cc) {
        castContext = cc;
        hub.setCast(this);
        cc.addCastStateListener(castStateListener);
        cc.getSessionManager().addSessionManagerListener(sessionListener, CastSession.class);
        CastSession current = cc.getSessionManager().getCurrentCastSession();
        if (current != null && current.isConnected()) bind(current, false);
        emitState();
    }

    public boolean available() {
        return castContext != null && !failed;
    }

    // ---- contract: getCastState / showRoutePicker / endCastSession ---------------------------

    public JSONObject state() {
        JSONObject o = new JSONObject();
        try {
            String status = "unavailable";
            String device = null;
            CastContext cc = castContext;
            if (cc != null && !failed) {
                switch (cc.getCastState()) {
                    case CastState.CONNECTED:
                        status = "connected";
                        break;
                    case CastState.CONNECTING:
                        status = "connecting";
                        break;
                    case CastState.NOT_CONNECTED:
                        status = "available";
                        break;
                    case CastState.NO_DEVICES_AVAILABLE:
                    default:
                        status = "unavailable";
                        break;
                }
                CastSession s = cc.getSessionManager().getCurrentCastSession();
                if (s != null && s.getCastDevice() != null && ("connected".equals(status) || "connecting".equals(status))) {
                    device = s.getCastDevice().getFriendlyName();
                }
            }
            o.put("status", status);
            o.put("kind", "unavailable".equals(status) ? JSONObject.NULL : "chromecast");
            if (device != null) o.put("deviceName", device);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
        return o;
    }

    /** The MediaRouter device dialog (chooser when idle, controller when casting). */
    @MainThread
    public boolean showRoutePicker(Activity activity) {
        CastContext cc = castContext;
        if (cc == null || failed) return false;
        CastSession s = cc.getSessionManager().getCurrentCastSession();
        if (s != null && (s.isConnected() || s.isConnecting())) {
            new MediaRouteControllerDialog(activity).show();
        } else {
            MediaRouteChooserDialog d = new MediaRouteChooserDialog(activity);
            MediaRouteSelector selector = cc.getMergedSelector();
            if (selector != null) d.setRouteSelector(selector);
            d.show();
        }
        return true;
    }

    @MainThread
    public void endSession() {
        CastContext cc = castContext;
        if (cc != null) cc.getSessionManager().endCurrentSession(true);
    }

    // ---- CastBridge (PlaybackHub routes commands here while casting) ---------------------------

    @Override
    public boolean isCasting() {
        CastSession s = session;
        return s != null && s.isConnected() && client != null;
    }

    @Override
    public void load(List<TrackInfo> tracks, int index, long positionMs, boolean autoplay, float rate, String repeat) {
        RemoteMediaClient c = client;
        if (c == null) return;
        CastQueueMapper.Plan plan = CastQueueMapper.plan(tracks, index);
        if (plan.startIndex < 0) {
            SafeLog.w(TAG, "Nothing in the queue can be cast (downloaded files only)");
            return;
        }
        List<MediaQueueItem> items = new ArrayList<>(plan.tracks.size());
        for (TrackInfo t : plan.tracks) items.add(queueItem(t));
        MediaQueueData queue = new MediaQueueData.Builder()
                .setItems(items)
                .setStartIndex(plan.startIndex)
                .setRepeatMode(castRepeat(repeat))
                .build();
        MediaLoadRequestData req = new MediaLoadRequestData.Builder()
                .setQueueData(queue)
                .setAutoplay(autoplay)
                .setCurrentTime(plan.startIsExact ? Math.max(0, positionMs) : 0)
                .setPlaybackRate(rate)
                .build();
        endedSent = false;
        c.load(req);
    }

    private static MediaQueueItem queueItem(TrackInfo t) {
        MediaMetadata md = new MediaMetadata(MediaMetadata.MEDIA_TYPE_MUSIC_TRACK);
        md.putString(MediaMetadata.KEY_TITLE, t.title);
        if (t.artist != null) md.putString(MediaMetadata.KEY_ARTIST, t.artist);
        if (t.album != null) md.putString(MediaMetadata.KEY_ALBUM_TITLE, t.album);
        String art = t.artworkUrl;
        if (art != null && (art.startsWith("http://") || art.startsWith("https://"))) {
            // The receiver fetches artwork itself, without headers: covers behind a Bearer
            // header only show when JS passes a signed artwork link.
            md.addImage(new WebImage(Uri.parse(art)));
        }
        MediaInfo.Builder info = new MediaInfo.Builder(t.id)
                .setContentUrl(t.url)
                .setStreamType(MediaInfo.STREAM_TYPE_BUFFERED)
                .setContentType(t.mimeType != null ? t.mimeType : "audio/mpeg")
                .setMetadata(md);
        if (t.durationMs > 0) info.setStreamDuration(t.durationMs);
        JSONObject custom = new JSONObject();
        try {
            custom.put("trackId", t.id);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
        return new MediaQueueItem.Builder(info.build()).setAutoplay(true).setCustomData(custom).build();
    }

    private static int castRepeat(String repeat) {
        if ("one".equals(repeat)) return MediaStatus.REPEAT_MODE_REPEAT_SINGLE;
        if ("all".equals(repeat)) return MediaStatus.REPEAT_MODE_REPEAT_ALL;
        return MediaStatus.REPEAT_MODE_REPEAT_OFF;
    }

    @Override
    public void play() {
        if (client != null) client.play();
    }

    @Override
    public void pause() {
        if (client != null) client.pause();
    }

    @Override
    public void seek(long positionMs) {
        if (client != null) client.seek(new MediaSeekOptions.Builder().setPosition(positionMs).build());
    }

    @Override
    public void setRate(float rate) {
        if (client != null) client.setPlaybackRate(rate);
    }

    @Override
    public void setRepeat(String repeat) {
        if (client != null) client.queueSetRepeatMode(castRepeat(repeat), null);
    }

    @Override
    public void stop() {
        if (client != null) client.stop();
    }

    @Nullable
    @Override
    public JSONObject snapshot(QueueModel queue) {
        RemoteMediaClient c = client;
        MediaStatus st = c == null ? null : c.getMediaStatus();
        if (c == null || st == null) return null;
        JSONObject o = new JSONObject();
        try {
            String trackId = currentTrackId(c);
            int index = queue.indexOfId(trackId);
            TrackInfo t = queue.get(index);
            o.put("status", statusOf(st));
            o.put("index", index);
            o.put("trackId", trackId == null ? JSONObject.NULL : trackId);
            o.put("positionMs", Math.max(0, c.getApproximateStreamPosition()));
            long dur = c.getStreamDuration();
            o.put("durationMs", dur > 0 ? dur : t == null ? 0 : t.durationMs);
            o.put("bufferedMs", Math.max(0, c.getApproximateStreamPosition()));
            o.put("rate", st.getPlaybackRate());
            o.put("volume", 1.0);
            int rm = st.getQueueRepeatMode();
            o.put("repeat", rm == MediaStatus.REPEAT_MODE_REPEAT_SINGLE ? "one"
                    : rm == MediaStatus.REPEAT_MODE_REPEAT_ALL || rm == MediaStatus.REPEAT_MODE_REPEAT_ALL_AND_SHUFFLE ? "all" : "off");
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
        return o;
    }

    @Nullable
    private static String currentTrackId(RemoteMediaClient c) {
        MediaQueueItem item = c.getCurrentItem();
        JSONObject custom = item == null ? null : item.getCustomData();
        if (custom != null && custom.has("trackId")) return custom.optString("trackId");
        MediaInfo info = c.getMediaInfo();
        return info == null ? null : info.getContentId();
    }

    private static String statusOf(MediaStatus st) {
        int ps = st.getPlayerState();
        int idle = st.getIdleReason();
        return CastQueueMapper.statusName(
                ps == MediaStatus.PLAYER_STATE_PLAYING,
                ps == MediaStatus.PLAYER_STATE_PAUSED,
                ps == MediaStatus.PLAYER_STATE_BUFFERING,
                ps == MediaStatus.PLAYER_STATE_LOADING,
                ps == MediaStatus.PLAYER_STATE_IDLE && idle == MediaStatus.IDLE_REASON_FINISHED,
                ps == MediaStatus.PLAYER_STATE_IDLE && idle == MediaStatus.IDLE_REASON_ERROR);
    }

    // ---- session lifecycle ---------------------------------------------------------------------

    private void bind(CastSession s, boolean handOver) {
        unbindClient();
        session = s;
        client = s.getRemoteMediaClient();
        lastStatus = null;
        lastTrackId = null;
        lastEmittedTrack = null;
        if (client != null) {
            client.registerCallback(clientCallback);
            client.addProgressListener(progressListener, PROGRESS_INTERVAL_MS);
        }
        if (handOver) hub.onCastStarted();
    }

    private void unbindClient() {
        if (client != null) {
            client.unregisterCallback(clientCallback);
            client.removeProgressListener(progressListener);
        }
        client = null;
    }

    private void remember() {
        RemoteMediaClient c = client;
        if (c == null) return;
        MediaStatus st = c.getMediaStatus();
        String id = currentTrackId(c);
        if (id != null) lastTrackId = id;
        lastPositionMs = Math.max(0, c.getApproximateStreamPosition());
        lastPlaying = st != null && (st.getPlayerState() == MediaStatus.PLAYER_STATE_PLAYING
                || st.getPlayerState() == MediaStatus.PLAYER_STATE_BUFFERING);
    }

    private void handBack() {
        String trackId = lastTrackId;
        long pos = lastPositionMs;
        boolean playing = lastPlaying;
        unbindClient();
        session = null;
        if (trackId != null) hub.onCastEnded(trackId, pos, playing);
    }

    private final SessionManagerListener<CastSession> sessionListener = new SessionManagerListener<CastSession>() {
        @Override
        public void onSessionStarting(@NonNull CastSession s) {}

        @Override
        public void onSessionStarted(@NonNull CastSession s, @NonNull String sessionId) {
            bind(s, true);
            emitState();
        }

        @Override
        public void onSessionStartFailed(@NonNull CastSession s, int error) {
            emitState();
        }

        @Override
        public void onSessionEnding(@NonNull CastSession s) {
            remember();
        }

        @Override
        public void onSessionEnded(@NonNull CastSession s, int error) {
            handBack();
            emitState();
        }

        @Override
        public void onSessionResuming(@NonNull CastSession s, @NonNull String sessionId) {}

        @Override
        public void onSessionResumed(@NonNull CastSession s, boolean wasSuspended) {
            bind(s, false);
            emitState();
        }

        @Override
        public void onSessionResumeFailed(@NonNull CastSession s, int error) {
            emitState();
        }

        @Override
        public void onSessionSuspended(@NonNull CastSession s, int reason) {
            remember();
            emitState();
        }
    };

    private final CastStateListener castStateListener = state -> emitState();

    private void emitState() {
        hub.emit("castState", state(), false);
    }

    private final RemoteMediaClient.Callback clientCallback = new RemoteMediaClient.Callback() {
        @Override
        public void onStatusUpdated() {
            RemoteMediaClient c = client;
            MediaStatus st = c == null ? null : c.getMediaStatus();
            if (c == null || st == null) return;
            remember();
            String trackId = currentTrackId(c);
            String status = statusOf(st);
            JSONObject snap = snapshot(queueForEvents());
            int index = snap == null ? -1 : snap.optInt("index", -1);
            if (trackId != null && index >= 0 && !trackId.equals(lastEmittedTrack)) {
                if (lastEmittedTrack != null) hub.emitTrackChanged(index, "auto");
                lastEmittedTrack = trackId;
            }
            if (!status.equals(lastStatus)) {
                lastStatus = status;
                JSONObject o = new JSONObject();
                try {
                    o.put("status", status);
                    o.put("trackId", trackId == null ? JSONObject.NULL : trackId);
                    o.put("index", index);
                } catch (JSONException e) {
                    throw new IllegalStateException(e);
                }
                hub.emit("state", o, false);
                if ("ended".equals(status) && !endedSent) {
                    endedSent = true;
                    JSONObject q = new JSONObject();
                    try {
                        q.put("trackId", trackId == null ? JSONObject.NULL : trackId);
                    } catch (JSONException e) {
                        throw new IllegalStateException(e);
                    }
                    hub.emit("queueEnded", q, true);
                }
            }
        }
    };

    @Nullable private String lastEmittedTrack;

    private QueueModel queueForEvents() {
        return hub.queue();
    }

    private final RemoteMediaClient.ProgressListener progressListener = this::onProgress;

    private void onProgress(long progressMs, long durationMs) {
        RemoteMediaClient c = client;
        if (c == null) return;
        String trackId = currentTrackId(c);
        int index = hub.queue().indexOfId(trackId);
        if (trackId == null || index < 0) return;
        JSONObject o = new JSONObject();
        try {
            o.put("trackId", trackId);
            o.put("index", index);
            o.put("positionMs", Math.max(0, progressMs));
            o.put("durationMs", Math.max(0, durationMs));
            o.put("bufferedMs", Math.max(0, progressMs));
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
        hub.emit("position", o, false);
    }
}

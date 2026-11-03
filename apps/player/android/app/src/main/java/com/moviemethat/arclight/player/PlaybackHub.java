package com.moviemethat.arclight.player;

import android.content.ComponentName;
import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import androidx.annotation.MainThread;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.datasource.ResolvingDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.session.CommandButton;
import androidx.media3.session.MediaController;
import androidx.media3.session.MediaLibraryService.MediaLibrarySession;
import androidx.media3.session.MediaSession;
import androidx.media3.session.SessionToken;
import com.google.common.collect.ImmutableList;
import com.google.common.util.concurrent.ListenableFuture;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The native player: one ExoPlayer for the whole process, the queue JS handed it, and every
 * event the plugin contract defines. It outlives the activity (the {@link PlaybackService}
 * wraps the same player in a MediaLibrarySession and keeps the process in the foreground while
 * playing); the Capacitor plugin attaches as the {@link EventSink} while the WebView exists.
 *
 * <p>Threading: every public method must be called on the main thread (the player's
 * application looper). The plugin posts there; the session and the service already run there.
 */
@UnstableApi
public final class PlaybackHub {

    private static final String TAG = "ArclightPlayback";
    private static final String PLACEHOLDER_ID = "arclight:pending-js";
    private static final long POSITION_INTERVAL_MS = 1000;
    private static final long REMOTE_FALLBACK_MS = 2000;
    private static final long STATE_SAVE_INTERVAL_MS = 15000;
    private static final String USER_AGENT = "ArclightPlayer (android)";

    @SuppressWarnings("StaticFieldLeak") // application context only
    private static PlaybackHub instance;

    public static synchronized PlaybackHub get(Context context) {
        if (instance == null) instance = new PlaybackHub(context.getApplicationContext());
        return instance;
    }

    /** Interface of the cast controller (kept small so playback never depends on Play services). */
    public interface CastBridge {
        boolean isCasting();
        void load(List<TrackInfo> tracks, int index, long positionMs, boolean autoplay, float rate, String repeat);
        void play();
        void pause();
        void seek(long positionMs);
        void setRate(float rate);
        void setRepeat(String repeat);
        void stop();
        /** The cast snapshot (same shape as getState), or null when it has no status yet. */
        @Nullable JSONObject snapshot(QueueModel queue);
    }

    private final Context app;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final QueueModel queue = new QueueModel();
    private final HeaderRegistry headers = new HeaderRegistry();
    private final File stateFile;

    @Nullable private ExoPlayer player;
    @Nullable private SessionPlayer sessionPlayer;
    @Nullable private MediaLibrarySession session;
    @Nullable private volatile EventSink sink;
    @Nullable private volatile CastBridge cast;
    @Nullable private ListenableFuture<MediaController> serviceConnection;
    private DataSource.Factory dataSourceFactory;

    // Remote (lock screen / notification) configuration.
    private String remoteMode = "music";
    private long skipBackMs = 15000;
    private long skipForwardMs = 30000;
    @Nullable private String chapterTitle;

    // Event bookkeeping.
    @Nullable private String lastTrackId;
    @Nullable private String pendingReason;
    private boolean everReady;
    private boolean endedSent;
    @Nullable private JSONObject lastError;
    private String lastStatus = "idle";
    private int lastStatusIndex = -2;
    @Nullable private String lastStatusTrack;
    private float userVolume = 1f;
    private int jsGeneration;
    private long lastStateSave;
    private long suppressRemotePlayUntil;

    // Sleep timer.
    @Nullable private String sleepTrackId;
    @Nullable private Runnable sleepRunnable;

    private final Runnable positionTick = new Runnable() {
        @Override
        public void run() {
            ExoPlayer p = player;
            if (p == null || !p.isPlaying()) return;
            emitPosition();
            long now = SystemClock.elapsedRealtime();
            if (now - lastStateSave > STATE_SAVE_INTERVAL_MS) saveState();
            main.postDelayed(this, POSITION_INTERVAL_MS);
        }
    };

    private PlaybackHub(Context app) {
        this.app = app;
        this.stateFile = new File(new File(app.getFilesDir(), "arclight-player"), "last-queue.json");
    }

    // =====================================================================================
    // Wiring
    // =====================================================================================

    public Context context() {
        return app;
    }

    public HeaderRegistry headers() {
        return headers;
    }

    /** The native queue (read-only use outside this class). */
    public QueueModel queue() {
        return queue;
    }

    public void setSink(@Nullable EventSink sink) {
        this.sink = sink;
    }

    public void clearSink(EventSink s) {
        if (sink == s) sink = null;
    }

    @Nullable
    public EventSink sink() {
        return sink;
    }

    public void setCast(@Nullable CastBridge cast) {
        this.cast = cast;
    }

    public boolean jsListens(String event) {
        EventSink s = sink;
        return s != null && s.hasListenersFor(event);
    }

    public void emit(String event, JSONObject data, boolean retain) {
        EventSink s = sink;
        if (s != null) s.emit(event, data, retain);
    }

    /** One data source for audio and artwork: http(s) with per-URL headers, plus files. */
    public synchronized DataSource.Factory dataSourceFactory() {
        if (dataSourceFactory == null) {
            HttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
                    .setUserAgent(USER_AGENT)
                    .setAllowCrossProtocolRedirects(true)
                    .setConnectTimeoutMs(15000)
                    .setReadTimeoutMs(30000);
            ResolvingDataSource.Factory withHeaders = new ResolvingDataSource.Factory(http, dataSpec -> {
                Map<String, String> h = headers.get(dataSpec.uri.toString());
                return h.isEmpty() ? dataSpec : dataSpec.withAdditionalHeaders(h);
            });
            dataSourceFactory = new DefaultDataSource.Factory(app, withHeaders);
        }
        return dataSourceFactory;
    }

    /** The ExoPlayer, created on first use. */
    @MainThread
    public ExoPlayer player() {
        if (player == null) {
            AudioAttributes attrs = new AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                    .build();
            ExoPlayer p = new ExoPlayer.Builder(app)
                    .setMediaSourceFactory(new DefaultMediaSourceFactory(dataSourceFactory()))
                    .setAudioAttributes(attrs, /* handleAudioFocus= */ true)
                    .setHandleAudioBecomingNoisy(true)
                    .setWakeMode(C.WAKE_MODE_NETWORK)
                    .setSeekBackIncrementMs(skipBackMs)
                    .setSeekForwardIncrementMs(skipForwardMs)
                    .build();
            p.addListener(listener);
            p.setVolume(userVolume);
            player = p;
            sessionPlayer = new SessionPlayer(p, this);
        }
        return player;
    }

    /** The player the session wraps (remote commands are intercepted there). */
    @MainThread
    public Player sessionPlayer() {
        player();
        return sessionPlayer;
    }

    @MainThread
    public void attachSession(MediaLibrarySession s) {
        session = s;
        applyRemoteToSession();
    }

    @MainThread
    public void detachSession(MediaLibrarySession s) {
        if (session == s) session = null;
    }

    /** Called by the service when it is destroyed: release the player (nothing is playing). */
    @MainThread
    public void releasePlayer() {
        main.removeCallbacks(positionTick);
        cancelSleep();
        if (player != null) {
            saveState();
            player.removeListener(listener);
            player.release();
            player = null;
            sessionPlayer = null;
        }
        releaseServiceConnection();
        // The queue went with the player; JS sees 'idle' and reloads when the user plays again.
        queue.clear();
        lastTrackId = null;
        lastError = null;
        refreshStatus(true);
    }

    /**
     * Binds the {@link PlaybackService} (creating the MediaLibrarySession) so the notification
     * appears as soon as playback starts. Media3 then keeps the service in the foreground while
     * playing, independently of this binding.
     */
    @MainThread
    public void ensureService() {
        if (serviceConnection != null) return;
        try {
            SessionToken token = new SessionToken(app, new ComponentName(app, PlaybackService.class));
            serviceConnection = new MediaController.Builder(app, token).buildAsync();
        } catch (RuntimeException e) {
            Log.w(TAG, "Could not bind the playback service", e);
            serviceConnection = null;
        }
    }

    private void releaseServiceConnection() {
        ListenableFuture<MediaController> f = serviceConnection;
        serviceConnection = null;
        if (f != null) MediaController.releaseFuture(f);
    }

    // =====================================================================================
    // Commands from JS (the plugin)
    // =====================================================================================

    public boolean isCasting() {
        CastBridge c = cast;
        return c != null && c.isCasting();
    }

    @MainThread
    public void load(List<TrackInfo> tracks, int startIndex, long startMs, boolean autoplay, @Nullable Float rate) {
        jsGeneration++;
        suppressRemotePlayUntil = 0;
        if (tracks.isEmpty()) {
            stop();
            return;
        }
        List<MediaItem> items = toMediaItems(tracks); // throws IllegalArgumentException on a bad url
        int index = QueueModel.clampStart(startIndex, tracks.size());
        long pos = Math.max(0, startMs);
        queue.replace(tracks);
        if (rate != null) applyRate(rate);
        lastError = null;
        chapterTitle = null;
        if (isCasting()) {
            cast.load(tracks, index, pos, autoplay, currentRate(), repeatName());
            emitTrackChanged(index, "load");
            return;
        }
        ensureService();
        ExoPlayer p = player();
        everReady = false;
        endedSent = false;
        String previous = lastTrackId;
        lastTrackId = tracks.get(index).id; // the transition listener then ignores this item
        p.setMediaItems(items, index, pos);
        p.prepare();
        p.setPlayWhenReady(autoplay);
        updatePauseAtEnd();
        fireTrackChanged(index, tracks.get(index).id, previous, "load");
        refreshStatus(true);
        saveState();
    }

    @MainThread
    public void setUpcoming(List<TrackInfo> upcoming) {
        List<MediaItem> items = toMediaItems(upcoming);
        ExoPlayer p = player();
        int current = queue.isEmpty() ? -1 : p.getCurrentMediaItemIndex();
        int from = queue.replaceUpcoming(current, upcoming);
        if (!isCasting()) {
            int count = p.getMediaItemCount();
            if (from < count) p.removeMediaItems(from, count);
            p.addMediaItems(items);
            if (p.getPlaybackState() == Player.STATE_IDLE && !queue.isEmpty()) p.prepare();
        } else {
            // The receiver gets the whole queue again from where it is.
            JSONObject snap = cast.snapshot(queue);
            int idx = snap != null ? snap.optInt("index", current) : current;
            long pos = snap != null ? snap.optLong("positionMs", 0) : 0;
            boolean playing = snap != null && "playing".equals(snap.optString("status"));
            if (idx >= 0) cast.load(queue.snapshot(), idx, pos, playing, currentRate(), repeatName());
        }
        saveState();
    }

    @MainThread
    public void play() {
        suppressRemotePlayUntil = 0;
        if (isCasting()) {
            cast.play();
            return;
        }
        ExoPlayer p = player();
        if (p.getMediaItemCount() == 0) return;
        if (p.getPlaybackState() == Player.STATE_IDLE) p.prepare();
        if (p.getPlaybackState() == Player.STATE_ENDED) p.seekTo(p.getCurrentMediaItemIndex(), 0);
        ensureService();
        p.play();
    }

    @MainThread
    public void pause() {
        if (isCasting()) {
            cast.pause();
            return;
        }
        if (player != null) player.pause();
    }

    @MainThread
    public void seek(long positionMs) {
        if (isCasting()) {
            cast.seek(Math.max(0, positionMs));
            return;
        }
        if (player != null && player.getMediaItemCount() > 0) player.seekTo(Math.max(0, positionMs));
    }

    /** @throws IndexOutOfBoundsException for an index outside the queue */
    @MainThread
    public void skipTo(int index, long positionMs) {
        if (index < 0 || index >= queue.size()) throw new IndexOutOfBoundsException("No track at index " + index);
        jsGeneration++;
        lastError = null;
        if (isCasting()) {
            JSONObject snap = cast.snapshot(queue);
            boolean playing = snap == null || !"paused".equals(snap.optString("status"));
            cast.load(queue.snapshot(), index, Math.max(0, positionMs), playing, currentRate(), repeatName());
            emitTrackChanged(index, "skip");
            return;
        }
        ExoPlayer p = player();
        String previous = lastTrackId;
        lastTrackId = queue.get(index).id;
        everReady = false;
        endedSent = false;
        chapterTitle = null;
        if (p.getPlaybackState() == Player.STATE_IDLE) p.prepare();
        p.seekTo(index, Math.max(0, positionMs));
        updatePauseAtEnd();
        fireTrackChanged(index, lastTrackId, previous, "skip");
        refreshStatus(true);
        saveState();
    }

    @MainThread
    public void setRate(float rate) {
        applyRate(rate);
        if (isCasting()) cast.setRate(currentRate());
    }

    private void applyRate(float rate) {
        player().setPlaybackParameters(new PlaybackParameters(PlaybackMapping.clampRate(rate)));
    }

    public float currentRate() {
        return player == null ? 1f : player.getPlaybackParameters().speed;
    }

    @MainThread
    public void setVolume(float volume) {
        userVolume = PlaybackMapping.clampVolume(volume);
        if (sleepRunnable == null || !fading) player().setVolume(userVolume);
    }

    @MainThread
    public void setRepeat(String mode) {
        player().setRepeatMode(PlaybackMapping.repeatMode(mode));
        if (isCasting()) cast.setRepeat(mode);
    }

    public String repeatName() {
        return player == null ? "off" : PlaybackMapping.repeatName(player.getRepeatMode());
    }

    @MainThread
    public void stop() {
        jsGeneration++;
        cancelSleep();
        if (isCasting()) cast.stop();
        queue.clear();
        lastTrackId = null;
        lastError = null;
        chapterTitle = null;
        if (player != null) {
            player.stop();
            player.clearMediaItems();
        }
        main.removeCallbacks(positionTick);
        refreshStatus(true);
        //noinspection ResultOfMethodCallIgnored
        stateFile.delete();
        // Unbinding lets Media3 drop the notification and stop the idle service.
        releaseServiceConnection();
    }

    @MainThread
    public JSONObject snapshot() {
        if (isCasting()) {
            JSONObject c = cast.snapshot(queue);
            if (c != null) return c;
        }
        JSONObject o = new JSONObject();
        try {
            ExoPlayer p = player;
            int index = p == null || queue.isEmpty() ? -1 : p.getCurrentMediaItemIndex();
            TrackInfo t = queue.get(index);
            o.put("status", lastStatus);
            o.put("index", t == null ? -1 : index);
            o.put("trackId", t == null ? JSONObject.NULL : t.id);
            o.put("positionMs", p == null || t == null ? 0 : Math.max(0, p.getCurrentPosition()));
            o.put("durationMs", t == null ? 0 : durationOf(t));
            o.put("bufferedMs", p == null || t == null ? 0 : Math.max(0, p.getBufferedPosition()));
            o.put("rate", (double) currentRate());
            o.put("volume", (double) userVolume);
            o.put("repeat", repeatName());
            if (lastError != null && "error".equals(lastStatus)) o.put("error", lastError);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
        return o;
    }

    @MainThread
    public void configureRemote(String mode, long backMs, long forwardMs) {
        remoteMode = "audiobook".equals(mode) ? "audiobook" : "music";
        if (backMs > 0) skipBackMs = backMs;
        if (forwardMs > 0) skipForwardMs = forwardMs;
        applyRemoteToSession();
    }

    public long skipBackMs() {
        return skipBackMs;
    }

    public long skipForwardMs() {
        return skipForwardMs;
    }

    public boolean audiobookRemote() {
        return "audiobook".equals(remoteMode);
    }

    /** Player commands controllers may use: audiobooks swap previous/next for skip back/forward. */
    public Player.Commands allowedPlayerCommands() {
        Player.Commands base = MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS;
        if (!audiobookRemote()) return base;
        return base.buildUpon()
                .removeAll(Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_NEXT,
                        Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
                .build();
    }

    /** Notification / lock-screen buttons: skip ±N for audiobooks, the default prev/next for music. */
    public ImmutableList<CommandButton> mediaButtons() {
        if (!audiobookRemote()) return ImmutableList.of();
        CommandButton back = new CommandButton.Builder(skipBackIcon(skipBackMs))
                .setPlayerCommand(Player.COMMAND_SEEK_BACK)
                .setDisplayName("Back " + (skipBackMs / 1000) + " s")
                .setSlots(CommandButton.SLOT_BACK)
                .build();
        CommandButton forward = new CommandButton.Builder(skipForwardIcon(skipForwardMs))
                .setPlayerCommand(Player.COMMAND_SEEK_FORWARD)
                .setDisplayName("Forward " + (skipForwardMs / 1000) + " s")
                .setSlots(CommandButton.SLOT_FORWARD)
                .build();
        return ImmutableList.of(back, forward);
    }

    private static int skipBackIcon(long ms) {
        long s = ms / 1000;
        if (s == 5) return CommandButton.ICON_SKIP_BACK_5;
        if (s == 10) return CommandButton.ICON_SKIP_BACK_10;
        if (s == 15) return CommandButton.ICON_SKIP_BACK_15;
        if (s == 30) return CommandButton.ICON_SKIP_BACK_30;
        return CommandButton.ICON_SKIP_BACK;
    }

    private static int skipForwardIcon(long ms) {
        long s = ms / 1000;
        if (s == 5) return CommandButton.ICON_SKIP_FORWARD_5;
        if (s == 10) return CommandButton.ICON_SKIP_FORWARD_10;
        if (s == 15) return CommandButton.ICON_SKIP_FORWARD_15;
        if (s == 30) return CommandButton.ICON_SKIP_FORWARD_30;
        return CommandButton.ICON_SKIP_FORWARD;
    }

    private void applyRemoteToSession() {
        MediaLibrarySession s = session;
        if (s == null) return;
        Player.Commands commands = allowedPlayerCommands();
        for (MediaSession.ControllerInfo c : s.getConnectedControllers()) {
            s.setAvailableCommands(c, MediaSession.ConnectionResult.DEFAULT_SESSION_AND_LIBRARY_COMMANDS, commands);
        }
        s.setMediaButtonPreferences(mediaButtons());
    }

    /** Audiobook chapter title on the lock screen / notification (null clears it). */
    @MainThread
    public void setNowPlayingExtra(@Nullable String chapter) {
        chapterTitle = chapter == null || chapter.isEmpty() ? null : chapter;
        ExoPlayer p = player;
        if (p == null || queue.isEmpty()) return;
        int index = p.getCurrentMediaItemIndex();
        TrackInfo t = queue.get(index);
        if (t == null) return;
        // Same URI: ExoPlayer swaps the metadata without re-buffering.
        p.replaceMediaItem(index, toMediaItem(t, chapterTitle));
    }

    // ---- sleep timer ---------------------------------------------------------------------

    private boolean fading;

    @MainThread
    public void setSleepTimer(@Nullable JSONObject timer) {
        cancelSleep();
        if (timer == null) return;
        String kind = timer.optString("kind");
        if ("endOfTrack".equals(kind)) {
            sleepTrackId = timer.optString("trackId", null);
            updatePauseAtEnd();
            return;
        }
        if (!"minutes".equals(kind)) return;
        long endsAt = timer.optLong("endsAt", 0);
        final long fadeMs = Math.max(0, timer.optLong("fadeMs", 0));
        long delay = Math.max(0, endsAt - System.currentTimeMillis() - fadeMs);
        final long fadeStart = SystemClock.uptimeMillis() + delay;
        sleepRunnable = new Runnable() {
            @Override
            public void run() {
                long elapsed = SystemClock.uptimeMillis() - fadeStart;
                if (fadeMs > 0 && elapsed < fadeMs) {
                    fading = true;
                    float factor = 1f - (float) elapsed / fadeMs;
                    if (player != null) player.setVolume(userVolume * Math.max(0f, factor));
                    main.postDelayed(this, 100);
                    return;
                }
                sleepRunnable = null;
                fading = false;
                pause();
                if (player != null) player.setVolume(userVolume);
                emit("sleepTimerFired", new JSONObject(), true);
            }
        };
        main.postAtTime(sleepRunnable, fadeStart);
    }

    private void cancelSleep() {
        if (sleepRunnable != null) main.removeCallbacks(sleepRunnable);
        sleepRunnable = null;
        if (fading && player != null) player.setVolume(userVolume);
        fading = false;
        sleepTrackId = null;
        updatePauseAtEnd();
    }

    private void updatePauseAtEnd() {
        if (player == null) return;
        String current = currentTrackId();
        player.setPauseAtEndOfMediaItems(sleepTrackId != null && sleepTrackId.equals(current));
    }

    // =====================================================================================
    // Remote commands (from SessionPlayer: notification, lock screen, headset, car)
    // =====================================================================================

    /** @return true when the wrapped player should play now */
    boolean remotePlay() {
        if (SystemClock.elapsedRealtime() < suppressRemotePlayUntil) {
            // A car "play this" is waiting for JS to build the queue; JS's load starts playback.
            return false;
        }
        emitRemote("play", null, null, true);
        if (isCasting()) {
            cast.play();
            return false;
        }
        ensureService();
        return true;
    }

    boolean remotePause() {
        emitRemote("pause", null, null, true);
        if (isCasting()) {
            cast.pause();
            return false;
        }
        return true;
    }

    void remoteStop() {
        pause();
        emitRemote("stop", null, null, true);
    }

    void remoteSeekTo(long positionMs) {
        seek(positionMs);
        emitRemote("seekTo", Math.max(0, positionMs), null, true);
    }

    void remoteSkip(boolean forward) {
        long interval = forward ? skipForwardMs : skipBackMs;
        long target;
        if (isCasting()) {
            JSONObject snap = cast.snapshot(queue);
            long pos = snap == null ? 0 : snap.optLong("positionMs", 0);
            target = forward ? pos + interval : pos - interval;
            cast.seek(Math.max(0, target));
        } else if (player != null) {
            long pos = player.getCurrentPosition();
            long dur = player.getDuration();
            target = forward ? pos + interval : pos - interval;
            if (dur != C.TIME_UNSET && target > dur) target = dur;
            player.seekTo(Math.max(0, target));
        }
        emitRemote(forward ? "skipForward" : "skipBackward", null, interval, true);
    }

    void remoteNext() {
        remoteQueueMove(true);
    }

    void remotePrevious() {
        remoteQueueMove(false);
    }

    void remoteSkipTo(int index, long positionMs) {
        if (index == currentIndex()) {
            remoteSeekTo(positionMs);
            return;
        }
        // Treated like next/previous: JS decides, native follows after the grace period.
        final int target = index;
        boolean forward = index > currentIndex();
        emitRemote(forward ? "next" : "previous", null, null, false);
        final int generation = jsGeneration;
        Runnable fallback = () -> {
            if (generation != jsGeneration || target < 0 || target >= queue.size()) return;
            nativeMoveTo(target, 0);
        };
        if (jsListens("remoteCommand")) main.postDelayed(fallback, REMOTE_FALLBACK_MS);
        else fallback.run();
    }

    private void remoteQueueMove(final boolean next) {
        emitRemote(next ? "next" : "previous", null, null, false);
        final int generation = jsGeneration;
        Runnable fallback = () -> {
            if (generation != jsGeneration) return; // JS answered with load / skipTo
            int size = queue.size();
            int current = currentIndex();
            long pos = player == null ? 0 : player.getCurrentPosition();
            int target = next
                    ? QueueModel.fallbackNextIndex(current, size, repeatName())
                    : QueueModel.fallbackPreviousIndex(current, size, pos, repeatName());
            if (target < 0) return;
            if (target == current) seek(0);
            else nativeMoveTo(target, 0);
        };
        if (jsListens("remoteCommand")) main.postDelayed(fallback, REMOTE_FALLBACK_MS);
        else fallback.run();
    }

    private void nativeMoveTo(int index, long positionMs) {
        if (isCasting()) {
            cast.load(queue.snapshot(), index, positionMs, true, currentRate(), repeatName());
            emitTrackChanged(index, "remote");
            return;
        }
        if (player == null) return;
        pendingReason = "remote";
        player.seekTo(index, positionMs);
        if (!player.getPlayWhenReady()) player.play();
    }

    private void emitRemote(String command, @Nullable Long positionMs, @Nullable Long intervalMs, boolean handled) {
        JSONObject o = new JSONObject();
        try {
            o.put("command", command);
            if (positionMs != null) o.put("positionMs", (long) positionMs);
            if (intervalMs != null) o.put("intervalMs", (long) intervalMs);
            o.put("handled", handled);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
        emit("remoteCommand", o, false);
    }

    // =====================================================================================
    // Car (MediaLibrarySession callback helpers)
    // =====================================================================================

    /** A one-item list the session hands the player while JS builds the real queue. */
    public static List<MediaItem> placeholder() {
        return Collections.singletonList(new MediaItem.Builder().setMediaId(PLACEHOLDER_ID).build());
    }

    static boolean isPlaceholder(List<MediaItem> items) {
        return items.size() == 1 && PLACEHOLDER_ID.equals(items.get(0).mediaId);
    }

    /** The car picked something; native waits (up to 3 s) for JS's load instead of playing the old queue. */
    public void expectJsLoad() {
        suppressRemotePlayUntil = SystemClock.elapsedRealtime() + 3000;
    }

    /** Items a controller set directly (playback resumption): keep the queue model in step. */
    void adoptControllerItems(List<MediaItem> items) {
        if (items.size() == queue.size()) {
            boolean same = true;
            for (int i = 0; i < items.size() && same; i++) same = items.get(i).mediaId.equals(queue.get(i).id);
            if (same) return;
        }
        Log.w(TAG, "A controller replaced the queue with items native does not know; clearing the queue model");
        queue.clear();
    }

    /**
     * Playback resumption (a headset / car "play" after the process died): the last queue JS
     * handed over, restored from disk. Signed links may have expired; JS refreshes them when the
     * app opens (an 'auth' error otherwise).
     */
    @MainThread
    @Nullable
    public MediaSession.MediaItemsWithStartPosition resumptionItems() {
        if (!queue.isEmpty() && player != null && player.getMediaItemCount() > 0) {
            return new MediaSession.MediaItemsWithStartPosition(toMediaItems(queue.snapshot()),
                    player.getCurrentMediaItemIndex(), player.getCurrentPosition());
        }
        try {
            if (!stateFile.isFile()) return null;
            byte[] bytes = java.nio.file.Files.readAllBytes(stateFile.toPath());
            JSONObject o = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
            List<TrackInfo> tracks = QueueModel.parseTracks(o.optJSONArray("tracks"));
            if (tracks.isEmpty()) return null;
            int index = QueueModel.clampStart(o.optInt("index", 0), tracks.size());
            long pos = Math.max(0, o.optLong("positionMs", 0));
            List<MediaItem> items = toMediaItems(tracks);
            queue.replace(tracks);
            lastTrackId = null;
            if (o.has("rate")) applyRate((float) o.optDouble("rate", 1));
            return new MediaSession.MediaItemsWithStartPosition(items, index, pos);
        } catch (IOException | JSONException | RuntimeException e) {
            Log.w(TAG, "No usable saved queue", e);
            return null;
        }
    }

    private void saveState() {
        lastStateSave = SystemClock.elapsedRealtime();
        if (queue.isEmpty() || player == null) return;
        try {
            JSONObject o = new JSONObject();
            o.put("tracks", QueueModel.toJson(queue.snapshot()));
            o.put("index", player.getCurrentMediaItemIndex());
            o.put("positionMs", Math.max(0, player.getCurrentPosition()));
            o.put("rate", (double) currentRate());
            File dir = stateFile.getParentFile();
            if (dir != null && !dir.isDirectory() && !dir.mkdirs()) return;
            File tmp = new File(stateFile.getPath() + ".tmp");
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(o.toString().getBytes(StandardCharsets.UTF_8));
            }
            if (!tmp.renameTo(stateFile)) {
                //noinspection ResultOfMethodCallIgnored
                stateFile.delete();
                //noinspection ResultOfMethodCallIgnored
                tmp.renameTo(stateFile);
            }
        } catch (IOException | JSONException e) {
            Log.w(TAG, "Could not save the queue", e);
        }
    }

    // =====================================================================================
    // Cast hand-over (called by the cast controller)
    // =====================================================================================

    /** A cast session started: pause locally and return what the receiver should load. */
    @MainThread
    public void onCastStarted() {
        CastBridge c = cast;
        if (c == null || player == null || queue.isEmpty()) return;
        boolean wasPlaying = player.getPlayWhenReady();
        int index = player.getCurrentMediaItemIndex();
        long pos = Math.max(0, player.getCurrentPosition());
        player.pause();
        c.load(queue.snapshot(), index, pos, wasPlaying, currentRate(), repeatName());
    }

    /** The cast session ended: continue locally where the receiver was. */
    @MainThread
    public void onCastEnded(@Nullable String trackId, long positionMs, boolean wasPlaying) {
        if (player == null || queue.isEmpty()) return;
        int index = queue.indexOfId(trackId);
        if (index < 0) index = player.getCurrentMediaItemIndex();
        String previous = lastTrackId;
        if (index != player.getCurrentMediaItemIndex() || !queue.get(index).id.equals(previous)) {
            lastTrackId = queue.get(index).id;
            fireTrackChanged(index, lastTrackId, previous, "skip");
        }
        if (player.getPlaybackState() == Player.STATE_IDLE) player.prepare();
        player.seekTo(index, Math.max(0, positionMs));
        if (wasPlaying) {
            ensureService();
            player.play();
        }
        refreshStatus(true);
    }

    /** trackChanged while casting (the cast controller saw the receiver move). */
    public void emitTrackChanged(int index, String reason) {
        TrackInfo t = queue.get(index);
        if (t == null) return;
        String previous = lastTrackId;
        lastTrackId = t.id;
        fireTrackChanged(index, t.id, previous, reason);
    }

    // =====================================================================================
    // Player events → plugin events
    // =====================================================================================

    private final Player.Listener listener = new Player.Listener() {
        @Override
        public void onMediaItemTransition(@Nullable MediaItem mediaItem, int reason) {
            ExoPlayer p = player;
            if (p == null || mediaItem == null || isPlaceholder(Collections.singletonList(mediaItem))) return;
            int index = p.getCurrentMediaItemIndex();
            TrackInfo t = queue.get(index);
            if (t == null) return;
            boolean repeat = reason == Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT;
            if (t.id.equals(lastTrackId) && !repeat && pendingReason == null) return; // load/skipTo already told JS
            String why = pendingReason != null ? pendingReason : PlaybackMapping.transitionReason(reason);
            pendingReason = null;
            String previous = lastTrackId;
            lastTrackId = t.id;
            everReady = false;
            endedSent = false;
            chapterTitle = null;
            updatePauseAtEnd();
            fireTrackChanged(index, t.id, previous, why);
            refreshStatus(false);
            saveState();
        }

        @Override
        public void onPlaybackStateChanged(int playbackState) {
            if (playbackState == Player.STATE_READY) everReady = true;
            if (playbackState == Player.STATE_ENDED && !endedSent) {
                endedSent = true;
                refreshStatus(true);
                JSONObject o = new JSONObject();
                try {
                    String id = currentTrackId();
                    o.put("trackId", id == null ? JSONObject.NULL : id);
                } catch (JSONException e) {
                    throw new IllegalStateException(e);
                }
                emit("queueEnded", o, true);
                return;
            }
            refreshStatus(false);
        }

        @Override
        public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
            if (!playWhenReady && reason == Player.PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM && sleepTrackId != null) {
                sleepTrackId = null;
                updatePauseAtEnd();
                emit("sleepTimerFired", new JSONObject(), true);
            }
            refreshStatus(false);
            if (!playWhenReady) {
                emitPosition();
                saveState();
            }
        }

        @Override
        public void onPlaybackSuppressionReasonChanged(int playbackSuppressionReason) {
            refreshStatus(false);
        }

        @Override
        public void onIsPlayingChanged(boolean isPlaying) {
            main.removeCallbacks(positionTick);
            if (isPlaying) main.post(positionTick);
        }

        @Override
        public void onPositionDiscontinuity(@NonNull Player.PositionInfo oldPosition, @NonNull Player.PositionInfo newPosition, int reason) {
            if (reason == Player.DISCONTINUITY_REASON_SEEK || reason == Player.DISCONTINUITY_REASON_SEEK_ADJUSTMENT) {
                emitPosition();
            }
        }

        @Override
        public void onPlayerError(@NonNull PlaybackException error) {
            TrackInfo t = queue.get(currentIndex());
            int http = httpStatusOf(error);
            String code = PlaybackMapping.errorCode(error.errorCode, http, t != null && !t.isRemote());
            JSONObject e = new JSONObject();
            try {
                e.put("code", code);
                String msg = error.getMessage();
                e.put("message", msg == null || msg.isEmpty() ? error.getErrorCodeName() : msg);
                if (http > 0) e.put("httpStatus", http);
            } catch (JSONException ex) {
                throw new IllegalStateException(ex);
            }
            lastError = e;
            Log.w(TAG, "Playback error (" + code + ")", error);
            refreshStatus(true);
        }
    };

    private static int httpStatusOf(Throwable error) {
        Throwable c = error;
        for (int i = 0; c != null && i < 8; i++, c = c.getCause()) {
            if (c instanceof HttpDataSource.InvalidResponseCodeException) {
                return ((HttpDataSource.InvalidResponseCodeException) c).responseCode;
            }
        }
        return 0;
    }

    private int currentIndex() {
        return player == null || queue.isEmpty() ? -1 : player.getCurrentMediaItemIndex();
    }

    @Nullable
    private String currentTrackId() {
        TrackInfo t = queue.get(currentIndex());
        return t == null ? null : t.id;
    }

    private long durationOf(TrackInfo t) {
        long d = player == null ? C.TIME_UNSET : player.getDuration();
        return d == C.TIME_UNSET || d <= 0 ? t.durationMs : d;
    }

    private void refreshStatus(boolean force) {
        ExoPlayer p = player;
        boolean hasError = lastError != null && (p == null || p.getPlayerError() != null);
        if (!hasError) lastError = null;
        String status = p == null
                ? (queue.isEmpty() ? "idle" : "paused")
                : PlaybackMapping.status(p.getPlaybackState(), p.getPlayWhenReady(), hasError, everReady,
                        !queue.isEmpty() && p.getMediaItemCount() > 0,
                        p.getPlaybackSuppressionReason() != Player.PLAYBACK_SUPPRESSION_REASON_NONE);
        int index = currentIndex();
        String trackId = currentTrackId();
        boolean changed = !status.equals(lastStatus) || index != lastStatusIndex
                || (trackId == null ? lastStatusTrack != null : !trackId.equals(lastStatusTrack));
        if (!changed && !force) return;
        lastStatus = status;
        lastStatusIndex = index;
        lastStatusTrack = trackId;
        JSONObject o = new JSONObject();
        try {
            o.put("status", status);
            o.put("trackId", trackId == null ? JSONObject.NULL : trackId);
            o.put("index", trackId == null ? -1 : index);
            if (hasError) o.put("error", lastError);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
        emit("state", o, false);
    }

    private void emitPosition() {
        ExoPlayer p = player;
        int index = currentIndex();
        TrackInfo t = queue.get(index);
        if (p == null || t == null) return;
        JSONObject o = new JSONObject();
        try {
            o.put("trackId", t.id);
            o.put("index", index);
            o.put("positionMs", Math.max(0, p.getCurrentPosition()));
            o.put("durationMs", durationOf(t));
            o.put("bufferedMs", Math.max(0, p.getBufferedPosition()));
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
        emit("position", o, false);
    }

    private void fireTrackChanged(int index, String trackId, @Nullable String previous, String reason) {
        JSONObject o = new JSONObject();
        try {
            o.put("index", index);
            o.put("trackId", trackId);
            o.put("previousTrackId", previous == null ? JSONObject.NULL : previous);
            o.put("reason", reason);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
        emit("trackChanged", o, true);
    }

    // =====================================================================================
    // NativeTrack → MediaItem
    // =====================================================================================

    private List<MediaItem> toMediaItems(List<TrackInfo> tracks) {
        List<MediaItem> out = new ArrayList<>(tracks.size());
        for (TrackInfo t : tracks) out.add(toMediaItem(t, null));
        return out;
    }

    private MediaItem toMediaItem(TrackInfo t, @Nullable String chapter) {
        String uri = QueueModel.playableUri(t.url);
        if (uri == null) throw new IllegalArgumentException("Unusable url for track " + t.id);
        headers.put(uri, t.headers);
        String art = t.artworkUrl == null ? null : QueueModel.playableUri(t.artworkUrl);
        if (art != null) headers.put(art, t.artworkHeaders);
        String artist = t.artist;
        if (chapter != null) artist = artist == null ? chapter : chapter + " · " + artist;
        MediaMetadata.Builder md = new MediaMetadata.Builder()
                .setTitle(t.title)
                .setArtist(artist)
                .setAlbumTitle(t.album)
                .setSubtitle(chapter)
                .setIsBrowsable(false)
                .setIsPlayable(true)
                .setMediaType(t.isAudiobook() ? MediaMetadata.MEDIA_TYPE_AUDIO_BOOK_CHAPTER : MediaMetadata.MEDIA_TYPE_MUSIC);
        if (art != null) md.setArtworkUri(Uri.parse(art));
        if (t.durationMs > 0) md.setDurationMs(t.durationMs);
        MediaItem.Builder b = new MediaItem.Builder()
                .setMediaId(t.id)
                .setUri(uri)
                .setMediaMetadata(md.build());
        if (t.mimeType != null) b.setMimeType(t.mimeType);
        return b.build();
    }
}

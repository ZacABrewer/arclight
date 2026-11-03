package com.moviemethat.arclight.video;

import android.app.PendingIntent;
import android.app.PictureInPictureParams;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.text.format.DateFormat;
import android.util.Log;
import android.util.Rational;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.ProgressBar;
import android.widget.TextView;
import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.lifecycle.Lifecycle;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.ForwardingPlayer;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.TrackSelectionOverride;
import androidx.media3.common.TrackSelectionParameters;
import androidx.media3.common.Tracks;
import androidx.media3.common.VideoSize;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSourceBitmapLoader;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.session.MediaSession;
import androidx.media3.ui.PlayerView;
import androidx.media3.ui.SubtitleView;
import com.google.common.util.concurrent.FutureCallback;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;
import com.moviemethat.arclight.R;
import com.moviemethat.arclight.player.PlaybackMapping;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The full-screen video player (playVideo). Media3 ExoPlayer plays the progressive stream the
 * server chose (direct file, remuxed fragmented MP4 or a transcode); PlayerView draws the picture
 * and subtitles; the overlay controls are ours and work with touch and TV remotes (D-pad focus,
 * media keys). Times shown and reported are media time: player time + {@code streamStartMs}.
 *
 * <ul>
 *   <li>Seekable (direct) streams seek in the player. Otherwise a seek becomes a
 *       {@code videoSeekRequest} and JS answers with {@code replaceVideoStream}.</li>
 *   <li>Subtitles are the WebVTT links JS gives, side-loaded; when the stream starts later than
 *       media time 0 they are fetched and shifted ({@link VttShifter}) so cues line up.</li>
 *   <li>Audio: the file's own tracks in direct play; the JS list otherwise (a change re-requests).</li>
 *   <li>Skip intro / recap / credits, up-next card with a countdown, resume position, screen on,
 *       a media session for remotes, picture-in-picture on phones.</li>
 * </ul>
 */
@UnstableApi
public final class VideoActivity extends AppCompatActivity implements VideoSeekBar.Listener {

    private static final String TAG = "ArclightVideo";
    private static final String USER_AGENT = "ArclightPlayer (android)";
    private static final long TICK_MS = 500;
    private static final long PROGRESS_INTERVAL_MS = 10_000;
    private static final long HIDE_CONTROLS_MS = 5_000;
    private static final long SEEK_REQUEST_DEBOUNCE_MS = 500;
    private static final int SUBTITLE_TIMEOUT_MS = 10_000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    /** Raw WebVTT per subtitle id (media time), so a stream change only re-shifts. */
    private final Map<String, String> rawVtt = new HashMap<>();
    private final VideoController controller = VideoController.get();

    private ExoPlayer player;
    @Nullable private MediaSession session;
    private PlayerView playerView;
    private View controls;
    private ProgressBar loading;
    private TextView eyebrow;
    private TextView title;
    private TextView streamInfo;
    private TextView time;
    private TextView chapter;
    private TextView remaining;
    private VideoSeekBar seekBar;
    private ImageButton playPause;
    private ImageButton close;
    private Button rewind;
    private Button forward;
    private Button audioButton;
    private Button subtitlesButton;
    private Button nextButton;
    private Button skipButton;
    private View upNextCard;
    private ImageView upNextArt;
    private TextView upNextLabel;
    private TextView upNextTitle;
    private TextView upNextSubtitle;
    private Button upNextPlay;
    private Button upNextCancel;

    @Nullable private VideoRequest req;
    private boolean tv;
    private boolean closed;
    /** Bumped for every stream started: late subtitle work for an older one is dropped. */
    private int generation;
    private boolean tracksApplied;
    private boolean everReady;
    /** Waiting for JS: a replaceVideoStream (seek / audio change) or the next item. */
    private boolean awaitingJs;
    /** A seek target sent (or about to be sent) to JS, shown on the bar meanwhile; -1 = none. */
    private long pendingSeekMs = -1;
    private boolean upNextShown;
    private boolean upNextCancelled;
    private boolean upNextFired;
    private long upNextStartedAt;
    private long lastProgressAt;
    @Nullable private AlertDialog dialog;
    @Nullable private VideoRequest.Segment shownSkip;

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            onTick();
            handler.postDelayed(this, TICK_MS);
        }
    };
    private final Runnable hideControls = this::hideControlsNow;
    private final Runnable sendSeek = this::sendSeekRequest;

    // =====================================================================================
    // Lifecycle
    // =====================================================================================

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        VideoRequest request = controller.takePending();
        if (request == null) {
            // Recreated by the system after the process died, or JS closed it already.
            finish();
            return;
        }
        controller.attach(this);
        tv = VideoProfile.isTv(this);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(R.layout.activity_video);
        enterImmersive();
        bindViews();
        createPlayer();
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                finishWithClose(false, null);
            }
        });
        handler.post(tick);
        load(request);
    }

    private void bindViews() {
        playerView = findViewById(R.id.video_view);
        controls = findViewById(R.id.video_controls);
        loading = findViewById(R.id.video_loading);
        eyebrow = findViewById(R.id.video_eyebrow);
        title = findViewById(R.id.video_title);
        streamInfo = findViewById(R.id.video_stream_info);
        time = findViewById(R.id.video_time);
        chapter = findViewById(R.id.video_chapter);
        remaining = findViewById(R.id.video_remaining);
        seekBar = findViewById(R.id.video_seek);
        playPause = findViewById(R.id.video_play_pause);
        close = findViewById(R.id.video_close);
        rewind = findViewById(R.id.video_rewind);
        forward = findViewById(R.id.video_forward);
        audioButton = findViewById(R.id.video_audio);
        subtitlesButton = findViewById(R.id.video_subtitles);
        nextButton = findViewById(R.id.video_next);
        skipButton = findViewById(R.id.video_skip);
        upNextCard = findViewById(R.id.video_up_next);
        upNextArt = findViewById(R.id.video_up_next_art);
        upNextLabel = findViewById(R.id.video_up_next_label);
        upNextTitle = findViewById(R.id.video_up_next_title);
        upNextSubtitle = findViewById(R.id.video_up_next_subtitle);
        upNextPlay = findViewById(R.id.video_up_next_play);
        upNextCancel = findViewById(R.id.video_up_next_cancel);

        seekBar.setListener(this);
        playPause.setOnClickListener(v -> {
            togglePlayPause();
            showControls(false);
        });
        rewind.setOnClickListener(v -> {
            seekBy(-10_000);
            showControls(false);
        });
        forward.setOnClickListener(v -> {
            seekBy(10_000);
            showControls(false);
        });
        close.setOnClickListener(v -> finishWithClose(false, null));
        audioButton.setOnClickListener(v -> showAudioPicker());
        subtitlesButton.setOnClickListener(v -> showSubtitlePicker());
        nextButton.setOnClickListener(v -> fireNext());
        skipButton.setOnClickListener(v -> skipSegment());
        upNextPlay.setOnClickListener(v -> fireNext());
        upNextCancel.setOnClickListener(v -> cancelUpNext());
        // TV remotes have Back; the close button is for touch.
        if (tv) close.setVisibility(View.GONE);

        // Tap on the picture toggles the controls.
        playerView.setOnTouchListener((v, e) -> {
            if (e.getActionMasked() == MotionEvent.ACTION_UP) {
                if (controls.getVisibility() == View.VISIBLE) hideControlsNow();
                else showControls(false);
                v.performClick();
            }
            return true;
        });

        // Subtitles follow the system caption settings (size, colours, edge).
        SubtitleView subs = playerView.getSubtitleView();
        if (subs != null) {
            subs.setUserDefaultStyle();
            subs.setUserDefaultTextSize();
        }
    }

    private void createPlayer() {
        AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                .build();
        player = new ExoPlayer.Builder(this)
                .setAudioAttributes(attrs, /* handleAudioFocus= */ true)
                .setHandleAudioBecomingNoisy(true)
                .setWakeMode(C.WAKE_MODE_NETWORK)
                .setSeekBackIncrementMs(10_000)
                .setSeekForwardIncrementMs(10_000)
                .build();
        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int state) {
                onStateChanged(state);
            }

            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                updatePlayPause();
                if (!isPlaying && player.getPlaybackState() == Player.STATE_READY && !player.getPlayWhenReady()) {
                    emitProgress(true);
                }
                if (isPlaying) scheduleHide();
                updatePipParams();
            }

            @Override
            public void onTracksChanged(@NonNull Tracks tracks) {
                applyInitialTracks(tracks);
            }

            @Override
            public void onVideoSizeChanged(@NonNull VideoSize size) {
                updatePipParams();
            }

            @Override
            public void onPlayerError(@NonNull PlaybackException error) {
                onError(error);
            }
        });
        playerView.setPlayer(player);
        session = new MediaSession.Builder(this, new SessionPlayer(player))
                .setId("arclight-video")
                .setSessionActivity(PendingIntent.getActivity(this, 1,
                        new Intent(this, VideoActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                        PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT))
                .build();
    }

    @Override
    protected void onStop() {
        super.onStop();
        if (closed || isInPip()) return;
        // Home on a TV / app switch on a phone without PiP: pause and report.
        if (player != null && player.getPlayWhenReady()) {
            player.pause();
            emitProgress(true);
        }
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (dialog != null) dialog.dismiss();
        if (req != null && !closed && isFinishing()) {
            // Finished without our own close path (PiP window dismissed, task removed).
            closed = true;
            controller.closed(req.itemKey, currentMediaMs(), durationMs(), isCompleted(), null);
        }
        controller.detach(this);
        if (session != null) {
            session.release();
            session = null;
        }
        if (player != null) {
            player.release();
            player = null;
        }
        io.shutdownNow();
        deleteSubtitleFiles();
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) enterImmersive();
    }

    private void enterImmersive() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        c.hide(WindowInsetsCompat.Type.systemBars());
        c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    }

    // =====================================================================================
    // Loading (called by VideoController)
    // =====================================================================================

    /** Plays {@code request} (first item, or up next / another playVideo while open). */
    void load(VideoRequest request) {
        VideoRequest old = req;
        if (old != null && !upNextFired && !old.itemKey.equals(request.itemKey)) {
            // Replaced without going through up next: report where the old one stopped.
            controller.progress(old.itemKey, currentMediaMs(), durationMs(), true);
        }
        req = request;
        tracksApplied = false;
        everReady = false;
        awaitingJs = false;
        pendingSeekMs = -1;
        upNextShown = false;
        upNextCancelled = false;
        upNextFired = false;
        lastProgressAt = SystemClock.elapsedRealtime();
        shownSkip = null;
        handler.removeCallbacks(sendSeek);
        seekBar.cancelScrub();
        rawVtt.clear();
        if (dialog != null) dialog.dismiss();

        setText(eyebrow, request.subtitle);
        title.setText(request.title);
        setText(streamInfo, request.streamInfo);
        seekBar.setChapters(request.chapters);
        nextButton.setVisibility(request.next == null ? View.GONE : View.VISIBLE);
        if (request.next != null) nextButton.setText(getString(R.string.video_next_title, request.next.title));
        audioButton.setVisibility(View.VISIBLE);
        subtitlesButton.setVisibility(request.subtitles.isEmpty() ? View.GONE : View.VISIBLE);
        upNextCard.setVisibility(View.GONE);
        skipButton.setVisibility(View.GONE);
        bindUpNext(request.next);

        startStream(request.startPositionMs, true);
        showControls(true);
    }

    /** replaceVideoStream: a new stream for the same item (after a seek / audio request). */
    void replaceStream(VideoRequest.Stream stream) {
        VideoRequest r = req;
        if (r == null) return;
        boolean play = player.getPlayWhenReady() || awaitingJs;
        r.apply(stream);
        awaitingJs = false;
        pendingSeekMs = -1;
        tracksApplied = false;
        startStream(stream.positionMs, play);
    }

    void closeFromJs() {
        finishWithClose(false, null);
    }

    private void startStream(long mediaPositionMs, boolean playWhenReady) {
        VideoRequest r = req;
        if (r == null) return;
        final int gen = ++generation;
        loading.setVisibility(View.VISIBLE);
        if (r.streamStartMs <= 0 || r.subtitles.isEmpty()) {
            List<MediaItem.SubtitleConfiguration> subs = new ArrayList<>();
            for (VideoRequest.Subtitle s : r.subtitles) subs.add(subtitleConfig(s, Uri.parse(s.url)));
            prepare(r, subs, mediaPositionMs, playWhenReady);
            return;
        }
        // The stream starts later than media time 0: fetch, shift and side-load local copies.
        final long offset = r.streamStartMs;
        final List<VideoRequest.Subtitle> list = new ArrayList<>(r.subtitles);
        final Map<String, String> headers = r.headers;
        final File dir = subtitleDir();
        io.execute(() -> {
            List<Uri> files = new ArrayList<>();
            for (VideoRequest.Subtitle s : list) {
                Uri uri = null;
                try {
                    String raw;
                    synchronized (rawVtt) {
                        raw = rawVtt.get(s.id);
                    }
                    if (raw == null) {
                        raw = fetchText(s.url, headers);
                        synchronized (rawVtt) {
                            rawVtt.put(s.id, raw);
                        }
                    }
                    File f = new File(dir, gen + "-" + Math.abs(s.id.hashCode()) + ".vtt");
                    try (FileOutputStream out = new FileOutputStream(f)) {
                        out.write(VttShifter.shift(raw, offset).getBytes(StandardCharsets.UTF_8));
                    }
                    uri = Uri.fromFile(f);
                } catch (Exception e) {
                    Log.w(TAG, "Subtitle " + s.id + " unavailable", e);
                }
                files.add(uri);
            }
            handler.post(() -> {
                if (gen != generation || req != r || player == null) return;
                List<MediaItem.SubtitleConfiguration> subs = new ArrayList<>();
                for (int i = 0; i < list.size(); i++) {
                    if (files.get(i) != null) subs.add(subtitleConfig(list.get(i), files.get(i)));
                }
                prepare(r, subs, mediaPositionMs, playWhenReady);
            });
        });
    }

    private void prepare(VideoRequest r, List<MediaItem.SubtitleConfiguration> subs, long mediaPositionMs, boolean playWhenReady) {
        MediaMetadata.Builder meta = new MediaMetadata.Builder()
                .setTitle(r.title)
                .setDisplayTitle(r.title)
                .setMediaType(r.itemKey.startsWith("episode:") ? MediaMetadata.MEDIA_TYPE_TV_SHOW : MediaMetadata.MEDIA_TYPE_MOVIE);
        if (r.subtitle != null) meta.setSubtitle(r.subtitle).setArtist(r.subtitle);
        if (r.artworkUrl != null) meta.setArtworkUri(Uri.parse(r.artworkUrl));
        MediaItem.Builder item = new MediaItem.Builder()
                .setUri(r.url)
                .setMediaId(r.itemKey)
                .setMediaMetadata(meta.build())
                .setSubtitleConfigurations(subs);
        String mime = containerMime(r.mimeType);
        if (mime != null) item.setMimeType(mime);

        HttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
                .setUserAgent(USER_AGENT)
                .setAllowCrossProtocolRedirects(true)
                .setConnectTimeoutMs(15_000)
                // A transcode can take a while to produce its first bytes.
                .setReadTimeoutMs(45_000)
                .setDefaultRequestProperties(r.headers);
        player.setMediaSource(new DefaultMediaSourceFactory(new DefaultDataSource.Factory(this, http)).createMediaSource(item.build()),
                r.seekable ? r.toPlayerMs(mediaPositionMs) : 0);
        player.prepare();
        player.setPlayWhenReady(playWhenReady);
    }

    private static MediaItem.SubtitleConfiguration subtitleConfig(VideoRequest.Subtitle s, Uri uri) {
        return new MediaItem.SubtitleConfiguration.Builder(uri)
                .setId(s.id)
                .setMimeType(MimeTypes.TEXT_VTT)
                .setLanguage(s.language)
                .setLabel(s.label)
                .setSelectionFlags(s.forced ? C.SELECTION_FLAG_FORCED : 0)
                .build();
    }

    @Nullable
    static String containerMime(String mime) {
        if (mime == null || mime.isEmpty()) return null;
        String m = mime.toLowerCase(Locale.ROOT);
        if (m.contains("matroska") || m.equals("video/mkv")) return MimeTypes.VIDEO_MATROSKA;
        if (m.contains("webm")) return MimeTypes.VIDEO_WEBM;
        if (m.contains("mp4") || m.contains("quicktime")) return MimeTypes.VIDEO_MP4;
        return null;
    }

    private static String fetchText(String url, Map<String, String> headers) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(SUBTITLE_TIMEOUT_MS);
        c.setReadTimeout(SUBTITLE_TIMEOUT_MS);
        c.setRequestProperty("User-Agent", USER_AGENT);
        for (Map.Entry<String, String> h : headers.entrySet()) c.setRequestProperty(h.getKey(), h.getValue());
        try {
            int code = c.getResponseCode();
            if (code / 100 != 2) throw new java.io.IOException("HTTP " + code);
            try (InputStream in = c.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                return out.toString("UTF-8");
            }
        } finally {
            c.disconnect();
        }
    }

    private File subtitleDir() {
        File d = new File(getCacheDir(), "video-subtitles");
        //noinspection ResultOfMethodCallIgnored
        d.mkdirs();
        return d;
    }

    private void deleteSubtitleFiles() {
        File[] files = new File(getCacheDir(), "video-subtitles").listFiles();
        if (files == null) return;
        //noinspection ResultOfMethodCallIgnored
        for (File f : files) f.delete();
    }

    // =====================================================================================
    // Player state
    // =====================================================================================

    private void onStateChanged(int state) {
        if (state == Player.STATE_READY) everReady = true;
        if (state == Player.STATE_ENDED) {
            onEnded();
            return;
        }
        updateLoading();
    }

    private void updateLoading() {
        boolean busy = awaitingJs || player == null || player.getPlaybackState() == Player.STATE_BUFFERING
                || (player.getPlaybackState() == Player.STATE_IDLE && !closed);
        loading.setVisibility(busy ? View.VISIBLE : View.GONE);
    }

    private void onEnded() {
        VideoRequest r = req;
        if (r == null || awaitingJs) return;
        if (r.next != null && !upNextCancelled) {
            fireNext();
        } else {
            finishWithClose(true, null);
        }
    }

    private void onError(PlaybackException error) {
        int http = 0;
        Throwable cause = error.getCause();
        if (cause instanceof HttpDataSource.InvalidResponseCodeException) {
            http = ((HttpDataSource.InvalidResponseCodeException) cause).responseCode;
        }
        String code = PlaybackMapping.errorCode(error.errorCode, http, false);
        Log.w(TAG, "Playback failed (" + code + ")", error);
        finishWithClose(false, code);
    }

    private void applyInitialTracks(Tracks tracks) {
        VideoRequest r = req;
        if (r == null || tracksApplied || tracks.isEmpty()) return;
        tracksApplied = true;
        TrackSelectionParameters.Builder p = player.getTrackSelectionParameters().buildUpon();
        // Audio: in direct play pick the wanted ordinal among the file's tracks.
        if (r.seekable && r.selectedAudio != null) {
            List<Tracks.Group> audio = groups(tracks, C.TRACK_TYPE_AUDIO);
            int i = r.selectedAudio;
            if (i >= 0 && i < audio.size() && audio.get(i).isSupported()) {
                p.setOverrideForType(new TrackSelectionOverride(audio.get(i).getMediaTrackGroup(), 0));
            }
        }
        applySubtitleTo(p, tracks, r.selectedSubtitle);
        player.setTrackSelectionParameters(p.build());
    }

    /** Shows subtitle {@code id} (one of ours, side-loaded) or none; the file's own text tracks stay off. */
    private static void applySubtitleTo(TrackSelectionParameters.Builder p, Tracks tracks, @Nullable String id) {
        p.clearOverridesOfType(C.TRACK_TYPE_TEXT);
        if (id == null) {
            p.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true);
            return;
        }
        for (Tracks.Group g : groups(tracks, C.TRACK_TYPE_TEXT)) {
            Format f = g.getTrackFormat(0);
            if (f.id != null && (f.id.equals(id) || f.id.endsWith(":" + id))) {
                p.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false);
                p.setOverrideForType(new TrackSelectionOverride(g.getMediaTrackGroup(), 0));
                return;
            }
        }
        p.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true);
    }

    private static List<Tracks.Group> groups(Tracks tracks, int type) {
        List<Tracks.Group> out = new ArrayList<>();
        for (Tracks.Group g : tracks.getGroups()) if (g.getType() == type) out.add(g);
        return out;
    }

    // =====================================================================================
    // Time
    // =====================================================================================

    private long currentMediaMs() {
        VideoRequest r = req;
        if (r == null || player == null) return 0;
        if (pendingSeekMs >= 0) return pendingSeekMs;
        if (!everReady && player.getPlaybackState() != Player.STATE_READY) {
            // Still starting: the resume point, not the stream's 0.
            return r.seekable ? Math.max(r.toMediaMs(player.getCurrentPosition()), 0) : r.streamStartMs;
        }
        return r.toMediaMs(player.getCurrentPosition());
    }

    private long durationMs() {
        VideoRequest r = req;
        if (r == null) return 0;
        if (r.durationMs > 0) return r.durationMs;
        long d = player == null ? C.TIME_UNSET : player.getDuration();
        return d == C.TIME_UNSET ? 0 : r.toMediaMs(d);
    }

    private boolean isCompleted() {
        VideoRequest r = req;
        return r != null && VideoTimeline.completed(currentMediaMs(), durationMs(), r.segments);
    }

    private void onTick() {
        VideoRequest r = req;
        if (r == null || player == null) return;
        long pos = currentMediaMs();
        long dur = durationMs();
        long buffered = r.toMediaMs(player.getBufferedPosition());
        seekBar.setPosition(pos, buffered, dur);
        if (!seekBar.isScrubbing()) updateTimes(pos, dur);
        updateSkip(r, pos);
        updateUpNext(r, pos, dur);
        if (player.isPlaying() && SystemClock.elapsedRealtime() - lastProgressAt >= PROGRESS_INTERVAL_MS) emitProgress(false);
    }

    private void updateTimes(long pos, long dur) {
        VideoRequest r = req;
        time.setText(dur > 0 ? VideoTimeline.clock(pos) + " / " + VideoTimeline.clock(dur) : VideoTimeline.clock(pos));
        String ch = r == null ? null : VideoTimeline.chapterAt(r.chapters, pos);
        chapter.setText(ch == null ? "" : ch);
        if (dur > 0) {
            long left = Math.max(0, dur - pos);
            String ends = DateFormat.getTimeFormat(this).format(new Date(System.currentTimeMillis() + left));
            remaining.setText("−" + VideoTimeline.clock(left) + " · " + getString(R.string.video_ends_at, ends));
        } else {
            remaining.setText("");
        }
    }

    private void emitProgress(boolean paused) {
        VideoRequest r = req;
        if (r == null || closed || upNextFired) return;
        lastProgressAt = SystemClock.elapsedRealtime();
        controller.progress(r.itemKey, currentMediaMs(), durationMs(), paused);
    }

    // =====================================================================================
    // Seeking
    // =====================================================================================

    private void seekBy(long deltaMs) {
        seekTo(currentMediaMs() + deltaMs);
    }

    /** Seeks to a media time: in the player when seekable, else through JS (debounced). */
    private void seekTo(long mediaMs) {
        VideoRequest r = req;
        if (r == null || player == null) return;
        long target = VideoTimeline.clampSeek(mediaMs, durationMs());
        if (r.seekable) {
            player.seekTo(r.toPlayerMs(target));
            if (player.getPlaybackState() == Player.STATE_ENDED) player.play();
            onTick();
            return;
        }
        if (!controller.listens("videoSeekRequest")) return;
        pendingSeekMs = target;
        handler.removeCallbacks(sendSeek);
        handler.postDelayed(sendSeek, SEEK_REQUEST_DEBOUNCE_MS);
        onTick();
    }

    private void sendSeekRequest() {
        VideoRequest r = req;
        if (r == null || pendingSeekMs < 0) return;
        awaitingJs = true;
        updateLoading();
        controller.seekRequest(r.itemKey, pendingSeekMs, r.selectedAudio, r.selectedSubtitle);
    }

    @Override
    public void onScrubMove(long positionMs) {
        updateTimes(positionMs, durationMs());
    }

    @Override
    public void onScrubCommit(long positionMs) {
        seekTo(positionMs);
        scheduleHide();
    }

    @Override
    public void onInteraction() {
        showControls(false);
    }

    private void togglePlayPause() {
        if (player == null) return;
        if (player.getPlaybackState() == Player.STATE_ENDED) {
            seekTo(0);
            player.play();
        } else if (player.getPlayWhenReady()) {
            player.pause();
        } else {
            player.play();
        }
    }

    private void updatePlayPause() {
        boolean playing = player != null && player.getPlayWhenReady() && player.getPlaybackState() != Player.STATE_ENDED;
        playPause.setImageResource(playing ? R.drawable.ic_video_pause : R.drawable.ic_video_play);
        playPause.setContentDescription(getString(playing ? R.string.video_pause : R.string.video_play));
    }

    // =====================================================================================
    // Skip, up next
    // =====================================================================================

    private void updateSkip(VideoRequest r, long pos) {
        VideoRequest.Segment s = isInPip() ? null : VideoTimeline.activeSkip(r.segments, pos, r.next != null);
        if (s == shownSkip) return;
        shownSkip = s;
        if (s == null) {
            boolean hadFocus = skipButton.isFocused();
            skipButton.setVisibility(View.GONE);
            if (hadFocus && controls.getVisibility() == View.VISIBLE) playPause.requestFocus();
            return;
        }
        int label = s.type.equals("credits") ? R.string.video_skip_credits : s.type.equals("recap") ? R.string.video_skip_recap : R.string.video_skip_intro;
        skipButton.setText(label);
        skipButton.setVisibility(View.VISIBLE);
        // With the controls hidden, OK on the remote presses Skip.
        if (controls.getVisibility() != View.VISIBLE) skipButton.requestFocus();
    }

    private void skipSegment() {
        VideoRequest.Segment s = shownSkip;
        if (s == null) return;
        seekTo(s.endMs);
    }

    private void bindUpNext(@Nullable VideoRequest.Next next) {
        upNextArt.setImageDrawable(null);
        if (next == null) return;
        upNextTitle.setText(next.title);
        setText(upNextSubtitle, next.subtitle);
        if (next.artworkUrl == null) return;
        try {
            ListenableFuture<Bitmap> f = new DataSourceBitmapLoader(this).loadBitmap(Uri.parse(next.artworkUrl));
            final VideoRequest forReq = req;
            Futures.addCallback(f, new FutureCallback<Bitmap>() {
                @Override
                public void onSuccess(Bitmap bmp) {
                    if (req == forReq && !isDestroyed()) upNextArt.setImageBitmap(bmp);
                }

                @Override
                public void onFailure(@NonNull Throwable t) {
                    // No artwork: the card shows the title only.
                }
            }, ContextCompat.getMainExecutor(this));
        } catch (RuntimeException e) {
            Log.w(TAG, "Up-next artwork failed", e);
        }
    }

    private void updateUpNext(VideoRequest r, long pos, long dur) {
        if (r.next == null || upNextFired || upNextCancelled || isInPip()) {
            if (upNextShown && (upNextCancelled || isInPip())) hideUpNext();
            return;
        }
        long at = VideoTimeline.upNextAtMs(dur, r.segments);
        boolean due = at >= 0 && pos >= at && pendingSeekMs < 0;
        if (due && !upNextShown) {
            upNextShown = true;
            upNextStartedAt = SystemClock.elapsedRealtime();
            upNextCard.setVisibility(View.VISIBLE);
            upNextPlay.requestFocus();
        } else if (!due && upNextShown) {
            // Sought back before the credits.
            hideUpNext();
        }
        if (!upNextShown) return;
        // The countdown runs while playing; a pause holds it.
        if (!player.isPlaying()) upNextStartedAt += TICK_MS;
        long left = VideoTimeline.UP_NEXT_COUNTDOWN_MS - (SystemClock.elapsedRealtime() - upNextStartedAt);
        upNextLabel.setText(getString(R.string.video_up_next) + " · " + getString(R.string.video_playing_in, Math.max(0, (int) Math.ceil(left / 1000.0))));
        if (left <= 0) fireNext();
    }

    private void hideUpNext() {
        upNextShown = false;
        boolean hadFocus = upNextCard.hasFocus();
        upNextCard.setVisibility(View.GONE);
        if (hadFocus && controls.getVisibility() == View.VISIBLE) playPause.requestFocus();
    }

    private void cancelUpNext() {
        upNextCancelled = true;
        hideUpNext();
        showControls(true);
    }

    /** Up next fires: report the final position, tell JS, wait for its playVideo. */
    private void fireNext() {
        VideoRequest r = req;
        if (r == null || r.next == null || upNextFired) return;
        controller.progress(r.itemKey, currentMediaMs(), durationMs(), false);
        upNextFired = true;
        awaitingJs = true;
        hideUpNext();
        skipButton.setVisibility(View.GONE);
        player.pause();
        updateLoading();
        controller.next(r.next.itemKey);
    }

    // =====================================================================================
    // Track pickers
    // =====================================================================================

    private void showAudioPicker() {
        VideoRequest r = req;
        if (r == null || player == null) return;
        final List<String> labels = new ArrayList<>();
        int checked = -1;
        if (r.seekable) {
            // Direct play: the file's own tracks (labelled from JS when the lists line up).
            final List<Tracks.Group> audio = groups(player.getCurrentTracks(), C.TRACK_TYPE_AUDIO);
            if (audio.isEmpty()) return;
            boolean useJs = r.audioTracks.size() == audio.size();
            for (int i = 0; i < audio.size(); i++) {
                labels.add(useJs ? r.audioTracks.get(i).label : formatLabel(audio.get(i).getTrackFormat(0), i));
                if (audio.get(i).isSelected()) checked = i;
            }
            showPicker(R.string.video_audio, labels, checked, which -> {
                r.selectedAudio = which;
                player.setTrackSelectionParameters(player.getTrackSelectionParameters().buildUpon()
                        .setOverrideForType(new TrackSelectionOverride(audio.get(which).getMediaTrackGroup(), 0))
                        .build());
            });
            return;
        }
        if (r.audioTracks.isEmpty()) return;
        for (int i = 0; i < r.audioTracks.size(); i++) {
            labels.add(r.audioTracks.get(i).label);
            if (r.selectedAudio != null && r.audioTracks.get(i).index == r.selectedAudio) checked = i;
        }
        if (checked < 0) checked = 0;
        final int current = checked;
        showPicker(R.string.video_audio, labels, checked, which -> {
            if (which == current || !controller.listens("videoSeekRequest")) return;
            int ordinal = r.audioTracks.get(which).index;
            long pos = currentMediaMs();
            r.selectedAudio = ordinal;
            awaitingJs = true;
            updateLoading();
            controller.seekRequest(r.itemKey, pos, ordinal, r.selectedSubtitle);
        });
    }

    private void showSubtitlePicker() {
        VideoRequest r = req;
        if (r == null || player == null) return;
        List<String> labels = new ArrayList<>();
        labels.add(getString(R.string.video_subtitles_off));
        int checked = 0;
        for (int i = 0; i < r.subtitles.size(); i++) {
            labels.add(r.subtitles.get(i).label);
            if (r.subtitles.get(i).id.equals(r.selectedSubtitle)) checked = i + 1;
        }
        showPicker(R.string.video_subtitles, labels, checked, which -> {
            r.selectedSubtitle = which == 0 ? null : r.subtitles.get(which - 1).id;
            TrackSelectionParameters.Builder p = player.getTrackSelectionParameters().buildUpon();
            applySubtitleTo(p, player.getCurrentTracks(), r.selectedSubtitle);
            player.setTrackSelectionParameters(p.build());
        });
    }

    private interface Pick {
        void picked(int which);
    }

    private void showPicker(int titleRes, List<String> labels, int checked, Pick pick) {
        handler.removeCallbacks(hideControls);
        if (dialog != null) dialog.dismiss();
        dialog = new AlertDialog.Builder(this, R.style.VideoDialog)
                .setTitle(titleRes)
                .setSingleChoiceItems(labels.toArray(new CharSequence[0]), checked, (d, which) -> {
                    d.dismiss();
                    pick.picked(which);
                })
                .setOnDismissListener(d -> {
                    dialog = null;
                    enterImmersive();
                    scheduleHide();
                })
                .create();
        dialog.show();
    }

    private String formatLabel(Format f, int index) {
        StringBuilder sb = new StringBuilder();
        if (f.label != null) sb.append(f.label);
        else if (f.language != null && !f.language.equals(C.LANGUAGE_UNDETERMINED)) sb.append(new Locale(f.language).getDisplayLanguage());
        else sb.append(getString(R.string.video_track_n, index + 1));
        if (f.channelCount == 6) sb.append(" · 5.1");
        else if (f.channelCount == 8) sb.append(" · 7.1");
        else if (f.channelCount == 2) sb.append(" · 2.0");
        return sb.toString();
    }

    // =====================================================================================
    // Controls, keys
    // =====================================================================================

    private void showControls(boolean focusPlay) {
        if (isInPip()) return;
        boolean wasHidden = controls.getVisibility() != View.VISIBLE;
        if (wasHidden) {
            liftSubtitles(true);
            controls.setAlpha(0f);
            controls.setVisibility(View.VISIBLE);
            controls.animate().alpha(1f).setDuration(150).start();
        }
        View focused = getCurrentFocus();
        boolean focusOutside = focused == null || (!isInside(focused, controls) && focused != skipButton && !upNextCard.hasFocus());
        if ((focusPlay || wasHidden) && focusOutside && !upNextCard.hasFocus()) playPause.requestFocus();
        scheduleHide();
    }

    private void hideControlsNow() {
        handler.removeCallbacks(hideControls);
        if (controls.getVisibility() != View.VISIBLE) return;
        if (seekBar.isScrubbing() || dialog != null) {
            scheduleHide();
            return;
        }
        controls.animate().alpha(0f).setDuration(200).withEndAction(() -> {
            controls.setVisibility(View.INVISIBLE);
            liftSubtitles(false);
            if (skipButton.getVisibility() == View.VISIBLE) skipButton.requestFocus();
        }).start();
    }

    /** Subtitles move above the bottom controls while those show. */
    private void liftSubtitles(boolean lifted) {
        SubtitleView subs = playerView.getSubtitleView();
        if (subs != null) subs.setBottomPaddingFraction(lifted ? 0.24f : SubtitleView.DEFAULT_BOTTOM_PADDING_FRACTION);
    }

    private void scheduleHide() {
        handler.removeCallbacks(hideControls);
        if (player != null && player.isPlaying()) handler.postDelayed(hideControls, HIDE_CONTROLS_MS);
    }

    private static boolean isInside(View v, View parent) {
        View cur = v;
        while (cur != null) {
            if (cur == parent) return true;
            cur = cur.getParent() instanceof View ? (View) cur.getParent() : null;
        }
        return false;
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int code = event.getKeyCode();
        if (handleMediaKey(code, event)) return true;
        boolean down = event.getAction() == KeyEvent.ACTION_DOWN;
        boolean hidden = controls.getVisibility() != View.VISIBLE;
        if (hidden && !isInPip()) {
            switch (code) {
                case KeyEvent.KEYCODE_DPAD_LEFT:
                case KeyEvent.KEYCODE_DPAD_RIGHT:
                    if (upNextCard.hasFocus()) break;
                    // Left / right with the controls hidden: show them and scrub on the bar.
                    if (down) {
                        showControls(false);
                        seekBar.requestFocus();
                        seekBar.onKeyDown(code, event);
                    }
                    return true;
                case KeyEvent.KEYCODE_DPAD_CENTER:
                case KeyEvent.KEYCODE_ENTER:
                case KeyEvent.KEYCODE_NUMPAD_ENTER:
                    if (skipButton.isFocused() || upNextCard.hasFocus()) break;
                    if (down && event.getRepeatCount() == 0) {
                        togglePlayPause();
                        showControls(true);
                    }
                    return true;
                case KeyEvent.KEYCODE_DPAD_UP:
                case KeyEvent.KEYCODE_DPAD_DOWN:
                    if (skipButton.isFocused() || upNextCard.hasFocus()) break;
                    if (down) showControls(true);
                    return true;
                default:
                    break;
            }
        } else if (down && code != KeyEvent.KEYCODE_BACK) {
            scheduleHide();
        }
        return super.dispatchKeyEvent(event);
    }

    /** Remote / keyboard media keys, wherever the focus is. */
    private boolean handleMediaKey(int code, KeyEvent event) {
        boolean down = event.getAction() == KeyEvent.ACTION_DOWN;
        switch (code) {
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_HEADSETHOOK:
                if (down && event.getRepeatCount() == 0) {
                    togglePlayPause();
                    showControls(false);
                }
                return true;
            case KeyEvent.KEYCODE_MEDIA_PLAY:
                if (down && player != null) player.play();
                return true;
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
                if (down && player != null) {
                    player.pause();
                    showControls(false);
                }
                return true;
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
            case KeyEvent.KEYCODE_MEDIA_SKIP_FORWARD:
                if (down) {
                    seekBy(VideoTimeline.seekStepMs(event.getRepeatCount()));
                    showControls(false);
                }
                return true;
            case KeyEvent.KEYCODE_MEDIA_REWIND:
            case KeyEvent.KEYCODE_MEDIA_SKIP_BACKWARD:
                if (down) {
                    seekBy(-VideoTimeline.seekStepMs(event.getRepeatCount()));
                    showControls(false);
                }
                return true;
            case KeyEvent.KEYCODE_MEDIA_NEXT:
                if (down && event.getRepeatCount() == 0) fireNext();
                return true;
            case KeyEvent.KEYCODE_MEDIA_STOP:
                if (down) finishWithClose(false, null);
                return true;
            case KeyEvent.KEYCODE_CAPTIONS:
                if (down && event.getRepeatCount() == 0) showSubtitlePicker();
                return true;
            default:
                return false;
        }
    }

    // =====================================================================================
    // Picture-in-picture (phones; not on TV)
    // =====================================================================================

    private boolean pipSupported() {
        return !tv && Build.VERSION.SDK_INT >= 26 && getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE);
    }

    private boolean isInPip() {
        return Build.VERSION.SDK_INT >= 24 && isInPictureInPictureMode();
    }

    @Nullable
    private PictureInPictureParams pipParams() {
        if (Build.VERSION.SDK_INT < 26 || player == null) return null;
        PictureInPictureParams.Builder b = new PictureInPictureParams.Builder();
        VideoSize vs = player.getVideoSize();
        if (vs.width > 0 && vs.height > 0) {
            float ratio = vs.width * vs.pixelWidthHeightRatio / vs.height;
            ratio = Math.max(1 / 2.39f, Math.min(2.39f, ratio));
            b.setAspectRatio(new Rational(Math.round(ratio * 1000), 1000));
        }
        if (Build.VERSION.SDK_INT >= 31) {
            b.setAutoEnterEnabled(player.isPlaying());
            b.setSeamlessResizeEnabled(true);
        }
        return b.build();
    }

    private void updatePipParams() {
        if (!pipSupported() || closed) return;
        PictureInPictureParams p = pipParams();
        if (p == null) return;
        try {
            setPictureInPictureParams(p);
        } catch (RuntimeException e) {
            Log.w(TAG, "PiP params rejected", e);
        }
    }

    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        // Android 12+ enters on its own (auto-enter); older versions need the call.
        if (Build.VERSION.SDK_INT < 31 && pipSupported() && player != null && player.isPlaying()) {
            PictureInPictureParams p = pipParams();
            if (p != null) {
                try {
                    enterPictureInPictureMode(p);
                } catch (RuntimeException e) {
                    Log.w(TAG, "PiP failed", e);
                }
            }
        }
    }

    @Override
    public void onPictureInPictureModeChanged(boolean inPip, @NonNull Configuration newConfig) {
        super.onPictureInPictureModeChanged(inPip, newConfig);
        if (inPip) {
            handler.removeCallbacks(hideControls);
            controls.setVisibility(View.INVISIBLE);
            liftSubtitles(false);
            skipButton.setVisibility(View.GONE);
            upNextCard.setVisibility(View.GONE);
            shownSkip = null;
            upNextShown = false;
            if (dialog != null) dialog.dismiss();
        } else if (getLifecycle().getCurrentState() == Lifecycle.State.CREATED) {
            // The PiP window was dismissed (swiped away / closed).
            finishWithClose(false, null);
        } else {
            showControls(true);
        }
    }

    // =====================================================================================
    // Closing
    // =====================================================================================

    private void finishWithClose(boolean completed, @Nullable String error) {
        if (closed) return;
        closed = true;
        VideoRequest r = req;
        if (r != null && !upNextFired) {
            long pos = completed ? Math.max(currentMediaMs(), durationMs()) : currentMediaMs();
            controller.closed(r.itemKey, pos, durationMs(), completed || isCompleted(), error);
        } else if (r != null) {
            // Up next fired and JS never followed up: still report the close (completed).
            controller.closed(r.itemKey, durationMs(), durationMs(), true, error);
        }
        if (player != null) player.pause();
        finish();
        overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out);
    }

    private static void setText(TextView v, @Nullable String text) {
        v.setText(text == null ? "" : text);
        v.setVisibility(text == null || text.isEmpty() ? View.GONE : View.VISIBLE);
    }

    // =====================================================================================
    // Media session player
    // =====================================================================================

    /**
     * What remotes and the system see: media time (stream offset added, the item's duration) and
     * no seek commands on a stream that cannot seek (those go through the on-screen bar and JS).
     */
    private final class SessionPlayer extends ForwardingPlayer {
        SessionPlayer(Player player) {
            super(player);
        }

        private boolean canSeek() {
            return req != null && req.seekable;
        }

        @NonNull
        @Override
        public Commands getAvailableCommands() {
            Commands c = super.getAvailableCommands();
            if (canSeek()) return c;
            return c.buildUpon()
                    .removeAll(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM, Player.COMMAND_SEEK_BACK, Player.COMMAND_SEEK_FORWARD,
                            Player.COMMAND_SEEK_TO_DEFAULT_POSITION)
                    .build();
        }

        @Override
        public boolean isCommandAvailable(int command) {
            return getAvailableCommands().contains(command);
        }

        @Override
        public long getCurrentPosition() {
            return req == null ? super.getCurrentPosition() : req.toMediaMs(super.getCurrentPosition());
        }

        @Override
        public long getContentPosition() {
            return getCurrentPosition();
        }

        @Override
        public long getBufferedPosition() {
            return req == null ? super.getBufferedPosition() : req.toMediaMs(super.getBufferedPosition());
        }

        @Override
        public long getContentBufferedPosition() {
            return getBufferedPosition();
        }

        @Override
        public long getDuration() {
            return req != null && req.durationMs > 0 ? req.durationMs : super.getDuration();
        }

        @Override
        public long getContentDuration() {
            return getDuration();
        }

        @Override
        public void seekTo(long positionMs) {
            if (canSeek()) super.seekTo(req.toPlayerMs(positionMs));
        }

        @Override
        public void seekTo(int mediaItemIndex, long positionMs) {
            if (canSeek()) super.seekTo(mediaItemIndex, req.toPlayerMs(positionMs));
        }
    }
}

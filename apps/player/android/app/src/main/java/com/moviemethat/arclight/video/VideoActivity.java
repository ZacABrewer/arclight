package com.moviemethat.arclight.video;

import android.animation.ValueAnimator;
import android.app.PendingIntent;
import android.app.PictureInPictureParams;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.text.format.DateFormat;
import android.util.DisplayMetrics;
import android.util.Rational;
import android.util.TypedValue;
import android.view.FocusFinder;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.ProgressBar;
import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
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
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy;
import androidx.media3.session.MediaSession;
import androidx.media3.ui.CaptionStyleCompat;
import androidx.media3.ui.PlayerView;
import androidx.media3.ui.SubtitleView;
import com.moviemethat.arclight.R;
import com.moviemethat.arclight.SafeLog;
import com.moviemethat.arclight.player.PlaybackMapping;
import com.moviemethat.arclight.video.ui.ControlsView;
import com.moviemethat.arclight.video.ui.EpisodesPanel;
import com.moviemethat.arclight.video.ui.ImageLoader;
import com.moviemethat.arclight.video.ui.Overlay;
import com.moviemethat.arclight.video.ui.PauseGlyphView;
import com.moviemethat.arclight.video.ui.PauseInfoView;
import com.moviemethat.arclight.video.ui.SheetCache;
import com.moviemethat.arclight.video.ui.SidePanel;
import com.moviemethat.arclight.video.ui.SkipButton;
import com.moviemethat.arclight.video.ui.TracksPanel;
import com.moviemethat.arclight.video.ui.Ui;
import com.moviemethat.arclight.video.ui.UpNextCard;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The full-screen video player (playVideo). Media3 ExoPlayer plays the progressive stream the
 * server chose (direct file, remuxed fragmented MP4 or a transcode); PlayerView draws the picture
 * and subtitles; the overlay ({@code video/ui}, the redesign's §5) is ours and works with touch and
 * TV remotes (D-pad focus, media keys). Times shown and reported are media time: player time +
 * {@code streamStartMs}.
 *
 * <ul>
 *   <li>Seekable (direct) streams seek in the player. Otherwise a seek becomes a
 *       {@code videoSeekRequest} and JS answers with {@code replaceVideoStream}.</li>
 *   <li>Subtitles are the WebVTT links JS gives, side-loaded; when the stream starts later than
 *       media time 0 they are fetched and shifted ({@link VttShifter}) so cues line up.</li>
 *   <li>Audio: the file's own tracks in direct play; the JS list otherwise (a change re-requests).</li>
 *   <li>The overlay: controls with scrub thumbnails and chapter notches, the pause screen, the
 *       Episodes and Audio &amp; Subtitles panels, Skip intro / recap / credits, the up-next card.
 *       Every size is in the template's 1280x720 stage px, scaled to the window.</li>
 *   <li>Resume position, screen on, a media session for remotes, picture-in-picture on phones.</li>
 * </ul>
 */
@UnstableApi
public final class VideoActivity extends AppCompatActivity implements VideoSeekBar.Listener, Overlay.Listener {

    private static final String TAG = "ArclightVideo";
    private static final String USER_AGENT = "ArclightPlayer (android)";
    private static final long TICK_MS = 250;
    private static final long PROGRESS_INTERVAL_MS = 10_000;
    private static final long SEEK_REQUEST_DEBOUNCE_MS = 500;
    private static final int SUBTITLE_TIMEOUT_MS = 10_000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    /** Raw WebVTT per subtitle id (media time), so a stream change only re-shifts. */
    private final Map<String, String> rawVtt = new HashMap<>();
    private final VideoController controller = VideoController.get();
    private final ImageLoader images = new ImageLoader();
    private final SheetCache sheets = new SheetCache();

    private ExoPlayer player;
    @Nullable private MediaSession session;
    private PlayerView playerView;
    private ProgressBar loading;
    private Overlay overlay;

    // The overlay, rebuilt when the window size (stage scale) or the request's style changes.
    @Nullable private Ui ui;
    @Nullable private String uiStyleKey;
    private ControlsView controls;
    private PauseGlyphView glyph;
    private SkipButton skip;
    private UpNextCard upNext;
    private PauseInfoView pauseInfo;
    private EpisodesPanel episodes;
    private TracksPanel tracks;
    private boolean controlsShown;

    @Nullable private VideoRequest req;
    private boolean tv;
    private boolean closed;
    /** Bumped for every stream started: late subtitle work for an older one is dropped. */
    private int generation;
    private boolean tracksApplied;
    /** Read on the loader thread too (StartPolicy). */
    private volatile boolean everReady;
    /** Waiting for JS: a replaceVideoStream (seek / audio change) or the next / picked item. */
    private boolean awaitingJs;
    /** A seek target sent (or about to be sent) to JS, shown on the bar meanwhile; -1 = none. */
    private long pendingSeekMs = -1;
    private boolean upNextShown;
    private boolean upNextCancelled;
    private boolean upNextFired;
    /** Another episode was picked in the panel: JS answers with playVideo; progress is reported. */
    private boolean pickFired;
    /** Whether the item that fired up next counted as watched (false: "Next episode" mid-way). */
    private boolean upNextCompleted;
    private long upNextStartedAt;
    private long upNextHeldAt = -1;
    private long lastProgressAt;
    /** The intro was auto-skipped in this play ("Skip intros" pref: once per play). */
    private boolean introAutoSkipped;
    @Nullable private VideoRequest.Segment shownSkip;
    /** Since when the player is paused by the user (-1: playing / not paused). */
    private long pausedSince = -1;
    private long lastInputAt;
    /** The down time of a key press already handled (its repeats and up are swallowed). */
    private long swallowDownTime = -1;

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
        SafeLog.install();
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
        playerView = findViewById(R.id.video_view);
        loading = findViewById(R.id.video_loading);
        overlay = findViewById(R.id.video_overlay);
        overlay.setListener(this);
        createPlayer();
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                onBack();
            }
        });
        lastInputAt = SystemClock.elapsedRealtime();
        handler.post(tick);
        load(request);
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
            public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
                onPausedChanged();
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
        if (req != null && !closed) {
            // Gone without our own close path (PiP window dismissed, task removed, or recreated by
            // the system for a change not in configChanges: the new instance has no request and
            // finishes at once, so this is the end of playback either way).
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
        images.shutdown();
        sheets.shutdown();
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
    // The overlay
    // =====================================================================================

    /** Screen px per stage px for a window of {@code wPx} x {@code hPx}. */
    private float stageK(int wPx, int hPx) {
        float d = getResources().getDisplayMetrics().density;
        return OverlayMetrics.scale(wPx / d, hPx / d) * d;
    }

    /** The window size before the first layout (the overlay has no size yet). */
    private float initialK() {
        int w;
        int h;
        if (Build.VERSION.SDK_INT >= 30) {
            Rect b = getWindowManager().getCurrentWindowMetrics().getBounds();
            w = b.width();
            h = b.height();
        } else {
            DisplayMetrics m = new DisplayMetrics();
            //noinspection deprecation
            getWindowManager().getDefaultDisplay().getRealMetrics(m);
            w = m.widthPixels;
            h = m.heightPixels;
        }
        return stageK(w, h);
    }

    private Map<String, String> fallbackStrings() {
        Map<String, String> m = new HashMap<>();
        m.put("upNext", getString(R.string.video_up_next));
        m.put("playNow", getString(R.string.video_play_now));
        m.put("cancel", getString(R.string.video_cancel));
        m.put("nextIn", getString(R.string.video_next_in));
        m.put("skipIntro", getString(R.string.video_skip_intro));
        m.put("skipRecap", getString(R.string.video_skip_recap));
        m.put("skipCredits", getString(R.string.video_skip_credits));
        m.put("endsAt", getString(R.string.video_ends_at_time));
        m.put("audioSubtitles", getString(R.string.video_audio_subtitles));
        m.put("audio", getString(R.string.video_audio));
        m.put("subtitles", getString(R.string.video_subtitles));
        m.put("off", getString(R.string.video_subtitles_off));
        m.put("episodes", getString(R.string.video_episodes));
        m.put("nextEpisode", getString(R.string.video_next_episode));
        m.put("nowPlaying", getString(R.string.video_now_playing));
        return m;
    }

    private static boolean systemReducedMotion() {
        return Build.VERSION.SDK_INT >= 26 && !ValueAnimator.areAnimatorsEnabled();
    }

    private static String styleKey(VideoRequest r, float k) {
        return k + "|" + r.theme + "|" + r.strings + "|" + r.prefs.reduceMotion + "|" + r.prefs.focusStyle + "|"
                + r.prefs.subtitleSize;
    }

    /**
     * Builds (or rebuilds) the overlay for {@code r} at {@code k}, keeping what is showing. False
     * when the one built already fits (same scale and style).
     */
    private boolean buildOverlay(VideoRequest r, float k) {
        String key = styleKey(r, k);
        if (key.equals(uiStyleKey) && ui != null) return false;
        uiStyleKey = key;
        boolean wasShown = controls == null || controlsShown;
        boolean pauseShowing = pauseInfo != null && pauseInfo.isShowing();
        overlay.removeAllViews();
        OverlayStrings strings = new OverlayStrings(r.strings, fallbackStrings());
        Ui u = new Ui(this, k, new OverlayTheme(r.theme), strings, r.prefs.reduceMotion || systemReducedMotion(),
                r.prefs.cyanGlow());
        ui = u;
        overlay.setUi(u);

        glyph = new PauseGlyphView(this, u);
        glyph.setVisibility(View.GONE);
        overlay.addView(glyph, u.frame(u.px(96), u.px(96), Gravity.CENTER));

        controls = new ControlsView(this, u, sheets);
        overlay.addView(controls, u.frame(Ui.MATCH, Ui.MATCH, Gravity.TOP));
        controls.bar.setListener(this);
        controls.toggle.setOnClickListener(v -> {
            togglePlayPause();
            showControls(false);
        });
        controls.back10.setOnClickListener(v -> {
            seekBy(-10_000);
            showControls(false);
        });
        controls.fwd10.setOnClickListener(v -> {
            seekBy(10_000);
            showControls(false);
        });
        controls.next.setOnClickListener(v -> fireNext(false));
        controls.episodes.setOnClickListener(v -> openPanel(episodes));
        controls.tracks.setOnClickListener(v -> openTracks());

        skip = new SkipButton(this, u);
        overlay.addView(skip, skip.params());
        skip.setOnClickListener(v -> skipSegment());

        upNext = new UpNextCard(this, u, images);
        overlay.addView(upNext, upNext.params());
        upNext.playNow.setOnClickListener(v -> fireNext(true));
        upNext.cancel.setOnClickListener(v -> cancelUpNext());

        pauseInfo = new PauseInfoView(this, u, images);
        overlay.addView(pauseInfo, u.frame(Ui.MATCH, Ui.MATCH, Gravity.TOP));

        episodes = new EpisodesPanel(this, u, images);
        overlay.addView(episodes, episodes.params());
        episodes.setListener(this::pickEpisode);

        tracks = new TracksPanel(this, u);
        overlay.addView(tracks, tracks.params());
        tracks.setListener(new TracksPanel.Listener() {
            @Override
            public void onAudioPicked(int position) {
                pickAudio(position);
            }

            @Override
            public void onSubtitlePicked(int position) {
                pickSubtitle(position);
            }
        });

        applyCaptionStyle(r, u);
        bindOverlay(r);
        // Restore what was on screen.
        shownSkip = null;
        controlsShown = !wasShown;
        if (wasShown) showControlsNow(false);
        else hideControlsImmediately();
        if (upNextShown) {
            upNext.setVisibility(View.VISIBLE);
            upNext.setControlsShown(controlsShown);
        }
        if (pauseShowing) showPauseInfo();
        updatePlayPause();
        onTick();
        return true;
    }

    /** Per-item content of the overlay. */
    private void bindOverlay(VideoRequest r) {
        controls.setTitles(r.title, r.subtitle);
        controls.bar.setChapters(r.chapters);
        controls.preview.bind(r.trickplay);
        controls.next.setVisibility(r.next == null ? View.GONE : View.VISIBLE);
        boolean hasEpisodes = !r.seasons.isEmpty() && controller.listens("videoPickItem");
        controls.episodes.setVisibility(hasEpisodes ? View.VISIBLE : View.GONE);
        if (hasEpisodes) episodes.bind(r.seasons, r.panelSeason(), r.itemKey);
        upNext.bind(r.next, r.prefs.autoplayNext);
        pauseInfo.bind(pauseFor(r));
    }

    /** The pause screen's content: from JS, else the title, sub line and backdrop we have. */
    private static VideoRequest.Pause pauseFor(VideoRequest r) {
        if (r.pause != null) return r.pause;
        return new VideoRequest.Pause(r.title, r.subtitle, Collections.emptyList(), null, null, r.backdropUrl);
    }

    /** Captions as in the design: white 600 on black .6, 22 / 28 / 36 stage px. */
    private void applyCaptionStyle(VideoRequest r, Ui u) {
        SubtitleView subs = playerView.getSubtitleView();
        if (subs == null) return;
        subs.setStyle(new CaptionStyleCompat(Color.WHITE, 0x99000000, Color.TRANSPARENT,
                CaptionStyleCompat.EDGE_TYPE_NONE, Color.TRANSPARENT, Ui.font(600)));
        subs.setApplyEmbeddedStyles(false);
        subs.setApplyEmbeddedFontSizes(false);
        subs.setFixedTextSize(TypedValue.COMPLEX_UNIT_PX, u.pxf(VideoTimeline.captionSize(r.prefs.subtitleSize)));
        liftSubtitles(controlsShown);
    }

    @Override
    public void onOverlaySizeChanged(int w, int h) {
        VideoRequest r = req;
        if (r == null || closed || isInPip() || w <= 0 || h <= 0) return;
        buildOverlay(r, stageK(w, h));
        liftSubtitles(controlsShown);
    }

    @Override
    public void onBackgroundTap() {
        noteInput();
        if (pauseInfo.isShowing()) {
            hidePauseInfo();
            showControls(true);
            return;
        }
        SidePanel open = openPanel();
        if (open != null) {
            closePanel(open);
            return;
        }
        if (controlsShown) hideControlsNow();
        else showControls(false);
    }

    // =====================================================================================
    // Loading (called by VideoController)
    // =====================================================================================

    /** Plays {@code request} (first item, or up next / a picked episode / another playVideo). */
    void load(VideoRequest request) {
        VideoRequest old = req;
        if (old != null && !upNextFired && !pickFired && !old.itemKey.equals(request.itemKey)) {
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
        pickFired = false;
        upNextCompleted = false;
        upNextHeldAt = -1;
        introAutoSkipped = false;
        lastProgressAt = SystemClock.elapsedRealtime();
        shownSkip = null;
        handler.removeCallbacks(sendSeek);
        synchronized (rawVtt) {
            rawVtt.clear();
        }
        images.setHeaders(request.headers);
        sheets.bind(request.trickplay, request.headers);

        float k = overlay.getWidth() > 0 ? stageK(overlay.getWidth(), overlay.getHeight()) : initialK();
        if (controls != null) {
            controls.bar.cancelScrub();
            closePanels();
            hidePauseInfo();
        }
        if (!buildOverlay(request, k)) bindOverlay(request);
        upNext.setVisibility(View.GONE);
        skip.setVisibility(View.GONE);
        // A (re)build runs a tick, which can already show Skip (an intro from 0:00) or the up-next
        // card (a resume in the credits). They were just hidden, so the next tick decides afresh;
        // left set, Skip would stay hidden for the whole segment.
        shownSkip = null;
        upNextShown = false;

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
        // Keyed by item too: ids ("e0", "x12") repeat across items, and a fetch for the previous
        // episode can finish after load() cleared the cache.
        final String cachePrefix = r.itemKey + "|";
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
                        raw = rawVtt.get(cachePrefix + s.id);
                    }
                    if (raw == null) {
                        raw = fetchText(s.url, headers);
                        synchronized (rawVtt) {
                            rawVtt.put(cachePrefix + s.id, raw);
                        }
                    }
                    File f = new File(dir, gen + "-" + Math.abs(s.id.hashCode()) + ".vtt");
                    try (FileOutputStream out = new FileOutputStream(f)) {
                        out.write(VttShifter.shift(raw, offset).getBytes(StandardCharsets.UTF_8));
                    }
                    uri = Uri.fromFile(f);
                } catch (Exception e) {
                    SafeLog.w(TAG, "Subtitle " + s.id + " unavailable", e);
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
                .setConnectTimeoutMs(StartFailure.CONNECT_TIMEOUT_MS)
                // A transcode can take a while to produce its first bytes.
                .setReadTimeoutMs(45_000)
                .setDefaultRequestProperties(r.headers);
        DefaultMediaSourceFactory sources = new DefaultMediaSourceFactory(new DefaultDataSource.Factory(this, http))
                .setLoadErrorHandlingPolicy(new StartPolicy());
        player.setMediaSource(sources.createMediaSource(item.build()), r.seekable ? r.toPlayerMs(mediaPositionMs) : 0);
        player.prepare();
        player.setPlayWhenReady(playWhenReady);
    }

    /** Media3's retries, except for a server that cannot be reached at the start (StartFailure). */
    private final class StartPolicy extends DefaultLoadErrorHandlingPolicy {
        @Override
        public long getRetryDelayMsFor(@NonNull LoadErrorInfo info) {
            if (info.exception instanceof HttpDataSource.HttpDataSourceException) {
                HttpDataSource.HttpDataSourceException e = (HttpDataSource.HttpDataSourceException) info.exception;
                if (StartFailure.giveUp(everReady, e.type, e.reason)) return C.TIME_UNSET;
            }
            return super.getRetryDelayMsFor(info);
        }
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
        onPausedChanged();
    }

    private void updateLoading() {
        boolean busy = awaitingJs || player == null || player.getPlaybackState() == Player.STATE_BUFFERING
                || (player.getPlaybackState() == Player.STATE_IDLE && !closed);
        loading.setVisibility(busy ? View.VISIBLE : View.GONE);
        updateGlyph();
    }

    private void onEnded() {
        VideoRequest r = req;
        if (r == null || awaitingJs || closed) return;
        VideoTimeline.EndAction a = VideoTimeline.endAction(r.next != null, upNextCancelled, r.prefs.autoplayNext);
        if (a == VideoTimeline.EndAction.NEXT) fireNext(true);
        else finishWithClose(true, null);
    }

    private void onError(PlaybackException error) {
        int http = 0;
        Throwable cause = error.getCause();
        if (cause instanceof HttpDataSource.InvalidResponseCodeException) {
            http = ((HttpDataSource.InvalidResponseCodeException) cause).responseCode;
        }
        String code = PlaybackMapping.errorCode(error.errorCode, http, false);
        SafeLog.w(TAG, "Playback failed (" + code + ")", error);
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
            int i = TrackMatch.groupFor(r.audioTracks, fileTracks(audio), r.selectedAudio);
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
        // Closed: finish() is pending; nothing may fire (an up-next countdown would reopen the screen).
        if (r == null || player == null || closed || controls == null) return;
        long pos = currentMediaMs();
        long dur = durationMs();
        controls.bar.setPosition(pos, dur);
        if (!controls.bar.isScrubbing()) updateTimes(pos, dur);
        VideoRequest.Segment auto = VideoTimeline.autoSkip(r.segments, pos, r.prefs.skipIntros && !awaitingJs, introAutoSkipped);
        if (auto != null) {
            introAutoSkipped = true;
            seekTo(auto.endMs);
            pos = currentMediaMs();
        } else if (!introAutoSkipped && r.prefs.skipIntros && pos > 0) {
            // Started (or sought) past the intro: it is not skipped later in this play.
            for (VideoRequest.Segment s : r.segments) {
                if (s.type.equals("intro") && pos >= s.endMs) introAutoSkipped = true;
            }
        }
        updateSkip(r, pos);
        updateUpNext(r, pos, dur);
        updatePauseInfo();
        if (player.isPlaying() && SystemClock.elapsedRealtime() - lastProgressAt >= PROGRESS_INTERVAL_MS) emitProgress(false);
    }

    private void updateTimes(long pos, long dur) {
        controls.time.setText(dur > 0 ? VideoTimeline.clock(pos) + " / " + VideoTimeline.clock(dur) : VideoTimeline.clock(pos));
    }

    private String endsAtText() {
        long left = Math.max(0, durationMs() - currentMediaMs());
        Locale locale = getResources().getConfiguration().getLocales().get(0);
        String t = EndsAt.format(System.currentTimeMillis(), left, TimeZone.getDefault(), locale, DateFormat.is24HourFormat(this));
        return ui == null ? t : ui.strings.endsAt(t);
    }

    private void emitProgress(boolean paused) {
        VideoRequest r = req;
        if (r == null || closed || upNextFired || pickFired) return;
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
        if (r == null || pendingSeekMs < 0 || closed) return;
        awaitingJs = true;
        updateLoading();
        controller.seekRequest(r.itemKey, pendingSeekMs, r.selectedAudio, r.selectedSubtitle);
    }

    @Override
    public void onScrubMove(long positionMs) {
        VideoRequest r = req;
        if (r == null) return;
        handler.removeCallbacks(hideControls);
        updateTimes(positionMs, durationMs());
        controls.preview.show(positionMs, VideoTimeline.chapterAt(r.chapters, positionMs));
        controls.placePreview(positionMs);
    }

    @Override
    public void onScrubCommit(long positionMs) {
        controls.preview.hide();
        seekTo(positionMs);
        scheduleHide();
    }

    @Override
    public void onScrubCancel() {
        controls.preview.hide();
        updateTimes(currentMediaMs(), durationMs());
        scheduleHide();
    }

    @Override
    public void onBarSelect() {
        togglePlayPause();
        showControls(false);
    }

    @Override
    public void onInteraction() {
        noteInput();
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
        if (controls == null) return;
        boolean playing = player != null && player.getPlayWhenReady() && player.getPlaybackState() != Player.STATE_ENDED;
        controls.toggle.setPlaying(playing);
        controls.toggle.setContentDescription(getString(playing ? R.string.video_pause : R.string.video_play));
        updateGlyph();
    }

    // =====================================================================================
    // Paused: the glyph and the pause screen
    // =====================================================================================

    private boolean userPaused() {
        return player != null && !player.getPlayWhenReady() && player.getPlaybackState() != Player.STATE_ENDED
                && player.getPlaybackState() != Player.STATE_IDLE && !awaitingJs && !closed;
    }

    private void onPausedChanged() {
        boolean paused = userPaused();
        if (paused && pausedSince < 0) pausedSince = SystemClock.elapsedRealtime();
        if (!paused) {
            pausedSince = -1;
            hidePauseInfo();
        }
        updateGlyph();
    }

    /** The 96 px centred pause glyph, while paused and the pause screen is not up. */
    private void updateGlyph() {
        if (glyph == null) return;
        boolean show = userPaused() && !pauseInfo.isShowing() && !isInPip() && loading.getVisibility() != View.VISIBLE;
        glyph.setVisibility(show ? View.VISIBLE : View.GONE);
    }

    private void noteInput() {
        lastInputAt = SystemClock.elapsedRealtime();
    }

    private void updatePauseInfo() {
        if (pauseInfo == null) return;
        if (pauseInfo.isShowing()) {
            pauseInfo.setEndsAt(endsAtText());
            return;
        }
        boolean blocked = isInPip() || openPanel() != null || controls.bar.isScrubbing() || upNextShown;
        if (!blocked && VideoTimeline.pauseInfoDue(pausedSince, lastInputAt, SystemClock.elapsedRealtime())) showPauseInfo();
    }

    private void showPauseInfo() {
        pauseInfo.setEndsAt(endsAtText());
        hideControlsImmediately();
        skip.setVisibility(View.GONE);
        shownSkip = null;
        pauseInfo.show();
        overlay.setRingHidden(true);
        updateGlyph();
    }

    private void hidePauseInfo() {
        if (pauseInfo == null || !pauseInfo.isShowing()) return;
        pauseInfo.hide();
        overlay.setRingHidden(false);
        updateGlyph();
    }

    // =====================================================================================
    // Skip, up next
    // =====================================================================================

    private void updateSkip(VideoRequest r, long pos) {
        boolean blocked = isInPip() || pauseInfo.isShowing() || awaitingJs;
        VideoRequest.Segment s = blocked ? null : VideoTimeline.activeSkip(r.segments, pos, r.next != null);
        if (s == shownSkip) return;
        shownSkip = s;
        if (s == null) {
            boolean hadFocus = skip.isFocused();
            skip.setVisibility(View.GONE);
            if (hadFocus && controlsShown) controls.toggle.requestFocus();
            return;
        }
        String key = s.type.equals("credits") ? "skipCredits" : s.type.equals("recap") ? "skipRecap" : "skipIntro";
        skip.setText(ui.strings.get(key));
        skip.setControlsShown(controlsShown);
        skip.setVisibility(View.VISIBLE);
        // With the controls hidden, OK on the remote presses Skip.
        if (!controlsShown && openPanel() == null) skip.requestFocus();
    }

    private void skipSegment() {
        VideoRequest r = req;
        VideoRequest.Segment s = shownSkip;
        if (r == null || s == null) return;
        noteInput();
        if (VideoTimeline.skipEndsPlayback(s, r.next != null)) {
            // Credits with nothing next: the end (counted as completed).
            finishWithClose(true, null);
            return;
        }
        seekTo(s.endMs);
    }

    private void updateUpNext(VideoRequest r, long pos, long dur) {
        if (r.next == null || upNextFired || upNextCancelled || isInPip() || pickFired) {
            if (upNextShown && (upNextCancelled || isInPip())) hideUpNext();
            return;
        }
        long at = VideoTimeline.upNextAtMs(dur, r.segments);
        boolean due = at >= 0 && pos >= at && pendingSeekMs < 0;
        long now = SystemClock.elapsedRealtime();
        if (due && !upNextShown) {
            upNextShown = true;
            upNextStartedAt = now;
            upNextHeldAt = -1;
            hidePauseInfo();
            upNext.setControlsShown(controlsShown);
            upNext.setVisibility(View.VISIBLE);
            if (openPanel() == null) upNext.playNow.requestFocus();
        } else if (!due && upNextShown) {
            // Sought back before the credits.
            hideUpNext();
        }
        if (!upNextShown || !r.prefs.autoplayNext) return;
        // The countdown runs while playing; a pause (or an open panel) holds it.
        boolean running = player.isPlaying() && openPanel() == null;
        if (!running && upNextHeldAt < 0) upNextHeldAt = now;
        if (running && upNextHeldAt >= 0) {
            upNextStartedAt += now - upNextHeldAt;
            upNextHeldAt = -1;
        }
        long elapsed = (upNextHeldAt >= 0 ? upNextHeldAt : now) - upNextStartedAt;
        long left = VideoTimeline.UP_NEXT_COUNTDOWN_MS - elapsed;
        upNext.setCountdown(left, VideoTimeline.UP_NEXT_COUNTDOWN_MS, running);
        if (left <= 0) fireNext(true);
    }

    private void hideUpNext() {
        upNextShown = false;
        boolean hadFocus = upNext.hasFocus();
        upNext.setVisibility(View.GONE);
        if (hadFocus && controlsShown) controls.toggle.requestFocus();
    }

    private void cancelUpNext() {
        upNextCancelled = true;
        hideUpNext();
        showControls(true);
    }

    /**
     * Up next fires: report the final position, tell JS, wait for its playVideo. {@code atEnd}: the
     * countdown, the end of the stream or "Play now" on the card (the item counts as watched);
     * otherwise ("Next episode" button, media key) only when the position says so.
     */
    private void fireNext(boolean atEnd) {
        VideoRequest r = req;
        if (r == null || r.next == null || upNextFired || pickFired || closed) return;
        controller.progress(r.itemKey, currentMediaMs(), durationMs(), false);
        upNextCompleted = atEnd || isCompleted();
        upNextFired = true;
        awaitingJs = true;
        hideUpNext();
        skip.setVisibility(View.GONE);
        closePanels();
        player.pause();
        updateLoading();
        controller.next(r.next.itemKey, upNextCompleted);
    }

    // =====================================================================================
    // Panels: Episodes, Audio & Subtitles
    // =====================================================================================

    @Nullable
    private SidePanel openPanel() {
        if (episodes != null && episodes.isOpen()) return episodes;
        if (tracks != null && tracks.isOpen()) return tracks;
        return null;
    }

    private void openPanel(SidePanel p) {
        if (isInPip()) return;
        noteInput();
        closePanels();
        hidePauseInfo();
        handler.removeCallbacks(hideControls);
        p.open();
    }

    private void closePanel(SidePanel p) {
        p.close();
        View back = p == episodes ? controls.episodes : controls.tracks;
        if (controlsShown && back.getVisibility() == View.VISIBLE) back.requestFocus();
        else if (controlsShown) controls.toggle.requestFocus();
        scheduleHide();
    }

    private void closePanels() {
        if (episodes != null) episodes.close();
        if (tracks != null) tracks.close();
    }

    /** Another episode picked in the panel: report, pause, and ask JS to play it (§5.4). */
    private void pickEpisode(VideoRequest.Episode e) {
        VideoRequest r = req;
        if (r == null || closed) return;
        if (e.itemKey.equals(r.itemKey) || upNextFired || pickFired) {
            closePanel(episodes);
            return;
        }
        long pos = currentMediaMs();
        // Not marked completed: the position as it stands.
        controller.progress(r.itemKey, pos, durationMs(), true);
        pickFired = true;
        awaitingJs = true;
        hideUpNext();
        skip.setVisibility(View.GONE);
        closePanels();
        player.pause();
        updateLoading();
        controller.pickItem(e.itemKey, r.itemKey, pos);
    }

    /** The file's audio groups in direct play (empty otherwise). */
    private List<Tracks.Group> fileAudio() {
        VideoRequest r = req;
        if (r == null || player == null || !r.seekable) return Collections.emptyList();
        return groups(player.getCurrentTracks(), C.TRACK_TYPE_AUDIO);
    }

    /** The file's audio groups as TrackMatch sees them. */
    private static List<TrackMatch.FileTrack> fileTracks(List<Tracks.Group> groups) {
        List<TrackMatch.FileTrack> out = new ArrayList<>();
        for (Tracks.Group g : groups) {
            Format f = g.getTrackFormat(0);
            out.add(new TrackMatch.FileTrack(f.language, f.label, f.sampleMimeType, f.channelCount));
        }
        return out;
    }

    /** The request's audio track whose JS index is {@code index}, or null. */
    @Nullable
    private static VideoRequest.AudioTrack jsTrack(VideoRequest r, @Nullable Integer index) {
        if (index == null) return null;
        for (VideoRequest.AudioTrack a : r.audioTracks) if (a.index == index) return a;
        return null;
    }

    private void openTracks() {
        VideoRequest r = req;
        if (r == null || player == null) return;
        List<String> audio = new ArrayList<>();
        int audioSel = -1;
        List<Tracks.Group> file = fileAudio();
        if (r.seekable && !file.isEmpty()) {
            // Direct play: the file's own tracks, labelled from JS where one confidently matches.
            List<TrackMatch.FileTrack> mapped = fileTracks(file);
            for (int i = 0; i < file.size(); i++) {
                VideoRequest.AudioTrack js = jsTrack(r, TrackMatch.jsIndexFor(r.audioTracks, mapped, i));
                audio.add(js != null ? js.label : formatLabel(file.get(i).getTrackFormat(0), i));
                if (file.get(i).isSelected()) audioSel = i;
            }
        } else if (!r.seekable) {
            for (int i = 0; i < r.audioTracks.size(); i++) {
                audio.add(r.audioTracks.get(i).label);
                if (r.selectedAudio != null && r.audioTracks.get(i).index == r.selectedAudio) audioSel = i;
            }
            if (audioSel < 0 && !audio.isEmpty()) audioSel = 0;
        }
        List<String> subs = new ArrayList<>();
        int subSel = 0;
        for (int i = 0; i < r.subtitles.size(); i++) {
            subs.add(r.subtitles.get(i).label);
            if (r.subtitles.get(i).id.equals(r.selectedSubtitle)) subSel = i + 1;
        }
        tracks.bind(audio, audioSel, subs, subSel);
        openPanel(tracks);
    }

    private void pickAudio(int which) {
        VideoRequest r = req;
        if (r == null || player == null) return;
        noteInput();
        if (r.seekable) {
            List<Tracks.Group> file = fileAudio();
            if (which < 0 || which >= file.size()) return;
            player.setTrackSelectionParameters(player.getTrackSelectionParameters().buildUpon()
                    .setOverrideForType(new TrackSelectionOverride(file.get(which).getMediaTrackGroup(), 0))
                    .build());
            // JS knows tracks by its own ordinal, not ExoPlayer's group position: report the
            // matching one, or nothing (and no remembered audio) when no track matches for sure.
            Integer js = TrackMatch.jsIndexFor(r.audioTracks, fileTracks(file), which);
            r.selectedAudio = js;
            if (js != null) controller.tracksChanged(r.itemKey, js, r.selectedSubtitle);
            return;
        }
        if (which < 0 || which >= r.audioTracks.size()) return;
        int ordinal = r.audioTracks.get(which).index;
        if (r.selectedAudio != null && r.selectedAudio == ordinal) return;
        if (!controller.listens("videoSeekRequest")) return;
        long pos = currentMediaMs();
        r.selectedAudio = ordinal;
        awaitingJs = true;
        updateLoading();
        controller.seekRequest(r.itemKey, pos, ordinal, r.selectedSubtitle);
        controller.tracksChanged(r.itemKey, ordinal, r.selectedSubtitle);
    }

    private void pickSubtitle(int which) {
        VideoRequest r = req;
        if (r == null || player == null) return;
        noteInput();
        r.selectedSubtitle = which <= 0 || which > r.subtitles.size() ? null : r.subtitles.get(which - 1).id;
        TrackSelectionParameters.Builder p = player.getTrackSelectionParameters().buildUpon();
        applySubtitleTo(p, player.getCurrentTracks(), r.selectedSubtitle);
        player.setTrackSelectionParameters(p.build());
        controller.tracksChanged(r.itemKey, r.selectedAudio, r.selectedSubtitle);
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
        if (isInPip() || controls == null) return;
        hidePauseInfo();
        showControlsNow(focusPlay);
    }

    private void showControlsNow(boolean focusPlay) {
        boolean wasHidden = !controlsShown;
        controlsShown = true;
        liftSubtitles(true);
        skip.setControlsShown(true);
        upNext.setControlsShown(true);
        // Cancelling also stops a fade-in still running from a call just before (load() and a
        // rebuild both show the controls): that left them "shown" at alpha 0, invisible but
        // holding the focus, so the first keys of a stream moved an unseen focus and Enter pressed
        // the hidden Play. Fade in from wherever the alpha is instead.
        controls.animate().cancel();
        controls.setVisibility(View.VISIBLE);
        if (wasHidden) controls.setAlpha(0f);
        if (controls.getAlpha() < 1f) {
            long d = ui.anim(150);
            if (d == 0) {
                controls.setAlpha(1f);
            } else {
                controls.animate().alpha(1f).setDuration(d).setUpdateListener(a -> overlay.invalidate()).start();
            }
        }
        if (openPanel() == null) {
            View focused = getCurrentFocus();
            boolean focusOutside = focused == null || (!isInside(focused, controls) && focused != skip && !upNext.hasFocus());
            if ((focusPlay || wasHidden) && focusOutside) controls.toggle.requestFocus();
        }
        scheduleHide();
    }

    private void hideControlsNow() {
        handler.removeCallbacks(hideControls);
        if (!controlsShown || controls == null) return;
        if (controls.bar.isScrubbing() || openPanel() != null) {
            scheduleHide();
            return;
        }
        controlsShown = false;
        skip.setControlsShown(false);
        upNext.setControlsShown(false);
        liftSubtitles(false);
        controls.animate().cancel();
        long d = ui.anim(200);
        Runnable done = () -> {
            controls.setVisibility(View.INVISIBLE);
            if (skip.getVisibility() == View.VISIBLE) skip.requestFocus();
            else if (upNext.getVisibility() == View.VISIBLE) upNext.playNow.requestFocus();
        };
        if (d == 0) {
            controls.setAlpha(0f);
            done.run();
        } else {
            controls.animate().alpha(0f).setDuration(d).setUpdateListener(a -> overlay.invalidate()).withEndAction(done).start();
        }
    }

    /** Hides the controls at once (the pause screen, PiP, a rebuild while hidden). */
    private void hideControlsImmediately() {
        handler.removeCallbacks(hideControls);
        if (controls == null) return;
        controls.bar.cancelScrub();
        controls.animate().cancel();
        controls.setAlpha(0f);
        controls.setVisibility(View.INVISIBLE);
        controlsShown = false;
        skip.setControlsShown(false);
        upNext.setControlsShown(false);
        liftSubtitles(false);
    }

    /** Captions at bottom 232 stage px with the controls shown, 72 without (§5.1). */
    private void liftSubtitles(boolean lifted) {
        SubtitleView subs = playerView.getSubtitleView();
        Ui u = ui;
        if (subs == null || u == null) return;
        // Bottom padding, not setBottomPaddingFraction: WebVTT cues without a line setting carry an
        // explicit line of -1, and Media3 ignores the padding fraction for positioned cues. The
        // view's own padding shrinks the box every cue is laid out in.
        subs.setBottomPaddingFraction(0f);
        int pad = u.px(OverlayMetrics.captionBottom(lifted));
        if (subs.getPaddingBottom() != pad) subs.setPadding(0, 0, 0, pad);
    }

    private void scheduleHide() {
        handler.removeCallbacks(hideControls);
        if (player != null && player.isPlaying() && openPanel() == null) {
            handler.postDelayed(hideControls, VideoTimeline.CONTROLS_IDLE_MS);
        }
    }

    private static boolean isInside(View v, View parent) {
        View cur = v;
        while (cur != null) {
            if (cur == parent) return true;
            cur = cur.getParent() instanceof View ? (View) cur.getParent() : null;
        }
        return false;
    }

    /** Back: the pause screen, then a scrub preview, then a panel, then the player (§5.1, §5.3). */
    private void onBack() {
        noteInput();
        if (controls != null) {
            if (pauseInfo.isShowing()) {
                hidePauseInfo();
                showControls(true);
                return;
            }
            if (controls.bar.isScrubbing()) {
                controls.bar.cancelScrub();
                return;
            }
            SidePanel p = openPanel();
            if (p != null) {
                closePanel(p);
                return;
            }
        }
        finishWithClose(false, null);
    }

    private static boolean isEnter(int code) {
        return code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER || code == KeyEvent.KEYCODE_NUMPAD_ENTER;
    }

    private static boolean isDirection(int code) {
        return code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT
                || code == KeyEvent.KEYCODE_DPAD_UP || code == KeyEvent.KEYCODE_DPAD_DOWN;
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        // Finishing from onCreate (no request): the views were never built.
        if (req == null || controls == null) return super.dispatchKeyEvent(event);
        int code = event.getKeyCode();
        boolean down = event.getAction() == KeyEvent.ACTION_DOWN;
        if (down) noteInput();

        // The rest of a press already handled (its repeats and its up).
        if (swallowDownTime >= 0 && event.getDownTime() == swallowDownTime) {
            if (!down) swallowDownTime = -1;
            return true;
        }

        if (handleMediaKey(code, event)) return true;
        if (code == KeyEvent.KEYCODE_BACK) return super.dispatchKeyEvent(event);

        // The pause screen: any key goes back to the normal paused UI.
        if (pauseInfo.isShowing() && !isInPip()) {
            if (down) {
                swallowDownTime = event.getDownTime();
                hidePauseInfo();
                showControls(true);
            }
            return true;
        }

        // A panel is open: the focus stays inside it.
        SidePanel panel = openPanel();
        if (panel != null) {
            if (isDirection(code)) {
                if (down) panel.moveFocus(code);
                return true;
            }
            return super.dispatchKeyEvent(event);
        }

        if (!controlsShown && !isInPip()) {
            switch (code) {
                case KeyEvent.KEYCODE_DPAD_LEFT:
                case KeyEvent.KEYCODE_DPAD_RIGHT:
                    if (upNext.hasFocus()) break;
                    // Left / right with the UI hidden: ±10 s, and the UI wakes with the bar focused.
                    if (down) {
                        swallowDownTime = event.getDownTime();
                        seekBy(code == KeyEvent.KEYCODE_DPAD_RIGHT ? 10_000 : -10_000);
                        showControls(false);
                        controls.bar.requestFocus();
                    }
                    return true;
                case KeyEvent.KEYCODE_DPAD_CENTER:
                case KeyEvent.KEYCODE_ENTER:
                case KeyEvent.KEYCODE_NUMPAD_ENTER:
                    if (upNext.hasFocus()) break;
                    if (down) {
                        swallowDownTime = event.getDownTime();
                        // Enter presses Skip when it shows, else toggles play.
                        if (skip.getVisibility() == View.VISIBLE) {
                            skipSegment();
                        } else {
                            togglePlayPause();
                            showControls(true);
                        }
                    }
                    return true;
                case KeyEvent.KEYCODE_DPAD_UP:
                case KeyEvent.KEYCODE_DPAD_DOWN:
                    if (skip.isFocused() || upNext.hasFocus()) break;
                    if (down) {
                        swallowDownTime = event.getDownTime();
                        showControls(true);
                    }
                    return true;
                default:
                    if (down && event.getRepeatCount() == 0) showControls(false);
                    break;
            }
        } else if (down) {
            scheduleHide();
            if ((code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT) && staysInRow(code)) return true;
            // Down from the bar lands on Play, not on whichever pill sits nearest the knob (leaving
            // the bar cancels a scrub preview, as any focus loss does).
            if (code == KeyEvent.KEYCODE_DPAD_DOWN && controls.bar.isFocused()) {
                controls.toggle.requestFocus(View.FOCUS_DOWN);
                return true;
            }
        }
        return super.dispatchKeyEvent(event);
    }

    /**
     * Left / right on the button row stays in that row: at its end the focus stays put instead of
     * jumping diagonally to the bar or the corner buttons (Android's fallback search). True when
     * the key was consumed.
     */
    private boolean staysInRow(int code) {
        View focused = getCurrentFocus();
        if (focused == null || focused.getParent() != controls.buttonRow) return false;
        int dir = code == KeyEvent.KEYCODE_DPAD_LEFT ? View.FOCUS_LEFT : View.FOCUS_RIGHT;
        View next = FocusFinder.getInstance().findNextFocus((ViewGroup) controls.buttonRow, focused, dir);
        if (next == null) return true;
        next.requestFocus(dir);
        return true;
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
                if (down && event.getRepeatCount() == 0) fireNext(false);
                return true;
            case KeyEvent.KEYCODE_MEDIA_STOP:
                if (down) finishWithClose(false, null);
                return true;
            case KeyEvent.KEYCODE_CAPTIONS:
                if (down && event.getRepeatCount() == 0 && !isInPip()) {
                    hidePauseInfo();
                    showControls(false);
                    openTracks();
                }
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
            SafeLog.w(TAG, "PiP params rejected", e);
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
                    SafeLog.w(TAG, "PiP failed", e);
                }
            }
        }
    }

    @Override
    public void onPictureInPictureModeChanged(boolean inPip, @NonNull Configuration newConfig) {
        super.onPictureInPictureModeChanged(inPip, newConfig);
        if (controls == null) return;
        if (inPip) {
            hideControlsImmediately();
            hidePauseInfo();
            closePanels();
            overlay.setVisibility(View.INVISIBLE);
            skip.setVisibility(View.GONE);
            upNext.setVisibility(View.GONE);
            shownSkip = null;
            upNextShown = false;
        } else if (getLifecycle().getCurrentState() == Lifecycle.State.CREATED) {
            // The PiP window was dismissed (swiped away / closed).
            finishWithClose(false, null);
        } else {
            overlay.setVisibility(View.VISIBLE);
            // The window is full size again: rebuild for it if the scale changed, then show.
            overlay.post(() -> {
                if (closed || req == null) return;
                if (overlay.getWidth() > 0) buildOverlay(req, stageK(overlay.getWidth(), overlay.getHeight()));
                showControls(true);
            });
        }
        updateGlyph();
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
            controller.closed(r.itemKey, pos, durationMs(), completed || (!pickFired && isCompleted()), error);
        } else if (r != null) {
            // Up next fired and JS never followed up: still report the close (completed when the
            // up next counted it as watched, else where it stopped).
            long pos = upNextCompleted ? durationMs() : currentMediaMs();
            controller.closed(r.itemKey, pos, durationMs(), upNextCompleted, error);
        }
        handler.removeCallbacks(tick);
        handler.removeCallbacks(sendSeek);
        if (player != null) player.pause();
        finish();
        overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out);
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

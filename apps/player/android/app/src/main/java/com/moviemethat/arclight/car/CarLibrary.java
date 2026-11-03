package com.moviemethat.arclight.car;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import androidx.annotation.Nullable;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.util.UnstableApi;
import com.moviemethat.arclight.SafeLog;
import com.moviemethat.arclight.player.PlaybackHub;
import java.io.File;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Process-wide state for Android Auto: the browse broker (JS first, cached tree otherwise),
 * recent search results, the artwork URLs the {@link ArtworkProvider} may serve, and the car
 * connection count.
 */
@UnstableApi
public final class CarLibrary {

    private static final String TAG = "ArclightCar";
    /** How long the car waits for JS before native serves the cached tree. */
    static final long JS_TIMEOUT_MS = 4500;

    // Android Auto content-style / completion extras (androidx.media.utils.MediaConstants values).
    private static final String EXTRA_COMPLETION_STATUS = "android.media.extra.PLAYBACK_STATUS";
    private static final String EXTRA_COMPLETION_PERCENTAGE = "androidx.media.MediaItem.Extras.COMPLETION_PERCENTAGE";
    static final String EXTRA_SEARCH_SUPPORTED = "android.media.browse.SEARCH_SUPPORTED";

    @SuppressWarnings("StaticFieldLeak") // application context only
    private static CarLibrary instance;

    public static synchronized CarLibrary get(Context context) {
        if (instance == null) instance = new CarLibrary(context.getApplicationContext());
        return instance;
    }

    /** An artwork URL (http(s) or a local path) and the headers to fetch it with. */
    static final class ArtworkEntry {
        final String url;
        final Map<String, String> headers;

        ArtworkEntry(String url, Map<String, String> headers) {
            this.url = url;
            this.headers = headers;
        }
    }

    private final Context app;
    private final ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "arclight-car");
        t.setDaemon(true);
        return t;
    });
    private final BrowseBroker broker;
    private final Map<String, ArtworkEntry> artwork = new ConcurrentHashMap<>();
    private final Map<String, List<BrowseNodeInfo>> searchResults = Collections.synchronizedMap(
            new LinkedHashMap<String, List<BrowseNodeInfo>>(16, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, List<BrowseNodeInfo>> eldest) {
                    return size() > 8;
                }
            });
    private int carConnections;

    private CarLibrary(Context app) {
        this.app = app;
        File file = new File(new File(app.getFilesDir(), "arclight-player"), "browse-tree.json");
        BrowseCache cache = BrowseCache.load(file);
        final PlaybackHub hub = PlaybackHub.get(app);
        broker = new BrowseBroker(cache, file, new BrowseBroker.Requester() {
            @Override
            public boolean canAsk() {
                return hub.jsListens("browseRequest");
            }

            @Override
            public void ask(String requestId, String parentId, String query) {
                JSONObject o = new JSONObject();
                try {
                    o.put("requestId", requestId);
                    if (parentId != null) o.put("parentId", parentId);
                    if (query != null) o.put("query", query);
                } catch (JSONException e) {
                    throw new IllegalStateException(e);
                }
                hub.emit("browseRequest", o, false);
            }
        }, executor, JS_TIMEOUT_MS);
    }

    public BrowseBroker broker() {
        return broker;
    }

    ScheduledExecutorService executor() {
        return executor;
    }

    void putSearchResults(String query, List<BrowseNodeInfo> nodes) {
        searchResults.put(normalize(query), nodes);
    }

    @Nullable
    List<BrowseNodeInfo> searchResults(String query) {
        return searchResults.get(normalize(query));
    }

    private static String normalize(String q) {
        return q == null ? "" : q.trim().toLowerCase(Locale.ROOT);
    }

    // ---- car connection ----------------------------------------------------------------

    /** Android Auto (phone projection) and Android Automotive's media host. */
    static boolean isCarPackage(String pkg) {
        return "com.google.android.projection.gearhead".equals(pkg)
                || "com.android.car.media".equals(pkg);
    }

    synchronized void carConnected(boolean connected) {
        int before = carConnections;
        carConnections = Math.max(0, carConnections + (connected ? 1 : -1));
        if ((before == 0) == (carConnections == 0)) return; // no change in "is a car there"
        JSONObject o = new JSONObject();
        try {
            o.put("connected", carConnections > 0);
            o.put("kind", "android-auto");
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
        PlaybackHub.get(app).emit("carConnection", o, false);
    }

    // ---- browse rows → MediaItems -----------------------------------------------------

    /** Top-level rows shown when JS never sent a tree (fresh install, app not opened yet). */
    List<BrowseNodeInfo> defaultRoot() {
        String[][] rows = {
            {"continue", "Continue"}, {"albums", "Albums"}, {"artists", "Artists"},
            {"playlists", "Playlists"}, {"books", "Books"}, {"downloads", "Downloads"},
        };
        List<BrowseNodeInfo> out = new ArrayList<>();
        for (String[] r : rows) out.add(new BrowseNodeInfo(r[0], r[1], null, null, null, true, false, null));
        return out;
    }

    MediaItem rootItem() {
        Bundle extras = new Bundle();
        extras.putBoolean(EXTRA_SEARCH_SUPPORTED, true);
        MediaMetadata md = new MediaMetadata.Builder()
                .setTitle("Arclight")
                .setIsBrowsable(true)
                .setIsPlayable(false)
                .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
                .setExtras(extras)
                .build();
        return new MediaItem.Builder().setMediaId(BrowseCache.ROOT_ID).setMediaMetadata(md).build();
    }

    List<MediaItem> toMediaItems(List<BrowseNodeInfo> nodes, @Nullable String grantTo) {
        List<MediaItem> out = new ArrayList<>(nodes.size());
        for (BrowseNodeInfo n : nodes) out.add(toMediaItem(n, grantTo));
        return out;
    }

    MediaItem toMediaItem(BrowseNodeInfo n, @Nullable String grantTo) {
        MediaMetadata.Builder md = new MediaMetadata.Builder()
                .setTitle(n.title)
                .setSubtitle(n.subtitle)
                .setArtist(n.subtitle)
                .setIsBrowsable(n.browsable)
                .setIsPlayable(n.playable)
                .setMediaType(mediaTypeOf(n));
        Uri art = artworkUri(n, grantTo);
        if (art != null) md.setArtworkUri(art);
        if (n.progress != null) {
            Bundle extras = new Bundle();
            double p = n.progress;
            extras.putInt(EXTRA_COMPLETION_STATUS, p <= 0 ? 0 : p >= 0.99 ? 2 : 1);
            extras.putDouble(EXTRA_COMPLETION_PERCENTAGE, p);
            md.setExtras(extras);
        }
        return new MediaItem.Builder().setMediaId(n.id).setMediaMetadata(md.build()).build();
    }

    private static int mediaTypeOf(BrowseNodeInfo n) {
        String id = n.id;
        if (id.startsWith("album:")) return MediaMetadata.MEDIA_TYPE_ALBUM;
        if (id.startsWith("artist:")) return MediaMetadata.MEDIA_TYPE_ARTIST;
        if (id.startsWith("playlist:")) return MediaMetadata.MEDIA_TYPE_PLAYLIST;
        if (id.startsWith("book:")) return MediaMetadata.MEDIA_TYPE_AUDIO_BOOK;
        if (n.browsable) return MediaMetadata.MEDIA_TYPE_FOLDER_MIXED;
        return MediaMetadata.MEDIA_TYPE_MUSIC;
    }

    /**
     * The URI the car loads a row's artwork from. Artwork that needs headers (the server's
     * Bearer-protected route) or lives in app storage goes through {@link ArtworkProvider}, with
     * read access granted to the car app only.
     */
    @Nullable
    Uri artworkUri(BrowseNodeInfo n, @Nullable String grantTo) {
        String url = n.artworkUrl;
        if (url == null) return null;
        String lower = url.toLowerCase(Locale.ROOT);
        boolean remote = lower.startsWith("http://") || lower.startsWith("https://");
        if (remote && n.artworkHeaders.isEmpty()) return Uri.parse(url);
        if (!remote && !url.startsWith("/") && !lower.startsWith("file://")) return null;
        String key = registerArtwork(url, n.artworkHeaders);
        Uri uri = ArtworkProvider.uriFor(app, key);
        if (grantTo != null) {
            try {
                app.grantUriPermission(grantTo, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (SecurityException e) {
                SafeLog.w(TAG, "Could not grant artwork access to " + grantTo, e);
            }
        }
        return uri;
    }

    String registerArtwork(String url, Map<String, String> headers) {
        String key = sha1(url);
        artwork.put(key, new ArtworkEntry(url, headers));
        return key;
    }

    /** The artwork for a provider key; rebuilt from the browse cache after a process restart. */
    @Nullable
    ArtworkEntry artworkFor(String key) {
        ArtworkEntry e = artwork.get(key);
        if (e != null) return e;
        for (BrowseNodeInfo n : broker.cache().allNodes()) {
            if (n.artworkUrl != null && sha1(n.artworkUrl).equals(key)) {
                e = new ArtworkEntry(n.artworkUrl, n.artworkHeaders);
                artwork.put(key, e);
                return e;
            }
        }
        return null;
    }

    static String sha1(String s) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-1").digest(s.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(d.length * 2);
            for (byte b : d) sb.append(String.format(Locale.ROOT, "%02x", b & 0xff));
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}

package com.moviemethat.arclight.video.ui;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.util.LruCache;
import androidx.annotation.Nullable;
import com.moviemethat.arclight.video.VideoRequest;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Trickplay sprite sheets (§5.3): decoded with BitmapFactory at {@code inSampleSize} 1 (tiles
 * stay sharp) in RGB_565, kept in an LRU of three sheets. Asking for a sheet also prefetches its
 * neighbours. {@link Listener#onSheetReady} runs on the main thread.
 */
public final class SheetCache {

    public interface Listener {
        void onSheetReady(int sheet);
    }

    private static final String TAG = "ArclightVideo";
    private static final int MAX_SHEETS = 3;
    static final long RETRY_MS = 10_000;

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final LruCache<Integer, Bitmap> sheets = new LruCache<>(MAX_SHEETS);
    private final Set<Integer> loading = new HashSet<>();
    /** Sheets that failed for this item, with when: retried after {@link #RETRY_MS}, not on every scrub step. */
    private final Map<Integer, Long> failed = new java.util.HashMap<>();
    @Nullable private VideoRequest.Trickplay trickplay;
    private Map<String, String> headers = java.util.Collections.emptyMap();
    /** Bumped on every {@link #bind}: late decodes for the previous item are dropped. */
    private int generation;
    @Nullable private Listener listener;
    private boolean closed;

    public void setListener(@Nullable Listener l) {
        listener = l;
    }

    /** A new item (or none): drops every sheet. */
    public void bind(@Nullable VideoRequest.Trickplay t, Map<String, String> headers) {
        generation++;
        trickplay = t;
        this.headers = headers;
        sheets.evictAll();
        loading.clear();
        failed.clear();
    }

    /** The sheet if decoded; otherwise null and it (plus its neighbours) starts loading. */
    @Nullable
    public Bitmap get(int sheet) {
        VideoRequest.Trickplay t = trickplay;
        if (t == null || sheet < 0 || sheet >= t.sheets.size()) return null;
        Bitmap b = sheets.get(sheet);
        request(sheet);
        if (sheet + 1 < t.sheets.size()) request(sheet + 1);
        if (sheet > 0) request(sheet - 1);
        return b;
    }

    private void request(int sheet) {
        VideoRequest.Trickplay t = trickplay;
        if (t == null || closed || sheets.get(sheet) != null || loading.contains(sheet) || recentlyFailed(sheet)) return;
        loading.add(sheet);
        final int gen = generation;
        final String url = t.sheets.get(sheet);
        final Map<String, String> h = headers;
        try {
            io.execute(() -> {
                Bitmap bmp = null;
                try {
                    byte[] data = ImageLoader.fetch(url, h);
                    BitmapFactory.Options o = new BitmapFactory.Options();
                    o.inSampleSize = 1;
                    o.inPreferredConfig = Bitmap.Config.RGB_565;
                    bmp = BitmapFactory.decodeByteArray(data, 0, data.length, o);
                } catch (Exception e) {
                    Log.w(TAG, "Trickplay sheet " + sheet + " unavailable", e);
                }
                final Bitmap result = bmp;
                main.post(() -> {
                    if (closed || gen != generation) return;
                    loading.remove(sheet);
                    if (result == null) {
                        failed.put(sheet, SystemClock.elapsedRealtime());
                        return;
                    }
                    failed.remove(sheet);
                    sheets.put(sheet, result);
                    Listener l = listener;
                    if (l != null) l.onSheetReady(sheet);
                });
            });
        } catch (java.util.concurrent.RejectedExecutionException e) {
            loading.remove(sheet);
        }
    }

    private boolean recentlyFailed(int sheet) {
        Long at = failed.get(sheet);
        return at != null && SystemClock.elapsedRealtime() - at < RETRY_MS;
    }

    public void shutdown() {
        closed = true;
        io.shutdownNow();
        sheets.evictAll();
    }
}

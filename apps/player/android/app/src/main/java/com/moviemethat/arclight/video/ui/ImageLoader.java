package com.moviemethat.arclight.video.ui;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.util.LruCache;
import android.widget.ImageView;
import androidx.annotation.Nullable;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Small image loader for the overlay (episode thumbnails, up-next art, the pause screen's logo
 * and backdrop): fetched with the request headers, decoded down to the width it is shown at,
 * kept in a byte-sized LRU. Results for a view that was rebound meanwhile are dropped.
 */
public final class ImageLoader {

    private static final String TAG = "ArclightVideo";
    private static final int TIMEOUT_MS = 15_000;

    private final ExecutorService io = Executors.newFixedThreadPool(2);
    private final Handler main = new Handler(Looper.getMainLooper());
    private final LruCache<String, Bitmap> cache = new LruCache<String, Bitmap>(24 * 1024 * 1024) {
        @Override
        protected int sizeOf(String key, Bitmap value) {
            return value.getByteCount();
        }
    };
    private volatile Map<String, String> headers = java.util.Collections.emptyMap();
    private volatile boolean closed;

    public void setHeaders(Map<String, String> headers) {
        this.headers = headers;
    }

    public interface Callback {
        void loaded(@Nullable Bitmap bmp);
    }

    /** Loads {@code url} into {@code view} (cleared first); {@code done} runs with the result. */
    public void into(ImageView view, @Nullable String url, int targetWidthPx, @Nullable Callback done) {
        view.setImageDrawable(null);
        Object marker = new Object();
        view.setTag(marker);
        if (url == null) {
            if (done != null) done.loaded(null);
            return;
        }
        final String key = url + "#" + targetWidthPx;
        Bitmap hit = cache.get(key);
        if (hit != null) {
            view.setImageBitmap(hit);
            if (done != null) done.loaded(hit);
            return;
        }
        load(url, targetWidthPx, bmp -> {
            if (view.getTag() != marker) return;
            if (bmp != null) view.setImageBitmap(bmp);
            if (done != null) done.loaded(bmp);
        });
    }

    /** Loads a bitmap (null on failure); the callback runs on the main thread. */
    public void load(String url, int targetWidthPx, Callback done) {
        final String key = url + "#" + targetWidthPx;
        Bitmap hit = cache.get(key);
        if (hit != null) {
            done.loaded(hit);
            return;
        }
        final Map<String, String> h = headers;
        try {
            io.execute(() -> {
                Bitmap bmp = null;
                try {
                    byte[] data = fetch(url, h);
                    bmp = decode(data, targetWidthPx);
                } catch (Exception e) {
                    Log.w(TAG, "Overlay image unavailable", e);
                }
                final Bitmap result = bmp;
                if (result != null) cache.put(key, result);
                main.post(() -> {
                    if (!closed) done.loaded(result);
                });
            });
        } catch (java.util.concurrent.RejectedExecutionException e) {
            // Shut down (the activity is finishing).
        }
    }

    public void shutdown() {
        closed = true;
        io.shutdownNow();
        cache.evictAll();
    }

    static byte[] fetch(String url, Map<String, String> headers) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(TIMEOUT_MS);
        c.setReadTimeout(TIMEOUT_MS);
        c.setRequestProperty("User-Agent", "ArclightPlayer (android)");
        for (Map.Entry<String, String> e : headers.entrySet()) c.setRequestProperty(e.getKey(), e.getValue());
        try {
            int code = c.getResponseCode();
            if (code / 100 != 2) throw new IOException("HTTP " + code);
            try (InputStream in = c.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                return out.toByteArray();
            }
        } finally {
            c.disconnect();
        }
    }

    @Nullable
    private static Bitmap decode(byte[] data, int targetWidthPx) {
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(data, 0, data.length, o);
        int sample = 1;
        if (targetWidthPx > 0 && o.outWidth > 0) {
            while (o.outWidth / (sample * 2) >= targetWidthPx) sample *= 2;
        }
        BitmapFactory.Options d = new BitmapFactory.Options();
        d.inSampleSize = sample;
        return BitmapFactory.decodeByteArray(data, 0, data.length, d);
    }
}

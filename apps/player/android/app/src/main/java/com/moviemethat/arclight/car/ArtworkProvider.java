package com.moviemethat.arclight.car;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.media3.common.util.UnstableApi;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;
import java.util.Map;

/**
 * Serves car browse artwork as {@code content://<applicationId>.artwork/<key>} so Android Auto
 * can show covers that need the server's Bearer header or live in app storage. Not exported:
 * the car app gets per-URI read grants ({@link CarLibrary#artworkUri}). Only URLs the browse
 * tree registered can be fetched (the key is the SHA-1 of a registered URL), so this is not an
 * open proxy. Downloaded covers are kept in the cache directory.
 */
@UnstableApi
public final class ArtworkProvider extends ContentProvider {

    private static final String TAG = "ArclightArtwork";
    private static final long MAX_BYTES = 8L * 1024 * 1024;

    public static Uri uriFor(Context context, String key) {
        return new Uri.Builder().scheme("content").authority(context.getPackageName() + ".artwork").appendPath(key).build();
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Nullable
    @Override
    public ParcelFileDescriptor openFile(@NonNull Uri uri, @NonNull String mode) throws FileNotFoundException {
        Context context = getContext();
        if (context == null || !"r".equals(mode)) throw new FileNotFoundException("read-only");
        String key = uri.getLastPathSegment();
        if (key == null || !key.matches("[0-9a-f]{40}")) throw new FileNotFoundException("bad key");
        CarLibrary.ArtworkEntry entry = CarLibrary.get(context).artworkFor(key);
        if (entry == null) throw new FileNotFoundException("unknown artwork");
        File file = localFile(context, entry.url);
        if (file == null) file = cached(context, key, entry);
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    /** A local artwork path, only inside the app's own storage. */
    @Nullable
    private static File localFile(Context context, String url) throws FileNotFoundException {
        String path;
        if (url.startsWith("/")) path = url;
        else if (url.toLowerCase(Locale.ROOT).startsWith("file://")) path = Uri.parse(url).getPath();
        else return null;
        if (path == null) throw new FileNotFoundException("bad path");
        try {
            File f = new File(path).getCanonicalFile();
            String files = context.getFilesDir().getCanonicalPath() + File.separator;
            String cache = context.getCacheDir().getCanonicalPath() + File.separator;
            File ext = context.getExternalFilesDir(null);
            String extPath = ext == null ? null : ext.getCanonicalPath() + File.separator;
            String p = f.getPath();
            if (!(p.startsWith(files) || p.startsWith(cache) || (extPath != null && p.startsWith(extPath)))) {
                throw new FileNotFoundException("outside app storage");
            }
            if (!f.isFile()) throw new FileNotFoundException("missing");
            return f;
        } catch (IOException e) {
            throw new FileNotFoundException(e.getMessage());
        }
    }

    private static File cached(Context context, String key, CarLibrary.ArtworkEntry entry) throws FileNotFoundException {
        File dir = new File(context.getCacheDir(), "car-artwork");
        File file = new File(dir, key);
        if (file.isFile() && file.length() > 0) return file;
        if (!dir.isDirectory() && !dir.mkdirs()) throw new FileNotFoundException("no cache dir");
        File tmp = new File(dir, key + ".tmp" + Thread.currentThread().getId());
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(entry.url).openConnection();
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(15000);
            conn.setInstanceFollowRedirects(true);
            for (Map.Entry<String, String> h : entry.headers.entrySet()) conn.setRequestProperty(h.getKey(), h.getValue());
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) throw new FileNotFoundException("HTTP " + code);
            long total = 0;
            try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(tmp)) {
                byte[] buf = new byte[16 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    total += n;
                    if (total > MAX_BYTES) throw new FileNotFoundException("artwork too large");
                    out.write(buf, 0, n);
                }
            }
            if (!tmp.renameTo(file)) throw new FileNotFoundException("rename failed");
            return file;
        } catch (IOException e) {
            Log.w(TAG, "Artwork fetch failed", e);
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            throw e instanceof FileNotFoundException ? (FileNotFoundException) e : new FileNotFoundException(e.getMessage());
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    @Nullable
    @Override
    public String getType(@NonNull Uri uri) {
        return "image/*";
    }

    @Nullable
    @Override
    public Cursor query(@NonNull Uri uri, @Nullable String[] projection, @Nullable String selection, @Nullable String[] selectionArgs, @Nullable String sortOrder) {
        return null;
    }

    @Nullable
    @Override
    public Uri insert(@NonNull Uri uri, @Nullable ContentValues values) {
        return null;
    }

    @Override
    public int delete(@NonNull Uri uri, @Nullable String selection, @Nullable String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(@NonNull Uri uri, @Nullable ContentValues values, @Nullable String selection, @Nullable String[] selectionArgs) {
        return 0;
    }
}

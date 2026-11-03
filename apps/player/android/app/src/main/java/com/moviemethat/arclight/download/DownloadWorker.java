package com.moviemethat.arclight.download;

import android.app.Notification;
import android.content.Context;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.SystemClock;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationChannelCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.media3.common.util.UnstableApi;
import androidx.work.ForegroundInfo;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import com.moviemethat.arclight.R;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;

/**
 * Downloads one file (one WorkManager job per task). Resumes a partial file with HTTP Range
 * (guarded by If-Range), writes to {@code <dest>.part} and renames on completion. Runs as a
 * dataSync foreground job with a progress notification when the system allows it.
 */
@UnstableApi
public final class DownloadWorker extends Worker {

    static final String KEY_ID = "id";
    private static final String LOG_TAG = "ArclightDownload";
    private static final String CHANNEL_ID = "arclight-downloads";
    private static final int MAX_RUN_ATTEMPTS = 8;
    private static final long PROGRESS_EVENT_MS = 500;
    private static final long PROGRESS_SAVE_MS = 5000;
    private static final long NOTIFICATION_MS = 1000;

    private boolean foreground;

    public DownloadWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        String id = getInputData().getString(KEY_ID);
        if (id == null) return Result.failure();
        DownloadCenter center = DownloadCenter.get(getApplicationContext());
        DownloadStore store = center.store();
        DownloadTaskInfo t = store.get(id);
        if (t == null || DownloadTaskInfo.PAUSED.equals(t.status) || DownloadTaskInfo.COMPLETED.equals(t.status)) {
            return Result.success();
        }
        File target;
        try {
            target = DownloadPaths.fileFor(center.dir(), t.destName);
        } catch (IllegalArgumentException e) {
            return fail(center, t, e.getMessage(), 0, false);
        }
        File part = DownloadPaths.partFor(target);
        File parent = target.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            return fail(center, t, "Cannot create the download folder", 0, false);
        }
        store.update(id, x -> {
            x.status = DownloadTaskInfo.RUNNING;
            x.reason = null;
        });
        goForeground(t, part.isFile() ? part.length() : 0, t.totalBytes);

        try {
            for (int round = 0; round < 3; round++) {
                long partial = part.isFile() ? part.length() : 0;
                store.reconcileWithPartial(id, partial);
                DownloadTaskInfo cur = store.get(id);
                if (cur == null) return cancelled(part);
                HttpURLConnection conn = open(cur, partial);
                try {
                    int status = conn.getResponseCode();
                    ResumePlanner.Decision d = ResumePlanner.decide(partial, status,
                            conn.getHeaderField("Content-Range"), conn.getContentLengthLong());
                    switch (d.action) {
                        case COMPLETE:
                            return finish(center, id, part, target);
                        case DISCARD_AND_RETRY:
                            //noinspection ResultOfMethodCallIgnored
                            part.delete();
                            store.update(id, x -> x.validator = null);
                            continue;
                        case FAIL_PERMANENT:
                            //noinspection ResultOfMethodCallIgnored
                            part.delete();
                            return fail(center, cur, "HTTP " + status, status, false);
                        case FAIL_RETRY:
                            return retryOrFail(center, id, "HTTP " + status, status);
                        case APPEND:
                        case RESTART:
                        default:
                            break;
                    }
                    final boolean append = d.action == ResumePlanner.Action.APPEND;
                    final long total = d.totalBytes;
                    final String validator = validatorOf(conn);
                    store.update(id, x -> {
                        if (total >= 0) x.totalBytes = total;
                        if (!append || x.validator == null) x.validator = validator;
                        if (!append) x.bytesWritten = 0;
                    });
                    Result r = copy(center, id, conn, part, append, total);
                    if (r != null) return r;
                    long written = part.length();
                    if (!ResumePlanner.lengthMatches(written, total)) {
                        return retryOrFail(center, id, "Connection closed early", 0);
                    }
                    return finish(center, id, part, target);
                } finally {
                    conn.disconnect();
                }
            }
            return retryOrFail(center, id, "The server kept rejecting the resume range", 0);
        } catch (IOException e) {
            if (isStopped()) return stopped(center, id, part);
            Log.w(LOG_TAG, "Download " + id + " failed", e);
            return retryOrFail(center, id, e.getClass().getSimpleName() + ": " + e.getMessage(), 0);
        }
    }

    private HttpURLConnection open(DownloadTaskInfo t, long partial) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(t.url).openConnection();
        conn.setConnectTimeout(20000);
        conn.setReadTimeout(30000);
        conn.setInstanceFollowRedirects(true);
        // Byte-exact lengths (Range and gzip do not mix).
        conn.setRequestProperty("Accept-Encoding", "identity");
        conn.setRequestProperty("User-Agent", "ArclightPlayer (android)");
        for (Map.Entry<String, String> h : t.headers.entrySet()) conn.setRequestProperty(h.getKey(), h.getValue());
        String range = ResumePlanner.rangeHeader(partial);
        if (range != null) {
            conn.setRequestProperty("Range", range);
            if (t.validator != null) conn.setRequestProperty("If-Range", t.validator);
        }
        return conn;
    }

    @Nullable
    private static String validatorOf(HttpURLConnection conn) {
        String etag = conn.getHeaderField("ETag");
        if (etag != null && !etag.startsWith("W/")) return etag;
        return conn.getHeaderField("Last-Modified");
    }

    /** Streams the body into the partial file. Returns a Result when the job must end early. */
    @Nullable
    private Result copy(DownloadCenter center, String id, HttpURLConnection conn, File part, boolean append, long total) throws IOException {
        DownloadStore store = center.store();
        long written = append ? part.length() : 0;
        long lastEvent = 0;
        long lastSave = SystemClock.elapsedRealtime();
        long lastNotify = 0;
        DownloadTaskInfo info = store.get(id);
        try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(part, append)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                written += n;
                if (isStopped()) {
                    out.flush();
                    return stopped(center, id, part);
                }
                long now = SystemClock.elapsedRealtime();
                if (now - lastEvent >= PROGRESS_EVENT_MS) {
                    lastEvent = now;
                    final long w = written;
                    boolean known = store.updateInMemory(id, x -> {
                        x.bytesWritten = w;
                        if (!DownloadTaskInfo.PAUSED.equals(x.status)) x.status = DownloadTaskInfo.RUNNING;
                    });
                    if (!known) {
                        out.close();
                        return cancelled(part);
                    }
                    DownloadTaskInfo cur = store.get(id);
                    if (cur != null && DownloadTaskInfo.PAUSED.equals(cur.status)) {
                        return Result.success();
                    }
                    center.emitProgress(id, written, total);
                    if (now - lastSave >= PROGRESS_SAVE_MS) {
                        lastSave = now;
                        store.save();
                    }
                    if (foreground && info != null && now - lastNotify >= NOTIFICATION_MS) {
                        lastNotify = now;
                        goForeground(info, written, total);
                    }
                }
            }
        }
        return null;
    }

    private Result finish(DownloadCenter center, String id, File part, File target) {
        if (target.exists() && !target.delete()) {
            return fail(center, center.store().get(id), "Cannot replace " + target.getName(), 0, false);
        }
        if (!part.renameTo(target)) {
            return fail(center, center.store().get(id), "Cannot move the finished file into place", 0, false);
        }
        final long size = target.length();
        final String path = target.getAbsolutePath();
        DownloadStore store = center.store();
        if (!store.update(id, x -> {
            x.status = DownloadTaskInfo.COMPLETED;
            x.path = path;
            x.bytesWritten = size;
            x.totalBytes = size;
            x.reason = null;
        })) {
            // Cancelled at the last moment: the contract says cancel deletes the file.
            //noinspection ResultOfMethodCallIgnored
            target.delete();
            return Result.success();
        }
        center.emitProgress(id, size, size);
        center.emitCompleted(store.get(id), target);
        return Result.success();
    }

    private Result retryOrFail(DownloadCenter center, String id, String message, int httpStatus) {
        DownloadTaskInfo t = center.store().get(id);
        if (t == null) return Result.success();
        if (getRunAttemptCount() + 1 >= MAX_RUN_ATTEMPTS) return fail(center, t, message, httpStatus, true);
        center.store().update(id, x -> {
            x.status = DownloadTaskInfo.WAITING;
            x.reason = message;
            x.httpStatus = httpStatus;
        });
        return Result.retry();
    }

    private Result fail(DownloadCenter center, @Nullable DownloadTaskInfo t, String message, int httpStatus, boolean retryable) {
        if (t == null) return Result.failure();
        center.store().update(t.id, x -> {
            x.status = DownloadTaskInfo.FAILED;
            x.reason = message;
            x.httpStatus = httpStatus;
            x.retryable = retryable;
        });
        center.emitFailed(t.id, message, httpStatus, retryable);
        return Result.failure();
    }

    /** The system stopped the job (constraints lost, pause, quota): keep the partial file. */
    private Result stopped(DownloadCenter center, String id, File part) {
        DownloadStore store = center.store();
        DownloadTaskInfo t = store.get(id);
        if (t == null) return cancelled(part);
        store.update(id, x -> {
            x.bytesWritten = part.length();
            if (DownloadTaskInfo.RUNNING.equals(x.status)) {
                x.status = DownloadTaskInfo.WAITING;
                x.reason = x.wifiOnly ? "wifi" : "network";
            }
        });
        return Result.retry();
    }

    private static Result cancelled(File part) {
        //noinspection ResultOfMethodCallIgnored
        part.delete();
        return Result.success();
    }

    // ---- foreground notification -------------------------------------------------------------

    private void goForeground(DownloadTaskInfo t, long written, long total) {
        try {
            setForegroundAsync(foregroundInfo(t, written, total)).get();
            foreground = true;
        } catch (Exception e) {
            // Android 12+ may refuse a foreground start from the background; the job still runs
            // (and resumes via Range if the system stops it).
            if (!foreground) Log.i(LOG_TAG, "Downloading without a foreground notification: " + e.getMessage());
        }
    }

    @NonNull
    @Override
    public ForegroundInfo getForegroundInfo() {
        // Used by WorkManager for expedited work on old Android versions.
        DownloadTaskInfo t = DownloadCenter.get(getApplicationContext()).store().get(getInputData().getString(KEY_ID));
        return foregroundInfo(t, t == null ? 0 : t.bytesWritten, t == null ? -1 : t.totalBytes);
    }

    private ForegroundInfo foregroundInfo(@Nullable DownloadTaskInfo t, long written, long total) {
        Context ctx = getApplicationContext();
        NotificationManagerCompat nm = NotificationManagerCompat.from(ctx);
        nm.createNotificationChannel(new NotificationChannelCompat.Builder(CHANNEL_ID, NotificationManagerCompat.IMPORTANCE_LOW)
                .setName(ctx.getString(R.string.downloads_channel))
                .build());
        String title = t != null && t.title != null ? t.title : ctx.getString(R.string.downloading);
        boolean known = total > 0;
        int pct = known ? (int) Math.min(100, written * 100 / total) : 0;
        Notification n = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_arclight)
                .setContentTitle(title)
                .setContentText(ctx.getString(R.string.downloading))
                .setProgress(100, pct, !known)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setCategory(NotificationCompat.CATEGORY_PROGRESS)
                .build();
        int notificationId = 0x4000 + ((t == null ? 0 : t.id.hashCode()) & 0x3fff);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return new ForegroundInfo(notificationId, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        }
        return new ForegroundInfo(notificationId, n);
    }
}

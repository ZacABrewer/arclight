package com.moviemethat.arclight.download;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import androidx.annotation.Nullable;
import androidx.media3.common.util.UnstableApi;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import com.moviemethat.arclight.player.PlaybackHub;
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Downloads for offline listening: one WorkManager job per file ({@link DownloadWorker}), with a
 * network constraint for Wi-Fi-only, HTTP Range resume, pause / resume / cancel and progress
 * events. Files go to {@code <filesDir>/arclight-downloads/<destName>} (app-private, Capacitor's
 * Data directory), so the player and the WebView can use them directly.
 */
@UnstableApi
public final class DownloadCenter {

    static final String WORK_PREFIX = "arclight-dl:";
    static final String TAG = "arclight-download";
    /** Free space kept beyond a download's expected size. */
    private static final long SPACE_MARGIN = 32L * 1024 * 1024;

    @SuppressWarnings("StaticFieldLeak") // application context only
    private static DownloadCenter instance;

    public static synchronized DownloadCenter get(Context context) {
        if (instance == null) instance = new DownloadCenter(context.getApplicationContext());
        return instance;
    }

    private final Context app;
    private final File dir;
    private final DownloadStore store;

    private DownloadCenter(Context app) {
        this.app = app;
        this.dir = new File(app.getFilesDir(), DownloadPaths.DIR);
        this.store = new DownloadStore(new File(new File(app.getFilesDir(), "arclight-player"), "downloads.json"));
    }

    public File dir() {
        return dir;
    }

    DownloadStore store() {
        return store;
    }

    // ---- contract methods ----------------------------------------------------------------

    /** enqueueDownload. Re-enqueueing a known id returns the known task unchanged. */
    public DownloadTaskInfo enqueue(JSONObject request) {
        DownloadTaskInfo t = DownloadTaskInfo.fromRequest(request);
        DownloadTaskInfo known = store.get(t.id);
        if (known != null) return known;
        File target = DownloadPaths.fileFor(dir, t.destName);
        File part = DownloadPaths.partFor(target);
        if (target.isFile() && !part.exists()) {
            // Already on disk (an earlier run finished and JS forgot): report it as done.
            t.status = DownloadTaskInfo.COMPLETED;
            t.path = target.getAbsolutePath();
            t.bytesWritten = target.length();
            t.totalBytes = target.length();
            store.put(t);
            emitCompleted(t, target);
            return t;
        }
        if (t.expectedBytes > 0) {
            if (!dir.isDirectory()) //noinspection ResultOfMethodCallIgnored
                dir.mkdirs();
            long free = (dir.isDirectory() ? dir : app.getFilesDir()).getUsableSpace();
            long needed = t.expectedBytes - (part.isFile() ? part.length() : 0) + SPACE_MARGIN;
            if (free < needed) {
                t.status = DownloadTaskInfo.FAILED;
                t.reason = "Not enough free storage";
                t.retryable = false;
                store.put(t);
                emitFailed(t.id, t.reason, 0, false);
                return t;
            }
        }
        t.bytesWritten = part.isFile() ? part.length() : 0;
        store.put(t);
        schedule(t, ExistingWorkPolicy.KEEP);
        return t;
    }

    public void pause(String id) {
        if (!store.update(id, t -> {
            if (t.isActive()) {
                t.status = DownloadTaskInfo.PAUSED;
                t.reason = null;
            }
        })) throw new IllegalArgumentException("Unknown download " + id);
        WorkManager.getInstance(app).cancelUniqueWork(WORK_PREFIX + id);
    }

    public void resume(String id) {
        DownloadTaskInfo t = store.get(id);
        if (t == null) throw new IllegalArgumentException("Unknown download " + id);
        if (DownloadTaskInfo.COMPLETED.equals(t.status)) return;
        store.update(id, x -> {
            x.status = DownloadTaskInfo.QUEUED;
            x.reason = null;
            x.httpStatus = 0;
        });
        schedule(store.get(id), ExistingWorkPolicy.REPLACE);
    }

    public void cancel(String id) {
        DownloadTaskInfo t = store.remove(id);
        WorkManager.getInstance(app).cancelUniqueWork(WORK_PREFIX + id);
        if (t != null && !DownloadTaskInfo.COMPLETED.equals(t.status)) {
            File target = DownloadPaths.fileFor(dir, t.destName);
            //noinspection ResultOfMethodCallIgnored
            DownloadPaths.partFor(target).delete();
        }
    }

    /** listDownloads: active / failed tasks, plus completed ones (reported once, then forgotten). */
    public List<DownloadTaskInfo> list() {
        List<DownloadTaskInfo> out = new ArrayList<>();
        String wait = waitReason();
        for (DownloadTaskInfo t : store.all()) {
            if (DownloadTaskInfo.COMPLETED.equals(t.status)) continue;
            if (DownloadTaskInfo.QUEUED.equals(t.status) || DownloadTaskInfo.WAITING.equals(t.status)) {
                String r = t.wifiOnly && "metered".equals(wait) ? "wifi" : "offline".equals(wait) ? "network" : null;
                if (r != null) {
                    final String reason = r;
                    store.updateInMemory(t.id, x -> {
                        x.status = DownloadTaskInfo.WAITING;
                        x.reason = reason;
                    });
                }
            }
            out.add(store.get(t.id));
        }
        out.addAll(store.drainCompleted());
        return out;
    }

    /** deleteDownload: the file (relative destName or absolute path) and any task for it. */
    public void delete(String nameOrPath) {
        File f = DownloadPaths.resolveForDelete(dir, nameOrPath);
        for (DownloadTaskInfo t : store.all()) {
            File tf = DownloadPaths.fileFor(dir, t.destName);
            if (tf.getAbsolutePath().equals(f.getAbsolutePath())) cancel(t.id);
        }
        //noinspection ResultOfMethodCallIgnored
        f.delete();
        //noinspection ResultOfMethodCallIgnored
        DownloadPaths.partFor(f).delete();
        File parent = f.getParentFile();
        if (parent != null && !parent.equals(dir)) {
            String[] left = parent.list();
            if (left != null && left.length == 0) //noinspection ResultOfMethodCallIgnored
                parent.delete();
        }
    }

    public long usedBytes() {
        return DownloadPaths.sizeOf(dir);
    }

    public long freeBytes() {
        return (dir.isDirectory() ? dir : app.getFilesDir()).getUsableSpace();
    }

    /** setDownloadPolicy: apply the Wi-Fi-only setting to every unfinished task. */
    public void setWifiOnly(boolean wifiOnly) {
        for (DownloadTaskInfo t : store.all()) {
            if (!t.isActive() || t.wifiOnly == wifiOnly) continue;
            store.update(t.id, x -> x.wifiOnly = wifiOnly);
            // Re-queued with the new network constraint; a running job resumes via Range.
            schedule(store.get(t.id), ExistingWorkPolicy.REPLACE);
        }
    }

    // ---- scheduling / events ---------------------------------------------------------------

    private void schedule(@Nullable DownloadTaskInfo t, ExistingWorkPolicy policy) {
        if (t == null) return;
        Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(t.wifiOnly ? NetworkType.UNMETERED : NetworkType.CONNECTED)
                .build();
        OneTimeWorkRequest req = new OneTimeWorkRequest.Builder(DownloadWorker.class)
                .setConstraints(constraints)
                .setInputData(new Data.Builder().putString(DownloadWorker.KEY_ID, t.id).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .addTag(TAG)
                .build();
        WorkManager.getInstance(app).enqueueUniqueWork(WORK_PREFIX + t.id, policy, req);
    }

    /** "offline", "metered" or "unmetered". */
    private String waitReason() {
        ConnectivityManager cm = (ConnectivityManager) app.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return "unmetered";
        Network n = cm.getActiveNetwork();
        NetworkCapabilities caps = n == null ? null : cm.getNetworkCapabilities(n);
        if (caps == null || !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) return "offline";
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) ? "unmetered" : "metered";
    }

    void emitProgress(String id, long written, long total) {
        JSONObject o = new JSONObject();
        try {
            o.put("id", id);
            o.put("bytesWritten", written);
            o.put("totalBytes", total);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
        PlaybackHub.get(app).emit("downloadProgress", o, false);
    }

    void emitCompleted(DownloadTaskInfo t, File file) {
        JSONObject o = new JSONObject();
        try {
            o.put("id", t.id);
            o.put("path", file.getAbsolutePath());
            o.put("uri", Uri.fromFile(file).toString());
            o.put("sizeBytes", file.length());
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
        PlaybackHub.get(app).emit("downloadCompleted", o, true);
    }

    void emitFailed(String id, String message, int httpStatus, boolean retryable) {
        JSONObject o = new JSONObject();
        try {
            o.put("id", id);
            o.put("message", message);
            if (httpStatus > 0) o.put("httpStatus", httpStatus);
            o.put("retryable", retryable);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
        PlaybackHub.get(app).emit("downloadFailed", o, true);
    }
}

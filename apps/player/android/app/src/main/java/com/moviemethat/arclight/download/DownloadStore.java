package com.moviemethat.arclight.download;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Persisted list of download tasks (JSON in app-private storage), shared by the plugin and the
 * workers. Survives the process: a worker restarted by WorkManager finds its request here, and
 * listDownloads reports what finished while JS was away. Pure Java (unit tested).
 */
public final class DownloadStore {

    private final File file;
    private final Map<String, DownloadTaskInfo> tasks = new LinkedHashMap<>();

    public DownloadStore(File file) {
        this.file = file;
        load();
    }

    private void load() {
        if (file == null || !file.isFile()) return;
        try {
            String json = new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
            JSONArray a = new JSONObject(json).optJSONArray("tasks");
            if (a == null) return;
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.optJSONObject(i);
                if (o == null) continue;
                DownloadTaskInfo t = DownloadTaskInfo.fromJson(o);
                if (!t.id.isEmpty()) tasks.put(t.id, t);
            }
        } catch (IOException | JSONException e) {
            tasks.clear();
        }
    }

    public synchronized DownloadTaskInfo get(String id) {
        return tasks.get(id);
    }

    public synchronized List<DownloadTaskInfo> all() {
        return new ArrayList<>(tasks.values());
    }

    public synchronized void put(DownloadTaskInfo t) {
        tasks.put(t.id, t);
        save();
    }

    public synchronized DownloadTaskInfo remove(String id) {
        DownloadTaskInfo t = tasks.remove(id);
        if (t != null) save();
        return t;
    }

    /** Applies a change to a task under the lock and persists it. Returns false when unknown. */
    public synchronized boolean update(String id, Mutation m) {
        DownloadTaskInfo t = tasks.get(id);
        if (t == null) return false;
        m.apply(t);
        save();
        return true;
    }

    /** Same as {@link #update} without writing the file (frequent progress updates). */
    public synchronized boolean updateInMemory(String id, Mutation m) {
        DownloadTaskInfo t = tasks.get(id);
        if (t == null) return false;
        m.apply(t);
        return true;
    }

    /**
     * Resume bookkeeping when a worker (re)starts: the partial file on disk is the truth for how
     * many bytes are written (the stored counter may lag behind after a crash).
     */
    public synchronized void reconcileWithPartial(String id, long partialBytes) {
        DownloadTaskInfo t = tasks.get(id);
        if (t == null) return;
        t.bytesWritten = Math.max(0, partialBytes);
        if (t.totalBytes >= 0 && t.bytesWritten > t.totalBytes) t.totalBytes = -1;
        save();
    }

    /** The completed tasks, removed from the store (listDownloads hands them to JS once). */
    public synchronized List<DownloadTaskInfo> drainCompleted() {
        List<DownloadTaskInfo> out = new ArrayList<>();
        for (DownloadTaskInfo t : new ArrayList<>(tasks.values())) {
            if (DownloadTaskInfo.COMPLETED.equals(t.status)) {
                out.add(t);
                tasks.remove(t.id);
            }
        }
        if (!out.isEmpty()) save();
        return out;
    }

    public synchronized void save() {
        if (file == null) return;
        JSONArray a = new JSONArray();
        for (DownloadTaskInfo t : tasks.values()) a.put(t.toJson());
        JSONObject o = new JSONObject();
        try {
            o.put("tasks", a);
            File dir = file.getParentFile();
            if (dir != null && !dir.isDirectory() && !dir.mkdirs()) return;
            File tmp = new File(file.getPath() + ".tmp");
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(o.toString().getBytes(StandardCharsets.UTF_8));
            }
            if (!tmp.renameTo(file)) {
                Files.deleteIfExists(file.toPath());
                //noinspection ResultOfMethodCallIgnored
                tmp.renameTo(file);
            }
        } catch (IOException | JSONException ignored) {
            // Best effort; the in-memory list stays correct for this process.
        }
    }

    public interface Mutation {
        void apply(DownloadTaskInfo t);
    }
}

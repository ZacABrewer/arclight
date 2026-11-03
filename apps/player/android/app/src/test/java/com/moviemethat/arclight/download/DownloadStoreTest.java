package com.moviemethat.arclight.download;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.List;
import org.json.JSONObject;
import org.junit.Test;

public class DownloadStoreTest {

    static JSONObject request(String id, String dest) throws Exception {
        return new JSONObject().put("id", id).put("url", "https://server.example/file/" + id).put("destName", dest)
                .put("headers", new JSONObject().put("Authorization", "Bearer t")).put("expectedBytes", 5000);
    }

    @Test
    public void requestValidation() throws Exception {
        DownloadTaskInfo t = DownloadTaskInfo.fromRequest(request("a", "albums/a.flac"));
        assertEquals(5000, t.totalBytes);
        assertEquals(DownloadTaskInfo.QUEUED, t.status);
        JSONObject[] bad = {
                request("", "a.mp3"),
                request("a", "../a.mp3"),
                request("a", "a.mp3").put("url", "file:///etc/passwd"),
        };
        for (JSONObject o : bad) {
            try {
                DownloadTaskInfo.fromRequest(o);
                fail("accepted " + o);
            } catch (IllegalArgumentException expected) {
                // ok
            }
        }
    }

    @Test
    public void persistsResumeBookkeeping() throws Exception {
        File f = new File(Files.createTempDirectory("dl").toFile(), "state/downloads.json");
        DownloadStore s = new DownloadStore(f);
        s.put(DownloadTaskInfo.fromRequest(request("a", "a.flac")));
        s.update("a", x -> {
            x.status = DownloadTaskInfo.RUNNING;
            x.bytesWritten = 1200;
            x.validator = "\"etag-1\"";
        });
        // Progress kept in memory only, then a "crash": the file has the last saved values.
        s.updateInMemory("a", x -> x.bytesWritten = 3000);
        DownloadStore back = new DownloadStore(f);
        DownloadTaskInfo r = back.get("a");
        assertEquals(1200, r.bytesWritten);
        assertEquals("\"etag-1\"", r.validator);
        assertEquals("Bearer t", r.headers.get("Authorization"));
        // The partial file on disk is the truth when the worker restarts.
        back.reconcileWithPartial("a", 2500);
        assertEquals(2500, new DownloadStore(f).get("a").bytesWritten);
        back.reconcileWithPartial("a", 9000);
        assertEquals(-1, back.get("a").totalBytes);
    }

    @Test
    public void completedTasksAreDrainedOnce() throws Exception {
        File f = new File(Files.createTempDirectory("dl").toFile(), "downloads.json");
        DownloadStore s = new DownloadStore(f);
        s.put(DownloadTaskInfo.fromRequest(request("a", "a.flac")));
        s.put(DownloadTaskInfo.fromRequest(request("b", "b.flac")));
        s.update("a", x -> x.status = DownloadTaskInfo.COMPLETED);
        List<DownloadTaskInfo> done = s.drainCompleted();
        assertEquals(1, done.size());
        assertEquals("a", done.get(0).id);
        assertTrue(s.drainCompleted().isEmpty());
        assertNull(new DownloadStore(f).get("a"));
        assertEquals(1, new DownloadStore(f).all().size());
    }

    @Test
    public void corruptStoreStartsEmpty() throws Exception {
        File f = new File(Files.createTempDirectory("dl").toFile(), "downloads.json");
        Files.write(f.toPath(), "{\"tasks\": [".getBytes(StandardCharsets.UTF_8));
        assertTrue(new DownloadStore(f).all().isEmpty());
    }
}

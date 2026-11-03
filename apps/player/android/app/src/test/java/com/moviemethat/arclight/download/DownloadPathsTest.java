package com.moviemethat.arclight.download;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

import java.io.File;
import java.nio.file.Files;
import org.junit.Test;

public class DownloadPathsTest {

    @Test
    public void acceptsSimpleNames() {
        DownloadPaths.validateDestName("a.mp3");
        DownloadPaths.validateDestName("album-12/01 Intro.flac");
    }

    @Test
    public void rejectsUnsafeNames() {
        String[] bad = {null, "", "/etc/passwd", "..", "../x", "a/../b", "a/b/c.mp3", "a\\b", "c:x", "a/", "./a", "x.mp3.part", "a\nb"};
        for (String s : bad) {
            try {
                DownloadPaths.validateDestName(s);
                fail("accepted " + s);
            } catch (IllegalArgumentException expected) {
                // ok
            }
        }
    }

    @Test
    public void partFileAndSizes() throws Exception {
        File dir = Files.createTempDirectory("dls").toFile();
        File f = DownloadPaths.fileFor(dir, "al/a.mp3");
        assertEquals(new File(new File(dir, "al"), "a.mp3.part").getPath(), DownloadPaths.partFor(f).getPath());
        //noinspection ResultOfMethodCallIgnored
        f.getParentFile().mkdirs();
        Files.write(f.toPath(), new byte[123]);
        Files.write(new File(dir, "b.mp3").toPath(), new byte[7]);
        assertEquals(130, DownloadPaths.sizeOf(dir));
        assertEquals(f.getPath(), DownloadPaths.resolveForDelete(dir, "al/a.mp3").getPath());
    }

    @Test
    public void deleteRefusesPathsOutsideTheFolder() throws Exception {
        File dir = Files.createTempDirectory("dls").toFile();
        try {
            DownloadPaths.resolveForDelete(dir, "../outside.mp3");
            fail();
        } catch (IllegalArgumentException expected) {
            // ok
        }
        // Absolute paths are POSIX-only (Android); skip those checks on a Windows host.
        if (File.separatorChar == '/') {
            try {
                DownloadPaths.resolveForDelete(dir, "/etc/hosts");
                fail();
            } catch (IllegalArgumentException expected) {
                // ok
            }
            File inside = new File(dir, "a.mp3");
            assertEquals(inside.getCanonicalPath(), DownloadPaths.resolveForDelete(dir, inside.getAbsolutePath()).getPath());
            assertEquals(inside.getCanonicalPath(), DownloadPaths.resolveForDelete(dir, inside.toURI().toString()).getPath());
        }
    }
}

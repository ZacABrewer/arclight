package com.moviemethat.arclight.download;

import java.io.File;
import java.io.IOException;

/**
 * Where downloads live: {@code <filesDir>/arclight-downloads/<destName>}, the same folder as
 * Capacitor's {@code Directory.Data + "arclight-downloads"}. Pure Java (unit tested).
 */
public final class DownloadPaths {

    public static final String DIR = "arclight-downloads";
    public static final String PART_SUFFIX = ".part";

    private DownloadPaths() {}

    /**
     * Checks a {@code destName} from JS: relative, forward slashes, at most one sub-folder, no
     * "." / ".." segments, no control characters.
     *
     * @throws IllegalArgumentException when it is not acceptable
     */
    public static void validateDestName(String destName) {
        if (destName == null || destName.isEmpty()) throw new IllegalArgumentException("destName is required");
        if (destName.length() > 240) throw new IllegalArgumentException("destName is too long");
        if (destName.startsWith("/") || destName.contains("\\")) throw new IllegalArgumentException("destName must be relative: " + destName);
        String[] parts = destName.split("/", -1);
        if (parts.length > 2) throw new IllegalArgumentException("destName may contain one sub-folder at most: " + destName);
        for (String p : parts) {
            if (p.isEmpty() || p.equals(".") || p.equals("..")) throw new IllegalArgumentException("Bad destName: " + destName);
            for (int i = 0; i < p.length(); i++) {
                char c = p.charAt(i);
                if (c < 0x20 || c == 0x7f || c == ':') throw new IllegalArgumentException("Bad character in destName: " + destName);
            }
        }
        if (destName.endsWith(PART_SUFFIX)) throw new IllegalArgumentException("destName may not end in " + PART_SUFFIX);
    }

    /** The final file for a validated {@code destName}. */
    public static File fileFor(File downloadsDir, String destName) {
        validateDestName(destName);
        return new File(downloadsDir, destName);
    }

    /** The partial file a download writes before it is complete. */
    public static File partFor(File finalFile) {
        return new File(finalFile.getPath() + PART_SUFFIX);
    }

    /**
     * Resolves {@code deleteDownload}'s argument: a relative destName, or an absolute path /
     * file:// URL that must be inside the downloads folder.
     *
     * @throws IllegalArgumentException for anything outside the folder
     */
    public static File resolveForDelete(File downloadsDir, String nameOrPath) {
        if (nameOrPath == null || nameOrPath.isEmpty()) throw new IllegalArgumentException("destName is required");
        String s = nameOrPath;
        if (s.startsWith("file://")) s = java.net.URI.create(s).getPath();
        if (!s.startsWith("/")) return fileFor(downloadsDir, s);
        try {
            File base = downloadsDir.getCanonicalFile();
            File f = new File(s).getCanonicalFile();
            if (!f.getPath().startsWith(base.getPath() + File.separator)) {
                throw new IllegalArgumentException("Path is outside the downloads folder");
            }
            return f;
        } catch (IOException e) {
            throw new IllegalArgumentException("Bad path: " + e.getMessage());
        }
    }

    /** Total size of every file under {@code dir} (recursive). */
    public static long sizeOf(File dir) {
        if (dir == null || !dir.exists()) return 0;
        if (dir.isFile()) return dir.length();
        long total = 0;
        File[] list = dir.listFiles();
        if (list != null) for (File f : list) total += sizeOf(f);
        return total;
    }
}

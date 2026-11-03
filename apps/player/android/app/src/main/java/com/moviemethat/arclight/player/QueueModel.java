package com.moviemethat.arclight.player;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The native copy of the play queue JS handed over ({@code load} + {@code setUpcoming}). It is
 * kept in the same order as the ExoPlayer playlist: index i here is media item i there.
 * Pure Java so the queue rules can be unit tested.
 */
public final class QueueModel {

    private final List<TrackInfo> tracks = new ArrayList<>();

    public static List<TrackInfo> parseTracks(JSONArray array) {
        List<TrackInfo> out = new ArrayList<>();
        if (array == null) return out;
        for (int i = 0; i < array.length(); i++) {
            JSONObject o = array.optJSONObject(i);
            out.add(TrackInfo.fromJson(o));
        }
        return out;
    }

    public static JSONArray toJson(List<TrackInfo> list) {
        JSONArray a = new JSONArray();
        for (TrackInfo t : list) a.put(t.toJson());
        return a;
    }

    public synchronized void replace(List<TrackInfo> list) {
        tracks.clear();
        tracks.addAll(list);
    }

    public synchronized void clear() {
        tracks.clear();
    }

    public synchronized int size() {
        return tracks.size();
    }

    public synchronized boolean isEmpty() {
        return tracks.isEmpty();
    }

    /** The track at {@code index}, or null when out of range. */
    public synchronized TrackInfo get(int index) {
        return index >= 0 && index < tracks.size() ? tracks.get(index) : null;
    }

    public synchronized List<TrackInfo> snapshot() {
        return Collections.unmodifiableList(new ArrayList<>(tracks));
    }

    public synchronized int indexOfId(String id) {
        if (id == null) return -1;
        for (int i = 0; i < tracks.size(); i++) if (tracks.get(i).id.equals(id)) return i;
        return -1;
    }

    /** {@code startIndex} clamped into the queue (0 for an empty queue). */
    public static int clampStart(int startIndex, int size) {
        if (size <= 0) return 0;
        return Math.min(Math.max(0, startIndex), size - 1);
    }

    /**
     * Replaces every track after {@code currentIndex} with {@code upcoming} (setUpcoming). With
     * nothing current ({@code currentIndex < 0}) the queue becomes {@code upcoming}.
     *
     * @return the index of the first replaced slot (where the player must remove from and insert at).
     */
    public synchronized int replaceUpcoming(int currentIndex, List<TrackInfo> upcoming) {
        int keep = currentIndex < 0 ? 0 : Math.min(currentIndex + 1, tracks.size());
        while (tracks.size() > keep) tracks.remove(tracks.size() - 1);
        tracks.addAll(upcoming);
        return keep;
    }

    /**
     * Where a lock-screen / car "next" goes when native has to decide on its own (JS asleep):
     * the following track, wrapping with repeat "all"; -1 when there is none.
     */
    public static int fallbackNextIndex(int current, int size, String repeat) {
        if (size <= 0) return -1;
        if (current + 1 < size) return current + 1;
        return "all".equals(repeat) ? 0 : -1;
    }

    /**
     * Where "previous" goes natively: restart the current track after 3 s of it, else the track
     * before (wrapping with repeat "all"), else restart. Returns the target index.
     */
    public static int fallbackPreviousIndex(int current, int size, long positionMs, String repeat) {
        if (size <= 0) return -1;
        if (positionMs > 3000 || current < 0) return Math.max(0, current);
        if (current > 0) return current - 1;
        return "all".equals(repeat) ? size - 1 : 0;
    }

    /**
     * The URI ExoPlayer should open for a NativeTrack url: http(s), file:// and content:// URLs
     * as given; an absolute path becomes a percent-encoded file:// URI. Null when unusable.
     */
    public static String playableUri(String url) {
        if (url == null) return null;
        String u = url.trim();
        if (u.isEmpty()) return null;
        String lower = u.toLowerCase(Locale.ROOT);
        if (lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("file://") || lower.startsWith("content://")) {
            return u;
        }
        if (u.startsWith("/")) return "file://" + encodePath(u);
        return null;
    }

    /** Percent-encodes a path for a URI, keeping '/' and RFC 3986 unreserved characters. */
    static String encodePath(String path) {
        StringBuilder sb = new StringBuilder(path.length() + 16);
        byte[] bytes = path.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        for (byte b : bytes) {
            int c = b & 0xff;
            boolean keep = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
                    || c == '-' || c == '.' || c == '_' || c == '~' || c == '/';
            if (keep) {
                sb.append((char) c);
            } else {
                sb.append('%').append(Character.toUpperCase(Character.forDigit(c >> 4, 16))).append(Character.toUpperCase(Character.forDigit(c & 0xf, 16)));
            }
        }
        return sb.toString();
    }
}

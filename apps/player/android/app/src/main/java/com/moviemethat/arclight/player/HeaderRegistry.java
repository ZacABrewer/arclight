package com.moviemethat.arclight.player;

import java.util.Collections;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Request headers per URL (NativeTrack.headers / artworkHeaders), looked up by the player's
 * data source and the artwork loader when they open that URL. Thread-safe: loaders run on
 * background threads.
 */
public final class HeaderRegistry {

    private static final int MAX_ENTRIES = 2000;
    private final Map<String, Map<String, String>> byUrl = new ConcurrentHashMap<>();

    public void put(String url, Map<String, String> headers) {
        if (url == null || url.isEmpty()) return;
        if (headers == null || headers.isEmpty()) {
            byUrl.remove(url);
            return;
        }
        if (byUrl.size() >= MAX_ENTRIES) byUrl.clear();
        byUrl.put(url, headers);
    }

    public Map<String, String> get(String url) {
        if (url == null) return Collections.emptyMap();
        Map<String, String> h = byUrl.get(url);
        return h == null ? Collections.emptyMap() : h;
    }

    public void clear() {
        byUrl.clear();
    }
}

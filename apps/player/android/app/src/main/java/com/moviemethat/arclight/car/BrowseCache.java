package com.moviemethat.arclight.car;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The car browse tree native serves when JS cannot answer (WebView gone or asleep, offline):
 * what JS last gave {@code setBrowseTree}, plus every {@code answerBrowse} since. Persisted as
 * JSON in app-private storage so it survives the process. Pure Java (unit tested).
 */
public final class BrowseCache {

    public static final String ROOT_ID = "root";
    /** Cap on cached child lists (oldest-used dropped first). */
    static final int MAX_PARENTS = 400;

    private final List<BrowseNodeInfo> root = new ArrayList<>();
    private final LinkedHashMap<String, List<BrowseNodeInfo>> children = new LinkedHashMap<String, List<BrowseNodeInfo>>(64, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, List<BrowseNodeInfo>> eldest) {
            return size() > MAX_PARENTS;
        }
    };

    /** Replaces everything with a BrowseTree from JS ({@code {root, children}}). */
    public synchronized void setTree(JSONObject tree) {
        root.clear();
        children.clear();
        if (tree == null) return;
        root.addAll(parseList(tree.optJSONArray("root")));
        JSONObject map = tree.optJSONObject("children");
        if (map != null) {
            Iterator<String> keys = map.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                children.put(k, parseList(map.optJSONArray(k)));
            }
        }
    }

    /** Remembers an answer from JS (parent "root" replaces the root list). */
    public synchronized void putChildren(String parentId, List<BrowseNodeInfo> nodes) {
        if (parentId == null) return;
        if (ROOT_ID.equals(parentId)) {
            root.clear();
            root.addAll(nodes);
        } else {
            children.put(parentId, new ArrayList<>(nodes));
        }
    }

    /** Cached children of {@code parentId} (empty when unknown). */
    public synchronized List<BrowseNodeInfo> childrenOf(String parentId) {
        if (ROOT_ID.equals(parentId)) return new ArrayList<>(root);
        List<BrowseNodeInfo> l = children.get(parentId);
        return l == null ? new ArrayList<>() : new ArrayList<>(l);
    }

    public synchronized boolean hasChildren(String parentId) {
        return ROOT_ID.equals(parentId) ? !root.isEmpty() : children.containsKey(parentId);
    }

    /** A node anywhere in the cache, or null. */
    public synchronized BrowseNodeInfo find(String id) {
        if (id == null) return null;
        for (BrowseNodeInfo n : root) if (n.id.equals(id)) return n;
        for (List<BrowseNodeInfo> l : children.values()) for (BrowseNodeInfo n : l) if (n.id.equals(id)) return n;
        return null;
    }

    /** The parent a node was listed under ("root" for top-level rows), or null when unknown. */
    public synchronized String parentOf(String id) {
        if (id == null) return null;
        for (BrowseNodeInfo n : root) if (n.id.equals(id)) return ROOT_ID;
        for (Map.Entry<String, List<BrowseNodeInfo>> e : children.entrySet()) {
            for (BrowseNodeInfo n : e.getValue()) if (n.id.equals(id)) return e.getKey();
        }
        return null;
    }

    /** Offline search: rows whose title or subtitle contains every word of the query (case-insensitive). */
    public synchronized List<BrowseNodeInfo> search(String query, int limit) {
        List<BrowseNodeInfo> out = new ArrayList<>();
        if (query == null || query.trim().isEmpty()) return out;
        String[] words = query.toLowerCase(Locale.ROOT).trim().split("\\s+");
        Map<String, BrowseNodeInfo> seen = new LinkedHashMap<>();
        List<BrowseNodeInfo> all = new ArrayList<>(root);
        for (List<BrowseNodeInfo> l : children.values()) all.addAll(l);
        for (BrowseNodeInfo n : all) {
            if (seen.containsKey(n.id)) continue;
            String hay = (n.title + " " + (n.subtitle == null ? "" : n.subtitle)).toLowerCase(Locale.ROOT);
            boolean match = true;
            for (String w : words) {
                if (!hay.contains(w)) {
                    match = false;
                    break;
                }
            }
            if (match && (n.playable || n.browsable)) seen.put(n.id, n);
        }
        for (BrowseNodeInfo n : seen.values()) {
            if (out.size() >= limit) break;
            out.add(n);
        }
        return out;
    }

    /** Every node with artwork (to re-register artwork URLs after a restart). */
    public synchronized List<BrowseNodeInfo> allNodes() {
        List<BrowseNodeInfo> all = new ArrayList<>(root);
        for (List<BrowseNodeInfo> l : children.values()) all.addAll(l);
        return all;
    }

    public synchronized JSONObject toJson() {
        JSONObject o = new JSONObject();
        try {
            o.put("root", toArray(root));
            JSONObject map = new JSONObject();
            for (Map.Entry<String, List<BrowseNodeInfo>> e : children.entrySet()) map.put(e.getKey(), toArray(e.getValue()));
            o.put("children", map);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
        return o;
    }

    /** Writes the cache atomically (temp file + rename). */
    public void save(File file) throws IOException {
        String json = toJson().toString();
        File dir = file.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("Cannot create " + dir);
        File tmp = new File(file.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(json.getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        }
        if (!tmp.renameTo(file)) {
            Files.deleteIfExists(file.toPath());
            if (!tmp.renameTo(file)) throw new IOException("Cannot replace " + file);
        }
    }

    /** Reads a saved cache; an empty cache when the file is missing or unreadable. */
    public static BrowseCache load(File file) {
        BrowseCache c = new BrowseCache();
        if (file == null || !file.isFile()) return c;
        try {
            String json = new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
            c.setTree(new JSONObject(json));
        } catch (IOException | JSONException | IllegalArgumentException e) {
            c.setTree(null);
        }
        return c;
    }

    /** Parses a JSON array of BrowseNode, skipping malformed rows. */
    public static List<BrowseNodeInfo> parseList(JSONArray a) {
        List<BrowseNodeInfo> out = new ArrayList<>();
        if (a == null) return out;
        for (int i = 0; i < a.length(); i++) {
            try {
                out.add(BrowseNodeInfo.fromJson(a.optJSONObject(i)));
            } catch (IllegalArgumentException ignored) {
                // A row without an id cannot be shown or played.
            }
        }
        return out;
    }

    private static JSONArray toArray(List<BrowseNodeInfo> l) {
        JSONArray a = new JSONArray();
        for (BrowseNodeInfo n : l) a.put(n.toJson());
        return a;
    }

    /** One page of a list (Media3 paging: page index and size; a size of 0 or less means everything). */
    public static <T> List<T> page(List<T> list, int page, int pageSize) {
        if (pageSize <= 0 || pageSize == Integer.MAX_VALUE) return page <= 0 ? list : Collections.emptyList();
        long from = (long) Math.max(0, page) * pageSize;
        if (from >= list.size()) return Collections.emptyList();
        int to = (int) Math.min(list.size(), from + pageSize);
        return list.subList((int) from, to);
    }
}

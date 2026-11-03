package com.moviemethat.arclight.car;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class BrowseCacheTest {

    static JSONObject node(String id, String title, boolean browsable) throws Exception {
        return new JSONObject().put("id", id).put("title", title).put("browsable", browsable).put("playable", !browsable);
    }

    static JSONObject tree() throws Exception {
        return new JSONObject()
                .put("root", new JSONArray().put(node("albums", "Albums", true)).put(node("books", "Books", true)))
                .put("children", new JSONObject()
                        .put("albums", new JSONArray().put(node("al1", "Blue Train", true)).put(node("al2", "Kind of Blue", true)))
                        .put("al1", new JSONArray().put(node("t1", "Moments Notice", false)).put(new JSONObject().put("title", "no id"))));
    }

    @Test
    public void treeQueries() throws Exception {
        BrowseCache c = new BrowseCache();
        c.setTree(tree());
        assertEquals(2, c.childrenOf(BrowseCache.ROOT_ID).size());
        assertEquals(2, c.childrenOf("albums").size());
        assertEquals(1, c.childrenOf("al1").size()); // the row without an id is dropped
        assertTrue(c.hasChildren("al1"));
        assertEquals("albums", c.parentOf("al2"));
        assertEquals(BrowseCache.ROOT_ID, c.parentOf("books"));
        assertNotNull(c.find("t1"));
    }

    @Test
    public void searchMatchesAllWordsCaseInsensitive() throws Exception {
        BrowseCache c = new BrowseCache();
        c.setTree(tree());
        List<BrowseNodeInfo> r = c.search("BLUE", 10);
        assertEquals(2, r.size());
        r = c.search("blue kind", 10);
        assertEquals(1, r.size());
        assertEquals("al2", r.get(0).id);
        assertEquals(1, c.search("blue", 1).size());
        assertEquals(0, c.search(" ", 10).size());
    }

    @Test
    public void saveAndLoadRoundTrip() throws Exception {
        File dir = Files.createTempDirectory("browse").toFile();
        File f = new File(dir, "sub/browse-tree.json");
        BrowseCache c = new BrowseCache();
        c.setTree(tree());
        c.save(f);
        BrowseCache back = BrowseCache.load(f);
        assertEquals(2, back.childrenOf("albums").size());
        assertEquals("Moments Notice", back.childrenOf("al1").get(0).title);
        // Missing or corrupt files give an empty cache.
        assertEquals(0, BrowseCache.load(new File(dir, "missing.json")).childrenOf(BrowseCache.ROOT_ID).size());
        Files.write(f.toPath(), "{not json".getBytes(StandardCharsets.UTF_8));
        assertEquals(0, BrowseCache.load(f).childrenOf(BrowseCache.ROOT_ID).size());
    }

    @Test
    public void paging() {
        List<Integer> l = Arrays.asList(1, 2, 3, 4, 5);
        assertEquals(Arrays.asList(1, 2), BrowseCache.page(l, 0, 2));
        assertEquals(Arrays.asList(5), BrowseCache.page(l, 2, 2));
        assertEquals(0, BrowseCache.page(l, 3, 2).size());
        assertEquals(l, BrowseCache.page(l, 0, Integer.MAX_VALUE));
    }
}

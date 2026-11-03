package com.moviemethat.arclight.car;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

public class BrowseBrokerTest {

    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor();
    private final List<String> asked = Collections.synchronizedList(new ArrayList<>());
    private volatile boolean jsAlive;
    private BrowseCache cache;
    private BrowseBroker broker;

    @Before
    public void setUp() throws Exception {
        cache = new BrowseCache();
        cache.setTree(BrowseCacheTest.tree());
        broker = new BrowseBroker(cache, null, new BrowseBroker.Requester() {
            @Override
            public boolean canAsk() {
                return jsAlive;
            }

            @Override
            public void ask(String requestId, String parentId, String query) {
                asked.add(requestId);
            }
        }, timer, 300);
    }

    @After
    public void tearDown() {
        timer.shutdownNow();
    }

    @Test
    public void servesCacheWhenJsIsAsleep() throws Exception {
        jsAlive = false;
        List<BrowseNodeInfo> r = broker.children("albums").get(1, TimeUnit.SECONDS);
        assertEquals(2, r.size());
        assertTrue(asked.isEmpty());
        assertEquals(2, broker.search("blue").get(1, TimeUnit.SECONDS).size());
    }

    @Test
    public void jsAnswerWinsAndIsCached() throws Exception {
        jsAlive = true;
        Future<List<BrowseNodeInfo>> f = broker.children("books");
        assertEquals(1, asked.size());
        List<BrowseNodeInfo> items = BrowseCache.parseList(new JSONArray().put(BrowseCacheTest.node("b1", "Dune", false)));
        assertTrue(broker.answer(asked.get(0), items));
        assertEquals("b1", f.get(1, TimeUnit.SECONDS).get(0).id);
        assertEquals(1, cache.childrenOf("books").size());
        // A second answer for the same request is ignored.
        assertFalse(broker.answer(asked.get(0), items));
    }

    @Test
    public void timeoutFallsBackToCache() throws Exception {
        jsAlive = true;
        Future<List<BrowseNodeInfo>> f = broker.children("albums");
        assertEquals(2, f.get(3, TimeUnit.SECONDS).size());
        assertFalse(broker.answer(asked.get(0), Collections.<BrowseNodeInfo>emptyList()));
    }

    @Test
    public void unknownRequestIsIgnored() {
        assertFalse(broker.answer("car-999", Collections.<BrowseNodeInfo>emptyList()));
    }
}

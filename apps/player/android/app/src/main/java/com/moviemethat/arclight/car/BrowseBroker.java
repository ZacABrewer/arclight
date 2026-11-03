package com.moviemethat.arclight.car;

import com.google.common.util.concurrent.ListenableFuture;
import com.google.common.util.concurrent.SettableFuture;
import java.io.File;
import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executor;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONObject;

/**
 * Answers the car's browse and search requests: asks JS when it is listening
 * ({@code browseRequest} → {@code answerBrowse}), and falls back to the persisted
 * {@link BrowseCache} when JS is not there or does not answer in time. Pure Java + Guava
 * (unit tested with a real scheduler).
 */
public final class BrowseBroker {

    /** Sends a browseRequest to JS. */
    public interface Requester {
        /** Whether JS is alive and listening for browseRequest right now. */
        boolean canAsk();

        void ask(String requestId, String parentId, String query);
    }

    private static final int SEARCH_LIMIT = 50;

    private static final class Pending {
        final String parentId;
        final String query;
        final SettableFuture<List<BrowseNodeInfo>> future = SettableFuture.create();

        Pending(String parentId, String query) {
            this.parentId = parentId;
            this.query = query;
        }
    }

    private final BrowseCache cache;
    private final File file;
    private final Requester requester;
    private final ScheduledExecutorService timer;
    private final long timeoutMs;
    private final Map<String, Pending> pending = new ConcurrentHashMap<>();
    private final AtomicLong counter = new AtomicLong();

    public BrowseBroker(BrowseCache cache, File file, Requester requester, ScheduledExecutorService timer, long timeoutMs) {
        this.cache = cache;
        this.file = file;
        this.requester = requester;
        this.timer = timer;
        this.timeoutMs = timeoutMs;
    }

    public BrowseCache cache() {
        return cache;
    }

    /** Children of a node: from JS when it answers in time, else from the cache. */
    public ListenableFuture<List<BrowseNodeInfo>> children(String parentId) {
        return request(parentId, null);
    }

    /** Search results: from JS when it answers in time, else an offline search of the cache. */
    public ListenableFuture<List<BrowseNodeInfo>> search(String query) {
        return request(null, query);
    }

    private ListenableFuture<List<BrowseNodeInfo>> request(String parentId, String query) {
        if (!requester.canAsk()) {
            SettableFuture<List<BrowseNodeInfo>> f = SettableFuture.create();
            f.set(fallback(parentId, query));
            return f;
        }
        String id = "car-" + counter.incrementAndGet();
        Pending p = new Pending(parentId, query);
        pending.put(id, p);
        timer.schedule(() -> {
            Pending late = pending.remove(id);
            if (late != null) late.future.set(fallback(late.parentId, late.query));
        }, timeoutMs, TimeUnit.MILLISECONDS);
        try {
            requester.ask(id, parentId, query);
        } catch (RuntimeException e) {
            pending.remove(id);
            p.future.set(fallback(parentId, query));
        }
        return p.future;
    }

    /**
     * JS answered a request. Child lists are remembered in the cache (and persisted) for the
     * next time JS cannot answer.
     *
     * @return false when the request is unknown or already timed out
     */
    public boolean answer(String requestId, List<BrowseNodeInfo> items) {
        Pending p = pending.remove(requestId);
        if (p == null) return false;
        if (p.parentId != null) {
            cache.putChildren(p.parentId, items);
            persistAsync();
        }
        p.future.set(items);
        return true;
    }

    /** setBrowseTree from JS. */
    public void setTree(JSONObject tree) {
        cache.setTree(tree);
        persistAsync();
    }

    private List<BrowseNodeInfo> fallback(String parentId, String query) {
        if (query != null) return cache.search(query, SEARCH_LIMIT);
        return cache.childrenOf(parentId);
    }

    private void persistAsync() {
        Executor e = timer;
        e.execute(() -> {
            try {
                if (file != null) cache.save(file);
            } catch (IOException ignored) {
                // Best effort: the in-memory cache still serves this process.
            }
        });
    }

    /** Number of requests waiting for JS (tests). */
    int pendingCount() {
        return pending.size();
    }
}

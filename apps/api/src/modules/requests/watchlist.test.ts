import { describe, expect, it } from 'vitest';
import { Permission as P } from '@arclight/shared';
import { RequestsError } from './errors.js';
import { mediaRequests } from './schema.js';
import { addUser, setup } from './test-support.js';
import { plexWatchlistProvider, type WatchlistProvider, type WatchlistProviderItem } from './watchlist.js';

describe('watchlist', () => {
  it('adds, lists with status, rejects duplicates and removes', async () => {
    const h = await setup();
    h.tmdb.addMovie({ tmdbId: 603, title: 'The Matrix', year: 1999 });
    const u = addUser(h.db);
    const item = await h.services.watchlist.add(u.actor, { mediaType: 'movie', tmdbId: 603 });
    expect(item).toMatchObject({ title: 'The Matrix', year: 1999, source: 'manual', mediaStatus: 'unknown', posterUrl: 'https://img/603.jpg' });
    await expect(h.services.watchlist.add(u.actor, { mediaType: 'movie', tmdbId: 603 })).rejects.toMatchObject({ code: 'CONFLICT' });
    await h.services.requests.create(u.actor, { mediaType: 'movie', tmdbId: 603 });
    expect(h.services.watchlist.list(u.actor)[0]).toMatchObject({ mediaStatus: 'pending', requestStatus: 'pending' });
    h.services.watchlist.remove(u.actor, item.id);
    expect(h.services.watchlist.list(u.actor)).toEqual([]);
  });

  it("other users' lists need WATCHLIST_VIEW", async () => {
    const h = await setup();
    const a = addUser(h.db);
    const b = addUser(h.db);
    const viewer = addUser(h.db, { permissions: P.WATCHLIST_VIEW });
    expect(() => h.services.watchlist.list(a.actor, b.id)).toThrow(RequestsError);
    expect(h.services.watchlist.list(viewer.actor, b.id)).toEqual([]);
  });

  it('parses the plex.tv watchlist with the token in a header and paginates', async () => {
    const calls: { url: string; token: string | undefined }[] = [];
    const provider = plexWatchlistProvider(async (url, init) => {
      calls.push({ url, token: (init?.headers as Record<string, string>)['X-Plex-Token'] });
      const start = Number(new URL(url).searchParams.get('X-Plex-Container-Start'));
      const rows =
        start === 0
          ? Array.from({ length: 50 }, (_, i) => ({ type: 'movie', title: `M${i}`, year: 2000, ratingKey: `k${i}`, Guid: [{ id: `tmdb://${i + 1}` }] }))
          : [{ type: 'show', title: 'Show', year: 2010, Guid: [{ id: 'tvdb://81189' }, { id: 'imdb://tt0903747' }] }, { type: 'person', title: 'nope' }];
      return new Response(JSON.stringify({ MediaContainer: { totalSize: 51, Metadata: rows } }), { status: 200 });
    });
    const items = (await provider.fetch({} as never, { plexToken: 'secret', notifications: {} as never, watchlistSyncMovies: false, watchlistSyncSeries: false, autoRequestFromWatchlist: true }))!;
    expect(items).toHaveLength(51);
    expect(items[0]).toMatchObject({ mediaType: 'movie', tmdbId: 1, externalId: 'k0' });
    expect(items[50]).toMatchObject({ mediaType: 'series', tvdbId: 81189, imdbId: 'tt0903747', tmdbId: null });
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.token === 'secret' && !c.url.includes('secret'))).toBe(true);
    expect(await provider.fetch({} as never, { notifications: {} as never, watchlistSyncMovies: false, watchlistSyncSeries: false, autoRequestFromWatchlist: true })).toBeNull();
  });

  it('sync mirrors remote items, resolves TMDB ids, auto-requests when permitted and drops stale items', async () => {
    let remote: WatchlistProviderItem[] = [
      { mediaType: 'movie', title: 'The Matrix', tmdbId: 603 },
      { mediaType: 'series', title: 'Thrones', tvdbId: 121361 },
    ];
    const fake: WatchlistProvider = { source: 'plex', fetch: async (_u, s) => (s.plexToken ? remote : null) };
    const h = await setup({ watchlistProviders: [fake] });
    h.tmdb.addMovie({ tmdbId: 603, title: 'The Matrix', year: 1999 }).addSeries({ tmdbId: 1399, tvdbId: 121361, title: 'Thrones', year: 2011, seasons: [0, 2] });
    const auto = addUser(h.db, { permissions: P.REQUEST | P.AUTO_REQUEST_MOVIE, settings: { plexToken: 't', watchlistSyncMovies: true, watchlistSyncSeries: true } });
    addUser(h.db, { settings: {} }); // no token: skipped
    const first = await h.services.watchlist.sync();
    expect(first).toEqual({ users: 1, added: 2, requested: 1 });
    expect(h.services.watchlist.list(auto.actor).map((i) => i.tmdbId).sort((a, b) => a - b)).toEqual([603, 1399]);
    const reqs = h.db.select().from(mediaRequests).all();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ type: 'movie', tmdbId: 603, isAutoRequest: true });
    // A second run neither duplicates items nor re-requests.
    expect(await h.services.watchlist.sync()).toEqual({ users: 1, added: 0, requested: 0 });
    remote = [{ mediaType: 'movie', title: 'The Matrix', tmdbId: 603 }];
    await h.services.watchlist.sync();
    expect(h.services.watchlist.list(auto.actor).map((i) => i.tmdbId)).toEqual([603]);
  });
});

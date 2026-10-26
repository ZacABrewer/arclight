import { describe, expect, it } from 'vitest';
import { Permission as P, RequestsSettings } from '@arclight/shared';
import { setSection } from '../settings/service.js';
import { DiscoverCache } from './discover-cache.js';
import { ANONYMOUS_ACTOR } from './permissions.js';
import { addUser, buildApp, giveMovieFile, setup } from './test-support.js';

// The full discover catalogue: ready-made lists, people search, collections with "request all
// missing", tiles, filter vocabularies, declined badges, per-query hides and the TMDB cache.

async function harness() {
  const h = await setup();
  h.tmdb
    .addMovie({ tmdbId: 603, title: 'The Matrix', year: 1999 })
    .addMovie({ tmdbId: 604, title: 'Reloaded', year: 2003 })
    .addMovie({ tmdbId: 605, title: 'Revolutions', year: 2003 })
    .addSeries({ tmdbId: 1399, title: 'Thrones', year: 2011, seasons: [1, 2, 2] });
  h.tmdb.collections.set(2344, [603, 604, 605]);
  const admin = addUser(h.db, { role: 'admin' });
  const user = addUser(h.db, { permissions: P.REQUEST | P.CREATE_ISSUES });
  const manager = addUser(h.db, { permissions: P.MANAGE_REQUESTS | P.REQUEST });
  return { ...h, admin, user, manager };
}

describe('discover catalogue', () => {
  it('serves ready-made lists through the TMDB list endpoints', async () => {
    const h = await harness();
    const top = await h.services.discover.list('topRatedMovies', { page: 2 });
    expect(top.results.map((r) => r.tmdbId)).toEqual([603, 604, 605]);
    expect(h.tmdb.calls).toContain('list:movie:topRated:2');
    await h.services.discover.list('onTheAir', {});
    expect(h.tmdb.calls).toContain('list:tv:onTheAir:1');
    // Upcoming lists go through discover with a date floor.
    await h.services.discover.list('upcomingTv', {});
    expect(h.tmdb.calls.some((c) => c.startsWith('discover:tv:') && c.includes('first_air_date.asc'))).toBe(true);
  });

  it('shares cached TMDB pages between callers and clears them when metadata settings change', async () => {
    const h = await harness();
    await Promise.all([h.services.discover.list('nowPlaying', {}), h.services.discover.list('nowPlaying', {})]);
    await h.services.discover.list('nowPlaying', {});
    expect(h.tmdb.calls.filter((c) => c === 'list:movie:nowPlaying:1')).toHaveLength(1);
    h.ctx.bus.publish({ type: 'settings', section: 'metadata' });
    await h.services.discover.list('nowPlaying', {});
    expect(h.tmdb.calls.filter((c) => c === 'list:movie:nowPlaying:1')).toHaveLength(2);
  });

  it('overlays fresh status on cached pages', async () => {
    const h = await harness();
    expect((await h.services.discover.list('popularMovies', {})).results[0]!.mediaStatus).toBe('unknown');
    await h.services.requests.create(h.user.actor, { mediaType: 'movie', tmdbId: 603 });
    const again = await h.services.discover.list('popularMovies', {});
    expect(again.results[0]).toMatchObject({ tmdbId: 603, mediaStatus: 'pending', requestStatus: 'pending' });
    expect(h.tmdb.calls.filter((c) => c === 'list:movie:popular:1')).toHaveLength(1);
  });

  it('marks titles whose newest request was declined', async () => {
    const h = await harness();
    const out = await h.services.requests.create(h.user.actor, { mediaType: 'movie', tmdbId: 604 });
    if (out.kind !== 'created') throw new Error('expected a request');
    await h.services.requests.decline(h.manager.actor, out.request.id, 'no');
    const page = await h.services.discover.movies({});
    expect(page.results.find((r) => r.tmdbId === 604)).toMatchObject({ requestStatus: 'declined', mediaStatus: 'unknown', requestId: null });
  });

  it('hides available and requested titles per query', async () => {
    const h = await harness();
    await h.services.requests.create(h.admin.actor, { mediaType: 'movie', tmdbId: 603 });
    giveMovieFile(h.db, 603);
    await h.services.requests.create(h.user.actor, { mediaType: 'movie', tmdbId: 604 });
    expect((await h.services.discover.movies({ hideAvailable: 'true' })).results.map((r) => r.tmdbId)).toEqual([604, 605]);
    expect((await h.services.discover.movies({ hideAvailable: true, hideRequested: '1' })).results.map((r) => r.tmdbId)).toEqual([605]);
    expect((await h.services.discover.movies({ hideAvailable: 'false' })).results).toHaveLength(3);
  });

  it('searches one media type or all, and people', async () => {
    const h = await harness();
    expect((await h.services.discover.search({ query: 'matrix', mediaType: 'movie' })).results.map((r) => r.tmdbId)).toEqual([603]);
    expect(h.tmdb.calls).toContain('searchMovies:matrix');
    await h.services.discover.search({ query: 'thrones', mediaType: 'tv' });
    expect(h.tmdb.calls).toContain('searchSeries:thrones');
    const people = await h.services.discover.searchPeople({ query: 'lead' });
    expect(people).toMatchObject({ totalPages: 2, results: [{ tmdbId: 1, name: 'Lead Actor', knownFor: ['The Matrix'] }] });
  });

  it('builds a collection page and requests every missing part', async () => {
    const h = await harness();
    await h.services.requests.create(h.admin.actor, { mediaType: 'movie', tmdbId: 603 });
    giveMovieFile(h.db, 603);
    const before = await h.services.discover.collection(h.user.actor, 2344);
    expect(before).toMatchObject({ name: 'Collection 2344', missing: 2, canRequest: true, canRequest4k: false });
    const result = await h.services.discover.requestCollection(h.user.actor, 2344, {});
    expect(result.requested.map((r) => r.tmdbId)).toEqual([604, 605]);
    expect(result).toMatchObject({ skipped: 1, failed: [] });
    expect((await h.services.discover.collection(h.user.actor, 2344)).missing).toBe(0);
    await expect(h.services.discover.requestCollection(h.user.actor, 2344, { is4k: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('lists tiles and filter vocabularies with the instance region', async () => {
    const h = await harness();
    setSection(h.db, 'metadata', { language: 'en-GB', region: 'GB' });
    const providers = await h.services.discover.providers('movie');
    expect(providers).toEqual([{ id: 8, name: 'Streamer', imageUrl: 'https://img/streamer.png' }]);
    expect(h.tmdb.calls).toContain('providers:movie:GB');
    const tiles = await h.services.discover.genreTiles('movie');
    expect(tiles.map((g) => g.name)).toEqual(['Action', 'Animation']);
    const studios = await h.services.discover.companies('movie');
    expect(studios[0]).toMatchObject({ id: 2, name: 'Disney' });
    const options = await h.services.discover.filterOptions();
    expect(options).toMatchObject({ region: 'GB', language: 'en-GB', certifications: { movie: [{ certification: 'PG' }], tv: [{ certification: 'TV-14' }] } });
    expect(await h.services.discover.entity('keyword', 9715)).toEqual({ id: 9715, name: 'keyword 9715', imageUrl: null });
  });

  it('hides personal sliders from portal visitors and Recently added from users without the permission', async () => {
    const h = await harness();
    const anonymous = h.services.discover.sliders(ANONYMOUS_ACTOR).map((s) => s.type);
    expect(anonymous).not.toContain('recentRequests');
    expect(anonymous).not.toContain('watchlist');
    expect(anonymous).not.toContain('recentlyAdded');
    expect(anonymous).toContain('nowPlaying');
    const user = h.services.discover.sliders(h.user.actor).map((s) => s.type);
    expect(user).toContain('recentRequests');
    expect(user).not.toContain('recentlyAdded');
  });

  it('gives title pages release dates, certification and no personal data for visitors', async () => {
    const h = await harness();
    const detail = await h.services.discover.title(ANONYMOUS_ACTOR, 'movie', 603);
    expect(detail).toMatchObject({ requests: [], onWatchlist: false, openIssues: 0, canRequest: false });
    expect(detail.releaseDates).toEqual({ inCinemas: null, digital: null, physical: null });
    const show = await h.services.discover.title(h.user.actor, 'series', 1399);
    expect(show.releaseDates).toBeNull();
  });
});

describe('discover cache', () => {
  it('expires entries after their TTL and evicts the least recently used', async () => {
    let now = 0;
    const cache = new DiscoverCache({ maxEntries: 2, now: () => now });
    let loads = 0;
    const load = async () => ++loads;
    await cache.get('a', 1000, load);
    await cache.get('a', 1000, load);
    expect(loads).toBe(1);
    now = 2000;
    await cache.get('a', 1000, load);
    expect(loads).toBe(2);
    await cache.get('b', 1000, load);
    await cache.get('a', 1000, load); // a is now the most recent
    await cache.get('c', 1000, load); // evicts b
    expect(cache.size).toBe(2);
    await cache.get('b', 1000, load);
    expect(loads).toBe(5);
  });

  it('does not cache failures', async () => {
    const cache = new DiscoverCache();
    await expect(cache.get('x', 1000, async () => Promise.reject(new Error('down')))).rejects.toThrow('down');
    expect(await cache.get('x', 1000, async () => 'ok')).toBe('ok');
  });
});

describe('discover catalogue routes', () => {
  it('serves lists, people, tiles, options and collections over HTTP', async () => {
    const h = await buildApp();
    h.tmdb.addMovie({ tmdbId: 603, title: 'The Matrix', year: 1999 }).addMovie({ tmdbId: 604, title: 'Reloaded', year: 2003 });
    h.tmdb.collections.set(2344, [603, 604]);
    const user = addUser(h.db, { username: 'viewer', permissions: P.REQUEST });
    const cookie = h.cookieFor(user.id);
    const get = (url: string) => h.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { cookie } });
    expect((await get('/discover/list/nowPlaying?page=1')).json()).toMatchObject({ page: 1, results: [{ tmdbId: 603 }, { tmdbId: 604 }] });
    expect((await get('/discover/list/nonsense')).statusCode).toBe(400);
    expect((await get('/discover/search/people?query=lead')).json().results[0].name).toBe('Lead Actor');
    expect((await get('/discover/providers?mediaType=tv&region=gb')).json()[0].name).toBe('Streamer');
    expect(h.tmdb.calls).toContain('providers:tv:GB');
    expect((await get('/discover/genres/tiles?mediaType=movie')).statusCode).toBe(200);
    expect((await get('/discover/companies?mediaType=tv')).json()[0]).toMatchObject({ id: 213 });
    expect((await get('/discover/info/keyword/12')).json()).toMatchObject({ name: 'keyword 12' });
    expect((await get('/discover/options')).json()).toMatchObject({ region: 'US' });
    expect((await get('/discover/movies?certificationLte=PG-13&hideRequested=true')).statusCode).toBe(200);
    expect((await get('/discover/collection/2344')).json()).toMatchObject({ missing: 2, parts: [{ tmdbId: 603 }, { tmdbId: 604 }] });
    const requested = await h.app.inject({ method: 'POST', url: '/api/v1/discover/collection/2344/request', headers: { cookie }, payload: {} });
    expect(requested.statusCode).toBe(200);
    expect(requested.json().requested).toHaveLength(2);
  });

  it('keeps the catalogue public only while the portal allows anonymous browsing', async () => {
    const h = await buildApp();
    h.tmdb.addMovie({ tmdbId: 603, title: 'The Matrix', year: 1999 });
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/discover/list/topRatedMovies' })).statusCode).toBe(401);
    setSection(h.db, 'requests', RequestsSettings.parse({ publicPortal: { enabled: true, allowAnonymousDiscover: true } }));
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/discover/list/topRatedMovies' })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/discover/collection/1/request', payload: {} })).statusCode).toBe(401);
  });
});

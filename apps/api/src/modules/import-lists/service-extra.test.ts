import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { SECRET_MASK } from '@arclight/shared';
import { movies } from '../../db/schema.js';
import { settingsService } from '../settings/index.js';
import { importListAdditions, importListIdCache, importLists } from './schema.js';
import { fakeFetch, json, listInput, setup, TMDB_CONFIGURATION } from './test-support.js';

// Per-list rules (filters, streaming skip, sync interval, clean-up), preview, the Simkl PIN flow
// and the persistent id cache, over fixture responses.

const FEED_A = /feeds\.example\/a\.json$/;
const FEED_B = /feeds\.example\/b\.json$/;

/** TMDB movie details (only what the rules read). */
const details = (id: number, vote_average: number, vote_count: number, release_date = '2015-05-01') => ({
  id,
  title: `Movie ${id}`,
  release_date,
  vote_average,
  vote_count,
});

const providerEntry = (provider_id: number, provider_name: string) => ({ provider_id, provider_name, display_priority: 1 });

function routes(a: () => unknown, b: () => unknown = () => [], extra: Array<[RegExp, (url: URL) => unknown]> = []) {
  return fakeFetch([
    TMDB_CONFIGURATION,
    [FEED_A, a],
    [FEED_B, b],
    [/themoviedb\.org\/3\/movie\/1$/, () => details(1, 8.2, 5000, '2015-05-01')],
    [/themoviedb\.org\/3\/movie\/2$/, () => details(2, 5.1, 9000, '2016-01-01')],
    [/themoviedb\.org\/3\/movie\/3$/, () => details(3, 7.9, 40, '2017-01-01')],
    [/themoviedb\.org\/3\/movie\/4$/, () => details(4, 7.5, 3000, '1985-01-01')],
    [/themoviedb\.org\/3\/movie\/\d+\/watch\/providers$/, (url) => (url.pathname.includes('/movie/5/') ? { results: { US: { link: null, flatrate: [providerEntry(8, 'Netflix')] }, GB: { link: null, flatrate: [providerEntry(9, 'Prime Video')] } } } : { results: {} })],
    [/themoviedb\.org\/3\/movie\/5$/, () => details(5, 7.7, 8000, '2019-01-01')],
    ...extra,
  ]);
}

const FIVE = [1, 2, 3, 4, 5].map((id) => ({ tmdbId: id, title: `Movie ${id}` }));

/** A movie already in the library (added by hand). */
const handMovie = (tmdbId: number, year: number, profileId: number) => ({
  tmdbId,
  title: `Movie ${tmdbId}`,
  originalTitle: `Movie ${tmdbId}`,
  sortTitle: `movie ${tmdbId}`,
  cleanTitle: `movie${tmdbId}`,
  year,
  status: 'released' as const,
  genres: [],
  images: [],
  ratings: {},
  originalLanguage: 'en',
  path: `/movies/Movie ${tmdbId} (${year})`,
  rootFolderPath: '/movies',
  qualityProfileId: profileId,
  monitored: true,
  added: '2026-01-01T00:00:00Z',
  tags: [],
});

describe('per-list filters and the streaming rule', () => {
  it('preview reports what a sync would add, with reasons, before the list exists', async () => {
    const { service, db, profileId } = await setup(routes(() => [...FIVE, { imdbId: 'tt0000001', title: 'Unknown' }], undefined, [[/themoviedb\.org\/3\/find\/tt0000001$/, () => ({ movie_results: [], tv_results: [] })]]));
    db.insert(movies)
      .values(handMovie(1, 2015, profileId) as never)
      .run();
    const input = listInput(profileId, {
      settings: { url: 'https://feeds.example/a.json' },
      filters: { minRating: 7, minVotes: 100, yearFrom: 2000 },
      streaming: { enabled: true, providerIds: [8], region: null },
    });
    const preview = await service.preview(input);
    expect(preview.ok).toBe(true);
    expect(preview.itemCount).toBe(5);
    expect(preview.unresolved).toBe(1);
    expect(preview.counts).toEqual({ inLibrary: 1, rating: 1, votes: 1, year: 1, streaming: 1 });
    expect(preview.wouldAdd).toBe(0);
    expect(preview.items!.find((i) => i.tmdbId === 5)).toMatchObject({ outcome: 'streaming', streamingOn: ['Netflix'] });
    expect(service.list()).toHaveLength(0);

    // Another region: Movie 5 is not on the chosen service there, so it would be added.
    const gb = await service.preview({ ...input, streaming: { enabled: true, providerIds: [8], region: 'GB' } });
    expect(gb.wouldAdd).toBe(1);
    expect(gb.items![0]).toMatchObject({ tmdbId: 5, outcome: 'add' });
  });

  it('sync skips filtered titles but lets another list with looser rules add them', async () => {
    const fetch = routes(
      () => FIVE,
      () => [{ tmdbId: 2, title: 'Movie 2' }],
    );
    const { service, db, profileId } = await setup(fetch);
    service.create(listInput(profileId, { name: 'A strict', settings: { url: 'https://feeds.example/a.json' }, filters: { minRating: 7.6 } }));
    service.create(listInput(profileId, { name: 'B loose', settings: { url: 'https://feeds.example/b.json' } }));
    const result = await service.sync({ force: true });
    // A: 1 (8.2), 3 (7.9) and 5 (7.7) pass; 2 (5.1) and 4 (7.5) are filtered. B still adds 2.
    expect(result.added).toBe(4);
    expect(result.skippedFiltered).toBe(2);
    expect(db.select({ tmdbId: movies.tmdbId }).from(movies).all().map((m) => m.tmdbId).sort()).toEqual([1, 2, 3, 5]);
  });

  it('uses ratings the list already carried instead of looking them up', async () => {
    const fetch = fakeFetch([
      TMDB_CONFIGURATION,
      [
        /themoviedb\.org\/3\/discover\/movie$/,
        () => ({
          page: 1,
          total_pages: 1,
          results: [
            { id: 10, title: 'Good', release_date: '2010-01-01', vote_average: 8, vote_count: 900 },
            { id: 11, title: 'Bad', release_date: '2010-01-01', vote_average: 4, vote_count: 900 },
          ],
        }),
      ],
    ]);
    const { service, profileId } = await setup(fetch);
    const preview = await service.preview(listInput(profileId, { implementation: 'tmdbCompany', settings: { companyId: 1 }, filters: { minRating: 6 } }));
    expect(preview.counts).toEqual({ add: 1, rating: 1 });
    expect(fetch.calls.some((c) => /\/movie\/1[01]$/.test(c.url.pathname))).toBe(false);
  });

  it('stores and returns the rules; updates without them keep the stored values', async () => {
    const { service, profileId } = await setup(routes(() => []));
    const created = service.create(
      listInput(profileId, { syncIntervalHours: 24, filters: { minVotes: 10 }, streaming: { enabled: true, providerIds: [8, 337], region: 'DE' }, cleanupAction: 'unmonitor' }),
    );
    expect(created).toMatchObject({ syncIntervalHours: 24, filters: { minVotes: 10 }, streaming: { enabled: true, providerIds: [8, 337], region: 'DE' }, cleanupAction: 'unmonitor' });
    const kept = service.update(created.id, listInput(profileId, { name: 'Renamed' }));
    expect(kept).toMatchObject({ name: 'Renamed', syncIntervalHours: 24, cleanupAction: 'unmonitor' });
    const cleared = service.update(created.id, listInput(profileId, { syncIntervalHours: null }));
    expect(cleared.syncIntervalHours).toBeNull();
    const plain = service.create(listInput(profileId, { name: 'Plain' }));
    expect(plain).toMatchObject({ syncIntervalHours: null, filters: {}, streaming: { enabled: false, providerIds: [] }, cleanupAction: 'none' });
  });
});

describe('per-list sync interval', () => {
  it('a list with its own interval is due on that schedule, others on the global one', async () => {
    const fetch = routes(() => [], () => []);
    const { service, clock, profileId } = await setup(fetch);
    settingsService.setSection(service['db'], 'importLists', { ...service.getSettings(), syncIntervalHours: 6 });
    service.create(listInput(profileId, { name: 'Hourly', settings: { url: 'https://feeds.example/a.json' }, syncIntervalHours: 1 }));
    service.create(listInput(profileId, { name: 'Global', settings: { url: 'https://feeds.example/b.json' } }));
    expect((await service.sync()).lists).toBe(2);
    clock.now = new Date(clock.now.getTime() + 60 * 60 * 1000);
    expect((await service.sync()).lists).toBe(1);
    clock.now = new Date(clock.now.getTime() + 5 * 60 * 60 * 1000);
    expect((await service.sync()).lists).toBe(2);
  });
});

describe('per-list clean-up', () => {
  it('acts only on titles this list added that dropped off it and are on no other list', async () => {
    let a = [1, 2, 3].map((id) => ({ tmdbId: id, title: `Movie ${id}` }));
    let b: unknown[] = [];
    const fetch = routes(() => a, () => b);
    const { service, db, profileId } = await setup(fetch);
    const list = service.create(listInput(profileId, { name: 'A', settings: { url: 'https://feeds.example/a.json' }, cleanupAction: 'unmonitor' }));
    service.create(listInput(profileId, { name: 'B', settings: { url: 'https://feeds.example/b.json' }, enableAutomaticAdd: false }));
    await service.sync({ force: true });
    expect(db.select().from(importListAdditions).all().map((r) => r.tmdbId).sort()).toEqual([1, 2, 3]);

    // 2 and 3 drop off A; 3 is still on list B, so only 2 is unmonitored.
    a = [{ tmdbId: 1, title: 'Movie 1' }];
    b = [{ tmdbId: 3, title: 'Movie 3' }];
    const result = await service.sync({ force: true });
    expect(result.cleaned).toBe(1);
    const monitored = Object.fromEntries(db.select({ tmdbId: movies.tmdbId, monitored: movies.monitored }).from(movies).all().map((m) => [m.tmdbId, m.monitored]));
    expect(monitored).toEqual({ 1: true, 2: false, 3: true });
    expect(db.select().from(importListAdditions).where(eq(importListAdditions.importListId, list.id)).all().map((r) => r.tmdbId).sort()).toEqual([1, 3]);

    // An empty fetch is a source problem, not an emptied list.
    a = [];
    expect((await service.sync({ force: true })).cleaned).toBe(0);
    expect(db.select().from(movies).where(eq(movies.tmdbId, 1)).get()!.monitored).toBe(true);
  });

  it('remove deletes the library item; titles added by hand are never touched', async () => {
    let a = [{ tmdbId: 1, title: 'Movie 1' }, { tmdbId: 2, title: 'Movie 2' }];
    const fetch = routes(() => a);
    const { service, db, profileId } = await setup(fetch);
    db.insert(movies)
      .values(handMovie(2, 2016, profileId) as never)
      .run();
    service.create(listInput(profileId, { name: 'A', settings: { url: 'https://feeds.example/a.json' }, cleanupAction: 'remove' }));
    await service.sync({ force: true });
    a = [{ tmdbId: 9, title: 'Other' }];
    const result = await service.sync({ force: true });
    expect(result.cleaned).toBe(1);
    expect(db.select({ tmdbId: movies.tmdbId }).from(movies).all().map((m) => m.tmdbId).sort()).toEqual([2, 9]);
  });
});

describe('Simkl PIN flow', () => {
  const simkl = () =>
    fakeFetch([
      [/api\.simkl\.com\/oauth\/pin$/, () => ({ result: 'OK', user_code: 'ABC12', verification_url: 'https://simkl.com/pin/', expires_in: 900, interval: 5 })],
      [/api\.simkl\.com\/oauth\/pin\/ABC12$/, () => ({ result: 'OK', access_token: 'simkl-token' })],
    ]);

  it('hands out an authRef that create turns into a stored, masked token', async () => {
    const { service, db, profileId } = await setup(simkl());
    expect((await service.simklPin('client')).userCode).toBe('ABC12');
    const poll = await service.simklPoll({ userCode: 'ABC12', clientId: 'client' });
    expect(poll.status).toBe('authorized');
    const created = service.create(
      listInput(profileId, { implementation: 'simkl', mediaType: 'both', rootFolderPath: '/tv', movieRootFolderPath: '/movies', settings: { clientId: 'client', authRef: poll.authRef } }),
    );
    expect(created.settings['accessToken']).toBe(SECRET_MASK);
    expect(db.select().from(importLists).where(eq(importLists.id, created.id)).get()!.settings['accessToken']).toBe('simkl-token');
    expect(() =>
      service.create(listInput(profileId, { name: 'again', implementation: 'simkl', mediaType: 'both', rootFolderPath: '/tv', movieRootFolderPath: '/movies', settings: { clientId: 'client', authRef: poll.authRef } })),
    ).toThrow(/expired/);
  });

  it('stores the token on a saved list and refuses other list types', async () => {
    const { service, db, profileId } = await setup(simkl());
    const list = service.create(listInput(profileId, { implementation: 'simkl', mediaType: 'both', rootFolderPath: '/tv', movieRootFolderPath: '/movies', settings: { clientId: 'client' } }));
    const poll = await service.simklPoll({ userCode: 'ABC12', clientId: 'client', importListId: list.id });
    expect(poll.importList?.settings['accessToken']).toBe(SECRET_MASK);
    expect(db.select().from(importLists).where(eq(importLists.id, list.id)).get()!.settings['accessToken']).toBe('simkl-token');
    const rss = service.create(listInput(profileId, { name: 'rss' }));
    await expect(service.simklPoll({ userCode: 'ABC12', clientId: 'client', importListId: rss.id })).rejects.toThrow(/not a Simkl list/);
  });
});

describe('persistent id cache', () => {
  it('keeps Letterboxd slug lookups in the database and retries misses after a week', async () => {
    const page = '<div class="poster film-poster" data-item-slug="the-matrix" data-item-name="The Matrix (1999)"></div><div data-item-slug="gone" data-item-name="Gone (2000)"></div>';
    const fetch = fakeFetch([
      [/letterboxd\.com\/someone\/watchlist\/$/, () => new Response(page)],
      [/letterboxd\.com\/film\/the-matrix\/$/, () => new Response('<body data-tmdb-type="movie" data-tmdb-id="603"></body>')],
      [/letterboxd\.com\/film\/gone\/$/, () => new Response('<body></body>')],
    ]);
    const { service, db, clock, profileId } = await setup(fetch);
    const input = listInput(profileId, { implementation: 'letterboxd', settings: { username: 'someone' } });
    const first = await service.preview(input);
    expect(first.itemCount).toBe(1);
    expect(first.unresolved).toBe(1);
    expect(db.select().from(importListIdCache).all().map((r) => [r.key, r.tmdbId])).toEqual([
      ['the-matrix', 603],
      ['gone', null],
    ]);
    const filmCalls = () => fetch.calls.filter((c) => c.url.pathname.startsWith('/film/')).length;
    const before = filmCalls();
    await service.preview(input);
    expect(filmCalls()).toBe(before);
    clock.now = new Date(clock.now.getTime() + 8 * 24 * 3_600_000);
    await service.preview(input);
    expect(filmCalls()).toBe(before + 1);
  });
});

describe('preview errors', () => {
  it('returns the fetch error instead of throwing', async () => {
    const fetch = fakeFetch([[FEED_A, () => json({ error: 'nope' }, 500)]]);
    const { service, profileId } = await setup(fetch);
    const res = await service.preview(listInput(profileId, { settings: { url: 'https://feeds.example/a.json' } }));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBeDefined();
  });
});

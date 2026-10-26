import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { SECRET_MASK } from '@arclight/shared';
import { movies, series } from '../../db/schema.js';
import { libraryService } from '../library/index.js';
import { settingsService } from '../settings/index.js';
import { ImportListsError } from './errors.js';
import { importListItems, importLists } from './schema.js';
import { fakeFetch, json, listInput, setup, TMDB_CONFIGURATION } from './test-support.js';

const FEED_A = /feeds\.example\/a\.json$/;
const FEED_B = /feeds\.example\/b\.json$/;

function feeds(a: unknown, b: unknown = []) {
  return fakeFetch([
    [FEED_A, () => a],
    [FEED_B, () => b],
  ]);
}

const feedList = (profileId: number, name: string, file: 'a' | 'b', over: Parameters<typeof listInput>[1] = {}) =>
  listInput(profileId, { name, settings: { url: `https://feeds.example/${file}.json` }, ...over });

describe('import list CRUD', () => {
  it('validates settings per implementation', async () => {
    const { service, profileId } = await setup(feeds([]));
    expect(() => service.create(listInput(profileId, { implementation: 'tmdbList', settings: {} }))).toThrow(/settings.listId/);
    expect(() => service.create(listInput(profileId, { implementation: 'imdbList', settings: { listId: 'nope' } }))).toThrow(
      ImportListsError,
    );
    const ok = service.create(listInput(profileId, { implementation: 'tmdbPopular', settings: {} }));
    expect(ok.settings).toMatchObject({ listType: 'popular', limit: 100, languages: [] });
  });

  it('validates root folders, quality profile, media type support and unique names', async () => {
    const { service, profileId } = await setup(feeds([]));
    expect(() => service.create(listInput(profileId, { rootFolderPath: '/tv' }))).toThrow(/not a registered movie root folder/);
    expect(() => service.create(listInput(999))).toThrow(/quality profile 999/);
    expect(() =>
      service.create(listInput(profileId, { implementation: 'tmdbCollection', mediaType: 'series', rootFolderPath: '/tv', settings: { collectionId: 1 } })),
    ).toThrow(/cannot provide media type series/);
    expect(() => service.create(listInput(profileId, { mediaType: 'both', rootFolderPath: '/tv' }))).toThrow(/movieRootFolderPath/);
    const both = service.create(listInput(profileId, { mediaType: 'both', rootFolderPath: '/tv', movieRootFolderPath: '/movies' }));
    expect(both.movieRootFolderPath).toBe('/movies');
    expect(() => service.create(listInput(profileId, { mediaType: 'both', rootFolderPath: '/tv', movieRootFolderPath: '/movies' }))).toThrow(
      expect.objectContaining({ code: 'CONFLICT' }),
    );
  });

  it('masks secrets on read; the mask keeps them and null clears them', async () => {
    const { service, db, profileId } = await setup(feeds([]));
    const created = service.create(
      listInput(profileId, { implementation: 'plexWatchlist', mediaType: 'both', rootFolderPath: '/tv', movieRootFolderPath: '/movies', settings: { plexToken: 'plex-secret' } }),
    );
    expect(created.settings['plexToken']).toBe(SECRET_MASK);
    expect(JSON.stringify(service.list())).not.toContain('plex-secret');

    service.update(created.id, listInput(profileId, { name: 'Renamed', implementation: 'plexWatchlist', mediaType: 'both', rootFolderPath: '/tv', movieRootFolderPath: '/movies', settings: { plexToken: SECRET_MASK } }));
    expect(db.select().from(importLists).where(eq(importLists.id, created.id)).get()!.settings['plexToken']).toBe('plex-secret');

    expect(() =>
      service.update(created.id, listInput(profileId, { implementation: 'plexWatchlist', mediaType: 'both', rootFolderPath: '/tv', movieRootFolderPath: '/movies', settings: { plexToken: null } })),
    ).toThrow(/plexToken/);
  });

  it('does not carry secrets over when the implementation changes', async () => {
    const { service, profileId } = await setup(feeds([]));
    const created = service.create(listInput(profileId, { implementation: 'trakt', settings: { clientId: 'c', clientSecret: 's', username: 'u', listName: 'l' } }));
    const updated = service.update(created.id, listInput(profileId, { implementation: 'traktUser', settings: { clientId: 'c', clientSecret: SECRET_MASK } }));
    expect(updated.settings['clientSecret']).toBeUndefined();
  });
});

describe('sync', () => {
  it('adds each title once with the defaults of the first list and stores the items', async () => {
    const fetch = feeds(
      [{ tmdbId: 1, title: 'One' }, { tmdbId: 2, title: 'Two' }],
      [{ tmdbId: 2, title: 'Two' }, { tmdbId: 3, title: 'Three' }],
    );
    const { service, db, profileId } = await setup(fetch);
    const tag = libraryService.createTag(db, 'from-list');
    service.create(feedList(profileId, 'A list', 'a', { tags: [tag.id], minimumAvailability: 'inCinemas' }));
    service.create(feedList(profileId, 'B list', 'b', { monitorOption: 'none' }));

    const result = await service.sync({ force: true });
    expect(result).toMatchObject({ lists: 2, fetched: 4, added: 3, skippedExisting: 0, failed: 0, errors: [] });
    const rows = db.select().from(movies).all();
    expect(rows.map((m) => m.tmdbId).sort()).toEqual([1, 2, 3]);
    const two = rows.find((m) => m.tmdbId === 2)!;
    expect(two).toMatchObject({ rootFolderPath: '/movies', qualityProfileId: profileId, tags: [tag.id], minimumAvailability: 'inCinemas', monitored: true });
    expect(rows.find((m) => m.tmdbId === 3)!.monitored).toBe(false);
    expect(db.select().from(importListItems).all()).toHaveLength(4);

    const again = await service.sync({ force: true });
    expect(again).toMatchObject({ added: 0, skippedExisting: 3 });
  });

  it('respects exclusions, missing metadata and adds series with the monitor option', async () => {
    const fetch = feeds([
      { tmdbId: 10, title: 'Excluded', mediaType: 'tv' },
      { tmdbId: 11, title: 'Wanted', mediaType: 'tv' },
      { tmdbId: 12, title: 'Gone', mediaType: 'tv' },
    ]);
    const { service, db, profileId, metadata } = await setup(fetch);
    (metadata as { series: typeof metadata.series }).series = async (id) =>
      id === 12 ? null : { tmdbId: id, title: `Show ${id}`, year: 2020, status: 'continuing', seasons: [{ seasonNumber: 1 }] };
    service.createExclusion({ mediaType: 'series', tmdbId: 10, title: 'Excluded' });
    service.create(feedList(profileId, 'Shows', 'a', { mediaType: 'series', rootFolderPath: '/tv', monitorOption: 'future', seriesType: 'anime' }));

    const result = await service.sync({ force: true });
    expect(result).toMatchObject({ added: 1, skippedExcluded: 1, failed: 1 });
    const added = db.select().from(series).all();
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ tmdbId: 11, rootFolderPath: '/tv', seriesType: 'anime' });

    const preview = service.items(service.list()[0]!.id);
    expect(preview.find((i) => i.tmdbId === 10)).toMatchObject({ excluded: true, inLibrary: false });
    expect(preview.find((i) => i.tmdbId === 11)).toMatchObject({ excluded: false, inLibrary: true });
  });

  it('only fetches when automatic add is off', async () => {
    const { service, db, profileId } = await setup(feeds([{ tmdbId: 1 }]));
    service.create(feedList(profileId, 'Watch only', 'a', { enableAutomaticAdd: false }));
    const result = await service.sync({ force: true });
    expect(result).toMatchObject({ fetched: 1, added: 0 });
    expect(db.select().from(movies).all()).toHaveLength(0);
    expect(service.foundIn({ mediaType: 'movie', tmdbId: 1 })).toEqual([
      expect.objectContaining({ importListName: 'Watch only', tmdbId: 1, inLibrary: false }),
    ]);
  });

  it('a scheduled sync only fetches lists that are due and skips disabled lists', async () => {
    const fetch = feeds([{ tmdbId: 1 }], [{ tmdbId: 2 }]);
    const { service, profileId, clock } = await setup(fetch);
    service.create(feedList(profileId, 'A', 'a'));
    service.create(feedList(profileId, 'B', 'b', { enabled: false }));
    expect((await service.sync()).lists).toBe(1);
    clock.now = new Date(clock.now.getTime() + 60 * 60 * 1000);
    expect((await service.sync()).lists).toBe(0);
    settingsService.setSection(service['db'], 'importLists', { syncIntervalHours: 1, cleanLibraryLevel: 'disabled', cleanLibraryTags: [] });
    expect((await service.sync()).lists).toBe(1);
    expect(fetch.calls.filter((c) => c.url.pathname === '/b.json')).toHaveLength(0);
  });

  it('records a failing list and keeps syncing the others', async () => {
    const fetch = fakeFetch([
      [FEED_A, () => json({}, 500)],
      [FEED_B, () => [{ tmdbId: 5 }]],
    ]);
    const { service, profileId } = await setup(fetch);
    const a = service.create(feedList(profileId, 'A', 'a'));
    service.create(feedList(profileId, 'B', 'b'));
    const result = await service.sync({ force: true });
    expect(result.added).toBe(1);
    expect(result.errors).toEqual([{ importListId: a.id, name: 'A', message: 'Feed answered HTTP 500' }]);
    expect(service.get(a.id).lastSyncError).toBe('Feed answered HTTP 500');
  });

  it('resolves IMDb ids through TMDB find, and needs a key to do so', async () => {
    const fetch = fakeFetch([
      TMDB_CONFIGURATION,
      [/www\.imdb\.com\/list\/ls001\/export$/, () => new Response('Const,Title,Year,Title Type\ntt0133093,The Matrix,1999,movie\ntt9999999,Unknown,2000,movie\n')],
      [
        /themoviedb\.org\/3\/find\/tt0133093$/,
        () => ({ movie_results: [{ id: 603, title: 'The Matrix', release_date: '1999-03-30' }], tv_results: [] }),
      ],
      [/themoviedb\.org\/3\/find\/tt9999999$/, () => ({ movie_results: [], tv_results: [] })],
    ]);
    const { service, db, profileId } = await setup(fetch);
    const list = service.create(listInput(profileId, { name: 'IMDb', implementation: 'imdbList', settings: { listId: 'ls001' } }));
    const result = await service.sync({ force: true });
    expect(result).toMatchObject({ fetched: 1, added: 1 });
    expect(service.items(list.id)).toEqual([expect.objectContaining({ tmdbId: 603, imdbId: 'tt0133093', title: 'The Matrix' })]);
    expect(db.select().from(movies).get()!.tmdbId).toBe(603);

    const noKey = await setup(fetch, { tmdbKey: null });
    noKey.service.create(listInput(noKey.profileId, { name: 'IMDb', implementation: 'imdbList', settings: { listId: 'ls001' } }));
    const failed = await noKey.service.sync({ force: true });
    expect(failed.errors[0]!.message).toMatch(/TMDB API key is not configured/);
  });

  it('triggers a search for titles added from lists with search on add', async () => {
    const { service, profileId, searches, db } = await setup(feeds([{ tmdbId: 1 }], [{ tmdbId: 2 }]));
    service.create(feedList(profileId, 'A', 'a', { searchOnAdd: true }));
    service.create(feedList(profileId, 'B', 'b'));
    await service.sync({ force: true });
    await new Promise((r) => setImmediate(r));
    const id = db.select().from(movies).where(eq(movies.tmdbId, 1)).get()!.id;
    expect(searches).toEqual([{ movieId: id }]);
  });
});

describe('clean library', () => {
  async function seeded(level: 'unmonitor' | 'remove' | 'logOnly', tags: number[] = []) {
    const fetch = feeds([{ tmdbId: 1 }]);
    const ctx = await setup(fetch);
    const { service, db, profileId, metadata } = ctx;
    const keep = libraryService.createTag(db, 'keep');
    for (const id of [1, 2, 3]) {
      const meta = (await metadata.movie(id))!;
      libraryService.addMovie(db, meta, {
        tmdbId: id,
        rootFolderPath: '/movies',
        qualityProfileId: profileId,
        monitored: true,
        minimumAvailability: 'released',
        tags: id === 3 ? [keep.id] : [],
        searchOnAdd: false,
      });
    }
    const showMeta = (await metadata.series(50))!;
    libraryService.addSeries(db, showMeta, {
      tmdbId: 50,
      rootFolderPath: '/tv',
      qualityProfileId: profileId,
      monitored: true,
      monitorOption: 'all',
      monitorNewItems: 'all',
      seriesType: 'standard',
      seasonFolder: true,
      tags: [],
      searchOnAdd: false,
    });
    settingsService.setSection(db, 'importLists', {
      syncIntervalHours: 6,
      cleanLibraryLevel: level,
      cleanLibraryTags: tags.length ? [keep.id] : [],
    });
    service.create(feedList(profileId, 'A', 'a'));
    return { ...ctx, fetch, keep };
  }

  it('unmonitors movies on no list, leaving series alone when no list covers series', async () => {
    const { service, db } = await seeded('unmonitor');
    const result = await service.sync({ force: true });
    expect(result.cleaned).toBe(2);
    const byId = new Map(db.select().from(movies).all().map((m) => [m.tmdbId, m.monitored]));
    expect([...byId.entries()].sort()).toEqual([
      [1, true],
      [2, false],
      [3, false],
    ]);
    expect(db.select().from(series).get()!.monitored).toBe(true);
  });

  it('restricts cleaning to cleanLibraryTags and can remove', async () => {
    const { service, db } = await seeded('remove', [1]);
    const result = await service.sync({ force: true });
    expect(result.cleaned).toBe(1);
    expect(db.select().from(movies).all().map((m) => m.tmdbId).sort()).toEqual([1, 2]);
  });

  it('logOnly changes nothing and a failed list blocks cleaning', async () => {
    const quiet = await seeded('logOnly');
    expect((await quiet.service.sync({ force: true })).cleaned).toBe(0);
    expect(quiet.db.select().from(movies).all().every((m) => m.monitored)).toBe(true);

    const { service, db, profileId } = await seeded('unmonitor');
    service.create(listInput(profileId, { name: 'Broken', settings: { url: 'https://feeds.example/missing.json' } }));
    const result = await service.sync({ force: true });
    expect(result.errors).toHaveLength(1);
    expect(result.cleaned).toBe(0);
    expect(db.select().from(movies).all().every((m) => m.monitored)).toBe(true);
  });
});

describe('test endpoint', () => {
  it('returns the first items with library flags, or the fetch error', async () => {
    const fetch = feeds(Array.from({ length: 15 }, (_, i) => ({ tmdbId: i + 1, title: `T${i + 1}` })));
    const { service, profileId } = await setup(fetch);
    service.createExclusion({ mediaType: 'movie', tmdbId: 2, title: 'T2' });
    const ok = await service.test({ ...feedList(profileId, 'A', 'a') });
    expect(ok.ok).toBe(true);
    expect(ok.itemCount).toBe(15);
    expect(ok.items).toHaveLength(10);
    expect(ok.items![1]).toMatchObject({ tmdbId: 2, excluded: true });

    const bad = await service.test({ ...listInput(profileId, { settings: { url: 'https://feeds.example/missing.json' } }) });
    expect(bad).toEqual({ ok: false, error: { code: 'not-found', message: 'Feed has no such list (HTTP 404)' } });
  });
});

describe('trakt device flow', () => {
  const tokenRoute = (body: object) =>
    fakeFetch([
      [/oauth\/device\/token$/, () => body],
      [/\/users\/alice\/lists\/faves\/items\/movie$/, () => []],
    ]);

  it('returns an authRef for unsaved lists; create consumes it and stores masked tokens', async () => {
    const fetch = tokenRoute({ access_token: 'at-secret', refresh_token: 'rt-secret', expires_in: 3600 });
    const { service, db, profileId } = await setup(fetch);
    const poll = await service.traktPoll({ deviceCode: 'dc', clientId: 'cid', clientSecret: 'cs-secret' });
    expect(poll.status).toBe('authorized');
    expect(JSON.stringify(poll)).not.toContain('secret');
    const settings = { clientId: 'cid', username: 'alice', listName: 'faves', authRef: poll.authRef };
    const created = service.create(listInput(profileId, { implementation: 'trakt', settings }));
    expect(created.settings).toMatchObject({ accessToken: SECRET_MASK, refreshToken: SECRET_MASK, clientSecret: SECRET_MASK });
    expect(created.settings['authRef']).toBeUndefined();
    const stored = db.select().from(importLists).get()!.settings;
    expect(stored).toMatchObject({ accessToken: 'at-secret', refreshToken: 'rt-secret', clientSecret: 'cs-secret' });

    expect(() => service.create(listInput(profileId, { name: 'Again', implementation: 'trakt', settings }))).toThrow(/authorization expired/);
  });

  it('stores tokens on a saved list using its stored client secret', async () => {
    const fetch = tokenRoute({ access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 });
    const { service, db, profileId } = await setup(fetch);
    const list = service.create(
      listInput(profileId, { implementation: 'trakt', settings: { clientId: 'cid', clientSecret: 'stored-cs', username: 'alice', listName: 'faves' } }),
    );
    const res = await service.traktPoll({ deviceCode: 'dc', clientId: 'cid', clientSecret: SECRET_MASK, importListId: list.id });
    expect(res.importList?.settings['accessToken']).toBe(SECRET_MASK);
    expect(fetch.calls[0]!.body).toMatchObject({ code: 'dc', client_secret: 'stored-cs' });
    expect(db.select().from(importLists).get()!.settings['accessToken']).toBe('at2');

    const plain = service.create(listInput(profileId, { name: 'Feed' }));
    await expect(service.traktPoll({ deviceCode: 'dc', clientId: 'cid', importListId: plain.id })).rejects.toThrow(/not a Trakt list/);
  });
});

describe('exclusions', () => {
  it('supports CRUD on the shared library exclusion table', async () => {
    const { service, db } = await setup(feeds([]));
    const ex = service.createExclusion({ mediaType: 'movie', tmdbId: 603, title: 'The Matrix', year: 1999 });
    expect(libraryService.isExcluded(db, 'movie', 603)).toBe(true);
    expect(() => service.createExclusion({ mediaType: 'movie', tmdbId: 603, title: 'Dup' })).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    expect(service.updateExclusion(ex.id, { mediaType: 'movie', tmdbId: 604, title: 'Reloaded' })).toMatchObject({ tmdbId: 604, year: null });
    expect(service.listExclusions()).toHaveLength(1);
    service.deleteExclusion(ex.id);
    expect(() => service.getExclusion(ex.id)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });
});

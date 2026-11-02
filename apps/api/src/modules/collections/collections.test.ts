import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { Permission, type MediaServerConfig } from '@arclight/shared';
import type { MediaServerItem } from '@arclight/media-servers';
import type { Db } from '../../db/index.js';
import { mediaFiles, movies, retentionCandidates, retentionRules, series } from '../../db/schema.js';
import { authServiceFor, installAuth } from '../auth/index.js';
import { jellyfinPluginModule } from '../jellyfin-plugin/index.js';
import { MediaServersService, setMediaServersService } from '../media-servers/index.js';
import { requestsModuleWith } from '../requests/index.js';
import { addUser, setup } from '../requests/test-support.js';
import { setSection } from '../settings/service.js';
import { mediaServerUsers, watchHistoryModule, watchState } from '../watch-history/index.js';
import { addMovie, addSeries, FakeJellyfin } from '../watch-history/test-support.js';
import { collectionsModule } from './index.js';
import { CollectionsService, type CollectionServer } from './service.js';

const NOW = new Date('2026-11-02T12:00:00.000Z');
const DAY = 24 * 60 * 60_000;

/** An in-memory Jellyfin as far as collections go. */
type CollectionClient = CollectionServer['client'];

class FakeCollections implements CollectionClient {
  items: { movie: MediaServerItem[]; series: MediaServerItem[] } = { movie: [], series: [] };
  boxes = new Map<string, { name: string; items: string[]; overview: string | null }>();
  calls: string[] = [];
  private next = 1;
  fail = false;

  async listItems(kind: 'movie' | 'series'): Promise<MediaServerItem[]> {
    if (this.fail) throw new Error('server unreachable');
    return this.items[kind];
  }
  async collections() {
    return [...this.boxes].map(([id, b]) => ({ id, name: b.name, overview: b.overview }));
  }
  async collectionItemIds(id: string) {
    return this.boxes.get(id)?.items.slice() ?? null;
  }
  async createCollection(name: string, ids: string[] = []) {
    const id = `box${this.next++}`;
    this.boxes.set(id, { name, items: [...ids], overview: null });
    this.calls.push(`create ${name}`);
    return id;
  }
  async addToCollection(id: string, ids: string[]) {
    this.boxes.get(id)!.items.push(...ids);
    this.calls.push(`add ${id} ${ids.join(',')}`);
  }
  async removeFromCollection(id: string, ids: string[]) {
    const b = this.boxes.get(id)!;
    b.items = b.items.filter((x) => !ids.includes(x));
    this.calls.push(`remove ${id} ${ids.join(',')}`);
  }
  async deleteCollection(id: string) {
    this.boxes.delete(id);
    this.calls.push(`delete ${id}`);
  }
  async setCollectionOverview(id: string, overview: string) {
    this.boxes.get(id)!.overview = overview;
  }
  byName(name: string) {
    return [...this.boxes.values()].find((b) => b.name === name);
  }
}

const SERVER = { id: 'jf1', name: 'Den', kind: 'jellyfin', enabled: true, url: 'http://jellyfin.example.com', apiKey: 'k' } as MediaServerConfig;

function movie(db: Db, tmdbId: number, title: string, o: { year?: number; genres?: string[]; studio?: string; collection?: number; rating?: number; added?: string; file?: boolean } = {}): number {
  const id = addMovie(db, tmdbId, title, { added: o.added ?? '2025-01-01T00:00:00.000Z' });
  db.update(movies)
    .set({
      year: o.year ?? 2020,
      genres: o.genres ?? [],
      studio: o.studio ?? null,
      collection: o.collection ? { tmdbId: o.collection, title: `Collection ${o.collection}` } : null,
      ratings: o.rating !== undefined ? { tmdb: { votes: 100, value: o.rating } } : {},
      hasFile: o.file ?? true,
    })
    .where(eq(movies.id, id))
    .run();
  return id;
}

function show(db: Db, tmdbId: number, title: string, o: { genres?: string[]; network?: string; file?: boolean } = {}): number {
  const id = addSeries(db, tmdbId, tmdbId + 1000, title, [1]);
  db.update(series).set({ genres: o.genres ?? [], network: o.network ?? null }).where(eq(series.id, id)).run();
  if (o.file ?? true) {
    db.insert(mediaFiles)
      .values({ mediaType: 'series', seriesId: id, seasonNumber: 1, relativePath: `${title}.mkv`, path: `/tv/${title}.mkv`, dateAdded: NOW.toISOString(), quality: {} as never, languages: [] })
      .run();
  }
  return id;
}

async function harness() {
  const h = await setup();
  const fake = new FakeCollections();
  let servers: MediaServerConfig[] = [SERVER];
  const lists = new Map<string, number[]>([
    ['trending:movie', [3, 1]],
    ['trending:tv', [50]],
  ]);
  const svc = new CollectionsService({
    db: h.db,
    servers: () => servers,
    client: () => fake,
    lists: async (list, kind) => lists.get(`${list}:${kind}`) ?? [],
    now: () => NOW,
  });
  const m = {
    heat: movie(h.db, 1, 'Heatwave', { year: 1995, genres: ['Action', 'Thriller'], studio: 'Lumen Pictures', collection: 900, rating: 7.9, added: new Date(NOW.getTime() - 3 * DAY).toISOString() }),
    quiet: movie(h.db, 2, 'Quiet Fields', { year: 1998, genres: ['Drama'], rating: 6.1 }),
    rush: movie(h.db, 3, 'Rush Hour Blues', { year: 2011, genres: ['Action', 'Comedy'], studio: 'lumen pictures', collection: 900, rating: 8.4 }),
    gone: movie(h.db, 4, 'No File', { year: 1996, genres: ['Action'], file: false }),
  };
  const s = { harbour: show(h.db, 50, 'Harbour Lights', { genres: ['Drama', 'Comedy'], network: 'Channel Nine' }) };
  fake.items.movie = [
    { id: 'jm1', ids: { tmdbId: 1 } },
    { id: 'jm2', ids: { imdbId: null, tmdbId: 2 } },
    { id: 'jm3', ids: { tmdbId: 3 } },
  ] as MediaServerItem[];
  fake.items.series = [{ id: 'js1', ids: { tvdbId: 1050 } }] as MediaServerItem[];
  return { ...h, svc, fake, m, s, setServers: (x: MediaServerConfig[]) => (servers = x) };
}

const titles = (items: { title: string }[]) => items.map((i) => i.title);

describe('smart collection rules', () => {
  it('filters by genre, decade, studio, TMDB collection, rating and recently added', async () => {
    const t = await harness();
    expect(titles(await t.svc.evaluate({ name: 'x', criteria: { genres: ['action'] }, sort: 'title' }))).toEqual(['Heatwave', 'Rush Hour Blues']);
    expect(titles(await t.svc.evaluate({ name: 'x', criteria: { genres: ['Action', 'Comedy'], genreMatch: 'all' } }))).toEqual(['Rush Hour Blues']);
    expect(titles(await t.svc.evaluate({ name: 'x', criteria: { yearFrom: 1990, yearTo: 1999 }, sort: 'year' }))).toEqual(['Quiet Fields', 'Heatwave']);
    expect(titles(await t.svc.evaluate({ name: 'x', criteria: { studios: ['LUMEN PICTURES'], excludeGenres: ['Comedy'] } }))).toEqual(['Heatwave']);
    expect(titles(await t.svc.evaluate({ name: 'x', criteria: { tmdbCollectionIds: [900] }, sort: 'rating' }))).toEqual(['Rush Hour Blues', 'Heatwave']);
    expect(titles(await t.svc.evaluate({ name: 'x', criteria: { minRating: 7 }, sort: 'rating', limit: 1 }))).toEqual(['Rush Hour Blues']);
    expect(titles(await t.svc.evaluate({ name: 'x', criteria: { addedWithinDays: 7 } }))).toEqual(['Heatwave']);
    expect(titles(await t.svc.evaluate({ name: 'x', mediaType: 'all', criteria: { genres: ['comedy'] }, sort: 'title' }))).toEqual(['Harbour Lights', 'Rush Hour Blues']);
    expect(titles(await t.svc.evaluate({ name: 'x', mediaType: 'series', criteria: { studios: ['channel nine'] } }))).toEqual(['Harbour Lights']);
  });

  it('intersects trending lists with the library in list order', async () => {
    const t = await harness();
    expect(titles(await t.svc.evaluate({ name: 'x', mediaType: 'all', criteria: { list: 'trending' }, sort: 'list' }))).toEqual(['Harbour Lights', 'Rush Hour Blues', 'Heatwave']);
    // Movie and series lists interleave by position (ties by title).
  });

  it('filters by watch status across the server and sorts by plays', async () => {
    const t = await harness();
    const acct = t.db.insert(mediaServerUsers).values({ serverId: 'jf1', externalId: 'a', name: 'a', firstSeenAt: NOW.toISOString(), updatedAt: NOW.toISOString() }).returning().get().id;
    const state = (movieId: number, o: { played?: boolean; playCount?: number; positionMs?: number }) =>
      t.db
        .insert(watchState)
        .values({ serverId: 'jf1', mediaServerUserId: acct, jellyfinItemId: `i${movieId}`, itemType: 'movie', itemKey: `movie:${movieId}`, movieId, title: 't', updatedAt: NOW.toISOString(), ...o })
        .run();
    state(t.m.heat, { played: true, playCount: 3 });
    state(t.m.quiet, { positionMs: 60_000 });
    expect(titles(await t.svc.evaluate({ name: 'x', criteria: { watchStatus: 'watched' } }))).toEqual(['Heatwave']);
    expect(titles(await t.svc.evaluate({ name: 'x', criteria: { watchStatus: 'inProgress' } }))).toEqual(['Quiet Fields']);
    expect(titles(await t.svc.evaluate({ name: 'x', criteria: { watchStatus: 'unwatched' } }))).toEqual(['Rush Hour Blues']);
    expect(titles(await t.svc.evaluate({ name: 'x', sort: 'plays', limit: 1 }))).toEqual(['Heatwave']);
  });

  it('validates names and year ranges', async () => {
    const t = await harness();
    t.svc.create({ name: 'Action' });
    expect(() => t.svc.create({ name: ' action ' })).toThrow(/already exists/);
    expect(() => t.svc.create({ name: 'Leaving Soon' })).toThrow(/Leaving Soon/);
    expect(() => t.svc.create({ name: 'Bad', criteria: { yearFrom: 2000, yearTo: 1990 } })).toThrow(/yearFrom/);
  });
});

describe('Leaving Soon', () => {
  async function withCandidates() {
    const t = await harness();
    const rule = (o: { enabled?: boolean; dryRun?: boolean }) =>
      t.db
        .insert(retentionRules)
        .values({ name: `r${Math.random()}`, mediaType: 'movie', scope: {} as never, conditions: [], action: 'deleteFiles', enabled: o.enabled ?? true, dryRun: o.dryRun ?? false, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() })
        .returning()
        .get().id;
    const live = rule({});
    const dry = rule({ dryRun: true });
    const cand = (ruleId: number, mediaId: number, days: number, o: { status?: 'pending' | 'kept' | 'failed'; action?: 'deleteFiles' | 'unmonitor' } = {}) =>
      t.db
        .insert(retentionCandidates)
        .values({
          ruleId,
          mediaType: 'movie',
          mediaId,
          tmdbId: 0,
          title: 't',
          action: o.action ?? 'deleteFiles',
          reasons: [],
          watchedBy: [],
          status: o.status ?? 'pending',
          firstSeenAt: NOW.toISOString(),
          lastSeenAt: NOW.toISOString(),
          applyAfter: new Date(NOW.getTime() + days * DAY).toISOString(),
        })
        .run();
    cand(live, t.m.rush, 5);
    cand(live, t.m.heat, -1); // overdue: shown as today
    cand(live, t.m.quiet, 30); // beyond the window
    cand(dry, t.m.quiet, 1); // dry-run rule
    const extra = rule({});
    cand(extra, t.m.quiet, 2, { status: 'kept' });
    cand(extra, t.m.rush, 2, { action: 'unmonitor' });
    return t;
  }

  it('lists what live rules delete within the window, soonest first', async () => {
    const t = await withCandidates();
    const items = t.svc.leavingSoonItems(14);
    expect(items.map((i) => [i.title, i.removeAt])).toEqual([
      ['Heatwave', NOW.toISOString()],
      ['Rush Hour Blues', new Date(NOW.getTime() + 5 * DAY).toISOString()],
    ]);
  });

  it('syncs Leaving Soon and smart collections, updates them, renames, adopts and removes', async () => {
    const t = await withCandidates();
    setSection(t.db, 'collections', { leavingSoon: { enabled: true, days: 14, name: 'Leaving Soon', showInJellyfin: true }, serverIds: [] });
    const action = t.svc.create({ name: 'Action', criteria: { genres: ['Action'] } });
    // An existing collection with the same name is adopted, not duplicated.
    t.fake.boxes.set('mine', { name: 'Action', items: ['jm2'], overview: null });

    const r1 = await t.svc.sync();
    expect(r1).toMatchObject({ collections: 2, servers: 1, created: 1, errors: [] });
    expect(t.fake.byName('Leaving Soon')!.items.sort()).toEqual(['jm1', 'jm3']);
    expect(t.fake.byName('Leaving Soon')!.overview).toContain('Heatwave (1995)');
    expect(t.fake.boxes.get('mine')!.items.sort()).toEqual(['jm1', 'jm3']);
    expect(t.svc.get(action.id).sync[0]).toMatchObject({ serverId: 'jf1', serverName: 'Den', remoteId: 'mine', itemCount: 2, missing: 0, lastError: null });

    // Nothing changed: no calls but the reads.
    t.fake.calls = [];
    await t.svc.sync();
    expect(t.fake.calls).toEqual([]);

    // A new action movie on the server, and a rename.
    movie(t.db, 5, 'Late Arrival', { genres: ['Action'] });
    t.fake.items.movie.push({ id: 'jm5', ids: { tmdbId: 5 } } as MediaServerItem);
    t.svc.update(action.id, { name: 'Action Movies', criteria: { genres: ['Action'] } });
    await t.svc.sync();
    expect(t.fake.boxes.has('mine')).toBe(false);
    expect(t.fake.byName('Action Movies')!.items.sort()).toEqual(['jm1', 'jm3', 'jm5']);

    // A title missing on the server is counted, not fatal.
    movie(t.db, 6, 'Not On Server', { genres: ['Action'] });
    await t.svc.sync();
    expect(t.svc.get(action.id).sync[0]).toMatchObject({ itemCount: 3, missing: 1 });

    // Rule deleted and Leaving Soon off: only our collections go.
    t.fake.boxes.set('theirs', { name: 'Family Picks', items: ['jm2'], overview: null });
    t.svc.delete(action.id);
    setSection(t.db, 'collections', { leavingSoon: { enabled: false, days: 14, name: 'Leaving Soon', showInJellyfin: true }, serverIds: [] });
    const r = await t.svc.sync();
    expect(r.deleted).toBe(2);
    expect([...t.fake.boxes.keys()]).toEqual(['theirs']);
    expect(t.svc.syncStates()).toEqual([]);
  });

  it('records server errors per collection and skips non-Jellyfin servers', async () => {
    const t = await harness();
    t.svc.create({ name: 'Drama', criteria: { genres: ['Drama'] } });
    t.setServers([SERVER, { ...SERVER, id: 'plex', name: 'Plex', kind: 'plex' } as MediaServerConfig]);
    t.fake.fail = true;
    const r = await t.svc.sync();
    expect(r.servers).toBe(1);
    expect(r.errors[0]).toContain('server unreachable');
    expect(t.svc.list()[0]!.sync[0]).toMatchObject({ remoteId: null, lastError: 'server unreachable' });
    t.fake.fail = false;
    await t.svc.sync();
    expect(t.svc.list()[0]!.sync[0]).toMatchObject({ itemCount: 1, lastError: null, remoteId: expect.any(String) });
  });

  it('removes collections from a server that is no longer chosen', async () => {
    const t = await harness();
    t.svc.create({ name: 'Drama', criteria: { genres: ['Drama'] } });
    await t.svc.sync();
    expect(t.fake.byName('Drama')).toBeDefined();
    setSection(t.db, 'collections', { leavingSoon: { enabled: false, days: 14, name: 'Leaving Soon', showInJellyfin: true }, serverIds: ['other'] });
    await t.svc.sync();
    expect(t.fake.byName('Drama')).toBeUndefined();
  });
});

describe('collections routes', () => {
  it('serves rule CRUD, preview, settings and the plugin Leaving Soon row', async () => {
    const h = await setup();
    const fake = new FakeJellyfin();
    const servers = new MediaServersService({ db: h.db, fetch: fake.fetch, newId: () => 'jf1' });
    setMediaServersService(h.ctx, servers);
    servers.create({ kind: 'jellyfin', name: 'Den', url: 'http://jellyfin.test', apiKey: fake.apiKey, loginEnabled: true, createUsersOnLogin: false });
    addUser(h.db, { role: 'admin', username: 'owner' });
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(
      async (api) => {
        installAuth(api, h.ctx);
        await api.register(requestsModuleWith({})(h.ctx));
        await api.register(watchHistoryModule(h.ctx));
        await api.register(jellyfinPluginModule(h.ctx));
        await api.register(collectionsModule(h.ctx));
      },
      { prefix: '/api/v1' },
    );
    await app.ready();
    const auth = authServiceFor(h.ctx);
    const admin = { 'x-api-key': auth.apiKey() };
    const plugin = { 'x-api-key': auth.createPluginKey('t').key, 'x-arclight-jellyfin-user': 'aaaaaaaa1111aaaa1111aaaaaaaaaaaa' };
    addUser(h.db, { username: 'alice', permissions: Permission.REQUEST, settings: { mediaServerLink: { kind: 'jellyfin', externalId: 'aaaaaaaa1111aaaa1111aaaaaaaaaaaa', username: 'alice', linkedAt: '2026-01-01T00:00:00.000Z' } } });
    movie(h.db, 1, 'Heatwave', { genres: ['Action'] });

    const created = await app.inject({ method: 'POST', url: '/api/v1/collections/smart', headers: admin, payload: { name: 'Action', criteria: { genres: ['Action'] } } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect((await app.inject({ method: 'GET', url: `/api/v1/collections/smart/${id}/items`, headers: admin })).json()).toMatchObject({ total: 1, items: [{ title: 'Heatwave' }] });
    expect((await app.inject({ method: 'POST', url: '/api/v1/collections/smart/preview', headers: admin, payload: { name: 'p', criteria: { genres: ['Drama'] } } })).json().total).toBe(0);
    expect((await app.inject({ method: 'POST', url: '/api/v1/collections/smart', headers: admin, payload: { name: 'Action' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/collections/smart/999', headers: admin })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/collections/sync', headers: admin })).json().servers).toEqual([{ id: 'jf1', name: 'Den' }]);

    // Leaving Soon is off by default: the plugin row answers 403.
    expect((await app.inject({ method: 'GET', url: '/api/v1/jellyfin/leaving-soon', headers: plugin })).statusCode).toBe(403);
    const settings = (await app.inject({ method: 'GET', url: '/api/v1/settings/collections', headers: admin })).json();
    const put = await app.inject({ method: 'PUT', url: '/api/v1/settings/collections', headers: admin, payload: { ...settings, leavingSoon: { ...settings.leavingSoon, enabled: true } } });
    expect(put.statusCode).toBe(200);
    const row = await app.inject({ method: 'GET', url: '/api/v1/jellyfin/leaving-soon', headers: plugin });
    expect(row.statusCode).toBe(200);
    expect(row.json()).toEqual({ name: 'Leaving Soon', days: 14, items: [] });
    // Plugin keys cannot manage rules.
    expect((await app.inject({ method: 'GET', url: '/api/v1/collections/smart', headers: plugin })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/collections/smart/${id}`, headers: admin })).statusCode).toBe(204);
  });
});

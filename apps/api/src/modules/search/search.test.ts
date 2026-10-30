import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Permission, UniversalSearchQuery, type AppArea, type UniversalSearchResponse } from '@arclight/shared';
import { buildApp, type AppContext } from '../../app.js';
import type { AppConfig } from '../../config.js';
import type { Db } from '../../db/index.js';
import { indexers, issues, mediaRequests, movies, qualityProfiles, series, tags, trackedDownloads } from '../../db/schema.js';
import { createTestDb, seedAdmin } from '../../db/test-utils.js';
import { authServiceFor, SESSION_COOKIE } from '../auth/index.js';
import { universalSearch, type SearchScope } from './service.js';

const now = '2026-01-01T00:00:00.000Z';
const ADMIN: SearchScope = { isAdmin: true, appAccess: ['library', 'calendar', 'activity', 'wanted'], userId: null, permissions: 0 };

let seq = 0;
function addMovie(db: Db, title: string, hasFile = false): number {
  seq += 1;
  return db
    .insert(movies)
    .values({
      tmdbId: 1000 + seq,
      title,
      originalTitle: title,
      sortTitle: title.toLowerCase(),
      cleanTitle: title.toLowerCase().replace(/[^a-z0-9]/g, ''),
      year: 2020,
      status: 'released',
      genres: [],
      images: [{ coverType: 'poster', url: `/poster/${seq}.jpg` }],
      ratings: {},
      originalLanguage: 'en',
      path: `/movies/${seq}`,
      rootFolderPath: '/movies',
      qualityProfileId: 1,
      tags: [],
      added: now,
      hasFile,
    })
    .returning({ id: movies.id })
    .get().id;
}

function addSeries(db: Db, title: string): number {
  seq += 1;
  return db
    .insert(series)
    .values({
      tmdbId: 2000 + seq,
      title,
      sortTitle: title.toLowerCase(),
      cleanTitle: title.toLowerCase().replace(/[^a-z0-9]/g, ''),
      year: 2019,
      status: 'continuing',
      genres: [],
      images: [],
      ratings: {},
      originalLanguage: 'en',
      path: `/tv/${seq}`,
      rootFolderPath: '/tv',
      qualityProfileId: 1,
      tags: [],
      added: now,
    })
    .returning({ id: series.id })
    .get().id;
}

function addRequest(db: Db, title: string, requestedById: number): number {
  seq += 1;
  return db
    .insert(mediaRequests)
    .values({ type: 'movie', status: 'pending', tmdbId: 3000 + seq, title, year: 2021, requestedById, tags: [], createdAt: now, updatedAt: now })
    .returning({ id: mediaRequests.id })
    .get().id;
}

function addIssue(db: Db, title: string, createdById: number): number {
  seq += 1;
  return db
    .insert(issues)
    .values({ type: 'video', status: 'open', mediaType: 'movie', tmdbId: 4000 + seq, title, createdById, createdAt: now, updatedAt: now })
    .returning({ id: issues.id })
    .get().id;
}

/** Library, settings, activity rows all matching "dune". */
function seedDune(db: Db): void {
  addMovie(db, 'Dune', true);
  db.insert(indexers).values({ name: 'Dune Indexer', implementation: 'Newznab' as never, tags: [], settings: {} as never, addedAt: now }).run();
  db.insert(tags).values({ label: 'dune-fans' }).run();
  db.insert(qualityProfiles).values({ name: 'Dune HD', cutoff: 1, items: [], formatItems: [], languages: [] }).run();
  db.insert(trackedDownloads)
    .values({ downloadId: 'abc', title: 'Dune.2021.1080p', state: 'downloading', statusMessages: [], protocol: 'torrent', addedAt: now, updatedAt: now })
    .run();
}

const search = (db: Db, scope: SearchScope, q: string, limit?: number) =>
  universalSearch(db, scope, UniversalSearchQuery.parse(limit === undefined ? { q } : { q, limit }));
const kindsOf = (res: UniversalSearchResponse) => res.results.map((r) => r.kind);
const titlesOf = (res: UniversalSearchResponse, kind: string) => res.results.find((r) => r.kind === kind)?.hits.map((h) => h.title) ?? [];

describe('universalSearch (service)', () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
  });

  it('ranks exact before prefix before substring', () => {
    addMovie(db, 'The Dune Chronicles');
    addMovie(db, 'Dune: Part Two');
    const dune = addMovie(db, 'Dune', true);
    addMovie(db, 'Arrival');
    const res = search(db, ADMIN, 'dune');
    expect(kindsOf(res)).toEqual(['movie']);
    expect(titlesOf(res, 'movie')).toEqual(['Dune', 'Dune: Part Two', 'The Dune Chronicles']);
    const first = res.results[0]!.hits[0]!;
    expect(first).toMatchObject({ kind: 'movie', id: dune, subtitle: '2020', status: 'downloaded', poster: expect.stringContaining('/poster/'), parentId: null });
    expect(first.score).toBeGreaterThan(res.results[0]!.hits[1]!.score);
  });

  it('forgives loose matches (subsequence) and is case and punctuation blind', () => {
    addMovie(db, 'Dune: Part Two');
    addMovie(db, 'The Dune Chronicles');
    expect(titlesOf(search(db, ADMIN, 'dn prt'), 'movie')).toEqual(['Dune: Part Two']);
    expect(titlesOf(search(db, ADMIN, 'DUNE—part'), 'movie')).toEqual(['Dune: Part Two']);
    expect(search(db, ADMIN, 'zzz').results).toEqual([]);
  });

  it('caps hits per kind and reports the total', () => {
    for (let i = 1; i <= 5; i++) addSeries(db, `Gamma ${i}`);
    const res = search(db, ADMIN, 'gamma', 2);
    expect(res.results).toEqual([{ kind: 'series', total: 5, hits: [expect.objectContaining({ title: 'Gamma 1' }), expect.objectContaining({ title: 'Gamma 2' })] }]);
  });

  it('orders kinds by the enum and scopes requests and issues to their owner', () => {
    seedDune(db);
    addRequest(db, 'Dune Messiah', 7);
    addRequest(db, 'Dune Prophecy', 8);
    addIssue(db, 'Dune', 8);
    expect(kindsOf(search(db, ADMIN, 'dune'))).toEqual(['movie', 'indexer', 'qualityProfile', 'tag', 'queue', 'request', 'issue']);
    const portal = search(db, { isAdmin: false, appAccess: [], userId: 7, permissions: Permission.REQUEST }, 'dune');
    expect(portal.results.map((r) => [r.kind, r.hits.map((h) => h.title)])).toEqual([['request', ['Dune Messiah']]]);
    const viewer = search(db, { isAdmin: false, appAccess: [], userId: 7, permissions: Permission.REQUEST_VIEW | Permission.VIEW_ISSUES }, 'dune');
    expect(viewer.results.map((r) => [r.kind, r.total])).toEqual([
      ['request', 2],
      ['issue', 1],
    ]);
  });
});

// ---------------------------------------------------------------------------------------
// HTTP: route, validation and per-caller scoping
// ---------------------------------------------------------------------------------------

const config: AppConfig = { configDir: '.', dbPath: ':memory:', logDir: '.', port: 0, host: '127.0.0.1', logLevel: 'silent', isDocker: false, webDist: null };

interface Harness {
  app: Awaited<ReturnType<typeof buildApp>>;
  ctx: AppContext;
  db: Db;
}
const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.app.close();
});

async function harness(): Promise<Harness> {
  const db = await createTestDb();
  seedAdmin(db);
  let ctx: AppContext | undefined;
  const app = await buildApp(config, db, pino({ level: 'silent' }), { probe: false, onContext: (c) => (ctx = c) });
  await app.ready();
  const h = { app, ctx: ctx!, db };
  open.push(h);
  return h;
}

async function signedIn(h: Harness, opts: { appAccess?: AppArea[]; permissions?: number } = {}): Promise<{ cookie: string; id: number }> {
  const auth = authServiceFor(h.ctx);
  const user = await auth.createUser({
    username: `u${Math.random().toString(36).slice(2, 8)}`,
    password: 'password1',
    role: 'user',
    permissions: opts.permissions ?? Permission.REQUEST | Permission.CREATE_ISSUES,
    ...(opts.appAccess ? { appAccess: opts.appAccess } : {}),
  });
  return { cookie: `${SESSION_COOKIE}=${auth.createSession(user.id).token}`, id: user.id };
}

const get = (h: Harness, query: string, headers: Record<string, string>) => h.app.inject({ method: 'GET', url: `/api/v1/search/universal${query}`, headers });

describe('GET /search/universal', () => {
  it('answers 400 on an empty or missing query and 401 without credentials', async () => {
    const h = await harness();
    const key = { 'x-api-key': authServiceFor(h.ctx).apiKey() };
    expect((await get(h, '?q=', key)).statusCode).toBe(400);
    expect((await get(h, '?q=%20%20', key)).statusCode).toBe(400);
    expect((await get(h, '', key)).statusCode).toBe(400);
    expect((await get(h, '?q=dune&limit=0', key)).statusCode).toBe(400);
    expect((await get(h, '?q=dune', {})).statusCode).toBe(401);
  });

  it('gives admins every kind, settings entities included', async () => {
    const h = await harness();
    seedDune(h.db);
    const res = await get(h, '?q=dune', { 'x-api-key': authServiceFor(h.ctx).apiKey() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as UniversalSearchResponse;
    expect(body.query).toBe('dune');
    expect(kindsOf(body)).toEqual(['movie', 'indexer', 'qualityProfile', 'tag', 'queue']);
    expect(body.results.find((r) => r.kind === 'queue')!.hits[0]).toMatchObject({ title: 'Dune.2021.1080p', status: 'downloading' });
  });

  it('shows a portal user only their own requests and issues, no library or settings', async () => {
    const h = await harness();
    seedDune(h.db);
    const me = await signedIn(h);
    const other = await signedIn(h);
    addRequest(h.db, 'Dune Messiah', me.id);
    addRequest(h.db, 'Dune Prophecy', other.id);
    addIssue(h.db, 'Dune: Part Two', me.id);
    addIssue(h.db, 'Dune', other.id);
    const res = await get(h, '?q=dune', { cookie: me.cookie });
    expect(res.statusCode).toBe(200);
    const body = res.json() as UniversalSearchResponse;
    expect(body.results.map((r) => [r.kind, r.total, r.hits.map((x) => x.title)])).toEqual([
      ['request', 1, ['Dune Messiah']],
      ['issue', 1, ['Dune: Part Two']],
    ]);
  });

  it('shows a library app-access user the library but not settings or the queue', async () => {
    const h = await harness();
    seedDune(h.db);
    const lib = await signedIn(h, { appAccess: ['library'] });
    const body = (await get(h, '?q=dune', { cookie: lib.cookie })).json() as UniversalSearchResponse;
    expect(kindsOf(body)).toEqual(['movie']);
    const act = await signedIn(h, { appAccess: ['activity'] });
    expect(kindsOf((await get(h, '?q=dune', { cookie: act.cookie })).json())).toEqual(['queue']);
  });
});

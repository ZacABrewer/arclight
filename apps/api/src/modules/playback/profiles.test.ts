import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MY_LIST_MAX, QUALITIES, type ContentRestrictions, type QualityModel } from '@arclight/shared';
import { buildApp, type AppContext } from '../../app.js';
import type { AppConfig } from '../../config.js';
import type { Db } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { createTestDb, seedAdmin } from '../../db/test-utils.js';
import { authServiceFor, SESSION_COOKIE } from '../auth/index.js';
import { setSection } from '../settings/service.js';
import { artworkLinkQuery, linkKey, linkQuery, verifyArtworkLink, verifyLink } from './links.js';
import { myListHas } from './my-list.js';

// Household profiles in the player: My List, signed links that carry the profile (`p=`), and
// the profile's content limits on top of the account's for browse, items, streams and links.

const config: AppConfig = { configDir: '.', dbPath: ':memory:', logDir: '.', port: 0, host: '127.0.0.1', logLevel: 'silent', isDocker: false, webDist: null };
const NOW = '2026-05-01T12:00:00.000Z';
const KIDS: ContentRestrictions = { maxCertification: { movie: 'PG', tv: 'TV-PG' }, hideAdultContent: true };
const quality = (): QualityModel => ({ quality: { ...QUALITIES['Bluray-1080p'], mediaTypes: [...QUALITIES['Bluray-1080p'].mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } });

let tmp = '';
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'arclight-profiles-'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

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
  setSection(db, 'player', { enabled: true, video: true });
  const h = { app, ctx: ctx!, db };
  open.push(h);
  return h;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const call = (h: Harness, method: Method, url: string, cookie?: string, payload?: unknown, headers: Record<string, string> = {}) =>
  h.app.inject({ method, url, headers: { ...(cookie ? { cookie } : {}), ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });

let n = 0;
/** An account (admin when asked) with an owner session and a Kids session (PG / TV-PG). */
async function household(h: Harness, opts: { role?: 'user' | 'admin' } = {}) {
  const auth = authServiceFor(h.ctx);
  const user = await auth.createUser({ username: `pf${++n}${Math.random().toString(36).slice(2, 6)}`, password: 'password1', role: opts.role ?? 'user', settings: { player: { allowed: true } } });
  const owner = `${SESSION_COOKIE}=${auth.createSession(user.id).token}`;
  const kids = `${SESSION_COOKIE}=${auth.createSession(user.id).token}`;
  const created = await call(h, 'POST', '/api/v1/households/profiles', owner, { name: 'Kids', contentRestrictions: KIDS });
  expect(created.statusCode, created.body).toBe(201);
  const kidId = created.json().id as number;
  expect((await call(h, 'POST', `/api/v1/households/profiles/${kidId}/select`, kids, {})).statusCode).toBe(200);
  return { userId: user.id, owner, kids, kidId };
}

function movie(db: Db, title: string, certification: string) {
  const dir = join(tmp, `m-${Math.random().toString(36).slice(2, 8)}`);
  const row = db
    .insert(schema.movies)
    .values({
      tmdbId: Math.floor(Math.random() * 1e7),
      title,
      originalTitle: title,
      sortTitle: title.toLowerCase(),
      cleanTitle: title.toLowerCase().replace(/\W/g, ''),
      year: 2021,
      status: 'released',
      runtimeMinutes: 100,
      genres: ['Drama'],
      images: [{ coverType: 'poster', url: '/MediaCover/1/poster.jpg', remoteUrl: 'https://image.tmdb.org/t/p/original/poster.jpg' }],
      ratings: {},
      certification,
      originalLanguage: 'en',
      path: dir,
      rootFolderPath: tmp,
      qualityProfileId: 1,
      tags: [],
      added: NOW,
      hasFile: true,
    })
    .returning()
    .get();
  const path = join(tmp, `${row.id}-${Math.random().toString(36).slice(2, 6)}.mkv`);
  writeFileSync(path, Buffer.alloc(64));
  const file = db
    .insert(schema.mediaFiles)
    .values({ mediaType: 'movie', movieId: row.id, relativePath: 'film.mkv', path, sizeBytes: 64, dateAdded: NOW, quality: quality(), languages: ['English'], mediaInfo: null })
    .returning()
    .get();
  return { id: row.id, fileId: file.id };
}

function show(db: Db, title: string, certification: string, withFile = true) {
  const row = db
    .insert(schema.series)
    .values({
      tmdbId: Math.floor(Math.random() * 1e7),
      title,
      sortTitle: title.toLowerCase(),
      cleanTitle: title.toLowerCase().replace(/\W/g, ''),
      year: 2020,
      status: 'continuing',
      genres: ['Comedy'],
      images: [],
      ratings: {},
      certification,
      originalLanguage: 'en',
      path: join(tmp, `s-${Math.random().toString(36).slice(2, 8)}`),
      rootFolderPath: tmp,
      qualityProfileId: 1,
      tags: [],
      added: NOW,
      runtimeMinutes: 25,
    })
    .returning()
    .get();
  let fileId: number | null = null;
  if (withFile) {
    fileId = db
      .insert(schema.mediaFiles)
      .values({ mediaType: 'series', seriesId: row.id, seasonNumber: 1, relativePath: 'S01E01.mkv', path: join(tmp, 'none.mkv'), sizeBytes: 1, dateAdded: NOW, quality: quality(), languages: ['English'], mediaInfo: null })
      .returning()
      .get().id;
  }
  db.insert(schema.episodes).values({ seriesId: row.id, seasonNumber: 1, episodeNumber: 1, title: 'Pilot', airDate: '2020-01-01', hasFile: withFile, episodeFileId: fileId }).run();
  return { id: row.id };
}

// ------------------------------------------------------------------------------------ links

describe('signed links with a profile', () => {
  const key = linkKey('install-api-key');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const parse = (q: string) => Object.fromEntries(new URLSearchParams(q));

  it('owner links keep the old format; profile links carry p and verify with it', () => {
    const owner = linkQuery(key, { userId: 3, fileId: 7, exp }, 'video');
    expect(owner).not.toMatch(/(^|&)p=/);
    expect(verifyLink(key, 7, parse(owner), Date.now(), 'video')).toEqual({ ok: true, userId: 3, profileId: null });
    const kid = linkQuery(key, { userId: 3, profileId: 9, fileId: 7, exp }, 'video');
    expect(kid).toContain('&p=9&');
    expect(verifyLink(key, 7, parse(kid), Date.now(), 'video')).toEqual({ ok: true, userId: 3, profileId: 9 });
  });

  it('removing, changing or garbling p breaks the signature; domains never cross', () => {
    const q = parse(linkQuery(key, { userId: 3, profileId: 9, fileId: 7, exp }, 'video'));
    const { p: _p, ...stripped } = q;
    expect(verifyLink(key, 7, stripped, Date.now(), 'video')).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(verifyLink(key, 7, { ...q, p: '10' }, Date.now(), 'video')).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(verifyLink(key, 7, { ...q, p: 'x' }, Date.now(), 'video')).toEqual({ ok: false, reason: 'MALFORMED' });
    expect(verifyLink(key, 7, q, Date.now(), 'audio')).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(verifyLink(key, 7, q, Date.now(), 'trickplay')).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    // Adding p to an owner link does not make it a profile link either.
    const ownerQ = parse(linkQuery(key, { userId: 3, fileId: 7, exp }, 'video'));
    expect(verifyLink(key, 7, { ...ownerQ, p: '9' }, Date.now(), 'video')).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('artwork links carry p the same way', () => {
    const q = parse(artworkLinkQuery(key, { userId: 3, profileId: 9, exp }));
    expect(verifyArtworkLink(key, q, Date.now())).toEqual({ ok: true, userId: 3, profileId: 9 });
    const { p: _p, ...stripped } = q;
    expect(verifyArtworkLink(key, stripped, Date.now())).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(verifyArtworkLink(key, parse(artworkLinkQuery(key, { userId: 3, exp })), Date.now())).toEqual({ ok: true, userId: 3, profileId: null });
  });

  it('a Kids profile link cannot open an R movie; the owner link can; tampering and a deleted profile end it', async () => {
    const h = await harness();
    const hh = await household(h);
    const r = movie(h.db, 'Grown Up Film', 'R');
    const pg = movie(h.db, 'Family Film', 'PG');
    const key = linkKey(authServiceFor(h.ctx).apiKey());
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const stream = (fileId: number, q: string) => call(h, 'GET', `/api/v1/stream/video/${fileId}?m=direct&${q}`);
    const kidLink = (fileId: number) => linkQuery(key, { userId: hh.userId, profileId: hh.kidId, fileId, exp }, 'video');
    const ownerLink = (fileId: number) => linkQuery(key, { userId: hh.userId, fileId, exp }, 'video');

    expect((await stream(r.fileId, kidLink(r.fileId))).json().code).toBe('NOT_FOUND');
    expect((await stream(pg.fileId, kidLink(pg.fileId))).statusCode).toBe(200);
    expect((await stream(r.fileId, ownerLink(r.fileId))).statusCode).toBe(200);
    // Stripping p from a Kids link to reach the owner's limits fails the MAC.
    const stripped = kidLink(r.fileId).replace(`&p=${hh.kidId}`, '');
    expect((await stream(r.fileId, stripped)).json().code).toBe('LINK_BAD_SIGNATURE');
    // Deleting the profile ends its links.
    expect((await call(h, 'DELETE', `/api/v1/households/profiles/${hh.kidId}`, hh.owner)).statusCode).toBe(204);
    expect((await stream(pg.fileId, kidLink(pg.fileId))).json().code).toBe('LINK_REVOKED');
  });

  it('a Kids session signs its links with its profile and never sees restricted titles', async () => {
    const h = await harness();
    const hh = await household(h);
    const r = movie(h.db, 'Grown Up Film', 'R');
    const pg = movie(h.db, 'Family Film', 'PG');
    const kidMovies = (await call(h, 'GET', '/api/v1/playback/movies', hh.kids)).json();
    expect(kidMovies.items.map((m: { title: string }) => m.title)).toEqual(['Family Film']);
    const ownerMovies = (await call(h, 'GET', '/api/v1/playback/movies', hh.owner)).json();
    expect(ownerMovies.items).toHaveLength(2);
    expect((await call(h, 'GET', `/api/v1/playback/movies/${r.id}`, hh.kids)).statusCode).toBe(404);
    expect((await call(h, 'GET', `/api/v1/playback/item/movie:${r.id}`, hh.kids)).statusCode).toBe(404);
    expect((await call(h, 'GET', `/api/v1/playback/item/movie:${pg.id}`, hh.kids)).statusCode).toBe(200);
    expect((await call(h, 'GET', '/api/v1/playback/search?q=Film', hh.kids)).json().movies.map((m: { title: string }) => m.title)).toEqual(['Family Film']);
    // Artwork links from a Kids session carry its profile.
    const art = (await call(h, 'POST', '/api/v1/playback/artwork-link', hh.kids)).json();
    expect(art.query).toContain(`p=${hh.kidId}`);
    const ownerArt = (await call(h, 'POST', '/api/v1/playback/artwork-link', hh.owner)).json();
    expect(ownerArt.query).not.toMatch(/(^|&)p=/);
  });

  it('account limits still apply under an unrestricted profile', async () => {
    const h = await harness();
    const auth = authServiceFor(h.ctx);
    const user = await auth.createUser({ username: `lim${++n}`, password: 'password1', role: 'user', settings: { player: { allowed: true }, contentRestrictions: { maxCertification: { movie: 'PG-13', tv: null }, hideAdultContent: false } } });
    const cookie = `${SESSION_COOKIE}=${auth.createSession(user.id).token}`;
    const created = await call(h, 'POST', '/api/v1/households/profiles', cookie, { name: 'Free' });
    expect((await call(h, 'POST', `/api/v1/households/profiles/${created.json().id}/select`, cookie, {})).statusCode).toBe(200);
    movie(h.db, 'Grown Up Film', 'R');
    movie(h.db, 'Teen Film', 'PG-13');
    expect((await call(h, 'GET', '/api/v1/playback/movies', cookie)).json().items.map((m: { title: string }) => m.title)).toEqual(['Teen Film']);
  });
});

// ------------------------------------------------------------------------------------ My List

describe('My List', () => {
  it('adds, lists newest first, removes; both are idempotent; per profile', async () => {
    const h = await harness();
    const hh = await household(h);
    const a = movie(h.db, 'First', 'PG');
    const b = movie(h.db, 'Second', 'G');
    const s = show(h.db, 'A Show', 'TV-G');
    for (const k of [`movie:${a.id}`, `series:${s.id}`, `movie:${b.id}`]) {
      expect((await call(h, 'PUT', `/api/v1/playback/my-list/${k}`, hh.kids)).statusCode).toBe(204);
      await new Promise((r) => setTimeout(r, 5));
    }
    expect((await call(h, 'PUT', `/api/v1/playback/my-list/movie:${a.id}`, hh.kids)).statusCode).toBe(204);
    const list = (await call(h, 'GET', '/api/v1/playback/my-list', hh.kids)).json();
    expect(list.items.map((c: { kind: string; title: string }) => `${c.kind}:${c.title}`)).toEqual(['movie:Second', 'series:A Show', 'movie:First']);
    expect(list.items[1]).toMatchObject({ itemKey: null, kind: 'series', id: s.id });
    expect((await call(h, 'GET', '/api/v1/playback/my-list', hh.owner)).json().items).toEqual([]);
    expect(await myListHas(h.db, hh.kidId, [`movie:${a.id}`, `movie:${b.id}`, 'movie:999'])).toEqual(new Set([`movie:${a.id}`, `movie:${b.id}`]));

    expect((await call(h, 'DELETE', `/api/v1/playback/my-list/movie:${a.id}`, hh.kids)).statusCode).toBe(204);
    expect((await call(h, 'DELETE', `/api/v1/playback/my-list/movie:${a.id}`, hh.kids)).statusCode).toBe(204);
    expect((await call(h, 'GET', '/api/v1/playback/my-list', hh.kids)).json().items).toHaveLength(2);
  });

  it('refuses bad keys, missing and restricted titles, and stops at the maximum', async () => {
    const h = await harness();
    const hh = await household(h);
    const r = movie(h.db, 'Grown Up', 'R');
    const empty = show(h.db, 'No Files', 'TV-G', false);
    expect((await call(h, 'PUT', '/api/v1/playback/my-list/track:1', hh.kids)).statusCode).toBe(400);
    expect((await call(h, 'PUT', '/api/v1/playback/my-list/movie:0', hh.kids)).statusCode).toBe(400);
    expect((await call(h, 'PUT', '/api/v1/playback/my-list/movie:424242', hh.kids)).statusCode).toBe(404);
    expect((await call(h, 'PUT', `/api/v1/playback/my-list/movie:${r.id}`, hh.kids)).statusCode).toBe(404);
    expect((await call(h, 'PUT', `/api/v1/playback/my-list/series:${empty.id}`, hh.kids)).statusCode).toBe(404);
    // A title saved by the owner that the profile may not see stays out of the profile's list.
    expect((await call(h, 'PUT', `/api/v1/playback/my-list/movie:${r.id}`, hh.owner)).statusCode).toBe(204);
    h.db.insert(schema.profileMyList).values({ profileId: hh.kidId, itemKey: `movie:${r.id}`, addedAt: NOW }).run();
    expect((await call(h, 'GET', '/api/v1/playback/my-list', hh.kids)).json().items).toEqual([]);
    expect((await call(h, 'GET', '/api/v1/playback/my-list', hh.owner)).json().items).toHaveLength(1);

    const pg = movie(h.db, 'Family', 'PG');
    h.db.delete(schema.profileMyList).run();
    h.db.insert(schema.profileMyList).values(Array.from({ length: MY_LIST_MAX }, (_, i) => ({ profileId: hh.kidId, itemKey: `movie:${100000 + i}`, addedAt: NOW }))).run();
    const full = await call(h, 'PUT', `/api/v1/playback/my-list/movie:${pg.id}`, hh.kids);
    expect(full.statusCode).toBe(409);
    expect(full.json().error).toBe('limit-reached');
  });

  it('needs a user and the player', async () => {
    const h = await harness();
    const key = authServiceFor(h.ctx).apiKey();
    expect((await call(h, 'GET', '/api/v1/playback/my-list', undefined, undefined, { 'x-api-key': key })).json().code).toBe('NO_USER');
    const hh = await household(h);
    setSection(h.db, 'player', { enabled: false });
    expect((await call(h, 'GET', '/api/v1/playback/my-list', hh.kids)).statusCode).toBe(403);
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Each test imports a small Sonarr + Radarr library first; slow under load.
vi.setConfig({ testTimeout: 60_000 });
import { Permission, type MigrateArea, type MigrateSourceInput, type MigrationResult } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import * as t from '../../db/schema.js';
import { createTestDb } from '../../db/test-utils.js';
import { getSection } from '../settings/service.js';
import { IMPORTED_PASSWORD_HASH, mapSeerrPermissions } from './areas-requests.js';
import { bazarrLanguage, parsePyLiteral, parseSubtitleList } from './bazarr-reader.js';
import type { FetchLike } from './http.js';
import { migrateImported, migrateRuns, migrateStaging } from './schema.js';
import { MigrateService } from './service.js';
import { makeBazarrDb, makeRadarrDb, makeSeerrDb, makeSonarrDb } from './test-fixtures.js';

let tmp: string;
let db: Db;
let service: MigrateService;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'mt-migrate-bs-'));
  db = await createTestDb({ migrateImported, migrateStaging, migrateRuns });
  service = new MigrateService({ db, now: () => new Date('2024-06-01T00:00:00Z') });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function area(result: MigrationResult, name: MigrateArea) {
  const r = result.areas.find((a) => a.area === name);
  if (!r) throw new Error(`no result for ${name}`);
  return r;
}

const mappings = () => [
  { from: '/tv', to: join(tmp, 'tv') },
  { from: '/movies', to: join(tmp, 'movies') },
];

/** Sonarr + Radarr imported first, the way the stack runs them. */
async function library(): Promise<void> {
  const sonarr = join(tmp, 'sonarr', 'sonarr.db');
  makeSonarrDb(sonarr);
  const radarr = join(tmp, 'radarr', 'radarr.db');
  makeRadarrDb(radarr);
  mkdirSync(join(tmp, 'tv'), { recursive: true });
  await service.apply({ app: 'sonarr', dbPath: sonarr, pathMappings: mappings() });
  await service.apply({ app: 'radarr', dbPath: radarr, pathMappings: mappings() });
}

function bazarrSource(): MigrateSourceInput {
  const dbPath = join(tmp, 'bazarr', 'db', 'bazarr.db');
  mkdirSync(join(tmp, 'bazarr', 'config'), { recursive: true });
  makeBazarrDb(dbPath, join(tmp, 'bazarr', 'config', 'config.yaml'));
  return { app: 'bazarr', dbPath, pathMappings: mappings() };
}

function touch(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '1\n00:00:01,000 --> 00:00:02,000\nhi\n');
}

describe('Bazarr parsing', () => {
  it('reads Python-literal and JSON subtitle lists', () => {
    expect(parsePyLiteral("[['en', \"/a/Grey's.srt\", 12], ['fr:forced', None, None]]")).toEqual([
      ['en', "/a/Grey's.srt", 12],
      ['fr:forced', null, null],
    ]);
    expect(parseSubtitleList('[["en:hi","/b.srt",3]]')).toEqual([{ code: 'en:hi', path: '/b.srt', size: 3 }]);
    expect(parseSubtitleList([{ code2: 'de', forced: true, path: '/c.srt', file_size: 9 }])).toEqual([{ code: 'de:forced', path: '/c.srt', size: 9 }]);
  });

  it('maps Bazarr language codes to Arclight tags and flags', () => {
    expect(bazarrLanguage('pb')).toEqual({ code: 'pt-BR', forced: false, hi: false });
    expect(bazarrLanguage('en:hi')).toEqual({ code: 'en', forced: false, hi: true });
    expect(bazarrLanguage('zt:forced')).toEqual({ code: 'zh-Hant', forced: true, hi: false });
  });
});

describe('Bazarr apply', () => {
  it('imports profiles, assignments, providers, subtitle files and history into the subtitles module', async () => {
    await library();
    const episodeVideo = join(tmp, 'tv', 'Breaking Bad', 'Season 01', 'Breaking.Bad.S01E01E02.1080p.WEB-DL.mkv');
    touch(join(tmp, 'tv', 'Breaking Bad', 'Season 01', 'Breaking.Bad.S01E01E02.1080p.WEB-DL.en.srt'));
    touch(join(tmp, 'movies', 'The Matrix (1999)', 'The.Matrix.1999.Remux.en.hi.srt'));
    const src = bazarrSource();

    const plan = await service.plan(src);
    const by = Object.fromEntries(plan.areas.map((a) => [a.area, a]));
    expect(by['subtitleProfiles']).toMatchObject({ mode: 'import', create: 1 });
    expect(by['subtitleProviders']).toMatchObject({ total: 4, unsupported: 1 });
    expect(by['subtitleFiles']).toMatchObject({ total: 3, details: { embeddedSkipped: 1 } });
    expect(plan.unsupported.map((u) => u.name)).toContain('legendasdivx');

    const result = await service.apply(src);
    expect(area(result, 'subtitleProfiles').created).toBe(1);
    const [profile] = db.select().from(t.languageProfiles).all();
    expect(profile).toMatchObject({
      name: 'English + French',
      languages: [
        { code: 'en', hi: 'also', forced: 'never' },
        { code: 'fr', hi: 'never', forced: 'only' },
        { code: 'pt-BR', hi: 'only', forced: 'never' },
      ],
      cutoff: 'fr',
      mustContain: ['WEB'],
    });

    // Assignments: series by path, movie by its video file's folder; the show not in the library is skipped.
    expect(area(result, 'subtitleAssignments')).toMatchObject({ created: 2, skipped: 1 });
    expect(db.select().from(t.series).where(eq(t.series.tmdbId, 1396)).get()?.languageProfileId).toBe(profile!.id);
    expect(db.select().from(t.movies).where(eq(t.movies.tmdbId, 603)).get()?.languageProfileId).toBe(profile!.id);

    // Providers with credentials; unsupported ones skipped; default series profile set.
    const subs = getSection(db, 'subtitles');
    expect(subs.providers.find((p) => p.id === 'opensubtitlescom')).toMatchObject({ enabled: true, settings: { username: 'osuser', password: 'os pass', useHash: true } });
    expect(subs.providers.find((p) => p.id === 'addic7ed')).toMatchObject({ enabled: true, settings: { username: 'adduser', password: 'addpass' } });
    expect(subs.defaultSeriesProfileId).toBe(profile!.id);
    expect(result.warnings.some((w) => /consumer API key/.test(w.message))).toBe(true);

    // Subtitle files on disk attach to the media files; missing and embedded ones do not.
    expect(area(result, 'subtitleFiles')).toMatchObject({ created: 2, skipped: 1 });
    const files = db.select().from(t.subtitleFiles).all();
    const epFile = db.select().from(t.mediaFiles).where(eq(t.mediaFiles.path, episodeVideo)).get()!;
    expect(files.find((f) => f.mediaFileId === epFile.id)).toMatchObject({ language: 'en', forced: false, hi: false, embedded: false });
    expect(files.find((f) => f.hi)).toMatchObject({ language: 'en' });

    // History by video path, by Sonarr episode id (fallback), and by Radarr id; blacklist kept.
    expect(area(result, 'subtitleHistory')).toMatchObject({ created: 4 });
    const history = db.select().from(t.subtitleHistory).all();
    expect(history.find((h) => h.providerSubtitleId === 's2')).toMatchObject({ action: 'upgraded', hi: true, mediaFileId: epFile.id, score: 300, scoreOutOf: 360 });
    expect(history.find((h) => h.providerSubtitleId === 's1')).toMatchObject({ mediaFileId: epFile.id, title: 'Breaking Bad', date: '2021-01-01T10:00:00.000Z' });
    expect(history.find((h) => h.provider === 'addic7ed' && h.mediaType === 'movie')).toMatchObject({ title: 'The Matrix' });
    expect(db.select().from(t.subtitleBlacklist).all()).toEqual([expect.objectContaining({ provider: 'podnapisi', providerSubtitleId: 'bad1', title: 'Breaking Bad' })]);

    // Re-running changes nothing.
    const count = () => [t.languageProfiles, t.subtitleFiles, t.subtitleHistory, t.subtitleBlacklist].map((tb) => db.select().from(tb).all().length);
    const before = count();
    const again = await service.apply(src);
    expect(count()).toEqual(before);
    expect(again.areas.reduce((n, a) => n + a.created + a.failed, 0)).toBe(0);
  });

  it('writes nothing on a dry run', async () => {
    await library();
    const result = await service.apply(bazarrSource(), { dryRun: true });
    expect(area(result, 'subtitleProfiles').created).toBe(1);
    expect(db.select().from(t.languageProfiles).all()).toHaveLength(0);
    expect(db.select().from(t.subtitleHistory).all()).toHaveLength(0);
  });
});

describe('Seerr apply', () => {
  function seerrSource(): MigrateSourceInput {
    const dbPath = join(tmp, 'seerr', 'db', 'db.sqlite3');
    makeSeerrDb(dbPath, join(tmp, 'seerr', 'settings.json'));
    return { app: 'seerr', dbPath, pathMappings: [{ from: '/movies', to: '/data/media/movies' }] };
  }

  it('links users by media-server identity, creates the others without a password and imports requests and issues', async () => {
    await library();
    // An Arclight user who already signed in with the same Plex account as Seerr's owner.
    const owner = db
      .insert(t.users)
      .values({
        username: 'admin',
        usernameKey: 'admin',
        passwordHash: 'x',
        role: 'admin',
        permissions: Permission.ADMIN,
        settings: { mediaServerLink: { kind: 'plex', externalId: '42', username: 'owner', linkedAt: '2024-01-01T00:00:00Z' } },
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      })
      .returning()
      .get();
    const src = seerrSource();
    const plan = await service.plan(src);
    expect(plan.areas.map((a) => [a.area, a.mode, a.create, a.conflicts])).toEqual([
      ['users', 'import', 1, 1],
      ['requestSettings', 'import', 3, 0],
      ['requests', 'import', 2, 0],
      ['issues', 'import', 1, 0],
    ]);

    const result = await service.apply(src);
    expect(area(result, 'users')).toMatchObject({ created: 1, skipped: 1 });
    const friend = db.select().from(t.users).where(eq(t.users.usernameKey, 'friend')).get()!;
    expect(friend).toMatchObject({ role: 'user', email: 'friend@example.com', passwordHash: IMPORTED_PASSWORD_HASH, permissions: Permission.REQUEST });
    expect(friend.settings).toMatchObject({ quota: { movieLimit: 5, movieDays: 7 }, locale: 'en' });
    // The existing admin is untouched.
    expect(db.select().from(t.users).where(eq(t.users.id, owner.id)).get()).toMatchObject({ role: 'admin', permissions: Permission.ADMIN });

    expect(area(result, 'requests').created).toBe(2);
    const requests = db.select().from(t.mediaRequests).all();
    const movie = requests.find((r) => r.type === 'movie')!;
    expect(movie).toMatchObject({ tmdbId: 603, title: 'The Matrix', status: 'approved', requestedById: friend.id, modifiedById: owner.id, rootFolderPath: '/data/media/movies', createdAt: '2023-01-01T00:00:00.000Z' });
    expect(movie.libraryId).not.toBeNull();
    const tv = requests.find((r) => r.type === 'series')!;
    expect(tv).toMatchObject({ tmdbId: 1396, tvdbId: 81189, title: 'Breaking Bad', status: 'pending', is4k: true });
    expect(db.select().from(t.seasonRequests).where(eq(t.seasonRequests.requestId, tv.id)).all().map((s) => [s.seasonNumber, s.status])).toEqual([
      [1, 'pending'],
      [2, 'approved'],
    ]);

    const [issue] = db.select().from(t.issues).all();
    expect(issue).toMatchObject({ type: 'subtitles', status: 'open', mediaType: 'series', tmdbId: 1396, problemSeason: 1, problemEpisode: 2, createdById: friend.id, title: 'Breaking Bad' });
    expect(db.select().from(t.issueComments).all()).toEqual([expect.objectContaining({ issueId: issue!.id, userId: friend.id, message: 'Subs out of sync' })]);

    const settings = getSection(db, 'requests');
    expect(settings.defaultPermissions).toBe(Permission.REQUEST);
    expect(settings.defaultQuotas).toMatchObject({ movieLimit: 3, movieDays: 7, tvLimit: null });
    expect(db.select().from(t.overrideRules).all()).toEqual([expect.objectContaining({ mediaType: 'series', genres: [16], rootFolderPath: '/anime' })]);
    expect(db.select().from(t.discoverSliders).all().some((s) => s.type === 'recentlyAdded' && s.isBuiltIn)).toBe(true);

    // Secrets never reach Arclight.
    const everything = JSON.stringify([db.select().from(t.users).all(), db.select().from(t.settings).all()]);
    for (const secret of ['PLEX-SECRET', 'PB-SECRET', '$2b$12$hash', 'SEERR-API-KEY', 'CLIENT-SECRET']) expect(everything).not.toContain(secret);

    // Idempotent.
    const counts = () => [t.users, t.mediaRequests, t.seasonRequests, t.issues, t.issueComments, t.overrideRules, t.discoverSliders].map((tb) => db.select().from(tb).all().length);
    const before = counts();
    await service.apply(src);
    expect(counts()).toEqual(before);
  });

  it('never creates an Arclight admin from a Seerr admin', async () => {
    const src = seerrSource();
    await service.apply(src);
    const owner = db.select().from(t.users).all().find((u) => u.email === 'owner@example.com')!;
    expect(owner.role).toBe('user');
    expect(owner.permissions & Permission.ADMIN).toBe(0);
    expect(owner.permissions).toBe(mapSeerrPermissions(Permission.ADMIN));
    expect(owner.permissions & Permission.MANAGE_REQUESTS).toBeTruthy();
    expect(owner.settings).toMatchObject({ mediaServerLink: { kind: 'plex', externalId: '42', username: 'owner' } });
    // Requests whose title is not in the library get a placeholder title.
    expect(db.select().from(t.mediaRequests).all().map((r) => r.title).sort()).toEqual(['TMDB 1396', 'TMDB 603']);
  });
});

// ---- API mode --------------------------------------------------------------------------------------

function fakeFetch(routes: Record<string, unknown>, seen: string[] = []): FetchLike {
  return async (input, init) => {
    const url = new URL(input);
    seen.push(`${url.pathname}${url.search}`);
    const headers = new Headers(init?.headers);
    if (!headers.get('x-api-key')) return new Response('no key', { status: 401 });
    const body = routes[url.pathname];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(typeof body === 'function' ? (body as (u: URL) => unknown)(url) : body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

describe('Bazarr API mode', () => {
  it('reads profiles, settings, assignments, subtitles and history through the API', async () => {
    await library();
    touch(join(tmp, 'movies', 'The Matrix (1999)', 'The.Matrix.1999.Remux.en.srt'));
    const seen: string[] = [];
    const fetch = fakeFetch(
      {
        '/api/system/status': { data: { bazarr_version: '1.4.3' } },
        '/api/system/languages/profiles': [{ profileId: 3, name: 'English', cutoff: 65535, items: [{ id: 1, language: 'en', hi: 'also', forced: 'False', audio_exclude: 'False' }], mustContain: [], mustNotContain: [], originalFormat: false, tag: null }],
        '/api/system/settings': { general: { enabled_providers: ['subdl', 'opensubtitlescom'] }, subdl: { api_key: 'SUBDL-KEY' }, opensubtitlescom: { username: 'u', password: '********' } },
        '/api/series': { data: [{ sonarrSeriesId: 1, title: 'Breaking Bad', tvdbId: 81189, profileId: 3 }], total: 1 },
        '/api/episodes': { data: [{ sonarrSeriesId: 1, sonarrEpisodeId: 1, path: '/tv/Breaking Bad/Season 01/Breaking.Bad.S01E01E02.1080p.WEB-DL.mkv', subtitles: [{ code2: 'en', forced: false, hi: false, path: null }] }] },
        '/api/movies': { data: [{ radarrId: 1, title: 'The Matrix', tmdbId: 603, profileId: 3, path: '/movies/The Matrix (1999)/The.Matrix.1999.Remux.mkv', subtitles: [{ code2: 'en', forced: false, hi: false, path: '/movies/The Matrix (1999)/The.Matrix.1999.Remux.en.srt', file_size: 50 }] }], total: 1 },
        '/api/episodes/history': { data: [{ action: 1, description: 'downloaded', language: { code2: 'en', forced: false, hi: false }, provider: 'subdl', score: '95.0%', subs_id: 'a1', sonarrSeriesId: 1, sonarrEpisodeId: 1, raw_timestamp: 1700000000, video_path: '/tv/Breaking Bad/Season 01/Breaking.Bad.S01E01E02.1080p.WEB-DL.mkv' }] },
        '/api/movies/history': { data: [{ action: 1, description: 'old', language: 'en', provider: 'subdl', radarrId: 1, timestamp: '3 days ago' }] },
        '/api/episodes/blacklist': { data: [] },
        '/api/movies/blacklist': { data: [{ provider: 'subdl', subs_id: 'zz', language: { code2: 'en' }, radarrId: 1, parsed_timestamp: '2023-03-01T10:00:00Z' }] },
      },
      seen,
    );
    service = new MigrateService({ db, now: () => new Date('2024-06-01T00:00:00Z'), deps: { fetch } });
    const result = await service.apply({ app: 'bazarr', mode: 'api', url: 'http://bazarr:6767', apiKey: 'k', pathMappings: mappings() });
    expect(area(result, 'subtitleProfiles').created).toBe(1);
    expect(db.select().from(t.languageProfiles).get()).toMatchObject({ name: 'English', cutoff: '*' });
    expect(area(result, 'subtitleAssignments').created).toBe(2);
    expect(area(result, 'subtitleFiles')).toMatchObject({ created: 1 });
    const subs = getSection(db, 'subtitles');
    expect(subs.providers.find((p) => p.id === 'subdl')).toMatchObject({ settings: { apiKey: 'SUBDL-KEY' } });
    expect(subs.providers.find((p) => p.id === 'opensubtitlescom')?.settings).toEqual({ username: 'u' });
    expect(result.warnings.some((w) => /hidden by Bazarr/.test(w.message))).toBe(true);
    expect(result.warnings.some((w) => /no absolute date/.test(w.message))).toBe(true);
    const history = db.select().from(t.subtitleHistory).all();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ score: 342, scoreOutOf: 360, date: '2023-11-14T22:13:20.000Z' });
    expect(db.select().from(t.subtitleBlacklist).all()).toHaveLength(1);
    expect(seen.some((s) => s.startsWith('/api/episodes?seriesid%5B%5D=1'))).toBe(true);
  });
});

describe('Seerr API mode', () => {
  it('reads users, requests, issues with comments and settings through the API', async () => {
    const fetch = fakeFetch({
      '/api/v1/status': { version: '2.1.0' },
      '/api/v1/user': { pageInfo: { pages: 1, results: 1 }, results: [{ id: 5, email: 'jf@example.com', jellyfinUsername: 'jfuser', jellyfinUserId: 'abc123', userType: 3, permissions: Permission.REQUEST | Permission.AUTO_APPROVE, createdAt: '2023-02-02T00:00:00.000Z', settings: { locale: 'de' } }] },
      '/api/v1/request': { pageInfo: { pages: 1, results: 1 }, results: [{ id: 9, status: 3, type: 'movie', is4k: false, media: { tmdbId: 550, mediaType: 'movie' }, requestedBy: { id: 5 }, modifiedBy: null, seasons: [], createdAt: '2023-04-04T00:00:00.000Z', updatedAt: '2023-04-05T00:00:00.000Z' }] },
      '/api/v1/issue': { pageInfo: { pages: 1, results: 1 }, results: [{ id: 2, issueType: 1, status: 2, media: { tmdbId: 550, mediaType: 'movie' }, createdBy: { id: 5 }, createdAt: '2023-05-05T00:00:00.000Z' }] },
      '/api/v1/issue/2': { id: 2, comments: [{ user: { id: 5 }, message: 'Fixed?', createdAt: '2023-05-06T00:00:00.000Z' }] },
      '/api/v1/settings/main': { apiKey: 'NOPE', defaultPermissions: 32, partialRequestsEnabled: false, defaultQuotas: { movie: { quotaLimit: 0 }, tv: {} } },
      '/api/v1/settings/discover': [{ id: 1, type: 4, order: 2, isBuiltIn: true, enabled: false }],
    });
    service = new MigrateService({ db, now: () => new Date('2024-06-01T00:00:00Z'), deps: { fetch } });
    const result = await service.apply({ app: 'seerr', mode: 'api', url: 'http://jellyseerr:5055', apiKey: 'k' });
    expect(area(result, 'users').created).toBe(1);
    const user = db.select().from(t.users).get()!;
    expect(user).toMatchObject({ username: 'jfuser', email: 'jf@example.com', permissions: Permission.REQUEST | Permission.AUTO_APPROVE });
    expect(user.settings).toMatchObject({ mediaServerLink: { kind: 'jellyfin', externalId: 'abc123', username: 'jfuser' }, locale: 'de' });
    expect(db.select().from(t.mediaRequests).get()).toMatchObject({ tmdbId: 550, status: 'declined', requestedById: user.id, title: 'TMDB 550' });
    expect(db.select().from(t.issues).get()).toMatchObject({ status: 'resolved', type: 'video' });
    expect(db.select().from(t.issueComments).all()).toHaveLength(1);
    expect(getSection(db, 'requests')).toMatchObject({ defaultPermissions: 32, partialRequestsEnabled: false });
    expect(JSON.stringify(db.select().from(t.settings).all())).not.toContain('NOPE');
  });

  it('reports a wrong key as an auth error', async () => {
    const fetch: FetchLike = async () => new Response('no', { status: 401 });
    service = new MigrateService({ db, deps: { fetch } });
    await expect(service.plan({ app: 'seerr', mode: 'api', url: 'http://jellyseerr:5055', apiKey: 'bad' })).rejects.toMatchObject({ code: 'AUTH' });
  });
});

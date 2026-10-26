import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildItems, findItem, itemId } from '@arclight/profiles-engine';
import { QUALITIES, type Job, type QualityName } from '@arclight/shared';
import { buildApp, type AppContext } from './app.js';
import type { AppConfig } from './config.js';
import type { Db } from './db/index.js';
import { movies, series } from './db/schema.js';
import { createTestDb } from './db/test-utils.js';
import { EventBus } from './events.js';
import { authServiceFor } from './modules/auth/index.js';
import { historyServiceFor, type HistoryTarget } from './modules/history/index.js';
import { getImportsService } from './modules/imports/index.js';
import { libraryRoutes } from './modules/library/routes.js';
import type { MetadataLookup, SeriesMetadataInput } from './modules/library/index.js';
import { activeMetadataService } from './modules/metadata/index.js';
import { insertEpisode, insertFile, insertMovie, insertSeries, insertTag } from './modules/notifications/test-support.js';
import { ProfilesService } from './modules/profiles/index.js';
import { releasesServiceFor, type SearchTarget } from './modules/releases/index.js';
import { Scheduler } from './scheduler.js';

// Full-app tests for the api gaps closed in this pass: cutoff unmet, per-item refresh, history
// redownload and the failed-download path, blocklist add/clear/bulk, calendar filters and token
// rotation, and the bulk editor's tags/refresh/search. The edges are faked: release search
// (records targets), TMDB lookups, and disk rescans.

const HD: QualityName[] = ['HDTV-720p', 'WEBDL-720p', 'HDTV-1080p', 'WEBDL-1080p', 'Bluray-1080p'];

const config: AppConfig = {
  configDir: '.',
  dbPath: ':memory:',
  logDir: '.',
  port: 0,
  host: '127.0.0.1',
  logLevel: 'silent',
  isDocker: false,
  webDist: null,
};

const seriesMeta = (tmdbId: number, title = 'Fresh Title'): SeriesMetadataInput => ({
  tmdbId,
  title,
  year: 2020,
  status: 'continuing',
  runtimeMinutes: 45,
  originalLanguage: 'en',
  seasons: [{ seasonNumber: 1 }],
  episodes: [1, 2].map((n) => ({
    seasonNumber: 1,
    episodeNumber: n,
    title: `Episode ${n}`,
    airDate: `2020-01-0${n}`,
    airDateUtc: `2020-01-0${n}T20:00:00Z`,
  })),
});

const metadata: MetadataLookup = { series: async (tmdbId) => seriesMeta(tmdbId, 'Added Show'), movie: async () => null };

function quality(name: QualityName) {
  return { quality: { ...QUALITIES[name], mediaTypes: [...QUALITIES[name].mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } };
}

interface Harness {
  db: Db;
  ctx: AppContext;
  searches: SearchTarget[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test responses are read loosely
  api: (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => Promise<{ statusCode: number; json<T = any>(): T }>;
  profiles: ProfilesService;
  /** A profile allowing HD qualities with cutoff WEBDL-1080p. */
  profileId: number;
  close: () => Promise<void>;
}

let h: Harness;

async function harness(): Promise<Harness> {
  const db = await createTestDb();
  const searches: SearchTarget[] = [];
  let ctxRef: AppContext | undefined;
  const app = await buildApp(config, db, pino({ level: 'silent' }), {
    metadata,
    probe: false,
    onContext: (ctx) => {
      ctxRef = ctx;
      const releases = releasesServiceFor(ctx);
      releases.searchFor = async (target) => {
        searches.push(target);
        return { releases: 0, approved: 0, grabbed: [], pending: 0 };
      };
    },
  });
  await app.ready();
  const ctx = ctxRef!;
  const key = authServiceFor(ctx).apiKey();
  const profiles = new ProfilesService({ db });
  const items = buildItems(HD);
  const profile = profiles.createQualityProfile({
    name: 'Gaps HD',
    upgradeAllowed: true,
    cutoff: itemId(findItem({ items } as never, QUALITIES['WEBDL-1080p'].id)!),
    items,
    minFormatScore: 0,
    cutoffFormatScore: 0,
    minUpgradeFormatScore: 1,
    formatItems: [],
    languages: [],
  });
  return {
    db,
    ctx,
    searches,
    profiles,
    profileId: profile.id,
    api: (method, url, payload) =>
      app.inject({ method, url: `/api/v1${url}`, headers: { 'x-api-key': key }, ...(payload === undefined ? {} : { payload: payload as object }) }),
    close: () => app.close(),
  };
}

beforeEach(async () => {
  h = await harness();
});

afterEach(async () => {
  await h.close();
});

/** Lets detached work (bus handlers, `void` promises) settle. */
const settle = () => new Promise((r) => setTimeout(r, 20));

/** Waits for the latest job of a name to leave `running`. */
async function finished(name: string): Promise<Job> {
  for (let i = 0; i < 100; i++) {
    const jobs = (await h.api('GET', '/jobs')).json<Job[]>();
    const job = jobs.find((j) => j.name === name);
    if (job && job.status !== 'running') return job;
    await settle();
  }
  throw new Error(`job ${name} did not finish`);
}

function showWithFile(fileQuality: QualityName, overrides: { releaseGroup?: string; episodeMonitored?: boolean; seriesProfile?: number } = {}) {
  const s = insertSeries(h.db, { qualityProfileId: overrides.seriesProfile ?? h.profileId, title: `Show ${fileQuality}` });
  const file = insertFile(h.db, { mediaType: 'series', seriesId: s.id, seasonNumber: 1, quality: quality(fileQuality), releaseGroup: overrides.releaseGroup ?? 'GRP' });
  const ep = insertEpisode(h.db, s.id, { hasFile: true, episodeFileId: file.id, monitored: overrides.episodeMonitored ?? true, airDateUtc: '2025-01-01T00:00:00Z' });
  return { series: s, file, episode: ep };
}

function movieWithFile(fileQuality: QualityName, title: string) {
  const m = insertMovie(h.db, { qualityProfileId: h.profileId, title, sortTitle: title.toLowerCase(), hasFile: true });
  const file = insertFile(h.db, { mediaType: 'movie', movieId: m.id, quality: quality(fileQuality), relativePath: `${title}.mkv` });
  h.db.update(movies).set({ movieFileId: file.id }).where(eq(movies.id, m.id)).run();
  return { movie: m, file };
}

// ---------------------------------------------------------------------------------------

describe('GET /wanted/cutoff/*', () => {
  it('lists episodes whose file is below the profile quality cutoff and skips those at cutoff', async () => {
    const low = showWithFile('HDTV-720p');
    showWithFile('WEBDL-1080p');
    const res = await h.api('GET', '/wanted/cutoff/episodes');
    expect(res.statusCode).toBe(200);
    const page = res.json<{ totalRecords: number; records: Array<{ id: number; seriesTitle: string; qualityProfileId: number }> }>();
    expect(page.totalRecords).toBe(1);
    expect(page.records[0]).toMatchObject({ id: low.episode.id, seriesTitle: 'Show HDTV-720p', qualityProfileId: h.profileId });
  });

  it('uses the custom-format score: a file at the quality cutoff is unmet until its formats reach the format cutoff', async () => {
    const cf = h.profiles.createCustomFormat({
      name: 'Gold group',
      includeWhenRenaming: false,
      specifications: [{ implementation: 'releaseGroup', name: 'gold', negate: false, required: false, fields: { pattern: '^GOLD$' } }],
    });
    const p = h.profiles.getQualityProfile(h.profileId);
    h.profiles.updateQualityProfile(h.profileId, { ...p, cutoffFormatScore: 100, formatItems: [{ formatId: cf.id, score: 100 }] });
    const plain = showWithFile('WEBDL-1080p', { releaseGroup: 'GRP' });
    showWithFile('WEBDL-1080p', { releaseGroup: 'GOLD' });
    const page = (await h.api('GET', '/wanted/cutoff/episodes')).json<{ records: Array<{ id: number }> }>();
    expect(page.records.map((r) => r.id)).toEqual([plain.episode.id]);
  });

  it('ignores unmonitored episodes and items whose profile no longer exists', async () => {
    showWithFile('HDTV-720p', { episodeMonitored: false });
    showWithFile('HDTV-720p', { seriesProfile: 9999 });
    const page = (await h.api('GET', '/wanted/cutoff/episodes')).json<{ totalRecords: number }>();
    expect(page.totalRecords).toBe(0);
  });

  it('pages cutoff-unmet movies like the missing route', async () => {
    movieWithFile('HDTV-720p', 'Alpha');
    movieWithFile('WEBDL-720p', 'Bravo');
    movieWithFile('Bluray-1080p', 'Charlie');
    const first = (await h.api('GET', '/wanted/cutoff/movies?page=1&pageSize=1')).json<{ page: number; pageSize: number; totalRecords: number; records: Array<{ title: string }> }>();
    expect(first).toMatchObject({ page: 1, pageSize: 1, totalRecords: 2 });
    expect(first.records.map((m) => m.title)).toEqual(['Alpha']);
    const second = (await h.api('GET', '/wanted/cutoff/movies?page=2&pageSize=1')).json<{ records: Array<{ title: string }> }>();
    expect(second.records.map((m) => m.title)).toEqual(['Bravo']);
  });

  it('the CutoffUnmetSearch job searches exactly what the cutoff route lists', async () => {
    const low = showWithFile('HDTV-720p');
    showWithFile('Bluray-1080p');
    const { movie } = movieWithFile('HDTV-720p', 'Delta');
    const listedEpisodes = (await h.api('GET', '/wanted/cutoff/episodes')).json<{ records: Array<{ id: number }> }>().records.map((r) => r.id);
    const listedMovies = (await h.api('GET', '/wanted/cutoff/movies')).json<{ records: Array<{ id: number }> }>().records.map((r) => r.id);
    const job = await h.ctx.scheduler.run('CutoffUnmetSearch', 'manual');
    expect(job.status).toBe('completed');
    expect(h.searches).toEqual([{ seriesId: low.series.id, episodeIds: listedEpisodes }, { movieId: movie.id }]);
    expect(listedMovies).toEqual([movie.id]);
  });
});

// ---------------------------------------------------------------------------------------

describe('POST /command/refresh', () => {
  function fakeTmdb(lookup: (tmdbId: number) => Promise<SeriesMetadataInput | null> = async (id) => seriesMeta(id)) {
    const service = activeMetadataService()!;
    service.isConfigured = () => true;
    service.lookupSeries = lookup;
    service.lookupMovie = async (tmdbId) => ({ tmdbId, title: 'Refreshed Movie', year: 2001, status: 'released', originalLanguage: 'en' }) as never;
    return service;
  }

  it('validates the body: exactly one of seriesId, movieId or all', async () => {
    expect((await h.api('POST', '/command/refresh', {})).statusCode).toBe(400);
    expect((await h.api('POST', '/command/refresh', { seriesId: 1, movieId: 2 })).statusCode).toBe(400);
    expect((await h.api('POST', '/command/refresh', { all: false })).statusCode).toBe(400);
  });

  it('answers 404 for an unknown item without starting a job', async () => {
    const res = await h.api('POST', '/command/refresh', { seriesId: 424242 });
    expect(res.statusCode).toBe(404);
    expect((await h.api('GET', '/jobs')).json<Job[]>().some((j) => j.name === 'RefreshSeriesItem')).toBe(false);
  });

  it('refreshes one series as a RefreshSeriesItem job: 202 running, then completed with new metadata', async () => {
    fakeTmdb();
    const s = insertSeries(h.db, { title: 'Stale Title', qualityProfileId: h.profileId });
    const res = await h.api('POST', '/command/refresh', { seriesId: s.id });
    expect(res.statusCode).toBe(202);
    expect(res.json<Job>()).toMatchObject({ name: 'RefreshSeriesItem', status: 'running', trigger: 'manual' });
    const job = await finished('RefreshSeriesItem');
    expect(job).toMatchObject({ status: 'completed', message: 'refreshed 1 of 1 series' });
    const after = (await h.api('GET', `/series/${s.id}`)).json<{ title: string; seasons: unknown[] }>();
    expect(after.title).toBe('Fresh Title');
    expect((await h.api('GET', `/episode?seriesId=${s.id}`)).json<unknown[]>()).toHaveLength(2);
  });

  it('rescan: true also rescans the movie folder through the imports module', async () => {
    fakeTmdb();
    const rescanned: number[] = [];
    getImportsService(h.ctx).rescanMovie = async (id) => {
      rescanned.push(id);
      return { scanned: 3, added: [], removed: [], unmapped: [] };
    };
    const m = insertMovie(h.db, { title: 'Old', qualityProfileId: h.profileId });
    const res = await h.api('POST', '/command/refresh', { movieId: m.id, rescan: true });
    expect(res.json<Job>().name).toBe('RefreshMovieItem');
    const job = await finished('RefreshMovieItem');
    expect(job.message).toBe('refreshed 1 of 1 movie, rescanned 3 files');
    expect(rescanned).toEqual([m.id]);
    expect((await h.api('GET', `/movie/${m.id}`)).json<{ title: string }>().title).toBe('Refreshed Movie');
  });

  it('a failed single-item refresh is a failed job carrying the reason', async () => {
    fakeTmdb(async () => null);
    const s = insertSeries(h.db, { qualityProfileId: h.profileId });
    await h.api('POST', '/command/refresh', { seriesId: s.id });
    const job = await finished('RefreshSeriesItem');
    expect(job.status).toBe('failed');
    expect(job.message).toMatch(/no longer exists at TMDB/);
  });

  it('{ all: true } refreshes the whole library as one RefreshLibrary job', async () => {
    fakeTmdb();
    insertSeries(h.db, { qualityProfileId: h.profileId });
    insertMovie(h.db, { qualityProfileId: h.profileId });
    const res = await h.api('POST', '/command/refresh', { all: true });
    expect(res.json<Job>().name).toBe('RefreshLibrary');
    const job = await finished('RefreshLibrary');
    expect(job).toMatchObject({ status: 'completed', message: 'refreshed 1 of 1 series; refreshed 1 of 1 movies' });
  });
});

// ---------------------------------------------------------------------------------------

describe('history redownload and failed', () => {
  function grab(target: HistoryTarget, downloadId: string | null = 'HASH-1') {
    return historyServiceFor(h.ctx).recordGrab(
      {
        title: 'Show.S01E01E02.1080p.WEB-DL-GRP',
        protocol: 'torrent',
        guid: 'guid-1',
        indexerName: 'Tracker',
        indexerId: 1,
        downloadUrl: 'https://tracker.invalid/1.torrent',
        size: 2_000_000_000,
        publishDate: '2025-01-09T12:00:00.000Z',
      },
      { target, quality: quality('WEBDL-1080p'), languages: ['en'], releaseSource: 'rss' },
      downloadId,
      { name: 'qBit', implementation: 'qbittorrent' },
    );
  }

  it('POST /history/:id/redownload searches every episode of the grab and answers 202 with the job', async () => {
    const s = insertSeries(h.db, { qualityProfileId: h.profileId });
    const e1 = insertEpisode(h.db, s.id, { episodeNumber: 1 });
    const e2 = insertEpisode(h.db, s.id, { episodeNumber: 2 });
    const rows = grab({ mediaType: 'series', seriesId: s.id, episodeIds: [e1.id, e2.id] });
    const res = await h.api('POST', `/history/${rows[1]!.id}/redownload`);
    expect(res.statusCode).toBe(202);
    expect(res.json<Job>()).toMatchObject({ name: 'HistoryRedownload', status: 'running' });
    const job = await finished('HistoryRedownload');
    expect(job.status).toBe('completed');
    expect(h.searches).toEqual([{ seriesId: s.id, episodeIds: [e1.id, e2.id].sort((a, b) => a - b) }]);
  });

  it('redownload of a movie record searches the movie; unknown ids answer 404', async () => {
    const m = insertMovie(h.db, { qualityProfileId: h.profileId });
    const [row] = grab({ mediaType: 'movie', movieId: m.id }, null);
    expect((await h.api('POST', `/history/${row!.id}/redownload`)).statusCode).toBe(202);
    await finished('HistoryRedownload');
    expect(h.searches).toEqual([{ movieId: m.id }]);
    expect((await h.api('POST', '/history/999999/redownload')).statusCode).toBe(404);
  });

  it('POST /history/failed/:id blocklists the release and re-searches through the wiring', async () => {
    const s = insertSeries(h.db, { qualityProfileId: h.profileId });
    const e1 = insertEpisode(h.db, s.id, { episodeNumber: 1 });
    const [row] = grab({ mediaType: 'series', seriesId: s.id, episodeIds: [e1.id] });
    const res = await h.api('POST', `/history/failed/${row!.id}`, { message: 'bad file' });
    expect(res.statusCode).toBe(200);
    expect(res.json<Array<{ eventType: string }>>()[0]?.eventType).toBe('downloadFailed');
    await settle();
    const blocklist = (await h.api('GET', `/blocklist/series?seriesId=${s.id}`)).json<Array<{ sourceTitle: string }>>();
    expect(blocklist.map((b) => b.sourceTitle)).toEqual(['Show.S01E01E02.1080p.WEB-DL-GRP']);
    expect(h.searches).toEqual([{ seriesId: s.id, episodeIds: [e1.id] }]);
  });

  it('mark failed with skipRedownload blocklists without searching', async () => {
    const m = insertMovie(h.db, { qualityProfileId: h.profileId });
    const [row] = grab({ mediaType: 'movie', movieId: m.id });
    expect((await h.api('POST', `/history/failed/${row!.id}`, { skipRedownload: true })).statusCode).toBe(200);
    await settle();
    expect((await h.api('GET', `/blocklist/movie?movieId=${m.id}`)).json<unknown[]>()).toHaveLength(1);
    expect(h.searches).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------

describe('blocklist add / clear / bulk', () => {
  const entry = (movieId: number, title: string) => ({ mediaType: 'movie', movieId, sourceTitle: title, quality: quality('WEBDL-1080p'), protocol: 'torrent' });

  it('POST /blocklist adds manually and POST /blocklist/clear removes everything', async () => {
    const m = insertMovie(h.db, { qualityProfileId: h.profileId });
    expect((await h.api('POST', '/blocklist', entry(m.id, 'Movie.A.1080p'))).statusCode).toBe(201);
    expect((await h.api('POST', '/blocklist', entry(m.id, 'Movie.B.1080p'))).statusCode).toBe(201);
    expect((await h.api('GET', '/blocklist')).json<{ totalRecords: number }>().totalRecords).toBe(2);
    expect((await h.api('POST', '/blocklist/clear')).json()).toEqual({ deleted: 2 });
    expect((await h.api('GET', '/blocklist')).json<{ totalRecords: number }>().totalRecords).toBe(0);
  });

  it('DELETE /blocklist/bulk validates its body and deletes the listed ids', async () => {
    const m = insertMovie(h.db, { qualityProfileId: h.profileId });
    const a = (await h.api('POST', '/blocklist', entry(m.id, 'Movie.A.1080p'))).json<{ id: number }>();
    await h.api('POST', '/blocklist', entry(m.id, 'Movie.B.1080p'));
    expect((await h.api('DELETE', '/blocklist/bulk', {})).statusCode).toBe(400);
    expect((await h.api('DELETE', '/blocklist/bulk', { ids: [] })).statusCode).toBe(400);
    expect((await h.api('DELETE', '/blocklist/bulk', { ids: ['x'] })).statusCode).toBe(400);
    expect((await h.api('DELETE', '/blocklist/bulk', { ids: [0] })).statusCode).toBe(400);
    const res = await h.api('DELETE', '/blocklist/bulk', { ids: [a.id] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: 1 });
    expect((await h.api('GET', '/blocklist')).json<{ totalRecords: number }>().totalRecords).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------

describe('calendar filters and feed token', () => {
  it('mediaType narrows to episodes or movies; tags and unmonitored still apply', async () => {
    const tag = insertTag(h.db, 'kids');
    const s = insertSeries(h.db, { title: 'Tagged', tags: [tag], qualityProfileId: h.profileId });
    insertEpisode(h.db, s.id, { airDateUtc: '2030-05-11T01:00:00Z', airDate: '2030-05-11' });
    const other = insertSeries(h.db, { title: 'Untagged', monitored: false, qualityProfileId: h.profileId });
    insertEpisode(h.db, other.id, { airDateUtc: '2030-05-11T02:00:00Z', airDate: '2030-05-11' });
    insertMovie(h.db, { title: 'Film', inCinemas: '2030-05-12', tags: [tag], qualityProfileId: h.profileId });
    const get = async (qs: string) =>
      (await h.api('GET', `/calendar?start=2030-05-10&end=2030-05-13&${qs}`)).json<Array<{ type: string; seriesTitle?: string; movie?: { title: string } }>>().map((i) => i.seriesTitle ?? i.movie?.title);
    expect(await get('')).toEqual(['Tagged', 'Film']);
    expect(await get('mediaType=series')).toEqual(['Tagged']);
    expect(await get('mediaType=movie')).toEqual(['Film']);
    expect(await get('mediaType=series&unmonitored=true')).toEqual(['Tagged', 'Untagged']);
    expect(await get(`mediaType=series&unmonitored=true&tags=${tag}`)).toEqual(['Tagged']);
    expect((await h.api('GET', '/calendar?mediaType=books')).statusCode).toBe(400);
  });

  it('POST /calendar/feed/regenerate rotates the iCal token and the old feed URL stops working', async () => {
    const before = (await h.api('GET', '/calendar/feed')).json<{ token: string; path: string }>();
    const rotated = await h.api('POST', '/calendar/feed/regenerate');
    expect(rotated.statusCode).toBe(200);
    const after = rotated.json<{ token: string; path: string }>();
    expect(after.token).not.toBe(before.token);
    expect(after.path).toBe(`/api/v1/calendar/feed.ics?token=${after.token}`);
    expect((await h.api('GET', '/calendar/feed')).json<{ token: string }>().token).toBe(after.token);
    expect((await h.api('GET', `/calendar/feed.ics?token=${before.token}`)).statusCode).toBe(401);
    expect((await h.api('GET', `/calendar/feed.ics?token=${after.token}`)).statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------

describe('library bulk editor and search on add', () => {
  it('PUT /series/bulk adds/removes tags and queues refresh and search jobs', async () => {
    const keep = insertTag(h.db, 'keep');
    const drop = insertTag(h.db, 'drop');
    const a = insertSeries(h.db, { tags: [drop], qualityProfileId: h.profileId });
    const b = insertSeries(h.db, { tags: [], qualityProfileId: h.profileId });
    const service = activeMetadataService()!;
    service.isConfigured = () => true;
    service.lookupSeries = async (id) => seriesMeta(id);
    const res = await h.api('PUT', '/series/bulk', { ids: [a.id, b.id], tags: { add: [keep], remove: [drop] }, refresh: true, search: true });
    expect(res.statusCode).toBe(200);
    expect(res.json<Array<{ tags: number[] }>>().map((s) => s.tags)).toEqual([[keep], [keep]]);
    expect((await finished('RefreshSeriesItem')).message).toBe('refreshed 2 of 2 series');
    expect((await finished('SeriesSearch')).message).toBe('searched 2, grabbed 0');
    expect(h.searches).toEqual([{ seriesId: a.id }, { seriesId: b.id }]);
  });

  it('PUT /movie/bulk with search: true searches each movie; without flags nothing is queued', async () => {
    const m1 = insertMovie(h.db, { qualityProfileId: h.profileId });
    const m2 = insertMovie(h.db, { qualityProfileId: h.profileId });
    expect((await h.api('PUT', '/movie/bulk', { ids: [m1.id, m2.id], monitored: false })).statusCode).toBe(200);
    await settle();
    expect(h.searches).toEqual([]);
    const res = await h.api('PUT', '/movie/bulk', { ids: [m1.id, m2.id], monitored: true, search: true });
    expect(res.json<Array<{ monitored: boolean }>>().every((m) => m.monitored)).toBe(true);
    await finished('MovieSearch');
    expect(h.searches).toEqual([{ movieId: m1.id }, { movieId: m2.id }]);
  });

  it('PUT /series/bulk with an unknown tag fails without queueing anything', async () => {
    const a = insertSeries(h.db, { qualityProfileId: h.profileId });
    const res = await h.api('PUT', '/series/bulk', { ids: [a.id], tags: { add: [777] }, search: true });
    expect(res.statusCode).toBe(400);
    await settle();
    expect(h.searches).toEqual([]);
  });

  it('POST /series with searchOnAdd queues a search for the new series', async () => {
    const root = (await h.api('POST', '/rootfolder', { path: process.cwd(), mediaType: 'series' })).json<{ path: string }>();
    const res = await h.api('POST', '/series', { tmdbId: 5150, rootFolderPath: root.path, qualityProfileId: h.profileId, searchOnAdd: true });
    expect(res.statusCode).toBe(201);
    await finished('SeriesSearch');
    expect(h.searches).toEqual([{ seriesId: res.json<{ id: number }>().id }]);
  });
});

describe('library routes without wiring', () => {
  it('refuses bulk refresh/search with 400 and leaves the items unchanged', async () => {
    const db = await createTestDb();
    const log = pino({ level: 'silent' });
    const bus = new EventBus();
    const ctx: AppContext = { config, db, bus, scheduler: new Scheduler(db, bus, log), log, startedAt: new Date() };
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(libraryRoutes(ctx), { prefix: '/api/v1' });
    const s = insertSeries(db, { monitored: true });
    const res = await app.inject({ method: 'PUT', url: '/api/v1/series/bulk', payload: { ids: [s.id], monitored: false, refresh: true } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not available/);
    expect(db.select().from(series).where(eq(series.id, s.id)).get()?.monitored).toBe(true);
    await app.close();
  });
});

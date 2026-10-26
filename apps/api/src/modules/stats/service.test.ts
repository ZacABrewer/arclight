import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import pino from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { AddMovieRequest, AddSeriesRequest, QUALITIES, type IndexerStats, type MediaInfo, type QualityName } from '@arclight/shared';
import type { AppContext } from '../../app.js';
import type { Db } from '../../db/index.js';
import { episodes, history, rootFolders } from '../../db/schema.js';
import { createTestDb } from '../../db/test-utils.js';
import { EventBus } from '../../events.js';
import { Scheduler } from '../../scheduler.js';
import { libraryService } from '../library/index.js';
import { statsModuleWith } from './index.js';
import * as tables from './schema.js';
import { resolutionBucket, StatsService } from './service.js';

const NOW = new Date('2026-03-31T12:00:00.000Z');
const TV = '/data/tv';
const MV = '/data/movies';
const GB = 1024 ** 3;
let db: Db;

const q = (name: QualityName) => ({ quality: { ...QUALITIES[name], mediaTypes: [...QUALITIES[name].mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } });

const disk = async (path: string) => (path === TV ? { totalBytes: 8000 * GB, freeBytes: 1000 * GB } : path === MV ? { totalBytes: 4000 * GB, freeBytes: 3000 * GB } : null);

async function seed() {
  // Root folders are inserted directly: these paths do not exist on the test machine.
  db.insert(rootFolders).values([{ path: TV, mediaType: 'series' }, { path: MV, mediaType: 'movie' }]).run();
  const show = libraryService.addSeries(
    db,
    {
      tmdbId: 1,
      title: 'Big Show',
      year: 2019,
      status: 'continuing',
      seasons: [{ seasonNumber: 1 }],
      episodes: [
        { seasonNumber: 1, episodeNumber: 1, airDateUtc: '2026-01-01T00:00:00Z' },
        { seasonNumber: 1, episodeNumber: 2, airDateUtc: '2026-01-08T00:00:00Z' },
        { seasonNumber: 1, episodeNumber: 3, airDateUtc: '2026-01-15T00:00:00Z' },
        { seasonNumber: 1, episodeNumber: 4, airDateUtc: '2026-12-01T00:00:00Z' },
        { seasonNumber: 1, episodeNumber: 5, airDateUtc: '2026-01-22T00:00:00Z' },
      ],
    },
    AddSeriesRequest.parse({ tmdbId: 1, rootFolderPath: TV, qualityProfileId: 1 }),
    NOW.toISOString(),
  );
  const ended = libraryService.addSeries(
    db,
    { tmdbId: 2, title: 'Old Show', year: 2001, status: 'ended', seasons: [{ seasonNumber: 1 }], episodes: [{ seasonNumber: 1, episodeNumber: 1, airDateUtc: '2001-01-01T00:00:00Z' }] },
    AddSeriesRequest.parse({ tmdbId: 2, rootFolderPath: TV, qualityProfileId: 1, monitored: false }),
    NOW.toISOString(),
  );
  const eps = libraryService.listEpisodes(db, { seriesId: show.id });
  db.update(episodes).set({ monitored: false }).where(eq(episodes.id, eps[4]!.id)).run();
  const add = (epIndex: number, size: number, quality: QualityName, mediaInfo: MediaInfo | null) =>
    libraryService.addMediaFile(db, {
      mediaType: 'series',
      seriesId: show.id,
      seasonNumber: 1,
      episodeIds: [eps[epIndex]!.id],
      relativePath: `e${epIndex}.mkv`,
      path: `${show.path}/e${epIndex}.mkv`,
      sizeBytes: size,
      quality: q(quality),
      languages: ['en'],
      mediaInfo,
    });
  add(0, 2 * GB, 'WEBDL-1080p', { videoCodec: 'HEVC', width: 1920, height: 1080, videoDynamicRange: 'SDR' });
  add(1, 3 * GB, 'WEBDL-2160p', { videoCodec: 'HEVC', resolution: '3840x2160', videoDynamicRange: 'HDR10' });
  const movie = libraryService.addMovie(
    db,
    { tmdbId: 10, title: 'Huge Film', year: 2020, status: 'released', digitalRelease: '2020-05-01' },
    AddMovieRequest.parse({ tmdbId: 10, rootFolderPath: MV, qualityProfileId: 1 }),
    NOW.toISOString(),
  );
  const small = libraryService.addMovie(
    db,
    { tmdbId: 11, title: 'Small Film', year: 2018, status: 'released', digitalRelease: '2018-05-01' },
    AddMovieRequest.parse({ tmdbId: 11, rootFolderPath: MV, qualityProfileId: 1 }),
    NOW.toISOString(),
  );
  libraryService.addMovie(
    db,
    { tmdbId: 12, title: 'Wanted Film', year: 2022, status: 'released', digitalRelease: '2022-05-01' },
    AddMovieRequest.parse({ tmdbId: 12, rootFolderPath: MV, qualityProfileId: 1 }),
    NOW.toISOString(),
  );
  libraryService.addMediaFile(db, { mediaType: 'movie', movieId: movie.id, relativePath: 'h.mkv', path: `${movie.path}/h.mkv`, sizeBytes: 40 * GB, quality: q('Remux-2160p'), languages: ['en'], mediaInfo: { videoCodec: 'HEVC', width: 3840, height: 1600, videoDynamicRange: 'DV HDR10' } });
  libraryService.addMediaFile(db, { mediaType: 'movie', movieId: small.id, relativePath: 's.avi', path: `${small.path}/s.avi`, sizeBytes: 1 * GB, quality: q('SDTV'), languages: ['en'] });
  return { show, ended, eps, movie, small };
}

beforeEach(async () => {
  db = await createTestDb(tables);
});

function service(extra: Partial<ConstructorParameters<typeof StatsService>[0]> = {}) {
  return new StatsService({ db, diskUsage: disk, now: () => NOW, ...extra });
}

function hist(eventType: 'grabbed' | 'downloadFolderImported' | 'downloadFailed', date: string, downloadId: string | null, data: Record<string, string> = {}, episodeId = 1) {
  db.insert(history)
    .values({ eventType, mediaType: 'series', seriesId: 1, episodeId, sourceTitle: 'x', quality: q('HDTV-720p'), languages: [], date, downloadId, data })
    .run();
}

describe('StatsService.storage', () => {
  it('per root folder: total/free from the volume and bytes used by Arclight', async () => {
    await seed();
    const s = await service().storage();
    expect(s.totalUsedBytes).toBe(46 * GB);
    expect(s.totalFiles).toBe(4);
    expect(s.rootFolders).toEqual([
      { path: TV, mediaType: 'series', accessible: true, totalBytes: 8000 * GB, freeBytes: 1000 * GB, usedByArclightBytes: 5 * GB, fileCount: 2 },
      { path: MV, mediaType: 'movie', accessible: true, totalBytes: 4000 * GB, freeBytes: 3000 * GB, usedByArclightBytes: 41 * GB, fileCount: 2 },
    ]);
  });

  it('top series and movies by size, limited to N', async () => {
    const t = await seed();
    const s = await service().storage(1);
    expect(s.topMovies).toEqual([{ mediaType: 'movie', id: t.movie.id, title: 'Huge Film', year: 2020, sizeBytes: 40 * GB, fileCount: 1 }]);
    expect(s.topSeries).toEqual([{ mediaType: 'series', id: t.show.id, title: 'Big Show', year: 2019, sizeBytes: 5 * GB, fileCount: 2 }]);
  });

  it('breaks down by quality, codec, resolution and dynamic range', async () => {
    await seed();
    const s = await service().storage();
    expect(s.byQuality.map((b) => b.key)).toEqual(['Remux-2160p', 'WEBDL-2160p', 'WEBDL-1080p', 'SDTV']);
    expect(s.byVideoCodec).toEqual([
      { key: 'HEVC', count: 3, sizeBytes: 45 * GB },
      { key: 'Unknown', count: 1, sizeBytes: 1 * GB },
    ]);
    expect(s.byResolution).toEqual([
      { key: '2160p', count: 2, sizeBytes: 43 * GB },
      { key: '1080p', count: 1, sizeBytes: 2 * GB },
      { key: 'SD', count: 1, sizeBytes: 1 * GB },
    ]);
    expect(s.byDynamicRange.map((b) => b.key)).toEqual(['DV HDR10', 'HDR10', 'SDR', 'Unknown']);
  });

  it('growth over 30/90 days from the daily snapshots', async () => {
    await seed();
    const svc = service();
    for (const [date, used] of [['2026-01-05', 30], ['2026-03-05', 40], ['2026-03-20', 44]] as const) {
      db.insert(tables.statsSnapshots).values({ date, rootFolderPath: TV, usedBytes: used * GB, fileCount: 1, takenAt: `${date}T00:15:00Z`, totalBytes: null, freeBytes: null }).run();
    }
    const g = (await svc.storage()).growth;
    expect(g.last30).toEqual({ days: 30, fromBytes: 40 * GB, toBytes: 46 * GB, deltaBytes: 6 * GB });
    expect(g.last90).toEqual({ days: 90, fromBytes: 30 * GB, toBytes: 46 * GB, deltaBytes: 16 * GB });
    expect(g.points.map((p) => p.date)).toEqual(['2026-01-05', '2026-03-05', '2026-03-20']);
  });

  it('no snapshots: growth windows have no starting point; inaccessible roots report nulls', async () => {
    await seed();
    const s = await service({ diskUsage: async () => null }).storage();
    expect(s.growth.last30).toEqual({ days: 30, fromBytes: null, toBytes: 46 * GB, deltaBytes: null });
    expect(s.rootFolders[0]).toMatchObject({ accessible: false, totalBytes: null, freeBytes: null });
  });

  it('snapshot writes one row per root per day and overwrites on a second run', async () => {
    await seed();
    const svc = service();
    expect(await svc.snapshot()).toEqual({ date: '2026-03-31', rootFolders: 2 });
    await svc.snapshot();
    const rows = db.select().from(tables.statsSnapshots).all();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.rootFolderPath === MV)).toMatchObject({ usedBytes: 41 * GB, fileCount: 2, freeBytes: 3000 * GB });
  });
});

describe('StatsService.library and activity', () => {
  it('counts series, episodes by status, movies and files', async () => {
    await seed();
    const s = service().library();
    expect(s.series).toEqual({ total: 2, monitored: 1, continuing: 1, ended: 1 });
    // Big Show: e1,e2 downloaded; e3 aired+missing; e4 unaired; e5 unmonitored. Old Show: unmonitored series.
    expect(s.episodes).toEqual({ total: 6, downloaded: 2, missing: 1, unaired: 1, unmonitored: 2, cutoffUnmet: 0 });
    expect(s.movies).toEqual({ total: 3, monitored: 3, downloaded: 2, missing: 1, cutoffUnmet: 0 });
    expect(s.files).toEqual({ total: 4, sizeBytes: 46 * GB });
  });

  it('cutoff counts use the injected checker', async () => {
    await seed();
    const s = service({ cutoffChecker: () => (file) => file.quality.quality.resolution >= 2160 }).library();
    expect(s.episodes.cutoffUnmet).toBe(1);
    expect(s.movies.cutoffUnmet).toBe(1);
  });

  it('activity per day for the window, collapsing season packs and filling empty days', () => {
    hist('grabbed', '2026-03-30T10:00:00Z', 'pack1', {}, 1);
    hist('grabbed', '2026-03-30T10:00:00Z', 'pack1', {}, 2);
    hist('grabbed', '2026-03-31T08:00:00Z', 'single', {});
    hist('downloadFolderImported', '2026-03-31T09:00:00Z', 'pack1', { importedPath: '/tv/a.mkv' }, 1);
    hist('downloadFolderImported', '2026-03-31T09:00:00Z', 'pack1', { importedPath: '/tv/b.mkv' }, 2);
    hist('downloadFailed', '2026-03-29T09:00:00Z', 'bad', {});
    hist('grabbed', '2026-01-01T00:00:00Z', 'old', {});
    const a = service().activity(3);
    expect(a.since).toBe('2026-03-29T00:00:00.000Z');
    expect(a.perDay).toEqual([
      { date: '2026-03-29', grabbed: 0, imported: 0, failed: 1 },
      { date: '2026-03-30', grabbed: 1, imported: 0, failed: 0 },
      { date: '2026-03-31', grabbed: 1, imported: 2, failed: 0 },
    ]);
    expect(a.totals).toEqual({ grabbed: 2, imported: 2, failed: 1 });
    expect(service().activity().perDay).toHaveLength(30);
  });

  it('resolution buckets fall back to the quality when nothing was probed', () => {
    expect(resolutionBucket(null, q('Bluray-720p'))).toBe('720p');
    expect(resolutionBucket({ resolution: '1920x800' }, q('Unknown'))).toBe('1080p');
    expect(resolutionBucket(null, q('Unknown'))).toBe('Unknown');
  });
});

describe('stats routes', () => {
  it('serve storage, library, activity and the indexer proxy', async () => {
    await seed();
    const bus = new EventBus();
    const log = pino({ level: 'silent' });
    const ctx: AppContext = { config: {} as AppContext['config'], db, bus, scheduler: new Scheduler(db, bus, log), log, startedAt: new Date() };
    const indexerStats: IndexerStats = { days: 7, since: '2026-03-24T00:00:00.000Z', indexers: [], totals: { queries: 0, grabs: 0, failures: 0, avgResponseMs: null, byDay: [] } };
    let askedDays = 0;
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(
      statsModuleWith({ diskUsage: disk, now: () => NOW, indexerStats: (d) => ((askedDays = d), indexerStats) })(ctx),
      { prefix: '/api/v1' },
    );
    const storage = await app.inject({ method: 'GET', url: '/api/v1/stats/storage?top=1' });
    expect(storage.statusCode).toBe(200);
    expect(storage.json().topMovies).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/api/v1/stats/library' })).json().movies.total).toBe(3);
    expect((await app.inject({ method: 'GET', url: '/api/v1/stats/activity?days=7' })).json().perDay).toHaveLength(7);
    expect((await app.inject({ method: 'GET', url: '/api/v1/stats/activity?days=0' })).statusCode).toBe(400);
    const idx = await app.inject({ method: 'GET', url: '/api/v1/stats/indexers?days=7' });
    expect(idx.statusCode).toBe(200);
    expect(askedDays).toBe(7);
    await app.close();
  });
});

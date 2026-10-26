import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { eq } from 'drizzle-orm';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AddMovieRequest, AddSeriesRequest, QUALITIES, type MediaInfo, type ServerEvent } from '@arclight/shared';
import type { AppContext } from '../../app.js';
import type { Db } from '../../db/index.js';
import { mediaFiles } from '../../db/schema.js';
import { createTestDb } from '../../db/test-utils.js';
import { EventBus } from '../../events.js';
import { Scheduler } from '../../scheduler.js';
import { healthServiceFor } from '../health/index.js';
import { libraryService } from '../library/index.js';
import { ffprobeMissingCheck } from './health.js';
import { mediaAnalysisFor, mediaAnalysisModuleWith } from './index.js';
import type { MediaProber } from './runner.js';
import * as tables from './schema.js';
import { MediaAnalysisQueue } from './service.js';

const NOW = '2026-01-01T00:00:00.000Z';
const log = pino({ level: 'silent' });
let tmp: string;
let db: Db;
let bus: EventBus;
let events: ServerEvent[];

class FakeProber implements MediaProber {
  binary: string | null = '/usr/bin/ffprobe';
  calls: string[] = [];
  failFor = new Set<string>();
  inFlight = 0;
  maxInFlight = 0;
  async locate() {
    return this.binary;
  }
  async analyze(path: string): Promise<MediaInfo> {
    this.calls.push(path);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((r) => setTimeout(r, 5));
    this.inFlight--;
    if (this.failFor.has(path)) throw new Error('Invalid data found when processing input');
    return { videoCodec: 'HEVC', resolution: '3840x2160', runtimeSeconds: 2600, videoDynamicRange: 'HDR10' };
  }
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mt-analysis-'));
  await mkdir(join(tmp, 'tv'));
  await mkdir(join(tmp, 'movies'));
  db = await createTestDb(tables);
  await libraryService.addRootFolder(db, { path: join(tmp, 'tv'), mediaType: 'series' });
  await libraryService.addRootFolder(db, { path: join(tmp, 'movies'), mediaType: 'movie' });
  bus = new EventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const quality = () => ({ quality: { ...QUALITIES['Bluray-1080p'], mediaTypes: [...QUALITIES['Bluray-1080p'].mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } });

function seed() {
  const series = libraryService.addSeries(
    db,
    {
      tmdbId: 1,
      title: 'Show',
      year: 2020,
      status: 'continuing',
      seasons: [{ seasonNumber: 1 }],
      episodes: [1, 2, 3].map((n) => ({ seasonNumber: 1, episodeNumber: n, title: `E${n}` })),
    },
    AddSeriesRequest.parse({ tmdbId: 1, rootFolderPath: join(tmp, 'tv'), qualityProfileId: 1 }),
    NOW,
  );
  const movie = libraryService.addMovie(
    db,
    { tmdbId: 2, title: 'Film', year: 2021, status: 'released' },
    AddMovieRequest.parse({ tmdbId: 2, rootFolderPath: join(tmp, 'movies'), qualityProfileId: 1 }),
    NOW,
  );
  const eps = libraryService.listEpisodes(db, { seriesId: series.id });
  const files = eps.map(
    (e) =>
      libraryService.addMediaFile(db, {
        mediaType: 'series',
        seriesId: series.id,
        seasonNumber: 1,
        episodeIds: [e.id],
        relativePath: `S01E0${e.episodeNumber}.mkv`,
        path: join(series.path, `S01E0${e.episodeNumber}.mkv`),
        sizeBytes: 100,
        quality: quality(),
        languages: ['en'],
      }).file,
  );
  const movieFile = libraryService.addMediaFile(db, {
    mediaType: 'movie',
    movieId: movie.id,
    relativePath: 'Film.mkv',
    path: join(movie.path, 'Film.mkv'),
    sizeBytes: 100,
    quality: quality(),
    languages: ['en'],
  }).file;
  return { series, movie, files, movieFile };
}

function queue(prober = new FakeProber(), concurrency = 2) {
  return { q: new MediaAnalysisQueue({ db, bus, log, prober, concurrency, now: () => new Date(NOW) }), prober };
}

const infoOf = (id: number) => db.select().from(mediaFiles).where(eq(mediaFiles.id, id)).get()?.mediaInfo;

describe('MediaAnalysisQueue', () => {
  it('enqueues files, analyzes them N at a time and stores media info', async () => {
    const { files, movieFile, series, movie } = seed();
    const { q, prober } = queue(new FakeProber(), 2);
    expect(q.enqueueFor({ all: true })).toBe(4);
    const r = await q.process();
    expect(r).toEqual({ skipped: false, done: 4, failed: 0, pruned: 0 });
    expect(prober.maxInFlight).toBe(2);
    expect(infoOf(files[0]!.id)).toMatchObject({ videoCodec: 'HEVC', videoDynamicRange: 'HDR10' });
    expect(infoOf(movieFile.id)?.resolution).toBe('3840x2160');
    expect(events).toContainEqual({ type: 'library', action: 'updated', mediaType: 'series', id: series.id });
    expect(events).toContainEqual({ type: 'library', action: 'updated', mediaType: 'movie', id: movie.id });
    expect((await q.summary())).toMatchObject({ pending: 0, done: 4, failed: 0, ffprobePath: '/usr/bin/ffprobe', concurrency: 2 });
  });

  it('records failures with the ffprobe message and retries them when re-queued', async () => {
    const { movieFile } = seed();
    const prober = new FakeProber();
    prober.failFor.add(movieFile.path);
    const { q } = queue(prober);
    q.enqueue([movieFile.id]);
    expect(await q.process()).toMatchObject({ done: 0, failed: 1 });
    const s = await q.summary();
    expect(s.failed).toBe(1);
    expect(s.recentFailures[0]).toMatchObject({ mediaFileId: movieFile.id, path: movieFile.path, error: 'Invalid data found when processing input' });
    prober.failFor.clear();
    expect(q.enqueue([movieFile.id])).toBe(1);
    expect(await q.process()).toMatchObject({ done: 1, failed: 0 });
    expect(q.jobsFor([movieFile.id])[0]).toMatchObject({ status: 'done', attempts: 2, error: null });
  });

  it('skips (keeps the queue) when ffprobe is missing', async () => {
    const { movieFile } = seed();
    const prober = new FakeProber();
    prober.binary = null;
    const { q } = queue(prober);
    q.enqueue([movieFile.id]);
    expect(await q.process()).toMatchObject({ skipped: true, done: 0 });
    expect(q.jobsFor([movieFile.id])[0]!.status).toBe('pending');
  });

  it('prunes queue rows whose media file is gone', async () => {
    const { movieFile } = seed();
    const { q, prober } = queue();
    q.enqueue([movieFile.id]);
    await libraryService.deleteMediaFile(db, movieFile.id);
    expect(await q.process()).toMatchObject({ pruned: 1, done: 0 });
    expect(prober.calls).toHaveLength(0);
    expect(q.jobsFor([movieFile.id])).toHaveLength(0);
  });

  it('enqueueFor: series/movie re-analyze by default; all only files without info unless forced', async () => {
    const { series, movie } = seed();
    const { q } = queue();
    q.enqueueFor({ all: true });
    await q.process();
    expect(q.enqueueFor({ all: true })).toBe(0);
    expect(q.enqueueFor({ all: true, force: true })).toBe(4);
    await q.process();
    expect(q.enqueueFor({ seriesId: series.id })).toBe(3);
    expect(q.enqueueFor({ movieId: movie.id })).toBe(1);
    expect(() => q.enqueueFor({})).toThrow(/required/);
  });

  it('recoverInterrupted puts running rows back to pending; enqueue leaves running rows alone', async () => {
    const { movieFile } = seed();
    const { q } = queue();
    q.enqueue([movieFile.id]);
    db.update(tables.mediaAnalysisJobs).set({ status: 'running' }).run();
    expect(q.enqueue([movieFile.id])).toBe(0);
    expect(q.recoverInterrupted()).toBe(1);
    expect(q.jobsFor([movieFile.id])[0]!.status).toBe('pending');
  });

  it('enqueueMissingFor queues only files without info and without a queue row; kicks the runner', async () => {
    const { series, files } = seed();
    const { q } = queue();
    let kicks = 0;
    q.setKicker(() => kicks++);
    db.update(mediaFiles).set({ mediaInfo: { videoCodec: 'AVC' } }).where(eq(mediaFiles.id, files[0]!.id)).run();
    expect(q.enqueueMissingFor('series', series.id)).toBe(2);
    expect(q.enqueueMissingFor('series', series.id)).toBe(0);
    expect(kicks).toBe(1);
  });

  it('concurrent process() calls share one run', async () => {
    seed();
    const { q, prober } = queue();
    q.enqueueFor({ all: true });
    const [a, b] = await Promise.all([q.process(), q.process()]);
    expect(a).toBe(b);
    expect(prober.calls).toHaveLength(4);
  });
});

describe('media-analysis module', () => {
  async function build(prober: MediaProber) {
    const scheduler = new Scheduler(db, bus, log);
    const ctx: AppContext = { config: {} as AppContext['config'], db, bus, scheduler, log, startedAt: new Date() };
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(mediaAnalysisModuleWith({ prober })(ctx), { prefix: '/api/v1' });
    await app.ready();
    return { app, ctx, scheduler };
  }

  it('POST /command/analyze queues files and the AnalyzeMedia job drains them', async () => {
    const { series } = seed();
    const prober = new FakeProber();
    const { app, ctx } = await build(prober);
    const res = await app.inject({ method: 'POST', url: '/api/v1/command/analyze', payload: { seriesId: series.id } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ queued: 3, ffprobeAvailable: true });
    await mediaAnalysisFor(ctx).process();
    const status = await app.inject({ method: 'GET', url: '/api/v1/mediaanalysis/queue' });
    // The job run also sweeps up the movie file that never had media info.
    expect(status.json()).toMatchObject({ done: 4, pending: 0 });
    const bad = await app.inject({ method: 'POST', url: '/api/v1/command/analyze', payload: { seriesId: 1, movieId: 2 } });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it('a library fileAdded event queues the new file and the job runs', async () => {
    const { movie, movieFile } = seed();
    const prober = new FakeProber();
    const { app, ctx } = await build(prober);
    bus.publish({ type: 'library', action: 'fileAdded', mediaType: 'movie', id: movie.id });
    // The kicker started AnalyzeMedia; wait for it through the shared run.
    await new Promise((r) => setTimeout(r, 0));
    await mediaAnalysisFor(ctx).process();
    expect(prober.calls).toContain(movieFile.path);
    expect(infoOf(movieFile.id)).toMatchObject({ videoCodec: 'HEVC' });
    await app.close();
  });

  it('FfprobeMissing health check warns only when ffprobe is missing', async () => {
    const prober = new FakeProber();
    const check = ffprobeMissingCheck(prober);
    expect(await check.run({} as never)).toEqual([]);
    prober.binary = null;
    const findings = await check.run({} as never);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ source: 'FfprobeMissing', status: 'warning' });
  });

  it('registers FfprobeMissing on the health service', async () => {
    const prober = new FakeProber();
    prober.binary = null;
    const { app, ctx } = await build(prober);
    const service = healthServiceFor(ctx);
    // Only exercise the registered check, not the whole catalogue (which needs full deps).
    const ids = (service as unknown as { checks: Array<{ id: string }> }).checks.map((c) => c.id);
    expect(ids).toContain('FfprobeMissing');
    await app.close();
    expect((service as unknown as { checks: Array<{ id: string }> }).checks.map((c) => c.id)).not.toContain('FfprobeMissing');
  });
});

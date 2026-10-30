import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AddMovieRequest, AddSeriesRequest, QUALITIES, type BlocklistAddRequestInput, type HealthListResponse, type HealthScanMode, type QualityModel } from '@arclight/shared';
import type { AppContext } from '../../app.js';
import type { Db } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { createTestDb } from '../../db/test-utils.js';
import { EventBus } from '../../events.js';
import { Scheduler } from '../../scheduler.js';
import { libraryService } from '../library/index.js';
import type { SearchTarget } from '../releases/service.js';
import { setSection } from '../settings/service.js';
import type { DecodeOutcome, FileKind, ProbeInfo, ProbeOutcome, StatOutcome } from './checks.js';
import { HEALTH_SCAN_JOB } from './jobs.js';
import { healthScanModuleWith } from './index.js';
import * as tables from './schema.js';
import { HealthScanService, mergeTargets, type HealthScanSummaryEvent } from './service.js';
import type { HealthTools } from './tools.js';

const NOW = '2026-10-30T02:00:00.000Z';
const log = pino({ level: 'silent' });
let tmp: string;
let db: Db;
let bus: EventBus;

/** Fake ffprobe/ffmpeg: healthy unless told otherwise per path; records every call. */
class FakeTools implements HealthTools {
  ffprobe = true;
  ffmpeg = true;
  probes = new Map<string, ProbeOutcome>();
  decodes = new Map<string, DecodeOutcome>();
  probeCalls: string[] = [];
  decodeCalls: Array<{ path: string; kind: FileKind; mode: HealthScanMode; lowPriority: boolean }> = [];
  info: ProbeInfo = { durationSeconds: 2700, hasVideo: true, audioStreamCount: 1, audioLanguages: ['eng'] };
  async available() {
    return { ffprobe: this.ffprobe, ffmpeg: this.ffmpeg };
  }
  async probe(path: string): Promise<ProbeOutcome> {
    this.probeCalls.push(path);
    return this.probes.has(path) ? this.probes.get(path)! : { ok: true, info: { ...this.info, hasVideo: !/\.(flac|mp3|m4b)$/.test(path) } };
  }
  async decode(path: string, kind: FileKind, mode: HealthScanMode, _d: number | null, opts: { lowPriority: boolean }): Promise<DecodeOutcome> {
    this.decodeCalls.push({ path, kind, mode, lowPriority: opts.lowPriority });
    return this.decodes.get(path) ?? { exitCode: 0, errors: [] };
  }
}

/** Fake file system: every path is a 1000-byte file unless set otherwise. */
const fsState = new Map<string, StatOutcome>();
const statFile = async (path: string): Promise<StatOutcome> => fsState.get(path) ?? { kind: 'ok', sizeBytes: 1000, mtimeMs: 1 };

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mt-health-'));
  for (const d of ['tv', 'movies', 'music', 'books', 'bin']) await mkdir(join(tmp, d));
  db = await createTestDb(tables);
  bus = new EventBus();
  fsState.clear();
  db.insert(schema.qualityProfiles).values({ id: 1, name: 'Any', cutoff: 1, items: [], formatItems: [], languages: ['original'] }).run();
  for (const [d, mediaType] of [['tv', 'series'], ['movies', 'movie'], ['music', 'music'], ['books', 'audiobook']] as const) {
    db.insert(schema.rootFolders).values({ path: join(tmp, d), mediaType }).run();
  }
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const quality = (): QualityModel => ({ quality: { ...QUALITIES['Bluray-1080p'], mediaTypes: [...QUALITIES['Bluray-1080p'].mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } });

function seedVideo() {
  const series = libraryService.addSeries(
    db,
    {
      tmdbId: 1,
      title: 'Show',
      year: 2020,
      status: 'continuing',
      originalLanguage: 'en',
      runtimeMinutes: 45,
      seasons: [{ seasonNumber: 1 }],
      episodes: [1, 2].map((n) => ({ seasonNumber: 1, episodeNumber: n, title: `E${n}`, runtimeMinutes: 45 })),
    },
    AddSeriesRequest.parse({ tmdbId: 1, rootFolderPath: join(tmp, 'tv'), qualityProfileId: 1 }),
    NOW,
  );
  const movie = libraryService.addMovie(
    db,
    { tmdbId: 2, title: 'Film', year: 2021, status: 'released', runtimeMinutes: 120, originalLanguage: 'ja' },
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
        sizeBytes: 1000,
        quality: quality(),
        languages: ['en'],
      }).file,
  );
  const movieFile = libraryService.addMediaFile(db, {
    mediaType: 'movie',
    movieId: movie.id,
    relativePath: 'Film.mkv',
    path: join(movie.path, 'Film.mkv'),
    sizeBytes: 1000,
    quality: quality(),
    languages: ['ja'],
    sceneName: 'Film.2021.1080p.BluRay.x264-GRP',
  }).file;
  return { series, movie, eps, files, movieFile };
}

function seedAudio() {
  const type = db.insert(schema.albumTypeProfiles).values({ name: 'Studio', primaryTypes: ['Album'], secondaryTypes: [], releaseStatuses: ['Official'] }).returning().get();
  const artist = db
    .insert(schema.artists)
    .values({ mbArtistId: 'a1', name: 'Band', sortName: 'Band', cleanName: 'band', genres: [], images: [], links: [], aliases: [], path: join(tmp, 'music', 'Band'), rootFolderPath: join(tmp, 'music'), qualityProfileId: 1, albumTypeProfileId: type.id, tags: [], added: NOW })
    .returning()
    .get();
  const album = db
    .insert(schema.albums)
    .values({ artistId: artist.id, mbReleaseGroupId: 'rg1', title: 'Record', cleanTitle: 'record', primaryType: 'Album', secondaryTypes: [], genres: [], images: [], ratings: {}, added: NOW })
    .returning()
    .get();
  const release = db.insert(schema.albumReleases).values({ albumId: album.id, mbReleaseId: 'r1', title: 'Record', labels: [], formats: [], media: [] }).returning().get();
  const trackFiles = [1, 2, 4].map((n) => {
    const file = db
      .insert(schema.audioFiles)
      .values({ mediaType: 'music', artistId: artist.id, albumId: album.id, path: join(artist.path, `0${n}.flac`), relativePath: `0${n}.flac`, sizeBytes: 1000, dateAdded: NOW, quality: quality(), trackNumber: n, discNumber: 1, durationMs: 240_000 })
      .returning()
      .get();
    db.insert(schema.tracks).values({ albumId: album.id, albumReleaseId: release.id, absoluteNumber: n, trackNumber: n, title: `Song ${n}`, durationMs: 240_000, hasFile: true, audioFileId: file.id }).run();
    return file;
  });
  const author = db
    .insert(schema.authors)
    .values({ name: 'Writer', sortName: 'Writer', cleanName: 'writer', images: [], genres: [], aliases: [], path: join(tmp, 'books', 'Writer'), rootFolderPath: join(tmp, 'books'), qualityProfileId: 1, languages: [], tags: [], added: NOW })
    .returning()
    .get();
  const book = db
    .insert(schema.books)
    .values({ authorId: author.id, title: 'Tome', sortTitle: 'Tome', cleanTitle: 'tome', authorCredits: [], narrators: [], genres: [], images: [], chapters: [], ratings: {}, runtimeMinutes: 600, hasFile: true, added: NOW })
    .returning()
    .get();
  const parts = [1, 3].map((n) =>
    db
      .insert(schema.audioFiles)
      .values({ mediaType: 'audiobook', authorId: author.id, bookId: book.id, path: join(author.path, 'Tome', `Part ${n}.mp3`), relativePath: `Tome/Part ${n}.mp3`, sizeBytes: 1000, dateAdded: NOW, quality: quality(), partNumber: n, durationMs: 3600_000 })
      .returning()
      .get(),
  );
  return { artist, album, trackFiles, author, book, parts };
}

interface Built {
  service: HealthScanService;
  tools: FakeTools;
  blocklisted: BlocklistAddRequestInput[];
  searches: SearchTarget[][];
  notified: HealthScanSummaryEvent[];
}

function build(now: () => Date = () => new Date(NOW)): Built {
  const tools = new FakeTools();
  const blocklisted: BlocklistAddRequestInput[] = [];
  const searches: SearchTarget[][] = [];
  const notified: HealthScanSummaryEvent[] = [];
  const service = new HealthScanService({
    db,
    tools,
    bus,
    log,
    now,
    statFile,
    blocklist: (i) => void blocklisted.push(i),
    search: (t) => {
      searches.push(t);
      return 99;
    },
    notify: async (e) => void notified.push(e),
  });
  return { service, tools, blocklisted, searches, notified };
}

const open = async (s: HealthScanService) => (await s.list()).records;
const byType = (r: HealthListResponse['records']) => r.map((f) => `${f.title}:${f.type}`).sort();

describe('HealthScanService.scan', () => {
  it('checks every kind of file and records findings with severity and details', async () => {
    const v = seedVideo();
    seedAudio();
    const { service, tools, notified } = build();
    fsState.set(v.files[1]!.path, { kind: 'missing' });
    tools.probes.set(v.files[0]!.path, { ok: true, info: { durationSeconds: 900, hasVideo: true, audioStreamCount: 1, audioLanguages: ['eng'] } });
    tools.decodes.set(v.movieFile.path, { exitCode: 0, errors: ['[h264] error while decoding MB 1 1'] });
    tools.probes.set(v.movieFile.path, { ok: true, info: { durationSeconds: 7100, hasVideo: true, audioStreamCount: 2, audioLanguages: ['eng', 'und'] } });
    const r = await service.scan({ all: true });
    expect(r).toMatchObject({ files: 8, checked: 8, skipped: 0, stoppedEarly: false });
    const records = await open(service);
    expect(byType(records)).toEqual([
      'Band – Record:trackGaps',
      'Film (2021):decodeErrors',
      'Film (2021):wrongLanguage',
      'Show S01E01:truncated',
      'Show S01E02:missing',
      'Writer – Tome:bookParts',
      'Writer – Tome:truncated',
    ]);
    const missing = records.find((f) => f.type === 'missing')!;
    expect(missing).toMatchObject({ severity: 'error', status: 'open', source: 'media', fileId: v.files[1]!.id, seriesId: v.series.id, firstSeen: NOW });
    expect(missing.details).toContain('missing');
    // Original language of the movie is Japanese; its file has English audio.
    expect(records.find((f) => f.type === 'wrongLanguage')!.data).toEqual({ have: ['en'], wanted: ['ja'] });
    expect(records.find((f) => f.type === 'trackGaps')!.data).toMatchObject({ missingNumbers: [3] });
    expect(records.find((f) => f.type === 'bookParts')!).toMatchObject({ severity: 'error', data: { missingNumbers: [2] } });
    // Missing files are not probed; everything ran at low priority, quick mode.
    expect(tools.probeCalls).not.toContain(v.files[1]!.path);
    expect(tools.decodeCalls.every((c) => c.mode === 'quick' && c.lowPriority)).toBe(true);
    const list = await service.list();
    expect(list.counts).toMatchObject({ open: 7, byType: { missing: 1, truncated: 2, decodeErrors: 1 }, bySeverity: { error: 2, warning: 5, info: 0 } });
    expect(list).toMatchObject({ filesChecked: 8, filesTotal: 8, lastScan: NOW, running: false });
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({ totalNew: 7, totalOpen: 7, filesChecked: 8 });
  });

  it('resumes: unchanged files are skipped, changed files are checked again', async () => {
    const v = seedVideo();
    const { service, tools } = build();
    await service.scan({ all: true });
    tools.probeCalls = [];
    const again = await service.scan({ all: true });
    expect(again).toMatchObject({ checked: 0, skipped: 3 });
    fsState.set(v.movieFile.path, { kind: 'ok', sizeBytes: 2000, mtimeMs: 5 });
    expect(await service.scan({ all: true })).toMatchObject({ checked: 1, skipped: 2 });
    expect(tools.probeCalls).toEqual([v.movieFile.path]);
    // A deep scan does not count quick checks as done; force checks everything.
    expect(await service.scan({ all: true, mode: 'deep' })).toMatchObject({ checked: 3 });
    expect(await service.scan({ all: true })).toMatchObject({ skipped: 3 });
    expect(await service.scan({ all: true, force: true })).toMatchObject({ checked: 3 });
  });

  it('a check of chosen items is always forced and only touches those files', async () => {
    const v = seedVideo();
    const { service, tools } = build();
    await service.scan({ all: true });
    tools.probeCalls = [];
    const r = await service.scan({ movieIds: [v.movie.id] });
    expect(r).toMatchObject({ files: 1, checked: 1, skipped: 0 });
    expect(tools.probeCalls).toEqual([v.movieFile.path]);
    expect(await service.scan({ files: [{ source: 'media', id: v.files[0]!.id }] })).toMatchObject({ files: 1, checked: 1 });
  });

  it('marks findings fixed when the problem is gone and reopens them when it comes back', async () => {
    const v = seedVideo();
    const { service } = build();
    fsState.set(v.movieFile.path, { kind: 'ok', sizeBytes: 0, mtimeMs: 1 });
    await service.scan({ all: true });
    const [empty] = (await open(service)).filter((f) => f.type === 'empty');
    expect(empty).toBeDefined();
    fsState.set(v.movieFile.path, { kind: 'ok', sizeBytes: 500, mtimeMs: 2 });
    const r = await service.scan({ all: true });
    expect(r.fixed).toBe(1);
    expect((await service.list({ status: 'fixed' })).records.map((f) => f.id)).toEqual([empty!.id]);
    fsState.set(v.movieFile.path, { kind: 'ok', sizeBytes: 0, mtimeMs: 3 });
    expect((await service.scan({ all: true })).newFindings).toBe(1);
    expect((await open(service)).find((f) => f.id === empty!.id)?.status).toBe('open');
  });

  it('ignored findings stay ignored until the file changes', async () => {
    const v = seedVideo();
    const { service, tools } = build();
    tools.decodes.set(v.movieFile.path, { exitCode: 0, errors: ['bad frame'] });
    await service.scan({ all: true });
    const f = (await open(service)).find((x) => x.type === 'decodeErrors')!;
    expect(service.ignore([f.id])).toEqual([{ id: f.id, ok: true }]);
    expect((await open(service)).some((x) => x.id === f.id)).toBe(false);
    // Same file, checked again (forced): still ignored, and not "new".
    expect((await service.scan({ movieIds: [v.movie.id] })).newFindings).toBe(0);
    expect((await service.list({ status: 'ignored' })).records.map((x) => x.id)).toEqual([f.id]);
    // The file changed and still has the problem: open again.
    fsState.set(v.movieFile.path, { kind: 'ok', sizeBytes: 1001, mtimeMs: 9 });
    await service.scan({ movieIds: [v.movie.id] });
    expect((await open(service)).find((x) => x.id === f.id)?.status).toBe('open');
    service.ignore([f.id]);
    service.unignore([f.id]);
    expect((await open(service)).find((x) => x.id === f.id)?.status).toBe('open');
  });

  it('stops at the end of the time window and resumes on the next run', async () => {
    seedVideo();
    setSection(db, 'healthScan', { ...build().service.settings(), window: { enabled: true, start: '01:00', end: '05:00' } });
    let hour = 2;
    const { service, tools } = build(() => new Date(2026, 9, 30, hour, 0));
    const origProbe = tools.probe.bind(tools);
    tools.probe = async (p) => {
      hour = 6; // the window closes while the first file is checked
      return origProbe(p);
    };
    const first = await service.scan({ all: true }, { scheduled: true });
    expect(first).toMatchObject({ checked: 1, stoppedEarly: true });
    hour = 2;
    tools.probe = origProbe;
    const second = await service.scan({ all: true }, { scheduled: true });
    expect(second).toMatchObject({ checked: 2, skipped: 1, stoppedEarly: false });
    // Manual runs ignore the window.
    hour = 12;
    expect(await service.scan({ all: true, force: true })).toMatchObject({ checked: 3, stoppedEarly: false });
  });

  it('honours concurrency, the low-priority switch and missing tools', async () => {
    seedVideo();
    const { service, tools } = build();
    setSection(db, 'healthScan', { ...service.settings(), lowPriority: false, concurrency: 2, notify: false });
    tools.ffmpeg = false;
    await service.scan({ all: true });
    expect(tools.decodeCalls).toHaveLength(0);
    tools.ffmpeg = true;
    tools.ffprobe = false;
    await service.scan({ all: true, force: true });
    expect(tools.decodeCalls.every((c) => !c.lowPriority)).toBe(true);
    expect(tools.decodeCalls).toHaveLength(3);
    expect((await service.list()).ffprobe).toBe(false);
  });

  it('prunes findings of files that left the library', async () => {
    const v = seedVideo();
    const { service } = build();
    fsState.set(v.movieFile.path, { kind: 'missing' });
    await service.scan({ all: true });
    expect((await open(service)).length).toBe(1);
    await libraryService.deleteMediaFile(db, v.movieFile.id);
    await service.scan({ all: true });
    expect((await service.list({ status: 'all' })).records).toEqual([]);
  });
});

describe('fix actions', () => {
  async function brokenMovie() {
    const v = seedVideo();
    const built = build();
    await mkdir(v.movie.path, { recursive: true });
    await writeFile(v.movieFile.path, 'broken');
    built.tools.probes.set(v.movieFile.path, { ok: false, message: 'moov atom not found' });
    await built.service.scan({ all: true });
    const finding = (await open(built.service)).find((f) => f.type === 'unparseable')!;
    return { ...v, ...built, finding };
  }

  it('replace: blocklists the imported release, recycles the file and searches', async () => {
    const m = await brokenMovie();
    setSection(db, 'mediaManagement', { ...(await import('../settings/service.js')).getSection(db, 'mediaManagement'), recycleBinPath: join(tmp, 'bin') });
    db.insert(schema.history)
      .values([
        { eventType: 'grabbed', mediaType: 'movie', movieId: m.movie.id, sourceTitle: 'Film.2021.1080p.BluRay.x264-GRP', quality: quality(), languages: ['ja'], date: NOW, downloadId: 'HASH1', data: { indexer: 'Tracker', protocol: 'torrent', torrentInfoHash: 'hash1', size: '1000' } },
        { eventType: 'downloadFolderImported', mediaType: 'movie', movieId: m.movie.id, sourceTitle: 'Film.2021.1080p.BluRay.x264-GRP', quality: quality(), languages: ['ja'], date: NOW, downloadId: 'HASH1', data: { fileId: String(m.movieFile.id) } },
      ])
      .run();
    const r = await m.service.act('replace', [m.finding.id], () => null);
    expect(r).toMatchObject({ action: 'replace', succeeded: 1, failed: 0, jobId: 99 });
    expect(r.results[0]).toMatchObject({ ok: true, blocklisted: true });
    expect(r.results[0]!.recycledTo).toContain(join(tmp, 'bin'));
    expect(m.blocklisted).toEqual([
      expect.objectContaining({ mediaType: 'movie', movieId: m.movie.id, sourceTitle: 'Film.2021.1080p.BluRay.x264-GRP', protocol: 'torrent', indexer: 'Tracker', torrentInfoHash: 'hash1', size: 1000 }),
    ]);
    expect(m.searches).toEqual([[{ movieId: m.movie.id }]]);
    expect(db.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.id, m.movieFile.id)).get()).toBeUndefined();
    expect(await readdir(m.movie.path)).toEqual([]);
    expect((await m.service.list({ status: 'all' })).records.some((f) => f.fileId === m.movieFile.id)).toBe(false);
  });

  it('replace without import history still deletes and searches (no blocklist)', async () => {
    const m = await brokenMovie();
    const r = await m.service.act('replace', [m.finding.id], () => null);
    expect(r.results[0]).toMatchObject({ ok: true, blocklisted: false, recycledTo: null });
    expect(m.blocklisted).toEqual([]);
    expect(m.searches).toHaveLength(1);
  });

  it('delete removes the file from disk and the library; recheck starts a check of the file', async () => {
    const m = await brokenMovie();
    let rechecked: unknown = null;
    const re = await m.service.act('recheck', [m.finding.id, 12345], (target) => {
      rechecked = target;
      return 7;
    });
    expect(re).toMatchObject({ succeeded: 1, failed: 1, jobId: 7 });
    expect(rechecked).toEqual({ files: [{ source: 'media', id: m.movieFile.id }], albumIds: [], bookIds: [] });
    const del = await m.service.act('delete', [m.finding.id], () => null);
    expect(del).toMatchObject({ succeeded: 1, jobId: null });
    expect(await readdir(m.movie.path)).toEqual([]);
    expect(m.searches).toEqual([]);
  });

  it('album and book findings cannot be replaced or deleted file by file', async () => {
    seedAudio();
    const { service } = build();
    await service.scan({ all: true });
    const gaps = (await open(service)).find((f) => f.type === 'trackGaps')!;
    const r = await service.act('replace', [gaps.id], () => null);
    expect(r.results[0]).toMatchObject({ ok: false });
    expect((await service.act('delete', [gaps.id], () => null)).failed).toBe(1);
    expect(service.filesFor([gaps.id])).toEqual({ files: [], albumIds: [gaps.albumId], bookIds: [] });
  });

  it('removes audio files from tracks and books', async () => {
    const a = seedAudio();
    const { service, tools } = build();
    tools.probes.set(a.trackFiles[0]!.path, { ok: false, message: 'Invalid data' });
    await service.scan({ all: true });
    const f = (await open(service)).find((x) => x.type === 'unparseable')!;
    const r = await service.act('replace', [f.id], () => null);
    expect(r.results[0]).toMatchObject({ ok: true, blocklisted: false });
    expect(db.select().from(schema.tracks).where(eq(schema.tracks.audioFileId, a.trackFiles[0]!.id)).all()).toEqual([]);
  });

  it('merges search targets per series', () => {
    expect(mergeTargets([{ seriesId: 1, episodeIds: [2] }, { movieId: 3 }, { seriesId: 1, episodeIds: [1] }, { movieId: 3 }])).toEqual([{ movieId: 3 }, { seriesId: 1, episodeIds: [1, 2] }]);
    expect(mergeTargets([{ seriesId: 1, episodeIds: [2] }, { seriesId: 1 }])).toEqual([{ seriesId: 1 }]);
  });
});

describe('health-scan module (routes and job)', () => {
  async function app() {
    const scheduler = new Scheduler(db, bus, log);
    const ctx: AppContext = { config: {} as AppContext['config'], db, bus, scheduler, log, startedAt: new Date() };
    const tools = new FakeTools();
    const a = Fastify().withTypeProvider<ZodTypeProvider>();
    a.setValidatorCompiler(validatorCompiler);
    a.setSerializerCompiler(serializerCompiler);
    await a.register(healthScanModuleWith({ tools, statFile, search: () => 5, notify: async () => undefined, blocklist: () => undefined })(ctx), { prefix: '/api/v1' });
    await a.ready();
    return { app: a, scheduler, tools };
  }

  async function idle(scheduler: Scheduler) {
    for (let i = 0; i < 200 && scheduler.listRecent().some((j) => j.status === 'running'); i++) await new Promise((r) => setTimeout(r, 10));
  }

  it('registers the weekly job, scans on demand and lists findings', async () => {
    const v = seedVideo();
    fsState.set(v.movieFile.path, { kind: 'missing' });
    const { app: a, scheduler } = await app();
    expect(scheduler.jobSchedule(HEALTH_SCAN_JOB)).toEqual({ cron: '0 3 * * 0', enabled: true });
    const started = await a.inject({ method: 'POST', url: '/api/v1/library/health/scan', payload: { all: true } });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toMatchObject({ name: 'HealthScan', status: 'running' });
    await idle(scheduler);
    const list = await a.inject({ method: 'GET', url: '/api/v1/library/health?movieId=' + v.movie.id });
    expect(list.statusCode).toBe(200);
    expect(list.json().records).toEqual([expect.objectContaining({ type: 'missing', movieId: v.movie.id })]);
    const bad = await a.inject({ method: 'POST', url: '/api/v1/library/health/scan', payload: {} });
    expect(bad.statusCode).toBe(400);
    const item = await a.inject({ method: 'POST', url: '/api/v1/library/health/scan', payload: { movieIds: [v.movie.id] } });
    expect(item.json()).toMatchObject({ name: 'HealthCheck' });
  });

  it('runs actions and validates them', async () => {
    const v = seedVideo();
    fsState.set(v.movieFile.path, { kind: 'missing' });
    const { app: a, scheduler } = await app();
    await scheduler.run(HEALTH_SCAN_JOB, 'manual');
    const id = ((await a.inject({ method: 'GET', url: '/api/v1/library/health' })).json() as HealthListResponse).records[0]!.id;
    const ignored = await a.inject({ method: 'POST', url: '/api/v1/library/health/action', payload: { action: 'ignore', ids: [id] } });
    expect(ignored.json()).toMatchObject({ action: 'ignore', succeeded: 1, failed: 0 });
    expect(((await a.inject({ method: 'GET', url: '/api/v1/library/health?status=ignored' })).json() as HealthListResponse).records).toHaveLength(1);
    const recheck = await a.inject({ method: 'POST', url: '/api/v1/library/health/action', payload: { action: 'recheck', ids: [id] } });
    expect(recheck.json().jobId).toEqual(expect.any(Number));
    expect((await a.inject({ method: 'POST', url: '/api/v1/library/health/action', payload: { action: 'explode', ids: [id] } })).statusCode).toBe(400);
    expect((await a.inject({ method: 'POST', url: '/api/v1/library/health/action', payload: { action: 'ignore', ids: [] } })).statusCode).toBe(400);
  });

  it('reads and writes the settings and reschedules the job', async () => {
    const { app: a, scheduler } = await app();
    const got = await a.inject({ method: 'GET', url: '/api/v1/settings/healthscan' });
    const current = got.json<Record<string, unknown>>();
    expect(got.json()).toMatchObject({ schedule: 'weekly', mode: 'quick', concurrency: 1, lowPriority: true, truncatedPercent: 75, window: { enabled: false } });
    const put = await a.inject({ method: 'PUT', url: '/api/v1/settings/healthscan', payload: { ...current, schedule: 'daily', window: { enabled: true, start: '02:30', end: '06:00' } } });
    expect(put.statusCode).toBe(200);
    expect(scheduler.jobSchedule(HEALTH_SCAN_JOB)?.cron).toBe('30 2 * * *');
    await a.inject({ method: 'PUT', url: '/api/v1/settings/healthscan', payload: { ...put.json<Record<string, unknown>>(), schedule: 'off' } });
    expect(scheduler.jobSchedule(HEALTH_SCAN_JOB)?.cron).toBeNull();
    expect((await a.inject({ method: 'PUT', url: '/api/v1/settings/healthscan', payload: { ...current, concurrency: 9 } })).statusCode).toBe(400);
  });
});

import { link, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AddMovieRequest, AddSeriesRequest, HygieneMapRequest, QUALITIES, type ServerEvent } from '@arclight/shared';
import type { AppContext } from '../../app.js';
import type { Db } from '../../db/index.js';
import { createTestDb } from '../../db/test-utils.js';
import { EventBus } from '../../events.js';
import { Scheduler } from '../../scheduler.js';
import { ImportsService, type DownloadClientsPort } from '../imports/index.js';
import { libraryService } from '../library/index.js';
import { setSection, getSection } from '../settings/service.js';
import { libraryHygieneModuleWith, orphanFilesCheck } from './index.js';
import * as tables from './schema.js';
import { LibraryHygieneService, titleSimilarity } from './service.js';

const NOW = '2026-02-01T00:00:00.000Z';
const log = pino({ level: 'silent' });
let tmp: string;
let tv: string;
let mv: string;
let db: Db;
let bus: EventBus;
let events: ServerEvent[];

const downloads: DownloadClientsPort = {
  setState: () => {
    throw new Error('unused');
  },
  markImported: async () => {
    throw new Error('unused');
  },
  listTracked: () => [],
};

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mt-hygiene-'));
  tv = join(tmp, 'tv');
  mv = join(tmp, 'movies');
  await mkdir(tv, { recursive: true });
  await mkdir(mv, { recursive: true });
  db = await createTestDb(tables);
  await libraryService.addRootFolder(db, { path: tv, mediaType: 'series' });
  await libraryService.addRootFolder(db, { path: mv, mediaType: 'movie' });
  bus = new EventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const quality = () => ({ quality: { ...QUALITIES['HDTV-720p'], mediaTypes: [...QUALITIES['HDTV-720p'].mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } });

async function put(path: string, content: string | Buffer = 'x'.repeat(64)): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return path;
}

async function tree() {
  const show = libraryService.addSeries(
    db,
    {
      tmdbId: 1,
      title: 'Show Name',
      year: 2020,
      status: 'continuing',
      seasons: [{ seasonNumber: 1 }],
      episodes: [1, 2, 3].map((n) => ({ seasonNumber: 1, episodeNumber: n, title: `Episode ${n}` })),
    },
    AddSeriesRequest.parse({ tmdbId: 1, rootFolderPath: tv, qualityProfileId: 1 }),
    NOW,
  );
  const movie = libraryService.addMovie(
    db,
    { tmdbId: 2, title: 'Great Movie', year: 2021, status: 'released' },
    AddMovieRequest.parse({ tmdbId: 2, rootFolderPath: mv, qualityProfileId: 1 }),
    NOW,
  );
  const other = libraryService.addMovie(
    db,
    { tmdbId: 3, title: 'Other Movie', year: 2019, status: 'released' },
    AddMovieRequest.parse({ tmdbId: 3, rootFolderPath: mv, qualityProfileId: 1 }),
    NOW,
  );
  const eps = libraryService.listEpisodes(db, { seriesId: show.id });
  const season = join(show.path, 'Season 01');
  const ep1 = await put(join(season, 'Show.Name.S01E01.720p.HDTV-GRP.mkv'));
  const ep1File = libraryService.addMediaFile(db, {
    mediaType: 'series',
    seriesId: show.id,
    seasonNumber: 1,
    episodeIds: [eps[0]!.id],
    relativePath: 'Season 01/Show.Name.S01E01.720p.HDTV-GRP.mkv',
    path: ep1,
    sizeBytes: 64,
    quality: quality(),
    languages: ['en'],
  }).file;
  const movieContent = Buffer.alloc(4096, 7);
  const moviePath = await put(join(movie.path, 'Great.Movie.2021.1080p.BluRay.mkv'), movieContent);
  const movieFile = libraryService.addMediaFile(db, {
    mediaType: 'movie',
    movieId: movie.id,
    relativePath: 'Great.Movie.2021.1080p.BluRay.mkv',
    path: moviePath,
    sizeBytes: movieContent.length,
    quality: quality(),
    languages: ['en'],
  }).file;
  await mkdir(other.path, { recursive: true }); // an item's empty folder: expected, not reported

  const paths = {
    inFolderOrphan: await put(join(season, 'Show.Name.S01E02.720p.HDTV-GRP.mkv'), 'a'.repeat(70)),
    episodeDuplicate: await put(join(season, 'Show.Name.S01E01.REPACK.720p.HDTV-ALT.mkv'), 'b'.repeat(71)),
    stray: await put(join(tv, 'Random.Thing.S02E03.1080p.WEB-DL.mkv'), 'c'.repeat(72)),
    typo: await put(join(tv, 'Show.Nam.S01E03.720p.HDTV.mkv'), 'd'.repeat(73)),
    contentCopy: await put(join(mv, 'Backup', 'Great.Movie.2021.copy.mkv'), movieContent),
    extra: await put(join(show.path, 'Extras', 'Behind the scenes.mkv'), 'e'.repeat(74)),
    trailer: await put(join(movie.path, 'Great.Movie-trailer.mkv'), 'f'.repeat(75)),
    hidden: await put(join(tv, '.stash', 'Hidden.S01E01.mkv'), 'g'.repeat(76)),
    nfo: await put(join(movie.path, 'movie.nfo'), 'nfo'),
  };
  await mkdir(join(tv, 'Empty', 'Nested', 'Deeper'), { recursive: true });
  await put(join(tv, 'OnlyJunk', 'Thumbs.db'), 'junk');
  return { show, movie, other, eps, ep1, ep1File, movieFile, moviePath, paths };
}

function service() {
  return new LibraryHygieneService({
    db,
    bus,
    log,
    now: () => new Date(NOW),
    importer: () => new ImportsService({ db, bus, downloadClients: downloads, now: () => new Date(NOW) }),
  });
}

const byPath = (s: LibraryHygieneService, path: string) => s.list().records.find((r) => r.path === path);

describe('LibraryHygieneService.scan', () => {
  it('lists unknown video files as orphans with parser guesses', async () => {
    const t = await tree();
    const s = service();
    const summary = await s.scan();
    expect(summary).toMatchObject({ rootFolders: 2, orphans: 3, skippedRootFolders: [] });
    const stray = byPath(s, t.paths.stray)!;
    expect(stray).toMatchObject({ type: 'orphan', rootFolderPath: tv, sizeBytes: 72, mediaFileId: null });
    expect(stray.parsed).toMatchObject({ title: 'Random Thing', mediaType: 'series', seasonNumber: 2, episodeNumbers: [3], quality: 'WEBDL-1080p' });
    expect(stray.suggestions).toEqual([]);
  });

  it('an orphan inside a series folder suggests that series and the parsed episodes with score 1', async () => {
    const t = await tree();
    const s = service();
    await s.scan();
    const f = byPath(s, t.paths.inFolderOrphan)!;
    expect(f.type).toBe('orphan');
    expect(f.suggestions[0]).toEqual({ mediaType: 'series', seriesId: t.show.id, title: 'Show Name', year: 2020, score: 1, seasonNumber: 1, episodeIds: [t.eps[1]!.id] });
  });

  it('suggests a best match by fuzzy title for orphans outside any item folder', async () => {
    const t = await tree();
    const s = service();
    await s.scan();
    const f = byPath(s, t.paths.typo)!;
    expect(f.suggestions[0]).toMatchObject({ seriesId: t.show.id, episodeIds: [t.eps[2]!.id] });
    expect(f.suggestions[0]!.score).toBeGreaterThan(0.5);
    expect(f.suggestions[0]!.score).toBeLessThan(1);
  });

  it('a second file for an episode that already has one is a duplicate (reason episode)', async () => {
    const t = await tree();
    const s = service();
    await s.scan();
    const f = byPath(s, t.paths.episodeDuplicate)!;
    expect(f).toMatchObject({ type: 'duplicate', duplicateReason: 'episode', seriesId: t.show.id, duplicateOf: [t.ep1] });
  });

  it('identical size + hash prefix across root folders are content duplicates', async () => {
    const t = await tree();
    const s = service();
    await s.scan();
    const lib = byPath(s, t.moviePath)!;
    const copy = byPath(s, t.paths.contentCopy)!;
    expect(lib).toMatchObject({ type: 'duplicate', duplicateReason: 'content', mediaFileId: t.movieFile.id, duplicateOf: [t.paths.contentCopy] });
    expect(copy).toMatchObject({ type: 'duplicate', duplicateReason: 'content', mediaFileId: null, duplicateOf: [t.moviePath] });
  });

  it('hard links of one file are not duplicates', async () => {
    const t = await tree();
    await rm(t.paths.contentCopy);
    const linked = join(mv, 'Linked', 'Great.Movie.2021.hardlink.mkv');
    await mkdir(dirname(linked), { recursive: true });
    await link(t.moviePath, linked);
    const s = service();
    await s.scan();
    expect(byPath(s, t.moviePath)).toBeUndefined();
    expect(byPath(s, linked)?.type).toBe('orphan');
  });

  it('reports only the topmost empty folders; item folders and junk-only folders handled', async () => {
    const t = await tree();
    const s = service();
    await s.scan();
    const empty = s.list({ type: 'empty' }).records.map((r) => r.path).sort();
    expect(empty).toEqual([join(tv, 'Empty'), join(tv, 'OnlyJunk')].sort());
    expect(empty).not.toContain(t.other.path);
  });

  it('ignores extras, trailers, hidden folders, non-video files and the recycle bin', async () => {
    const t = await tree();
    const bin = join(tv, 'recycle');
    await put(join(bin, 'Old.Show.S01E01.mkv'));
    setSection(db, 'mediaManagement', { ...getSection(db, 'mediaManagement'), recycleBinPath: bin });
    const s = service();
    await s.scan();
    const paths = s.list().records.map((r) => r.path);
    for (const p of [t.paths.extra, t.paths.trailer, t.paths.hidden, t.paths.nfo, join(bin, 'Old.Show.S01E01.mkv')]) expect(paths).not.toContain(p);
  });

  it('flags a movie with two library files and series files no episode points at', async () => {
    const t = await tree();
    const second = await put(join(t.movie.path, 'Great.Movie.2021.720p.mkv'), 'z'.repeat(99));
    // A row for the same movie added directly (as a migration could leave behind).
    db.insert((await import('../../db/schema.js')).mediaFiles)
      .values({ mediaType: 'movie', movieId: t.movie.id, relativePath: 'Great.Movie.2021.720p.mkv', path: second, sizeBytes: 99, dateAdded: NOW, quality: quality(), languages: [] })
      .run();
    const stranded = await put(join(t.show.path, 'Season 01', 'Old.S01E01.mkv'), 'y'.repeat(98));
    db.insert((await import('../../db/schema.js')).mediaFiles)
      .values({ mediaType: 'series', seriesId: t.show.id, seasonNumber: 1, relativePath: 'Season 01/Old.S01E01.mkv', path: stranded, sizeBytes: 98, dateAdded: NOW, quality: quality(), languages: [] })
      .run();
    const s = service();
    await s.scan();
    expect(byPath(s, second)).toMatchObject({ type: 'duplicate', duplicateReason: 'movie', movieId: t.movie.id });
    expect(byPath(s, stranded)).toMatchObject({ type: 'duplicate', duplicateReason: 'episode', seriesId: t.show.id, duplicateOf: [] });
  });

  it('skips missing root folders and replaces the previous findings on rescan', async () => {
    const t = await tree();
    const s = service();
    await s.scan();
    await rm(t.paths.stray);
    await rm(mv, { recursive: true, force: true });
    const summary = await s.scan();
    expect(summary.skippedRootFolders).toEqual([mv]);
    expect(byPath(s, t.paths.stray)).toBeUndefined();
    expect(s.list().counts).toEqual({ orphan: 2, duplicate: 1, empty: 2 });
    expect(s.list().lastScan).toBe(NOW);
  });
});

describe('LibraryHygieneService actions', () => {
  it('maps an orphan through manual import using the best suggestion', async () => {
    const t = await tree();
    const s = service();
    await s.scan();
    const f = byPath(s, t.paths.inFolderOrphan)!;
    const result = await s.map(f.id, HygieneMapRequest.parse({}));
    expect(result.destination).toBe(t.paths.inFolderOrphan); // already in the series folder: registered in place
    expect(libraryService.getEpisode(db, t.eps[1]!.id).episodeFileId).toBe(result.mediaFileId);
    expect(byPath(s, t.paths.inFolderOrphan)).toBeUndefined();
  });

  it('maps with an explicit target; rejects empty folders and orphans without a target', async () => {
    const t = await tree();
    const s = service();
    await s.scan();
    const typo = byPath(s, t.paths.typo)!;
    const r = await s.map(typo.id, HygieneMapRequest.parse({ seriesId: t.show.id, episodeIds: [t.eps[2]!.id], importMode: 'move' }));
    expect(r.destination.startsWith(t.show.path)).toBe(true);
    expect((await stat(r.destination)).isFile()).toBe(true);
    const empty = s.list({ type: 'empty' }).records[0]!;
    await expect(s.map(empty.id, HygieneMapRequest.parse({}))).rejects.toMatchObject({ code: 'VALIDATION' });
    const stray = byPath(s, t.paths.stray)!;
    await expect(s.map(stray.id, HygieneMapRequest.parse({}))).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(s.map(9999, HygieneMapRequest.parse({}))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('deletes an orphan through the recycle bin, keeping its folder structure', async () => {
    const t = await tree();
    const bin = join(tmp, 'bin');
    setSection(db, 'mediaManagement', { ...getSection(db, 'mediaManagement'), recycleBinPath: bin });
    const s = service();
    await s.scan();
    const f = byPath(s, t.paths.inFolderOrphan)!;
    const r = await s.delete(f.id);
    expect(r.recycledTo).toBe(join(bin, 'Show Name (2020)', 'Season 01', 'Show.Name.S01E02.720p.HDTV-GRP.mkv'));
    await expect(stat(t.paths.inFolderOrphan)).rejects.toThrow();
    expect(byPath(s, t.paths.inFolderOrphan)).toBeUndefined();
  });

  it('deleting a library duplicate removes its media file row and publishes fileDeleted', async () => {
    const t = await tree();
    const s = service();
    await s.scan();
    const lib = byPath(s, t.moviePath)!;
    const r = await s.delete(lib.id);
    expect(r).toEqual({ recycledTo: null, removedMediaFileId: t.movieFile.id });
    expect(libraryService.getMovie(db, t.movie.id).hasFile).toBe(false);
    expect(events).toContainEqual({ type: 'library', action: 'fileDeleted', mediaType: 'movie', id: t.movie.id });
  });

  it('deletes empty folders, refusing when files appeared since the scan', async () => {
    await tree();
    const s = service();
    await s.scan();
    const [a, b] = s.list({ type: 'empty' }).records;
    await s.delete(a!.id);
    expect(await readdir(tv)).not.toContain('Empty');
    await put(join(b!.path, 'new.mkv'));
    await expect(s.delete(b!.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('OrphanFilesFound warns from the threshold up', async () => {
    await tree();
    const s = service();
    await s.scan();
    expect(await orphanFilesCheck(s, 4).run({} as never)).toEqual([]);
    const findings = await orphanFilesCheck(s, 3).run({} as never);
    expect(findings).toEqual([expect.objectContaining({ source: 'OrphanFilesFound', status: 'warning' })]);
  });

  it('titleSimilarity', () => {
    expect(titleSimilarity('showname', 'showname')).toBe(1);
    expect(titleSimilarity('shownam', 'showname')).toBeGreaterThan(0.8);
    expect(titleSimilarity('randomthing', 'showname')).toBeLessThan(0.3);
    expect(titleSimilarity('', 'x')).toBe(0);
  });
});

describe('library-hygiene routes', () => {
  it('GET list, POST scan (202 job), map and delete error mapping', async () => {
    const t = await tree();
    const scheduler = new Scheduler(db, bus, log);
    const ctx: AppContext = { config: {} as AppContext['config'], db, bus, scheduler, log, startedAt: new Date() };
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(
      libraryHygieneModuleWith({ importer: () => new ImportsService({ db, bus, downloadClients: downloads }) })(ctx),
      { prefix: '/api/v1' },
    );
    const scan = await app.inject({ method: 'POST', url: '/api/v1/library/hygiene/scan' });
    expect(scan.statusCode).toBe(202);
    expect(scan.json()).toMatchObject({ name: 'OrphanScan', status: 'running' });
    // Wait for the job to finish.
    for (let i = 0; i < 100 && scheduler.listRecent(1)[0]?.status === 'running'; i++) await new Promise((r) => setTimeout(r, 20));
    const list = await app.inject({ method: 'GET', url: '/api/v1/library/hygiene?type=orphan' });
    expect(list.statusCode).toBe(200);
    expect(list.json().records.map((r: { path: string }) => r.path)).toContain(t.paths.stray);
    expect(list.json().counts.orphan).toBe(3);
    const bad = await app.inject({ method: 'GET', url: '/api/v1/library/hygiene?type=nope' });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({ method: 'DELETE', url: '/api/v1/library/hygiene/9999' });
    expect(missing.statusCode).toBe(404);
    const strayId = list.json().records.find((r: { path: string }) => r.path === t.paths.stray).id;
    const noTarget = await app.inject({ method: 'POST', url: `/api/v1/library/hygiene/${strayId}/map`, payload: {} });
    expect(noTarget.statusCode).toBe(400);
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/library/hygiene/${strayId}` });
    expect(del.statusCode).toBe(200);
    await app.close();
  });
});

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AddMovieRequest,
  AddSeriesRequest,
  ManualImportQuery,
  ManualImportRequest,
  QUALITIES,
  type QueueStatusMessage,
  type ServerEvent,
  type TrackedDownloadState,
  type TrackedDownloadStatus,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { createTestDb } from '../../db/test-utils.js';
import { EventBus } from '../../events.js';
import type { TrackedDownload } from '../download-clients/index.js';
import { libraryService } from '../library/index.js';
import { setSection } from '../settings/service.js';
import type { ImportedEvent, ImportsDeps } from './deps.js';
import { importsRoutes } from './routes.js';
import * as tables from './schema.js';
import { ImportsService, type DownloadClientsPort } from './service.js';

const NOW = '2024-06-15T12:00:00.000Z';

let tmp: string;
let tvRoot: string;
let movieRoot: string;
let downloads: string;
let db: Db;
let bus: EventBus;
let events: ServerEvent[];

/** In-memory stand-in for the download-clients service. */
class FakeDownloads implements DownloadClientsPort {
  items = new Map<number, TrackedDownload>();
  imported: number[] = [];
  add(item: TrackedDownload) {
    this.items.set(item.id, item);
    return item;
  }
  setState(id: number, state: TrackedDownloadState, options: { statusMessages?: QueueStatusMessage[]; trackedStatus?: TrackedDownloadStatus } = {}) {
    const item = this.items.get(id)!;
    const next = { ...item, trackedState: state, ...(options.statusMessages ? { statusMessages: options.statusMessages } : {}), ...(options.trackedStatus ? { trackedStatus: options.trackedStatus } : {}) };
    this.items.set(id, next);
    return next;
  }
  async markImported(id: number) {
    this.imported.push(id);
    return this.setState(id, 'imported', { statusMessages: [], trackedStatus: 'ok' });
  }
  listTracked(states?: readonly TrackedDownloadState[]) {
    return [...this.items.values()].filter((i) => !states || states.includes(i.trackedState));
  }
}

let fake: FakeDownloads;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mt-imports-'));
  tvRoot = join(tmp, 'tv');
  movieRoot = join(tmp, 'movies');
  downloads = join(tmp, 'downloads');
  for (const d of [tvRoot, movieRoot, downloads]) await mkdir(d, { recursive: true });
  // Root folders must not be empty for rescans (unmounted-drive guard).
  await writeFile(join(tvRoot, '.keep'), '');
  await writeFile(join(movieRoot, '.keep'), '');
  db = await createTestDb(tables);
  await libraryService.addRootFolder(db, { path: tvRoot, mediaType: 'series' });
  await libraryService.addRootFolder(db, { path: movieRoot, mediaType: 'movie' });
  bus = new EventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
  fake = new FakeDownloads();
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function service(deps: ImportsDeps = {}) {
  return new ImportsService({ db, bus, downloadClients: fake, deps, now: () => new Date(NOW) });
}

function addSeries() {
  return libraryService.addSeries(
    db,
    {
      tmdbId: 100,
      title: 'Show Name',
      year: 2020,
      status: 'continuing',
      runtimeMinutes: 45,
      originalLanguage: 'en',
      seasons: [{ seasonNumber: 1 }],
      episodes: [1, 2, 3].map((n) => ({
        seasonNumber: 1,
        episodeNumber: n,
        title: `Episode ${n}`,
        airDate: `2020-01-0${n}`,
        airDateUtc: `2020-01-0${n}T20:00:00Z`,
      })),
    },
    AddSeriesRequest.parse({ tmdbId: 100, rootFolderPath: tvRoot, qualityProfileId: 1 }),
    NOW,
  );
}

function addMovie() {
  return libraryService.addMovie(
    db,
    { tmdbId: 200, title: 'Great Movie', originalTitle: 'Great Movie', year: 2021, status: 'released', runtimeMinutes: 120, originalLanguage: 'en' },
    AddMovieRequest.parse({ tmdbId: 200, rootFolderPath: movieRoot, qualityProfileId: 1 }),
    NOW,
  );
}

async function put(rel: string, size = 64): Promise<string> {
  const full = join(downloads, rel);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, Buffer.alloc(size, 1));
  return full;
}

function tracked(overrides: Partial<TrackedDownload> & { id: number; title: string; outputPath: string }): TrackedDownload {
  return fake.add({
    downloadId: `hash${overrides.id}`,
    downloadClientId: 1,
    downloadClientName: 'qbit',
    status: 'completed',
    trackedStatus: 'ok',
    statusMessages: [],
    protocol: 'torrent',
    sizeBytes: 100,
    sizeLeftBytes: 0,
    progress: 1,
    added: '2024-06-01T00:00:00.000Z',
    trackedState: 'importPending',
    canMoveFiles: true,
    canBeRemoved: true,
    isReadOnly: false,
    grabbedRelease: null,
    ...overrides,
  });
}

const exists = (p: string) => stat(p).then(() => true, () => false);
const episodesOf = (seriesId: number) => libraryService.listEpisodes(db, { seriesId });

describe('completed download import (series)', () => {
  it('imports a single episode end-to-end, keeping the name with rename off', async () => {
    const series = addSeries();
    const [e1] = episodesOf(series.id);
    const src = await put('Show.Name.S01E01.1080p.WEB-DL.x264-GRP/Show.Name.S01E01.1080p.WEB-DL.x264-GRP.mkv');
    const recorded: ImportedEvent[] = [];
    const notified: ImportedEvent[] = [];
    const svc = service({ history: { recordImport: (e) => void recorded.push(e) }, notifications: { onImported: (e) => void notified.push(e) } });
    const item = tracked({
      id: 1,
      title: 'Show.Name.S01E01.1080p.WEB-DL.x264-GRP',
      outputPath: join(downloads, 'Show.Name.S01E01.1080p.WEB-DL.x264-GRP'),
      mediaType: 'series',
      seriesId: series.id,
      episodeIds: [e1!.id],
    });

    const r = await svc.importCompletedDownload(item);
    expect(r.verified).toBe(true);
    const dest = join(series.path, 'Season 1', 'Show.Name.S01E01.1080p.WEB-DL.x264-GRP.mkv');
    expect(r.outcomes[0]).toMatchObject({ status: 'imported', destination: dest });
    expect(await exists(dest)).toBe(true);
    expect(await exists(src)).toBe(false);
    // Source folder held only the video: it is removed after a move.
    expect(await exists(join(downloads, 'Show.Name.S01E01.1080p.WEB-DL.x264-GRP'))).toBe(false);
    const files = libraryService.listMediaFiles(db, { seriesId: series.id });
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ episodeIds: [e1!.id], releaseGroup: 'GRP', sceneName: 'Show.Name.S01E01.1080p.WEB-DL.x264-GRP' });
    expect(files[0]!.quality.quality.name).toBe('WEBDL-1080p');
    expect(fake.imported).toEqual([1]);
    expect(recorded).toHaveLength(1);
    expect(notified[0]).toMatchObject({ downloadId: 'hash1', isUpgrade: false, importMode: 'move' });
    expect(events.some((e) => e.type === 'import' && e.action === 'imported')).toBe(true);
  });

  it('renames with the organizer when rename is on and copies when the client keeps seeding', async () => {
    setSection(db, 'naming', { ...(await import('@arclight/shared')).NAMING_DEFAULTS, renameEpisodes: true });
    const series = addSeries();
    const [e1] = episodesOf(series.id);
    const src = await put('Show.Name.S01E01.720p.HDTV.x264-GRP.mkv');
    const svc = service();
    const r = await svc.importCompletedDownload(
      tracked({ id: 2, title: 'Show.Name.S01E01.720p.HDTV.x264-GRP', outputPath: src, mediaType: 'series', seriesId: series.id, episodeIds: [e1!.id], canMoveFiles: false }),
    );
    expect(r.verified).toBe(true);
    expect(r.outcomes[0]!.destination).toBe(join(series.path, 'Season 1', 'Show Name - S01E01 - Episode 1 HDTV-720p.mkv'));
    expect(await exists(src)).toBe(true);
  });

  it('imports a season pack and blocks with messages when an episode is missing', async () => {
    const series = addSeries();
    const eps = episodesOf(series.id);
    const folder = join(downloads, 'Show.Name.S01.1080p.WEB-DL-GRP');
    await put('Show.Name.S01.1080p.WEB-DL-GRP/Show.Name.S01E01.1080p.WEB-DL-GRP.mkv');
    await put('Show.Name.S01.1080p.WEB-DL-GRP/Show.Name.S01E02.1080p.WEB-DL-GRP.mkv');
    await put('Show.Name.S01.1080p.WEB-DL-GRP/Show.Name.S01E02.sample.mkv', 4);
    const svc = service();
    const r = await svc.importCompletedDownload(
      tracked({ id: 3, title: 'Show.Name.S01.1080p.WEB-DL-GRP', outputPath: folder, mediaType: 'series', seriesId: series.id, episodeIds: eps.map((e) => e.id) }),
    );
    expect(r.outcomes.filter((o) => o.status === 'imported')).toHaveLength(2);
    expect(r.verified).toBe(false);
    expect(fake.items.get(3)).toMatchObject({ trackedState: 'importPending', trackedStatus: 'warning' });
    const lines = r.messages[0]!.messages;
    expect(lines[0]).toMatch(/One or more episodes expected/);
    expect(lines.some((l) => l.includes('sample') && l.includes('Sample'))).toBe(true);
    expect(events.some((e) => e.type === 'import' && e.action === 'manualRequired')).toBe(true);
  });

  it('upgrades: recycles the old file and reports replacedFileIds', async () => {
    const binPath = join(tmp, 'bin');
    setSection(db, 'mediaManagement', { ...service().getMediaManagement(), recycleBinPath: binPath });
    const series = addSeries();
    const [e1] = episodesOf(series.id);
    const oldPath = join(series.path, 'Season 1', 'Show.Name.S01E01.720p.HDTV.x264-OLD.mkv');
    await mkdir(join(series.path, 'Season 1'), { recursive: true });
    await writeFile(oldPath, 'old');
    const { file: old } = libraryService.addMediaFile(db, {
      mediaType: 'series',
      seriesId: series.id,
      seasonNumber: 1,
      episodeIds: [e1!.id],
      relativePath: join('Season 1', 'Show.Name.S01E01.720p.HDTV.x264-OLD.mkv'),
      path: oldPath,
      sizeBytes: 3,
      quality: { quality: { ...QUALITIES['HDTV-720p'], mediaTypes: ['series', 'movie'] }, revision: { version: 1, real: 0, isRepack: false } },
      languages: ['en'],
    });
    const src = await put('Show.Name.S01E01.1080p.BluRay.x264-NEW.mkv');
    const r = await service().importCompletedDownload(
      tracked({ id: 4, title: 'Show.Name.S01E01.1080p.BluRay.x264-NEW', outputPath: src, mediaType: 'series', seriesId: series.id, episodeIds: [e1!.id] }),
    );
    expect(r.outcomes[0]).toMatchObject({ status: 'imported', replacedFileIds: [old.id] });
    expect(await exists(oldPath)).toBe(false);
    expect(await exists(join(binPath, 'Show Name (2020)', 'Season 1', 'Show.Name.S01E01.720p.HDTV.x264-OLD.mkv'))).toBe(true);
    expect(libraryService.listMediaFiles(db, { seriesId: series.id }).map((f) => f.quality.quality.name)).toEqual(['Bluray-1080p']);
  });

  it('rejects a downgrade and leaves the existing file alone', async () => {
    const series = addSeries();
    const [e1] = episodesOf(series.id);
    const oldPath = join(series.path, 'Season 1', 'existing.mkv');
    await mkdir(join(series.path, 'Season 1'), { recursive: true });
    await writeFile(oldPath, 'old');
    libraryService.addMediaFile(db, {
      mediaType: 'series',
      seriesId: series.id,
      seasonNumber: 1,
      episodeIds: [e1!.id],
      relativePath: join('Season 1', 'existing.mkv'),
      path: oldPath,
      sizeBytes: 3,
      quality: { quality: { ...QUALITIES['Bluray-1080p'], mediaTypes: ['series', 'movie'] }, revision: { version: 1, real: 0, isRepack: false } },
      languages: ['en'],
    });
    const src = await put('Show.Name.S01E01.720p.HDTV.x264-GRP.mkv');
    const r = await service().importCompletedDownload(
      tracked({ id: 5, title: 'Show.Name.S01E01.720p.HDTV.x264-GRP', outputPath: src, mediaType: 'series', seriesId: series.id, episodeIds: [e1!.id] }),
    );
    expect(r.outcomes[0]!.rejections.map((x) => x.reason)).toContain('notQualityUpgrade');
    expect(await exists(oldPath)).toBe(true);
    expect(await exists(src)).toBe(true);
  });

  it('matches by parsed title when the tracked download carries no ids', async () => {
    const series = addSeries();
    const src = await put('Show.Name.S01E03.1080p.WEB-DL-GRP.mkv');
    const r = await service().importCompletedDownload(tracked({ id: 6, title: 'Show.Name.S01E03.1080p.WEB-DL-GRP', outputPath: src }));
    expect(r.verified).toBe(true);
    expect(episodesOf(series.id).find((e) => e.episodeNumber === 3)!.hasFile).toBe(true);
  });

  it('blocks when the series cannot be resolved or the path is missing', async () => {
    const svc = service();
    const r1 = await svc.importCompletedDownload(tracked({ id: 7, title: 'Unknown.Show.S01E01.720p', outputPath: join(downloads, 'x') }));
    expect(r1.messages[0]!.messages[0]).toMatch(/title mismatch/);
    const series = addSeries();
    const r2 = await svc.importCompletedDownload(tracked({ id: 8, title: 'Show.Name.S01E01', outputPath: join(downloads, 'gone'), seriesId: series.id, mediaType: 'series' }));
    expect(r2.messages[0]!.messages[0]).toMatch(/does not exist/);
    expect(fake.items.get(8)!.trackedState).toBe('importPending');
  });

  it('reports archives when nothing is importable', async () => {
    const series = addSeries();
    await put('Show.Name.S01E01.720p/show.rar', 10);
    const r = await service().importCompletedDownload(
      tracked({ id: 9, title: 'Show.Name.S01E01.720p', outputPath: join(downloads, 'Show.Name.S01E01.720p'), seriesId: series.id, mediaType: 'series' }),
    );
    expect(r.messages[0]!.messages).toEqual(['Found archive file, might need to be extracted', expect.stringMatching(/No files found/)]);
  });

  it('does not re-import a download that was already imported after its grab', async () => {
    const series = addSeries();
    const [e1] = episodesOf(series.id);
    const src = await put('Show.Name.S01E01.720p.HDTV.x264-GRP.mkv');
    const svc = service();
    const t = { title: 'Show.Name.S01E01.720p.HDTV.x264-GRP', outputPath: src, mediaType: 'series' as const, seriesId: series.id, episodeIds: [e1!.id], canMoveFiles: false };
    expect((await svc.importCompletedDownload(tracked({ id: 10, ...t }))).verified).toBe(true);
    // Same download id handed over again (e.g. after a restart): the AlreadyImported spec stops it.
    const again = await svc.importCompletedDownload(tracked({ id: 10, ...t }));
    expect(again.outcomes[0]!.rejections.map((x) => x.reason)).toEqual(expect.arrayContaining(['alreadyImported']));
  });
});

describe('completed download import (movie)', () => {
  it('imports a movie, renamed with the organizer', async () => {
    setSection(db, 'naming', { ...(await import('@arclight/shared')).NAMING_DEFAULTS, renameMovies: true });
    const movie = addMovie();
    await put('Great.Movie.2021.1080p.BluRay.x264-GRP/Great.Movie.2021.1080p.BluRay.x264-GRP.mkv');
    await put('Great.Movie.2021.1080p.BluRay.x264-GRP/Sample/great.movie.sample.mkv', 4);
    const r = await service().importCompletedDownload(
      tracked({ id: 20, title: 'Great.Movie.2021.1080p.BluRay.x264-GRP', outputPath: join(downloads, 'Great.Movie.2021.1080p.BluRay.x264-GRP'), mediaType: 'movie', movieId: movie.id }),
    );
    expect(r.verified).toBe(true);
    const dest = join(movie.path, 'Great Movie (2021) Bluray-1080p.mkv');
    expect(r.outcomes.find((o) => o.status === 'imported')!.destination).toBe(dest);
    expect(libraryService.getMovie(db, movie.id).hasFile).toBe(true);
    // Only a sample folder remained: deleted with the source folder.
    expect(await exists(join(downloads, 'Great.Movie.2021.1080p.BluRay.x264-GRP'))).toBe(false);
  });

  it('imports extra files alongside when enabled', async () => {
    setSection(db, 'mediaManagement', { ...service().getMediaManagement(), importExtraFiles: true, extraFileExtensions: ['srt'] });
    const movie = addMovie();
    await put('Great.Movie.2021.720p.WEB-DL-GRP/Great.Movie.2021.720p.WEB-DL-GRP.mkv');
    await put('Great.Movie.2021.720p.WEB-DL-GRP/Great.Movie.2021.720p.WEB-DL-GRP.en.srt', 3);
    await service().importCompletedDownload(
      tracked({ id: 21, title: 'Great.Movie.2021.720p.WEB-DL-GRP', outputPath: join(downloads, 'Great.Movie.2021.720p.WEB-DL-GRP'), mediaType: 'movie', movieId: movie.id }),
    );
    expect(await exists(join(movie.path, 'Great.Movie.2021.720p.WEB-DL-GRP.en.srt'))).toBe(true);
  });
});

describe('failed downloads', () => {
  it('marks failed, blocklists and asks for a new search', async () => {
    const blocked: string[] = [];
    const searches: unknown[] = [];
    const svc = service({
      blocklist: { add: ({ message }) => void blocked.push(message) },
      releases: { researchFor: (r) => void searches.push(r) },
    });
    const item = tracked({
      id: 30,
      title: 'Show.Name.S01E01',
      outputPath: join(downloads, 'x'),
      mediaType: 'series',
      seriesId: 1,
      episodeIds: [5],
      trackedState: 'failedPending',
      statusMessages: [{ title: 'Show.Name.S01E01', messages: ['Encrypted download detected'] }],
    });
    await svc.handleFailedDownload(item);
    expect(fake.items.get(30)).toMatchObject({ trackedState: 'failed', trackedStatus: 'error' });
    expect(blocked).toEqual(['Encrypted download detected']);
    expect(searches).toEqual([{ mediaType: 'series', seriesId: 1, episodeIds: [5], reason: 'failedDownload' }]);
  });

  it('skips the re-search when auto redownload is off', async () => {
    setSection(db, 'mediaManagement', { ...service().getMediaManagement(), autoRedownloadFailed: false });
    const searches: unknown[] = [];
    const svc = service({ releases: { researchFor: (r) => void searches.push(r) } });
    await svc.handleFailedDownload(tracked({ id: 31, title: 'M', outputPath: '/x', mediaType: 'movie', movieId: 3 }));
    expect(searches).toEqual([]);
  });
});

describe('manual import', () => {
  it('lists candidates with suggested mappings and rejections, then imports the chosen mapping', async () => {
    const series = addSeries();
    const eps = episodesOf(series.id);
    const folder = join(downloads, 'Show.Name.S01.Pack-GRP');
    await put('Show.Name.S01.Pack-GRP/Show.Name.S01E01.720p.HDTV-GRP.mkv');
    await put('Show.Name.S01.Pack-GRP/garbage-name-xyz.mkv');
    const svc = service();
    const items = await svc.listManualImport(ManualImportQuery.parse({ folder }));
    expect(items).toHaveLength(2);
    const good = items.find((i) => i.name.startsWith('Show'))!;
    expect(good).toMatchObject({ mediaType: 'series', seriesId: series.id, seasonNumber: 1, episodeIds: [eps[0]!.id], rejections: [] });
    const bad = items.find((i) => i.name.startsWith('garbage'))!;
    expect(bad.rejections.length).toBeGreaterThan(0);

    // The user maps the unparseable file to episode 2: specs are bypassed.
    const res = await svc.executeManualImport(
      ManualImportRequest.parse({
        items: [
          { path: good.path, mediaType: 'series', seriesId: series.id, episodeIds: [eps[0]!.id] },
          { path: bad.path, mediaType: 'series', seriesId: series.id, episodeIds: [eps[1]!.id] },
        ],
        importMode: 'copy',
      }),
    );
    expect(res.failed).toEqual([]);
    expect(res.imported).toHaveLength(2);
    expect(episodesOf(series.id).filter((e) => e.hasFile)).toHaveLength(2);
    expect(await exists(bad.path)).toBe(true);
  });

  it('lists by downloadId and marks the tracked download imported once complete', async () => {
    const movie = addMovie();
    const folder = join(downloads, 'Great.Movie.2021.720p.WEB-DL-GRP');
    const src = await put('Great.Movie.2021.720p.WEB-DL-GRP/movie.mkv');
    tracked({ id: 40, title: 'Great.Movie.2021.720p.WEB-DL-GRP', outputPath: folder, mediaType: 'movie', movieId: movie.id });
    const svc = service();
    const items = await svc.listManualImport(ManualImportQuery.parse({ downloadId: 'hash40' }));
    expect(items[0]).toMatchObject({ movieId: movie.id, downloadId: 'hash40' });
    const res = await svc.executeManualImport(
      ManualImportRequest.parse({ items: [{ path: src, mediaType: 'movie', movieId: movie.id, downloadId: 'hash40' }] }),
    );
    expect(res.imported).toHaveLength(1);
    expect(fake.imported).toEqual([40]);
  });

  it('reports a failure for a missing file', async () => {
    const movie = addMovie();
    const res = await service().executeManualImport(
      ManualImportRequest.parse({ items: [{ path: join(downloads, 'missing.mkv'), mediaType: 'movie', movieId: movie.id }] }),
    );
    expect(res.failed[0]!.error).toMatch(/not found/i);
  });
});

describe('rescan', () => {
  it('adds files found on disk and removes rows whose file vanished', async () => {
    const series = addSeries();
    const [e1, e2] = episodesOf(series.id);
    await mkdir(join(series.path, 'Season 1'), { recursive: true });
    const onDisk = join(series.path, 'Season 1', 'Show Name - S01E02 - Episode 2.mkv');
    await writeFile(onDisk, 'x');
    await writeFile(join(series.path, 'Season 1', 'random.mkv'), 'x');
    const ghost = join(series.path, 'Season 1', 'ghost.mkv');
    libraryService.addMediaFile(db, {
      mediaType: 'series',
      seriesId: series.id,
      seasonNumber: 1,
      episodeIds: [e1!.id],
      relativePath: join('Season 1', 'ghost.mkv'),
      path: ghost,
      sizeBytes: 1,
      quality: { quality: { ...QUALITIES.SDTV, mediaTypes: ['series', 'movie'] }, revision: { version: 1, real: 0, isRepack: false } },
      languages: ['en'],
    });
    const r = await service().rescanSeries(series.id);
    expect(r.removed.map((x) => x.path)).toEqual([ghost]);
    expect(r.added.map((x) => x.path)).toEqual([onDisk]);
    expect(r.unmapped).toEqual([join(series.path, 'Season 1', 'random.mkv')]);
    const eps = episodesOf(series.id);
    expect(eps.find((e) => e.id === e1!.id)!.hasFile).toBe(false);
    expect(eps.find((e) => e.id === e2!.id)!.hasFile).toBe(true);
  });

  it('registers the movie file and skips when the root folder is empty', async () => {
    const movie = addMovie();
    await mkdir(movie.path, { recursive: true });
    await writeFile(join(movie.path, 'Great.Movie.2021.1080p.BluRay.x264-GRP.mkv'), 'x');
    const r = await service().rescanMovie(movie.id);
    expect(r.added).toHaveLength(1);
    expect(libraryService.getMovie(db, movie.id).hasFile).toBe(true);

    await rm(movieRoot, { recursive: true, force: true });
    await mkdir(movieRoot);
    const skipped = await service().rescanMovie(movie.id);
    expect(skipped.removed).toEqual([]);
    expect(libraryService.getMovie(db, movie.id).hasFile).toBe(true);
  });
});

describe('rename', () => {
  it('previews and executes renames of existing files', async () => {
    const series = addSeries();
    const [e1] = episodesOf(series.id);
    const oldPath = join(series.path, 'Season 1', 'show.name.s01e01.720p.hdtv-grp.mkv');
    await mkdir(join(series.path, 'Season 1'), { recursive: true });
    await writeFile(oldPath, 'x');
    const { file } = libraryService.addMediaFile(db, {
      mediaType: 'series',
      seriesId: series.id,
      seasonNumber: 1,
      episodeIds: [e1!.id],
      relativePath: join('Season 1', 'show.name.s01e01.720p.hdtv-grp.mkv'),
      path: oldPath,
      sizeBytes: 1,
      quality: { quality: { ...QUALITIES['HDTV-720p'], mediaTypes: ['series', 'movie'] }, revision: { version: 1, real: 0, isRepack: false } },
      languages: ['en'],
      releaseGroup: 'GRP',
    });
    const svc = service();
    expect(svc.previewRename({ seriesId: series.id })).toEqual([]);
    setSection(db, 'naming', { ...svc.getNaming(), renameEpisodes: true });
    const preview = svc.previewRename({ seriesId: series.id });
    const newRel = join('Season 1', 'Show Name - S01E01 - Episode 1 HDTV-720p.mkv');
    expect(preview).toEqual([expect.objectContaining({ mediaFileId: file.id, existingPath: file.relativePath, newPath: newRel, episodeNumbers: [1] })]);
    const res = await svc.executeRename({ seriesId: series.id });
    expect(res.renamed).toHaveLength(1);
    expect(await exists(join(series.path, newRel))).toBe(true);
    expect(await exists(oldPath)).toBe(false);
    expect(libraryService.getMediaFile(db, file.id).relativePath).toBe(newRel);
    expect(svc.previewRename({ seriesId: series.id })).toEqual([]);
  });
});

describe('routes', () => {
  async function app() {
    const a = Fastify().withTypeProvider<ZodTypeProvider>();
    a.setValidatorCompiler(validatorCompiler);
    a.setSerializerCompiler(serializerCompiler);
    await a.register(importsRoutes(service()), { prefix: '/api/v1' });
    return a;
  }

  it('serves and updates media management and naming settings', async () => {
    const a = await app();
    const get = await a.inject({ method: 'GET', url: '/api/v1/settings/mediamanagement' });
    expect(get.json()).toMatchObject({ recycleBinCleanupDays: 7, useHardlinks: true, episodeTitleRequired: 'always' });
    const put = await a.inject({ method: 'PUT', url: '/api/v1/settings/mediamanagement', payload: { ...get.json<Record<string, unknown>>(), minimumFreeSpaceMb: 500 } });
    expect(put.statusCode).toBe(200);
    expect(put.json().minimumFreeSpaceMb).toBe(500);
    const naming = await a.inject({ method: 'GET', url: '/api/v1/settings/naming' });
    expect(naming.json().renameEpisodes).toBe(false);
    const bad = await a.inject({ method: 'PUT', url: '/api/v1/settings/naming', payload: { ...naming.json<Record<string, unknown>>(), standardEpisodeFormat: '' } });
    expect(bad.statusCode).toBe(400);
    const samples = await a.inject({ method: 'GET', url: '/api/v1/settings/naming/samples' });
    expect(samples.json().singleEpisode.value).toMatch(/S01E01/);
  });

  it('lists the filesystem and validates manual import queries', async () => {
    await put('Folder/file.mkv');
    const a = await app();
    const fs = await a.inject({ method: 'GET', url: `/api/v1/filesystem?path=${encodeURIComponent(downloads)}&includeFiles=true` });
    expect(fs.statusCode).toBe(200);
    expect(fs.json().directories.map((d: { name: string }) => d.name)).toEqual(['Folder']);
    const missing = await a.inject({ method: 'GET', url: `/api/v1/filesystem?path=${encodeURIComponent(join(tmp, 'nope'))}` });
    expect(missing.statusCode).toBe(404);
    const noArgs = await a.inject({ method: 'GET', url: '/api/v1/manualimport' });
    expect(noArgs.statusCode).toBe(400);
    const list = await a.inject({ method: 'GET', url: `/api/v1/manualimport?folder=${encodeURIComponent(join(downloads, 'Folder'))}` });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    const content = await readFile(join(downloads, 'Folder', 'file.mkv'));
    expect(content.length).toBe(64);
  });

  it('creates folders for the path picker and rejects bad names', async () => {
    const a = await app();
    const made = await a.inject({ method: 'POST', url: '/api/v1/filesystem/mkdir', payload: { parent: downloads, name: 'New Folder' } });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({ name: 'New Folder', type: 'directory', path: join(downloads, 'New Folder') });
    expect((await stat(join(downloads, 'New Folder'))).isDirectory()).toBe(true);
    const again = await a.inject({ method: 'POST', url: '/api/v1/filesystem/mkdir', payload: { path: join(downloads, 'New Folder') } });
    expect(again.statusCode).toBe(201);
    const bad = await a.inject({ method: 'POST', url: '/api/v1/filesystem/mkdir', payload: { parent: downloads, name: '../escape' } });
    expect(bad.statusCode).toBe(400);
    const noParent = await a.inject({ method: 'POST', url: '/api/v1/filesystem/mkdir', payload: { parent: join(tmp, 'nope'), name: 'x' } });
    expect(noParent.statusCode).toBe(404);
    const listing = await a.inject({ method: 'GET', url: `/api/v1/filesystem?path=${encodeURIComponent(downloads)}&allowFoldersWithoutTrailingSlashes=true` });
    expect(listing.json().directories.map((d: { name: string }) => d.name)).toContain('New Folder');
  });
});

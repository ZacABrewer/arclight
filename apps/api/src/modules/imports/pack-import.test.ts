import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AddSeriesRequest, QUALITIES, type QueueStatusMessage, type TrackedDownloadState, type TrackedDownloadStatus } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { createTestDb } from '../../db/test-utils.js';
import type { TrackedDownload } from '../download-clients/index.js';
import { libraryService } from '../library/index.js';
import { getSection, setSection } from '../settings/service.js';
import type { ImportedEvent, ImportSkippedEvent } from './deps.js';
import * as tables from './schema.js';
import { ImportsService, isSettledPack, packKindOf, type DownloadClientsPort, type ImportOutcome } from './service.js';
import { parseRelease } from '@arclight/parser';

// Season packs on import: every file maps to its own episodes (multi-season folders, anime
// batches by absolute number and by season name), unwanted and no-better files are skipped,
// and the pack is done with a History row per skipped file.

const NOW = '2024-06-15T12:00:00.000Z';

let tmp: string;
let tvRoot: string;
let downloads: string;
let db: Db;
let fake: FakeDownloads;

class FakeDownloads implements DownloadClientsPort {
  items = new Map<number, TrackedDownload>();
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
    return this.setState(id, 'imported', { statusMessages: [], trackedStatus: 'ok' });
  }
  listTracked(states?: readonly TrackedDownloadState[]) {
    return [...this.items.values()].filter((i) => !states || states.includes(i.trackedState));
  }
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mt-packs-'));
  tvRoot = join(tmp, 'tv');
  downloads = join(tmp, 'downloads');
  for (const d of [tvRoot, downloads]) await mkdir(d, { recursive: true });
  await writeFile(join(tvRoot, '.keep'), '');
  db = await createTestDb(tables);
  await libraryService.addRootFolder(db, { path: tvRoot, mediaType: 'series' });
  // Fixture videos are a few bytes; the implausible-size check would reject them.
  setSection(db, 'mediaManagement', { ...getSection(db, 'mediaManagement'), rejectImplausibleSize: false });
  fake = new FakeDownloads();
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function addSeries(title: string, seasons: number, perSeason: number, seriesType: 'standard' | 'anime' = 'standard', tmdbId = 100) {
  const episodes = [];
  for (let s = 1; s <= seasons; s++) {
    for (let n = 1; n <= perSeason; n++) {
      const day = String(((s - 1) * perSeason + n) % 28 + 1).padStart(2, '0');
      episodes.push({ seasonNumber: s, episodeNumber: n, title: `Episode ${s}x${n}`, airDate: `20${10 + s}-02-${day}`, airDateUtc: `20${10 + s}-02-${day}T20:00:00Z` });
    }
  }
  return libraryService.addSeries(
    db,
    {
      tmdbId,
      title,
      year: 2011,
      status: 'ended',
      runtimeMinutes: seriesType === 'anime' ? 24 : 45,
      originalLanguage: seriesType === 'anime' ? 'ja' : 'en',
      seasons: Array.from({ length: seasons }, (_, i) => ({ seasonNumber: i + 1 })),
      episodes,
    },
    AddSeriesRequest.parse({ tmdbId, rootFolderPath: tvRoot, qualityProfileId: 1, seriesType }),
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
    downloadClientName: 'client',
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

function service(onImport: ImportedEvent[] = [], onSkip: ImportSkippedEvent[] = []) {
  return new ImportsService({
    db,
    downloadClients: fake,
    deps: { history: { recordImport: (e) => void onImport.push(e), recordImportSkipped: (e) => void onSkip.push(e) } },
    now: () => new Date(NOW),
  });
}

const episodesOf = (seriesId: number) => libraryService.listEpisodes(db, { seriesId });
const sxe = (seriesId: number, ids: readonly number[]) =>
  episodesOf(seriesId)
    .filter((e) => ids.includes(e.id))
    .map((e) => `${e.seasonNumber}x${e.episodeNumber}`)
    .sort();

describe('season pack import', () => {
  it('imports a multi-season pack file by file, skipping unwanted and no-better files', async () => {
    const series = addSeries('Show Name', 2, 3);
    const eps = episodesOf(series.id);
    const e = (s: number, n: number) => eps.find((x) => x.seasonNumber === s && x.episodeNumber === n)!;
    // 2x3 is unmonitored; 1x2 is already in the library at the same quality.
    libraryService.setEpisodeMonitored(db, e(2, 3).id, false);
    const existing = join(series.path, 'Season 1', 'Show.Name.S01E02.1080p.BluRay.x264-OLD.mkv');
    await mkdir(join(series.path, 'Season 1'), { recursive: true });
    await writeFile(existing, 'old');
    libraryService.addMediaFile(db, {
      mediaType: 'series',
      seriesId: series.id,
      seasonNumber: 1,
      episodeIds: [e(1, 2).id],
      relativePath: join('Season 1', basename(existing)),
      path: existing,
      sizeBytes: 3,
      quality: { quality: { ...QUALITIES['Bluray-1080p'], mediaTypes: ['series', 'movie'] }, revision: { version: 1, real: 0, isRepack: false } },
      languages: ['en'],
    });

    const name = 'Show.Name.S01-S02.1080p.BluRay.x264-GRP';
    for (const s of [1, 2]) for (const n of [1, 2, 3]) await put(`${name}/Season ${s}/Show.Name.S0${s}E0${n}.1080p.BluRay.x264-GRP.mkv`);
    const imported: ImportedEvent[] = [];
    const skipped: ImportSkippedEvent[] = [];
    const r = await service(imported, skipped).importCompletedDownload(
      tracked({ id: 1, title: name, outputPath: join(downloads, name), mediaType: 'series', seriesId: series.id, episodeIds: eps.map((x) => x.id) }),
    );

    expect(r.verified).toBe(true);
    expect(fake.items.get(1)?.trackedState).toBe('imported');
    expect(sxe(series.id, imported.flatMap((x) => x.episodeIds))).toEqual(['1x1', '1x3', '2x1', '2x2']);
    expect(imported.every((x) => x.releaseType === 'multiSeason')).toBe(true);
    expect(skipped.map((x) => [sxe(series.id, x.episodeIds)[0], x.reasons.map((y) => y.reason)])).toEqual(
      expect.arrayContaining([
        ['1x2', ['packNotUpgrade']],
        ['2x3', ['notWanted']],
      ]),
    );
    expect(skipped).toHaveLength(2);
    expect(r.messages[0]?.messages[0]).toBe('Imported 4 of 6 files; 2 skipped');
    // The library file of 1x2 was kept.
    const files = libraryService.listMediaFiles(db, { seriesId: series.id });
    expect(files.find((f) => f.episodeIds.includes(e(1, 2).id))?.path).toBe(existing);
  });

  it('imports unmonitored episodes from a pack the user grabbed by hand', async () => {
    const series = addSeries('Show Name', 1, 2);
    const eps = episodesOf(series.id);
    libraryService.setEpisodeMonitored(db, eps[0]!.id, false);
    const name = 'Show.Name.S01.720p.WEB-DL-GRP';
    await put(`${name}/Show.Name.S01E01.720p.WEB-DL-GRP.mkv`);
    await put(`${name}/Show.Name.S01E02.720p.WEB-DL-GRP.mkv`);
    const imported: ImportedEvent[] = [];
    const r = await service(imported).importCompletedDownload(
      tracked({
        id: 2,
        title: name,
        outputPath: join(downloads, name),
        mediaType: 'series',
        seriesId: series.id,
        episodeIds: eps.map((x) => x.id),
        grabbedRelease: { title: name, userInvoked: true },
      }),
    );
    expect(r.verified).toBe(true);
    expect(imported).toHaveLength(2);
  });

  it('maps an anime absolute batch across seasons', async () => {
    const series = addSeries('Anime Title', 2, 12, 'anime');
    const name = '[SubGroup] Anime Title (01-24) [1080p] [Batch]';
    for (let n = 1; n <= 24; n++) await put(`${name}/[SubGroup] Anime Title - ${String(n).padStart(2, '0')} [1080p].mkv`);
    const imported: ImportedEvent[] = [];
    const r = await service(imported).importCompletedDownload(
      tracked({ id: 3, title: name, outputPath: join(downloads, name), mediaType: 'series', seriesId: series.id, episodeIds: episodesOf(series.id).map((x) => x.id) }),
    );
    expect(r.verified).toBe(true);
    expect(imported).toHaveLength(24);
    const byFile = new Map(imported.map((x) => [basename(x.sourcePath), sxe(series.id, x.episodeIds)[0]]));
    expect(byFile.get('[SubGroup] Anime Title - 13 [1080p].mkv')).toBe('2x1');
    expect(byFile.get('[SubGroup] Anime Title - 24 [1080p].mkv')).toBe('2x12');
  });

  it('maps files of an anime batch named by its season', async () => {
    const series = addSeries('Anime Title', 2, 3, 'anime');
    const name = '[SubGroup] Anime Title 2nd Season [1080p] [Batch]';
    for (let n = 1; n <= 3; n++) await put(`${name}/[SubGroup] Anime Title 2nd Season - 0${n} [1080p].mkv`);
    const imported: ImportedEvent[] = [];
    const s2 = episodesOf(series.id).filter((x) => x.seasonNumber === 2);
    const r = await service(imported).importCompletedDownload(
      tracked({ id: 4, title: name, outputPath: join(downloads, name), mediaType: 'series', seriesId: series.id, episodeIds: s2.map((x) => x.id) }),
    );
    expect(r.verified).toBe(true);
    expect(sxe(series.id, imported.flatMap((x) => x.episodeIds))).toEqual(['2x1', '2x2', '2x3']);
  });

  it('maps title-less files inside a season pack folder', async () => {
    const series = addSeries('Show Name', 2, 3);
    const name = 'Show.Name.S02.1080p.WEB-DL-GRP';
    for (let n = 1; n <= 3; n++) await put(`${name}/0${n} - Episode Title.mkv`);
    const imported: ImportedEvent[] = [];
    const s2 = episodesOf(series.id).filter((x) => x.seasonNumber === 2);
    const r = await service(imported).importCompletedDownload(
      tracked({ id: 5, title: name, outputPath: join(downloads, name), mediaType: 'series', seriesId: series.id, episodeIds: s2.map((x) => x.id) }),
    );
    expect(r.verified).toBe(true);
    expect(sxe(series.id, imported.flatMap((x) => x.episodeIds))).toEqual(['2x1', '2x2', '2x3']);
  });

  it('imports a multi-episode file of a pack', async () => {
    const series = addSeries('Show Name', 1, 4);
    const name = 'Show.Name.S01.1080p.WEB-DL-GRP';
    await put(`${name}/Show.Name.S01E01E02.1080p.WEB-DL-GRP.mkv`);
    await put(`${name}/Show.Name.S01E03-E04.1080p.WEB-DL-GRP.mkv`);
    const imported: ImportedEvent[] = [];
    const r = await service(imported).importCompletedDownload(
      tracked({ id: 6, title: name, outputPath: join(downloads, name), mediaType: 'series', seriesId: series.id, episodeIds: episodesOf(series.id).map((x) => x.id) }),
    );
    expect(r.verified).toBe(true);
    expect(imported.map((x) => sxe(series.id, x.episodeIds))).toEqual(expect.arrayContaining([['1x1', '1x2'], ['1x3', '1x4']]));
  });
});

describe('pack helpers', () => {
  it('knows a pack from its title or from several videos under a season title', () => {
    expect(packKindOf(parseRelease('Show.Name.S01-S03.1080p.BluRay.x264-GRP', 'series'), 30)).toBe('multiSeason');
    expect(packKindOf(parseRelease('Show.Name.Complete.Series.1080p.BluRay.x264-GRP', 'series'), 30)).toBe('completeSeries');
    expect(packKindOf(parseRelease('Show.Name.S01E01-E06.1080p.WEB-DL-GRP', 'series'), 6)).toBe('episodeRange');
    expect(packKindOf(parseRelease('Show.Name.S01.1080p.WEB-DL-GRP', 'series'), 10)).toBe('season');
    expect(packKindOf(parseRelease('Show.Name.S01E01.1080p.WEB-DL-GRP', 'series'), 1)).toBeNull();
    expect(packKindOf(null, 3)).toBeNull();
  });

  it('settles a pack only when every file has a final outcome', () => {
    const imported: ImportOutcome = { path: '/a', status: 'imported', rejections: [] };
    const skip = (reason: string, type: 'permanent' | 'temporary' = 'permanent'): ImportOutcome => ({
      path: '/b',
      status: 'rejected',
      rejections: [{ reason: reason as never, message: reason, type }],
    });
    expect(isSettledPack([imported, skip('notWanted')], true)).toBe(true);
    expect(isSettledPack([imported, skip('invalidSeasonOrEpisode')], true)).toBe(true);
    expect(isSettledPack([imported, skip('titleMissing', 'temporary')], true)).toBe(false);
    expect(isSettledPack([imported, { path: '/c', status: 'failed', rejections: [], error: 'x' }], true)).toBe(false);
    // Nothing imported: done only when the library needs nothing from any file.
    expect(isSettledPack([skip('packNotUpgrade'), skip('notWanted')], false)).toBe(true);
    expect(isSettledPack([skip('packNotUpgrade'), skip('unknownSeries')], false)).toBe(false);
    expect(isSettledPack([], false)).toBe(false);
  });
});

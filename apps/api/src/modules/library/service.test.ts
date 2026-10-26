import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AddMovieRequest, AddSeriesRequest, QUALITIES, QualityModel, type MonitorOption } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { createTestDb } from '../../db/test-utils.js';
import { LibraryError } from './errors.js';
import * as lib from './schema.js';
import * as svc from './service.js';
import type { EpisodeMetadataInput, MovieMetadataInput, SeriesMetadataInput } from './service.js';

// A fixed "now" so air-date logic is deterministic: 2024-06-15 noon UTC.
const NOW = '2024-06-15T12:00:00.000Z';

let tmp: string;
let tvRoot: string;
let movieRoot: string;
let db: Db;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'arclight-library-'));
  tvRoot = join(tmp, 'tv');
  movieRoot = join(tmp, 'movies');
  await mkdir(tvRoot);
  await mkdir(movieRoot);
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  db = await createTestDb(lib);
  await svc.addRootFolder(db, { path: tvRoot, mediaType: 'series' });
  await svc.addRootFolder(db, { path: movieRoot, mediaType: 'movie' });
});

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

function episode(season: number, number: number, airDateUtc: string | null, extra: Partial<EpisodeMetadataInput> = {}): EpisodeMetadataInput {
  return {
    seasonNumber: season,
    episodeNumber: number,
    title: `S${season}E${number}`,
    airDate: airDateUtc ? airDateUtc.slice(0, 10) : null,
    airDateUtc,
    ...extra,
  };
}

/** Two aired seasons, one season in progress (2 aired, 2 future), plus a special. */
function seriesMeta(overrides: Partial<SeriesMetadataInput> = {}): SeriesMetadataInput {
  return {
    tmdbId: 1001,
    tvdbId: 5001,
    title: 'The Example: Show',
    year: 2022,
    overview: 'An example.',
    status: 'continuing',
    network: 'HBO',
    runtimeMinutes: 45,
    genres: ['Drama'],
    images: [{ coverType: 'poster', url: 'https://img/poster.jpg' }],
    ratings: { tmdb: { votes: 100, value: 8.1 } },
    originalLanguage: 'en',
    seasons: [{ seasonNumber: 0 }, { seasonNumber: 1 }, { seasonNumber: 2 }, { seasonNumber: 3 }],
    episodes: [
      episode(0, 1, '2022-12-25T20:00:00Z'),
      episode(1, 1, '2022-01-01T20:00:00Z'),
      episode(1, 2, '2022-01-08T20:00:00Z'),
      episode(2, 1, '2023-01-01T20:00:00Z'),
      episode(2, 2, '2023-01-08T20:00:00Z'),
      episode(3, 1, '2024-06-01T20:00:00Z'),
      episode(3, 2, '2024-06-08T20:00:00Z'),
      episode(3, 3, '2024-06-22T20:00:00Z'),
      episode(3, 4, null),
    ],
    ...overrides,
  };
}

function addReq(overrides: Partial<AddSeriesRequest> = {}): AddSeriesRequest {
  return AddSeriesRequest.parse({ tmdbId: 1001, rootFolderPath: tvRoot, qualityProfileId: 1, ...overrides });
}

function movieMeta(overrides: Partial<MovieMetadataInput> = {}): MovieMetadataInput {
  return {
    tmdbId: 2001,
    imdbId: 'tt0000001',
    title: 'Example Movie: Part II',
    originalTitle: 'Example Movie: Part II',
    year: 2023,
    overview: 'A movie.',
    status: 'released',
    inCinemas: '2023-05-01',
    digitalRelease: '2023-08-01',
    physicalRelease: '2023-09-01',
    runtimeMinutes: 120,
    studio: 'A24',
    genres: ['Action'],
    images: [],
    ratings: {},
    originalLanguage: 'en',
    ...overrides,
  };
}

function movieReq(overrides: Partial<AddMovieRequest> = {}): AddMovieRequest {
  return AddMovieRequest.parse({ tmdbId: 2001, rootFolderPath: movieRoot, qualityProfileId: 1, ...overrides });
}

const qualityOf = (name: keyof typeof QUALITIES) =>
  QualityModel.parse({ quality: QUALITIES[name], revision: { version: 1, real: 0, isRepack: false } });
const quality = qualityOf('WEBDL-1080p');

function addSeriesWith(option: MonitorOption) {
  return svc.addSeries(db, seriesMeta(), addReq({ monitorOption: option }), NOW);
}

function monitoredKeys(seriesId: number): string[] {
  return svc
    .listEpisodes(db, { seriesId })
    .filter((e) => e.monitored)
    .map((e) => `${e.seasonNumber}x${e.episodeNumber}`);
}

function seasonFlags(seriesId: number): Record<number, boolean> {
  const out: Record<number, boolean> = {};
  for (const s of svc.getSeries(db, seriesId, { includeStatistics: false }).seasons) out[s.seasonNumber] = s.monitored;
  return out;
}

function giveFile(seriesId: number, episodeIds: number[], season: number, size = 1_000_000) {
  return svc.addMediaFile(
    db,
    {
      mediaType: 'series',
      seriesId,
      seasonNumber: season,
      episodeIds,
      relativePath: `Season ${season}/file-${episodeIds.join('-')}.mkv`,
      path: join(tvRoot, 'show', `Season ${season}`, `file-${episodeIds.join('-')}.mkv`),
      sizeBytes: size,
      quality,
      languages: ['en'],
    },
    NOW,
  );
}

// ---------------------------------------------------------------------------------------
// Titles and paths
// ---------------------------------------------------------------------------------------

describe('titles and paths', () => {
  it('builds <root>/<Title (Year)> with filesystem-unsafe characters removed', () => {
    expect(svc.buildMediaFolderName('The Example: Show', 2022)).toBe('The Example - Show (2022)');
    expect(svc.buildMediaFolderName('What/If? <Pilot> *|"', 2020)).toBe('WhatIf Pilot (2020)');
    expect(svc.buildMediaFolderName('Trailing dots...', 2020)).toBe('Trailing dots (2020)');
    expect(svc.buildMediaFolderName('No Year', 0)).toBe('No Year');
    expect(svc.buildMediaPath(tvRoot, 'A  Spaced   Title', 1999)).toBe(join(tvRoot, 'A Spaced Title (1999)'));
  });

  it('derives sort and clean titles', () => {
    expect(svc.toSortTitle('The Example Show')).toBe('example show');
    expect(svc.toSortTitle('An Apple')).toBe('apple');
    expect(svc.toCleanTitle("Marvel's Agents of S.H.I.E.L.D. & Co")).toBe('marvelsagentsofshieldandco');
    expect(svc.toCleanTitle('Café Été')).toBe('cafeete');
  });
});

// ---------------------------------------------------------------------------------------
// Root folders
// ---------------------------------------------------------------------------------------

describe('root folders', () => {
  it('lists registered folders with accessibility and free space', async () => {
    const folders = await svc.listRootFolders(db);
    expect(folders).toHaveLength(2);
    const tv = folders.find((f) => f.mediaType === 'series');
    expect(tv?.path).toBe(tvRoot);
    expect(tv?.accessible).toBe(true);
    expect(typeof tv?.freeSpaceBytes === 'number' || tv?.freeSpaceBytes === null).toBe(true);
  });

  it('rejects relative, missing and nested paths and duplicates', async () => {
    await expect(svc.addRootFolder(db, { path: 'relative/tv', mediaType: 'series' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(svc.addRootFolder(db, { path: join(tmp, 'does-not-exist'), mediaType: 'series' })).rejects.toMatchObject({
      code: 'ROOT_FOLDER_INACCESSIBLE',
    });
    await expect(svc.addRootFolder(db, { path: tvRoot, mediaType: 'movie' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await mkdir(join(tvRoot, 'nested'), { recursive: true });
    await expect(svc.addRootFolder(db, { path: join(tvRoot, 'nested'), mediaType: 'series' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(svc.addRootFolder(db, { path: tmp, mediaType: 'series' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('reports a folder that disappeared as inaccessible and deletes by id', async () => {
    const gone = join(tmp, 'gone');
    await mkdir(gone);
    const folder = await svc.addRootFolder(db, { path: gone, mediaType: 'series' });
    await rm(gone, { recursive: true });
    expect((await svc.getRootFolder(db, folder.id)).accessible).toBe(false);
    svc.deleteRootFolder(db, folder.id);
    expect(() => svc.deleteRootFolder(db, folder.id)).toThrow(LibraryError);
  });
});

// ---------------------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------------------

describe('tags', () => {
  it('creates, normalises, updates and lists tags', () => {
    const a = svc.createTag(db, '  Kids ');
    expect(a.label).toBe('kids');
    expect(() => svc.createTag(db, 'KIDS')).toThrow(/already exists/);
    const b = svc.createTag(db, 'anime');
    expect(svc.listTags(db).map((x) => x.label)).toEqual(['anime', 'kids']);
    expect(svc.updateTag(db, b.id, 'Animation').label).toBe('animation');
    expect(() => svc.updateTag(db, b.id, 'kids')).toThrow(LibraryError);
    expect(() => svc.getTag(db, 999)).toThrow(/not found/);
  });

  it('deleting a tag strips it from series and movies', () => {
    const tag = svc.createTag(db, 'hd');
    const keep = svc.createTag(db, 'keep');
    const s = svc.addSeries(db, seriesMeta(), addReq({ tags: [tag.id, keep.id] }), NOW);
    const m = svc.addMovie(db, movieMeta(), movieReq({ tags: [tag.id] }), NOW);
    svc.deleteTag(db, tag.id);
    expect(svc.getSeries(db, s.id).tags).toEqual([keep.id]);
    expect(svc.getMovie(db, m.id).tags).toEqual([]);
    expect(svc.listTags(db)).toHaveLength(1);
  });

  it('rejects unknown tag ids when adding media', () => {
    expect(() => svc.addSeries(db, seriesMeta(), addReq({ tags: [42] }), NOW)).toThrow(/unknown tag ids: 42/);
  });
});

// ---------------------------------------------------------------------------------------
// Adding series + monitor options
// ---------------------------------------------------------------------------------------

describe('addSeries', () => {
  it('stores metadata, derived titles, path and creates seasons + episodes', () => {
    const s = svc.addSeries(db, seriesMeta(), addReq(), NOW);
    expect(s.path).toBe(join(tvRoot, 'The Example - Show (2022)'));
    expect(s.rootFolderPath).toBe(tvRoot);
    expect(s.sortTitle).toBe('example: show');
    expect(s.cleanTitle).toBe('theexampleshow');
    expect(s.seasons.map((x) => x.seasonNumber)).toEqual([0, 1, 2, 3]);
    expect(s.added).toBe(NOW);
    expect(s.monitored).toBe(true);
    expect(svc.listEpisodes(db, { seriesId: s.id })).toHaveLength(9);
    expect(svc.getEpisode(db, svc.listEpisodes(db, { seriesId: s.id, seasonNumber: 3 })[2]!.id).airDateUtc).toBe('2024-06-22T20:00:00.000Z');
  });

  it('rejects duplicate tmdbId, unknown root folder and wrong media type root folder', () => {
    svc.addSeries(db, seriesMeta(), addReq(), NOW);
    expect(() => svc.addSeries(db, seriesMeta(), addReq(), NOW)).toThrow(/already exists/);
    expect(() => svc.addSeries(db, seriesMeta({ tmdbId: 7 }), addReq({ rootFolderPath: join(tmp, 'nope') }), NOW)).toThrow(/not a registered/);
    expect(() => svc.addSeries(db, seriesMeta({ tmdbId: 7 }), addReq({ rootFolderPath: movieRoot }), NOW)).toThrow(/not a registered series/);
  });

  it('rejects a second series that would share a folder', () => {
    svc.addSeries(db, seriesMeta(), addReq(), NOW);
    expect(() => svc.addSeries(db, seriesMeta({ tmdbId: 8, tvdbId: null }), addReq({ tmdbId: 8 }), NOW)).toThrow(/already uses the path/);
  });

  it('monitorOption=all monitors every regular episode and season, never specials', () => {
    const s = addSeriesWith('all');
    expect(monitoredKeys(s.id)).toEqual(['1x1', '1x2', '2x1', '2x2', '3x1', '3x2', '3x3', '3x4']);
    expect(seasonFlags(s.id)).toEqual({ 0: false, 1: true, 2: true, 3: true });
  });

  it('monitorOption=future monitors unaired and undated episodes; latest season stays monitored', () => {
    const s = addSeriesWith('future');
    expect(monitoredKeys(s.id)).toEqual(['3x3', '3x4']);
    expect(seasonFlags(s.id)).toEqual({ 0: false, 1: false, 2: false, 3: true });
  });

  it('monitorOption=future on an ended show leaves nothing monitored', () => {
    const s = svc.addSeries(
      db,
      seriesMeta({ status: 'ended', episodes: [episode(1, 1, '2020-01-01T00:00:00Z'), episode(1, 2, '2020-01-08T00:00:00Z')], seasons: [{ seasonNumber: 1 }] }),
      addReq({ monitorOption: 'future' }),
      NOW,
    );
    expect(monitoredKeys(s.id)).toEqual([]);
    expect(seasonFlags(s.id)).toEqual({ 1: false });
  });

  it('monitorOption=missing / existing split on file presence', () => {
    const s = addSeriesWith('all');
    const [e1, e2] = svc.listEpisodes(db, { seriesId: s.id, seasonNumber: 1 });
    giveFile(s.id, [e1!.id, e2!.id], 1);
    svc.applyMonitorOption(db, s.id, 'missing', NOW);
    expect(monitoredKeys(s.id)).toEqual(['2x1', '2x2', '3x1', '3x2', '3x3', '3x4']);
    expect(seasonFlags(s.id)[1]).toBe(false);
    svc.applyMonitorOption(db, s.id, 'existing', NOW);
    expect(monitoredKeys(s.id)).toEqual(['1x1', '1x2']);
    expect(seasonFlags(s.id)).toEqual({ 0: false, 1: true, 2: false, 3: false });
  });

  it('monitorOption=firstSeason / latestSeason / pilot', () => {
    const first = addSeriesWith('firstSeason');
    expect(monitoredKeys(first.id)).toEqual(['1x1', '1x2']);
    expect(seasonFlags(first.id)).toEqual({ 0: false, 1: true, 2: false, 3: false });

    const latest = svc.addSeries(db, seriesMeta({ tmdbId: 2, tvdbId: null, title: 'Latest' }), addReq({ tmdbId: 2, monitorOption: 'latestSeason' }), NOW);
    expect(monitoredKeys(latest.id)).toEqual(['3x1', '3x2', '3x3', '3x4']);
    expect(seasonFlags(latest.id)).toEqual({ 0: false, 1: false, 2: false, 3: true });

    const pilot = svc.addSeries(db, seriesMeta({ tmdbId: 3, tvdbId: null, title: 'Pilot' }), addReq({ tmdbId: 3, monitorOption: 'pilot' }), NOW);
    expect(monitoredKeys(pilot.id)).toEqual(['1x1']);
    // Season 1 is deliberately left unmonitored so the rest of it is not wanted.
    expect(seasonFlags(pilot.id)).toEqual({ 0: false, 1: false, 2: false, 3: false });
  });

  it('monitorOption=none unmonitors the series itself and everything in it', () => {
    const s = addSeriesWith('none');
    expect(s.monitored).toBe(false);
    expect(monitoredKeys(s.id)).toEqual([]);
    expect(Object.values(seasonFlags(s.id)).every((v) => v === false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// Episode refresh
// ---------------------------------------------------------------------------------------

describe('refreshEpisodes', () => {
  it('updates metadata but preserves monitored and file state', () => {
    const s = addSeriesWith('all');
    const eps = svc.listEpisodes(db, { seriesId: s.id, seasonNumber: 1 });
    svc.setEpisodeMonitored(db, eps[0]!.id, false);
    giveFile(s.id, [eps[1]!.id], 1);

    const remote = seriesMeta().episodes!.map((e) => ({ ...e, title: `${e.title} (renamed)`, overview: 'new' }));
    const result = svc.refreshEpisodes(db, s.id, remote, NOW);
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(result.updated).toHaveLength(9);

    const after = svc.listEpisodes(db, { seriesId: s.id, seasonNumber: 1 });
    expect(after[0]).toMatchObject({ id: eps[0]!.id, title: 'S1E1 (renamed)', monitored: false, hasFile: false });
    expect(after[1]).toMatchObject({ id: eps[1]!.id, title: 'S1E2 (renamed)', monitored: true, hasFile: true });
    expect(after[1]!.episodeFileId).not.toBeNull();
  });

  it('adds new episodes with the season flag and new seasons per monitorNewItems', () => {
    const s = addSeriesWith('firstSeason'); // seasons 2+ unmonitored
    const remote = [...seriesMeta().episodes!, episode(1, 3, '2022-01-15T20:00:00Z'), episode(2, 3, '2023-01-15T20:00:00Z'), episode(4, 1, null)];
    const result = svc.refreshEpisodes(db, s.id, remote, NOW);
    expect(result.added.map((e) => `${e.seasonNumber}x${e.episodeNumber}:${e.monitored}`)).toEqual(['1x3:true', '2x3:false', '4x1:true']);
    expect(seasonFlags(s.id)[4]).toBe(true);

    svc.updateSeries(db, s.id, { monitorNewItems: 'none' }, NOW);
    const next = svc.refreshEpisodes(db, s.id, [...remote, episode(5, 1, null)], NOW);
    expect(next.added[0]).toMatchObject({ seasonNumber: 5, monitored: false });
    expect(seasonFlags(s.id)[5]).toBe(false);
  });

  it('removes episodes the source dropped, drops emptied seasons and ignores duplicates', () => {
    const s = addSeriesWith('all');
    const remote = seriesMeta().episodes!.filter((e) => e.seasonNumber !== 2);
    const result = svc.refreshEpisodes(db, s.id, [...remote, remote[0]!], NOW);
    expect(result.removed.map((e) => `${e.seasonNumber}x${e.episodeNumber}`)).toEqual(['2x1', '2x2']);
    expect(svc.listEpisodes(db, { seriesId: s.id })).toHaveLength(7);
    expect(Object.keys(seasonFlags(s.id))).toEqual(['0', '1', '3']);
    expect(svc.getSeries(db, s.id).lastRefreshed).toBe(NOW);
  });

  it('refreshSeriesMetadata updates series fields and episodes together', () => {
    const s = addSeriesWith('all');
    const updated = svc.refreshSeriesMetadata(db, s.id, seriesMeta({ title: 'Renamed', status: 'ended', network: 'Netflix' }), NOW);
    expect(updated).toMatchObject({ title: 'Renamed', status: 'ended', network: 'Netflix', cleanTitle: 'renamed' });
    // The folder does not move on rename: that is a user decision carried out by the organizer.
    expect(updated.path).toBe(s.path);
  });
});

// ---------------------------------------------------------------------------------------
// Monitored flags, updates, bulk, delete
// ---------------------------------------------------------------------------------------

describe('series updates', () => {
  it('toggling a season toggles its episodes', () => {
    const s = addSeriesWith('all');
    svc.setSeasonMonitored(db, s.id, 2, false);
    expect(monitoredKeys(s.id)).toEqual(['1x1', '1x2', '3x1', '3x2', '3x3', '3x4']);
    expect(seasonFlags(s.id)[2]).toBe(false);
    expect(() => svc.setSeasonMonitored(db, s.id, 9, true)).toThrow(/not found/);
  });

  it('bulk episode monitoring and single episode toggle', () => {
    const s = addSeriesWith('none');
    const ids = svc.listEpisodes(db, { seriesId: s.id, seasonNumber: 3 }).map((e) => e.id);
    expect(svc.bulkSetEpisodesMonitored(db, ids, true)).toHaveLength(4);
    expect(svc.bulkSetEpisodesMonitored(db, [], true)).toEqual([]);
    expect(svc.setEpisodeMonitored(db, ids[0]!, false).monitored).toBe(false);
    expect(monitoredKeys(s.id)).toEqual(['3x2', '3x3', '3x4']);
    expect(svc.listEpisodes(db, { seriesId: s.id, monitored: true })).toHaveLength(3);
  });

  it('updateSeries patches fields, seasons and recomputes path on root change', async () => {
    const tv2 = join(tmp, 'tv2');
    await mkdir(tv2, { recursive: true });
    await svc.addRootFolder(db, { path: tv2, mediaType: 'series' });
    const s = addSeriesWith('all');
    const u = svc.updateSeries(
      db,
      s.id,
      { qualityProfileId: 5, seriesType: 'anime', seasonFolder: false, rootFolderPath: tv2, seasons: [{ seasonNumber: 1, monitored: false }] },
      NOW,
    );
    expect(u).toMatchObject({ qualityProfileId: 5, seriesType: 'anime', seasonFolder: false, rootFolderPath: tv2 });
    expect(u.path).toBe(join(tv2, 'The Example - Show (2022)'));
    expect(u.seasons.find((x) => x.seasonNumber === 1)?.monitored).toBe(false);
    expect(svc.updateSeries(db, s.id, { path: join(tv2, 'Custom') }, NOW).path).toBe(join(tv2, 'Custom'));
    expect(() => svc.updateSeries(db, 999, { monitored: true }, NOW)).toThrow(/not found/);
  });

  it('bulkUpdateSeries applies shared fields, tag add/remove and a monitor option', () => {
    const a = svc.createTag(db, 'a');
    const b = svc.createTag(db, 'b');
    const s1 = svc.addSeries(db, seriesMeta(), addReq({ tags: [a.id] }), NOW);
    const s2 = svc.addSeries(db, seriesMeta({ tmdbId: 2, tvdbId: null, title: 'Two' }), addReq({ tmdbId: 2, monitorOption: 'none' }), NOW);
    const out = svc.bulkUpdateSeries(
      db,
      { ids: [s1.id, s2.id], qualityProfileId: 9, monitored: true, monitorOption: 'latestSeason', tags: { add: [b.id], remove: [a.id] } },
      NOW,
    );
    expect(out.map((s) => s.qualityProfileId)).toEqual([9, 9]);
    expect(out.map((s) => s.tags)).toEqual([[b.id], [b.id]]);
    expect(out[1]!.monitored).toBe(true);
    expect(monitoredKeys(s2.id)).toEqual(['3x1', '3x2', '3x3', '3x4']);
    expect(() => svc.bulkUpdateSeries(db, { ids: [s1.id, 777], monitored: false }, NOW)).toThrow(/777/);
  });

  it('deleteSeries cascades, optionally removes the folder and records an exclusion', async () => {
    const s = addSeriesWith('all');
    const eps = svc.listEpisodes(db, { seriesId: s.id, seasonNumber: 1 });
    giveFile(s.id, [eps[0]!.id], 1);
    await mkdir(s.path, { recursive: true });
    await writeFile(join(s.path, 'x.mkv'), 'x');

    await svc.deleteSeries(db, s.id, { deleteFiles: true, addExclusion: true });
    expect(() => svc.getSeries(db, s.id)).toThrow(/not found/);
    expect(svc.listEpisodes(db, { seriesId: s.id })).toEqual([]);
    expect(svc.listMediaFiles(db, { seriesId: s.id })).toEqual([]);
    await expect(rm(s.path, { recursive: true })).rejects.toThrow(); // already gone
    expect(svc.isExcluded(db, 'series', 1001)).toBe(true);
    expect(svc.listImportExclusions(db)[0]).toMatchObject({ mediaType: 'series', tmdbId: 1001, title: 'The Example: Show', year: 2022 });
    await expect(svc.deleteSeries(db, s.id)).rejects.toThrow(/not found/);
  });

  it('refuses to delete files when the series path is not inside its root folder', async () => {
    const s = addSeriesWith('all');
    svc.updateSeries(db, s.id, { path: tmp }, NOW);
    await expect(svc.deleteSeries(db, s.id, { deleteFiles: true })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

// ---------------------------------------------------------------------------------------
// Listing + statistics
// ---------------------------------------------------------------------------------------

describe('listing and statistics', () => {
  it('computes season and series statistics', () => {
    const s = addSeriesWith('all');
    const s1 = svc.listEpisodes(db, { seriesId: s.id, seasonNumber: 1 });
    const s3 = svc.listEpisodes(db, { seriesId: s.id, seasonNumber: 3 });
    giveFile(s.id, [s1[0]!.id, s1[1]!.id], 1, 2_000); // one multi-episode file
    giveFile(s.id, [s3[0]!.id], 3, 500);

    const full = svc.getSeries(db, s.id, { now: NOW });
    const stats = full.statistics!;
    // Aired+monitored or has file: 1x1,1x2,2x1,2x2,3x1,3x2 = 6 (3x3 is future, 3x4 undated, special unmonitored).
    expect(stats).toMatchObject({
      seasonCount: 3,
      totalEpisodeCount: 9,
      monitoredEpisodeCount: 8,
      episodeCount: 6,
      episodeFileCount: 3,
      sizeOnDisk: 2_500,
      percentOfEpisodes: 50,
      nextAiring: '2024-06-22T20:00:00.000Z',
      previousAiring: '2024-06-08T20:00:00.000Z',
    });
    const season3 = full.seasons.find((x) => x.seasonNumber === 3)!.statistics!;
    expect(season3).toMatchObject({ episodeCount: 2, episodeFileCount: 1, totalEpisodeCount: 4, sizeOnDisk: 500, percentOfEpisodes: 50 });
    const season1 = full.seasons.find((x) => x.seasonNumber === 1)!.statistics!;
    expect(season1).toMatchObject({ episodeCount: 2, episodeFileCount: 2, percentOfEpisodes: 100, nextAiring: null });
  });

  it('lists series with filters, search, tags and sorting', () => {
    const tag = svc.createTag(db, 't');
    svc.addSeries(db, seriesMeta(), addReq(), NOW);
    svc.addSeries(db, seriesMeta({ tmdbId: 2, tvdbId: null, title: 'Beta', status: 'ended', year: 2010 }), addReq({ tmdbId: 2, monitorOption: 'none', tags: [tag.id] }), NOW);
    svc.addSeries(db, seriesMeta({ tmdbId: 3, tvdbId: null, title: 'Alpha', year: 2015 }), addReq({ tmdbId: 3, qualityProfileId: 2 }), NOW);

    const base = { includeStatistics: false, sortKey: 'sortTitle', sortOrder: 'asc' } as const;
    expect(svc.listSeries(db, { ...base }).map((s) => s.title)).toEqual(['Alpha', 'Beta', 'The Example: Show']);
    expect(svc.listSeries(db, { ...base, sortKey: 'year', sortOrder: 'desc' }).map((s) => s.year)).toEqual([2022, 2015, 2010]);
    expect(svc.listSeries(db, { ...base, monitored: false }).map((s) => s.title)).toEqual(['Beta']);
    expect(svc.listSeries(db, { ...base, status: 'continuing' })).toHaveLength(2);
    expect(svc.listSeries(db, { ...base, qualityProfileId: 2 }).map((s) => s.title)).toEqual(['Alpha']);
    expect(svc.listSeries(db, { ...base, tag: tag.id }).map((s) => s.title)).toEqual(['Beta']);
    expect(svc.listSeries(db, { ...base, search: 'example show' }).map((s) => s.title)).toEqual(['The Example: Show']);
    expect(svc.listSeries(db, { ...base, tmdbId: 3 })).toHaveLength(1);
    expect(svc.listSeries(db, { ...base, includeStatistics: true }, NOW)[0]!.statistics).not.toBeNull();
    expect(svc.listSeries(db, { ...base, search: 'nothing' })).toEqual([]);
    expect(svc.findSeriesByTmdbId(db, 2)?.title).toBe('Beta');
    expect(svc.findSeriesByTmdbId(db, 99)).toBeNull();
  });

  it('library statistics aggregate series, movies, files and root folders', async () => {
    const s = addSeriesWith('all');
    const eps = svc.listEpisodes(db, { seriesId: s.id, seasonNumber: 2 });
    giveFile(s.id, [eps[0]!.id], 2, 100);
    const m = svc.addMovie(db, movieMeta(), movieReq(), NOW);
    svc.addMovie(db, movieMeta({ tmdbId: 2002, title: 'Other' }), movieReq({ tmdbId: 2002, monitored: false }), NOW);
    svc.addMediaFile(db, { mediaType: 'movie', movieId: m.id, relativePath: 'm.mkv', path: join(movieRoot, 'm.mkv'), sizeBytes: 900, quality, languages: ['en'] }, NOW);

    const stats = await svc.getLibraryStatistics(db, NOW);
    expect(stats).toMatchObject({
      seriesCount: 1,
      monitoredSeriesCount: 1,
      continuingSeriesCount: 1,
      endedSeriesCount: 0,
      episodeCount: 6,
      episodeFileCount: 1,
      movieCount: 2,
      monitoredMovieCount: 1,
      movieFileCount: 1,
      sizeOnDisk: 1_000,
    });
    expect(stats.rootFolders).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------
// Movies
// ---------------------------------------------------------------------------------------

describe('movies', () => {
  it('adds a movie with derived titles, path and availability', () => {
    const m = svc.addMovie(db, movieMeta(), movieReq(), NOW);
    expect(m.path).toBe(join(movieRoot, 'Example Movie - Part II (2023)'));
    expect(m).toMatchObject({ sortTitle: 'example movie: part ii', cleanTitle: 'examplemoviepartii', hasFile: false, isAvailable: true, minimumAvailability: 'released' });
    expect(m.statistics).toEqual({ sizeOnDisk: 0, movieFileCount: 0 });
    expect(() => svc.addMovie(db, movieMeta(), movieReq(), NOW)).toThrow(/already exists/);
    expect(() => svc.addMovie(db, movieMeta({ tmdbId: 5 }), movieReq({ tmdbId: 5, rootFolderPath: tvRoot }), NOW)).toThrow(/not a registered movie/);
    expect(svc.findMovieByTmdbId(db, 2001, NOW)?.id).toBe(m.id);
  });

  it('isMovieAvailable follows minimumAvailability, dates and the 90-day cinema window', () => {
    const base = { status: 'announced' as const, inCinemas: null, digitalRelease: null, physicalRelease: null };
    expect(svc.isMovieAvailable({ ...base, minimumAvailability: 'announced' }, NOW)).toBe(true);
    expect(svc.isMovieAvailable({ ...base, minimumAvailability: 'inCinemas' }, NOW)).toBe(false);
    expect(svc.isMovieAvailable({ ...base, minimumAvailability: 'inCinemas', inCinemas: '2024-06-01' }, NOW)).toBe(true);
    expect(svc.isMovieAvailable({ ...base, minimumAvailability: 'inCinemas', inCinemas: '2024-07-01' }, NOW)).toBe(false);
    expect(svc.isMovieAvailable({ ...base, minimumAvailability: 'released', inCinemas: '2024-06-01' }, NOW)).toBe(false);
    expect(svc.isMovieAvailable({ ...base, minimumAvailability: 'released', inCinemas: '2024-01-01' }, NOW)).toBe(true);
    expect(svc.isMovieAvailable({ ...base, minimumAvailability: 'released', inCinemas: '2024-01-01', digitalRelease: '2024-09-01' }, NOW)).toBe(false);
    expect(svc.isMovieAvailable({ ...base, minimumAvailability: 'released', physicalRelease: '2024-06-14' }, NOW)).toBe(true);
    expect(svc.isMovieAvailable({ ...base, status: 'released', minimumAvailability: 'released' }, NOW)).toBe(true);
    expect(svc.isMovieAvailable({ ...base, status: 'deleted', minimumAvailability: 'announced' }, NOW)).toBe(false);
  });

  it('updates, bulk updates and refreshes movies', async () => {
    const other = join(tmp, 'movies2');
    await mkdir(other, { recursive: true });
    await svc.addRootFolder(db, { path: other, mediaType: 'movie' });
    const m1 = svc.addMovie(db, movieMeta(), movieReq(), NOW);
    const m2 = svc.addMovie(db, movieMeta({ tmdbId: 2002, title: 'Second' }), movieReq({ tmdbId: 2002 }), NOW);

    const u = svc.updateMovie(db, m1.id, { monitored: false, minimumAvailability: 'announced', rootFolderPath: other }, NOW);
    expect(u).toMatchObject({ monitored: false, minimumAvailability: 'announced', rootFolderPath: other, path: join(other, 'Example Movie - Part II (2023)') });

    const tag = svc.createTag(db, 'x');
    const bulk = svc.bulkUpdateMovies(db, { ids: [m1.id, m2.id], qualityProfileId: 3, tags: { add: [tag.id] } }, NOW);
    expect(bulk.map((m) => [m.qualityProfileId, m.tags])).toEqual([[3, [tag.id]], [3, [tag.id]]]);

    const refreshed = svc.refreshMovieMetadata(db, m2.id, movieMeta({ tmdbId: 2002, title: 'Second', status: 'released', studio: 'Pixar' }), NOW);
    expect(refreshed).toMatchObject({ studio: 'Pixar', status: 'released', path: m2.path });
    expect(() => svc.updateMovie(db, 404, {}, NOW)).toThrow(/not found/);
  });

  it('lists movies with filters and sorting', () => {
    svc.addMovie(db, movieMeta(), movieReq(), NOW);
    svc.addMovie(db, movieMeta({ tmdbId: 2002, title: 'Aardvark', year: 1999, status: 'announced' }), movieReq({ tmdbId: 2002, monitored: false }), NOW);
    const base = { sortKey: 'sortTitle', sortOrder: 'asc' } as const;
    expect(svc.listMovies(db, base, NOW).map((m) => m.title)).toEqual(['Aardvark', 'Example Movie: Part II']);
    expect(svc.listMovies(db, { ...base, sortKey: 'year', sortOrder: 'desc' }, NOW).map((m) => m.year)).toEqual([2023, 1999]);
    expect(svc.listMovies(db, { ...base, monitored: true }, NOW)).toHaveLength(1);
    expect(svc.listMovies(db, { ...base, status: 'announced' }, NOW).map((m) => m.title)).toEqual(['Aardvark']);
    expect(svc.listMovies(db, { ...base, search: 'part ii' }, NOW)).toHaveLength(1);
    expect(svc.listMovies(db, { ...base, hasFile: true }, NOW)).toEqual([]);
  });

  it('deleteMovie removes the row, its files, optionally the folder, and records an exclusion', async () => {
    const m = svc.addMovie(db, movieMeta(), movieReq(), NOW);
    svc.addMediaFile(db, { mediaType: 'movie', movieId: m.id, relativePath: 'm.mkv', path: join(m.path, 'm.mkv'), sizeBytes: 1, quality, languages: [] }, NOW);
    await mkdir(m.path, { recursive: true });
    await svc.deleteMovie(db, m.id, { deleteFiles: true, addExclusion: true });
    expect(() => svc.getMovie(db, m.id)).toThrow(/not found/);
    expect(svc.listMediaFiles(db, { movieId: m.id })).toEqual([]);
    expect(svc.isExcluded(db, 'movie', 2001)).toBe(true);
    const ex = svc.listImportExclusions(db)[0]!;
    svc.deleteImportExclusion(db, ex.id);
    expect(svc.isExcluded(db, 'movie', 2001)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// Media files
// ---------------------------------------------------------------------------------------

describe('media files', () => {
  it('links a multi-episode file, exposes episodeIds and replaces an upgraded file', () => {
    const s = addSeriesWith('all');
    const [e1, e2] = svc.listEpisodes(db, { seriesId: s.id, seasonNumber: 1 });
    const first = giveFile(s.id, [e1!.id, e2!.id], 1, 10);
    expect(first.file.episodeIds).toEqual([e1!.id, e2!.id]);
    expect(first.replacedFileIds).toEqual([]);
    expect(svc.getEpisode(db, e1!.id)).toMatchObject({ hasFile: true, episodeFileId: first.file.id });

    // Upgrade just episode 1: the old file still covers episode 2 so it stays.
    const second = svc.addMediaFile(db, { mediaType: 'series', seriesId: s.id, seasonNumber: 1, episodeIds: [e1!.id], relativePath: 'S1/e1.mkv', path: join(tvRoot, 'e1.mkv'), sizeBytes: 20, quality, languages: ['en'] }, NOW);
    expect(second.replacedFileIds).toEqual([]);
    expect(svc.getMediaFile(db, first.file.id).episodeIds).toEqual([e2!.id]);

    // Then upgrade episode 2: nothing references the first file any more, so it goes.
    const third = svc.addMediaFile(db, { mediaType: 'series', seriesId: s.id, seasonNumber: 1, episodeIds: [e2!.id], relativePath: 'S1/e2.mkv', path: join(tvRoot, 'e2.mkv'), sizeBytes: 30, quality, languages: ['en'] }, NOW);
    expect(third.replacedFileIds).toEqual([first.file.id]);
    expect(svc.listMediaFiles(db, { seriesId: s.id }).map((f) => f.sizeBytes).sort()).toEqual([20, 30]);
    expect(svc.listMediaFiles(db, { seriesId: s.id, seasonNumber: 1 })).toHaveLength(2);
  });

  it('validates file inputs', () => {
    const s = addSeriesWith('all');
    const other = svc.addSeries(db, seriesMeta({ tmdbId: 2, tvdbId: null, title: 'Other' }), addReq({ tmdbId: 2 }), NOW);
    const foreign = svc.listEpisodes(db, { seriesId: other.id })[1]!.id;
    const base = { relativePath: 'x', path: join(tvRoot, 'x.mkv'), sizeBytes: 1, quality, languages: [] };
    expect(() => svc.addMediaFile(db, { ...base, mediaType: 'series', seriesId: s.id, episodeIds: [] })).toThrow(/at least one episodeId/);
    expect(() => svc.addMediaFile(db, { ...base, mediaType: 'series', seriesId: s.id, episodeIds: [foreign] })).toThrow(/belong to the file/);
    expect(() => svc.addMediaFile(db, { ...base, mediaType: 'series', seriesId: s.id, episodeIds: [9999] })).toThrow(/do not exist/);
    expect(() => svc.addMediaFile(db, { ...base, mediaType: 'movie' })).toThrow(/need movieId/);
    expect(() => svc.addMediaFile(db, { ...base, mediaType: 'movie', movieId: 77 })).toThrow(/not found/);
    const e = svc.listEpisodes(db, { seriesId: s.id })[1]!.id;
    svc.addMediaFile(db, { ...base, mediaType: 'series', seriesId: s.id, episodeIds: [e] });
    expect(() => svc.addMediaFile(db, { ...base, mediaType: 'series', seriesId: s.id, episodeIds: [e] })).toThrow(/already exists at/);
  });

  it('deleting a file clears hasFile on episodes and movies and can remove it from disk', async () => {
    const s = addSeriesWith('all');
    const e = svc.listEpisodes(db, { seriesId: s.id, seasonNumber: 2 })[0]!;
    const { file } = giveFile(s.id, [e.id], 2);
    await svc.deleteMediaFile(db, file.id, { deleteFromDisk: false });
    expect(svc.getEpisode(db, e.id)).toMatchObject({ hasFile: false, episodeFileId: null });

    const m = svc.addMovie(db, movieMeta(), movieReq(), NOW);
    const onDisk = join(movieRoot, 'real.mkv');
    await writeFile(onDisk, 'data');
    const mf = svc.addMediaFile(db, { mediaType: 'movie', movieId: m.id, relativePath: 'real.mkv', path: onDisk, sizeBytes: 4, quality, languages: [] }, NOW);
    expect(svc.getMovie(db, m.id, NOW)).toMatchObject({ hasFile: true, movieFileId: mf.file.id });
    await svc.deleteMediaFile(db, mf.file.id, { deleteFromDisk: true });
    expect(svc.getMovie(db, m.id, NOW)).toMatchObject({ hasFile: false, movieFileId: null });
    await expect(rm(onDisk)).rejects.toThrow();
    await expect(svc.deleteMediaFile(db, mf.file.id)).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------------------
// Wanted
// ---------------------------------------------------------------------------------------

describe('wanted', () => {
  it('missing episodes: monitored, aired, no file, series monitored; specials opt-in; paged', () => {
    const s = addSeriesWith('all');
    const s1 = svc.listEpisodes(db, { seriesId: s.id, seasonNumber: 1 });
    giveFile(s.id, [s1[0]!.id], 1);
    svc.setEpisodeMonitored(db, s1[1]!.id, false);
    const unmonitoredSeries = svc.addSeries(db, seriesMeta({ tmdbId: 2, tvdbId: null, title: 'Off' }), addReq({ tmdbId: 2 }), NOW);
    svc.updateSeries(db, unmonitoredSeries.id, { monitored: false }, NOW);

    const page = svc.listMissingEpisodes(db, { page: 1, pageSize: 50, includeSpecials: false }, NOW);
    // Remaining aired+monitored without file: 2x1, 2x2, 3x1, 3x2 (3x3 future, 3x4 undated).
    expect(page.totalRecords).toBe(4);
    expect(page.records.map((e) => `${e.seasonNumber}x${e.episodeNumber}`)).toEqual(['3x2', '3x1', '2x2', '2x1']);
    expect(page.records[0]).toMatchObject({ seriesTitle: 'The Example: Show', seriesTmdbId: 1001, qualityProfileId: 1 });

    const small = svc.listMissingEpisodes(db, { page: 2, pageSize: 3, includeSpecials: false }, NOW);
    expect(small.records).toHaveLength(1);

    svc.setEpisodeMonitored(db, svc.listEpisodes(db, { seriesId: s.id, seasonNumber: 0 })[0]!.id, true);
    expect(svc.listMissingEpisodes(db, { page: 1, pageSize: 50, includeSpecials: true }, NOW).totalRecords).toBe(5);
    expect(svc.listMissingEpisodes(db, { page: 1, pageSize: 50, includeSpecials: false }, NOW).totalRecords).toBe(4);
  });

  it('cutoff-unmet episodes use the injected cutoff hook', () => {
    const s = addSeriesWith('all');
    const s1 = svc.listEpisodes(db, { seriesId: s.id, seasonNumber: 1 });
    const s2 = svc.listEpisodes(db, { seriesId: s.id, seasonNumber: 2 });
    giveFile(s.id, [s1[0]!.id], 1, 10);
    svc.addMediaFile(db, { mediaType: 'series', seriesId: s.id, seasonNumber: 2, episodeIds: [s2[0]!.id], relativePath: 'hd.mkv', path: join(tvRoot, 'hd.mkv'), sizeBytes: 99, quality: qualityOf('Bluray-2160p'), languages: [] }, NOW);

    const page = svc.listCutoffUnmetEpisodes(db, { page: 1, pageSize: 50, includeSpecials: false }, (f) => f.quality.quality.resolution >= 2160);
    expect(page.records.map((e) => `${e.seasonNumber}x${e.episodeNumber}`)).toEqual(['1x1']);
    expect(svc.listCutoffUnmetEpisodes(db, { page: 1, pageSize: 50, includeSpecials: false }, () => true).totalRecords).toBe(0);
  });

  it('missing and cutoff-unmet movies respect monitored, hasFile and availability', () => {
    const available = svc.addMovie(db, movieMeta(), movieReq(), NOW);
    svc.addMovie(db, movieMeta({ tmdbId: 2002, title: 'Future', status: 'announced', inCinemas: '2025-01-01', digitalRelease: null, physicalRelease: null }), movieReq({ tmdbId: 2002 }), NOW);
    svc.addMovie(db, movieMeta({ tmdbId: 2003, title: 'Unmonitored' }), movieReq({ tmdbId: 2003, monitored: false }), NOW);
    const withFile = svc.addMovie(db, movieMeta({ tmdbId: 2004, title: 'Has File' }), movieReq({ tmdbId: 2004 }), NOW);
    svc.addMediaFile(db, { mediaType: 'movie', movieId: withFile.id, relativePath: 'f.mkv', path: join(movieRoot, 'f.mkv'), sizeBytes: 5, quality, languages: [] }, NOW);

    const missing = svc.listMissingMovies(db, { page: 1, pageSize: 10 }, NOW);
    expect(missing.records.map((m) => m.id)).toEqual([available.id]);

    const unmet = svc.listCutoffUnmetMovies(db, { page: 1, pageSize: 10 }, (f) => f.quality.quality.resolution >= 2160, NOW);
    expect(unmet.records.map((m) => m.id)).toEqual([withFile.id]);
    expect(unmet.records[0]!.statistics).toEqual({ sizeOnDisk: 5, movieFileCount: 1 });
    expect(svc.listCutoffUnmetMovies(db, { page: 1, pageSize: 10 }, () => true, NOW).totalRecords).toBe(0);
  });
});

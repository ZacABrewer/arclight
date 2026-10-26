import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRelease } from '@arclight/parser';
import {
  MediaManagementSettings,
  NAMING_DEFAULTS,
  QUALITIES,
  type Episode,
  type MediaFile,
  type Movie,
  type QualityDefinition,
  type QualityModel,
  type Series,
} from '@arclight/shared';
import { evaluate, orderForImport, readGrabbedRelease, type DecisionContext, type LocalItem } from './decisions.js';

const NOW = new Date('2024-06-15T12:00:00.000Z');
const ROOT = join(process.platform === 'win32' ? 'C:\\' : '/', 'media');

function q(def: QualityDefinition, version = 1): QualityModel {
  return { quality: { ...def, mediaTypes: [...def.mediaTypes] }, revision: { version, real: 0, isRepack: false } };
}

const series: Series = {
  id: 1,
  tmdbId: 10,
  title: 'Show Name',
  sortTitle: 'show name',
  cleanTitle: 'showname',
  year: 2020,
  overview: '',
  status: 'continuing',
  runtimeMinutes: 45,
  genres: [],
  images: [],
  ratings: {},
  originalLanguage: 'en',
  path: join(ROOT, 'tv', 'Show Name (2020)'),
  rootFolderPath: join(ROOT, 'tv'),
  qualityProfileId: 1,
  monitored: true,
  monitorNewItems: 'all',
  seriesType: 'standard',
  seasonFolder: true,
  useSceneNumbering: false,
  tags: [],
  added: NOW.toISOString(),
  seasons: [],
};

function ep(id: number, n: number, extra: Partial<Episode> = {}): Episode {
  return {
    id,
    seriesId: 1,
    seasonNumber: 1,
    episodeNumber: n,
    title: `Episode ${n}`,
    overview: '',
    airDate: '2020-01-01',
    airDateUtc: '2020-01-01T20:00:00Z',
    monitored: true,
    hasFile: false,
    unverifiedSceneNumbering: false,
    ...extra,
  };
}

function file(id: number, quality: QualityModel, episodeIds: number[] = [11]): MediaFile {
  return {
    id,
    mediaType: 'series',
    seriesId: 1,
    seasonNumber: 1,
    episodeIds,
    relativePath: 'Season 1/old.mkv',
    path: join(series.path, 'Season 1', 'old.mkv'),
    sizeBytes: 1,
    dateAdded: NOW.toISOString(),
    quality,
    languages: ['en'],
  };
}

function item(extra: Partial<LocalItem> = {}): LocalItem {
  const path = join(ROOT, 'downloads', 'Show.Name.S01E01.1080p.WEB-DL-GRP', 'Show.Name.S01E01.1080p.WEB-DL-GRP.mkv');
  return {
    path,
    sizeBytes: 1000,
    extension: '.mkv',
    mtimeMs: 0,
    mediaType: 'series',
    parsed: parseRelease('Show.Name.S01E01.1080p.WEB-DL-GRP.mkv', 'series'),
    quality: q(QUALITIES['WEBDL-1080p']),
    languages: ['en'],
    releaseGroup: 'GRP',
    series,
    episodes: [ep(11, 1)],
    parsedEpisodeCount: 1,
    existingFile: false,
    existingFiles: [],
    formatScore: 0,
    existingFormatScores: {},
    runtimeSeconds: undefined,
    ...extra,
  };
}

function ctx(extra: Partial<DecisionContext> = {}): DecisionContext {
  return {
    settings: MediaManagementSettings.parse({}),
    naming: NAMING_DEFAULTS,
    profile: null,
    freeSpaceBytes: null,
    grab: null,
    alreadyImported: false,
    seriesEpisodes: [ep(11, 1)],
    videoCount: 1,
    libraryPaths: new Set(),
    platform: 'linux',
    now: NOW,
    ...extra,
  };
}

const reasons = (i: LocalItem, c: DecisionContext = ctx()) => evaluate(i, c).rejections.map((r) => r.reason);

describe('decision engine', () => {
  it('approves a clean episode file', () => {
    const d = evaluate(item(), ctx());
    expect(d.rejections).toEqual([]);
    expect(d.approved).toBe(true);
  });

  it('rejects for free space only when the check is enabled and space is known', () => {
    expect(reasons(item(), ctx({ freeSpaceBytes: 10 }))).toContain('minimumFreeSpace');
    expect(reasons(item(), ctx({ freeSpaceBytes: 200 * 1024 * 1024 }))).not.toContain('minimumFreeSpace');
    const skip = ctx({ freeSpaceBytes: 10, settings: MediaManagementSettings.parse({ skipFreeSpaceCheck: true }) });
    expect(reasons(item(), skip)).not.toContain('minimumFreeSpace');
    expect(reasons(item({ existingFile: true }), ctx({ freeSpaceBytes: 10 }))).not.toContain('minimumFreeSpace');
  });

  it('rejects samples by name and by probed runtime', () => {
    expect(reasons(item({ path: join(ROOT, 'dl', 'show.s01e01.sample.mkv') }))).toContain('sample');
    expect(reasons(item({ runtimeSeconds: 60 }))).toContain('sample');
    expect(reasons(item({ runtimeSeconds: null }))).toContain('sampleIndeterminate');
    expect(reasons(item({ runtimeSeconds: 45 * 60 }))).not.toContain('sample');
  });

  it('rejects files still being unpacked', () => {
    const r = evaluate(item({ path: join(ROOT, 'dl', '_UNPACK_Show', 'Show.S01E01.mkv') }), ctx());
    expect(r.rejections.find((x) => x.reason === 'unpacking')?.type).toBe('temporary');
  });

  it('rejects unsupported, dangerous and executable extensions', () => {
    expect(reasons(item({ path: join(ROOT, 'dl', 'a.txt'), extension: '.txt' }))).toContain('unsupportedExtension');
    expect(reasons(item({ path: join(ROOT, 'dl', 'a.scr'), extension: '.scr' }))).toContain('dangerousFile');
    expect(reasons(item({ path: join(ROOT, 'dl', 'a.exe'), extension: '.exe' }))).toContain('executableFile');
    expect(reasons(item({ path: join(ROOT, 'dl', '._a.mkv') }))).toContain('invalidFilePath');
  });

  it('rejects relative paths', () => {
    expect(reasons(item({ path: 'dl/Show.S01E01.mkv' }))).toContain('invalidFilePath');
  });

  it('rejects episodes outside the grabbed release, and another series', () => {
    expect(reasons(item(), ctx({ grab: { episodeIds: [99] } }))).toContain('notFoundInRelease');
    expect(reasons(item(), ctx({ grab: { episodeIds: [11] } }))).not.toContain('notFoundInRelease');
    expect(reasons(item(), ctx({ grab: { seriesId: 2 } }))).toContain('notFoundInRelease');
  });

  it('rejects a movie that is not the grabbed one', () => {
    const movie = { id: 5, title: 'M', year: 2020, runtimeMinutes: 100, path: join(ROOT, 'm', 'M'), rootFolderPath: join(ROOT, 'm') } as Movie;
    const m = item({ mediaType: 'movie', series: undefined, episodes: [], movie, parsed: parseRelease('M.2020.1080p.mkv', 'movie') });
    expect(reasons(m, ctx({ grab: { movieId: 6 } }))).toContain('notFoundInRelease');
    expect(reasons(m, ctx({ grab: { movieId: 5 } }))).toEqual([]);
  });

  it('judges upgrades against existing files (quality, revision, custom format score)', () => {
    const better = file(7, q(QUALITIES['HDTV-720p']));
    expect(reasons(item({ existingFiles: [better] }))).toEqual([]);
    const worse = file(7, q(QUALITIES['Bluray-1080p']));
    expect(reasons(item({ existingFiles: [worse] }))).toContain('notQualityUpgrade');
    const proper = file(7, q(QUALITIES['WEBDL-1080p'], 2));
    expect(reasons(item({ existingFiles: [proper] }))).toContain('notRevisionUpgrade');
    const noPrefer = ctx({ settings: MediaManagementSettings.parse({ downloadPropersAndRepacks: 'doNotPrefer' }) });
    expect(reasons(item({ existingFiles: [proper] }), noPrefer)).not.toContain('notRevisionUpgrade');
    const same = file(7, q(QUALITIES['WEBDL-1080p']));
    expect(reasons(item({ existingFiles: [same], existingFormatScores: { 7: 100 }, formatScore: 50 }))).toContain('notCustomFormatUpgrade');
    expect(reasons(item({ existingFiles: [same] }))).toEqual([]);
  });

  it('rejects a file already registered in the library and already-imported downloads', () => {
    const i = item();
    expect(reasons(i, ctx({ libraryPaths: new Set([i.path]) }))).toContain('sameFile');
    const withFile = item({ existingFiles: [file(7, q(QUALITIES['HDTV-720p']))] });
    expect(reasons(withFile, ctx({ alreadyImported: true }))).toContain('alreadyImported');
    expect(reasons(item(), ctx({ alreadyImported: true }))).not.toContain('alreadyImported');
  });

  it('rejects an episode count mismatch and an existing file covering more episodes', () => {
    expect(reasons(item({ parsedEpisodeCount: 2 }))).toContain('episodeCountMismatch');
    expect(reasons(item({ existingFiles: [file(7, q(QUALITIES['HDTV-720p']), [11, 12])] }))).toContain('existingFileHasMoreEpisodes');
  });

  it('rejects full-season single files, multi-season packs and split episodes', () => {
    const full = parseRelease('Show.Name.S01.1080p.WEB-DL-GRP', 'series');
    expect(full.series?.fullSeason).toBe(true);
    expect(reasons(item({ parsed: full, episodes: [] }))).toContain('fullSeason');
    const parsed = parseRelease('Show.Name.S01E01.1080p.WEB-DL-GRP.mkv', 'series');
    expect(reasons(item({ parsed: { ...parsed, series: { ...parsed.series!, isMultiSeason: true } } }))).toContain('multiSeason');
    expect(reasons(item({ parsed: { ...parsed, series: { ...parsed.series!, isSplitEpisode: true } } }))).toContain('splitEpisode');
  });

  it('rejects unknown episodes and unparseable files', () => {
    expect(reasons(item({ episodes: [] }))).toContain('invalidSeasonOrEpisode');
    expect(reasons(item({ series: undefined, episodes: [], parsed: null }))).toContain('unableToParse');
    expect(reasons(item({ series: undefined, episodes: [] }))).toContain('unknownSeries');
  });

  it('rejects unverified scene numbering', () => {
    expect(reasons(item({ episodes: [ep(11, 1, { unverifiedSceneNumbering: true })] }))).toContain('unverifiedSceneMapping');
  });

  it('requires an episode title only when renaming uses it and the episode aired recently', () => {
    const naming = { ...NAMING_DEFAULTS, renameEpisodes: true };
    const recent = ep(11, 1, { title: '', airDate: '2024-06-15', airDateUtc: '2024-06-15T01:00:00Z' });
    expect(reasons(item({ episodes: [recent] }), ctx({ naming }))).toContain('titleMissing');
    expect(reasons(item({ episodes: [{ ...recent, title: 'TBA' }] }), ctx({ naming }))).toContain('titleTba');
    // Rename off: title not needed.
    expect(reasons(item({ episodes: [recent] }), ctx())).not.toContain('titleMissing');
    // Aired long ago: exempt.
    expect(reasons(item({ episodes: [ep(11, 1, { title: '' })] }), ctx({ naming }))).not.toContain('titleMissing');
    const never = ctx({ naming, settings: MediaManagementSettings.parse({ episodeTitleRequired: 'never' }) });
    expect(reasons(item({ episodes: [recent] }), never)).not.toContain('titleMissing');
    // Bulk-season mode: a lone release is exempt; a bulk drop (4+ same day) is checked.
    const bulk = ctx({ naming, settings: MediaManagementSettings.parse({ episodeTitleRequired: 'bulkSeasonReleases' }) });
    expect(reasons(item({ episodes: [recent] }), { ...bulk, seriesEpisodes: [recent] })).not.toContain('titleMissing');
    const drop = [1, 2, 3, 4].map((n) => ({ ...recent, id: 10 + n, episodeNumber: n }));
    expect(reasons(item({ episodes: [recent] }), { ...bulk, seriesEpisodes: drop })).toContain('titleMissing');
  });

  it('collects every rejection instead of stopping at the first', () => {
    const d = evaluate(item({ path: join(ROOT, 'dl', 'Show.sample.mkv'), episodes: [ep(11, 1, { unverifiedSceneNumbering: true })] }), ctx({ freeSpaceBytes: 0 }));
    expect(d.rejections.map((r) => r.reason)).toEqual(expect.arrayContaining(['sample', 'unverifiedSceneMapping', 'minimumFreeSpace']));
  });

  it('orders decisions by quality then size', () => {
    const a = evaluate(item({ quality: q(QUALITIES['HDTV-720p']), sizeBytes: 5 }), ctx());
    const b = evaluate(item({ quality: q(QUALITIES['Bluray-1080p']), sizeBytes: 1 }), ctx());
    const c = evaluate(item({ quality: q(QUALITIES['Bluray-1080p']), sizeBytes: 9 }), ctx());
    expect(orderForImport([a, b, c], null).map((d) => d.item.sizeBytes)).toEqual([9, 1, 5]);
  });

  it('reads the grabbed release snapshot tolerantly', () => {
    expect(readGrabbedRelease(null)).toBeNull();
    const g = readGrabbedRelease({ title: 'X', seriesId: 1, episodeIds: [1, 2], quality: { quality: { id: 3 }, revision: { version: 2 } } });
    expect(g).toMatchObject({ title: 'X', seriesId: 1, episodeIds: [1, 2] });
    expect(g?.quality?.quality.name).toBe('WEBDL-1080p');
    expect(g?.quality?.revision.version).toBe(2);
  });
});

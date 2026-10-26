import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AddMovieRequest, AddSeriesRequest, MediaVersions, UpdateMovieRequest, type MediaVersion, type QualityName } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { createTestDb } from '../../db/test-utils.js';
import { HD_ALLOWED, makeProfile, quality } from '../releases/test-support.js';
import { createCutoffChecker } from './cutoff.js';
import * as lib from './schema.js';
import * as svc from './service.js';
import { pickVersion, primaryOf, slotOf, upsertVersion } from './versions.js';

// Multi-version library: one file per (item, version slot), each slot judged against its own
// profile. Profile 1 = HD (1080p cutoff), profile 2 = UHD (2160p only, Remux cutoff).

const NOW = '2024-06-15T12:00:00.000Z';
const UHD_ALLOWED: QualityName[] = ['WEBDL-2160p', 'WEBRip-2160p', 'Bluray-2160p', 'Remux-2160p'];
const HD = makeProfile(HD_ALLOWED, { id: 1, name: 'HD' }, 'Bluray-1080p');
const UHD = makeProfile(UHD_ALLOWED, { id: 2, name: 'UHD' }, 'Remux-2160p');
const PROFILES = new Map([
  [1, HD],
  [2, UHD],
]);
const TWO: MediaVersion[] = [
  { tag: '1080p', qualityProfileId: 1, enabled: true },
  { tag: '4K', qualityProfileId: 2, enabled: true },
];

let tmp: string;
let tvRoot: string;
let movieRoot: string;
let db: Db;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'arclight-versions-'));
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

function addMovie(versions?: MediaVersion[] | null, tmdbId = 200) {
  return svc.addMovie(
    db,
    { tmdbId, title: `Movie ${tmdbId}`, year: 2021, status: 'released', digitalRelease: '2021-01-01', originalLanguage: 'en' },
    AddMovieRequest.parse({ tmdbId, rootFolderPath: movieRoot, qualityProfileId: 1, ...(versions !== undefined ? { versions } : {}) }),
    NOW,
  );
}

function addSeries(versions?: MediaVersion[] | null) {
  return svc.addSeries(
    db,
    {
      tmdbId: 100,
      title: 'Show',
      year: 2020,
      status: 'continuing',
      seasons: [{ seasonNumber: 1 }],
      episodes: [1, 2].map((n) => ({ seasonNumber: 1, episodeNumber: n, title: `E${n}`, airDateUtc: `2020-01-0${n}T20:00:00Z` })),
    },
    AddSeriesRequest.parse({ tmdbId: 100, rootFolderPath: tvRoot, qualityProfileId: 1, ...(versions !== undefined ? { versions } : {}) }),
    NOW,
  );
}

let pathSeq = 0;
function movieFile(movieId: number, q: QualityName, versionTag?: string | null) {
  const name = `m${movieId}-${q}-${pathSeq++}.mkv`;
  return svc.addMediaFile(
    db,
    {
      mediaType: 'movie',
      movieId,
      relativePath: name,
      path: join(movieRoot, name),
      sizeBytes: 1000,
      quality: quality(q),
      languages: ['en'],
      ...(versionTag !== undefined ? { versionTag } : {}),
    },
    NOW,
  );
}

function episodeFile(seriesId: number, episodeIds: number[], q: QualityName, versionTag?: string | null) {
  const name = `s${seriesId}-${episodeIds.join('-')}-${q}-${pathSeq++}.mkv`;
  return svc.addMediaFile(
    db,
    {
      mediaType: 'series',
      seriesId,
      seasonNumber: 1,
      episodeIds,
      relativePath: name,
      path: join(tvRoot, name),
      sizeBytes: 500,
      quality: quality(q),
      languages: ['en'],
      ...(versionTag !== undefined ? { versionTag } : {}),
    },
    NOW,
  );
}

const checker = () => createCutoffChecker(db, { listQualityProfiles: () => [HD, UHD], listCustomFormats: () => [] });

describe('version helpers (pure)', () => {
  it('picks the 4K slot for a 2160p release and the 1080p slot for a 1080p one', () => {
    expect(pickVersion(TWO, PROFILES, quality('Remux-2160p'))?.tag).toBe('4K');
    expect(pickVersion(TWO, PROFILES, quality('WEBDL-2160p'))?.tag).toBe('4K');
    expect(pickVersion(TWO, PROFILES, quality('WEBDL-1080p'))?.tag).toBe('1080p');
  });

  it('a language fit ranks first: a slot asking for audio the release has wins over an equal-profile slot', () => {
    const versions: MediaVersion[] = [
      { tag: 'Standard', qualityProfileId: 1, enabled: true },
      { tag: 'Spanish', qualityProfileId: 1, enabled: true, audioLanguages: ['es'] },
    ];
    const fit = (have: string[]) => (v: MediaVersion) => ((v.audioLanguages ?? []).length === 0 ? 1 : v.audioLanguages!.every((l) => have.includes(l)) ? 2 : 0);
    expect(pickVersion(versions, PROFILES, quality('WEBDL-1080p'))?.tag).toBe('Standard');
    expect(pickVersion(versions, PROFILES, quality('WEBDL-1080p'), () => 0, fit(['es']))?.tag).toBe('Spanish');
    expect(pickVersion(versions, PROFILES, quality('WEBDL-1080p'), () => 0, fit(['en']))?.tag).toBe('Standard');
    expect(upsertVersion({ qualityProfileId: 1, versions }, { tag: 'spanish', qualityProfileId: 2, enabled: true, audioLanguages: ['es'] })[1]).toEqual({
      tag: 'Spanish',
      qualityProfileId: 2,
      enabled: true,
      audioLanguages: ['es'],
    });
  });

  it('prefers the profile whose cutoff is nearest when several allow the quality', () => {
    const wide = makeProfile([...HD_ALLOWED, ...UHD_ALLOWED], { id: 3 }, 'Remux-2160p');
    const versions: MediaVersion[] = [
      { tag: '4K', qualityProfileId: 3, enabled: true },
      { tag: 'HD', qualityProfileId: 1, enabled: true },
    ];
    const profiles = new Map([...PROFILES, [3, wide]]);
    expect(pickVersion(versions, profiles, quality('Bluray-1080p'))?.tag).toBe('HD');
    expect(pickVersion(versions, profiles, quality('Bluray-2160p'))?.tag).toBe('4K');
  });

  it('ignores disabled slots and falls back to the first enabled slot when nothing allows the quality', () => {
    const versions: MediaVersion[] = [
      { tag: '1080p', qualityProfileId: 1, enabled: true },
      { tag: '4K', qualityProfileId: 2, enabled: false },
    ];
    expect(pickVersion(versions, PROFILES, quality('Remux-2160p'))?.tag).toBe('1080p');
    expect(pickVersion(TWO, PROFILES, quality('HDTV-2160p'))?.tag).toBe('1080p');
  });

  it('returns null for unversioned items and breaks ties by format score', () => {
    expect(pickVersion(null, PROFILES, quality('WEBDL-1080p'))).toBeNull();
    expect(pickVersion([], PROFILES, quality('WEBDL-1080p'))).toBeNull();
    const twins: MediaVersion[] = [
      { tag: 'A', qualityProfileId: 1, enabled: true },
      { tag: 'B', qualityProfileId: 4, enabled: true },
    ];
    const profiles = new Map([...PROFILES, [4, { ...HD, id: 4 }]]);
    expect(pickVersion(twins, profiles, quality('WEBDL-1080p'), (p) => (p.id === 4 ? 50 : 0))?.tag).toBe('B');
  });

  it('maps untagged files to the first slot and tags case-insensitively', () => {
    expect(slotOf(null, TWO)).toBe('1080p');
    expect(slotOf(null, null)).toBeNull();
    expect(slotOf('4k', TWO)).toBe('4K');
    expect(slotOf('Remux', TWO)).toBe('Remux');
  });

  it('upserts a 4K slot next to a Standard slot for an unversioned item', () => {
    expect(upsertVersion({ qualityProfileId: 1, versions: null }, { tag: '4K', qualityProfileId: 2, enabled: true })).toEqual([
      { tag: 'Standard', qualityProfileId: 1, enabled: true },
      { tag: '4K', qualityProfileId: 2, enabled: true },
    ]);
    expect(upsertVersion({ qualityProfileId: 1, versions: TWO }, { tag: '4k', qualityProfileId: 9, enabled: false })).toEqual([
      TWO[0],
      { tag: '4K', qualityProfileId: 9, enabled: false },
    ]);
  });

  it('chooses the unversioned file as primary, then config order', () => {
    const files = [
      { id: 5, versionTag: '4K' },
      { id: 6, versionTag: '1080p' },
    ];
    expect(primaryOf(files, TWO)?.id).toBe(6);
    expect(primaryOf([...files, { id: 9, versionTag: null }], TWO)?.id).toBe(9);
  });

  it('validates the versions contract: unique tags, no path characters', () => {
    expect(MediaVersions.safeParse(TWO).success).toBe(true);
    expect(MediaVersions.safeParse([...TWO, { tag: '4k', qualityProfileId: 2 }]).success).toBe(false);
    expect(MediaVersions.safeParse([{ tag: 'a/b', qualityProfileId: 1 }]).success).toBe(false);
  });
});

describe('two-version movie', () => {
  it('keeps one file per slot and exposes files[] with tags', () => {
    const movie = addMovie(TWO);
    expect(movie.versions).toEqual(TWO);
    movieFile(movie.id, 'Bluray-1080p', '1080p');
    movieFile(movie.id, 'Remux-2160p', '4K');
    const m = svc.getMovie(db, movie.id, NOW);
    expect(m.hasFile).toBe(true);
    expect(m.files!.map((f) => f.versionTag).sort()).toEqual(['1080p', '4K']);
    expect(m.statistics?.movieFileCount).toBe(2);
    // The primary pointer is the first configured version.
    expect(m.files![0]!.versionTag).toBe('1080p');
    expect(m.movieFileId).toBe(m.files![0]!.id);
  });

  it('an upgrade replaces only its own slot', () => {
    const movie = addMovie(TWO);
    const hd = movieFile(movie.id, 'WEBDL-1080p', '1080p').file;
    const uhd = movieFile(movie.id, 'WEBDL-2160p', '4K').file;
    const up = movieFile(movie.id, 'Remux-2160p', '4K');
    expect(up.replacedFileIds).toEqual([uhd.id]);
    const files = svc.listMediaFiles(db, { movieId: movie.id });
    expect(files.map((f) => f.id).sort()).toEqual([hd.id, up.file.id].sort());
    expect(files.find((f) => f.versionTag === '4K')!.quality.quality.name).toBe('Remux-2160p');
  });

  it('an untagged file on a versioned movie fills (and is stored in) the first slot', () => {
    const movie = addMovie(TWO);
    const { file } = movieFile(movie.id, 'WEBDL-1080p');
    expect(file.versionTag).toBe('1080p');
    const again = movieFile(movie.id, 'Bluray-1080p');
    expect(again.replacedFileIds).toEqual([file.id]);
  });

  it('a legacy untagged file survives a 4K import and is replaced by a slot-1 import', () => {
    const movie = addMovie(null);
    const legacy = movieFile(movie.id, 'WEBDL-1080p').file;
    expect(legacy.versionTag).toBeNull();
    svc.updateMovie(db, movie.id, UpdateMovieRequest.parse({ versions: TWO }), NOW);
    const uhd = movieFile(movie.id, 'Remux-2160p', '4K');
    expect(uhd.replacedFileIds).toEqual([]);
    expect(svc.getMovie(db, movie.id, NOW).movieFileId).toBe(legacy.id);
    const hd = movieFile(movie.id, 'Bluray-1080p', '1080p');
    expect(hd.replacedFileIds).toEqual([legacy.id]);
    expect(svc.listMediaFiles(db, { movieId: movie.id }).map((f) => f.versionTag).sort()).toEqual(['1080p', '4K']);
  });

  it('deleting a version re-points the movie at the remaining one; deleting the last clears hasFile', async () => {
    const movie = addMovie(TWO);
    const hd = movieFile(movie.id, 'Bluray-1080p', '1080p').file;
    const uhd = movieFile(movie.id, 'Remux-2160p', '4K').file;
    await svc.deleteMediaFile(db, hd.id);
    let m = svc.getMovie(db, movie.id, NOW);
    expect(m).toMatchObject({ hasFile: true, movieFileId: uhd.id });
    await svc.deleteMediaFile(db, uhd.id);
    m = svc.getMovie(db, movie.id, NOW);
    expect(m).toMatchObject({ hasFile: false, movieFileId: null });
  });

  it('the database refuses a second file in the same (movie, version) slot', () => {
    const movie = addMovie(TWO);
    const { file } = movieFile(movie.id, 'Bluray-1080p', '1080p');
    const { id: _id, ...row } = db.select().from(lib.mediaFiles).all().find((f) => f.id === file.id)!;
    expect(() => db.insert(lib.mediaFiles).values({ ...row, path: '/elsewhere.mkv' }).run()).toThrow(/UNIQUE/);
  });

  it('missing / cutoff lists are computed per version', () => {
    const movie = addMovie(TWO);
    let missing = svc.listMissingMovies(db, { page: 1, pageSize: 50 }, NOW);
    expect(missing.records[0]).toMatchObject({ id: movie.id, wantedVersions: ['1080p', '4K'] });
    movieFile(movie.id, 'Bluray-1080p', '1080p');
    missing = svc.listMissingMovies(db, { page: 1, pageSize: 50 }, NOW);
    expect(missing.records[0]!.wantedVersions).toEqual(['4K']);
    // A 2160p WEB file is below the UHD cutoff (Remux) but the 1080p Bluray meets HD's.
    movieFile(movie.id, 'WEBDL-2160p', '4K');
    expect(svc.listMissingMovies(db, { page: 1, pageSize: 50 }, NOW).totalRecords).toBe(0);
    const unmet = svc.listCutoffUnmetMovies(db, { page: 1, pageSize: 50 }, checker(), NOW);
    expect(unmet.records.map((m) => m.wantedVersions)).toEqual([['4K']]);
  });

  it('a disabled version is neither missing nor cutoff-unmet', () => {
    const movie = addMovie([TWO[0]!, { ...TWO[1]!, enabled: false }]);
    movieFile(movie.id, 'Bluray-1080p', '1080p');
    movieFile(movie.id, 'WEBDL-2160p', '4K');
    expect(svc.listMissingMovies(db, { page: 1, pageSize: 50 }, NOW).totalRecords).toBe(0);
    expect(svc.listCutoffUnmetMovies(db, { page: 1, pageSize: 50 }, checker(), NOW).totalRecords).toBe(0);
  });

  it('judges each version file against its own profile', () => {
    const movie = addMovie(TWO);
    const hd = movieFile(movie.id, 'Bluray-1080p', '1080p').file;
    const uhd = movieFile(movie.id, 'Remux-2160p', '4K').file;
    const met = checker();
    expect(met(hd)).toBe(true);
    expect(met(uhd)).toBe(true);
    const web = movieFile(movie.id, 'WEBDL-2160p', '4K').file;
    expect(met(web)).toBe(false);
  });

  it('clearing versions (empty list) stores null', () => {
    const movie = addMovie(TWO);
    const m = svc.updateMovie(db, movie.id, UpdateMovieRequest.parse({ versions: [] }), NOW);
    expect(m.versions).toBeNull();
  });
});

describe('backward compatibility (versions unset)', () => {
  it('a movie keeps one file: a new import replaces the previous one', () => {
    const movie = addMovie();
    expect(movie.versions).toBeNull();
    const first = movieFile(movie.id, 'WEBDL-1080p').file;
    const second = movieFile(movie.id, 'Bluray-1080p');
    expect(second.file.versionTag).toBeNull();
    expect(second.replacedFileIds).toEqual([first.id]);
    expect(svc.getMovie(db, movie.id, NOW)).toMatchObject({ hasFile: true, movieFileId: second.file.id });
  });

  it('missing/cutoff lists behave as before and carry no wantedVersions', () => {
    const movie = addMovie();
    const missing = svc.listMissingMovies(db, { page: 1, pageSize: 50 }, NOW);
    expect(missing.records[0]!.id).toBe(movie.id);
    expect(missing.records[0]!.wantedVersions).toBeUndefined();
    movieFile(movie.id, 'WEBDL-720p');
    expect(svc.listMissingMovies(db, { page: 1, pageSize: 50 }, NOW).totalRecords).toBe(0);
    expect(svc.listCutoffUnmetMovies(db, { page: 1, pageSize: 50 }, checker(), NOW).totalRecords).toBe(1);
  });

  it('an episode keeps one file and multi-episode files still link both episodes', () => {
    const series = addSeries();
    const [e1, e2] = svc.listEpisodes(db, { seriesId: series.id });
    const single = episodeFile(series.id, [e1!.id], 'WEBDL-720p').file;
    const multi = episodeFile(series.id, [e1!.id, e2!.id], 'WEBDL-1080p');
    expect(multi.replacedFileIds).toEqual([single.id]);
    expect(multi.file.episodeIds).toEqual([e1!.id, e2!.id]);
    const eps = svc.listEpisodes(db, { seriesId: series.id });
    expect(eps.every((e) => e.episodeFileId === multi.file.id && e.hasFile)).toBe(true);
    expect(eps[0]!.files).toEqual([expect.objectContaining({ id: multi.file.id, versionTag: null })]);
  });
});

describe('two-version series', () => {
  it('episodes hold one file per slot; files[] lists both; hasFile stays true when one goes', async () => {
    const series = addSeries(TWO);
    const [e1] = svc.listEpisodes(db, { seriesId: series.id });
    const hd = episodeFile(series.id, [e1!.id], 'WEBDL-1080p', '1080p').file;
    const uhd = episodeFile(series.id, [e1!.id], 'WEBDL-2160p', '4K').file;
    let ep = svc.getEpisode(db, e1!.id);
    expect(ep.files!.map((f) => f.versionTag)).toEqual(['1080p', '4K']);
    expect(ep.episodeFileId).toBe(hd.id);
    expect(svc.getMediaFile(db, uhd.id).episodeIds).toEqual([e1!.id]);
    await svc.deleteMediaFile(db, hd.id);
    ep = svc.getEpisode(db, e1!.id);
    expect(ep).toMatchObject({ hasFile: true, episodeFileId: uhd.id });
  });

  it('a 4K season-pack file replaces only the 4K slot of the episodes it covers', () => {
    const series = addSeries(TWO);
    const [e1, e2] = svc.listEpisodes(db, { seriesId: series.id });
    const hd1 = episodeFile(series.id, [e1!.id], 'WEBDL-1080p', '1080p').file;
    const uhd1 = episodeFile(series.id, [e1!.id], 'WEBDL-2160p', '4K').file;
    const pack = episodeFile(series.id, [e1!.id, e2!.id], 'Remux-2160p', '4K');
    expect(pack.replacedFileIds).toEqual([uhd1.id]);
    expect(svc.getMediaFile(db, hd1.id).episodeIds).toEqual([e1!.id]);
    expect(pack.file.episodeIds).toEqual([e1!.id, e2!.id]);
    const e2Now = svc.getEpisode(db, e2!.id);
    expect(e2Now).toMatchObject({ hasFile: true, episodeFileId: pack.file.id });
  });

  it('missing episodes list the empty slots; cutoff uses each slot profile', () => {
    const series = addSeries(TWO);
    const [e1, e2] = svc.listEpisodes(db, { seriesId: series.id });
    episodeFile(series.id, [e1!.id], 'Bluray-1080p', '1080p');
    episodeFile(series.id, [e1!.id], 'WEBDL-2160p', '4K');
    episodeFile(series.id, [e2!.id], 'WEBDL-720p', '1080p');
    const missing = svc.listMissingEpisodes(db, { page: 1, pageSize: 50, includeSpecials: false }, NOW);
    expect(missing.records.map((r) => [r.episodeNumber, r.wantedVersions])).toEqual([[2, ['4K']]]);
    const unmet = svc.listCutoffUnmetEpisodes(db, { page: 1, pageSize: 50, includeSpecials: false }, checker());
    const byEp = Object.fromEntries(unmet.records.map((r) => [r.episodeNumber, r.wantedVersions]));
    expect(byEp).toEqual({ 1: ['4K'], 2: ['1080p'] });
  });
});

import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AddMovieRequest,
  NAMING_DEFAULTS,
  QualityProfileInput,
  type MediaFile,
  type MediaVersion,
  type QualityName,
  type TrackedDownloadState,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { createTestDb } from '../../db/test-utils.js';
import type { TrackedDownload } from '../download-clients/index.js';
import { libraryService } from '../library/index.js';
import { ProfilesService } from '../profiles/index.js';
import { HD_ALLOWED, makeProfile, quality } from '../releases/test-support.js';
import { setSection } from '../settings/service.js';
import * as tables from './schema.js';
import { ImportsService, type DownloadClientsPort } from './service.js';
import { filesInSlot, placeVersioned } from './versions.js';

// Multi-version imports: a new file goes into the version slot whose profile it fits best,
// replaces only that slot's file, and is named/placed so versions never collide.

const NOW = '2024-06-15T12:00:00.000Z';
const UHD_ALLOWED: QualityName[] = ['WEBDL-2160p', 'WEBRip-2160p', 'Bluray-2160p', 'Remux-2160p'];

class FakeDownloads implements DownloadClientsPort {
  items = new Map<number, TrackedDownload>();
  add(item: TrackedDownload) {
    this.items.set(item.id, item);
    return item;
  }
  setState(id: number, state: TrackedDownloadState) {
    const next = { ...this.items.get(id)!, trackedState: state };
    this.items.set(id, next);
    return next;
  }
  async markImported(id: number) {
    return this.setState(id, 'imported');
  }
  listTracked(states?: readonly TrackedDownloadState[]) {
    return [...this.items.values()].filter((i) => !states || states.includes(i.trackedState));
  }
}

let tmp: string;
let movieRoot: string;
let downloads: string;
let db: Db;
let fake: FakeDownloads;
let versions: MediaVersion[];

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'arclight-mv-imports-'));
  movieRoot = join(tmp, 'movies');
  downloads = join(tmp, 'downloads');
  for (const d of [movieRoot, downloads]) await mkdir(d, { recursive: true });
  await writeFile(join(movieRoot, '.keep'), '');
  db = await createTestDb(tables);
  await libraryService.addRootFolder(db, { path: movieRoot, mediaType: 'movie' });
  const profiles = new ProfilesService({ db });
  const create = (allowed: QualityName[], cutoff: QualityName, name: string) => {
    const { id: _id, ...draft } = makeProfile(allowed, {}, cutoff);
    return profiles.createQualityProfile(QualityProfileInput.parse({ ...draft, name }));
  };
  const hd = create(HD_ALLOWED, 'Bluray-1080p', 'HD');
  const uhd = create(UHD_ALLOWED, 'Remux-2160p', 'UHD');
  versions = [
    { tag: '1080p', qualityProfileId: hd.id, enabled: true },
    { tag: '4K', qualityProfileId: uhd.id, enabled: true },
  ];
  fake = new FakeDownloads();
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const exists = (p: string) => stat(p).then(() => true, () => false);

function service() {
  return new ImportsService({ db, downloadClients: fake, deps: {}, now: () => new Date(NOW) });
}

function addMovie(v: MediaVersion[] | null) {
  return libraryService.addMovie(
    db,
    { tmdbId: 200, title: 'Great Movie', originalTitle: 'Great Movie', year: 2021, status: 'released', runtimeMinutes: 120, originalLanguage: 'en' },
    AddMovieRequest.parse({ tmdbId: 200, rootFolderPath: movieRoot, qualityProfileId: versions[0]!.qualityProfileId, versions: v }),
    NOW,
  );
}

async function put(name: string): Promise<string> {
  const full = join(downloads, name);
  await writeFile(full, Buffer.alloc(64, 1));
  return full;
}

let nextId = 1;
function tracked(title: string, outputPath: string, movieId: number): TrackedDownload {
  const id = nextId++;
  return fake.add({
    id,
    downloadId: `hash${id}`,
    downloadClientId: 1,
    downloadClientName: 'qbit',
    title,
    outputPath,
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
    mediaType: 'movie',
    movieId,
  } as TrackedDownload);
}

async function importRelease(title: string, movieId: number) {
  const src = await put(`${title}.mkv`);
  return service().importCompletedDownload(tracked(title, src, movieId));
}

describe('import into version slots', () => {
  it('puts a 2160p file in the 4K slot next to the 1080p file (side by side)', async () => {
    const movie = addMovie(versions);
    const hd = await importRelease('Great.Movie.2021.1080p.WEB-DL.x264-GRP', movie.id);
    expect(hd.outcomes[0]).toMatchObject({ status: 'imported' });
    const uhd = await importRelease('Great.Movie.2021.2160p.WEB-DL.x265-GRP', movie.id);
    expect(uhd.outcomes[0]).toMatchObject({ status: 'imported', replacedFileIds: [] });
    expect(uhd.outcomes[0]!.destination).toBe(join(movie.path, 'Great.Movie.2021.2160p.WEB-DL.x265-GRP - 4K.mkv'));
    const files = libraryService.listMediaFiles(db, { movieId: movie.id });
    expect(files.map((f) => f.versionTag).sort()).toEqual(['1080p', '4K']);
    for (const f of files) expect(await exists(f.path)).toBe(true);
  });

  it('an upgrade replaces only its own slot', async () => {
    const movie = addMovie(versions);
    await importRelease('Great.Movie.2021.1080p.WEB-DL.x264-GRP', movie.id);
    await importRelease('Great.Movie.2021.2160p.WEB-DL.x265-GRP', movie.id);
    const before = libraryService.listMediaFiles(db, { movieId: movie.id });
    const old4k = before.find((f) => f.versionTag === '4K')!;
    const hd = before.find((f) => f.versionTag === '1080p')!;
    const r = await importRelease('Great.Movie.2021.2160p.BluRay.REMUX.HEVC-GRP', movie.id);
    expect(r.outcomes[0]).toMatchObject({ status: 'imported', replacedFileIds: [old4k.id] });
    const after = libraryService.listMediaFiles(db, { movieId: movie.id });
    expect(after.find((f) => f.versionTag === '1080p')!.id).toBe(hd.id);
    expect(after.find((f) => f.versionTag === '4K')!.quality.quality.name).toBe('Remux-2160p');
    expect(await exists(old4k.path)).toBe(false);
    expect(await exists(hd.path)).toBe(true);
  });

  it('a downgrade inside a slot is rejected against that slot only', async () => {
    const movie = addMovie(versions);
    await importRelease('Great.Movie.2021.2160p.BluRay.REMUX.HEVC-GRP', movie.id);
    const r = await importRelease('Great.Movie.2021.2160p.WEB-DL.x265-GRP', movie.id);
    expect(r.outcomes[0]!.rejections.map((x) => x.reason)).toContain('notQualityUpgrade');
    // ...while a 1080p file is still welcome in its own, empty slot.
    const hd = await importRelease('Great.Movie.2021.1080p.WEB-DL.x264-GRP', movie.id);
    expect(hd.outcomes[0]!.status).toBe('imported');
  });

  it('subfolder layout keeps each version in a <tag> folder', async () => {
    setSection(db, 'naming', { ...NAMING_DEFAULTS, versionLayout: 'subfolder' });
    const movie = addMovie(versions);
    const r = await importRelease('Great.Movie.2021.2160p.WEB-DL.x265-GRP', movie.id);
    expect(r.outcomes[0]!.destination).toBe(join(movie.path, '4K', 'Great.Movie.2021.2160p.WEB-DL.x265-GRP.mkv'));
  });

  it('renders {Version} when the movie format uses it (no extra suffix)', async () => {
    setSection(db, 'naming', { ...NAMING_DEFAULTS, renameMovies: true, movieFormat: '{Movie Title} ({Release Year}) {[Version]}' });
    const movie = addMovie(versions);
    const r = await importRelease('Great.Movie.2021.2160p.WEB-DL.x265-GRP', movie.id);
    expect(r.outcomes[0]!.destination).toBe(join(movie.path, 'Great Movie (2021) [4K].mkv'));
  });

  it('backward compatible: an unversioned movie still replaces its single file and keeps the plain name', async () => {
    const movie = addMovie(null);
    const first = await importRelease('Great.Movie.2021.1080p.WEB-DL.x264-GRP', movie.id);
    expect(first.outcomes[0]!.destination).toBe(join(movie.path, 'Great.Movie.2021.1080p.WEB-DL.x264-GRP.mkv'));
    const second = await importRelease('Great.Movie.2021.1080p.BluRay.x264-GRP', movie.id);
    expect(second.outcomes[0]).toMatchObject({ status: 'imported', replacedFileIds: [first.outcomes[0]!.mediaFileId] });
    expect(libraryService.listMediaFiles(db, { movieId: movie.id }).map((f) => f.versionTag)).toEqual([null]);
  });
});

describe('placement helpers (pure)', () => {
  const naming = NAMING_DEFAULTS;
  it('appends " - <tag>" before the extension side by side, nothing when unversioned', () => {
    expect(placeVersioned('/m', 'Movie (2020).mkv', '4K', naming, naming.movieFormat, '.mkv')).toBe(join('/m', 'Movie (2020) - 4K.mkv'));
    expect(placeVersioned('/m', 'Movie (2020).mkv', null, naming, naming.movieFormat, '.mkv')).toBe(join('/m', 'Movie (2020).mkv'));
  });

  it('skips the suffix when the format has {Version}; subfolder layout nests', () => {
    expect(placeVersioned('/m', 'Movie 4K.mkv', '4K', naming, '{Movie Title} {Version}', '.mkv')).toBe(join('/m', 'Movie 4K.mkv'));
    expect(placeVersioned('/m', 'Movie.mkv', 'HDR', { ...naming, versionLayout: 'subfolder' }, naming.movieFormat, '.mkv')).toBe(
      join('/m', 'HDR', 'Movie.mkv'),
    );
  });

  it('selects competitors by slot (versioned) or by the movie pointer (unversioned)', () => {
    const f = (id: number, versionTag: string | null): MediaFile =>
      ({ id, versionTag, episodeIds: [], quality: quality('WEBDL-1080p') }) as unknown as MediaFile;
    const files = [f(1, null), f(2, '4K'), f(3, '1080p')];
    const movie = { id: 1, movieFileId: 1, versions } as never;
    expect(filesInSlot(files, { movie, episodes: [] }, '1080p').map((x) => x.id)).toEqual([1, 3]);
    expect(filesInSlot(files, { movie, episodes: [] }, '4K').map((x) => x.id)).toEqual([2]);
    const legacy = { id: 1, movieFileId: 1, versions: null } as never;
    expect(filesInSlot(files, { movie: legacy, episodes: [] }, null).map((x) => x.id)).toEqual([1]);
  });
});

import { buildItems, findItem, itemId } from '@arclight/profiles-engine';
import { parseMusicRelease, parseRelease } from '@arclight/parser';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import {
  QualityProfileInput,
  QUALITIES,
  type Episode,
  type Indexer,
  type Movie,
  type QualityModel,
  type QualityName,
  type QualityProfile,
  type ReleaseResource,
  type Series,
  type TrackedDownloadState,
} from '@arclight/shared';
import { createTestDb } from '../../db/test-utils.js';
import * as schema from '../../db/schema.js';
import { EventBus } from '../../events.js';
import { ProfilesService } from '../profiles/index.js';
import { setSection } from '../settings/service.js';
import { DEFAULT_RELEASE_SETTINGS, type ReleasesDeps } from './deps.js';
import {
  evaluateFormats,
  qualityModelOf,
  releaseKindOf,
  toLanguageCodes,
  type Candidate,
  type DecisionContext,
} from './engine.js';
import { matchAlbum, type AlbumTypeFilter, type AudioAlbum, type AudioArtist, type AudioLibrarySnapshot } from './audio-matcher.js';
import { matchRelease, type LibrarySnapshot } from './matcher.js';
import * as tables from './schema.js';
import { ReleasesService, type DownloadClientGrab, type DownloadTracking, type TrackedView } from './service.js';

// Test-only helpers: in-memory library snapshots, a fixed clock, fake indexer and download
// ports and a DB-backed harness. Not used by production code.

export const NOW = new Date('2026-03-01T12:00:00.000Z');
const MINUTE = 60_000;
export const GB = 1024 * 1024 * 1024;

let nextId = 1;

export function makeSeries(overrides: Partial<Series> = {}): Series {
  const id = overrides.id ?? nextId++;
  const title = overrides.title ?? 'Show Name';
  return {
    id,
    tmdbId: 1000 + id,
    tvdbId: 2000 + id,
    imdbId: null,
    title,
    sortTitle: title.toLowerCase(),
    cleanTitle: title.toLowerCase().replace(/[^a-z0-9]/g, ''),
    year: 2020,
    overview: '',
    status: 'continuing',
    runtimeMinutes: 45,
    genres: [],
    images: [],
    ratings: {},
    originalLanguage: 'en',
    path: `/tv/${title}-${id}`,
    rootFolderPath: '/tv',
    qualityProfileId: 1,
    monitored: true,
    monitorNewItems: 'all',
    seriesType: 'standard',
    seasonFolder: true,
    useSceneNumbering: false,
    tags: [],
    added: '2025-01-01T00:00:00.000Z',
    seasons: [],
    ...overrides,
  };
}

export function makeEpisode(seriesId: number, season: number, episode: number, overrides: Partial<Episode> = {}): Episode {
  return {
    id: overrides.id ?? nextId++,
    seriesId,
    seasonNumber: season,
    episodeNumber: episode,
    title: `Episode ${episode}`,
    overview: '',
    airDate: '2025-01-01',
    airDateUtc: '2025-01-01T20:00:00.000Z',
    runtimeMinutes: null,
    monitored: true,
    hasFile: false,
    episodeFileId: null,
    unverifiedSceneNumbering: false,
    ...overrides,
  };
}

export function makeMovie(overrides: Partial<Movie> = {}): Movie {
  const id = overrides.id ?? nextId++;
  const title = overrides.title ?? 'Movie';
  return {
    id,
    tmdbId: 5000 + id,
    imdbId: null,
    title,
    originalTitle: title,
    sortTitle: title.toLowerCase(),
    cleanTitle: title.toLowerCase().replace(/[^a-z0-9]/g, ''),
    year: 2020,
    overview: '',
    status: 'released',
    inCinemas: '2020-01-01',
    digitalRelease: '2020-03-01',
    physicalRelease: null,
    runtimeMinutes: 120,
    genres: [],
    images: [],
    ratings: {},
    originalLanguage: 'en',
    path: `/movies/${title}-${id}`,
    rootFolderPath: '/movies',
    qualityProfileId: 1,
    minimumAvailability: 'released',
    monitored: true,
    tags: [],
    added: '2025-01-01T00:00:00.000Z',
    hasFile: false,
    isAvailable: true,
    ...overrides,
  };
}

export function snapshot(series: Series[], episodes: Episode[], movies: Movie[] = []): LibrarySnapshot {
  return {
    series: () => series,
    episodes: (id) => episodes.filter((e) => e.seriesId === id),
    movies: () => movies,
  };
}

export function makeProfile(allowed: QualityName[], overrides: Partial<QualityProfile> = {}, cutoffName: QualityName = 'WEBDL-1080p'): QualityProfile {
  const items = buildItems(allowed);
  const draft: QualityProfile = {
    id: 1,
    name: 'HD',
    upgradeAllowed: true,
    cutoff: 0,
    items,
    minFormatScore: 0,
    cutoffFormatScore: 0,
    minUpgradeFormatScore: 1,
    formatItems: [],
    languages: [],
    ...overrides,
  };
  const cutoffItem = findItem(draft, QUALITIES[cutoffName].id);
  return { ...draft, cutoff: overrides.cutoff ?? (cutoffItem ? itemId(cutoffItem) : 0) };
}

export const HD_ALLOWED: QualityName[] = ['HDTV-720p', 'WEBDL-720p', 'HDTV-1080p', 'WEBDL-1080p', 'WEBRip-1080p', 'Bluray-1080p'];

export function quality(name: QualityName, version = 1, isRepack = false): QualityModel {
  return qualityModelOf({ quality: QUALITIES[name], revision: { version, real: 0, isRepack } });
}

export function makeRelease(title: string, overrides: Partial<ReleaseResource> = {}): ReleaseResource {
  const ageMinutes = overrides.ageMinutes ?? 60;
  const publishDate = overrides.publishDate ?? new Date(NOW.getTime() - ageMinutes * MINUTE).toISOString();
  return {
    guid: title,
    title,
    size: Math.round(1.5 * GB),
    publishDate,
    downloadUrl: `http://indexer.test/dl/${encodeURIComponent(title)}`,
    seeders: 50,
    leechers: 5,
    categories: [],
    indexerId: 1,
    indexerName: 'Tracker',
    indexerPriority: 25,
    protocol: 'torrent',
    age: Math.floor(ageMinutes / 1440),
    ageHours: ageMinutes / 60,
    ageMinutes,
    rejections: [],
    approved: false,
    ...overrides,
  };
}

export function makeIndexer(overrides: Partial<Indexer> = {}): Indexer {
  return {
    id: 1,
    name: 'Tracker',
    implementation: 'torznab',
    protocol: 'torrent',
    enableRss: true,
    enableAutomaticSearch: true,
    enableInteractiveSearch: true,
    priority: 25,
    tags: [],
    settings: { baseUrl: 'http://indexer.test', apiPath: '/api', categories: [5000, 2000], animeCategories: [], minimumSeeders: 1 },
    ...overrides,
  };
}

/** A pure decision context with permissive defaults. */
export function makeContext(overrides: Partial<DecisionContext> = {}): DecisionContext {
  return {
    source: 'rss',
    now: NOW,
    settings: { ...DEFAULT_RELEASE_SETTINGS },
    propers: 'preferAndUpgrade',
    profile: makeProfile(HD_ALLOWED),
    delayProfile: undefined,
    releaseProfiles: [],
    qualityLimits: () => undefined,
    indexer: makeIndexer(),
    indexerDisabledTill: undefined,
    existingFiles: [],
    queue: [],
    pending: [],
    latestHistory: [],
    importedGrabs: [],
    blocklisted: false,
    criteria: undefined,
    freeSpaceBytes: null,
    minimumFreeSpaceMb: 100,
    ...overrides,
  };
}

/** Parse + match a release against a snapshot and build an engine candidate. */
export function makeCandidate(
  release: ReleaseResource,
  lib: LibrarySnapshot,
  profile: QualityProfile = makeProfile(HD_ALLOWED),
  now: Date = NOW,
): Candidate {
  const { parsed, match } = matchRelease(release.title, {}, lib);
  if (match.status !== 'mapped') throw new Error(`test release did not map: ${release.title} (${match.reason})`);
  const q = qualityModelOf(parsed.quality);
  const languages = toLanguageCodes(parsed.languages);
  const f = evaluateFormats(profile, [], { title: release.title, quality: q, mediaType: match.mediaType, releaseKind: releaseKindOf(match) });
  return {
    release,
    parsed,
    match,
    quality: q,
    languages,
    customFormats: f.formats,
    formatScore: f.score,
    releaseGroup: parsed.releaseGroup ?? undefined,
    ageMinutes: (now.getTime() - Date.parse(release.publishDate)) / MINUTE,
  };
}

// ---- DB harness ---------------------------------------------------------------------

export class FakeIndexers {
  indexers: Indexer[] = [makeIndexer()];
  results: ReleaseResource[] = [];
  searches: unknown[] = [];
  handler: ((r: ReleaseResource[]) => void | Promise<void>) | undefined;
  resolver: ((r: never) => unknown) | undefined;
  list() {
    return this.indexers;
  }
  async search(request: unknown) {
    this.searches.push(request);
    return this.results;
  }
  onReleases(h: (r: ReleaseResource[]) => void | Promise<void>) {
    this.handler = h;
    return () => {
      this.handler = undefined;
    };
  }
  setManualSearchResolver(r: unknown) {
    this.resolver = r as typeof this.resolver;
  }
}

export class FakeDownloads {
  grabs: Array<{ clientId: number | null; request: DownloadClientGrab; tracking: DownloadTracking }> = [];
  queue: TrackedView[] = [];
  fail: Error | null = null;
  async grab(clientId: number | null, request: DownloadClientGrab, tracking: DownloadTracking): Promise<TrackedView> {
    if (this.fail) throw this.fail;
    this.grabs.push({ clientId, request, tracking });
    return {
      id: this.grabs.length,
      downloadId: `hash${this.grabs.length}`,
      downloadClientId: 1,
      downloadClientName: 'qBit',
      title: request.title,
      trackedState: 'downloading',
      sizeBytes: 0,
      ...(tracking.episodeIds ? { episodeIds: tracking.episodeIds } : {}),
      ...(tracking.movieId !== undefined ? { movieId: tracking.movieId } : {}),
    };
  }
  listTracked(states?: readonly TrackedDownloadState[]) {
    return this.queue.filter((q) => !states || states.includes(q.trackedState));
  }
}

export function fakeFetch(): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('gone')) return new Response('nope', { status: 404 });
    if (url.includes('tomagnet')) return new Response(null, { status: 302, headers: { location: 'magnet:?xt=urn:btih:abc' } });
    return new Response(new TextEncoder().encode('d8:announce3:urle'), { status: 200 });
  }) as typeof fetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}

export async function harness(opts: { deps?: ReleasesDeps; allowed?: QualityName[]; tables?: Record<string, unknown> } = {}) {
  const db = await createTestDb({ ...tables, ...(opts.tables ?? {}) });
  const profiles = new ProfilesService({ db });
  profiles.seedDefaults();
  const draft = makeProfile(opts.allowed ?? HD_ALLOWED);
  const { id: _id, ...input } = draft;
  const profile = profiles.createQualityProfile(QualityProfileInput.parse({ ...input, name: 'Test HD' }));
  let clock = NOW;
  const indexers = new FakeIndexers();
  const downloads = new FakeDownloads();
  const bus = new EventBus();
  const events: unknown[] = [];
  bus.subscribe((e) => events.push(e));
  const fetchImpl = fakeFetch();
  const service = new ReleasesService({
    db,
    bus,
    log: pino({ level: 'silent' }),
    indexers,
    downloads,
    deps: opts.deps ?? {},
    fetch: fetchImpl,
    now: () => clock,
  });

  const nowIso = () => clock.toISOString();
  function addSeries(values: Partial<typeof schema.series.$inferInsert> = {}) {
    const title = values.title ?? 'Show Name';
    return db
      .insert(schema.series)
      .values({
        tmdbId: Math.floor(Math.random() * 1e9),
        title,
        sortTitle: title.toLowerCase(),
        cleanTitle: title.toLowerCase().replace(/[^a-z0-9]/g, ''),
        year: 2020,
        status: 'continuing',
        genres: [],
        images: [],
        ratings: {},
        originalLanguage: 'en',
        path: `/tv/${title}-${Math.random()}`,
        rootFolderPath: '/tv',
        qualityProfileId: profile.id,
        runtimeMinutes: 45,
        tags: [],
        added: nowIso(),
        ...values,
      })
      .returning()
      .get();
  }
  function addEpisode(seriesId: number, season: number, episode: number, values: Partial<typeof schema.episodes.$inferInsert> = {}) {
    return db
      .insert(schema.episodes)
      .values({ seriesId, seasonNumber: season, episodeNumber: episode, airDate: '2025-01-01', airDateUtc: '2025-01-01T20:00:00.000Z', ...values })
      .returning()
      .get();
  }
  function addMovie(values: Partial<typeof schema.movies.$inferInsert> = {}) {
    const title = values.title ?? 'Movie';
    return db
      .insert(schema.movies)
      .values({
        tmdbId: Math.floor(Math.random() * 1e9),
        title,
        originalTitle: title,
        sortTitle: title.toLowerCase(),
        cleanTitle: title.toLowerCase().replace(/[^a-z0-9]/g, ''),
        year: 2020,
        status: 'released',
        digitalRelease: '2020-03-01',
        runtimeMinutes: 120,
        genres: [],
        images: [],
        ratings: {},
        originalLanguage: 'en',
        path: `/movies/${title}-${Math.random()}`,
        rootFolderPath: '/movies',
        qualityProfileId: profile.id,
        tags: [],
        added: nowIso(),
        ...values,
      })
      .returning()
      .get();
  }

  return {
    db,
    profiles,
    profile,
    service,
    indexers,
    downloads,
    events,
    fetchImpl,
    addSeries,
    addEpisode,
    addMovie,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
    now: () => clock,
  };
}

export { parseRelease };

// ---- music --------------------------------------------------------------------------

export const MUSIC_ALLOWED: QualityName[] = ['MP3-192', 'MP3-VBR-V0', 'MP3-320', 'FLAC', 'FLAC-24bit'];

export function makeMusicProfile(allowed: QualityName[] = MUSIC_ALLOWED, overrides: Partial<QualityProfile> = {}, cutoffName: QualityName = 'FLAC'): QualityProfile {
  const items = buildItems(allowed, 'music');
  const draft: QualityProfile = {
    id: 1,
    name: 'Lossless',
    upgradeAllowed: true,
    cutoff: 0,
    items,
    minFormatScore: 0,
    cutoffFormatScore: 0,
    minUpgradeFormatScore: 1,
    formatItems: [],
    languages: [],
    ...overrides,
  };
  const cutoffItem = findItem(draft, QUALITIES[cutoffName].id);
  return { ...draft, cutoff: overrides.cutoff ?? (cutoffItem ? itemId(cutoffItem) : 0) };
}

export function makeArtist(overrides: Partial<AudioArtist> = {}): AudioArtist {
  const id = overrides.id ?? nextId++;
  return {
    id,
    name: 'Radiohead',
    aliases: [],
    monitored: true,
    qualityProfileId: 1,
    albumTypeProfileId: 1,
    tags: [],
    path: `/music/artist-${id}`,
    ...overrides,
  };
}

export function makeAlbum(artistId: number, title: string, year: number | null, overrides: Partial<AudioAlbum> = {}): AudioAlbum {
  return {
    id: overrides.id ?? nextId++,
    artistId,
    title,
    year,
    releaseDate: year !== null ? `${year}-06-01` : null,
    primaryType: 'Album',
    secondaryTypes: [],
    monitored: true,
    durationMs: 50 * 60_000,
    trackCount: 12,
    trackFileCount: 0,
    ...overrides,
  };
}

export function audioSnapshot(artists: AudioArtist[], albums: AudioAlbum[], profiles: Record<number, AlbumTypeFilter> = {}): AudioLibrarySnapshot {
  return {
    artists: () => artists,
    albums: (id) => albums.filter((a) => a.artistId === id),
    albumTypeProfile: (id) => profiles[id],
  };
}

/** Parse + match a music release against an audio snapshot and build an engine candidate. */
export function makeAudioCandidate(
  release: ReleaseResource,
  lib: AudioLibrarySnapshot,
  profile: QualityProfile = makeMusicProfile(),
  now: Date = NOW,
): Candidate {
  const parsed = parseMusicRelease(release.title);
  const match = matchAlbum(parsed.music, lib, { now });
  if (match.status !== 'mapped') throw new Error(`test release did not map: ${release.title} (${match.reason})`);
  const q = qualityModelOf(parsed.audio);
  const f = evaluateFormats(profile, [], { title: release.title, quality: q, mediaType: 'music', releaseKind: releaseKindOf(match) });
  return {
    release,
    parsed: {
      releaseTitle: parsed.releaseTitle,
      quality: { quality: parsed.audio.quality, revision: parsed.audio.revision, detectionSource: parsed.audio.detectionSource },
      languages: [],
      releaseGroup: parsed.releaseGroup,
      releaseHash: parsed.releaseHash,
      series: null,
      movie: null,
    },
    match,
    ...(parsed.music ? { music: parsed.music } : {}),
    quality: q,
    languages: [],
    customFormats: f.formats,
    formatScore: f.score,
    releaseGroup: parsed.releaseGroup ?? undefined,
    ageMinutes: (now.getTime() - Date.parse(release.publishDate)) / MINUTE,
  };
}

/** Music rows for a DB harness: turn music on, add artists / albums (with an edition and tracks) / track files. */
export function musicFixtures(db: Awaited<ReturnType<typeof createTestDb>>, profiles: ProfilesService) {
  setSection(db, 'features', { music: true, audiobooks: false });
  const music = makeMusicProfile();
  const { id: _id, ...input } = music;
  const profile = profiles.createQualityProfile(QualityProfileInput.parse({ ...input, name: 'Test Lossless', mediaDomain: 'music' }));
  const typeProfile = db
    .insert(schema.albumTypeProfiles)
    .values({ name: `Studio ${Math.random()}`, primaryTypes: ['Album', 'EP'], secondaryTypes: [], releaseStatuses: ['Official'], isDefault: false })
    .returning()
    .get();
  let mb = 1;
  const mbid = () => `00000000-0000-4000-8000-${String(mb++).padStart(12, '0')}`;
  function addArtist(values: Partial<typeof schema.artists.$inferInsert> = {}) {
    const name = values.name ?? 'Radiohead';
    return db
      .insert(schema.artists)
      .values({
        mbArtistId: mbid(),
        name,
        sortName: name,
        cleanName: name.toLowerCase().replace(/[^a-z0-9]/g, ''),
        genres: [],
        images: [],
        links: [],
        aliases: [],
        path: `/music/${name}-${Math.random()}`,
        rootFolderPath: '/music',
        qualityProfileId: profile.id,
        albumTypeProfileId: typeProfile.id,
        tags: [],
        added: NOW.toISOString(),
        ...values,
      })
      .returning()
      .get();
  }
  function addAlbum(artistId: number, title: string, year: number, values: Partial<typeof schema.albums.$inferInsert> & { tracks?: number; minutes?: number } = {}) {
    const { tracks: trackCount = 10, minutes = 45, ...rest } = values;
    const album = db
      .insert(schema.albums)
      .values({
        artistId,
        mbReleaseGroupId: mbid(),
        title,
        cleanTitle: title.toLowerCase().replace(/[^a-z0-9]/g, ''),
        primaryType: 'Album',
        secondaryTypes: [],
        releaseDate: `${year}-05-01`,
        year,
        genres: [],
        images: [],
        ratings: {},
        added: NOW.toISOString(),
        ...rest,
      })
      .returning()
      .get();
    const release = db
      .insert(schema.albumReleases)
      .values({ albumId: album.id, mbReleaseId: mbid(), title, labels: [], formats: ['CD'], mediumCount: 1, trackCount, durationMs: minutes * 60_000, media: [] })
      .returning()
      .get();
    db.update(schema.albums).set({ selectedReleaseId: release.id }).where(eq(schema.albums.id, album.id)).run();
    const trackRows = Array.from({ length: trackCount }, (_, i) =>
      db
        .insert(schema.tracks)
        .values({ albumId: album.id, albumReleaseId: release.id, absoluteNumber: i + 1, trackNumber: i + 1, title: `Track ${i + 1}`, durationMs: (minutes * 60_000) / trackCount })
        .returning()
        .get(),
    );
    return { ...album, selectedReleaseId: release.id, trackRows };
  }
  /** Gives every track of the album a file of `qualityName` (the first track `lowest` when given). */
  function addFiles(album: ReturnType<typeof addAlbum>, qualityName: QualityName, lowest?: QualityName) {
    album.trackRows.forEach((t, i) => {
      const file = db
        .insert(schema.audioFiles)
        .values({
          mediaType: 'music',
          artistId: album.artistId,
          albumId: album.id,
          path: `/music/${album.id}/${i}.flac`,
          relativePath: `${album.id}/${i}.flac`,
          sizeBytes: 30 * 1024 * 1024,
          dateAdded: NOW.toISOString(),
          quality: quality(i === 0 && lowest ? lowest : qualityName),
        })
        .returning()
        .get();
      db.update(schema.tracks).set({ hasFile: true, audioFileId: file.id }).where(eq(schema.tracks.id, t.id)).run();
    });
  }
  return { profile, typeProfile, addArtist, addAlbum, addFiles };
}

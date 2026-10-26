import type {
  Episode,
  MediaFile,
  MediaImage,
  MediaInfo,
  Movie,
  Ratings,
  SeasonStatistics,
  Series,
  SeriesStatistics,
} from '@arclight/shared';
import type { MovieMetadata, SearchResult, SeriesMetadata } from '@arclight/metadata';
import { baseName, compact, MIN_DATE, slugify, timeSpan, type Json } from './common.js';
import { v3Language, v3Languages, v3QualityModel } from './quality.js';

// Library -> Sonarr (series, episode, episodefile) and Radarr (movie, moviefile) resources.

export interface SeriesExtras {
  /** First/last aired episode (UTC) for firstAired / lastAired. */
  firstAired?: string | null;
  lastAired?: string | null;
  /** HH:mm of the most recent airing (UTC; upstream uses network-local time). */
  airTime?: string | null;
}

// ---- shared sub-shapes -------------------------------------------------------------------

export function v3Images(images: readonly MediaImage[]): Json[] {
  return images.map((i) => compact({ coverType: i.coverType, url: i.url, remoteUrl: i.remoteUrl ?? i.url }));
}

/** Sonarr ratings: one `{ votes, value }` (TMDB preferred). */
export function sonarrRatings(ratings: Ratings): Json {
  const r = ratings['tmdb'] ?? ratings['tvdb'] ?? Object.values(ratings)[0];
  return { votes: r?.votes ?? 0, value: r?.value ?? 0 };
}

/** Radarr ratings: keyed by source, each `{ votes, value, type }`. */
export function radarrRatings(ratings: Ratings): Json {
  const out: Json = {};
  for (const [source, r] of Object.entries(ratings)) out[source] = { votes: r.votes, value: r.value, type: 'user' };
  return out;
}

function seasonStatistics(s: SeasonStatistics | null | undefined): Json {
  return compact({
    nextAiring: s?.nextAiring,
    previousAiring: s?.previousAiring,
    episodeFileCount: s?.episodeFileCount ?? 0,
    episodeCount: s?.episodeCount ?? 0,
    totalEpisodeCount: s?.totalEpisodeCount ?? 0,
    sizeOnDisk: s?.sizeOnDisk ?? 0,
    releaseGroups: [],
    percentOfEpisodes: s?.percentOfEpisodes ?? 0,
  });
}

function seriesStatistics(s: SeriesStatistics | null | undefined): Json {
  const { nextAiring: _next, previousAiring: _previous, ...rest } = seasonStatistics(s);
  return { seasonCount: s?.seasonCount ?? 0, ...rest };
}

function imagesFromSet(set: { poster?: string; backdrop?: string; logo?: string }): Json[] {
  const images: Json[] = [];
  if (set.poster) images.push({ coverType: 'poster', url: set.poster, remoteUrl: set.poster });
  if (set.backdrop) images.push({ coverType: 'fanart', url: set.backdrop, remoteUrl: set.backdrop });
  if (set.logo) images.push({ coverType: 'clearlogo', url: set.logo, remoteUrl: set.logo });
  return images;
}

const isoDay = (d: string | undefined): string | undefined => (d ? `${d.slice(0, 10)}T00:00:00Z` : undefined);

// ---- series ------------------------------------------------------------------------------

export function toV3Series(series: Series, extras: SeriesExtras = {}): Json {
  return compact({
    id: series.id,
    title: series.title,
    alternateTitles: [],
    sortTitle: series.sortTitle,
    status: series.status,
    ended: series.status === 'ended',
    overview: series.overview,
    previousAiring: series.statistics?.previousAiring,
    nextAiring: series.statistics?.nextAiring,
    network: series.network ?? '',
    airTime: extras.airTime,
    images: v3Images(series.images),
    originalLanguage: v3Language(series.originalLanguage),
    seasons: series.seasons.map((s) => ({
      seasonNumber: s.seasonNumber,
      monitored: s.monitored,
      statistics: seasonStatistics(s.statistics),
    })),
    year: series.year,
    path: series.path,
    qualityProfileId: series.qualityProfileId,
    languageProfileId: 1,
    seasonFolder: series.seasonFolder,
    monitored: series.monitored,
    monitorNewItems: series.monitorNewItems,
    useSceneNumbering: false,
    runtime: series.runtimeMinutes ?? 0,
    tvdbId: series.tvdbId ?? 0,
    tvRageId: 0,
    tvMazeId: 0,
    tmdbId: series.tmdbId,
    imdbId: series.imdbId,
    firstAired: extras.firstAired,
    lastAired: extras.lastAired,
    seriesType: series.seriesType,
    cleanTitle: series.cleanTitle,
    titleSlug: slugify(series.title) || String(series.tmdbId),
    rootFolderPath: series.rootFolderPath,
    folder: baseName(series.path),
    certification: series.certification,
    genres: series.genres,
    tags: series.tags,
    added: series.added,
    ratings: sonarrRatings(series.ratings),
    statistics: seriesStatistics(series.statistics),
  });
}

/** A metadata lookup result in series shape; `existing` (a library series resource) wins when set. */
export function toV3SeriesLookup(meta: SeriesMetadata | SearchResult, existing: Json | null): Json {
  const full = 'seasons' in meta ? meta : null;
  const year = meta.year ?? 0;
  const firstAired = full?.firstAired ?? ('firstAired' in meta ? meta.firstAired : undefined);
  const seasons = full?.seasons ?? [];
  const base = compact({
    title: meta.title,
    sortTitle: full?.sortTitle ?? meta.title.toLowerCase(),
    status: full && full.status !== 'unknown' ? full.status : 'continuing',
    ended: full?.status === 'ended',
    overview: meta.overview,
    network: full?.network ?? '',
    images: imagesFromSet(meta.images),
    remotePoster: meta.images.poster,
    originalLanguage: v3Language(meta.originalLanguage),
    seasons: seasons.map((s) => ({
      seasonNumber: s.seasonNumber,
      monitored: s.seasonNumber > 0,
      statistics: seasonStatistics({
        episodeCount: 0,
        episodeFileCount: 0,
        totalEpisodeCount: s.episodeCount,
        monitoredEpisodeCount: 0,
        sizeOnDisk: 0,
        percentOfEpisodes: 0,
      }),
    })),
    year,
    qualityProfileId: 0,
    languageProfileId: 0,
    seasonFolder: true,
    monitored: false,
    monitorNewItems: 'all',
    useSceneNumbering: false,
    runtime: full?.runtimeMinutes ?? 0,
    tvdbId: full?.tvdbId ?? 0,
    tvRageId: 0,
    tvMazeId: 0,
    tmdbId: meta.tmdbId,
    imdbId: full?.imdbId,
    firstAired: isoDay(firstAired),
    lastAired: isoDay(full?.lastAired),
    seriesType: 'standard',
    cleanTitle: slugify(meta.title).replace(/-/g, ''),
    titleSlug: slugify(meta.title) || String(meta.tmdbId),
    folder: year ? `${meta.title} (${year})` : meta.title,
    certification: full?.certification,
    genres: full?.genres ?? [],
    tags: [],
    added: MIN_DATE,
    ratings: { votes: meta.ratings.tmdb.votes, value: meta.ratings.tmdb.value },
    statistics: {
      seasonCount: seasons.filter((s) => s.seasonNumber > 0).length,
      episodeFileCount: 0,
      episodeCount: 0,
      totalEpisodeCount: 0,
      sizeOnDisk: 0,
      releaseGroups: [],
      percentOfEpisodes: 0,
    },
  });
  return existing ? { ...base, ...existing, ...(meta.images.poster ? { remotePoster: meta.images.poster } : {}) } : base;
}

// ---- episodes ----------------------------------------------------------------------------

export function toV3Episode(e: Episode, extra: { episodeFile?: Json | undefined; series?: Json | undefined } = {}): Json {
  return compact({
    id: e.id,
    seriesId: e.seriesId,
    tvdbId: 0,
    episodeFileId: e.episodeFileId ?? 0,
    seasonNumber: e.seasonNumber,
    episodeNumber: e.episodeNumber,
    title: e.title,
    airDate: e.airDate,
    airDateUtc: e.airDateUtc,
    runtime: e.runtimeMinutes ?? 0,
    overview: e.overview,
    episodeFile: extra.episodeFile,
    hasFile: e.hasFile,
    monitored: e.monitored,
    absoluteEpisodeNumber: e.absoluteEpisodeNumber,
    unverifiedSceneNumbering: e.unverifiedSceneNumbering,
    grabbed: false,
    series: extra.series,
    images: [],
  });
}

// ---- files -------------------------------------------------------------------------------

/** Upstream renders language lists inside media info as `eng/fre`. */
function joinLanguages(list: readonly string[] | null | undefined): string {
  return (list ?? []).join('/');
}

export function v3MediaInfo(info: MediaInfo | null | undefined): Json | undefined {
  if (!info) return undefined;
  const hdr = info.videoDynamicRange && info.videoDynamicRange !== 'SDR' ? info.videoDynamicRange : null;
  return {
    audioBitrate: 0,
    audioChannels: info.audioChannels ?? 0,
    audioCodec: info.audioCodec ?? '',
    audioLanguages: joinLanguages(info.audioLanguages),
    audioStreamCount: info.audioLanguages?.length ?? (info.audioCodec ? 1 : 0),
    videoBitDepth: 0,
    videoBitrate: 0,
    videoCodec: info.videoCodec ?? '',
    videoFps: 0,
    videoDynamicRange: hdr ? 'HDR' : '',
    videoDynamicRangeType: hdr ?? '',
    resolution: info.resolution ?? '',
    runTime: (info.runtimeSeconds ? timeSpan(info.runtimeSeconds * 1000) : undefined) ?? '00:00:00',
    scanType: 'Progressive',
    subtitles: joinLanguages(info.subtitles),
  };
}

export function toV3EpisodeFile(f: MediaFile, cutoffNotMet = false): Json {
  return compact({
    id: f.id,
    seriesId: f.seriesId ?? 0,
    seasonNumber: f.seasonNumber ?? 0,
    relativePath: f.relativePath,
    path: f.path,
    size: f.sizeBytes,
    dateAdded: f.dateAdded,
    sceneName: f.sceneName,
    releaseGroup: f.releaseGroup,
    languages: v3Languages(f.languages),
    quality: v3QualityModel(f.quality, 'sonarr'),
    customFormats: [],
    customFormatScore: 0,
    indexerFlags: 0,
    releaseType: f.episodeIds.length > 1 ? 'multiEpisode' : 'singleEpisode',
    mediaInfo: v3MediaInfo(f.mediaInfo),
    qualityCutoffNotMet: cutoffNotMet,
  });
}

export function toV3MovieFile(f: MediaFile, cutoffNotMet = false): Json {
  return compact({
    id: f.id,
    movieId: f.movieId ?? 0,
    relativePath: f.relativePath,
    path: f.path,
    size: f.sizeBytes,
    dateAdded: f.dateAdded,
    sceneName: f.sceneName,
    releaseGroup: f.releaseGroup,
    edition: f.edition ?? '',
    languages: v3Languages(f.languages),
    quality: v3QualityModel(f.quality, 'radarr'),
    customFormats: [],
    customFormatScore: 0,
    indexerFlags: 0,
    mediaInfo: v3MediaInfo(f.mediaInfo),
    qualityCutoffNotMet: cutoffNotMet,
  });
}

// ---- movies ------------------------------------------------------------------------------

export function toV3Movie(m: Movie, extra: { movieFile?: Json | undefined } = {}): Json {
  return compact({
    id: m.id,
    title: m.title,
    originalTitle: m.originalTitle,
    originalLanguage: v3Language(m.originalLanguage),
    alternateTitles: [],
    secondaryYearSourceId: 0,
    sortTitle: m.sortTitle,
    sizeOnDisk: m.statistics?.sizeOnDisk ?? 0,
    status: m.status,
    overview: m.overview,
    inCinemas: m.inCinemas,
    physicalRelease: m.physicalRelease,
    digitalRelease: m.digitalRelease,
    releaseDate: m.digitalRelease ?? m.physicalRelease ?? m.inCinemas,
    images: v3Images(m.images),
    website: '',
    year: m.year,
    youTubeTrailerId: '',
    studio: m.studio ?? '',
    path: m.path,
    qualityProfileId: m.qualityProfileId,
    hasFile: m.hasFile,
    movieFileId: m.movieFileId ?? 0,
    monitored: m.monitored,
    minimumAvailability: m.minimumAvailability,
    isAvailable: m.isAvailable,
    folderName: m.path,
    runtime: m.runtimeMinutes ?? 0,
    cleanTitle: m.cleanTitle,
    imdbId: m.imdbId,
    tmdbId: m.tmdbId,
    titleSlug: String(m.tmdbId),
    rootFolderPath: m.rootFolderPath,
    folder: baseName(m.path),
    certification: m.certification,
    genres: m.genres,
    tags: m.tags,
    added: m.added,
    ratings: radarrRatings(m.ratings),
    movieFile: extra.movieFile,
    collection: m.collection ? { title: m.collection.title, tmdbId: m.collection.tmdbId } : undefined,
    popularity: 0,
    statistics: {
      movieFileCount: m.statistics?.movieFileCount ?? (m.hasFile ? 1 : 0),
      sizeOnDisk: m.statistics?.sizeOnDisk ?? 0,
      releaseGroups: [],
    },
  });
}

export function toV3MovieLookup(meta: MovieMetadata | SearchResult, existing: Json | null): Json {
  const full = 'genres' in meta ? meta : null;
  const year = meta.year ?? 0;
  const inCinemas = full?.inCinemas ?? ('releaseDate' in meta ? meta.releaseDate : undefined);
  const folder = year ? `${meta.title} (${year})` : meta.title;
  const base = compact({
    title: meta.title,
    originalTitle: meta.originalTitle,
    originalLanguage: v3Language(meta.originalLanguage),
    alternateTitles: [],
    sortTitle: full?.sortTitle ?? meta.title.toLowerCase(),
    sizeOnDisk: 0,
    status: full ? (full.status === 'unknown' ? 'tba' : full.status) : 'announced',
    overview: meta.overview,
    inCinemas: isoDay(inCinemas),
    digitalRelease: isoDay(full?.digitalRelease),
    physicalRelease: isoDay(full?.physicalRelease),
    images: imagesFromSet(meta.images),
    remotePoster: meta.images.poster,
    website: '',
    year,
    youTubeTrailerId: full?.youtubeTrailerId ?? '',
    studio: full?.studio ?? '',
    qualityProfileId: 0,
    hasFile: false,
    monitored: false,
    minimumAvailability: 'released',
    isAvailable: false,
    folderName: folder,
    runtime: full?.runtimeMinutes ?? 0,
    cleanTitle: slugify(meta.title).replace(/-/g, ''),
    imdbId: full?.imdbId,
    tmdbId: meta.tmdbId,
    titleSlug: String(meta.tmdbId),
    folder,
    certification: full?.certification,
    genres: full?.genres ?? [],
    tags: [],
    added: MIN_DATE,
    ratings: { tmdb: { votes: meta.ratings.tmdb.votes, value: meta.ratings.tmdb.value, type: 'user' } },
    collection: full?.collection ? { title: full.collection.name, tmdbId: full.collection.tmdbId } : undefined,
    popularity: ('popularity' in meta ? meta.popularity : undefined) ?? 0,
    statistics: { movieFileCount: 0, sizeOnDisk: 0, releaseGroups: [] },
  });
  return existing ? { ...base, ...existing, ...(meta.images.poster ? { remotePoster: meta.images.poster } : {}) } : base;
}

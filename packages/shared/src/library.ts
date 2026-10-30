import { z } from 'zod';
import { ListSearchParam } from './list-search.js';
import { QualityModel } from './quality.js';

// The library contract: root folders, series/seasons/episodes, movies, media files, tags.
// Dates are ISO-8601 strings (date-only `YYYY-MM-DD` for air/release dates where the source
// gives no time; full timestamps elsewhere). Fields that may be unknown are `.nullish()` so a
// DB `null` and an absent key are both valid on the wire.

/**
 * A query-string boolean: true/false, 1/0, yes/no, on/off. Never `z.coerce.boolean()`, which
 * reads the string "false" as true (so `?deleteFiles=false` would delete files).
 */
const queryFlag = () => z.union([z.boolean(), z.stringbool()]);

/** Video media types. Video-only modules keep speaking this; audio never widens it. */

export const MediaType = z.enum(['series', 'movie']);
export type MediaType = z.infer<typeof MediaType>;

/** Audio media types (docs/design/music-audiobooks.md section 1). */
export const AudioMediaType = z.enum(['music', 'audiobook']);
export type AudioMediaType = z.infer<typeof AudioMediaType>;

/** Every media type. Only pipeline modules (and root folders) widen to this. */
export const AnyMediaType = z.enum(['series', 'movie', 'music', 'audiobook']);
export type AnyMediaType = z.infer<typeof AnyMediaType>;

export function isAudioMediaType(t: AnyMediaType): t is AudioMediaType {
  return t === 'music' || t === 'audiobook';
}

export function isVideoMediaType(t: AnyMediaType): t is MediaType {
  return t === 'series' || t === 'movie';
}

const isoDate = () => z.string().describe('ISO-8601 date or timestamp');
const idList = () => z.array(z.number().int().positive());

// ---------------------------------------------------------------------------------------
// Shared sub-shapes
// ---------------------------------------------------------------------------------------

export const ImageCoverType = z.enum(['poster', 'banner', 'fanart', 'clearlogo', 'screenshot', 'headshot']);
export type ImageCoverType = z.infer<typeof ImageCoverType>;

export const MediaImage = z.object({
  coverType: ImageCoverType,
  /** Local cached URL once the metadata module has fetched it; remote URL until then. */
  url: z.string(),
  remoteUrl: z.string().nullish(),
});
export type MediaImage = z.infer<typeof MediaImage>;

export const Rating = z.object({
  votes: z.number().int().min(0),
  value: z.number().min(0),
});
export type Rating = z.infer<typeof Rating>;

/** Keyed by source, e.g. `{ tmdb: { votes, value }, imdb: { votes, value } }`. */
export const Ratings = z.record(z.string(), Rating);
export type Ratings = z.infer<typeof Ratings>;

export const MovieCollection = z.object({
  tmdbId: z.number().int(),
  title: z.string(),
});
export type MovieCollection = z.infer<typeof MovieCollection>;

// ---------------------------------------------------------------------------------------
// Root folders
// ---------------------------------------------------------------------------------------

export const RootFolder = z.object({
  id: z.number().int(),
  path: z.string(),
  /** Each media type has its own roots; a music root never holds series. */
  mediaType: AnyMediaType,
  freeSpaceBytes: z.number().int().nullish(),
  accessible: z.boolean(),
});
export type RootFolder = z.infer<typeof RootFolder>;

export const AddRootFolderRequest = z.object({
  path: z.string().min(1),
  mediaType: AnyMediaType,
});
export type AddRootFolderRequest = z.infer<typeof AddRootFolderRequest>;

// ---------------------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------------------

export const Tag = z.object({
  id: z.number().int(),
  label: z.string(),
});
export type Tag = z.infer<typeof Tag>;

export const TagRequest = z.object({
  label: z.string().trim().min(1).max(100),
});
export type TagRequest = z.infer<typeof TagRequest>;

// ---------------------------------------------------------------------------------------
// Series / seasons / episodes
// ---------------------------------------------------------------------------------------

export const SeriesStatus = z.enum(['continuing', 'ended', 'upcoming', 'deleted']);
export type SeriesStatus = z.infer<typeof SeriesStatus>;

export const SeriesType = z.enum(['standard', 'daily', 'anime']);
export type SeriesType = z.infer<typeof SeriesType>;

export const NewItemMonitor = z.enum(['all', 'none']);
export type NewItemMonitor = z.infer<typeof NewItemMonitor>;

/** How to set episode/season monitored flags when a series is added or re-monitored. */
export const MonitorOption = z.enum([
  'all',
  'future',
  'missing',
  'existing',
  'firstSeason',
  'latestSeason',
  'pilot',
  'none',
]);
export type MonitorOption = z.infer<typeof MonitorOption>;

export const SeasonStatistics = z.object({
  /** Episodes that have aired and are monitored, or have a file. The denominator for percent. */
  episodeCount: z.number().int(),
  episodeFileCount: z.number().int(),
  totalEpisodeCount: z.number().int(),
  monitoredEpisodeCount: z.number().int(),
  sizeOnDisk: z.number().int(),
  percentOfEpisodes: z.number(),
  nextAiring: isoDate().nullish(),
  previousAiring: isoDate().nullish(),
});
export type SeasonStatistics = z.infer<typeof SeasonStatistics>;

export const SeriesStatistics = SeasonStatistics.extend({
  seasonCount: z.number().int(),
});
export type SeriesStatistics = z.infer<typeof SeriesStatistics>;

// ---------------------------------------------------------------------------------------
// Versions (multi-version library: e.g. a 1080p and a 4K copy kept on purpose)
// ---------------------------------------------------------------------------------------

/** A version tag such as `4K`, `HDR`, `Remux`: used in file names and folders, so no path characters. */
export const VersionTag = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[^\\/<>:?*|"]+$/, 'must not contain \\ / < > : ? * | "');
export type VersionTag = z.infer<typeof VersionTag>;

/**
 * One version slot of a series or movie. Each enabled slot is monitored, searched and upgraded
 * on its own against its own quality profile; a disabled slot keeps its file but is not wanted.
 */
export const MediaVersion = z.object({
  tag: VersionTag,
  qualityProfileId: z.number().int(),
  enabled: z.boolean().default(true),
  /**
   * Audio languages a release must carry to fill this slot (IETF tags, e.g. `["es"]`); a release
   * that has them prefers this slot. Set by "Add additional…" → audio → separate version.
   */
  audioLanguages: z.array(z.string().min(2).max(16)).max(8).optional(),
});
export type MediaVersion = z.infer<typeof MediaVersion>;

/** The `versions` config of a series or movie. null/absent = one unversioned file per item (classic). */
export const MediaVersions = z
  .array(MediaVersion)
  .max(8)
  .refine((v) => new Set(v.map((x) => x.tag.toLowerCase())).size === v.length, { message: 'version tags must be unique' });
export type MediaVersions = z.infer<typeof MediaVersions>;

/** A file of an episode/movie as listed on the item: which version slot it fills. */
export const MediaFileVersion = z.object({
  id: z.number().int(),
  /** null = unversioned (classic) file. */
  versionTag: z.string().nullish(),
  quality: QualityModel,
  sizeBytes: z.number().int(),
  relativePath: z.string(),
});
export type MediaFileVersion = z.infer<typeof MediaFileVersion>;

export const Season = z.object({
  seasonNumber: z.number().int().min(0),
  monitored: z.boolean(),
  statistics: SeasonStatistics.nullish(),
});
export type Season = z.infer<typeof Season>;

export const Series = z.object({
  id: z.number().int(),
  tmdbId: z.number().int(),
  tvdbId: z.number().int().nullish(),
  imdbId: z.string().nullish(),
  title: z.string(),
  sortTitle: z.string(),
  cleanTitle: z.string(),
  year: z.number().int(),
  overview: z.string(),
  status: SeriesStatus,
  network: z.string().nullish(),
  runtimeMinutes: z.number().int().nullish(),
  genres: z.array(z.string()),
  images: z.array(MediaImage),
  ratings: Ratings,
  certification: z.string().nullish(),
  originalLanguage: z.string(),
  path: z.string(),
  rootFolderPath: z.string(),
  qualityProfileId: z.number().int(),
  monitored: z.boolean(),
  monitorNewItems: NewItemMonitor,
  seriesType: SeriesType,
  seasonFolder: z.boolean(),
  useSceneNumbering: z.boolean(),
  /** Subtitle language profile (subtitles module); null = no subtitles wanted. */
  languageProfileId: z.number().int().nullish(),
  tags: z.array(z.number().int()),
  /** Version slots; null = unversioned (one file per episode). */
  versions: z.array(MediaVersion).nullish(),
  added: isoDate(),
  lastRefreshed: isoDate().nullish(),
  seasons: z.array(Season),
  statistics: SeriesStatistics.nullish(),
});
export type Series = z.infer<typeof Series>;

export const Episode = z.object({
  id: z.number().int(),
  seriesId: z.number().int(),
  tmdbId: z.number().int().nullish(),
  seasonNumber: z.number().int().min(0),
  episodeNumber: z.number().int().min(0),
  absoluteEpisodeNumber: z.number().int().nullish(),
  title: z.string(),
  overview: z.string(),
  airDate: z.string().nullish().describe('YYYY-MM-DD in the network timezone'),
  airDateUtc: isoDate().nullish(),
  runtimeMinutes: z.number().int().nullish(),
  monitored: z.boolean(),
  /** True when any version has a file. */
  hasFile: z.boolean(),
  /** The primary file (the unversioned one, else the first configured version's). */
  episodeFileId: z.number().int().nullish(),
  unverifiedSceneNumbering: z.boolean(),
  /** Every file of the episode with its version tag (filled on single-series reads). */
  files: z.array(MediaFileVersion).optional(),
});
export type Episode = z.infer<typeof Episode>;

export const AddSeriesRequest = z.object({
  tmdbId: z.number().int().positive(),
  rootFolderPath: z.string().min(1),
  qualityProfileId: z.number().int(),
  monitored: z.boolean().default(true),
  monitorOption: MonitorOption.default('all'),
  monitorNewItems: NewItemMonitor.default('all'),
  seriesType: SeriesType.default('standard'),
  seasonFolder: z.boolean().default(true),
  /** Subtitle language profile; omitted = the subtitles default profile, null = none. */
  languageProfileId: z.number().int().nullable().optional(),
  tags: z.array(z.number().int()).default([]),
  /** Version slots; omit for an unversioned series. */
  versions: MediaVersions.nullable().optional(),
  searchOnAdd: z.boolean().default(false),
});
export type AddSeriesRequest = z.infer<typeof AddSeriesRequest>;

export const SeasonMonitorUpdate = z.object({
  seasonNumber: z.number().int().min(0),
  monitored: z.boolean(),
});
export type SeasonMonitorUpdate = z.infer<typeof SeasonMonitorUpdate>;

export const UpdateSeriesRequest = z.object({
  monitored: z.boolean().optional(),
  monitorNewItems: NewItemMonitor.optional(),
  qualityProfileId: z.number().int().optional(),
  seriesType: SeriesType.optional(),
  seasonFolder: z.boolean().optional(),
  useSceneNumbering: z.boolean().optional(),
  /** Subtitle language profile; null clears it. */
  languageProfileId: z.number().int().nullable().optional(),
  rootFolderPath: z.string().min(1).optional(),
  /** Set explicitly to override the generated `<root>/<Title (Year)>` folder. */
  path: z.string().min(1).optional(),
  tags: z.array(z.number().int()).optional(),
  seasons: z.array(SeasonMonitorUpdate).optional(),
  /** Version slots; null clears them (back to one unversioned file per episode). */
  versions: MediaVersions.nullable().optional(),
});
export type UpdateSeriesRequest = z.infer<typeof UpdateSeriesRequest>;

export const TagListChange = z.object({
  add: z.array(z.number().int()).optional(),
  remove: z.array(z.number().int()).optional(),
});
export type TagListChange = z.infer<typeof TagListChange>;

export const BulkSeriesUpdateRequest = z.object({
  ids: idList().min(1),
  monitored: z.boolean().optional(),
  /** When set alongside `monitored: true`, re-applies this option to every series' episodes. */
  monitorOption: MonitorOption.optional(),
  monitorNewItems: NewItemMonitor.optional(),
  qualityProfileId: z.number().int().optional(),
  seriesType: SeriesType.optional(),
  seasonFolder: z.boolean().optional(),
  rootFolderPath: z.string().min(1).optional(),
  tags: TagListChange.optional(),
  /** Queue a metadata refresh of every listed series after the update. */
  refresh: z.boolean().optional(),
  /** Queue a search for every listed series after the update. */
  search: z.boolean().optional(),
});
export type BulkSeriesUpdateRequest = z.infer<typeof BulkSeriesUpdateRequest>;

export const EpisodeMonitorUpdate = z.object({
  monitored: z.boolean(),
});
export type EpisodeMonitorUpdate = z.infer<typeof EpisodeMonitorUpdate>;

export const BulkEpisodeMonitorRequest = z.object({
  episodeIds: idList().min(1),
  monitored: z.boolean(),
});
export type BulkEpisodeMonitorRequest = z.infer<typeof BulkEpisodeMonitorRequest>;

export const DeleteMediaQuery = z.object({
  deleteFiles: queryFlag().default(false),
  addExclusion: queryFlag().default(false),
});
export type DeleteMediaQuery = z.infer<typeof DeleteMediaQuery>;

export const SortOrder = z.enum(['asc', 'desc']);
export type SortOrder = z.infer<typeof SortOrder>;

export const SeriesSortKey = z.enum(['sortTitle', 'added', 'year', 'status', 'qualityProfileId', 'path']);
export type SeriesSortKey = z.infer<typeof SeriesSortKey>;

export const SeriesListQuery = z.object({
  monitored: queryFlag().optional(),
  status: SeriesStatus.optional(),
  seriesType: SeriesType.optional(),
  qualityProfileId: z.coerce.number().int().optional(),
  rootFolderPath: z.string().optional(),
  tag: z.coerce.number().int().optional(),
  tmdbId: z.coerce.number().int().optional(),
  /** Case-insensitive substring match on title. */
  search: z.string().optional(),
  includeStatistics: queryFlag().default(true),
  sortKey: SeriesSortKey.default('sortTitle'),
  sortOrder: SortOrder.default('asc'),
});
export type SeriesListQuery = z.infer<typeof SeriesListQuery>;

export const EpisodeListQuery = z.object({
  seriesId: z.coerce.number().int(),
  seasonNumber: z.coerce.number().int().min(0).optional(),
  monitored: queryFlag().optional(),
  hasFile: queryFlag().optional(),
});
export type EpisodeListQuery = z.infer<typeof EpisodeListQuery>;

// ---------------------------------------------------------------------------------------
// Movies
// ---------------------------------------------------------------------------------------

export const MovieStatus = z.enum(['tba', 'announced', 'inCinemas', 'released', 'deleted']);
export type MovieStatus = z.infer<typeof MovieStatus>;

export const MinimumAvailability = z.enum(['announced', 'inCinemas', 'released']);
export type MinimumAvailability = z.infer<typeof MinimumAvailability>;

export const MovieStatistics = z.object({
  sizeOnDisk: z.number().int(),
  movieFileCount: z.number().int(),
});
export type MovieStatistics = z.infer<typeof MovieStatistics>;

export const Movie = z.object({
  id: z.number().int(),
  tmdbId: z.number().int(),
  imdbId: z.string().nullish(),
  title: z.string(),
  originalTitle: z.string(),
  sortTitle: z.string(),
  cleanTitle: z.string(),
  year: z.number().int(),
  overview: z.string(),
  status: MovieStatus,
  inCinemas: isoDate().nullish(),
  digitalRelease: isoDate().nullish(),
  physicalRelease: isoDate().nullish(),
  runtimeMinutes: z.number().int().nullish(),
  studio: z.string().nullish(),
  genres: z.array(z.string()),
  images: z.array(MediaImage),
  ratings: Ratings,
  certification: z.string().nullish(),
  originalLanguage: z.string(),
  collection: MovieCollection.nullish(),
  path: z.string(),
  rootFolderPath: z.string(),
  qualityProfileId: z.number().int(),
  minimumAvailability: MinimumAvailability,
  monitored: z.boolean(),
  /** Subtitle language profile (subtitles module); null = no subtitles wanted. */
  languageProfileId: z.number().int().nullish(),
  tags: z.array(z.number().int()),
  added: isoDate(),
  lastRefreshed: isoDate().nullish(),
  /** Version slots; null = unversioned (one file per movie). */
  versions: z.array(MediaVersion).nullish(),
  /** True when any version has a file. */
  hasFile: z.boolean(),
  /** The primary file (the unversioned one, else the first configured version's). */
  movieFileId: z.number().int().nullish(),
  /** Every file of the movie with its version tag. */
  files: z.array(MediaFileVersion).optional(),
  /** Wanted lists only: the enabled version slots that are missing / below cutoff. */
  wantedVersions: z.array(z.string()).optional(),
  /** True when the movie is considered obtainable under its minimumAvailability. */
  isAvailable: z.boolean(),
  statistics: MovieStatistics.nullish(),
});
export type Movie = z.infer<typeof Movie>;

export const AddMovieRequest = z.object({
  tmdbId: z.number().int().positive(),
  rootFolderPath: z.string().min(1),
  qualityProfileId: z.number().int(),
  monitored: z.boolean().default(true),
  minimumAvailability: MinimumAvailability.default('released'),
  /** Subtitle language profile; omitted = the subtitles default profile, null = none. */
  languageProfileId: z.number().int().nullable().optional(),
  tags: z.array(z.number().int()).default([]),
  /** Version slots; omit for an unversioned movie. */
  versions: MediaVersions.nullable().optional(),
  searchOnAdd: z.boolean().default(false),
});
export type AddMovieRequest = z.infer<typeof AddMovieRequest>;

export const UpdateMovieRequest = z.object({
  monitored: z.boolean().optional(),
  qualityProfileId: z.number().int().optional(),
  /** Subtitle language profile; null clears it. */
  languageProfileId: z.number().int().nullable().optional(),

  minimumAvailability: MinimumAvailability.optional(),
  rootFolderPath: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  tags: z.array(z.number().int()).optional(),
  /** Version slots; null clears them (back to one unversioned file per movie). */
  versions: MediaVersions.nullable().optional(),
});
export type UpdateMovieRequest = z.infer<typeof UpdateMovieRequest>;

export const BulkMovieUpdateRequest = z.object({
  ids: idList().min(1),
  monitored: z.boolean().optional(),
  qualityProfileId: z.number().int().optional(),
  minimumAvailability: MinimumAvailability.optional(),
  rootFolderPath: z.string().min(1).optional(),
  tags: TagListChange.optional(),
  /** Queue a metadata refresh of every listed movie after the update. */
  refresh: z.boolean().optional(),
  /** Queue a search for every listed movie after the update. */
  search: z.boolean().optional(),
});
export type BulkMovieUpdateRequest = z.infer<typeof BulkMovieUpdateRequest>;

export const MovieSortKey = z.enum(['sortTitle', 'added', 'year', 'status', 'inCinemas', 'qualityProfileId', 'path']);
export type MovieSortKey = z.infer<typeof MovieSortKey>;

export const MovieListQuery = z.object({
  monitored: queryFlag().optional(),
  hasFile: queryFlag().optional(),
  status: MovieStatus.optional(),
  minimumAvailability: MinimumAvailability.optional(),
  qualityProfileId: z.coerce.number().int().optional(),
  rootFolderPath: z.string().optional(),
  tag: z.coerce.number().int().optional(),
  tmdbId: z.coerce.number().int().optional(),
  search: z.string().optional(),
  sortKey: MovieSortKey.default('sortTitle'),
  sortOrder: SortOrder.default('asc'),
});
export type MovieListQuery = z.infer<typeof MovieListQuery>;

// ---------------------------------------------------------------------------------------
// Media files
// ---------------------------------------------------------------------------------------

/** One audio track as read by the media-analysis module (ffprobe). */
export const MediaAudioStream = z.object({
  /** Probe codec id, e.g. `eac3`, `truehd`, `dts`. */
  codec: z.string(),
  /** Probe profile, e.g. `DTS-HD MA`, `Dolby TrueHD + Dolby Atmos`. */
  profile: z.string().nullish(),
  channels: z.number().int().nullish(),
  /** e.g. `5.1(side)`, `stereo`. */
  channelLayout: z.string().nullish(),
  /** ISO 639-2 code as tagged in the container (`eng`); null when untagged/`und`. */
  language: z.string().nullish(),
  bitrate: z.number().int().nullish().describe('bits per second'),
  title: z.string().nullish(),
  default: z.boolean().optional(),
});
export type MediaAudioStream = z.infer<typeof MediaAudioStream>;

/** One embedded subtitle track. */
export const MediaSubtitleStream = z.object({
  /** e.g. `subrip`, `ass`, `hdmv_pgs_subtitle`. */
  codec: z.string(),
  language: z.string().nullish(),
  forced: z.boolean(),
  /** Hearing impaired / SDH. */
  hearingImpaired: z.boolean(),
  default: z.boolean().optional(),
  title: z.string().nullish(),
});
export type MediaSubtitleStream = z.infer<typeof MediaSubtitleStream>;

export const MediaInfo = z.object({
  /** Friendly name (`x265`, `HEVC`, `AVC`, `AV1` ...). */
  videoCodec: z.string().nullish(),
  /** Friendly name of the primary audio track (`EAC3 Atmos`, `DTS-HD MA` ...). */
  audioCodec: z.string().nullish(),
  audioChannels: z.number().nullish(),
  resolution: z.string().nullish().describe('e.g. 1920x1080'),
  runtimeSeconds: z.number().int().nullish(),
  videoDynamicRange: z.string().nullish().describe('SDR, HDR10, HDR10Plus, HLG, PQ, DV, DV HDR10 ...'),
  subtitles: z.array(z.string()).nullish(),
  audioLanguages: z.array(z.string()).nullish(),
  // ---- richer probe fields (media-analysis module); all optional ------------------------
  /** Container format, e.g. `matroska`, `mp4`. */
  container: z.string().nullish(),
  durationMs: z.number().int().nullish(),
  overallBitrate: z.number().int().nullish().describe('bits per second'),
  /** Probe codec id of the video track, e.g. `hevc`, `h264`. */
  videoFormat: z.string().nullish(),
  /** Codec tag, e.g. `hvc1`, `xvid`, when meaningful. */
  videoCodecId: z.string().nullish(),
  videoProfile: z.string().nullish(),
  videoBitDepth: z.number().int().nullish(),
  videoBitrate: z.number().int().nullish(),
  videoFps: z.number().nullish(),
  width: z.number().int().nullish(),
  height: z.number().int().nullish(),
  /** Same vocabulary as `videoDynamicRange` (the organizer's `{MediaInfo VideoDynamicRangeType}`). */
  videoDynamicRangeType: z.string().nullish(),
  /** Dolby Vision profile (5, 7, 8 ...) when present. */
  doviProfile: z.number().int().nullish(),
  colorPrimaries: z.string().nullish(),
  colorTransfer: z.string().nullish(),
  scanType: z.enum(['Progressive', 'Interlaced']).nullish(),
  audioFormat: z.string().nullish(),
  audioProfile: z.string().nullish(),
  audioChannelPositions: z.string().nullish(),
  audioBitrate: z.number().int().nullish(),
  audioStreamCount: z.number().int().nullish(),
  audioStreams: z.array(MediaAudioStream).nullish(),
  subtitleStreams: z.array(MediaSubtitleStream).nullish(),
});
export type MediaInfo = z.infer<typeof MediaInfo>;

/**
 * A file kept by the user's choice: its release was grabbed with "Grab anyway" although the
 * rules rejected it. Automatic searches (RSS, upgrade, cutoff) do not replace such a file until
 * the user allows upgrades again; interactive search still can. Video and audio files alike.
 */
export const GrabOverride = z.object({
  /** The rejection messages the user overrode when grabbing. */
  rejections: z.array(z.string()),
  /** When the override was recorded (the grab). */
  grabbedAt: isoDate(),
  /** The grabbed release title. */
  sourceTitle: z.string().nullish(),
});
export type GrabOverride = z.infer<typeof GrabOverride>;

export const MediaFile = z.object({
  id: z.number().int(),
  mediaType: MediaType,
  seriesId: z.number().int().nullish(),
  movieId: z.number().int().nullish(),
  seasonNumber: z.number().int().nullish(),
  /** Episodes this file covers (multi-episode files are one row). Empty for movies. */
  episodeIds: z.array(z.number().int()),
  relativePath: z.string().describe('relative to the series/movie folder'),
  path: z.string(),
  sizeBytes: z.number().int(),
  dateAdded: isoDate(),
  quality: QualityModel,
  languages: z.array(z.string()),
  releaseGroup: z.string().nullish(),
  sceneName: z.string().nullish(),
  edition: z.string().nullish(),
  mediaInfo: MediaInfo.nullish(),
  /** Version slot the file fills (`4K`, `HDR`, ...); null = unversioned. */
  versionTag: z.string().nullish(),
  /** Set when the file came from a "Grab anyway" grab; upgrades are paused while it is set. */
  grabOverride: GrabOverride.nullish(),
});
export type MediaFile = z.infer<typeof MediaFile>;

export const MediaFileListQuery = z
  .object({
    seriesId: z.coerce.number().int().optional(),
    movieId: z.coerce.number().int().optional(),
    seasonNumber: z.coerce.number().int().optional(),
  })
  .refine((q) => q.seriesId !== undefined || q.movieId !== undefined, {
    message: 'seriesId or movieId is required',
  });
export type MediaFileListQuery = z.infer<typeof MediaFileListQuery>;

export const DeleteMediaFileQuery = z.object({
  deleteFromDisk: queryFlag().default(true),
});
export type DeleteMediaFileQuery = z.infer<typeof DeleteMediaFileQuery>;

// ---------------------------------------------------------------------------------------
// Wanted
// ---------------------------------------------------------------------------------------

export const PageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});
export type PageQuery = z.infer<typeof PageQuery>;

export const WantedEpisodesQuery = PageQuery.extend({
  includeSpecials: queryFlag().default(false),
  /** Text search (list-search.ts): every word must match. */
  q: ListSearchParam,
});
export type WantedEpisodesQuery = z.infer<typeof WantedEpisodesQuery>;

/** GET /wanted/missing/movies and /wanted/cutoff/movies. */
export const WantedMoviesQuery = PageQuery.extend({
  /** Text search (list-search.ts): every word must match. */
  q: ListSearchParam,
});
export type WantedMoviesQuery = z.infer<typeof WantedMoviesQuery>;

export const WantedEpisode = Episode.extend({
  seriesTitle: z.string(),
  seriesTmdbId: z.number().int(),
  qualityProfileId: z.number().int(),
  /** Versioned series: the enabled version slots that are missing / below cutoff. */
  wantedVersions: z.array(z.string()).optional(),
});
export type WantedEpisode = z.infer<typeof WantedEpisode>;

export const Paged = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    page: z.number().int(),
    pageSize: z.number().int(),
    totalRecords: z.number().int(),
    records: z.array(item),
  });

export const WantedEpisodesPage = Paged(WantedEpisode);
export type WantedEpisodesPage = z.infer<typeof WantedEpisodesPage>;

export const WantedMoviesPage = Paged(Movie);
export type WantedMoviesPage = z.infer<typeof WantedMoviesPage>;

// ---------------------------------------------------------------------------------------
// Library-wide statistics
// ---------------------------------------------------------------------------------------

export const LibraryStatistics = z.object({
  seriesCount: z.number().int(),
  monitoredSeriesCount: z.number().int(),
  endedSeriesCount: z.number().int(),
  continuingSeriesCount: z.number().int(),
  episodeCount: z.number().int(),
  episodeFileCount: z.number().int(),
  movieCount: z.number().int(),
  monitoredMovieCount: z.number().int(),
  movieFileCount: z.number().int(),
  sizeOnDisk: z.number().int(),
  rootFolders: z.array(RootFolder),
  // Music (filled once the music module is registered; absent on video-only builds).
  artistCount: z.number().int().optional(),
  monitoredArtistCount: z.number().int().optional(),
  albumCount: z.number().int().optional(),
  monitoredAlbumCount: z.number().int().optional(),
  trackCount: z.number().int().optional(),
  trackFileCount: z.number().int().optional(),
  // Audiobooks (only while `features.audiobooks` is on).
  authorCount: z.number().int().optional(),
  monitoredAuthorCount: z.number().int().optional(),
  bookCount: z.number().int().optional(),
  monitoredBookCount: z.number().int().optional(),
  /** Books with at least one file. */
  bookFileCount: z.number().int().optional(),
  /** Bytes of audio files (music and audiobooks); `sizeOnDisk` stays video-only. */
  audioSizeOnDisk: z.number().int().optional(),
});
export type LibraryStatistics = z.infer<typeof LibraryStatistics>;

export const ImportExclusion = z.object({
  id: z.number().int(),
  mediaType: MediaType,
  tmdbId: z.number().int(),
  title: z.string(),
  year: z.number().int().nullish(),
});
export type ImportExclusion = z.infer<typeof ImportExclusion>;

export const ErrorResponse = z.object({
  error: z.string(),
  code: z.string().optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

/**
 * When an episode aired, in ms: the UTC instant, or else the start of its air date (UTC). Null
 * when neither is known. Rows imported without `airDateUtc` but with an `airDate` used to count
 * as never aired on the server (missing from totals and from the Missing search) while the web
 * already showed them as wanted.
 */
export function episodeAiredMs(ep: { airDate?: string | null | undefined; airDateUtc?: string | null | undefined }): number | null {
  if (ep.airDateUtc) {
    const ms = Date.parse(ep.airDateUtc);
    if (!Number.isNaN(ms)) return ms;
  }
  if (ep.airDate && /^\d{4}-\d{2}-\d{2}$/.test(ep.airDate)) {
    const ms = Date.parse(`${ep.airDate}T00:00:00Z`);
    if (!Number.isNaN(ms)) return ms;
  }
  return null;
}

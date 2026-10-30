import { z } from 'zod';
import { AnyMediaType, MediaType, SortOrder } from './library.js';
import { LanguageCode, ReleaseProtocol } from './profiles.js';
import { QualityModel } from './quality.js';
import { ListSearchParam } from './list-search.js';

// History (the user-visible activity log) and the blocklist (releases that must not be
// grabbed again). See docs/spec/history-and-blocklist.md.

// ---------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------

const queryBool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

/** Accepts `1,2,3`, repeated query params, or a JSON array. */
const intList = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const parts = (Array.isArray(value) ? value : [value]).flatMap((v) => String(v).split(','));
  return parts.map((p) => p.trim()).filter((p) => p !== '').map(Number);
}, z.array(z.number().int().min(0)).optional());

const listOf = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return undefined;
    const parts = (Array.isArray(value) ? value : [value]).flatMap((v) => String(v).split(','));
    return parts.map((p) => p.trim()).filter((p) => p !== '');
  }, z.array(item).optional());

// ---------------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------------

/**
 * One enum for both media types (spec 1.2). The deprecated "series/movie folder imported"
 * slots are never written upstream and are deliberately not part of this enum.
 */
export const HistoryEventType = z.enum([
  'unknown',
  'grabbed',
  'downloadFolderImported',
  'downloadFailed',
  'fileDeleted',
  'fileRenamed',
  'downloadIgnored',
  // A library file was remuxed or transcoded in place (transcode module).
  'fileTranscoded',
  // The quality profile of an item (or a version slot) changed (profile-migration module).
  'profileChanged',
  // A file was replaced because it did not meet its (new) quality profile (profile-migration module).
  'profileReplaced',
  // "Add additional…" asked for an audio/subtitle language, and what came of it (data.outcome).
  'additionalLanguage',
]);
export type HistoryEventType = z.infer<typeof HistoryEventType>;

/** Why a library file was deleted (spec 1.3.4). */
export const HistoryDeleteReason = z.enum(['MissingFromDisk', 'Manual', 'Upgrade', 'NoLinkedEpisodes', 'ManualOverride']);
export type HistoryDeleteReason = z.infer<typeof HistoryDeleteReason>;

/** Where a grabbed release came from; stored in history data as `releaseSource`. */
export const HistoryReleaseSource = z.enum(['unknown', 'rss', 'search', 'userInvokedSearch', 'interactiveSearch', 'releasePush']);
export type HistoryReleaseSource = z.infer<typeof HistoryReleaseSource>;

/**
 * Free-form string map. Keys are normalised to camelCase on write (`Indexer` -> `indexer`)
 * so readers can ask for either casing. Well-known keys: indexer, nzbInfoUrl, releaseGroup,
 * age, ageHours, ageMinutes, publishedDate, downloadClient, downloadClientName, size,
 * downloadUrl, guid, protocol, customFormatScore, releaseSource, indexerFlags,
 * torrentInfoHash, releaseType, seriesMatchType/movieMatchType, fileId, droppedPath,
 * importedPath, reason, sourcePath, sourceRelativePath, path, relativePath, message, source.
 */
export const HistoryData = z.record(z.string(), z.string());
export type HistoryData = z.infer<typeof HistoryData>;

export const HistoryCustomFormat = z.object({ id: z.number().int(), name: z.string() });
export type HistoryCustomFormat = z.infer<typeof HistoryCustomFormat>;

export const HistorySeriesSummary = z.object({
  id: z.number().int(),
  title: z.string(),
  sortTitle: z.string(),
  year: z.number().int(),
  qualityProfileId: z.number().int(),
});
export type HistorySeriesSummary = z.infer<typeof HistorySeriesSummary>;

export const HistoryEpisodeSummary = z.object({
  id: z.number().int(),
  seriesId: z.number().int(),
  seasonNumber: z.number().int(),
  episodeNumber: z.number().int(),
  title: z.string(),
  airDate: z.string().nullable(),
});
export type HistoryEpisodeSummary = z.infer<typeof HistoryEpisodeSummary>;

export const HistoryMovieSummary = z.object({
  id: z.number().int(),
  title: z.string(),
  sortTitle: z.string(),
  year: z.number().int(),
  qualityProfileId: z.number().int(),
});
export type HistoryMovieSummary = z.infer<typeof HistoryMovieSummary>;

export const HistoryRecord = z.object({
  id: z.number().int(),
  eventType: HistoryEventType,
  mediaType: AnyMediaType,
  seriesId: z.number().int().nullable(),
  episodeId: z.number().int().nullable(),
  movieId: z.number().int().nullable(),
  /** Music rows: the artist and the albums of the event (absent on video rows). */
  artistId: z.number().int().nullable().optional(),
  albumIds: z.array(z.number().int()).optional(),
  /** Audiobook rows: the author and the books of the event (absent on other rows). */
  authorId: z.number().int().nullable().optional(),
  bookIds: z.array(z.number().int()).optional(),
  sourceTitle: z.string(),
  quality: QualityModel,
  languages: z.array(LanguageCode),
  /** Recomputed at read time when a resolver is available; empty otherwise. */
  customFormats: z.array(HistoryCustomFormat),
  /** Score stored at grab/import time (data `customFormatScore`), 0 when absent. */
  customFormatScore: z.number().int(),
  /** ISO-8601 UTC, set at insert. */
  date: z.string(),
  downloadId: z.string().nullable(),
  data: HistoryData,
  series: HistorySeriesSummary.optional(),
  episode: HistoryEpisodeSummary.optional(),
  movie: HistoryMovieSummary.optional(),
});
export type HistoryRecord = z.infer<typeof HistoryRecord>;

export const HistorySortKey = z.enum(['date', 'sourceTitle', 'title', 'quality', 'eventType']);
export type HistorySortKey = z.infer<typeof HistorySortKey>;

export const HistoryListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(1000).default(20),
  sortKey: HistorySortKey.default('date'),
  sortDirection: SortOrder.default('desc'),
  /** One or more event types (comma separated or repeated). */
  eventType: listOf(HistoryEventType),
  mediaType: AnyMediaType.optional(),
  seriesId: intList,
  /** Music: rows of these artists. */
  artistId: intList,
  /** Music: rows that cover this album. */
  albumId: z.coerce.number().int().optional(),
  /** Audiobooks: rows of these authors. */
  authorId: intList,
  /** Audiobooks: rows that cover this book. */
  bookId: z.coerce.number().int().optional(),
  episodeId: z.coerce.number().int().optional(),
  movieId: intList,
  downloadId: z.string().min(1).optional(),
  /** Quality ids (revision ignored); any of. */
  quality: intList,
  /** Language codes; any of. */
  language: listOf(LanguageCode),
  includeSeries: queryBool.default(false),
  includeEpisode: queryBool.default(false),
  includeMovie: queryBool.default(false),
  /** Text search (list-search.ts): every word must match. */
  q: ListSearchParam,
});
export type HistoryListQuery =z.infer<typeof HistoryListQuery>;
export type HistoryListQueryInput = z.input<typeof HistoryListQuery>;

export const HistoryPage = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  sortKey: HistorySortKey,
  sortDirection: SortOrder,
  totalRecords: z.number().int(),
  records: z.array(HistoryRecord),
});
export type HistoryPage = z.infer<typeof HistoryPage>;

export const HistorySinceQuery = z.object({
  date: z.string().datetime({ offset: true }),
  eventType: HistoryEventType.optional(),
  includeSeries: queryBool.default(false),
  includeEpisode: queryBool.default(false),
  includeMovie: queryBool.default(false),
});
export type HistorySinceQuery = z.infer<typeof HistorySinceQuery>;

export const HistorySeriesQuery = z.object({
  seriesId: z.coerce.number().int().min(1),
  seasonNumber: z.coerce.number().int().min(0).optional(),
  eventType: HistoryEventType.optional(),
  includeSeries: queryBool.default(false),
  includeEpisode: queryBool.default(false),
});
export type HistorySeriesQuery = z.infer<typeof HistorySeriesQuery>;

export const HistoryMovieQuery = z.object({
  movieId: z.coerce.number().int().min(1),
  eventType: HistoryEventType.optional(),
  includeMovie: queryBool.default(false),
});
export type HistoryMovieQuery = z.infer<typeof HistoryMovieQuery>;

export const HistoryMarkFailedRequest = z
  .object({
    message: z.string().min(1).optional(),
    skipRedownload: z.boolean().default(false),
  })
  .default({ skipRedownload: false });
export type HistoryMarkFailedRequest = z.infer<typeof HistoryMarkFailedRequest>;

export const HistoryErrorResponse = z.object({ error: z.string(), code: z.string().optional() });
export type HistoryErrorResponse = z.infer<typeof HistoryErrorResponse>;

// ---------------------------------------------------------------------------------------
// Blocklist
// ---------------------------------------------------------------------------------------

export const BlocklistRecord = z.object({
  id: z.number().int(),
  mediaType: AnyMediaType,
  seriesId: z.number().int().nullable(),
  /** TV: the episodes of the blocked grab. Empty for movies. */
  episodeIds: z.array(z.number().int()),
  movieId: z.number().int().nullable(),
  /** Music: the artist the entry is scoped to and the albums of the blocked grab. */
  artistId: z.number().int().nullable().optional(),
  albumIds: z.array(z.number().int()).optional(),
  /** Audiobooks: the author the entry is scoped to and the books of the blocked grab. */
  authorId: z.number().int().nullable().optional(),
  bookIds: z.array(z.number().int()).optional(),
  sourceTitle: z.string(),
  quality: QualityModel,
  languages: z.array(LanguageCode),
  /** ISO-8601 UTC, set at insert. */
  date: z.string(),
  /** ISO-8601; null when the release had none. */
  publishedDate: z.string().nullable(),
  /** Bytes; null when unknown. */
  size: z.number().int().nullable(),
  protocol: ReleaseProtocol,
  indexer: z.string().nullable(),
  indexerFlags: z.array(z.string()),
  message: z.string().nullable(),
  /** Lower-case hex; torrents only. */
  torrentInfoHash: z.string().nullable(),
  /** What created the entry (e.g. "TorrentFileValidation"); null when unknown. */
  source: z.string().nullable(),
  /** TV release type (singleEpisode, multiEpisode, seasonPack); null for movies. */
  releaseType: z.string().nullable(),
  customFormats: z.array(HistoryCustomFormat),
});
export type BlocklistRecord = z.infer<typeof BlocklistRecord>;

export const BlocklistAddRequest = z
  .object({
    mediaType: MediaType,
    seriesId: z.number().int().min(1).optional(),
    episodeIds: z.array(z.number().int().min(1)).default([]),
    movieId: z.number().int().min(1).optional(),
    sourceTitle: z.string().min(1),
    quality: QualityModel,
    languages: z.array(LanguageCode).default([]),
    publishedDate: z.string().datetime({ offset: true }).nullish(),
    size: z.number().int().min(0).nullish(),
    protocol: ReleaseProtocol,
    indexer: z.string().nullish(),
    indexerFlags: z.array(z.string()).default([]),
    message: z.string().nullish(),
    torrentInfoHash: z.string().nullish(),
    source: z.string().nullish(),
    releaseType: z.string().nullish(),
  })
  .refine((r) => (r.mediaType === 'series' ? r.seriesId !== undefined : r.movieId !== undefined), {
    message: 'seriesId is required for series entries, movieId for movie entries',
  });
export type BlocklistAddRequest = z.infer<typeof BlocklistAddRequest>;
export type BlocklistAddRequestInput = z.input<typeof BlocklistAddRequest>;

export const BlocklistSortKey = z.enum(['date', 'indexer', 'sourceTitle', 'title', 'quality']);
export type BlocklistSortKey = z.infer<typeof BlocklistSortKey>;

export const BlocklistListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(1000).default(20),
  sortKey: BlocklistSortKey.default('date'),
  sortDirection: SortOrder.default('desc'),
  mediaType: AnyMediaType.optional(),
  seriesId: intList,
  movieId: intList,
  artistId: intList,
  authorId: intList,
  protocol: listOf(ReleaseProtocol),
  /** Text search (list-search.ts): every word must match. */
  q: ListSearchParam,
});
export type BlocklistListQuery = z.infer<typeof BlocklistListQuery>;
export type BlocklistListQueryInput = z.input<typeof BlocklistListQuery>;

export const BlocklistPage = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  sortKey: BlocklistSortKey,
  sortDirection: SortOrder,
  totalRecords: z.number().int(),
  records: z.array(BlocklistRecord),
});
export type BlocklistPage = z.infer<typeof BlocklistPage>;

export const BlocklistBulkDeleteRequest = z.object({ ids: z.array(z.number().int().min(1)).min(1) });
export type BlocklistBulkDeleteRequest = z.infer<typeof BlocklistBulkDeleteRequest>;

export const BlocklistSeriesQuery = z.object({ seriesId: z.coerce.number().int().min(1) });
export type BlocklistSeriesQuery = z.infer<typeof BlocklistSeriesQuery>;

export const BlocklistMovieQuery = z.object({ movieId: z.coerce.number().int().min(1) });
export type BlocklistMovieQuery = z.infer<typeof BlocklistMovieQuery>;

export const BlocklistDeleteResult = z.object({ deleted: z.number().int() });
export type BlocklistDeleteResult = z.infer<typeof BlocklistDeleteResult>;

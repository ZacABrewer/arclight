import { z } from 'zod';
import { ReleaseResource } from './indexers.js';
import { MediaType } from './library.js';
import { ReleaseProtocol } from './profiles.js';
import { QualityModel } from './quality.js';

// Releases contract: decisions the engine reaches about indexer results, grab requests,
// the delayed-release (pending) queue and the search/push request shapes.

/** Where a batch of releases came from; some specs behave differently by source. */
export const ReleaseSource = z.enum(['rss', 'search', 'userInvokedSearch', 'interactiveSearch', 'releasePush']);
export type ReleaseSource = z.infer<typeof ReleaseSource>;

export const RejectionType = z.enum(['permanent', 'temporary']);
export type RejectionType = z.infer<typeof RejectionType>;

/** One failed check. `reason` is the stable code (decision-engine spec §14), `message` is for humans. */
export const ReleaseRejection = z.object({
  reason: z.string(),
  message: z.string(),
  type: RejectionType,
});
export type ReleaseRejection = z.infer<typeof ReleaseRejection>;

/** The verdict on one release. Extends the indexer's resource so the UI can show both at once. */
export const ReleaseDecision = ReleaseResource.omit({ rejections: true, approved: true }).extend({
  rejections: z.array(ReleaseRejection),
  approved: z.boolean(),
  temporarilyRejected: z.boolean(),
  /** True when the release may be grabbed (approved, or the user overrides a rejection interactively). */
  downloadAllowed: z.boolean(),
  source: ReleaseSource,
  mediaType: MediaType.optional(),
  seriesId: z.number().int().optional(),
  seriesTitle: z.string().optional(),
  episodeIds: z.array(z.number().int()).optional(),
  movieId: z.number().int().optional(),
  movieTitle: z.string().optional(),
  /** Multi-version items: the version slot the release was evaluated for (best-fitting profile). */
  versionTag: z.string().optional(),
  quality: QualityModel,
  languages: z.array(z.string()),
  customFormats: z.array(z.object({ id: z.number().int(), name: z.string() })),
  customFormatScore: z.number().int(),
  releaseGroup: z.string().optional(),
  mappedSeasonNumber: z.number().int().optional(),
  mappedEpisodeNumbers: z.array(z.number().int()).optional(),
  mappedAbsoluteEpisodeNumbers: z.array(z.number().int()).optional(),
  fullSeason: z.boolean(),
  /** Remaining delay in minutes when the release is held back by a delay profile. */
  delayMinutes: z.number().int().optional(),
});
export type ReleaseDecision = z.infer<typeof ReleaseDecision>;

/**
 * POST /release. Grabs a release seen by a recent search (cached by guid + indexer). For
 * interactive grabs whose mapping was ambiguous the caller may pin the library item.
 */
export const ReleaseGrabRequest = z.object({
  guid: z.string().min(1),
  indexerId: z.number().int(),
  seriesId: z.number().int().optional(),
  episodeIds: z.array(z.number().int()).optional(),
  movieId: z.number().int().optional(),
  downloadClientId: z.number().int().optional(),
});
export type ReleaseGrabRequest = z.infer<typeof ReleaseGrabRequest>;
/** Alias used by the module code. */
export const GrabRequest = ReleaseGrabRequest;
export type GrabRequest = ReleaseGrabRequest;

export const ReleaseGrabResponse = z.object({
  title: z.string(),
  queueItemId: z.number().int(),
  downloadId: z.string(),
  downloadClientId: z.number().int().nullable(),
});
export type ReleaseGrabResponse = z.infer<typeof ReleaseGrabResponse>;

export const PendingReason = z.enum(['delay', 'fallback', 'downloadClientUnavailable']);
export type PendingReason = z.infer<typeof PendingReason>;

/** A release held back (delay profile, client down) until it becomes eligible. */
export const PendingRelease = z.object({
  id: z.number().int(),
  guid: z.string(),
  indexerId: z.number().int(),
  indexerName: z.string(),
  title: z.string(),
  protocol: ReleaseProtocol,
  size: z.number().int(),
  publishDate: z.string(),
  mediaType: MediaType,
  seriesId: z.number().int().optional(),
  episodeIds: z.array(z.number().int()).optional(),
  movieId: z.number().int().optional(),
  quality: QualityModel,
  customFormatScore: z.number().int(),
  reason: PendingReason,
  added: z.string(),
  /** ISO-8601 time the release becomes eligible for grabbing. */
  eligibleAt: z.string(),
  /** Whole minutes until eligible (0 when due). */
  remainingMinutes: z.number().int(),
});
export type PendingRelease = z.infer<typeof PendingRelease>;

const OptionalInt = z.coerce.number().int().min(0).optional();

/** GET /release: interactive search for a library item. */
export const ReleaseSearchQuery = z
  .object({
    seriesId: OptionalInt,
    seasonNumber: OptionalInt,
    episodeId: OptionalInt,
    movieId: OptionalInt,
  })
  .refine((q) => q.seriesId !== undefined || q.episodeId !== undefined || q.movieId !== undefined, {
    message: 'seriesId, episodeId or movieId is required',
  });
export type ReleaseSearchQuery = z.infer<typeof ReleaseSearchQuery>;

export const ReleaseSearchResponse = z.array(ReleaseDecision);
export type ReleaseSearchResponse = z.infer<typeof ReleaseSearchResponse>;

/** POST /release/push: a release announced by an external tool (Torznab-like fields). */
export const ReleasePushRequest = z.object({
  title: z.string().min(1),
  downloadUrl: z.string().min(1).optional(),
  magnetUrl: z.string().min(1).optional(),
  protocol: ReleaseProtocol,
  publishDate: z.string(),
  size: z.number().int().min(0).default(0),
  guid: z.string().optional(),
  infoUrl: z.string().optional(),
  infoHash: z.string().optional(),
  indexerId: z.number().int().optional(),
  indexer: z.string().optional(),
  seeders: z.number().int().optional(),
  leechers: z.number().int().optional(),
  tvdbId: z.number().int().optional(),
  tmdbId: z.number().int().optional(),
  imdbId: z.string().optional(),
  downloadClientId: z.number().int().optional(),
});
export type ReleasePushRequest = z.infer<typeof ReleasePushRequest>;

export const ReleasePushResponse = z.object({
  decision: ReleaseDecision.nullable(),
  grabbed: z.boolean(),
  pending: z.boolean(),
});
export type ReleasePushResponse = z.infer<typeof ReleasePushResponse>;

/** POST /command/search: trigger an automatic search (user invoked). */
export const SearchCommandRequest = z
  .object({
    seriesId: z.number().int().optional(),
    seasonNumber: z.number().int().min(0).optional(),
    episodeIds: z.array(z.number().int()).optional(),
    movieId: z.number().int().optional(),
  })
  .refine((q) => q.seriesId !== undefined || q.movieId !== undefined || (q.episodeIds?.length ?? 0) > 0, {
    message: 'seriesId, episodeIds or movieId is required',
  });
export type SearchCommandRequest = z.infer<typeof SearchCommandRequest>;

export const SearchCommandResponse = z.object({
  releases: z.number().int(),
  approved: z.number().int(),
  grabbed: z.array(z.string()),
  pending: z.number().int(),
});
export type SearchCommandResponse = z.infer<typeof SearchCommandResponse>;

export const ReleasesErrorResponse = z.object({ error: z.string(), code: z.string().optional() });
export type ReleasesErrorResponse = z.infer<typeof ReleasesErrorResponse>;

// ---- decision log -----------------------------------------------------------------------

/** Where a logged evaluation batch came from (coarser than `ReleaseSource`; `pending` = re-decided held releases). */
export const DecisionLogSource = z.enum(['rss', 'search', 'interactive', 'push', 'pending']);
export type DecisionLogSource = z.infer<typeof DecisionLogSource>;

/** One release as the engine judged it in one batch. */
export const DecisionLogEntry = z.object({
  id: z.number().int(),
  batchId: z.string(),
  /** ISO-8601 time of the batch. */
  time: z.string(),
  source: DecisionLogSource,
  mediaType: MediaType.nullable(),
  seriesId: z.number().int().nullable(),
  episodeIds: z.array(z.number().int()),
  movieId: z.number().int().nullable(),
  guid: z.string(),
  indexerId: z.number().int(),
  title: z.string(),
  quality: QualityModel,
  formats: z.array(z.object({ id: z.number().int(), name: z.string() })),
  score: z.number().int(),
  approved: z.boolean(),
  rejections: z.array(ReleaseRejection),
  /** The release was grabbed from this batch. */
  chosen: z.boolean(),
  /** 1-based position in the engine's preference order among the batch's releases for the same item; null when unranked (unmatched). */
  rank: z.number().int().nullable(),
});
export type DecisionLogEntry = z.infer<typeof DecisionLogEntry>;

/** One evaluation batch, decisions in rank order. */
export const DecisionLogBatch = z.object({
  batchId: z.string(),
  time: z.string(),
  source: DecisionLogSource,
  /** Rows in this batch (for the item when listed per item). */
  total: z.number().int(),
  approved: z.number().int(),
  /** True when a release of this batch was grabbed. */
  grabbed: z.boolean(),
  /** The grabbed row, else the best-ranked approved row; null when nothing qualified. */
  winnerId: z.number().int().nullable(),
  decisions: z.array(DecisionLogEntry),
});
export type DecisionLogBatch = z.infer<typeof DecisionLogBatch>;

/** GET /release/decisions: exactly one of seriesId, episodeId, movieId. */
export const DecisionLogQuery = z
  .object({
    seriesId: z.coerce.number().int().min(1).optional(),
    episodeId: z.coerce.number().int().min(1).optional(),
    movieId: z.coerce.number().int().min(1).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(10),
  })
  .refine((q) => [q.seriesId, q.episodeId, q.movieId].filter((v) => v !== undefined).length === 1, {
    message: 'exactly one of seriesId, episodeId or movieId is required',
  });
export type DecisionLogQuery = z.infer<typeof DecisionLogQuery>;

export const DecisionLogPage = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  totalRecords: z.number().int(),
  records: z.array(DecisionLogBatch),
});
export type DecisionLogPage = z.infer<typeof DecisionLogPage>;

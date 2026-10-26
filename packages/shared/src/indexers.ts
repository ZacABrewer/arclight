import { z } from 'zod';
import { ReleaseProtocol } from './profiles.js';

// Indexers: persistent Torznab/Newznab endpoint configuration, health (failure backoff),
// capabilities, and the release shape every search returns. The protocol clients live in
// @media-tron/indexers; these are the shapes the API serves and the release pipeline reads.

export const IndexerImplementation = z.enum(['torznab', 'newznab']);
export type IndexerImplementation = z.infer<typeof IndexerImplementation>;

/** Torznab endpoints serve torrents, Newznab endpoints serve usenet. */
export function protocolForImplementation(implementation: IndexerImplementation): ReleaseProtocol {
  return implementation === 'torznab' ? 'torrent' : 'usenet';
}

export const INDEXER_PRIORITY_MIN = 1;
export const INDEXER_PRIORITY_MAX = 50;
export const INDEXER_PRIORITY_DEFAULT = 25;

const CategoryId = z.number().int().min(0);
const Priority = z.number().int().min(INDEXER_PRIORITY_MIN).max(INDEXER_PRIORITY_MAX);
const NonNegativeInt = z.number().int().min(0);

/** Stored settings for one endpoint. Seed times are milliseconds; the rate limit is seconds. */
export const IndexerSettings = z.object({
  baseUrl: z.string(),
  apiPath: z.string(),
  apiKey: z.string().optional(),
  categories: z.array(CategoryId),
  animeCategories: z.array(CategoryId),
  minimumSeeders: NonNegativeInt.optional(),
  seedRatio: z.number().min(0).optional(),
  /** Milliseconds. */
  seedTime: NonNegativeInt.optional(),
  /** Milliseconds. */
  seasonPackSeedTime: NonNegativeInt.optional(),
  /** Raw query-string fragment appended to every request, e.g. `&attrs=poster`. */
  additionalParameters: z.string().optional(),
  /** Minimum seconds between two requests to this indexer. */
  rateLimitSeconds: z.number().min(0).optional(),
});
export type IndexerSettings = z.infer<typeof IndexerSettings>;

/** Settings as submitted: list/path fields fall back to defaults. */
export const IndexerSettingsInput = IndexerSettings.extend({
  baseUrl: z.string().trim().min(1),
  apiPath: z.string().trim().default('/api'),
  categories: z.array(CategoryId).default([]),
  animeCategories: z.array(CategoryId).default([]),
});
export type IndexerSettingsInput = z.input<typeof IndexerSettingsInput>;

export const IndexerStatusSummary = z.object({
  failureCount: NonNegativeInt,
  /** ISO-8601; the indexer is skipped by RSS and searches until then. */
  disabledTill: z.string().optional(),
  lastFailure: z.string().optional(),
  mostRecentFailure: z.string().optional(),
});
export type IndexerStatusSummary = z.infer<typeof IndexerStatusSummary>;

export const Indexer = z.object({
  id: z.number().int(),
  name: z.string(),
  implementation: IndexerImplementation,
  protocol: ReleaseProtocol,
  enableRss: z.boolean(),
  enableAutomaticSearch: z.boolean(),
  enableInteractiveSearch: z.boolean(),
  priority: Priority,
  downloadClientId: z.number().int().optional(),
  tags: z.array(z.number().int()),
  settings: IndexerSettings,
  status: IndexerStatusSummary.optional(),
});
export type Indexer = z.infer<typeof Indexer>;

export const IndexerCreate = z.object({
  name: z.string().trim().min(1),
  implementation: IndexerImplementation,
  enableRss: z.boolean().default(true),
  enableAutomaticSearch: z.boolean().default(true),
  enableInteractiveSearch: z.boolean().default(true),
  priority: Priority.default(INDEXER_PRIORITY_DEFAULT),
  downloadClientId: z.number().int().nullish(),
  tags: z.array(z.number().int()).default([]),
  settings: IndexerSettingsInput,
});
export type IndexerCreate = z.input<typeof IndexerCreate>;
export type IndexerCreateParsed = z.output<typeof IndexerCreate>;

/** Partial update; `settings` is merged field by field, `downloadClientId: null` clears it. */
export const IndexerUpdate = z.object({
  name: z.string().trim().min(1).optional(),
  implementation: IndexerImplementation.optional(),
  enableRss: z.boolean().optional(),
  enableAutomaticSearch: z.boolean().optional(),
  enableInteractiveSearch: z.boolean().optional(),
  priority: Priority.optional(),
  downloadClientId: z.number().int().nullish(),
  tags: z.array(z.number().int()).optional(),
  settings: IndexerSettings.partial().optional(),
});
export type IndexerUpdate = z.input<typeof IndexerUpdate>;

// ---- capabilities -------------------------------------------------------------------

export const IndexerSearchModeCapabilities = z.object({
  available: z.boolean(),
  supportedParams: z.array(z.string()),
});

export const IndexerCapabilitiesResource = z.object({
  serverTitle: z.string().optional(),
  limits: z.object({ max: z.number().int(), default: z.number().int() }),
  searching: z.object({
    search: IndexerSearchModeCapabilities,
    tvSearch: IndexerSearchModeCapabilities,
    movieSearch: IndexerSearchModeCapabilities,
  }),
  categories: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      subcats: z.array(z.object({ id: z.number().int(), name: z.string() })),
    }),
  ),
  /** ISO-8601 time the caps were fetched from the indexer. */
  fetchedAt: z.string().optional(),
});
export type IndexerCapabilitiesResource = z.infer<typeof IndexerCapabilitiesResource>;

export const IndexerErrorCode = z.enum([
  'auth',
  'unreachable',
  'bad-response',
  'rate-limited',
  'unsupported-search',
  'caps-failed',
]);
export type IndexerErrorCode = z.infer<typeof IndexerErrorCode>;

export const IndexerTestResult = z.object({
  ok: z.boolean(),
  releaseCount: NonNegativeInt.optional(),
  caps: IndexerCapabilitiesResource.optional(),
  error: z.object({ code: IndexerErrorCode, message: z.string() }).optional(),
});
export type IndexerTestResult = z.infer<typeof IndexerTestResult>;

export const IndexerTestAllItem = IndexerTestResult.extend({ id: z.number().int(), name: z.string() });
export type IndexerTestAllItem = z.infer<typeof IndexerTestAllItem>;

// ---- status -------------------------------------------------------------------------

export const IndexerStatus = IndexerStatusSummary.extend({
  indexerId: z.number().int(),
  /** ISO-8601 of the last successful RSS fetch. */
  lastRssSyncAt: z.string().optional(),
});
export type IndexerStatus = z.infer<typeof IndexerStatus>;

// ---- schema templates & categories --------------------------------------------------

export const IndexerTemplate = z.object({
  implementation: IndexerImplementation,
  implementationName: z.string(),
  protocol: ReleaseProtocol,
  infoLink: z.string().optional(),
  /** A ready-to-fill create body with default settings. */
  template: z.object({
    name: z.string(),
    implementation: IndexerImplementation,
    enableRss: z.boolean(),
    enableAutomaticSearch: z.boolean(),
    enableInteractiveSearch: z.boolean(),
    priority: Priority,
    tags: z.array(z.number().int()),
    settings: IndexerSettings,
  }),
});
export type IndexerTemplate = z.infer<typeof IndexerTemplate>;

export const IndexerCategory = z.object({
  id: z.number().int(),
  name: z.string(),
  subCategories: z.array(z.object({ id: z.number().int(), name: z.string() })),
});
export type IndexerCategory = z.infer<typeof IndexerCategory>;

// ---- releases & search --------------------------------------------------------------

export const ReleaseResource = z.object({
  guid: z.string(),
  title: z.string(),
  /** Bytes. */
  size: z.number().int(),
  /** ISO-8601. */
  publishDate: z.string(),
  downloadUrl: z.string(),
  infoUrl: z.string().optional(),
  magnetUrl: z.string().optional(),
  /** Lower-case hex. */
  infoHash: z.string().optional(),
  seeders: z.number().int().optional(),
  leechers: z.number().int().optional(),
  peers: z.number().int().optional(),
  categories: z.array(z.number().int()),
  indexerId: z.number().int(),
  indexerName: z.string(),
  indexerPriority: Priority,
  protocol: ReleaseProtocol,
  tvdbId: z.number().int().optional(),
  tmdbId: z.number().int().optional(),
  imdbId: z.string().optional(),
  grabs: z.number().int().optional(),
  downloadVolumeFactor: z.number().optional(),
  uploadVolumeFactor: z.number().optional(),
  minimumRatio: z.number().optional(),
  /** Milliseconds. */
  minimumSeedTime: z.number().int().optional(),
  /** Whole days since publishDate. */
  age: NonNegativeInt,
  ageHours: z.number().min(0),
  ageMinutes: z.number().min(0),
  /** Filled by the decision engine; empty until then. */
  rejections: z.array(z.string()),
  /** Filled by the decision engine; false until then. */
  approved: z.boolean(),
});
export type ReleaseResource = z.infer<typeof ReleaseResource>;

/** Accepts `1,2,3`, repeated query params, or a JSON array. */
const IdList = z
  .preprocess((value) => {
    const parts = (Array.isArray(value) ? value : [value]).flatMap((v) => String(v).split(','));
    return parts.map((p) => p.trim()).filter((p) => p !== '').map(Number);
  }, z.array(z.number().int().min(0)))
  .optional();

const OptionalInt = z.coerce.number().int().min(0).optional();

export const ManualSearchType = z.enum(['search', 'tv', 'movie']);
export type ManualSearchType = z.infer<typeof ManualSearchType>;

/**
 * Interactive search. Library ids (`seriesId`, `episodeId`, `movieId`, `seasonNumber`)
 * are resolved by the release pipeline; raw ids and `query` search directly. Usable as
 * a query string (numbers coerced, lists comma separated) or as a JSON body.
 */
export const ManualSearchRequest = z.object({
  query: z.string().trim().min(1).optional(),
  type: ManualSearchType.optional(),
  seriesId: OptionalInt,
  seasonNumber: OptionalInt,
  episodeId: OptionalInt,
  movieId: OptionalInt,
  tvdbId: OptionalInt,
  tmdbId: OptionalInt,
  imdbId: z.string().trim().min(1).optional(),
  season: OptionalInt,
  episode: OptionalInt,
  year: OptionalInt,
  /** `YYYY-MM-DD` for daily shows. */
  airDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  categories: IdList,
  indexerIds: IdList,
});
export type ManualSearchRequest = z.infer<typeof ManualSearchRequest>;

export const IndexersErrorResponse = z.object({ error: z.string(), code: z.string().optional() });
export type IndexersErrorResponse = z.infer<typeof IndexersErrorResponse>;

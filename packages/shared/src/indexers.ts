import { z } from 'zod';
import { ARCLIGHT_RAW_BASE } from './project.js';
import { ReleaseIndexerFlag, ReleaseProtocol } from './profiles.js';

// Indexers: persistent Torznab/Newznab endpoint configuration, health (failure backoff),
// capabilities, and the release shape every search returns. The protocol clients live in
// @arclight/indexers; these are the shapes the API serves and the release pipeline reads.

/**
 * `torznab` / `newznab` talk to an API endpoint; `definition` runs a YAML site definition
 * from the catalogue (always torrent).
 */
export const IndexerImplementation = z.enum(['torznab', 'newznab', 'definition']);
export type IndexerImplementation = z.infer<typeof IndexerImplementation>;

/** Torznab endpoints and site definitions serve torrents, Newznab endpoints serve usenet. */
export function protocolForImplementation(implementation: IndexerImplementation): ReleaseProtocol {
  return implementation === 'newznab' ? 'usenet' : 'torrent';
}

export const INDEXER_PRIORITY_MIN = 1;
export const INDEXER_PRIORITY_MAX = 50;
export const INDEXER_PRIORITY_DEFAULT = 25;

const CategoryId = z.number().int().min(0);

/** Default music categories: Audio, Audio/MP3, Audio/Lossless. */
export const DEFAULT_INDEXER_MUSIC_CATEGORIES: readonly number[] = [3000, 3010, 3040];
/** Default audiobook categories: Audio/Audiobook. */
export const DEFAULT_INDEXER_AUDIOBOOK_CATEGORIES: readonly number[] = [3030];

/**
 * The music / audiobook lists are optional in stored settings: indexers saved before music
 * support lack them and read as the defaults (see `indexerAudioCategories`). The api fills
 * them in on every indexer it serves; create bodies default them.
 */
export function indexerAudioCategories(settings: {
  musicCategories?: readonly number[] | undefined;
  audiobookCategories?: readonly number[] | undefined;
}): { musicCategories: number[]; audiobookCategories: number[] } {
  return {
    musicCategories: [...(settings.musicCategories ?? DEFAULT_INDEXER_MUSIC_CATEGORIES)],
    audiobookCategories: [...(settings.audiobookCategories ?? DEFAULT_INDEXER_AUDIOBOOK_CATEGORIES)],
  };
}
const Priority = z.number().int().min(INDEXER_PRIORITY_MIN).max(INDEXER_PRIORITY_MAX);
const NonNegativeInt = z.number().int().min(0);

/** A value of one definition setting: text/password/select are strings, checkboxes booleans. */
export const DefinitionFieldValue = z.union([z.string(), z.boolean()]);
export type DefinitionFieldValue = z.infer<typeof DefinitionFieldValue>;

/** The definition-specific part of an indexer's settings (implementation `definition`). */
export const DefinitionIndexerSettings = z.object({
  /** Catalogue id, e.g. `yts`. */
  definitionId: z.string().min(1),
  /** Values for the definition's `settings` list, keyed by setting name. */
  fields: z.record(z.string(), DefinitionFieldValue).default({}),
});
export type DefinitionIndexerSettings = z.infer<typeof DefinitionIndexerSettings>;

/**
 * Stored settings for one indexer. Seed times are milliseconds; the rate limit is seconds.
 * Definition indexers set `definitionId` + `fields`; their `baseUrl` is the site link in use
 * (a definition mirror or `fields.sitelink`) and `apiPath` is empty.
 */
export const IndexerSettings = z.object({
  baseUrl: z.string(),
  apiPath: z.string(),
  apiKey: z.string().optional(),
  categories: z.array(CategoryId),
  animeCategories: z.array(CategoryId),
  /** Searched by `music` requests; added to RSS while music is enabled and an artist is monitored. */
  musicCategories: z.array(CategoryId).optional(),
  /** Searched by `book` requests; added to RSS while audiobooks are enabled. */
  audiobookCategories: z.array(CategoryId).optional(),
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
  /** Definition indexers: catalogue id. */
  definitionId: z.string().min(1).optional(),
  /** Definition indexers: values for the definition's settings, keyed by name. */
  fields: z.record(z.string(), DefinitionFieldValue).optional(),
});
export type IndexerSettings = z.infer<typeof IndexerSettings>;

/**
 * Settings as submitted: list/path fields fall back to defaults. `baseUrl` is required for
 * Torznab/Newznab (checked by the api); definition indexers may omit it.
 */
export const IndexerSettingsInput = IndexerSettings.extend({
  baseUrl: z.string().trim().default(''),
  apiPath: z.string().trim().default('/api'),
  categories: z.array(CategoryId).default([]),
  animeCategories: z.array(CategoryId).default([]),
  musicCategories: z.array(CategoryId).default(() => [...DEFAULT_INDEXER_MUSIC_CATEGORIES]),
  audiobookCategories: z.array(CategoryId).default(() => [...DEFAULT_INDEXER_AUDIOBOOK_CATEGORIES]),
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
  /** Explicit indexer proxy; without it proxies apply by matching tags. */
  proxyId: z.number().int().optional(),
  tags: z.array(z.number().int()),
  settings: IndexerSettings,
  status: IndexerStatusSummary.optional(),
  /** Definition indexers: the definition's display name (absent when missing from the catalogue). */
  definitionName: z.string().optional(),
  /** Definition indexers: public / semi-private / private. */
  privacy: z.enum(['public', 'semi-private', 'private']).optional(),
  /** Names of the proxies applied to this indexer (explicit or by tag). */
  proxyNames: z.array(z.string()).optional(),
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
  proxyId: z.number().int().nullish(),
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
  proxyId: z.number().int().nullish(),
  tags: z.array(z.number().int()).optional(),
  // No defaults here: an absent list keeps the saved one instead of resetting it.
  settings: IndexerSettings.partial().optional(),
});
export type IndexerUpdate = z.input<typeof IndexerUpdate>;

// ---- capabilities -------------------------------------------------------------------

export const IndexerSearchModeCapabilities = z.object({
  available: z.boolean(),
  supportedParams: z.array(z.string()),
});
export type IndexerSearchModeCapabilities = z.infer<typeof IndexerSearchModeCapabilities>;

export const IndexerCapabilitiesResource = z.object({
  serverTitle: z.string().optional(),
  limits: z.object({ max: z.number().int(), default: z.number().int() }),
  searching: z.object({
    search: IndexerSearchModeCapabilities,
    tvSearch: IndexerSearchModeCapabilities,
    movieSearch: IndexerSearchModeCapabilities,
    /** `music-search` / `audio-search`; absent in caps cached before music support (= unavailable). */
    musicSearch: IndexerSearchModeCapabilities.optional(),
    /** `book-search`; absent in caps cached before audiobook support (= unavailable). */
    bookSearch: IndexerSearchModeCapabilities.optional(),
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
  /**
   * Indexer flags (freeleech, double upload, ...). Filled from the Torznab volume factors when
   * the indexer reports them; see `indexerFlagsFromVolumeFactors`.
   */
  indexerFlags: z.array(ReleaseIndexerFlag).optional(),
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

const near = (a: number, b: number) => Math.abs(a - b) < 0.001;

/**
 * Flags implied by Torznab `downloadvolumefactor` / `uploadvolumefactor`: a download factor
 * of 0 is freeleech, 0.25 / 0.5 / 0.75 count 25% / 50% / 75% of the size (freeleech75,
 * halfleech, freeleech25); an upload factor of 2 or more is double upload.
 */
export function indexerFlagsFromVolumeFactors(r: {
  downloadVolumeFactor?: number | undefined;
  uploadVolumeFactor?: number | undefined;
}): ReleaseIndexerFlag[] {
  const flags: ReleaseIndexerFlag[] = [];
  const dvf = r.downloadVolumeFactor;
  if (dvf !== undefined && Number.isFinite(dvf)) {
    if (near(dvf, 0)) flags.push('freeleech');
    else if (near(dvf, 0.25)) flags.push('freeleech75');
    else if (near(dvf, 0.5)) flags.push('halfleech');
    else if (near(dvf, 0.75)) flags.push('freeleech25');
  }
  const uvf = r.uploadVolumeFactor;
  if (uvf !== undefined && Number.isFinite(uvf) && uvf >= 2) flags.push('doubleUpload');
  return flags;
}

/** Accepts `1,2,3`, repeated query params, or a JSON array. */
const IdList = z
  .preprocess((value) => {
    const parts = (Array.isArray(value) ? value : [value]).flatMap((v) => String(v).split(','));
    return parts.map((p) => p.trim()).filter((p) => p !== '').map(Number);
  }, z.array(z.number().int().min(0)))
  .optional();

const OptionalInt = z.coerce.number().int().min(0).optional();

export const ManualSearchType = z.enum(['search', 'tv', 'movie', 'music', 'book']);
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
  /** Music library ids, resolved by the release pipeline like `seriesId` / `movieId`. */
  artistId: OptionalInt,
  albumId: OptionalInt,
  tvdbId: OptionalInt,
  tmdbId: OptionalInt,
  imdbId: z.string().trim().min(1).optional(),
  season: OptionalInt,
  episode: OptionalInt,
  year: OptionalInt,
  /** `YYYY-MM-DD` for daily shows. */
  airDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** `type: music` fields (`year` and `query` are shared). */
  artist: z.string().trim().min(1).optional(),
  album: z.string().trim().min(1).optional(),
  label: z.string().trim().min(1).optional(),
  /** `type: book` fields. */
  author: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).optional(),
  categories: IdList,
  indexerIds: IdList,
});
export type ManualSearchRequest = z.infer<typeof ManualSearchRequest>;

// ---- definition catalogue -----------------------------------------------------------

export const IndexerPrivacy = z.enum(['public', 'semi-private', 'private']);
export type IndexerPrivacy = z.infer<typeof IndexerPrivacy>;

/** One entry of a definition's `settings` list, as the editor renders it. */
export const DefinitionSettingField = z.object({
  name: z.string(),
  /** text, password, checkbox, select, multi-select, info, info_cookie, info_flaresolverr, ... */
  type: z.string(),
  label: z.string(),
  default: DefinitionFieldValue.optional(),
  /** select / multi-select choices. */
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  /** Help-only entries (`info*`) carry no value. */
  informational: z.boolean(),
});
export type DefinitionSettingField = z.infer<typeof DefinitionSettingField>;

export const IndexerDefinitionSummary = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** e.g. `en-US`. */
  language: z.string(),
  /** The site's declared type (same vocabulary as `privacy`). */
  type: IndexerPrivacy,
  protocol: ReleaseProtocol,
  privacy: IndexerPrivacy,
  /** Mirrors; the first is the default site link. */
  links: z.array(z.string()),
  settingsFields: z.array(DefinitionSettingField),
  /** Standard (Newznab) categories the site maps to. */
  categories: z.array(z.object({ id: z.number().int(), name: z.string() })),
  /** False until someone confirmed the definition against the live site. */
  tested: z.boolean(),
  /**
   * builtin: shipped; feed: downloaded from the definition feed; custom: user YAML (wins);
   * community: the community catalogue (loses to every other source with the same id).
   */
  source: z.enum(['builtin', 'feed', 'custom', 'community']),
  /** The definition sets `requiresFlareSolverr`: the site sits behind a browser challenge. */
  requiresFlareSolverr: z.boolean().optional(),
});
export type IndexerDefinitionSummary = z.infer<typeof IndexerDefinitionSummary>;

export const IndexerDefinitionDetail = IndexerDefinitionSummary.extend({
  /** Search modes the site supports (`search`, `tv-search`, `movie-search`, ...). */
  searchModes: z.array(z.string()),
  requiresLogin: z.boolean(),
  /** Non-fatal problems found while loading. */
  warnings: z.array(z.string()),
});
export type IndexerDefinitionDetail = z.infer<typeof IndexerDefinitionDetail>;

export const IndexerDefinitionListQuery = z.object({
  privacy: IndexerPrivacy.optional(),
  protocol: ReleaseProtocol.optional(),
  /** Prefix match on the language (`en` matches `en-US`), case-insensitive. */
  language: z.string().trim().min(1).optional(),
  /** Case-insensitive substring of id, name or description. */
  query: z.string().trim().min(1).optional(),
});
export type IndexerDefinitionListQuery = z.infer<typeof IndexerDefinitionListQuery>;

/** Upload a custom definition (YAML text); saved as `<config>/definitions/<id>.yml`. */
export const IndexerDefinitionUpload = z.object({ yaml: z.string().min(1) });
export type IndexerDefinitionUpload = z.infer<typeof IndexerDefinitionUpload>;

export const DefinitionLoadError = z.object({ file: z.string(), code: z.string(), message: z.string() });
export type DefinitionLoadError = z.infer<typeof DefinitionLoadError>;

export const IndexerDefinitionReloadResult = z.object({
  total: z.number().int(),
  builtin: z.number().int(),
  /** Definitions loaded from the definition feed (`<config>/definitions/feed`). */
  feed: z.number().int().default(0),
  custom: z.number().int(),
  /** Definitions loaded from the community catalogue (`<config>/definitions/community`). */
  community: z.number().int().default(0),
  /** Builtin, feed and custom files that failed to load (community failures are catalogue entries). */
  errors: z.array(DefinitionLoadError),
});
export type IndexerDefinitionReloadResult = z.infer<typeof IndexerDefinitionReloadResult>;

// ---- indexer proxies ----------------------------------------------------------------

export const IndexerProxyType = z.enum(['flaresolverr', 'http', 'socks5']);
export type IndexerProxyType = z.infer<typeof IndexerProxyType>;

export const INDEXER_PROXY_SECRET_MASK = '********';

/**
 * A proxy indexer requests can go through. FlareSolverr: `host` may carry a scheme
 * (`http://flaresolverr`; default http). `requestTimeout` is seconds. Responses mask the
 * password with `********`; sending the mask back keeps the stored one.
 */
export const IndexerProxy = z.object({
  id: z.number().int(),
  name: z.string(),
  type: IndexerProxyType,
  host: z.string(),
  port: z.number().int().min(1).max(65535),
  username: z.string().optional(),
  password: z.string().optional(),
  requestTimeout: z.number().int().min(1).max(600).optional(),
  tags: z.array(z.number().int()),
  /** Created and kept in sync by ProxyAutoDetect (FlareSolverr (bundled), Built-in solver). */
  managed: z.boolean().optional(),
});
export type IndexerProxy = z.infer<typeof IndexerProxy>;

export const IndexerProxyCreate = z.object({
  name: z.string().trim().min(1),
  type: IndexerProxyType,
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().optional(),
  password: z.string().optional(),
  requestTimeout: z.number().int().min(1).max(600).optional(),
  tags: z.array(z.number().int()).default([]),
});
export type IndexerProxyCreate = z.input<typeof IndexerProxyCreate>;

export const IndexerProxyUpdate = IndexerProxyCreate.partial();
export type IndexerProxyUpdate = z.input<typeof IndexerProxyUpdate>;

/** Test an unsaved proxy; `url` is the target reached through it (default: a public test URL). */
export const IndexerProxyTestRequest = IndexerProxyCreate.extend({ url: z.string().trim().min(1).optional() });
export type IndexerProxyTestRequest = z.input<typeof IndexerProxyTestRequest>;

export const IndexerProxyTestResult = z.object({
  ok: z.boolean(),
  message: z.string(),
  /** Milliseconds. */
  durationMs: z.number().int().min(0),
});
export type IndexerProxyTestResult = z.infer<typeof IndexerProxyTestResult>;

// ---- stats --------------------------------------------------------------------------

/** `query` = a search, `rss` = an RSS fetch, `grab` = a release download sent to a client. */
export const IndexerStatKind = z.enum(['query', 'rss', 'grab']);
export type IndexerStatKind = z.infer<typeof IndexerStatKind>;

export const IndexerStatsDay = z.object({
  /** `YYYY-MM-DD` (UTC). */
  date: z.string(),
  queries: NonNegativeInt,
  grabs: NonNegativeInt,
  failures: NonNegativeInt,
});
export type IndexerStatsDay = z.infer<typeof IndexerStatsDay>;

export const IndexerStatsEntry = z.object({
  indexerId: z.number().int(),
  indexerName: z.string(),
  /** Searches + RSS fetches. */
  queries: NonNegativeInt,
  grabs: NonNegativeInt,
  /** Failed queries, RSS fetches and grabs. */
  failures: NonNegativeInt,
  /** Mean duration of successful queries/RSS fetches; null without any. */
  avgResponseMs: z.number().int().min(0).nullable(),
  /** One entry per day of the window, oldest first. */
  byDay: z.array(IndexerStatsDay),
});
export type IndexerStatsEntry = z.infer<typeof IndexerStatsEntry>;

export const IndexerStats = z.object({
  days: z.number().int(),
  /** ISO-8601 start of the window. */
  since: z.string(),
  indexers: z.array(IndexerStatsEntry),
  totals: z.object({
    queries: NonNegativeInt,
    grabs: NonNegativeInt,
    failures: NonNegativeInt,
    avgResponseMs: z.number().int().min(0).nullable(),
    byDay: z.array(IndexerStatsDay),
  }),
});
export type IndexerStats = z.infer<typeof IndexerStats>;

export const INDEXER_STATS_MAX_DAYS = 90;
export const IndexerStatsQuery = z.object({
  days: z.coerce.number().int().min(1).max(INDEXER_STATS_MAX_DAYS).default(30),
});
export type IndexerStatsQuery = z.infer<typeof IndexerStatsQuery>;

// ---- global indexer options ---------------------------------------------------------

// ---- definition feed settings (rest of the feed contract at the end of the file) ----

/**
 * Default definition feed: this repository's own builtin definitions folder on GitHub raw, which
 * serves `index.json` (written by scripts/build-definition-index.mjs) and the YAML files.
 */
export const DEFAULT_DEFINITION_FEED_PATH = 'packages/indexers/src/definitions/builtin/';
export const DEFAULT_DEFINITION_FEED_URL = `${ARCLIGHT_RAW_BASE}${DEFAULT_DEFINITION_FEED_PATH}`;

/** Feed index format versions this build understands. */
export const DEFINITION_FEED_SCHEMA_VERSION = 1;

/** `indexers.definitionFeed` settings. */
export const DefinitionFeedSettings = z.object({
  enabled: z.boolean().default(true),
  /** Base URL; `index.json` and every entry's `file` are resolved against it. */
  url: z.string().url().default(DEFAULT_DEFINITION_FEED_URL),
  /** 1-168 hours between automatic syncs. */
  intervalHours: z.number().int().min(1).max(168).default(12),
  /** auto: sync on the interval and install. manual: only POST /indexer/definition/feed/sync. */
  mode: z.enum(['auto', 'manual']).default('auto'),
});
export type DefinitionFeedSettings = z.infer<typeof DefinitionFeedSettings>;
export type DefinitionFeedSettingsInput = z.input<typeof DefinitionFeedSettings>;

// ---- community catalogue settings (rest of the catalogue contract: indexer-catalogue.ts) ----

/**
 * Cardigann schema version of the community catalogue Arclight reads: the Prowlarr/Indexers
 * repository keeps one folder per schema version (`definitions/v<N>/`). v11 is the folder
 * that holds the active catalogue; v12 only carries a handful of files that need newer engine
 * changes, so v11 is the newest complete version our engine loads.
 */
export const COMMUNITY_CATALOGUE_SCHEMA = 11;

/**
 * Default listing: the GitHub contents API for the v11 folder. It returns one JSON array of
 * `{ name, sha, size, download_url, type }`; `sha` is the git blob hash, so unchanged files are
 * never downloaded again. Any URL that serves the same array, or an Arclight feed `index.json`
 * (`{ schemaVersion, definitions: [{ id, file, sha256 }] }`), works as a mirror.
 */
export const DEFAULT_COMMUNITY_CATALOGUE_URL = `https://api.github.com/repos/Prowlarr/Indexers/contents/definitions/v${COMMUNITY_CATALOGUE_SCHEMA}?ref=master`;

/** `indexers.communityCatalogue` settings. */
export const CommunityCatalogueSettings = z.object({
  /** Off: the community definitions are not loaded (files stay on disk) and nothing is fetched. */
  enabled: z.boolean().default(true),
  url: z.string().url().default(DEFAULT_COMMUNITY_CATALOGUE_URL),
  /** 1-168 hours between automatic syncs. */
  intervalHours: z.number().int().min(1).max(168).default(24),
});
export type CommunityCatalogueSettings = z.infer<typeof CommunityCatalogueSettings>;
export type CommunityCatalogueSettingsInput = z.input<typeof CommunityCatalogueSettings>;

/**
 * Settings → Indexer options. Minimum age, retention and maximum size are the values the
 * decision engine reads from the `releases` settings section (one source of truth); the rest
 * live in the `indexers` section. `rssSyncIntervalMinutes` 0 disables RSS sync.
 * (Named "global" because `IndexerSettings` is the per-indexer settings shape.)
 */
export const IndexerGlobalSettings = z.object({
  /** Usenet: ignore releases newer than this (minutes); 0 = off. */
  minimumAgeMinutes: z.number().int().min(0).default(0),
  /** Usenet: ignore releases older than this (days); 0 = off. */
  retentionDays: z.number().int().min(0).default(0),
  /** Global hard cap in MB; 0 = off. */
  maximumSizeMb: z.number().int().min(0).default(0),
  /** 0 = disabled, otherwise 10-1440 minutes. */
  rssSyncIntervalMinutes: z
    .number()
    .int()
    .refine((n) => n === 0 || (n >= 10 && n <= 1440), 'must be 0 (off) or between 10 and 1440')
    .default(15),
  allowHardcodedSubs: z.boolean().default(false),
  /** Subtitle tags (e.g. `ENG`, `HC.ENG`) allowed even when hardcoded subs are not. */
  whitelistedHardcodedSubs: z.array(z.string().trim().min(1)).default([]),
  preferIndexerFlags: z.boolean().default(false),
});
export type IndexerGlobalSettings = z.infer<typeof IndexerGlobalSettings>;
export type IndexerGlobalSettingsInput = z.input<typeof IndexerGlobalSettings>;

/** The `indexers` settings section: the IndexerGlobalSettings fields not owned by `releases`. */
export const IndexerOptionsSection = IndexerGlobalSettings.pick({
  rssSyncIntervalMinutes: true,
  allowHardcodedSubs: true,
  whitelistedHardcodedSubs: true,
  preferIndexerFlags: true,
}).extend({
  /** Definition feed (indexers module); edited through /indexer/definition/feed/settings. */
  definitionFeed: DefinitionFeedSettings.default(() => DefinitionFeedSettings.parse({})),
  /** Community catalogue (indexers module); edited through /indexer/catalogue/community/settings. */
  communityCatalogue: CommunityCatalogueSettings.default(() => CommunityCatalogueSettings.parse({})),
});
export type IndexerOptionsSection = z.infer<typeof IndexerOptionsSection>;

// ---- search-page grab ---------------------------------------------------------------

/**
 * Grab a result of a recent `GET /search` by guid. The decision engine re-runs on it; a
 * result that maps to nothing in the library is refused (409 NO_MATCH) unless `force`, which
 * sends it to the default client of its protocol untracked (shown as unknown in the queue).
 */
export const SearchGrabRequest = z.object({
  guid: z.string().min(1),
  indexerId: z.number().int(),
  force: z.boolean().default(false),
  downloadClientId: z.number().int().optional(),
});
export type SearchGrabRequest = z.input<typeof SearchGrabRequest>;

export const SearchGrabResponse = z.object({
  title: z.string(),
  queueItemId: z.number().int(),
  downloadId: z.string(),
  downloadClientId: z.number().int().nullable(),
  /** False when force-grabbed without a library match. */
  matched: z.boolean(),
  /** Decision-engine rejection messages that the grab overrode. */
  rejections: z.array(z.string()),
});
export type SearchGrabResponse = z.infer<typeof SearchGrabResponse>;

export const IndexersErrorResponse = z.object({ error: z.string(), code: z.string().optional() });
export type IndexersErrorResponse = z.infer<typeof IndexersErrorResponse>;

// ---- definition feed ------------------------------------------------------------------

/**
 * `index.json` of a definition feed. `sha256` is the hex digest of the file's UTF-8 text with
 * CRLF normalised to LF (so a Windows checkout produces the same index).
 */
export const DefinitionFeedIndex = z.object({
  schemaVersion: z.number().int(),
  generatedAt: z.string().optional(),
  definitions: z.array(
    z.object({
      id: z.string().regex(/^[a-z0-9._-]+$/),
      version: z.string().min(1),
      /** Path relative to the feed URL, e.g. `yts.yml` or `definitions/yts.yml`. */
      file: z.string().regex(/^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]+\.ya?ml$/),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  ),
});
export type DefinitionFeedIndex = z.infer<typeof DefinitionFeedIndex>;

export const DefinitionFeedRejection = z.object({ id: z.string(), version: z.string().nullable(), reason: z.string() });
export type DefinitionFeedRejection = z.infer<typeof DefinitionFeedRejection>;

export const DefinitionFeedInstalled = z.object({
  id: z.string(),
  version: z.string(),
  sha256: z.string(),
  installedAt: z.string(),
  /** A previous version is kept and POST .../rollback/:id restores it. */
  previousVersion: z.string().nullable(),
  /** False when a user definition with the same id overrides it. */
  active: z.boolean(),
});
export type DefinitionFeedInstalled = z.infer<typeof DefinitionFeedInstalled>;

export const DefinitionFeedStatus = z.object({
  settings: DefinitionFeedSettings,
  lastSyncAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastError: z.string().nullable(),
  /** schemaVersion of the last index read. */
  schemaVersion: z.number().int().nullable(),
  installed: z.array(DefinitionFeedInstalled),
  /** Entries of the last sync that were not installed. */
  rejected: z.array(DefinitionFeedRejection),
});
export type DefinitionFeedStatus = z.infer<typeof DefinitionFeedStatus>;

export const DefinitionFeedSyncResult = z.object({
  /** The index answered 304 / was byte-identical: nothing to do. */
  notModified: z.boolean(),
  added: z.array(z.string()),
  updated: z.array(z.string()),
  removed: z.array(z.string()),
  unchanged: z.number().int(),
  rejected: z.array(DefinitionFeedRejection),
});
export type DefinitionFeedSyncResult = z.infer<typeof DefinitionFeedSyncResult>;

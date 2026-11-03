import { z } from 'zod';
import { MediaType, MinimumAvailability, MonitorOption, SeriesType } from './library.js';

// Import lists: external lists (TMDB, Trakt, Plex, IMDb, RSS/JSON feeds) whose items are
// added to the library automatically. A list carries the defaults used when one of its items
// is added (root folder, quality profile, monitoring, tags). Settings are per implementation;
// on the wire they are a JSON object whose secret values (tokens, client secrets) are masked
// with SECRET_MASK. Sending the mask back keeps the stored value.

export const ImportListImplementation = z.enum([
  'tmdbList',
  'tmdbPopular',
  'tmdbCollection',
  'tmdbPerson',
  'tmdbKeyword',
  'trakt',
  'traktPopular',
  'traktUser',
  'plexWatchlist',
  'imdbList',
  'rss',
  'stevenLu',
  'tmdbCompany',
  'tmdbNetwork',
  'tmdbDiscover',
  'traktLists',
  'imdbTop',
  'letterboxd',
  'mdblist',
  'anilist',
  'myAnimeList',
  'kitsu',
  'simkl',
  'jellyfinFavorites',
  'customUrl',
]);
export type ImportListImplementation = z.infer<typeof ImportListImplementation>;

/** Which kind of library item a list feeds. `both` keeps series and movies from mixed lists. */
export const ImportListMediaType = z.enum(['series', 'movie', 'both']);
export type ImportListMediaType = z.infer<typeof ImportListMediaType>;

// ---- per-implementation settings ------------------------------------------------------

const Year = z.number().int().min(1870).max(2200);

/** Filters shared by the TMDB discover-backed lists. */
const TmdbFilters = {
  /** Minimum TMDB vote average (0-10). */
  minVoteAverage: z.number().min(0).max(10).optional(),
  /** Minimum number of TMDB votes. */
  minVotes: z.number().int().min(0).optional(),
  yearFrom: Year.optional(),
  yearTo: Year.optional(),
  /** ISO-639-1 original languages, any of. */
  languages: z.array(z.string().trim().min(2)).default([]),
  /** TMDB genre ids, any of. */
  genreIds: z.array(z.number().int()).default([]),
  /** Maximum items taken from the list. */
  limit: z.number().int().min(1).max(1000).default(100),
};

export const TmdbListSettings = z.object({ listId: z.string().trim().min(1) });
export const TmdbPopularSettings = z.object({
  listType: z
    .enum(['popular', 'topRated', 'trending', 'nowPlaying', 'upcoming', 'airingToday', 'onTheAir'])
    .default('popular'),
  ...TmdbFilters,
});
export const TmdbCollectionSettings = z.object({ collectionId: z.number().int().positive() });
export const TmdbPersonSettings = z.object({
  personId: z.number().int().positive(),
  includeCast: z.boolean().default(true),
  includeCrew: z.boolean().default(false),
  /** Crew jobs to include (e.g. Director); empty with includeCrew means every job. */
  crewJobs: z.array(z.string().trim().min(1)).default([]),
});
export const TmdbKeywordSettings = z.object({ keywordId: z.number().int().positive(), ...TmdbFilters });

/** Trakt app credentials and OAuth tokens. Tokens are filled by the device-code flow. */
const TraktAuth = {
  clientId: z.string().trim().min(1),
  clientSecret: z.string().optional(),
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  /** ISO-8601 time the access token expires. */
  tokenExpiresAt: z.string().optional(),
  /** Reference returned by POST /importlist/trakt/poll for a list not saved yet. */
  authRef: z.string().optional(),
};
const TraktLimit = z.number().int().min(1).max(1000).default(100);
export const TraktListSettings = z.object({
  ...TraktAuth,
  username: z.string().trim().min(1),
  listName: z.string().trim().min(1),
  limit: TraktLimit,
});
export const TraktPopularSettings = z.object({
  ...TraktAuth,
  listType: z
    .enum(['trending', 'popular', 'anticipated', 'watched', 'boxOffice', 'played', 'collected', 'recommended'])
    .default('popular'),
  /** Period for the watched/played/collected/recommended charts. */
  period: z.enum(['daily', 'weekly', 'monthly', 'yearly', 'all']).default('weekly'),
  yearFrom: Year.optional(),
  yearTo: Year.optional(),
  /** Trakt genre slugs (e.g. `action`). */
  genres: z.array(z.string().trim().min(1)).default([]),
  /** ISO-639-1 languages. */
  languages: z.array(z.string().trim().min(2)).default([]),
  /** Minimum Trakt rating (0-100). */
  minRating: z.number().int().min(0).max(100).optional(),
  limit: TraktLimit,
});
export const TraktUserSettings = z.object({
  ...TraktAuth,
  /** Empty: the authenticated user. */
  username: z.string().trim().optional(),
  /** `favorites` and `recommendations` (personal, needs authentication) besides the original three. */
  listType: z.enum(['watchlist', 'watched', 'collection', 'favorites', 'recommendations']).default('watchlist'),
  limit: TraktLimit,
});
/** Every list a Trakt user owns, or every list they liked. */
export const TraktListsSettings = z.object({
  ...TraktAuth,
  /** Empty: the authenticated user. */
  username: z.string().trim().optional(),
  source: z.enum(['own', 'liked']).default('own'),
  /** Only lists whose slug or name is one of these; empty = every list. */
  listNames: z.array(z.string().trim().min(1)).default([]),
  limit: TraktLimit,
});
export const PlexWatchlistSettings = z.object({ plexToken: z.string().min(1) });
export const ImdbListSettings = z.object({
  /** `ls` list id or `ur` user id (that user's watchlist). */
  listId: z.string().trim().regex(/^(ls|ur)\d+$/, 'expected an IMDb list id (ls...) or user id (ur...)'),
});
export const RssListSettings = z.object({ url: z.url({ protocol: /^https?$/ }) });
export const StevenLuSettings = z.object({
  url: z.url({ protocol: /^https?$/ }).default('https://s3.amazonaws.com/popular-movies/movies.json'),
});

export const TmdbCompanySettings = z.object({ companyId: z.number().int().positive(), ...TmdbFilters });
export const TmdbNetworkSettings = z.object({ networkId: z.number().int().positive(), ...TmdbFilters });
/** TMDB discover with any combination of its filters. */
export const TmdbDiscoverSettings = z.object({
  sortBy: z
    .enum(['popularity.desc', 'vote_average.desc', 'vote_count.desc', 'primary_release_date.desc', 'revenue.desc'])
    .default('popularity.desc'),
  keywordIds: z.array(z.number().int()).default([]),
  companyIds: z.array(z.number().int()).default([]),
  /** Series only. */
  networkIds: z.array(z.number().int()).default([]),
  /** Only titles streaming on one of these TMDB watch providers (in `watchRegion`). */
  watchProviderIds: z.array(z.number().int()).default([]),
  /** ISO-3166-1; defaults to the instance region. */
  watchRegion: z.string().trim().length(2).optional(),
  /** Certification up to and including (in the instance region), e.g. PG-13. */
  certificationLte: z.string().trim().min(1).optional(),
  runtimeMin: z.number().int().min(0).optional(),
  runtimeMax: z.number().int().min(0).optional(),
  ...TmdbFilters,
});
/** Highest-rated titles from IMDb's official non-commercial datasets (title.ratings). */
export const ImdbTopSettings = z.object({
  /** Titles with fewer votes are ignored (IMDb's own Top 250 uses a large threshold too). */
  minVotes: z.number().int().min(1000).default(25000),
  limit: z.number().int().min(1).max(1000).default(250),
});
export const LetterboxdSettings = z
  .object({
    /** watchlist and diary need `username`; list needs `username` + `listSlug`; url takes any list page. */
    source: z.enum(['watchlist', 'list', 'diary', 'url']).default('watchlist'),
    username: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_]+$/, 'expected a Letterboxd username')
      .optional(),
    listSlug: z
      .string()
      .trim()
      .regex(/^[a-z0-9-]+$/, 'expected the list slug from its URL')
      .optional(),
    url: z.url({ protocol: /^https?$/ }).optional(),
    limit: z.number().int().min(1).max(1000).default(250),
  })
  .superRefine((s, ctx) => {
    if (s.source !== 'url' && !s.username) ctx.addIssue({ code: 'custom', path: ['username'], message: 'a username is required' });
    if (s.source === 'list' && !s.listSlug) ctx.addIssue({ code: 'custom', path: ['listSlug'], message: 'a list slug is required' });
    if (s.source === 'url' && !(s.url && /^https:\/\/(www\.)?letterboxd\.com\//.test(s.url))) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'expected a letterboxd.com URL' });
    }
  });
export const MdblistSettings = z.object({
  apiKey: z.string().min(1),
  /** A numeric list id, `username/list-slug`, or the list URL. */
  list: z.string().trim().min(1),
  limit: z.number().int().min(1).max(5000).default(500),
});
const AnimeLimit = z.number().int().min(1).max(1000).default(100);
const Season = z.enum(['winter', 'spring', 'summer', 'fall']);
const needsUser = (s: { source: string; username?: string | undefined }, ctx: z.RefinementCtx) => {
  if (s.source === 'user' && !s.username) ctx.addIssue({ code: 'custom', path: ['username'], message: 'a username is required' });
};
export const AnilistSettings = z
  .object({
    source: z.enum(['user', 'seasonal', 'trending', 'popular', 'top']).default('user'),
    username: z.string().trim().min(1).optional(),
    statuses: z
      .array(z.enum(['current', 'planning', 'completed', 'paused', 'dropped', 'repeating']))
      .default(['current', 'planning']),
    /** Seasonal: defaults to the current season. */
    season: Season.optional(),
    seasonYear: Year.optional(),
    limit: AnimeLimit,
  })
  .superRefine(needsUser);
export const MyAnimeListSettings = z
  .object({
    /** MyAnimeList API client id (free, from the API section of a MAL account). */
    clientId: z.string().trim().min(1),
    source: z.enum(['user', 'seasonal', 'ranking']).default('user'),
    username: z.string().trim().min(1).optional(),
    statuses: z
      .array(z.enum(['watching', 'completed', 'on_hold', 'dropped', 'plan_to_watch']))
      .default(['watching', 'plan_to_watch']),
    season: Season.optional(),
    seasonYear: Year.optional(),
    rankingType: z.enum(['all', 'airing', 'upcoming', 'tv', 'movie', 'bypopularity', 'favorite']).default('all'),
    limit: AnimeLimit,
  })
  .superRefine(needsUser);
export const KitsuSettings = z
  .object({
    source: z.enum(['user', 'trending']).default('user'),
    username: z.string().trim().min(1).optional(),
    statuses: z.array(z.enum(['current', 'planned', 'completed', 'on_hold', 'dropped'])).default(['current', 'planned']),
    limit: AnimeLimit,
  })
  .superRefine(needsUser);
export const SimklSettings = z.object({
  /** Simkl app client id; the access token comes from the PIN flow (or is pasted). */
  clientId: z.string().trim().min(1),
  accessToken: z.string().optional(),
  statuses: z
    .array(z.enum(['watching', 'plantowatch', 'hold', 'completed', 'dropped']))
    .default(['plantowatch', 'watching']),
  types: z.array(z.enum(['shows', 'movies', 'anime'])).default(['shows', 'movies', 'anime']),
  limit: z.number().int().min(1).max(5000).default(500),
  /** Reference returned by POST /importlist/simkl/poll for a list not saved yet. */
  authRef: z.string().optional(),
});
export const JellyfinFavoritesSettings = z.object({
  serverType: z.enum(['jellyfin', 'emby']).default('jellyfin'),
  url: z.url({ protocol: /^https?$/ }),
  apiKey: z.string().min(1),
  /** Whose favourites; matched case-insensitively against the server's users. */
  username: z.string().trim().min(1),
});
/** Any JSON or CSV document of titles with TMDB/IMDb/TVDB ids. */
export const CustomUrlSettings = z.object({
  url: z.url({ protocol: /^https?$/ }),
  format: z.enum(['auto', 'json', 'csv']).default('auto'),
  /** Dotted path to the array inside a JSON document (e.g. `data.items`); empty = auto-detect. */
  itemsPath: z.string().trim().optional(),
  /** Optional request header (e.g. Authorization) for private feeds. */
  headerName: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]+$/, 'expected an HTTP header name')
    .optional(),
  headerValue: z.string().optional(),
});

export type TmdbCompanySettings = z.infer<typeof TmdbCompanySettings>;
export type TmdbNetworkSettings = z.infer<typeof TmdbNetworkSettings>;
export type TmdbDiscoverSettings = z.infer<typeof TmdbDiscoverSettings>;
export type TraktListsSettings = z.infer<typeof TraktListsSettings>;
export type ImdbTopSettings = z.infer<typeof ImdbTopSettings>;
export type LetterboxdSettings = z.infer<typeof LetterboxdSettings>;
export type MdblistSettings = z.infer<typeof MdblistSettings>;
export type AnilistSettings = z.infer<typeof AnilistSettings>;
export type MyAnimeListSettings = z.infer<typeof MyAnimeListSettings>;
export type KitsuSettings = z.infer<typeof KitsuSettings>;
export type SimklSettings = z.infer<typeof SimklSettings>;
export type JellyfinFavoritesSettings = z.infer<typeof JellyfinFavoritesSettings>;
export type CustomUrlSettings = z.infer<typeof CustomUrlSettings>;
export type TmdbListSettings = z.infer<typeof TmdbListSettings>;
export type TmdbPopularSettings = z.infer<typeof TmdbPopularSettings>;
export type TmdbCollectionSettings = z.infer<typeof TmdbCollectionSettings>;
export type TmdbPersonSettings = z.infer<typeof TmdbPersonSettings>;
export type TmdbKeywordSettings = z.infer<typeof TmdbKeywordSettings>;
export type TraktListSettings = z.infer<typeof TraktListSettings>;
export type TraktPopularSettings = z.infer<typeof TraktPopularSettings>;
export type TraktUserSettings = z.infer<typeof TraktUserSettings>;
export type PlexWatchlistSettings = z.infer<typeof PlexWatchlistSettings>;
export type ImdbListSettings = z.infer<typeof ImdbListSettings>;
export type RssListSettings = z.infer<typeof RssListSettings>;
export type StevenLuSettings = z.infer<typeof StevenLuSettings>;

/** Settings schema per implementation; the api validates stored and submitted settings with it. */
export const importListSettingsSchemas = {
  tmdbList: TmdbListSettings,
  tmdbPopular: TmdbPopularSettings,
  tmdbCollection: TmdbCollectionSettings,
  tmdbPerson: TmdbPersonSettings,
  tmdbKeyword: TmdbKeywordSettings,
  trakt: TraktListSettings,
  traktPopular: TraktPopularSettings,
  traktUser: TraktUserSettings,
  plexWatchlist: PlexWatchlistSettings,
  imdbList: ImdbListSettings,
  rss: RssListSettings,
  stevenLu: StevenLuSettings,
  tmdbCompany: TmdbCompanySettings,
  tmdbNetwork: TmdbNetworkSettings,
  tmdbDiscover: TmdbDiscoverSettings,
  traktLists: TraktListsSettings,
  imdbTop: ImdbTopSettings,
  letterboxd: LetterboxdSettings,
  mdblist: MdblistSettings,
  anilist: AnilistSettings,
  myAnimeList: MyAnimeListSettings,
  kitsu: KitsuSettings,
  simkl: SimklSettings,
  jellyfinFavorites: JellyfinFavoritesSettings,
  customUrl: CustomUrlSettings,
} as const satisfies Record<ImportListImplementation, z.ZodType>;

export type ImportListSettingsMap = {
  [K in ImportListImplementation]: z.infer<(typeof importListSettingsSchemas)[K]>;
};

/** Settings fields stored secret: masked on read, kept when the mask is sent back. */
export const IMPORT_LIST_SECRET_FIELDS = [
  'clientSecret',
  'accessToken',
  'refreshToken',
  'plexToken',
  'apiKey',
  'headerValue',
] as const;

export const ImportListSettingsJson = z.record(z.string(), z.unknown());
export type ImportListSettingsJson = z.infer<typeof ImportListSettingsJson>;

// ---- list-level rules -----------------------------------------------------------------

/** Filters applied before a found title is added. Ratings are TMDB vote averages (0-10). */
export const ImportListFilters = z.object({
  minRating: z.number().min(0).max(10).optional(),
  minVotes: z.number().int().min(0).optional(),
  yearFrom: Year.optional(),
  yearTo: Year.optional(),
});
export type ImportListFilters = z.infer<typeof ImportListFilters>;

/** "Skip if streamable": titles included with one of these subscriptions in the region are not added. */
export const ImportListStreamingRule = z.object({
  enabled: z.boolean().default(false),
  /** ISO-3166-1; defaults to the instance region (Settings > Metadata). */
  region: z.string().trim().length(2).nullish(),
  /** TMDB watch-provider ids. */
  providerIds: z.array(z.number().int()).default([]),
});
export type ImportListStreamingRule = z.infer<typeof ImportListStreamingRule>;

/** What happens to a title this list added once it drops off the list (and off every other list). */
export const ImportListCleanupAction = z.enum(['none', 'unmonitor', 'remove', 'removeAndDeleteFiles']);
export type ImportListCleanupAction = z.infer<typeof ImportListCleanupAction>;

// ---- resource -------------------------------------------------------------------------

export const ImportList = z.object({
  id: z.number().int(),
  name: z.string(),
  implementation: ImportListImplementation,
  enabled: z.boolean(),
  /** Add new items automatically on sync; off = only fetch (preview, "found in list"). */
  enableAutomaticAdd: z.boolean(),
  searchOnAdd: z.boolean(),
  monitorOption: MonitorOption,
  seriesType: SeriesType,
  seasonFolder: z.boolean(),
  /** Root folder for added items (the series root when mediaType is `both`). */
  rootFolderPath: z.string(),
  /** Movie root folder when mediaType is `both`. */
  movieRootFolderPath: z.string().nullish(),
  qualityProfileId: z.number().int(),
  tags: z.array(z.number().int()),
  minimumAvailability: MinimumAvailability,
  mediaType: ImportListMediaType,
  settings: ImportListSettingsJson,
  /** Hours between syncs of this list; null = the global interval. */
  syncIntervalHours: z.number().int().nullable(),
  filters: ImportListFilters,
  streaming: ImportListStreamingRule,
  cleanupAction: ImportListCleanupAction,
  lastSyncAt: z.string().nullish(),
  lastSyncError: z.string().nullish(),
});
export type ImportList = z.infer<typeof ImportList>;

/** POST /importlist and PUT /importlist/:id body. Settings are validated per implementation. */
export const ImportListCreate = z.object({
  name: z.string().trim().min(1).max(100),
  implementation: ImportListImplementation,
  enabled: z.boolean().default(true),
  enableAutomaticAdd: z.boolean().default(true),
  searchOnAdd: z.boolean().default(false),
  monitorOption: MonitorOption.default('all'),
  seriesType: SeriesType.default('standard'),
  seasonFolder: z.boolean().default(true),
  rootFolderPath: z.string().min(1),
  movieRootFolderPath: z.string().min(1).nullish(),
  qualityProfileId: z.number().int(),
  tags: z.array(z.number().int()).default([]),
  minimumAvailability: MinimumAvailability.default('released'),
  mediaType: ImportListMediaType,
  settings: ImportListSettingsJson.default({}),
  // The rules below are optional on input (older clients omit them); the service applies the defaults.
  syncIntervalHours: z.number().int().min(1).max(720).nullish(),
  filters: ImportListFilters.optional(),
  streaming: ImportListStreamingRule.optional(),
  cleanupAction: ImportListCleanupAction.optional(),
});
export type ImportListCreate = z.infer<typeof ImportListCreate>;
export type ImportListCreateInput = z.input<typeof ImportListCreate>;

export const ImportListUpdate = ImportListCreate;
export type ImportListUpdate = ImportListCreate;

/** POST /importlist/test: an unsaved candidate, or a saved one (`id`) whose secrets are reused. */
export const ImportListTestRequest = ImportListCreate.extend({ id: z.number().int().positive().optional() });
export type ImportListTestRequest = z.infer<typeof ImportListTestRequest>;

/** One item a list returned on its last fetch. */
export const ImportListItem = z.object({
  importListId: z.number().int(),
  mediaType: MediaType,
  tmdbId: z.number().int(),
  imdbId: z.string().nullish(),
  title: z.string(),
  year: z.number().int().nullish(),
  /** Already in the library (computed on read). */
  inLibrary: z.boolean(),
  /** On the exclusion list (computed on read). */
  excluded: z.boolean(),
});
export type ImportListItem = z.infer<typeof ImportListItem>;

/** GET /importlist/items: the lists a title was found in ("found in list" chips). */
export const ImportListItemsQuery = z.object({
  mediaType: MediaType.optional(),
  tmdbId: z.coerce.number().int().optional(),
});
export type ImportListItemsQuery = z.infer<typeof ImportListItemsQuery>;

export const ImportListFoundItem = ImportListItem.extend({ importListName: z.string() });
export type ImportListFoundItem = z.infer<typeof ImportListFoundItem>;

export const ImportListTestResult = z.object({
  ok: z.boolean(),
  itemCount: z.number().int().optional(),
  /** The first items fetched (at most 10). */
  items: z.array(ImportListItem.omit({ importListId: true })).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type ImportListTestResult = z.infer<typeof ImportListTestResult>;

/** Why a found title would not be added (`add` = it would be). */
export const ImportListPreviewOutcome = z.enum(['add', 'inLibrary', 'excluded', 'rating', 'votes', 'year', 'streaming']);
export type ImportListPreviewOutcome = z.infer<typeof ImportListPreviewOutcome>;

export const ImportListPreviewItem = ImportListItem.omit({ importListId: true }).extend({
  outcome: ImportListPreviewOutcome,
  /** Services the title streams on (streaming rule only). */
  streamingOn: z.array(z.string()).optional(),
});
export type ImportListPreviewItem = z.infer<typeof ImportListPreviewItem>;

/** POST /importlist/preview: what a list would do right now, before it is enabled. */
export const ImportListPreviewResult = z.object({
  ok: z.boolean(),
  itemCount: z.number().int().optional(),
  /** Titles a sync would add. */
  wouldAdd: z.number().int().optional(),
  counts: z.partialRecord(ImportListPreviewOutcome, z.number().int()).optional(),
  /** Resolved items with their outcome, titles to add first (at most 500). */
  items: z.array(ImportListPreviewItem).optional(),
  /** Entries dropped because no TMDB id was found for them (unmapped anime, unknown slugs). */
  unresolved: z.number().int().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type ImportListPreviewResult = z.infer<typeof ImportListPreviewResult>;

export const ImportListSyncResult = z.object({
  lists: z.number().int(),
  fetched: z.number().int(),
  added: z.number().int(),
  skippedExisting: z.number().int(),
  skippedExcluded: z.number().int(),
  failed: z.number().int(),
  /** Library items unmonitored or removed by "clean library" and per-list clean-up. */
  cleaned: z.number().int(),
  /** Found titles skipped by a list's rating/votes/year filters or its streaming rule. */
  skippedFiltered: z.number().int().default(0),
  errors: z.array(z.object({ importListId: z.number().int(), name: z.string(), message: z.string() })),
});
export type ImportListSyncResult = z.infer<typeof ImportListSyncResult>;

// ---- schema (form definitions) --------------------------------------------------------

export const ImportListFieldType = z.enum([
  'text',
  'password',
  'url',
  'number',
  'boolean',
  'select',
  'textList',
  'numberList',
  /** Several of `options` (an array of their values). */
  'multiSelect',
]);
export type ImportListFieldType = z.infer<typeof ImportListFieldType>;

export const ImportListField = z.object({
  name: z.string(),
  label: z.string(),
  type: ImportListFieldType,
  helpText: z.string().optional(),
  required: z.boolean(),
  secret: z.boolean(),
  /** Filled by the server (OAuth tokens): shown read-only. */
  readOnly: z.boolean().optional(),
  default: z.unknown().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});
export type ImportListField = z.infer<typeof ImportListField>;

export const ImportListSchema = z.object({
  implementation: ImportListImplementation,
  implementationName: z.string(),
  /** Media types the implementation can return. */
  supportedMediaTypes: z.array(ImportListMediaType),
  /** True when the list needs the Trakt device-code flow. */
  requiresTraktAuth: z.boolean(),
  /** True when the list authenticates with the Simkl PIN flow. */
  requiresSimklAuth: z.boolean().optional(),
  infoLink: z.string().optional(),
  fields: z.array(ImportListField),
});
export type ImportListSchema = z.infer<typeof ImportListSchema>;

// ---- exclusions -----------------------------------------------------------------------

/** Exclusions share the library's import exclusion table (titles never re-added). */
export const ImportListExclusion = z.object({
  id: z.number().int(),
  mediaType: MediaType,
  tmdbId: z.number().int(),
  title: z.string(),
  year: z.number().int().nullish(),
});
export type ImportListExclusion = z.infer<typeof ImportListExclusion>;

export const ImportListExclusionCreate = z.object({
  mediaType: MediaType,
  tmdbId: z.number().int().positive(),
  title: z.string().trim().min(1),
  year: z.number().int().nullish(),
});
export type ImportListExclusionCreate = z.infer<typeof ImportListExclusionCreate>;

// ---- trakt device-code flow -----------------------------------------------------------

export const TraktDeviceRequest = z.object({ clientId: z.string().trim().min(1) });
export type TraktDeviceRequest = z.infer<typeof TraktDeviceRequest>;

export const TraktDeviceResponse = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationUrl: z.string(),
  /** Seconds. */
  expiresIn: z.number().int(),
  /** Seconds between polls. */
  interval: z.number().int(),
});
export type TraktDeviceResponse = z.infer<typeof TraktDeviceResponse>;

export const TraktPollRequest = z.object({
  deviceCode: z.string().min(1),
  clientId: z.string().trim().min(1),
  /** Omit (or send the mask) with importListId to reuse the stored secret. */
  clientSecret: z.string().optional(),
  /** Store the tokens on this saved list. Without it an `authRef` is returned for the create body. */
  importListId: z.number().int().positive().optional(),
});
export type TraktPollRequest = z.infer<typeof TraktPollRequest>;

export const TraktPollResponse = z.object({
  status: z.enum(['pending', 'slowDown', 'authorized', 'denied', 'expired', 'invalid']),
  /** Put into settings.authRef when creating the list (only when no importListId was given). */
  authRef: z.string().optional(),
  /** The updated list, secrets masked (only when importListId was given). */
  importList: ImportList.optional(),
});
export type TraktPollResponse = z.infer<typeof TraktPollResponse>;

// ---- simkl PIN flow -------------------------------------------------------------------

export const SimklPinRequest = z.object({ clientId: z.string().trim().min(1) });
export type SimklPinRequest = z.infer<typeof SimklPinRequest>;

export const SimklPinResponse = z.object({
  userCode: z.string(),
  verificationUrl: z.string(),
  /** Seconds. */
  expiresIn: z.number().int(),
  /** Seconds between polls. */
  interval: z.number().int(),
});
export type SimklPinResponse = z.infer<typeof SimklPinResponse>;

export const SimklPollRequest = z.object({
  userCode: z.string().min(1),
  clientId: z.string().trim().min(1),
  /** Store the token on this saved list. Without it an `authRef` is returned for the create body. */
  importListId: z.number().int().positive().optional(),
});
export type SimklPollRequest = z.infer<typeof SimklPollRequest>;

export const SimklPollResponse = z.object({
  status: z.enum(['pending', 'authorized', 'expired']),
  authRef: z.string().optional(),
  importList: ImportList.optional(),
});
export type SimklPollResponse = z.infer<typeof SimklPollResponse>;

// ---- settings section -----------------------------------------------------------------

export const CleanLibraryLevel = z.enum(['disabled', 'logOnly', 'unmonitor', 'remove', 'removeAndDeleteFiles']);
export type CleanLibraryLevel = z.infer<typeof CleanLibraryLevel>;

/** Stored form of the `importLists` settings section; GET/PUT /settings/importlists. */
export const ImportListSettings = z.object({
  /** Hours between automatic syncs of each list. */
  syncIntervalHours: z.number().int().min(1).max(168).default(6),
  /** What to do with library items no longer on any enabled list. */
  cleanLibraryLevel: CleanLibraryLevel.default('disabled'),
  /** Only library items carrying one of these tags are cleaned; empty = every item. */
  cleanLibraryTags: z.array(z.number().int()).default([]),
});
export type ImportListSettings = z.infer<typeof ImportListSettings>;
export type ImportListSettingsInput = z.input<typeof ImportListSettings>;

export const ImportListsErrorResponse = z.object({ error: z.string(), code: z.string().optional() });
export type ImportListsErrorResponse = z.infer<typeof ImportListsErrorResponse>;

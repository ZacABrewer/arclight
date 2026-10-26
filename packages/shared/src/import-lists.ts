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
  listType: z.enum(['popular', 'topRated', 'trending']).default('popular'),
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
  listType: z.enum(['trending', 'popular', 'anticipated', 'watched', 'boxOffice']).default('popular'),
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
  listType: z.enum(['watchlist', 'watched', 'collection']).default('watchlist'),
  limit: TraktLimit,
});
export const PlexWatchlistSettings = z.object({ plexToken: z.string().min(1) });
export const ImdbListSettings = z.object({
  /** `ls` list id or `ur` user id (that user's watchlist). */
  listId: z.string().trim().regex(/^(ls|ur)\d+$/, 'expected an IMDb list id (ls...) or user id (ur...)'),
});
export const RssListSettings = z.object({ url: z.url() });
export const StevenLuSettings = z.object({
  url: z.url().default('https://s3.amazonaws.com/popular-movies/movies.json'),
});

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
} as const satisfies Record<ImportListImplementation, z.ZodType>;

export type ImportListSettingsMap = {
  [K in ImportListImplementation]: z.infer<(typeof importListSettingsSchemas)[K]>;
};

/** Settings fields stored secret: masked on read, kept when the mask is sent back. */
export const IMPORT_LIST_SECRET_FIELDS = ['clientSecret', 'accessToken', 'refreshToken', 'plexToken'] as const;

export const ImportListSettingsJson = z.record(z.string(), z.unknown());
export type ImportListSettingsJson = z.infer<typeof ImportListSettingsJson>;

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

export const ImportListSyncResult = z.object({
  lists: z.number().int(),
  fetched: z.number().int(),
  added: z.number().int(),
  skippedExisting: z.number().int(),
  skippedExcluded: z.number().int(),
  failed: z.number().int(),
  /** Library items unmonitored or removed by "clean library". */
  cleaned: z.number().int(),
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

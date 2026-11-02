import { z } from 'zod';
import { MediaType } from './library.js';
import { IssueType, MediaRequest, RequestStatus, WatchlistItem } from './requests.js';
import { CreateLanguageRequest, LanguageRequest, LanguageRequestOptions } from './language-requests.js';
import { SubtitleLanguageOption } from './subtitles.js';

// The API the Arclight Jellyfin plugin calls (routes under /api/v1/jellyfin, docs/API.md
// "Jellyfin plugin"). The plugin authenticates with a plugin key (`X-Api-Key`; created under
// Settings > Media servers > Jellyfin plugin), which may call these routes and nothing else.
// Per-user routes also carry `X-Arclight-Jellyfin-User: <Jellyfin user id>`; Arclight runs them as
// the Arclight user linked to that Jellyfin account, with that user's permissions, request types
// and quotas. Jellyfin stays the source of truth: Arclight never writes to it from here.

/** Header naming the Jellyfin user a per-user call acts for (GUID, with or without dashes). */
export const JELLYFIN_USER_HEADER = 'x-arclight-jellyfin-user';

/** Plugin repository manifest users add to Jellyfin (Dashboard > Plugins > Repositories). */
export const JELLYFIN_PLUGIN_MANIFEST_URL = 'https://arclight.moviemethat.com/jellyfin/manifest.json';
/** Latest plugin version this Arclight release knows of (static until the manifest is read). */
export const JELLYFIN_PLUGIN_LATEST_VERSION = '1.2.0.0';

/** Features GET /jellyfin/ping advertises; the plugin hides UI for features that are missing. */
export const JELLYFIN_PLUGIN_FEATURES = [
  'events',
  'status',
  'search',
  'title',
  'request',
  'languageRequest',
  'issue',
  'watchlist',
  'discover',
  'upcoming',
  'providers',
  'requests',
  'themes',
] as const;

/**
 * Why a title cannot be requested by this account:
 * `available` (already in the library), `requested` (already requested / processing),
 * `permission` (no request permission for this type / 4K), `request_type` (the account's request
 * type filter excludes it), `content_restricted` (above the account's content caps; such titles are
 * normally filtered out entirely), `quota` (request quota used up).
 */
export const JellyfinRequestBlockReason = z.enum(['available', 'requested', 'permission', 'request_type', 'content_restricted', 'quota']);
export type JellyfinRequestBlockReason = z.infer<typeof JellyfinRequestBlockReason>;

// ---------------------------------------------------------------------------------------
// Plugin keys (admin: /settings/jellyfinplugin)
// ---------------------------------------------------------------------------------------

/** A stored plugin key; the secret is only shown once, on creation. */
export const JellyfinPluginKey = z.object({
  id: z.number().int(),
  name: z.string(),
  /** First characters of the key, to tell keys apart. */
  prefix: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  lastPingAt: z.string().nullable(),
});
export type JellyfinPluginKey = z.infer<typeof JellyfinPluginKey>;

export const JellyfinPluginKeyCreate = z.object({ name: z.string().trim().min(1).max(100).default('Jellyfin plugin') });
export type JellyfinPluginKeyCreate = z.input<typeof JellyfinPluginKeyCreate>;

/** POST /settings/jellyfinplugin/keys: the new key, with its secret (shown once). */
export const JellyfinPluginKeyCreated = JellyfinPluginKey.extend({ key: z.string() });
export type JellyfinPluginKeyCreated = z.infer<typeof JellyfinPluginKeyCreated>;

/** GET /settings/jellyfinplugin: the plugin card. */
export const JellyfinPluginOverview = z.object({
  manifestUrl: z.string(),
  latestVersion: z.string(),
  keys: z.array(JellyfinPluginKey),
  /** Latest ping by any plugin key. */
  lastPingAt: z.string().nullable(),
  /** Jellyfin/Emby servers and the last event their plugin sent. */
  servers: z.array(z.object({ serverId: z.string(), name: z.string(), remoteId: z.string().nullable(), lastEventAt: z.string().nullable() })),
});
export type JellyfinPluginOverview = z.infer<typeof JellyfinPluginOverview>;

// ---------------------------------------------------------------------------------------
// GET /jellyfin/ping, GET /jellyfin/plugin
// ---------------------------------------------------------------------------------------

export const JellyfinPing = z.object({
  /** Arclight version. */
  version: z.string(),
  /** Arclight instance name. */
  serverName: z.string(),
  features: z.array(z.string()),
  /** Arclight users linked to a Jellyfin/Emby account. */
  linkedUsers: z.number().int(),
});
export type JellyfinPing = z.infer<typeof JellyfinPing>;

export const JellyfinPluginInfo = z.object({ latestVersion: z.string(), manifestUrl: z.string() });
export type JellyfinPluginInfo = z.infer<typeof JellyfinPluginInfo>;

// ---------------------------------------------------------------------------------------
// POST /jellyfin/events
// ---------------------------------------------------------------------------------------

export const JellyfinEventType = z.enum([
  'playbackStart',
  'playbackProgress',
  'playbackStop',
  'userDataSaved',
  'itemAdded',
  'userCreated',
  'userUpdated',
  'userDeleted',
]);
export type JellyfinEventType = z.infer<typeof JellyfinEventType>;

const ProviderIdMap = z.record(z.string(), z.string());

export const JellyfinEventItem = z.object({
  id: z.string().min(1).max(64),
  /** Movie, Episode, Series, Season, MusicAlbum, Audio, AudioBook, or any other Jellyfin type. */
  type: z.string().min(1).max(64),
  name: z.string().max(1000),
  providerIds: ProviderIdMap.default({}),
  /** Episodes and seasons: the series' provider ids. */
  seriesProviderIds: ProviderIdMap.optional(),
  seasonNumber: z.number().int().optional(),
  episodeNumber: z.number().int().optional(),
  runTimeTicks: z.number().optional(),
});
export type JellyfinEventItem = z.infer<typeof JellyfinEventItem>;

export const JellyfinEvent = z.object({
  type: JellyfinEventType,
  /** ISO-8601. */
  at: z.string().min(1).max(64),
  jellyfinUserId: z.string().max(64).optional(),
  userName: z.string().max(256).optional(),
  item: JellyfinEventItem.optional(),
  positionTicks: z.number().optional(),
  played: z.boolean().optional(),
  playCount: z.number().int().optional(),
  isFavorite: z.boolean().optional(),
  client: z.string().max(256).optional(),
  deviceName: z.string().max(256).optional(),
  playMethod: z.enum(['DirectPlay', 'DirectStream', 'Transcode']).optional(),
  sessionId: z.string().max(128).optional(),
});
export type JellyfinEvent = z.infer<typeof JellyfinEvent>;

export const JELLYFIN_EVENTS_MAX = 500;

export const JellyfinEventBatch = z.object({
  /** The Jellyfin server's System/Info Id. */
  serverId: z.string().min(1).max(128),
  events: z.array(JellyfinEvent).max(JELLYFIN_EVENTS_MAX),
});
export type JellyfinEventBatch = z.input<typeof JellyfinEventBatch>;

export const JellyfinEventsAccepted = z.object({ accepted: z.number().int() });
export type JellyfinEventsAccepted = z.infer<typeof JellyfinEventsAccepted>;

// ---------------------------------------------------------------------------------------
// Status badges: GET /jellyfin/status?items=…, POST /jellyfin/status
// ---------------------------------------------------------------------------------------

export const JellyfinStatusQuery = z.object({
  /** Comma-separated Jellyfin item ids, at most 100. */
  items: z.string().min(1).max(10_000),
});
export type JellyfinStatusQuery = z.infer<typeof JellyfinStatusQuery>;

export const JellyfinStatusItemInput = z.object({
  id: z.string().min(1).max(64),
  type: z.string().min(1).max(64),
  providerIds: ProviderIdMap.default({}),
  /** Optional extras (not in the minimal contract): episodes and seasons resolve through their series. */
  seriesProviderIds: ProviderIdMap.optional(),
  seasonNumber: z.number().int().optional(),
  episodeNumber: z.number().int().optional(),
});
export type JellyfinStatusItemInput = z.input<typeof JellyfinStatusItemInput>;

export const JELLYFIN_STATUS_MAX = 100;

export const JellyfinStatusRequest = z.object({ items: z.array(JellyfinStatusItemInput).min(1).max(JELLYFIN_STATUS_MAX) });
export type JellyfinStatusRequest = z.input<typeof JellyfinStatusRequest>;

export const JellyfinItemStatus = z.object({
  id: z.string(),
  /** The movie/series is in Arclight's library. */
  inLibrary: z.boolean(),
  /** Library item (or episode) monitored. */
  monitored: z.boolean().optional(),
  /** Newest active request (normal track first, else 4K). `requestedBy`: display name (empty when the caller may not see who asked). */
  request: z
    .object({ id: z.number().int(), status: RequestStatus, requestedBy: z.string(), requestedAt: z.string(), is4k: z.boolean() })
    .optional(),
  /** Active download of the item (series: any of its episodes; episode: that episode). `progress` is a fraction 0..1, not a percentage. */
  download: z.object({ progress: z.number().min(0).max(1), etaSeconds: z.number().int().optional(), status: z.string() }).optional(),
  /** Not available yet: next release (movie) or next air date (series/season). */
  upcoming: z.object({ releaseDate: z.string() }).optional(),
  /** Series/season: monitored, aired episodes without a file. */
  missingEpisodes: z.number().int().optional(),
});
export type JellyfinItemStatus = z.infer<typeof JellyfinItemStatus>;

export const JellyfinStatusResponse = z.object({ items: z.array(JellyfinItemStatus) });
export type JellyfinStatusResponse = z.infer<typeof JellyfinStatusResponse>;

// ---------------------------------------------------------------------------------------
// GET /jellyfin/search, GET /jellyfin/title/:mediaType/:tmdbId
// ---------------------------------------------------------------------------------------

export const JellyfinTitleStatus = z.enum(['available', 'partial', 'requested', 'processing', 'none']);
export type JellyfinTitleStatus = z.infer<typeof JellyfinTitleStatus>;

export const JellyfinSearchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  type: z.enum(['movie', 'series', 'all']).default('all'),
  page: z.coerce.number().int().min(1).max(500).default(1),
});
export type JellyfinSearchQuery = z.input<typeof JellyfinSearchQuery>;

export const JellyfinSearchItem = z.object({
  tmdbId: z.number().int(),
  mediaType: MediaType,
  title: z.string(),
  year: z.number().int().nullable(),
  posterUrl: z.string().nullable(),
  overview: z.string(),
  status: JellyfinTitleStatus,
  canRequest: z.boolean(),
  canRequest4k: z.boolean(),
  /** Why `canRequest` is false (null when it is true). The plugin shows the reason instead of a Request button. */
  requestBlockedReason: JellyfinRequestBlockReason.nullable().optional(),
});
export type JellyfinSearchItem = z.infer<typeof JellyfinSearchItem>;

export const JellyfinSearchPage = z.object({
  page: z.number().int(),
  totalPages: z.number().int(),
  totalResults: z.number().int(),
  results: z.array(JellyfinSearchItem),
});
export type JellyfinSearchPage = z.infer<typeof JellyfinSearchPage>;

/** `tv` is accepted as an alias of `series`. */
export const JellyfinMediaType = z.enum(['movie', 'series', 'tv']).transform((t) => (t === 'tv' ? 'series' : t));

export const JellyfinTitleParams = z.object({ mediaType: JellyfinMediaType, tmdbId: z.coerce.number().int().positive() });
export type JellyfinTitleParams = z.input<typeof JellyfinTitleParams>;

export const JellyfinGenre = z.object({ id: z.number().int(), name: z.string() });
export type JellyfinGenre = z.infer<typeof JellyfinGenre>;

export const JellyfinTitleSeason = z.object({
  seasonNumber: z.number().int(),
  name: z.string().nullable(),
  episodeCount: z.number().int(),
  airDate: z.string().nullable(),
  status: JellyfinTitleStatus,
  status4k: JellyfinTitleStatus,
});
export type JellyfinTitleSeason = z.infer<typeof JellyfinTitleSeason>;

export const JellyfinTitle = z.object({
  tmdbId: z.number().int(),
  mediaType: MediaType,
  title: z.string(),
  year: z.number().int().nullable(),
  overview: z.string(),
  posterUrl: z.string().nullable(),
  backdropUrl: z.string().nullable(),
  status: JellyfinTitleStatus,
  status4k: JellyfinTitleStatus,
  canRequest: z.boolean(),
  canRequest4k: z.boolean(),
  /** Why `canRequest` is false (null when it is true). */
  requestBlockedReason: JellyfinRequestBlockReason.nullable().optional(),
  /** Series: whether "future seasons" (also grab seasons that air later) can be requested. */
  canRequestFutureSeasons: z.boolean().optional(),
  /** The user may pick a quality profile (`qualityProfiles` is then filled). */
  canRequestAdvanced: z.boolean(),
  qualityProfiles: z.array(z.object({ id: z.number().int(), name: z.string() })),
  /** Series only. */
  seasons: z.array(JellyfinTitleSeason),
  /** Requests for this title the user may see. */
  requests: z.array(MediaRequest),
  onWatchlist: z.boolean(),
  /** Language requests: whether the user may ask for subtitles / extra audio languages. */
  canRequestSubtitles: z.boolean(),
  canRequestAudio: z.boolean(),
  /** Languages that can be requested (code + English name). */
  languages: z.array(SubtitleLanguageOption),
  /** What the title already has (in the library) and open language requests. */
  languageOptions: LanguageRequestOptions,

  // ---- title page (plugin 1.2): optional so older Arclight answers still parse ----
  /** The title is in Arclight's library (movie or series row). */
  inLibrary: z.boolean().optional(),
  tagline: z.string().nullable().optional(),
  runtimeMinutes: z.number().int().nullable().optional(),
  /** US certification (PG-13, TV-MA, ...), null when unknown. */
  certification: z.string().nullable().optional(),
  /** TMDB score 0-10. */
  voteAverage: z.number().nullable().optional(),
  genres: z.array(JellyfinGenre).optional(),
  /** Top-billed cast, at most 15. */
  cast: z.array(z.object({ name: z.string(), character: z.string().nullable(), profileUrl: z.string().nullable() })).optional(),
  /** Movies: directors. */
  directors: z.array(z.string()).optional(),
  /** Series: creators. */
  creators: z.array(z.string()).optional(),
  /** Series: networks; movies: production companies (studios). */
  networks: z.array(z.string()).optional(),
  studios: z.array(z.string()).optional(),
  /** The main trailer, opened in a new tab (never embedded). */
  trailer: z.object({ site: z.string(), key: z.string(), url: z.string() }).nullable().optional(),
  releaseDates: z
    .object({
      cinema: z.string().nullable(),
      digital: z.string().nullable(),
      physical: z.string().nullable(),
      firstAirDate: z.string().nullable(),
      lastAirDate: z.string().nullable(),
    })
    .optional(),
  /** TMDB recommendations (search item shape), capped titles left out. */
  recommendations: z.array(JellyfinSearchItem).optional(),
});
export type JellyfinTitle = z.infer<typeof JellyfinTitle>;

// ---------------------------------------------------------------------------------------
// POST /jellyfin/request, /jellyfin/language-request, /jellyfin/issue
// ---------------------------------------------------------------------------------------

export const JellyfinRequestInput = z.object({
  mediaType: JellyfinMediaType,
  tmdbId: z.number().int().positive(),
  seasons: z.union([z.array(z.number().int().min(0)).min(1), z.literal('all')]).optional(),
  is4k: z.boolean().default(false),
  /** Only honoured when the user may make advanced requests (`profileId` is an alias). */
  qualityProfileId: z.number().int().optional(),
  profileId: z.number().int().optional(),
});
export type JellyfinRequestInput = z.input<typeof JellyfinRequestInput>;

/** The language request body of POST /request/language, without `userId`. */
export const JellyfinLanguageRequestInput = CreateLanguageRequest;
export type JellyfinLanguageRequestInput = z.input<typeof JellyfinLanguageRequestInput>;
export { LanguageRequest as JellyfinLanguageRequestResult };

export const JellyfinIssueInput = z.object({
  mediaType: JellyfinMediaType,
  tmdbId: z.number().int().positive(),
  seasonNumber: z.number().int().min(0).optional(),
  episodeNumber: z.number().int().min(0).optional(),
  type: IssueType,
  message: z.string().trim().min(1).max(5000),
});
export type JellyfinIssueInput = z.input<typeof JellyfinIssueInput>;

// ---------------------------------------------------------------------------------------
// /jellyfin/watchlist
// ---------------------------------------------------------------------------------------

export const JellyfinWatchlistAdd = z.object({ mediaType: JellyfinMediaType, tmdbId: z.number().int().positive() });
export type JellyfinWatchlistAdd = z.input<typeof JellyfinWatchlistAdd>;

/** DELETE /jellyfin/watchlist: by item id, or by title. */
export const JellyfinWatchlistDeleteQuery = z.object({
  id: z.coerce.number().int().positive().optional(),
  mediaType: JellyfinMediaType.optional(),
  tmdbId: z.coerce.number().int().positive().optional(),
});
export type JellyfinWatchlistDeleteQuery = z.input<typeof JellyfinWatchlistDeleteQuery>;

/** One watchlist entry as the plugin sees it (`id` is what DELETE /jellyfin/watchlist/:id takes). */
export const JellyfinWatchlistItem = z.object({
  id: z.number().int(),
  mediaType: MediaType,
  tmdbId: z.number().int(),
  title: z.string(),
  year: z.number().int().nullable(),
  posterUrl: z.string().nullable(),
  source: WatchlistItem.shape.source,
  addedAt: z.string(),
});
export type JellyfinWatchlistItem = z.infer<typeof JellyfinWatchlistItem>;

export const JellyfinWatchlist = z.object({ items: z.array(JellyfinWatchlistItem) });
export type JellyfinWatchlist = z.infer<typeof JellyfinWatchlist>;

/** Errors: `{ error, code }`; `code: 'not_linked'` (403) when the Jellyfin user has no Arclight user. */
export const JellyfinErrorResponse = z.object({ error: z.string(), code: z.string().optional() });
export type JellyfinErrorResponse = z.infer<typeof JellyfinErrorResponse>;

// ---------------------------------------------------------------------------------------
// Discover rows, upcoming, watch providers, my requests (per user)
// ---------------------------------------------------------------------------------------

/**
 * Discover rows. `trending` = `trendingWeek`. `recommended`: TMDB recommendations of the user's five
 * most recently watched titles (Arclight watch history), deduplicated, without titles that are in the
 * library; falls back to trending when there is no history.
 */
export const JellyfinDiscoverCategory = z.enum([
  'recommended',
  'trending',
  'trendingDay',
  'trendingWeek',
  'popularMovies',
  'popularSeries',
  'topRatedMovies',
  'topRatedSeries',
  'nowPlaying',
  'upcomingMovies',
  'upcomingSeries',
  'airingToday',
  'onTheAir',
]);
export type JellyfinDiscoverCategory = z.infer<typeof JellyfinDiscoverCategory>;

/** GET /jellyfin/discover: same page shape as /jellyfin/search, filtered by the account's content caps. */
export const JellyfinDiscoverQuery = z.object({
  category: JellyfinDiscoverCategory,
  page: z.coerce.number().int().min(1).max(500).default(1),
});
export type JellyfinDiscoverQuery = z.input<typeof JellyfinDiscoverQuery>;

/** GET /jellyfin/upcoming. */
export const JellyfinUpcomingQuery = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) });
export type JellyfinUpcomingQuery = z.input<typeof JellyfinUpcomingQuery>;

/**
 * One upcoming release from Arclight's calendar (monitored library items only). Accounts without
 * View requests see only titles they requested themselves, or library titles allowed by their
 * content caps; admins and View requests see everything.
 */
export const JellyfinUpcomingItem = z.object({
  /** ISO date-time (episodes: air time; movies: the release date). */
  date: z.string(),
  kind: z.enum(['movie', 'episode']),
  /** Movies: cinema / digital / physical; null for episodes. */
  releaseType: z.enum(['cinema', 'digital', 'physical']).nullable(),
  mediaType: MediaType,
  tmdbId: z.number().int().nullable(),
  title: z.string(),
  year: z.number().int().nullable(),
  posterUrl: z.string().nullable(),
  seasonNumber: z.number().int().nullable(),
  episodeNumber: z.number().int().nullable(),
  episodeTitle: z.string().nullable(),
  /** The release already has a file. */
  hasFile: z.boolean(),
});
export type JellyfinUpcomingItem = z.infer<typeof JellyfinUpcomingItem>;

export const JellyfinUpcoming = z.object({ days: z.number().int(), items: z.array(JellyfinUpcomingItem) });
export type JellyfinUpcoming = z.infer<typeof JellyfinUpcoming>;

/** GET /jellyfin/providers/:mediaType/:tmdbId?region=US (TMDB watch providers; data from JustWatch). */
export const JellyfinProvidersQuery = z.object({
  region: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/)
    .transform((r) => r.toUpperCase())
    .default('US'),
});
export type JellyfinProvidersQuery = z.input<typeof JellyfinProvidersQuery>;

export const JellyfinProvider = z.object({ id: z.number().int(), name: z.string(), logoUrl: z.string().nullable() });
export type JellyfinProvider = z.infer<typeof JellyfinProvider>;

export const JellyfinProviders = z.object({
  region: z.string(),
  /** TMDB's watch page for the title in that region (null when TMDB has none). */
  link: z.string().nullable(),
  flatrate: z.array(JellyfinProvider),
  rent: z.array(JellyfinProvider),
  buy: z.array(JellyfinProvider),
  /** Required attribution wherever the providers are shown. */
  attribution: z.literal('Data from JustWatch'),
});
export type JellyfinProviders = z.infer<typeof JellyfinProviders>;

/** GET /jellyfin/requests: the caller's own requests (media and language), newest first. */
export const JellyfinRequestsQuery = z.object({
  take: z.coerce.number().int().min(1).max(100).default(20),
  skip: z.coerce.number().int().min(0).default(0),
});
export type JellyfinRequestsQuery = z.input<typeof JellyfinRequestsQuery>;

export const JellyfinMyRequest = z.object({
  kind: z.enum(['media', 'language']),
  id: z.number().int(),
  mediaType: MediaType,
  tmdbId: z.number().int(),
  title: z.string(),
  year: z.number().int().nullable(),
  posterUrl: z.string().nullable(),
  /** Media requests: RequestStatus; language requests: their status. */
  status: z.string(),
  is4k: z.boolean(),
  /** Series media requests: requested seasons (empty = all). */
  seasons: z.array(z.number().int()),
  /** Language requests: subtitle/audio and the language. */
  language: z.object({ kind: z.enum(['subtitle', 'audio']), language: z.string() }).nullable(),
  createdAt: z.string(),
  /** Active download progress 0..1 of the requested title, when downloading. */
  progress: z.number().min(0).max(1).nullable(),
  /** The caller may cancel (delete) it now: their own pending request, and Arclight allows that. */
  canCancel: z.boolean(),
});
export type JellyfinMyRequest = z.infer<typeof JellyfinMyRequest>;

export const JellyfinMyRequests = z.object({ total: z.number().int(), items: z.array(JellyfinMyRequest) });
export type JellyfinMyRequests = z.infer<typeof JellyfinMyRequests>;

/** DELETE /jellyfin/requests/:id?kind=media|language. */
export const JellyfinRequestDeleteQuery = z.object({ kind: z.enum(['media', 'language']).default('media') });
export type JellyfinRequestDeleteQuery = z.input<typeof JellyfinRequestDeleteQuery>;

/** GET /jellyfin/userconfig (per user): the account facts the plugin uses (theme, request rights). */
export const JellyfinUserConfig = z.object({
  /** The Arclight theme this account uses (own pick, else the server default); null = built-in Tron (no Jellyfin stylesheet). */
  theme: z.string().nullable(),
  canRequestMovies: z.boolean(),
  canRequestSeries: z.boolean(),
  canRequest4k: z.boolean(),
  canViewAllRequests: z.boolean(),
});
export type JellyfinUserConfig = z.infer<typeof JellyfinUserConfig>;

// ---------------------------------------------------------------------------------------
// Themes in Jellyfin: GET /jellyfin/themes, GET /jellyfin/theme/:themeId.css
// ---------------------------------------------------------------------------------------

export const JellyfinThemeInfo = z.object({ id: z.string(), name: z.string(), version: z.string(), dark: z.boolean() });
export type JellyfinThemeInfo = z.infer<typeof JellyfinThemeInfo>;

export const JellyfinThemes = z.object({
  /** Server default Arclight theme (null = built-in Tron). */
  defaultTheme: z.string().nullable(),
  themes: z.array(JellyfinThemeInfo),
});
export type JellyfinThemes = z.infer<typeof JellyfinThemes>;

// ---------------------------------------------------------------------------------------
// Genres (plugin 1.2): GET /jellyfin/genres/:mediaType, GET /jellyfin/discover/genre/:mediaType/:genreId
// ---------------------------------------------------------------------------------------

export const JellyfinGenreParams = z.object({ mediaType: JellyfinMediaType });
export type JellyfinGenreParams = z.input<typeof JellyfinGenreParams>;

export const JellyfinGenres = z.object({ mediaType: MediaType, genres: z.array(JellyfinGenre) });
export type JellyfinGenres = z.infer<typeof JellyfinGenres>;

export const JellyfinGenreSort = z.enum(['popularity', 'rating', 'releaseDate', 'title']);
export type JellyfinGenreSort = z.infer<typeof JellyfinGenreSort>;

export const JellyfinGenreDiscoverParams = z.object({ mediaType: JellyfinMediaType, genreId: z.coerce.number().int().positive() });
export type JellyfinGenreDiscoverParams = z.input<typeof JellyfinGenreDiscoverParams>;

/** GET /jellyfin/discover/genre/:mediaType/:genreId → JellyfinSearchPage (content caps applied). */
export const JellyfinGenreDiscoverQuery = z.object({
  sort: JellyfinGenreSort.default('popularity'),
  page: z.coerce.number().int().min(1).max(500).default(1),
});
export type JellyfinGenreDiscoverQuery = z.input<typeof JellyfinGenreDiscoverQuery>;

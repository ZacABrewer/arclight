import { z } from 'zod';

// Playback statistics over the watch history (watch_events / watch_state), the per-user
// Year in review ("Wrapped") with expiring share links, the weekly "recently added" newsletter,
// and what the Jellyfin plugin may show to whom. Behaviour: docs/using/media-servers.md
// ("Playback stats and Wrapped").

/** Who sees the server-wide stats inside Jellyfin. */
export const StatsAudience = z.enum(['nobody', 'admins', 'everyone']);
export type StatsAudience = z.infer<typeof StatsAudience>;

/** Stored form of the `watchStats` section; also the GET/PUT body of /settings/watchstats. */
export const WatchStatsSettings = z.object({
  /** What the Jellyfin plugin shows (the plugin's own toggles can only hide more). */
  jellyfin: z
    .object({
      /** "My stats" page for every linked user. */
      myStats: z.boolean().default(true),
      /** Year in review page for every linked user. */
      wrapped: z.boolean().default(true),
      /** Server-wide stats page. Admins = Arclight admins and Jellyfin administrators. */
      serverStats: StatsAudience.default('admins'),
      /** Server stats name other users (most active users); off shows totals only to non-admins. */
      showUserNames: z.boolean().default(false),
    })
    .default({ myStats: true, wrapped: true, serverStats: 'admins', showUserNames: false }),
  wrapped: z
    .object({
      /** Users may create share links to their Year in review. */
      shareLinks: z.boolean().default(true),
      /** Days a share link stays valid. */
      shareLinkDays: z.number().int().min(1).max(90).default(14),
    })
    .default({ shareLinks: true, shareLinkDays: 14 }),
  newsletter: z
    .object({
      enabled: z.boolean().default(false),
      /** Email notification connection whose SMTP server sends it (Settings > Notifications). */
      notificationId: z.number().int().positive().nullable().default(null),
      /** connection: the connection's own To/Cc/Bcc; users: Bcc every active user with an email address. */
      recipients: z.enum(['connection', 'users']).default('connection'),
      /** 0 = Sunday ... 6 = Saturday, server local time. */
      weekday: z.number().int().min(0).max(6).default(5),
      hour: z.number().int().min(0).max(23).default(9),
      /** Most items listed per media type. */
      maxItems: z.number().int().min(1).max(100).default(30),
    })
    .default({ enabled: false, notificationId: null, recipients: 'connection', weekday: 5, hour: 9, maxItems: 30 }),
});
export type WatchStatsSettings = z.infer<typeof WatchStatsSettings>;

// ---------------------------------------------------------------------------------------
// playback stats
// ---------------------------------------------------------------------------------------

export const PlaybackStatsQuery = z.object({
  /** Window in days ending now. */
  days: z.coerce.number().int().min(1).max(3650).default(30),
  /** Admins: one Arclight user's stats (non-admins always get their own). */
  userId: z.coerce.number().int().positive().optional(),
  serverId: z.string().max(64).optional(),
});
export type PlaybackStatsQuery = z.input<typeof PlaybackStatsQuery>;

export const PlaybackTitle = z.object({
  /** `movie:<id>`, `series:<id>` or the raw item key when not in the library. */
  key: z.string(),
  mediaType: z.enum(['movie', 'series', 'other']),
  title: z.string(),
  year: z.number().int().nullable(),
  movieId: z.number().int().nullable(),
  seriesId: z.number().int().nullable(),
  tmdbId: z.number().int().nullable(),
  plays: z.number().int(),
  watchMs: z.number().int(),
  /** Distinct viewers. */
  users: z.number().int(),
  lastPlayedAt: z.string().nullable(),
});
export type PlaybackTitle = z.infer<typeof PlaybackTitle>;

export const PlaybackBucket = z.object({ name: z.string(), plays: z.number().int(), watchMs: z.number().int() });
export type PlaybackBucket = z.infer<typeof PlaybackBucket>;

export const PlaybackUser = z.object({
  /** `user:<arclight id>` for linked accounts, `account:<id>` otherwise. */
  key: z.string(),
  arclightUserId: z.number().int().nullable(),
  name: z.string(),
  plays: z.number().int(),
  watchMs: z.number().int(),
  lastPlayedAt: z.string().nullable(),
});
export type PlaybackUser = z.infer<typeof PlaybackUser>;

export const PlaybackDay = z.object({ date: z.string(), plays: z.number().int(), watchMs: z.number().int() });
export type PlaybackDay = z.infer<typeof PlaybackDay>;

export const PlayMethodCounts = z.object({
  directPlay: z.number().int(),
  directStream: z.number().int(),
  transcode: z.number().int(),
  /** Plays known only from the sync (no session details). */
  unknown: z.number().int(),
});
export type PlayMethodCounts = z.infer<typeof PlayMethodCounts>;

/** GET /watchstats (and the plugin's /jellyfin/stats/me and /jellyfin/stats/server). */
export const PlaybackStats = z.object({
  from: z.string(),
  to: z.string(),
  /** null: server-wide; else whose stats these are. */
  userId: z.number().int().nullable(),
  totals: z.object({
    plays: z.number().int(),
    watchMs: z.number().int(),
    titles: z.number().int(),
    users: z.number().int(),
    movies: z.number().int(),
    episodes: z.number().int(),
  }),
  playMethods: PlayMethodCounts,
  topMovies: z.array(PlaybackTitle),
  topSeries: z.array(PlaybackTitle),
  topGenres: z.array(PlaybackBucket),
  clients: z.array(PlaybackBucket),
  devices: z.array(PlaybackBucket),
  /** Most active users (empty when names are hidden from the caller). */
  users: z.array(PlaybackUser),
  perDay: z.array(PlaybackDay),
  /** Plays by weekday (0 = Sunday) and hour, server local time: 7 rows of 24. */
  heatmap: z.array(z.array(z.number().int())),
});
export type PlaybackStats = z.infer<typeof PlaybackStats>;

export const LibraryGrowthQuery = z.object({ days: z.coerce.number().int().min(7).max(3650).default(365) });
export type LibraryGrowthQuery = z.input<typeof LibraryGrowthQuery>;

/** GET /watchstats/growth: daily storage snapshots and titles added per month. */
export const LibraryGrowth = z.object({
  snapshots: z.array(z.object({ date: z.string(), usedBytes: z.number(), fileCount: z.number().int() })),
  added: z.array(z.object({ month: z.string(), movies: z.number().int(), series: z.number().int(), episodes: z.number().int() })),
});
export type LibraryGrowth = z.infer<typeof LibraryGrowth>;

// ---------------------------------------------------------------------------------------
// Wrapped (year in review)
// ---------------------------------------------------------------------------------------

export const WrappedQuery = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  userId: z.coerce.number().int().positive().optional(),
});
export type WrappedQuery = z.input<typeof WrappedQuery>;

export const Wrapped = z.object({
  year: z.number().int(),
  userId: z.number().int(),
  /** Display name (or username). */
  name: z.string(),
  plays: z.number().int(),
  watchMs: z.number().int(),
  movies: z.number().int(),
  episodes: z.number().int(),
  /** Distinct series with at least one episode watched. */
  series: z.number().int(),
  /** Days with at least one play. */
  activeDays: z.number().int(),
  topMovies: z.array(PlaybackTitle),
  topSeries: z.array(PlaybackTitle),
  topGenres: z.array(PlaybackBucket),
  topDevice: z.string().nullable(),
  /** Month (1-12) with the most watch time. */
  busiestMonth: z.number().int().nullable(),
  /** Weekday (0 = Sunday) with the most plays. */
  favouriteWeekday: z.number().int().nullable(),
  /** Hour (0-23) with the most plays. */
  favouriteHour: z.number().int().nullable(),
  /** Day with the most watch time. */
  longestDay: z.object({ date: z.string(), watchMs: z.number().int() }).nullable(),
  firstPlay: z.object({ title: z.string(), at: z.string() }).nullable(),
  /** Watch time per month, January first (12 entries). */
  monthly: z.array(z.number().int()),
  /** Share of users with less watch time (0-100); null when the user is the only viewer. */
  percentile: z.number().int().nullable(),
  /** Years with any history for this user (newest first), for a year picker. */
  years: z.array(z.number().int()),
});
export type Wrapped = z.infer<typeof Wrapped>;

export const WrappedShareCreate = z.object({
  year: z.number().int().min(2000).max(2100),
  /** Admins may share another user's Wrapped. */
  userId: z.number().int().positive().optional(),
});
export type WrappedShareCreate = z.infer<typeof WrappedShareCreate>;

export const WrappedShare = z.object({
  id: z.number().int(),
  userId: z.number().int(),
  year: z.number().int(),
  /** The page path (relative to the Arclight origin), e.g. /api/v1/share/wrapped/<token>. */
  path: z.string(),
  /** Absolute link when Settings > Requests > Application URL is set, else null. */
  url: z.string().nullable(),
  imagePath: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type WrappedShare = z.infer<typeof WrappedShare>;

// ---------------------------------------------------------------------------------------
// newsletter
// ---------------------------------------------------------------------------------------

export const NewsletterItem = z.object({
  mediaType: z.enum(['movie', 'series', 'episode']),
  title: z.string(),
  year: z.number().int().nullable(),
  /** Episodes: `S01E02` etc. grouped per series ("3 new episodes"). */
  detail: z.string().nullable(),
  addedAt: z.string(),
  posterUrl: z.string().nullable(),
  overview: z.string(),
});
export type NewsletterItem = z.infer<typeof NewsletterItem>;

export const NewsletterPreview = z.object({
  subject: z.string(),
  from: z.string(),
  to: z.string(),
  items: z.array(NewsletterItem),
  html: z.string(),
  text: z.string(),
  /** Recipient addresses for the current settings (empty: nothing would be sent). */
  recipients: z.number().int(),
  problem: z.string().nullable(),
});
export type NewsletterPreview = z.infer<typeof NewsletterPreview>;

export const NewsletterRun = z.object({
  id: z.number().int(),
  sentAt: z.string(),
  trigger: z.enum(['scheduled', 'manual']),
  recipients: z.number().int(),
  items: z.number().int(),
  error: z.string().nullable(),
});
export type NewsletterRun = z.infer<typeof NewsletterRun>;

/** What the Jellyfin plugin shows the calling user (GET /jellyfin/stats/access). */
export const JellyfinStatsAccess = z.object({
  myStats: z.boolean(),
  wrapped: z.boolean(),
  serverStats: z.boolean(),
  shareLinks: z.boolean(),
  leavingSoon: z.boolean(),
  isAdmin: z.boolean(),
});
export type JellyfinStatsAccess = z.infer<typeof JellyfinStatsAccess>;

import { z } from 'zod';

// Watch history (Settings > Media servers; Profile > Watch history; "Watched by" on titles):
// play state and a timeline of plays copied from Jellyfin/Emby. Jellyfin is the source of truth;
// Arclight only reads. Two feeds fill it: the MediaServerWatchSync job (a catch-up read of every
// user's play state) and the Jellyfin plugin's events (POST /jellyfin/events). Server accounts
// are kept in their own list (media_server_users) so history of accounts without an Arclight
// user is not lost and attaches once the account is linked or imported. Routes under
// /api/v1/watchhistory, /api/v1/mediaserver/:id/sync and /api/v1/mediaserver/:id/accounts.

/** Settings section `watchHistory` (GET/PUT /settings/watchhistory). */
export const WatchHistorySettings = z.object({
  /** MediaServerWatchSync: minutes between catch-up reads. */
  syncIntervalMinutes: z.number().int().min(5).max(1440).default(10),
  /**
   * Hours between full reads per user. In between, reads only fetch recently played items, which
   * misses "mark unplayed" and favourite changes (the plugin's events carry those at once).
   */
  fullSyncHours: z.number().int().min(1).max(168).default(24),
  /** Days the play timeline (watch_events) is kept; play state itself is never pruned. */
  eventRetentionDays: z.number().int().min(7).max(3650).default(400),
});
export type WatchHistorySettings = z.infer<typeof WatchHistorySettings>;

export const WatchEventType = z.enum(['start', 'progress', 'stop', 'played', 'unplayed']);
export type WatchEventType = z.infer<typeof WatchEventType>;

/** `sync`: synthesized by the catch-up job when Played flipped; `plugin`: sent by the Jellyfin plugin. */
export const WatchEventSource = z.enum(['sync', 'plugin']);
export type WatchEventSource = z.infer<typeof WatchEventSource>;

export const WatchPlayMethod = z.enum(['DirectPlay', 'DirectStream', 'Transcode']);
export type WatchPlayMethod = z.infer<typeof WatchPlayMethod>;

/** What a watch row or event is about. `other`: anything the library does not hold (music, books, unmatched). */
export const WatchItemType = z.enum(['movie', 'episode', 'series', 'season', 'other']);
export type WatchItemType = z.infer<typeof WatchItemType>;

/** A media server account as the history knows it, with its Arclight user when linked. */
export const WatchUserRef = z.object({
  mediaServerUserId: z.number().int(),
  name: z.string(),
  arclightUserId: z.number().int().nullable(),
  arclightUsername: z.string().nullable(),
});
export type WatchUserRef = z.infer<typeof WatchUserRef>;

export const WatchEvent = z.object({
  id: z.number().int(),
  serverId: z.string(),
  serverName: z.string(),
  user: WatchUserRef.nullable(),
  type: WatchEventType,
  at: z.string(),
  itemType: WatchItemType,
  title: z.string(),
  seriesTitle: z.string().nullable(),
  seasonNumber: z.number().int().nullable(),
  episodeNumber: z.number().int().nullable(),
  movieId: z.number().int().nullable(),
  seriesId: z.number().int().nullable(),
  episodeId: z.number().int().nullable(),
  positionMs: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  client: z.string().nullable(),
  device: z.string().nullable(),
  playMethod: WatchPlayMethod.nullable(),
  sessionId: z.string().nullable(),
  source: WatchEventSource,
});
export type WatchEvent = z.infer<typeof WatchEvent>;

/**
 * GET /watchhistory. Admins see everyone (filter with userId / mediaServerUserId); other users
 * always get their own history. Progress events are left out unless asked for.
 */
export const WatchHistoryQuery = z.object({
  userId: z.coerce.number().int().positive().optional(),
  mediaServerUserId: z.coerce.number().int().positive().optional(),
  serverId: z.string().optional(),
  movieId: z.coerce.number().int().positive().optional(),
  seriesId: z.coerce.number().int().positive().optional(),
  type: WatchEventType.optional(),
  includeProgress: z.union([z.boolean(), z.stringbool()]).default(false),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type WatchHistoryQuery = z.input<typeof WatchHistoryQuery>;

export const WatchEventPage = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  totalRecords: z.number().int(),
  records: z.array(WatchEvent),
});
export type WatchEventPage = z.infer<typeof WatchEventPage>;

/** GET /watchhistory/title/:mediaType/:id (admins): who watched a library movie or series. */
export const WatchedByEntry = z.object({
  user: WatchUserRef,
  serverId: z.string(),
  serverName: z.string(),
  played: z.boolean(),
  playCount: z.number().int(),
  lastPlayedAt: z.string().nullable(),
  positionMs: z.number().int(),
  durationMs: z.number().int().nullable(),
  favorite: z.boolean(),
  /** Series: episodes present on the server / played by this user. */
  episodes: z.object({ total: z.number().int(), played: z.number().int() }).nullable(),
});
export type WatchedByEntry = z.infer<typeof WatchedByEntry>;

export const WatchTitleParams = z.object({ mediaType: z.enum(['movie', 'series']), id: z.coerce.number().int().positive() });
export type WatchTitleParams = z.infer<typeof WatchTitleParams>;

/** GET /watchhistory/nowplaying (admins): sessions with a start/progress event and no stop in the last few minutes. */
export const NowPlayingEntry = z.object({
  sessionId: z.string(),
  serverId: z.string(),
  serverName: z.string(),
  user: WatchUserRef.nullable(),
  itemType: WatchItemType,
  title: z.string(),
  seriesTitle: z.string().nullable(),
  seasonNumber: z.number().int().nullable(),
  episodeNumber: z.number().int().nullable(),
  movieId: z.number().int().nullable(),
  seriesId: z.number().int().nullable(),
  positionMs: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  client: z.string().nullable(),
  device: z.string().nullable(),
  playMethod: WatchPlayMethod.nullable(),
  startedAt: z.string(),
  updatedAt: z.string(),
});
export type NowPlayingEntry = z.infer<typeof NowPlayingEntry>;

export const SyncRunStatus = z.enum(['ok', 'failed', 'running']);
export type SyncRunStatus = z.infer<typeof SyncRunStatus>;

/** GET /mediaserver/:id/sync: watch-history and user sync state of one server. */
export const MediaServerSyncStatus = z.object({
  serverId: z.string(),
  /** Effective syncWatchHistory (Jellyfin/Emby and enabled). */
  watchSyncEnabled: z.boolean(),
  lastSyncAt: z.string().nullable(),
  lastFullSyncAt: z.string().nullable(),
  lastStatus: SyncRunStatus.nullable(),
  lastError: z.string().nullable(),
  /** Stored play-state rows for this server. */
  itemsTracked: z.number().int(),
  lastUserSyncAt: z.string().nullable(),
  lastUserSyncStatus: SyncRunStatus.nullable(),
  lastUserSyncError: z.string().nullable(),
  /** Last event the Jellyfin plugin sent for this server. */
  lastEventAt: z.string().nullable(),
  users: z.number().int(),
  linkedUsers: z.number().int(),
});
export type MediaServerSyncStatus = z.infer<typeof MediaServerSyncStatus>;

/** GET /mediaserver/:id/accounts: the server's accounts as last synced. */
export const MediaServerAccountRow = z.object({
  id: z.number().int(),
  serverId: z.string(),
  externalId: z.string(),
  name: z.string(),
  isAdmin: z.boolean(),
  disabled: z.boolean(),
  /** Gone from the server; history is kept. */
  deleted: z.boolean(),
  lastActivityAt: z.string().nullable(),
  firstSeenAt: z.string(),
  arclightUserId: z.number().int().nullable(),
  arclightUsername: z.string().nullable(),
  lastWatchSyncAt: z.string().nullable(),
});
export type MediaServerAccountRow = z.infer<typeof MediaServerAccountRow>;

export const WatchSyncServerResult = z.object({
  serverId: z.string(),
  name: z.string(),
  status: z.enum(['ok', 'failed', 'skipped']),
  users: z.number().int(),
  /** Play-state rows inserted or changed. */
  changed: z.number().int(),
  /** played/unplayed events synthesized. */
  events: z.number().int(),
  message: z.string().optional(),
});
export type WatchSyncServerResult = z.infer<typeof WatchSyncServerResult>;

export const WatchSyncResult = z.object({ servers: z.array(WatchSyncServerResult) });
export type WatchSyncResult = z.infer<typeof WatchSyncResult>;

export const UserSyncServerResult = z.object({
  serverId: z.string(),
  name: z.string(),
  status: z.enum(['ok', 'failed', 'skipped']),
  added: z.number().int(),
  renamed: z.number().int(),
  disabled: z.number().int(),
  deleted: z.number().int(),
  /** Arclight users created for new accounts (createUsersOnLogin + automatic sign-in policy). */
  created: z.number().int(),
  /** Linked users whose content restrictions were updated from Jellyfin parental controls (mirrorParentalControls). */
  mirrored: z.number().int().optional(),
  message: z.string().optional(),
});
export type UserSyncServerResult = z.infer<typeof UserSyncServerResult>;

export const UserSyncResult = z.object({ servers: z.array(UserSyncServerResult) });
export type UserSyncResult = z.infer<typeof UserSyncResult>;

export const WatchHistoryErrorResponse = z.object({ error: z.string(), code: z.string().optional() });
export type WatchHistoryErrorResponse = z.infer<typeof WatchHistoryErrorResponse>;

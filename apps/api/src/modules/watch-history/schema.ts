import { sqliteTable, integer, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { SyncRunStatus, WatchEventSource, WatchEventType, WatchItemType, WatchPlayMethod } from '@arclight/shared';

// Watch-history tables. Rows point at library movies/series/episodes by id without foreign keys
// (modules do not reference each other's tables) and keep the provider ids and titles they were
// matched with, so a row of an item that is not (or no longer) in the library still reads.
// Media servers live in the `mediaServers` settings section, so `server_id` is a plain text id.

/**
 * Every account seen on a Jellyfin/Emby/Plex server. History hangs off these rows, not off Arclight
 * users: an account without an Arclight user keeps its history, which shows up under the user
 * once the account is linked or imported (the link lives in users.settings.mediaServerLink and is
 * matched by server kind + account id, never by name). Accounts are never deleted, only marked.
 */
export const mediaServerUsers = sqliteTable(
  'media_server_users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    serverId: text('server_id').notNull(),
    /** Jellyfin/Emby user id, lower-case without dashes; Plex: the plex.tv account id. */
    externalId: text('external_id').notNull(),
    /**
     * Plex: the id the server itself uses for the account in history, sessions and webhooks
     * (the plex.tv id for everyone but the owner, who is 1). Null for Jellyfin/Emby.
     */
    localId: text('local_id'),
    name: text('name').notNull(),
    isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
    disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
    /** No longer listed by the server. */
    deleted: integer('deleted', { mode: 'boolean' }).notNull().default(false),
    lastActivityAt: text('last_activity_at'),
    firstSeenAt: text('first_seen_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    /** Last catch-up read of this account's play state (incremental or full). */
    lastWatchSyncAt: text('last_watch_sync_at'),
    lastFullSyncAt: text('last_full_sync_at'),
  },
  (t) => [uniqueIndex('media_server_users_server_external_idx').on(t.serverId, t.externalId)],
);

/**
 * Current play state per account and item. Movies get a row for every movie the account can see
 * (so "watched by all" knows who could have watched), episodes only once there is something to
 * remember (played, a play count, a resume point or a favourite), and series and seasons get
 * roll-up rows (`episodes_total` / `episodes_played`; played = every present episode played).
 */
export const watchState = sqliteTable(
  'watch_state',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    serverId: text('server_id').notNull(),
    mediaServerUserId: integer('media_server_user_id')
      .notNull()
      .references(() => mediaServerUsers.id, { onDelete: 'cascade' }),
    /** The Jellyfin item (movie, episode, series or season id). */
    jellyfinItemId: text('jellyfin_item_id').notNull(),
    itemType: text('item_type').$type<WatchItemType>().notNull(),
    /** `movie:<id>`, `episode:<id>`, `series:<id>`, `season:<seriesId>:<n>`, or `jf:<jellyfin id>` when not in the library. */
    itemKey: text('item_key').notNull(),
    movieId: integer('movie_id'),
    seriesId: integer('series_id'),
    episodeId: integer('episode_id'),
    seasonNumber: integer('season_number'),
    episodeNumber: integer('episode_number'),
    tmdbId: integer('tmdb_id'),
    tvdbId: integer('tvdb_id'),
    imdbId: text('imdb_id'),
    /** Episodes and seasons: their series' Jellyfin id (roll-ups group by it). */
    jellyfinSeriesId: text('jellyfin_series_id'),
    /** Episodes: their season's Jellyfin id. */
    jellyfinSeasonId: text('jellyfin_season_id'),
    title: text('title').notNull(),
    played: integer('played', { mode: 'boolean' }).notNull().default(false),
    playCount: integer('play_count').notNull().default(0),
    lastPlayedAt: text('last_played_at'),
    positionMs: integer('position_ms').notNull().default(0),
    durationMs: integer('duration_ms'),
    favorite: integer('favorite', { mode: 'boolean' }).notNull().default(false),
    /** Roll-ups: episodes present on the server (null: not known yet) and played. */
    episodesTotal: integer('episodes_total'),
    episodesPlayed: integer('episodes_played'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('watch_state_user_item_idx').on(t.mediaServerUserId, t.jellyfinItemId),
    index('watch_state_item_key_idx').on(t.itemKey),
    index('watch_state_movie_idx').on(t.movieId),
    index('watch_state_series_idx').on(t.seriesId),
    index('watch_state_server_idx').on(t.serverId),
    index('watch_state_jf_series_idx').on(t.mediaServerUserId, t.jellyfinSeriesId),
  ],
);

/**
 * Append-only play timeline: start/progress/stop from the Jellyfin plugin, played/unplayed from
 * either feed. Pruned after `watchHistory.eventRetentionDays` by WatchHistoryCleanup.
 * `dedupe_key` makes re-sent plugin batches and repeated sync passes idempotent.
 */
export const watchEvents = sqliteTable(
  'watch_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    serverId: text('server_id').notNull(),
    mediaServerUserId: integer('media_server_user_id').references(() => mediaServerUsers.id, { onDelete: 'set null' }),
    type: text('type').$type<WatchEventType>().notNull(),
    at: text('at').notNull(),
    itemType: text('item_type').$type<WatchItemType>().notNull(),
    itemKey: text('item_key').notNull(),
    jellyfinItemId: text('jellyfin_item_id'),
    title: text('title').notNull(),
    seriesTitle: text('series_title'),
    seasonNumber: integer('season_number'),
    episodeNumber: integer('episode_number'),
    movieId: integer('movie_id'),
    seriesId: integer('series_id'),
    episodeId: integer('episode_id'),
    tmdbId: integer('tmdb_id'),
    positionMs: integer('position_ms'),
    durationMs: integer('duration_ms'),
    client: text('client'),
    device: text('device'),
    playMethod: text('play_method').$type<WatchPlayMethod>(),
    sessionId: text('session_id'),
    source: text('source').$type<WatchEventSource>().notNull(),
    dedupeKey: text('dedupe_key').notNull(),
  },
  (t) => [
    uniqueIndex('watch_events_dedupe_idx').on(t.dedupeKey),
    index('watch_events_at_idx').on(t.at),
    index('watch_events_user_at_idx').on(t.mediaServerUserId, t.at),
    index('watch_events_session_idx').on(t.sessionId),
    index('watch_events_movie_idx').on(t.movieId),
    index('watch_events_series_idx').on(t.seriesId),
  ],
);

/** Per-server sync bookkeeping (watch-history catch-up, user sync, plugin events). */
export const mediaServerSyncState = sqliteTable('media_server_sync_state', {
  serverId: text('server_id').primaryKey(),
  lastSyncAt: text('last_sync_at'),
  /** Set once every account of the server had a full read; retention trusts stored state from then on. */
  lastFullSyncAt: text('last_full_sync_at'),
  lastStatus: text('last_status').$type<SyncRunStatus>(),
  lastError: text('last_error'),
  lastUserSyncAt: text('last_user_sync_at'),
  lastUserSyncStatus: text('last_user_sync_status').$type<SyncRunStatus>(),
  lastUserSyncError: text('last_user_sync_error'),
  lastEventAt: text('last_event_at'),
});

export type MediaServerUserRow = typeof mediaServerUsers.$inferSelect;
export type WatchStateRow = typeof watchState.$inferSelect;
export type WatchEventRow = typeof watchEvents.$inferSelect;
export type MediaServerSyncStateRow = typeof mediaServerSyncState.$inferSelect;

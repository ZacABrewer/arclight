import { sqliteTable, integer, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { ItemPrefs, PlayQueue } from '@arclight/shared';
import { users } from '../auth/schema.js';

// The player's own tables, keyed on the Arclight user. Items are referenced by item key
// (`track:<id>`, `audiobook:<id>`) without foreign keys, like the watch history: a row of an item
// that left the library still reads, and browse simply skips it.

/**
 * Where a user is in an item, and what they think of it. `updated_at` is the device time of the
 * newest accepted report (never later than the server's clock), so an offline queue that sends
 * late cannot overwrite a newer position.
 */
export const playbackProgress = sqliteTable(
  'playback_progress',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    itemKey: text('item_key').notNull(),
    positionMs: integer('position_ms').notNull().default(0),
    durationMs: integer('duration_ms').notNull().default(0),
    played: integer('played', { mode: 'boolean' }).notNull().default(false),
    playCount: integer('play_count').notNull().default(0),
    lastPlayedAt: text('last_played_at'),
    updatedAt: text('updated_at').notNull(),
    favorite: integer('favorite', { mode: 'boolean' }).notNull().default(false),
    prefs: text('prefs', { mode: 'json' }).$type<ItemPrefs>().notNull().default({}),
    /** The device that sent the newest report. */
    deviceId: text('device_id'),
  },
  (t) => [
    uniqueIndex('playback_progress_user_item_idx').on(t.userId, t.itemKey),
    index('playback_progress_user_played_at_idx').on(t.userId, t.lastPlayedAt),
  ],
);

/**
 * Completed plays inside Arclight (one row per play-through). `watch_events` is keyed on a media
 * server account and server id (both required by its readers), so native plays get their own table.
 */
export const playbackPlays = sqliteTable(
  'playback_plays',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    itemKey: text('item_key').notNull(),
    at: text('at').notNull(),
    durationMs: integer('duration_ms').notNull().default(0),
    deviceId: text('device_id'),
    deviceName: text('device_name'),
    playMethod: text('play_method').$type<'DirectPlay' | 'Transcode'>(),
  },
  (t) => [index('playback_plays_user_at_idx').on(t.userId, t.at), index('playback_plays_item_idx').on(t.itemKey)],
);

/** One play queue per user; the whole queue is one JSON value (last write wins). */
export const playbackQueue = sqliteTable('playback_queue', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  queue: text('queue', { mode: 'json' }).$type<Omit<PlayQueue, 'updatedAt' | 'deviceId'>>().notNull(),
  deviceId: text('device_id'),
  updatedAt: text('updated_at').notNull(),
});

export const playbackBookmarks = sqliteTable(
  'playback_bookmarks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    itemKey: text('item_key').notNull(),
    positionMs: integer('position_ms').notNull(),
    note: text('note').notNull().default(''),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('playback_bookmarks_user_item_idx').on(t.userId, t.itemKey)],
);

/** The player's own playlists (not the music module's synced `music_playlists`). */
export const userPlaylists = sqliteTable(
  'user_playlists',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('user_playlists_user_idx').on(t.userId)],
);

/** Tracks of a user playlist in order; the same track may appear more than once. */
export const userPlaylistTracks = sqliteTable(
  'user_playlist_tracks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    playlistId: integer('playlist_id')
      .notNull()
      .references(() => userPlaylists.id, { onDelete: 'cascade' }),
    /** tracks.id (no FK: a track that leaves the library drops out of the listing). */
    trackId: integer('track_id').notNull(),
    position: integer('position').notNull(),
  },
  (t) => [uniqueIndex('user_playlist_tracks_position_idx').on(t.playlistId, t.position), index('user_playlist_tracks_track_idx').on(t.trackId)],
);

export type PlaybackProgressRow = typeof playbackProgress.$inferSelect;
export type PlaybackBookmarkRow = typeof playbackBookmarks.$inferSelect;
export type UserPlaylistRow = typeof userPlaylists.$inferSelect;

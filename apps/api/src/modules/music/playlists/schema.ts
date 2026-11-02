import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core';
import type { PlaylistEntryStatus, PlaylistMatchMethod, PlaylistSource, PlaylistSyncStatus, PlaylistTarget, PlaylistWant } from '@arclight/shared';

// Music playlists (docs/using/music-playlists.md): one row per followed source, and the
// source's tracks as of the last sync with what each matched in the library.

/** What a push target last created, so the next sync updates it instead of adding another. */
export interface PlaylistTargetState {
  target: PlaylistTarget;
  remoteId?: string;
  lastPushAt?: string;
  error?: string;
}

export const musicPlaylists = sqliteTable('music_playlists', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  source: text('source', { mode: 'json' }).$type<PlaylistSource>().notNull(),
  want: text('want').$type<PlaylistWant>().notNull().default('none'),
  addArtists: integer('add_artists', { mode: 'boolean' }).notNull().default(false),
  rootFolderPath: text('root_folder_path'),
  qualityProfileId: integer('quality_profile_id'),
  searchOnWant: integer('search_on_want', { mode: 'boolean' }).notNull().default(false),
  writeM3u: integer('write_m3u', { mode: 'boolean' }).notNull().default(true),
  targets: text('targets', { mode: 'json' }).$type<PlaylistTarget[]>().notNull(),
  targetState: text('target_state', { mode: 'json' }).$type<PlaylistTargetState[]>().notNull(),
  /** Albums this playlist monitored in `tracks` mode: their track monitoring follows the playlist. */
  ownedAlbumIds: text('owned_album_ids', { mode: 'json' }).$type<number[]>().notNull(),
  syncIntervalHours: integer('sync_interval_hours').notNull().default(24),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  sourceTitle: text('source_title'),
  lastSyncAt: text('last_sync_at'),
  lastSyncStatus: text('last_sync_status').$type<PlaylistSyncStatus>().notNull().default('never'),
  lastSyncMessage: text('last_sync_message'),
  createdAt: text('created_at').notNull(),
});

export const musicPlaylistEntries = sqliteTable(
  'music_playlist_entries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    playlistId: integer('playlist_id')
      .notNull()
      .references(() => musicPlaylists.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    title: text('title').notNull(),
    artist: text('artist').notNull(),
    album: text('album'),
    durationMs: integer('duration_ms'),
    isrc: text('isrc'),
    status: text('status').$type<PlaylistEntryStatus>().notNull(),
    matchMethod: text('match_method').$type<PlaylistMatchMethod>(),
    recordingMbid: text('recording_mbid'),
    releaseGroupMbid: text('release_group_mbid'),
    artistMbid: text('artist_mbid'),
    /** Library ids, no foreign keys: entries are rebuilt on every sync. */
    artistId: integer('artist_id'),
    albumId: integer('album_id'),
    trackId: integer('track_id'),
  },
  (t) => [index('music_playlist_entries_playlist_idx').on(t.playlistId, t.position)],
);

export type MusicPlaylistRow = typeof musicPlaylists.$inferSelect;
export type MusicPlaylistEntryRow = typeof musicPlaylistEntries.$inferSelect;

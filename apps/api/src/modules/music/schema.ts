import { sqliteTable, integer, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type {
  AlbumPrimaryType,
  AlbumReleaseStatus,
  AlbumSecondaryType,
  ArtistLink,
  ArtistType,
  MusicImage,
  Ratings,
  ReleaseLabel,
  ReleaseMedium,
} from '@arclight/shared';

// Music tables (docs/design/music-audiobooks.md section 4.3): artists → albums (MusicBrainz
// release groups) → album releases (editions) → tracks of the selected release. Files live in
// the shared `audio_files` table (library/schema.ts); `tracks.audio_file_id` links them.

export const albumTypeProfiles = sqliteTable(
  'album_type_profiles',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    primaryTypes: text('primary_types', { mode: 'json' }).$type<AlbumPrimaryType[]>().notNull(),
    secondaryTypes: text('secondary_types', { mode: 'json' }).$type<AlbumSecondaryType[]>().notNull(),
    releaseStatuses: text('release_statuses', { mode: 'json' }).$type<AlbumReleaseStatus[]>().notNull(),
    /** The profile new artists get when the add request names none. */
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [uniqueIndex('album_type_profiles_name_idx').on(t.name)],
);

export const artists = sqliteTable(
  'artists',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    mbArtistId: text('mb_artist_id').notNull(),
    name: text('name').notNull(),
    sortName: text('sort_name').notNull(),
    cleanName: text('clean_name').notNull(),
    disambiguation: text('disambiguation'),
    artistType: text('artist_type').$type<ArtistType>(),
    status: text('status', { enum: ['continuing', 'ended'] }).notNull().default('continuing'),
    overview: text('overview').notNull().default(''),
    genres: text('genres', { mode: 'json' }).$type<string[]>().notNull(),
    images: text('images', { mode: 'json' }).$type<MusicImage[]>().notNull(),
    links: text('links', { mode: 'json' }).$type<ArtistLink[]>().notNull(),
    aliases: text('aliases', { mode: 'json' }).$type<string[]>().notNull(),
    path: text('path').notNull(),
    rootFolderPath: text('root_folder_path').notNull(),
    /** A `music` domain quality profile (not a foreign key, like series/movies). */
    qualityProfileId: integer('quality_profile_id').notNull(),
    albumTypeProfileId: integer('album_type_profile_id')
      .notNull()
      .references(() => albumTypeProfiles.id),
    monitored: integer('monitored', { mode: 'boolean' }).notNull().default(true),
    monitorNewAlbums: text('monitor_new_albums', { enum: ['all', 'none', 'future'] }).notNull().default('all'),
    tags: text('tags', { mode: 'json' }).$type<number[]>().notNull(),
    added: text('added').notNull(),
    lastRefreshed: text('last_refreshed'),
    /** RefreshArtists orders by this (+1 d recent/upcoming release, +7 d continuing, +30 d ended). */
    nextRefreshAt: text('next_refresh_at'),
  },
  (t) => [
    uniqueIndex('artists_mb_artist_id_idx').on(t.mbArtistId),
    uniqueIndex('artists_path_idx').on(t.path),
    index('artists_clean_name_idx').on(t.cleanName),
    index('artists_next_refresh_idx').on(t.nextRefreshAt),
  ],
);

export const albums = sqliteTable(
  'albums',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    artistId: integer('artist_id')
      .notNull()
      .references(() => artists.id, { onDelete: 'cascade' }),
    mbReleaseGroupId: text('mb_release_group_id').notNull(),
    title: text('title').notNull(),
    cleanTitle: text('clean_title').notNull(),
    disambiguation: text('disambiguation'),
    primaryType: text('primary_type').$type<AlbumPrimaryType>().notNull(),
    secondaryTypes: text('secondary_types', { mode: 'json' }).$type<AlbumSecondaryType[]>().notNull(),
    /** First release date of the group: `YYYY-MM-DD`, `YYYY-MM` or `YYYY`. */
    releaseDate: text('release_date'),
    year: integer('year'),
    overview: text('overview').notNull().default(''),
    genres: text('genres', { mode: 'json' }).$type<string[]>().notNull(),
    images: text('images', { mode: 'json' }).$type<MusicImage[]>().notNull(),
    ratings: text('ratings', { mode: 'json' }).$type<Ratings>().notNull(),
    monitored: integer('monitored', { mode: 'boolean' }).notNull().default(true),
    anyReleaseOk: integer('any_release_ok', { mode: 'boolean' }).notNull().default(true),
    /** album_releases.id of the edition whose tracks are stored (no FK: the two tables point at each other). */
    selectedReleaseId: integer('selected_release_id'),
    added: text('added').notNull(),
    lastRefreshed: text('last_refreshed'),
  },
  (t) => [
    uniqueIndex('albums_mb_release_group_id_idx').on(t.mbReleaseGroupId),
    index('albums_artist_idx').on(t.artistId),
    index('albums_monitored_release_date_idx').on(t.monitored, t.releaseDate),
    index('albums_clean_title_idx').on(t.cleanTitle),
  ],
);

export const albumReleases = sqliteTable(
  'album_releases',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    albumId: integer('album_id')
      .notNull()
      .references(() => albums.id, { onDelete: 'cascade' }),
    mbReleaseId: text('mb_release_id').notNull(),
    title: text('title').notNull(),
    status: text('status').$type<AlbumReleaseStatus>(),
    country: text('country'),
    date: text('date'),
    labels: text('labels', { mode: 'json' }).$type<ReleaseLabel[]>().notNull(),
    catalogNumber: text('catalog_number'),
    barcode: text('barcode'),
    formats: text('formats', { mode: 'json' }).$type<string[]>().notNull(),
    mediumCount: integer('medium_count').notNull().default(0),
    trackCount: integer('track_count').notNull().default(0),
    durationMs: integer('duration_ms'),
    media: text('media', { mode: 'json' }).$type<ReleaseMedium[]>().notNull(),
    disambiguation: text('disambiguation'),
  },
  (t) => [uniqueIndex('album_releases_mb_release_id_idx').on(t.mbReleaseId), index('album_releases_album_idx').on(t.albumId)],
);

export const tracks = sqliteTable(
  'tracks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    albumId: integer('album_id')
      .notNull()
      .references(() => albums.id, { onDelete: 'cascade' }),
    albumReleaseId: integer('album_release_id')
      .notNull()
      .references(() => albumReleases.id, { onDelete: 'cascade' }),
    mbTrackId: text('mb_track_id'),
    mbRecordingId: text('mb_recording_id'),
    mediumNumber: integer('medium_number').notNull().default(1),
    absoluteNumber: integer('absolute_number').notNull(),
    trackNumber: integer('track_number').notNull(),
    title: text('title').notNull(),
    durationMs: integer('duration_ms'),
    artistCredit: text('artist_credit'),
    hasFile: integer('has_file', { mode: 'boolean' }).notNull().default(false),
    /** audio_files.id (no FK: the file row may be replaced while the track stays). */
    audioFileId: integer('audio_file_id'),
  },
  (t) => [
    uniqueIndex('tracks_release_position_idx').on(t.albumReleaseId, t.mediumNumber, t.trackNumber),
    index('tracks_album_idx').on(t.albumId),
    index('tracks_mb_recording_id_idx').on(t.mbRecordingId),
    index('tracks_audio_file_idx').on(t.audioFileId),
  ],
);

export type ArtistRow = typeof artists.$inferSelect;
export type AlbumRow = typeof albums.$inferSelect;
export type AlbumReleaseRow = typeof albumReleases.$inferSelect;
export type TrackRow = typeof tracks.$inferSelect;
export type AlbumTypeProfileRow = typeof albumTypeProfiles.$inferSelect;

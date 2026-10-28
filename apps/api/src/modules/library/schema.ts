import { sqliteTable, integer, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type {
  AudioFileTags,
  AudioMediaInfo,
  MediaImage,
  MediaInfo,
  MediaVersion,
  Ratings,
  MovieCollection,
  QualityModel,
} from '@arclight/shared';
import { albums, artists } from '../music/schema.js';

// Library tables. One family of rows that every other module (releases, downloads, organizer,
// subtitles, requests, calendar) reads and attaches to. JSON columns hold the small, rarely
// filtered structures; anything we filter or join on is a real column with an index.

export const rootFolders = sqliteTable(
  'root_folders',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    path: text('path').notNull(),
    // Enum is TS-only on SQLite; music/audiobook roots need no migration of the column.
    mediaType: text('media_type', { enum: ['series', 'movie', 'music', 'audiobook'] }).notNull(),
  },
  (t) => [uniqueIndex('root_folders_path_idx').on(t.path)],
);

export const tags = sqliteTable(
  'tags',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    label: text('label').notNull(),
  },
  (t) => [uniqueIndex('tags_label_idx').on(t.label)],
);

export const series = sqliteTable(
  'series',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tmdbId: integer('tmdb_id').notNull(),
    tvdbId: integer('tvdb_id'),
    imdbId: text('imdb_id'),
    title: text('title').notNull(),
    sortTitle: text('sort_title').notNull(),
    cleanTitle: text('clean_title').notNull(),
    year: integer('year').notNull(),
    overview: text('overview').notNull().default(''),
    status: text('status', { enum: ['continuing', 'ended', 'upcoming', 'deleted'] }).notNull(),
    network: text('network'),
    runtimeMinutes: integer('runtime_minutes'),
    genres: text('genres', { mode: 'json' }).$type<string[]>().notNull(),
    images: text('images', { mode: 'json' }).$type<MediaImage[]>().notNull(),
    ratings: text('ratings', { mode: 'json' }).$type<Ratings>().notNull(),
    certification: text('certification'),
    originalLanguage: text('original_language').notNull(),
    path: text('path').notNull(),
    rootFolderPath: text('root_folder_path').notNull(),
    qualityProfileId: integer('quality_profile_id').notNull(),
    monitored: integer('monitored', { mode: 'boolean' }).notNull().default(true),
    monitorNewItems: text('monitor_new_items', { enum: ['all', 'none'] }).notNull().default('all'),
    seriesType: text('series_type', { enum: ['standard', 'daily', 'anime'] }).notNull().default('standard'),
    seasonFolder: integer('season_folder', { mode: 'boolean' }).notNull().default(true),
    useSceneNumbering: integer('use_scene_numbering', { mode: 'boolean' }).notNull().default(false),
    // Subtitle language profile (subtitles module); null = no subtitles wanted.
    languageProfileId: integer('language_profile_id'),
    tags: text('tags', { mode: 'json' }).$type<number[]>().notNull(),
    // Multi-version library: version slots [{tag, qualityProfileId, enabled}]; null = unversioned.
    versions: text('versions', { mode: 'json' }).$type<MediaVersion[]>(),
    added: text('added').notNull(),
    lastRefreshed: text('last_refreshed'),
  },
  (t) => [
    uniqueIndex('series_tmdb_id_idx').on(t.tmdbId),
    uniqueIndex('series_path_idx').on(t.path),
    index('series_tvdb_id_idx').on(t.tvdbId),
    index('series_clean_title_idx').on(t.cleanTitle),
    index('series_monitored_idx').on(t.monitored),
  ],
);

export const seasons = sqliteTable(
  'seasons',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    seriesId: integer('series_id')
      .notNull()
      .references(() => series.id, { onDelete: 'cascade' }),
    seasonNumber: integer('season_number').notNull(),
    monitored: integer('monitored', { mode: 'boolean' }).notNull().default(true),
  },
  (t) => [uniqueIndex('seasons_series_season_idx').on(t.seriesId, t.seasonNumber)],
);

export const episodes = sqliteTable(
  'episodes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    seriesId: integer('series_id')
      .notNull()
      .references(() => series.id, { onDelete: 'cascade' }),
    tmdbId: integer('tmdb_id'),
    seasonNumber: integer('season_number').notNull(),
    episodeNumber: integer('episode_number').notNull(),
    absoluteEpisodeNumber: integer('absolute_episode_number'),
    title: text('title').notNull().default('TBA'),
    overview: text('overview').notNull().default(''),
    airDate: text('air_date'),
    airDateUtc: text('air_date_utc'),
    runtimeMinutes: integer('runtime_minutes'),
    monitored: integer('monitored', { mode: 'boolean' }).notNull().default(true),
    hasFile: integer('has_file', { mode: 'boolean' }).notNull().default(false),
    // Several episodes may point at one media_files row (multi-episode files); the link lives
    // here rather than in a join table so "does this episode have a file" is one column read.
    episodeFileId: integer('episode_file_id'),
    unverifiedSceneNumbering: integer('unverified_scene_numbering', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [
    uniqueIndex('episodes_series_season_episode_idx').on(t.seriesId, t.seasonNumber, t.episodeNumber),
    index('episodes_tmdb_id_idx').on(t.tmdbId),
    index('episodes_monitored_has_file_idx').on(t.monitored, t.hasFile),
    index('episodes_air_date_utc_idx').on(t.airDateUtc),
    index('episodes_file_id_idx').on(t.episodeFileId),
  ],
);

export const movies = sqliteTable(
  'movies',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tmdbId: integer('tmdb_id').notNull(),
    imdbId: text('imdb_id'),
    title: text('title').notNull(),
    originalTitle: text('original_title').notNull(),
    sortTitle: text('sort_title').notNull(),
    cleanTitle: text('clean_title').notNull(),
    year: integer('year').notNull(),
    overview: text('overview').notNull().default(''),
    status: text('status', { enum: ['tba', 'announced', 'inCinemas', 'released', 'deleted'] }).notNull(),
    inCinemas: text('in_cinemas'),
    digitalRelease: text('digital_release'),
    physicalRelease: text('physical_release'),
    runtimeMinutes: integer('runtime_minutes'),
    studio: text('studio'),
    genres: text('genres', { mode: 'json' }).$type<string[]>().notNull(),
    images: text('images', { mode: 'json' }).$type<MediaImage[]>().notNull(),
    ratings: text('ratings', { mode: 'json' }).$type<Ratings>().notNull(),
    certification: text('certification'),
    originalLanguage: text('original_language').notNull(),
    collection: text('collection', { mode: 'json' }).$type<MovieCollection>(),
    path: text('path').notNull(),
    rootFolderPath: text('root_folder_path').notNull(),
    qualityProfileId: integer('quality_profile_id').notNull(),
    minimumAvailability: text('minimum_availability', { enum: ['announced', 'inCinemas', 'released'] })
      .notNull()
      .default('released'),
    monitored: integer('monitored', { mode: 'boolean' }).notNull().default(true),
    // Subtitle language profile (subtitles module); null = no subtitles wanted.
    languageProfileId: integer('language_profile_id'),
    tags: text('tags', { mode: 'json' }).$type<number[]>().notNull(),
    added: text('added').notNull(),
    lastRefreshed: text('last_refreshed'),
    hasFile: integer('has_file', { mode: 'boolean' }).notNull().default(false),
    movieFileId: integer('movie_file_id'),
    // Multi-version library: version slots [{tag, qualityProfileId, enabled}]; null = unversioned.
    versions: text('versions', { mode: 'json' }).$type<MediaVersion[]>(),
  },
  (t) => [
    uniqueIndex('movies_tmdb_id_idx').on(t.tmdbId),
    uniqueIndex('movies_path_idx').on(t.path),
    index('movies_imdb_id_idx').on(t.imdbId),
    index('movies_clean_title_idx').on(t.cleanTitle),
    index('movies_monitored_has_file_idx').on(t.monitored, t.hasFile),
  ],
);

export const mediaFiles = sqliteTable(
  'media_files',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    mediaType: text('media_type', { enum: ['series', 'movie'] }).notNull(),
    seriesId: integer('series_id').references(() => series.id, { onDelete: 'cascade' }),
    movieId: integer('movie_id').references(() => movies.id, { onDelete: 'cascade' }),
    seasonNumber: integer('season_number'),
    relativePath: text('relative_path').notNull(),
    path: text('path').notNull(),
    sizeBytes: integer('size_bytes').notNull().default(0),
    dateAdded: text('date_added').notNull(),
    quality: text('quality', { mode: 'json' }).$type<QualityModel>().notNull(),
    languages: text('languages', { mode: 'json' }).$type<string[]>().notNull(),
    releaseGroup: text('release_group'),
    sceneName: text('scene_name'),
    edition: text('edition'),
    mediaInfo: text('media_info', { mode: 'json' }).$type<MediaInfo>(),
    // Version slot the file fills ('4K', 'HDR', 'Remux', ...); null = unversioned (classic).
    versionTag: text('version_tag'),
  },
  (t) => [
    uniqueIndex('media_files_path_idx').on(t.path),
    index('media_files_series_season_idx').on(t.seriesId, t.seasonNumber),
    index('media_files_movie_idx').on(t.movieId),
    // One file per (movie, version). NULL tags never collide, so unversioned rows keep the
    // classic single-pointer behaviour (movies.movie_file_id).
    uniqueIndex('media_files_movie_version_idx').on(t.movieId, t.versionTag),
  ],
);

// Multi-version library, series side: which file fills which version slot of an episode. A
// multi-episode file has one row per episode. One file per (episode, version); unversioned
// files stay on episodes.episode_file_id only, which also points at the primary version.
export const episodeVersionFiles = sqliteTable(
  'episode_version_files',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    episodeId: integer('episode_id')
      .notNull()
      .references(() => episodes.id, { onDelete: 'cascade' }),
    versionTag: text('version_tag').notNull(),
    mediaFileId: integer('media_file_id')
      .notNull()
      .references(() => mediaFiles.id, { onDelete: 'cascade' }),
  },
  (t) => [
    uniqueIndex('episode_version_files_episode_version_idx').on(t.episodeId, t.versionTag),
    index('episode_version_files_file_idx').on(t.mediaFileId),
  ],
);

// Items the user deleted and asked never to be re-added by import lists / discovery.
export const importExclusions = sqliteTable(
  'import_exclusions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    mediaType: text('media_type', { enum: ['series', 'movie'] }).notNull(),
    tmdbId: integer('tmdb_id').notNull(),
    title: text('title').notNull(),
    year: integer('year'),
  },
  (t) => [uniqueIndex('import_exclusions_media_tmdb_idx').on(t.mediaType, t.tmdbId)],
);

// Audio files of both audio domains (docs/design/music-audiobooks.md section 4.1). Separate from
// `media_files` on purpose: video modules (hygiene, media analysis, retention, subtitles) query
// that table and would mishandle audio rows. Music rows set artist_id/album_id, audiobook rows
// author_id/book_id. The authors/books tables arrive in migration 0019, so those two columns
// carry no foreign key; the audiobooks module deletes its files itself.
export const audioFiles = sqliteTable(
  'audio_files',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    mediaType: text('media_type', { enum: ['music', 'audiobook'] }).notNull(),
    artistId: integer('artist_id').references(() => artists.id, { onDelete: 'cascade' }),
    albumId: integer('album_id').references(() => albums.id, { onDelete: 'cascade' }),
    authorId: integer('author_id'),
    bookId: integer('book_id'),
    path: text('path').notNull(),
    relativePath: text('relative_path').notNull(),
    sizeBytes: integer('size_bytes').notNull().default(0),
    dateAdded: text('date_added').notNull(),
    mtime: text('mtime'),
    quality: text('quality', { mode: 'json' }).$type<QualityModel>().notNull(),
    releaseGroup: text('release_group'),
    sceneName: text('scene_name'),
    codec: text('codec'),
    container: text('container'),
    bitrateKbps: integer('bitrate_kbps'),
    sampleRateHz: integer('sample_rate_hz'),
    bitDepth: integer('bit_depth'),
    channels: integer('channels'),
    durationMs: integer('duration_ms'),
    discNumber: integer('disc_number'),
    trackNumber: integer('track_number'),
    partNumber: integer('part_number'),
    chapterCount: integer('chapter_count'),
    tags: text('tags', { mode: 'json' }).$type<AudioFileTags>(),
    mediaInfo: text('media_info', { mode: 'json' }).$type<AudioMediaInfo>(),
  },
  (t) => [
    uniqueIndex('audio_files_path_idx').on(t.path),
    index('audio_files_album_idx').on(t.albumId),
    index('audio_files_book_idx').on(t.bookId),
    index('audio_files_artist_idx').on(t.artistId),
    index('audio_files_author_idx').on(t.authorId),
  ],
);

// Audio items the user deleted and asked never to be re-added (`import_exclusions.tmdb_id` is
// NOT NULL, so audio gets its own table). `foreign_id` is the MusicBrainz artist id for music and
// the ASIN (or OpenLibrary author id) for audiobooks.
export const audioImportExclusions = sqliteTable(
  'audio_import_exclusions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    mediaType: text('media_type', { enum: ['music', 'audiobook'] }).notNull(),
    foreignId: text('foreign_id').notNull(),
    title: text('title').notNull(),
    year: integer('year'),
  },
  (t) => [uniqueIndex('audio_import_exclusions_media_foreign_idx').on(t.mediaType, t.foreignId)],
);

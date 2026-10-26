import { sqliteTable, integer, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { LanguageProfileItem, SubtitleHistoryAction } from '@arclight/shared';

// Subtitles module tables (docs/spec/subtitles.md). No foreign keys to the library tables
// (same rule as history): rows of deleted media files are pruned on `library` bus events and
// by the weekly SubtitleScan job.

export const languageProfiles = sqliteTable('language_profiles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  languages: text('languages', { mode: 'json' }).$type<LanguageProfileItem[]>().notNull(),
  /** Language code of the cutoff item, '*' for any, null for none. */
  cutoff: text('cutoff'),
  mustContain: text('must_contain', { mode: 'json' }).$type<string[]>().notNull(),
  mustNotContain: text('must_not_contain', { mode: 'json' }).$type<string[]>().notNull(),
  originalFormat: integer('original_format', { mode: 'boolean' }).notNull().default(false),
});

/** Subtitles indexed for a media file: external files on disk and embedded tracks. */
export const subtitleFiles = sqliteTable(
  'subtitle_files',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    mediaFileId: integer('media_file_id').notNull(),
    language: text('language').notNull(),
    forced: integer('forced', { mode: 'boolean' }).notNull().default(false),
    hi: integer('hi', { mode: 'boolean' }).notNull().default(false),
    /** Null for embedded tracks. */
    path: text('path'),
    embedded: integer('embedded', { mode: 'boolean' }).notNull().default(false),
    streamIndex: integer('stream_index'),
    codec: text('codec'),
    provider: text('provider'),
    providerSubtitleId: text('provider_subtitle_id'),
    score: integer('score'),
    scoreOutOf: integer('score_out_of'),
    size: integer('size'),
    mtime: text('mtime'),
    added: text('added').notNull(),
  },
  (t) => [index('subtitle_files_media_file_idx').on(t.mediaFileId), index('subtitle_files_path_idx').on(t.path)],
);

export const subtitleHistory = sqliteTable(
  'subtitle_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    action: text('action').$type<SubtitleHistoryAction>().notNull(),
    description: text('description').notNull(),
    language: text('language').notNull(),
    forced: integer('forced', { mode: 'boolean' }).notNull().default(false),
    hi: integer('hi', { mode: 'boolean' }).notNull().default(false),
    provider: text('provider'),
    providerSubtitleId: text('provider_subtitle_id'),
    score: integer('score'),
    scoreOutOf: integer('score_out_of'),
    mediaType: text('media_type', { enum: ['series', 'movie'] }).notNull(),
    seriesId: integer('series_id'),
    movieId: integer('movie_id'),
    episodeIds: text('episode_ids', { mode: 'json' }).$type<number[]>().notNull(),
    /** Not a foreign key: history outlives replaced files. */
    mediaFileId: integer('media_file_id'),
    title: text('title').notNull(),
    subtitlePath: text('subtitle_path'),
    videoPath: text('video_path').notNull(),
    matched: text('matched', { mode: 'json' }).$type<string[]>().notNull(),
    notMatched: text('not_matched', { mode: 'json' }).$type<string[]>().notNull(),
    upgradedFromId: integer('upgraded_from_id'),
    date: text('date').notNull(),
  },
  (t) => [
    index('subtitle_history_date_idx').on(t.date),
    index('subtitle_history_media_file_idx').on(t.mediaFileId),
    index('subtitle_history_video_path_idx').on(t.videoPath),
  ],
);

export const subtitleBlacklist = sqliteTable(
  'subtitle_blacklist',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    provider: text('provider').notNull(),
    providerSubtitleId: text('provider_subtitle_id').notNull(),
    language: text('language').notNull(),
    forced: integer('forced', { mode: 'boolean' }).notNull().default(false),
    hi: integer('hi', { mode: 'boolean' }).notNull().default(false),
    mediaType: text('media_type', { enum: ['series', 'movie'] }).notNull(),
    seriesId: integer('series_id'),
    movieId: integer('movie_id'),
    mediaFileId: integer('media_file_id'),
    title: text('title').notNull(),
    date: text('date').notNull(),
  },
  (t) => [uniqueIndex('subtitle_blacklist_provider_id_idx').on(t.provider, t.providerSubtitleId)],
);

/** Adaptive-search state per media file and language string ("en", "en:forced", "en:hi"). */
export const subtitleWantedState = sqliteTable(
  'subtitle_wanted_state',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    mediaFileId: integer('media_file_id').notNull(),
    language: text('language').notNull(),
    firstAttempt: text('first_attempt').notNull(),
    lastAttempt: text('last_attempt').notNull(),
    attempts: integer('attempts').notNull().default(0),
  },
  (t) => [uniqueIndex('subtitle_wanted_state_file_lang_idx').on(t.mediaFileId, t.language)],
);

/** Persisted provider throttles (spec R13.2), restored into the ThrottleTracker at start. */
export const subtitleProviderState = sqliteTable('subtitle_provider_state', {
  provider: text('provider').primaryKey(),
  code: text('code').notNull(),
  description: text('description').notNull(),
  until: text('until').notNull(),
});

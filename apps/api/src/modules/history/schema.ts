import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core';
import type { QualityModel } from '@arclight/shared';

// The user-visible activity log: one row per item (episode or movie) per event. Append-only;
// rows go away only with their parent (series/movie) or through housekeeping.
//
// No foreign keys to the library tables: parent deletion is handled by an event subscriber
// plus the orphan sweep in the HistoryCleanup job, which keeps this table independent of the
// library schema file.

export const history = sqliteTable(
  'history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    eventType: text('event_type', {
      enum: ['unknown', 'grabbed', 'downloadFolderImported', 'downloadFailed', 'fileDeleted', 'fileRenamed', 'downloadIgnored', 'fileTranscoded'],
    }).notNull(),
    mediaType: text('media_type', { enum: ['series', 'movie'] }).notNull(),
    seriesId: integer('series_id'),
    episodeId: integer('episode_id'),
    movieId: integer('movie_id'),
    sourceTitle: text('source_title').notNull(),
    quality: text('quality', { mode: 'json' }).$type<QualityModel>().notNull(),
    languages: text('languages', { mode: 'json' }).$type<string[]>().notNull(),
    date: text('date').notNull(),
    downloadId: text('download_id'),
    /** camelCase keys, string values. */
    data: text('data', { mode: 'json' }).$type<Record<string, string>>().notNull(),
  },
  (t) => [
    index('history_download_id_idx').on(t.downloadId),
    index('history_series_id_idx').on(t.seriesId),
    index('history_episode_id_idx').on(t.episodeId),
    index('history_movie_id_idx').on(t.movieId),
    index('history_event_type_idx').on(t.eventType),
    index('history_date_idx').on(t.date),
  ],
);

export type HistoryRow = typeof history.$inferSelect;
export type NewHistoryRow = typeof history.$inferInsert;

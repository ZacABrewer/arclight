import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core';
import type { QualityModel } from '@arclight/shared';

// Releases that must not be grabbed again, scoped to one parent (series or movie). Entries
// never expire; they are removed by the user, with their parent, or by housekeeping.

export const blocklist = sqliteTable(
  'blocklist',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    // 'music' and 'audiobook' are TS-only (Drizzle does not enforce enums on SQLite).
    mediaType: text('media_type', { enum: ['series', 'movie', 'music', 'audiobook'] }).notNull(),
    seriesId: integer('series_id'),
    episodeIds: text('episode_ids', { mode: 'json' }).$type<number[]>().notNull(),
    movieId: integer('movie_id'),
    sourceTitle: text('source_title').notNull(),
    quality: text('quality', { mode: 'json' }).$type<QualityModel>().notNull(),
    languages: text('languages', { mode: 'json' }).$type<string[]>().notNull(),
    date: text('date').notNull(),
    publishedDate: text('published_date'),
    size: integer('size'),
    protocol: text('protocol', { enum: ['usenet', 'torrent'] }).notNull(),
    indexer: text('indexer'),
    indexerFlags: text('indexer_flags', { mode: 'json' }).$type<string[]>().notNull(),
    message: text('message'),
    /** Stored lower-case. */
    torrentInfoHash: text('torrent_info_hash'),
    source: text('source'),
    releaseType: text('release_type'),
    // Audio targets (docs/design/music-audiobooks.md section 4.2); null on video rows.
    artistId: integer('artist_id'),
    albumIds: text('album_ids', { mode: 'json' }).$type<number[]>(),
    authorId: integer('author_id'),
    bookIds: text('book_ids', { mode: 'json' }).$type<number[]>(),
  },
  (t) => [
    index('blocklist_series_id_idx').on(t.seriesId),
    index('blocklist_movie_id_idx').on(t.movieId),
    index('blocklist_torrent_info_hash_idx').on(t.torrentInfoHash),
    index('blocklist_date_idx').on(t.date),
    index('blocklist_artist_id_idx').on(t.artistId),
    index('blocklist_author_id_idx').on(t.authorId),
  ],
);

export type BlocklistRow = typeof blocklist.$inferSelect;
export type NewBlocklistRow = typeof blocklist.$inferInsert;

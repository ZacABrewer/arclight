import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core';
import type { AnyMediaType } from '@arclight/shared';

// Imports module tables. `imported_downloads` is the "download history" of spec 2.4 reduced to
// what the importer needs: which download id produced which library file, and when. It backs
// the AlreadyImported spec (7.1) and survives the tracked-download purge.

export const importedDownloads = sqliteTable(
  'imported_downloads',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    downloadId: text('download_id').notNull(),
    mediaType: text('media_type').$type<AnyMediaType>().notNull(),
    seriesId: integer('series_id'),
    movieId: integer('movie_id'),
    episodeIds: text('episode_ids', { mode: 'json' }).$type<number[]>().notNull(),
    /** Not a foreign key: the file row may be replaced later while the record stays. */
    mediaFileId: integer('media_file_id'),
    sourcePath: text('source_path').notNull(),
    destinationPath: text('destination_path').notNull(),
    importedAt: text('imported_at').notNull(),
    // Audio targets (docs/design/music-audiobooks.md section 4.2); null on video rows.
    artistId: integer('artist_id'),
    albumIds: text('album_ids', { mode: 'json' }).$type<number[]>(),
    authorId: integer('author_id'),
    bookIds: text('book_ids', { mode: 'json' }).$type<number[]>(),
  },
  (t) => [index('imported_downloads_download_idx').on(t.downloadId)],
);

export type ImportedDownloadRow = typeof importedDownloads.$inferSelect;

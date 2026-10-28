import { sqliteTable, integer, text, real, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';
import type {
  AudibleRegion,
  AudiobookImage,
  BookAuthorCredit,
  BookAuthorRole,
  BookChapter,
  BookFormatType,
  Ratings,
} from '@arclight/shared';

// Audiobook tables (docs/design/music-audiobooks.md section 4.4): authors → books, with series
// and co-authors as many-to-many links. Files live in the shared `audio_files` table
// (library/schema.ts, `media_type = 'audiobook'`). Its `author_id` / `book_id` columns were
// added in 0018, before these tables existed, so they carry no foreign key and nothing cascades:
// the audiobooks module deletes an author's or book's `audio_files` rows itself, in the same
// transaction as the author/book row. Exclusions use `audio_import_exclusions` with
// `media_type = 'audiobook'`.

export const authors = sqliteTable(
  'authors',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Audible author ASIN (the Audnexus key); null for authors only OpenLibrary knows. */
    asin: text('asin'),
    olAuthorId: text('ol_author_id'),
    name: text('name').notNull(),
    sortName: text('sort_name').notNull(),
    cleanName: text('clean_name').notNull(),
    overview: text('overview').notNull().default(''),
    images: text('images', { mode: 'json' }).$type<AudiobookImage[]>().notNull(),
    genres: text('genres', { mode: 'json' }).$type<string[]>().notNull(),
    aliases: text('aliases', { mode: 'json' }).$type<string[]>().notNull(),
    path: text('path').notNull(),
    rootFolderPath: text('root_folder_path').notNull(),
    /** An `audiobook` domain quality profile (not a foreign key, like series/movies/artists). */
    qualityProfileId: integer('quality_profile_id').notNull(),
    monitored: integer('monitored', { mode: 'boolean' }).notNull().default(true),
    monitorNewBooks: text('monitor_new_books', { enum: ['all', 'none', 'inSeries'] }).notNull().default('all'),
    /** Book languages to keep; empty means the `audiobookMetadata.languages` setting. */
    languages: text('languages', { mode: 'json' }).$type<string[]>().notNull(),
    tags: text('tags', { mode: 'json' }).$type<number[]>().notNull(),
    added: text('added').notNull(),
    lastRefreshed: text('last_refreshed'),
    /** RefreshAuthors orders by this (+7 d, +1 d with a future monitored book). */
    nextRefreshAt: text('next_refresh_at'),
  },
  (t) => [
    // SQLite unique indexes allow any number of NULLs, so ASIN-less / OL-less authors coexist.
    uniqueIndex('authors_asin_idx').on(t.asin),
    uniqueIndex('authors_ol_author_id_idx').on(t.olAuthorId),
    uniqueIndex('authors_path_idx').on(t.path),
    index('authors_clean_name_idx').on(t.cleanName),
    index('authors_next_refresh_idx').on(t.nextRefreshAt),
  ],
);

export const books = sqliteTable(
  'books',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** The owning author; the book's folder lives under theirs. */
    authorId: integer('author_id')
      .notNull()
      .references(() => authors.id, { onDelete: 'cascade' }),
    asin: text('asin'),
    isbn13: text('isbn13'),
    olWorkId: text('ol_work_id'),
    region: text('region').$type<AudibleRegion>(),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    sortTitle: text('sort_title').notNull(),
    cleanTitle: text('clean_title').notNull(),
    authorCredits: text('author_credits', { mode: 'json' }).$type<BookAuthorCredit[]>().notNull(),
    narrators: text('narrators', { mode: 'json' }).$type<string[]>().notNull(),
    publisher: text('publisher'),
    language: text('language'),
    /** `YYYY-MM-DD` (or `YYYY` when the catalogue knows no more). */
    releaseDate: text('release_date'),
    year: integer('year'),
    runtimeMinutes: integer('runtime_minutes'),
    formatType: text('format_type').$type<BookFormatType>(),
    overview: text('overview').notNull().default(''),
    genres: text('genres', { mode: 'json' }).$type<string[]>().notNull(),
    images: text('images', { mode: 'json' }).$type<AudiobookImage[]>().notNull(),
    chapters: text('chapters', { mode: 'json' }).$type<BookChapter[]>().notNull(),
    ratings: text('ratings', { mode: 'json' }).$type<Ratings>().notNull(),
    monitored: integer('monitored', { mode: 'boolean' }).notNull().default(true),
    hasFile: integer('has_file', { mode: 'boolean' }).notNull().default(false),
    path: text('path'),
    added: text('added').notNull(),
    lastRefreshed: text('last_refreshed'),
  },
  (t) => [
    uniqueIndex('books_asin_idx').on(t.asin),
    index('books_author_idx').on(t.authorId),
    index('books_monitored_has_file_idx').on(t.monitored, t.hasFile),
    index('books_release_date_idx').on(t.releaseDate),
    index('books_clean_title_idx').on(t.cleanTitle),
    index('books_isbn13_idx').on(t.isbn13),
  ],
);

/** Library authors linked to books they do not own (co-authors, editors ...). */
export const bookAuthors = sqliteTable(
  'book_authors',
  {
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    authorId: integer('author_id')
      .notNull()
      .references(() => authors.id, { onDelete: 'cascade' }),
    role: text('role').$type<BookAuthorRole>().notNull().default('author'),
  },
  (t) => [primaryKey({ columns: [t.bookId, t.authorId] }), index('book_authors_author_idx').on(t.authorId)],
);

/** Series span authors, so they belong to none; orphaned series are pruned by the module. */
export const bookSeries = sqliteTable(
  'book_series',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    asin: text('asin'),
    name: text('name').notNull(),
    cleanName: text('clean_name').notNull(),
    overview: text('overview').notNull().default(''),
  },
  (t) => [uniqueIndex('book_series_asin_idx').on(t.asin), index('book_series_clean_name_idx').on(t.cleanName)],
);

export const bookSeriesEntries = sqliteTable(
  'book_series_entries',
  {
    seriesId: integer('series_id')
      .notNull()
      .references(() => bookSeries.id, { onDelete: 'cascade' }),
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    /** As the catalogue writes it: `3`, `2.5`, `1-3`, `Prequel`. */
    position: text('position'),
    /** Numeric sort key derived from `position`. */
    positionSort: real('position_sort'),
    isPrimary: integer('is_primary', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.seriesId, t.bookId] }), index('book_series_entries_book_idx').on(t.bookId)],
);

export type AuthorRow = typeof authors.$inferSelect;
export type BookRow = typeof books.$inferSelect;
export type BookAuthorRow = typeof bookAuthors.$inferSelect;
export type BookSeriesRow = typeof bookSeries.$inferSelect;
export type BookSeriesEntryRow = typeof bookSeriesEntries.$inferSelect;

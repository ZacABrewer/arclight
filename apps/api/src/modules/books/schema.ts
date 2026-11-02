import { sqliteTable, integer, text, real, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';
import type { BooksFormat, BooksKind, BooksLibraryAppImplementation, BooksLibraryAppKind, BooksRequestStatus } from '@arclight/shared';
import { bookSeries } from '../audiobooks/schema.js';

// Books tables (docs/books.md): ebook authors → ebooks, comic series → issues, one `book_files`
// table for both kinds, format profiles, the module's own grab log (download-client tracking
// has no books media type, so book grabs are matched back by download id here), reading
// requests and the reading servers told about imports.
//
// Ebook series reuse the audiobook library's `book_series` rows (one "Mistborn" for both), linked
// through `ebook_series_entries`; the audiobooks module keeps series these entries still use when
// it prunes orphans. Format profiles are referenced by id without a foreign key (like quality
// profiles elsewhere); the profiles route refuses to delete one still in use.

export const bookFormatProfiles = sqliteTable(
  'book_format_profiles',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    kind: text('kind').$type<BooksKind>().notNull(),
    /** Allowed formats, best first. */
    formats: text('formats', { mode: 'json' }).$type<BooksFormat[]>().notNull(),
    cutoff: text('cutoff').$type<BooksFormat>().notNull(),
    upgradeAllowed: integer('upgrade_allowed', { mode: 'boolean' }).notNull().default(true),
    minSizeMb: real('min_size_mb'),
    maxSizeMb: real('max_size_mb'),
    ignoredTerms: text('ignored_terms', { mode: 'json' }).$type<string[]>().notNull(),
    preferredTerms: text('preferred_terms', { mode: 'json' }).$type<string[]>().notNull(),
  },
  (t) => [uniqueIndex('book_format_profiles_name_idx').on(t.name)],
);

export const ebookAuthors = sqliteTable(
  'ebook_authors',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** The catalogue key the author was added by (`ol:…`, `hc:…`, `name:…`); refreshes use it. */
    foreignId: text('foreign_id').notNull(),
    olAuthorId: text('ol_author_id'),
    hardcoverId: text('hardcover_id'),
    name: text('name').notNull(),
    sortName: text('sort_name').notNull(),
    /** `bookTitleKey(name)`: matching releases, files and the audiobook library. */
    cleanName: text('clean_name').notNull(),
    overview: text('overview').notNull().default(''),
    imageUrl: text('image_url'),
    path: text('path').notNull(),
    rootFolderPath: text('root_folder_path').notNull(),
    formatProfileId: integer('format_profile_id').notNull(),
    monitored: integer('monitored', { mode: 'boolean' }).notNull().default(true),
    monitorNewBooks: text('monitor_new_books', { enum: ['all', 'none', 'inSeries'] }).notNull().default('all'),
    tags: text('tags', { mode: 'json' }).$type<number[]>().notNull(),
    /** The same person in the audiobook `authors` table (no foreign key: either side may go first). */
    audiobookAuthorId: integer('audiobook_author_id'),
    added: text('added').notNull(),
    lastRefreshed: text('last_refreshed'),
    nextRefreshAt: text('next_refresh_at'),
  },
  (t) => [
    uniqueIndex('ebook_authors_foreign_id_idx').on(t.foreignId),
    uniqueIndex('ebook_authors_ol_author_id_idx').on(t.olAuthorId),
    uniqueIndex('ebook_authors_path_idx').on(t.path),
    index('ebook_authors_clean_name_idx').on(t.cleanName),
    index('ebook_authors_next_refresh_idx').on(t.nextRefreshAt),
  ],
);

export const ebooks = sqliteTable(
  'ebooks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    authorId: integer('author_id')
      .notNull()
      .references(() => ebookAuthors.id, { onDelete: 'cascade' }),
    /** Best catalogue key (`isbn:` first); `keys` holds every key the work is known by. */
    foreignId: text('foreign_id').notNull(),
    keys: text('keys', { mode: 'json' }).$type<string[]>().notNull(),
    isbn13: text('isbn13'),
    /** Other editions' ISBN-13s (release matching). */
    isbns: text('isbns', { mode: 'json' }).$type<string[]>().notNull(),
    olWorkId: text('ol_work_id'),
    googleVolumeId: text('google_volume_id'),
    hardcoverId: text('hardcover_id'),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    sortTitle: text('sort_title').notNull(),
    /** `bookTitleKey(title)`. */
    cleanTitle: text('clean_title').notNull(),
    publisher: text('publisher'),
    language: text('language'),
    releaseDate: text('release_date'),
    year: integer('year'),
    pageCount: integer('page_count'),
    overview: text('overview').notNull().default(''),
    genres: text('genres', { mode: 'json' }).$type<string[]>().notNull(),
    coverUrl: text('cover_url'),
    rating: real('rating'),
    monitored: integer('monitored', { mode: 'boolean' }).notNull().default(true),
    hasFile: integer('has_file', { mode: 'boolean' }).notNull().default(false),
    lastSearchedAt: text('last_searched_at'),
    added: text('added').notNull(),
    lastRefreshed: text('last_refreshed'),
  },
  (t) => [
    index('ebooks_author_idx').on(t.authorId),
    index('ebooks_foreign_id_idx').on(t.foreignId),
    index('ebooks_clean_title_idx').on(t.cleanTitle),
    index('ebooks_isbn13_idx').on(t.isbn13),
    index('ebooks_monitored_has_file_idx').on(t.monitored, t.hasFile),
    index('ebooks_release_date_idx').on(t.releaseDate),
  ],
);

/** Ebooks in the shared `book_series`. */
export const ebookSeriesEntries = sqliteTable(
  'ebook_series_entries',
  {
    seriesId: integer('series_id')
      .notNull()
      .references(() => bookSeries.id, { onDelete: 'cascade' }),
    ebookId: integer('ebook_id')
      .notNull()
      .references(() => ebooks.id, { onDelete: 'cascade' }),
    position: text('position'),
    positionSort: real('position_sort'),
  },
  (t) => [primaryKey({ columns: [t.seriesId, t.ebookId] }), index('ebook_series_entries_ebook_idx').on(t.ebookId)],
);

export const comicSeries = sqliteTable(
  'comic_series',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** `cv:…` or `metron:…`, the key the series was added by. */
    foreignId: text('foreign_id').notNull(),
    comicVineId: text('comic_vine_id'),
    metronId: text('metron_id'),
    title: text('title').notNull(),
    sortTitle: text('sort_title').notNull(),
    cleanTitle: text('clean_title').notNull(),
    publisher: text('publisher'),
    startYear: integer('start_year'),
    seriesType: text('series_type', { enum: ['comic', 'manga', 'graphicNovel'] }).notNull().default('comic'),
    overview: text('overview').notNull().default(''),
    coverUrl: text('cover_url'),
    status: text('status', { enum: ['continuing', 'ended', 'unknown'] }).notNull().default('unknown'),
    path: text('path').notNull(),
    rootFolderPath: text('root_folder_path').notNull(),
    formatProfileId: integer('format_profile_id').notNull(),
    monitored: integer('monitored', { mode: 'boolean' }).notNull().default(true),
    monitorNewIssues: integer('monitor_new_issues', { mode: 'boolean' }).notNull().default(true),
    tags: text('tags', { mode: 'json' }).$type<number[]>().notNull(),
    added: text('added').notNull(),
    lastRefreshed: text('last_refreshed'),
    nextRefreshAt: text('next_refresh_at'),
  },
  (t) => [
    uniqueIndex('comic_series_foreign_id_idx').on(t.foreignId),
    uniqueIndex('comic_series_comic_vine_id_idx').on(t.comicVineId),
    uniqueIndex('comic_series_metron_id_idx').on(t.metronId),
    uniqueIndex('comic_series_path_idx').on(t.path),
    index('comic_series_clean_title_idx').on(t.cleanTitle),
    index('comic_series_next_refresh_idx').on(t.nextRefreshAt),
  ],
);

export const comicIssues = sqliteTable(
  'comic_issues',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    seriesId: integer('series_id')
      .notNull()
      .references(() => comicSeries.id, { onDelete: 'cascade' }),
    foreignId: text('foreign_id'),
    comicVineId: text('comic_vine_id'),
    metronId: text('metron_id'),
    /** As published (`1`, `12.1`, `Annual 1`). */
    issueNumber: text('issue_number').notNull(),
    /** Normalized issue number for matching (`001` → `1`, `Annual 01` → `annual 1`). */
    issueKey: text('issue_key').notNull(),
    issueSort: real('issue_sort'),
    title: text('title'),
    coverDate: text('cover_date'),
    storeDate: text('store_date'),
    overview: text('overview').notNull().default(''),
    coverUrl: text('cover_url'),
    monitored: integer('monitored', { mode: 'boolean' }).notNull().default(true),
    hasFile: integer('has_file', { mode: 'boolean' }).notNull().default(false),
    lastSearchedAt: text('last_searched_at'),
    added: text('added').notNull(),
  },
  (t) => [
    uniqueIndex('comic_issues_series_issue_idx').on(t.seriesId, t.issueKey),
    index('comic_issues_monitored_has_file_idx').on(t.monitored, t.hasFile),
    index('comic_issues_store_date_idx').on(t.storeDate),
  ],
);

/** One file per ebook or comic issue (exactly one of the two ids is set). */
export const bookFiles = sqliteTable(
  'book_files',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind').$type<BooksKind>().notNull(),
    ebookId: integer('ebook_id').references(() => ebooks.id, { onDelete: 'cascade' }),
    comicIssueId: integer('comic_issue_id').references(() => comicIssues.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    /** Relative to the root folder (`Author/Book/file.epub`). */
    relativePath: text('relative_path').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    format: text('format').$type<BooksFormat>().notNull(),
    releaseGroup: text('release_group'),
    sceneName: text('scene_name'),
    dateAdded: text('date_added').notNull(),
  },
  (t) => [
    uniqueIndex('book_files_path_idx').on(t.path),
    index('book_files_ebook_idx').on(t.ebookId),
    index('book_files_comic_issue_idx').on(t.comicIssueId),
  ],
);

/**
 * Releases the books module sent to a download client. `downloadId` starts as the client's
 * `pending:` id when the client was unreachable and is rewritten once it takes the item. Failed
 * rows double as the books blocklist (a failed guid is not grabbed again automatically).
 */
export const bookGrabs = sqliteTable(
  'book_grabs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind').$type<BooksKind>().notNull(),
    ebookId: integer('ebook_id').references(() => ebooks.id, { onDelete: 'cascade' }),
    comicIssueId: integer('comic_issue_id').references(() => comicIssues.id, { onDelete: 'cascade' }),
    downloadId: text('download_id').notNull(),
    guid: text('guid').notNull(),
    indexerId: integer('indexer_id').notNull(),
    indexerName: text('indexer_name').notNull(),
    title: text('title').notNull(),
    protocol: text('protocol', { enum: ['torrent', 'usenet'] }).notNull(),
    sizeBytes: integer('size_bytes').notNull().default(0),
    format: text('format').$type<BooksFormat>(),
    releaseGroup: text('release_group'),
    status: text('status', { enum: ['grabbed', 'imported', 'failed'] }).notNull().default('grabbed'),
    message: text('message'),
    grabbedAt: text('grabbed_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('book_grabs_download_id_idx').on(t.downloadId),
    index('book_grabs_guid_idx').on(t.guid),
    index('book_grabs_ebook_idx').on(t.ebookId),
    index('book_grabs_comic_issue_idx').on(t.comicIssueId),
  ],
);

/** Reading requests; user ids are plain integers like the other request tables. */
export const bookRequests = sqliteTable(
  'book_requests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind').$type<BooksKind>().notNull(),
    status: text('status').$type<BooksRequestStatus>().notNull().default('pending'),
    foreignId: text('foreign_id').notNull(),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    year: integer('year'),
    coverUrl: text('cover_url'),
    requestedById: integer('requested_by_id').notNull(),
    modifiedById: integer('modified_by_id'),
    declineReason: text('decline_reason'),
    failureReason: text('failure_reason'),
    /** Ebook id or comic series id once approved. */
    libraryId: integer('library_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('book_requests_kind_foreign_idx').on(t.kind, t.foreignId),
    index('book_requests_requested_by_idx').on(t.requestedById),
    index('book_requests_status_idx').on(t.status),
  ],
);

/** Reading servers (Kavita, Komga, Calibre-Web, Audiobookshelf) asked to rescan after imports. */
export const bookLibraryApps = sqliteTable('book_library_apps', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  implementation: text('implementation').$type<BooksLibraryAppImplementation>().notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  url: text('url').notNull(),
  apiKey: text('api_key').notNull().default(''),
  username: text('username').notNull().default(''),
  password: text('password').notNull().default(''),
  libraryId: text('library_id').notNull().default(''),
  kinds: text('kinds', { mode: 'json' }).$type<BooksLibraryAppKind[]>().notNull(),
});

export type BookFormatProfileRow = typeof bookFormatProfiles.$inferSelect;
export type EbookAuthorRow = typeof ebookAuthors.$inferSelect;
export type EbookRow = typeof ebooks.$inferSelect;
export type EbookSeriesEntryRow = typeof ebookSeriesEntries.$inferSelect;
export type ComicSeriesRow = typeof comicSeries.$inferSelect;
export type ComicIssueRow = typeof comicIssues.$inferSelect;
export type BookFileRow = typeof bookFiles.$inferSelect;
export type BookGrabRow = typeof bookGrabs.$inferSelect;
export type BookRequestRow = typeof bookRequests.$inferSelect;
export type BookLibraryAppRow = typeof bookLibraryApps.$inferSelect;

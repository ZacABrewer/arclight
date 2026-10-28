import { z } from 'zod';
import { Paged, Ratings, SortOrder } from './library.js';
import { AudioFile } from './music.js';

// The audiobook contract (docs/design/music-audiobooks.md sections 4.4, 5.2): authors, books
// (one audiobook edition each, keyed by ASIN when known), series and their entries, co-author
// links, the add/list/details API and the `audiobookMetadata` settings section. Files live in the
// shared `audio_files` table (`AudioFile` from music.ts, `mediaType: 'audiobook'`). Dates follow
// the library rules: ISO-8601 strings, date-only `YYYY-MM-DD` for release dates.

const isoDate = () => z.string().describe('ISO-8601 date or timestamp');
const idList = () => z.array(z.number().int().positive());
/**
 * Query-string boolean: `true`/`false`/`1`/`0` (and real booleans from typed callers).
 * `z.coerce.boolean()` would read the string "false" as true.
 */
const qsBool = () => z.union([z.boolean(), z.stringbool()]);

// ---------------------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------------------

/** An Amazon/Audible ASIN (10 characters, letters and digits). Stored upper-case. */
export const Asin = z
  .string()
  .trim()
  .regex(/^[0-9a-z]{10}$/i, 'must be an ASIN (10 letters or digits)')
  .transform((s) => s.toUpperCase());
export type Asin = z.infer<typeof Asin>;

/**
 * An ISBN-10 or ISBN-13. Hyphens and spaces are dropped; a trailing `x` is upper-cased.
 * Check digits are not verified here (catalogues carry the odd bad one).
 */
export const Isbn = z
  .string()
  .transform((s) => s.replace(/[\s-]/g, '').toUpperCase())
  .pipe(z.string().regex(/^(?:\d{9}[\dX]|\d{13})$/, 'must be an ISBN-10 or ISBN-13'));
export type Isbn = z.infer<typeof Isbn>;

/** Convert an ISBN-10 to ISBN-13 (978 prefix); ISBN-13 is returned unchanged. */
export function toIsbn13(isbn: string): string {
  if (isbn.length === 13) return isbn;
  const core = `978${isbn.slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
  return `${core}${(10 - (sum % 10)) % 10}`;
}

/** An OpenLibrary author key, e.g. `OL23919A`. Stored upper-case without the `/authors/` prefix. */
export const OpenLibraryAuthorId = z
  .string()
  .trim()
  .transform((s) => s.replace(/^\/?authors\//i, '').toUpperCase())
  .pipe(z.string().regex(/^OL\d+A$/, 'must be an OpenLibrary author id (OL…A)'));
export type OpenLibraryAuthorId = z.infer<typeof OpenLibraryAuthorId>;

/** An OpenLibrary work key, e.g. `OL82563W`. */
export const OpenLibraryWorkId = z
  .string()
  .trim()
  .transform((s) => s.replace(/^\/?works\//i, '').toUpperCase())
  .pipe(z.string().regex(/^OL\d+W$/, 'must be an OpenLibrary work id (OL…W)'));
export type OpenLibraryWorkId = z.infer<typeof OpenLibraryWorkId>;

// ---------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------

/** Audible marketplaces the catalogue clients know. */
export const AudibleRegion = z.enum(['us', 'uk', 'ca', 'au', 'de', 'fr', 'it', 'es', 'jp', 'in']);
export type AudibleRegion = z.infer<typeof AudibleRegion>;

/** Top-level domain suffix of each marketplace (`audible.<tld>`, `api.audible.<tld>`). */
export const AUDIBLE_REGION_TLD: Readonly<Record<AudibleRegion, string>> = {
  us: 'com',
  uk: 'co.uk',
  ca: 'ca',
  au: 'com.au',
  de: 'de',
  fr: 'fr',
  it: 'it',
  es: 'es',
  jp: 'co.jp',
  in: 'in',
};

/** How the recording relates to the text. */
export const BookFormatType = z.enum(['unabridged', 'abridged', 'dramatized']);
export type BookFormatType = z.infer<typeof BookFormatType>;

/** What a metadata refresh does with books that are new since the last refresh. */
export const MonitorNewBooks = z.enum(['all', 'none', 'inSeries']);
export type MonitorNewBooks = z.infer<typeof MonitorNewBooks>;

/**
 * How book monitored flags are set when an author is added or re-monitored (like
 * `MusicMonitorOption`). `inSeries`: only books that belong to a series.
 */
export const AudiobookMonitorOption = z.enum(['all', 'future', 'missing', 'existing', 'latest', 'first', 'inSeries', 'none']);
export type AudiobookMonitorOption = z.infer<typeof AudiobookMonitorOption>;

/** A library author's part in a book they do not own (`book_authors.role`). */
export const BookAuthorRole = z.enum(['author', 'editor', 'translator', 'foreword', 'contributor']);
export type BookAuthorRole = z.infer<typeof BookAuthorRole>;

// ---------------------------------------------------------------------------------------
// Sub-shapes
// ---------------------------------------------------------------------------------------

export const AudiobookImageType = z.enum(['cover', 'headshot', 'fanart', 'banner']);
export type AudiobookImageType = z.infer<typeof AudiobookImageType>;

export const AudiobookImage = z.object({
  coverType: AudiobookImageType,
  /** Local cached URL once fetched; remote URL until then. */
  url: z.string(),
  remoteUrl: z.string().nullish(),
});
export type AudiobookImage = z.infer<typeof AudiobookImage>;

/** One chapter marker from the catalogue (Audnexus) or the file. */
export const BookChapter = z.object({
  title: z.string(),
  startMs: z.number().int().min(0),
  lengthMs: z.number().int().min(0).nullish(),
});
export type BookChapter = z.infer<typeof BookChapter>;

/** An author as credited on the book (`books.author_credits`), whether or not they are in the library. */
export const BookAuthorCredit = z.object({
  name: z.string(),
  asin: z.string().nullish(),
  /** Set when the credited author is in the library. */
  authorId: z.number().int().nullish(),
});
export type BookAuthorCredit = z.infer<typeof BookAuthorCredit>;

// ---------------------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------------------

export const BookStatistics = z.object({
  /** `audio_files` rows of the book (one for an m4b, one per part for multi-file books). */
  fileCount: z.number().int(),
  sizeOnDisk: z.number().int(),
  /** Sum of the files' durations; null when no file reports one. */
  durationMs: z.number().int().nullish(),
});
export type BookStatistics = z.infer<typeof BookStatistics>;

export const AuthorStatistics = z.object({
  bookCount: z.number().int(),
  monitoredBookCount: z.number().int(),
  /** Books with at least one file. */
  availableBookCount: z.number().int(),
  /** Monitored, released, no file (the "missing" count). */
  missingBookCount: z.number().int(),
  fileCount: z.number().int(),
  sizeOnDisk: z.number().int(),
  seriesCount: z.number().int(),
  /** Available monitored books / monitored books × 100 (0 when nothing is monitored). */
  percentOfBooks: z.number(),
});
export type AuthorStatistics = z.infer<typeof AuthorStatistics>;

// ---------------------------------------------------------------------------------------
// Authors / books / series
// ---------------------------------------------------------------------------------------

export const Author = z.object({
  id: z.number().int(),
  /** Audible author ASIN (the Audnexus key). Null for authors only OpenLibrary knows. */
  asin: z.string().nullish(),
  olAuthorId: z.string().nullish(),
  name: z.string(),
  sortName: z.string(),
  cleanName: z.string(),
  overview: z.string(),
  images: z.array(AudiobookImage),
  genres: z.array(z.string()),
  aliases: z.array(z.string()),
  path: z.string(),
  rootFolderPath: z.string(),
  /** An `audiobook` domain quality profile. */
  qualityProfileId: z.number().int(),
  monitored: z.boolean(),
  monitorNewBooks: MonitorNewBooks,
  /** Book languages to keep for this author; empty means the `audiobookMetadata.languages` setting. */
  languages: z.array(z.string()),
  tags: z.array(z.number().int()),
  added: isoDate(),
  lastRefreshed: isoDate().nullish(),
  nextRefreshAt: isoDate().nullish(),
  statistics: AuthorStatistics.nullish(),
});
export type Author = z.infer<typeof Author>;

/** A series row (`book_series`). Series span authors, so they belong to no single author. */
export const BookSeries = z.object({
  id: z.number().int(),
  /** Audible series ASIN, when known. */
  asin: z.string().nullish(),
  name: z.string(),
  cleanName: z.string(),
  overview: z.string(),
});
export type BookSeries = z.infer<typeof BookSeries>;

/** A book's place in a series (`book_series_entries`). */
export const BookSeriesEntry = z.object({
  seriesId: z.number().int(),
  bookId: z.number().int(),
  /** As the catalogue writes it: `3`, `2.5`, `1-3`, `Prequel`. */
  position: z.string().nullish(),
  /** Numeric sort key derived from `position` (null when it has no number). */
  positionSort: z.number().nullish(),
  /** The series the book is filed under when it is in several. */
  isPrimary: z.boolean(),
});
export type BookSeriesEntry = z.infer<typeof BookSeriesEntry>;

/** An entry with the series' name, as embedded in a book. */
export const BookSeriesLink = BookSeriesEntry.extend({
  name: z.string(),
  asin: z.string().nullish(),
});
export type BookSeriesLink = z.infer<typeof BookSeriesLink>;

/** A library author linked to a book they do not own (`book_authors`). */
export const BookAuthor = z.object({
  bookId: z.number().int(),
  authorId: z.number().int(),
  role: BookAuthorRole,
});
export type BookAuthor = z.infer<typeof BookAuthor>;

export const Book = z.object({
  id: z.number().int(),
  /** The owning author: the book's folder lives under theirs. */
  authorId: z.number().int(),
  asin: z.string().nullish(),
  isbn13: z.string().nullish(),
  olWorkId: z.string().nullish(),
  /** The Audible marketplace the record came from. */
  region: AudibleRegion.nullish(),
  title: z.string(),
  subtitle: z.string().nullish(),
  sortTitle: z.string(),
  cleanTitle: z.string(),
  authorCredits: z.array(BookAuthorCredit),
  narrators: z.array(z.string()),
  publisher: z.string().nullish(),
  language: z.string().nullish(),
  releaseDate: z.string().nullish(),
  year: z.number().int().nullish(),
  runtimeMinutes: z.number().int().nullish(),
  formatType: BookFormatType.nullish(),
  overview: z.string(),
  genres: z.array(z.string()),
  images: z.array(AudiobookImage),
  chapters: z.array(BookChapter),
  ratings: Ratings,
  monitored: z.boolean(),
  hasFile: z.boolean(),
  /** The book's folder (or single file's folder) once imported or planned. */
  path: z.string().nullish(),
  series: z.array(BookSeriesLink),
  added: isoDate(),
  lastRefreshed: isoDate().nullish(),
  statistics: BookStatistics.nullish(),
});
export type Book = z.infer<typeof Book>;

/** The author fields a book or series page needs. */
export const AuthorSummary = Author.pick({ id: true, asin: true, name: true, sortName: true, path: true, images: true });
export type AuthorSummary = z.infer<typeof AuthorSummary>;

// ---------------------------------------------------------------------------------------
// API: add / update / list / details
// ---------------------------------------------------------------------------------------

export const AddAuthorRequest = z
  .object({
    /** Audible author ASIN. One of `asin` / `olAuthorId` is required; ASIN wins when both are sent. */
    asin: Asin.optional(),
    olAuthorId: OpenLibraryAuthorId.optional(),
    rootFolderPath: z.string().min(1),
    /** Must be an `audiobook` domain quality profile. */
    qualityProfileId: z.number().int(),
    monitored: z.boolean().default(true),
    monitorOption: AudiobookMonitorOption.default('all'),
    monitorNewBooks: MonitorNewBooks.default('all'),
    languages: z.array(z.string().trim().min(1)).default([]),
    tags: z.array(z.number().int()).default([]),
    /** Search for monitored missing books once the bibliography is loaded. */
    searchOnAdd: z.boolean().default(false),
  })
  .refine((r) => r.asin !== undefined || r.olAuthorId !== undefined, { message: 'asin or olAuthorId is required', path: ['asin'] });
export type AddAuthorRequest = z.infer<typeof AddAuthorRequest>;
export type AddAuthorRequestInput = z.input<typeof AddAuthorRequest>;

/** How the author of an added book is created when they are not in the library yet. */
export const AddBookAuthorOptions = z.object({
  rootFolderPath: z.string().min(1),
  /** Must be an `audiobook` domain quality profile. */
  qualityProfileId: z.number().int(),
  monitored: z.boolean().default(true),
  /** Default `none`: adding one book does not pull in the whole bibliography as wanted. */
  monitorNewBooks: MonitorNewBooks.default('none'),
  tags: z.array(z.number().int()).default([]),
});
export type AddBookAuthorOptions = z.infer<typeof AddBookAuthorOptions>;

/**
 * POST /api/v1/book: add one book by ASIN or ISBN. The book's primary author is looked up and,
 * when not in the library, created from `author` (required then; 400 without it). Other books
 * of a newly created author are added unmonitored.
 */
export const AddBookRequest = z
  .object({
    asin: Asin.optional(),
    isbn: Isbn.optional(),
    /** Marketplace to resolve the ASIN in; defaults to `audiobookMetadata.audibleRegion`. */
    region: AudibleRegion.optional(),
    monitored: z.boolean().default(true),
    searchOnAdd: z.boolean().default(false),
    author: AddBookAuthorOptions.optional(),
  })
  .refine((r) => r.asin !== undefined || r.isbn !== undefined, { message: 'asin or isbn is required', path: ['asin'] });
export type AddBookRequest = z.infer<typeof AddBookRequest>;
export type AddBookRequestInput = z.input<typeof AddBookRequest>;

export const UpdateAuthorRequest = z.object({
  monitored: z.boolean().optional(),
  monitorNewBooks: MonitorNewBooks.optional(),
  /** Re-applies this option to every book of the author. */
  monitorOption: AudiobookMonitorOption.optional(),
  qualityProfileId: z.number().int().optional(),
  rootFolderPath: z.string().min(1).optional(),
  /** Set explicitly to override the generated `<root>/<Author Name>` folder. */
  path: z.string().min(1).optional(),
  languages: z.array(z.string().trim().min(1)).optional(),
  tags: z.array(z.number().int()).optional(),
});
export type UpdateAuthorRequest = z.infer<typeof UpdateAuthorRequest>;

export const UpdateBookRequest = z.object({
  monitored: z.boolean().optional(),
});
export type UpdateBookRequest = z.infer<typeof UpdateBookRequest>;

export const BulkBookMonitorRequest = z.object({
  bookIds: idList().min(1),
  monitored: z.boolean(),
});
export type BulkBookMonitorRequest = z.infer<typeof BulkBookMonitorRequest>;

export const BulkAuthorUpdateRequest = z.object({
  ids: idList().min(1),
  monitored: z.boolean().optional(),
  monitorOption: AudiobookMonitorOption.optional(),
  monitorNewBooks: MonitorNewBooks.optional(),
  qualityProfileId: z.number().int().optional(),
  rootFolderPath: z.string().min(1).optional(),
  tags: z
    .object({ add: z.array(z.number().int()).optional(), remove: z.array(z.number().int()).optional() })
    .optional(),
  refresh: z.boolean().optional(),
});
export type BulkAuthorUpdateRequest = z.infer<typeof BulkAuthorUpdateRequest>;

export const DeleteAuthorQuery = z.object({
  deleteFiles: qsBool().default(false),
  /** Adds the author to `audio_import_exclusions` (`media_type` audiobook, foreign id = ASIN or OL id). */
  addExclusion: qsBool().default(false),
});
export type DeleteAuthorQuery = z.infer<typeof DeleteAuthorQuery>;

export const DeleteBookQuery = z.object({
  deleteFiles: qsBool().default(false),
  /** Adds the book's ASIN (or ISBN) to `audio_import_exclusions`. */
  addExclusion: qsBool().default(false),
});
export type DeleteBookQuery = z.infer<typeof DeleteBookQuery>;

export const AuthorSortKey = z.enum(['sortName', 'added', 'qualityProfileId', 'path', 'sizeOnDisk', 'bookCount']);
export type AuthorSortKey = z.infer<typeof AuthorSortKey>;

export const AuthorListQuery = z.object({
  monitored: qsBool().optional(),
  qualityProfileId: z.coerce.number().int().optional(),
  rootFolderPath: z.string().optional(),
  tag: z.coerce.number().int().optional(),
  asin: z.string().optional(),
  olAuthorId: z.string().optional(),
  /** Case-insensitive substring match on name and aliases. */
  search: z.string().optional(),
  includeStatistics: qsBool().default(true),
  sortKey: AuthorSortKey.default('sortName'),
  sortOrder: SortOrder.default('asc'),
});
export type AuthorListQuery = z.infer<typeof AuthorListQuery>;

/** GET /api/v1/author. */
export const AuthorListResponse = z.array(Author);
export type AuthorListResponse = z.infer<typeof AuthorListResponse>;

export const BookListQuery = z.object({
  /** Books the author owns or is linked to through `book_authors`. */
  authorId: z.coerce.number().int().optional(),
  seriesId: z.coerce.number().int().optional(),
  monitored: qsBool().optional(),
  hasFile: qsBool().optional(),
  asin: z.string().optional(),
  isbn: z.string().optional(),
  includeStatistics: qsBool().default(true),
});
export type BookListQuery = z.infer<typeof BookListQuery>;

/** GET /api/v1/book. */
export const BookListResponse = z.array(Book);
export type BookListResponse = z.infer<typeof BookListResponse>;

export const BookSeriesListQuery = z.object({
  /** Series with at least one book of this author. */
  authorId: z.coerce.number().int().optional(),
  search: z.string().optional(),
});
export type BookSeriesListQuery = z.infer<typeof BookSeriesListQuery>;

/** A series with its book counts, for lists. */
export const BookSeriesSummary = BookSeries.extend({
  bookCount: z.number().int(),
  availableBookCount: z.number().int(),
});
export type BookSeriesSummary = z.infer<typeof BookSeriesSummary>;

/** GET /api/v1/bookseries. */
export const BookSeriesListResponse = z.array(BookSeriesSummary);
export type BookSeriesListResponse = z.infer<typeof BookSeriesListResponse>;

/** GET /api/v1/author/:id: the author with their books (grouped by series in the UI) and series. */
export const AuthorDetails = Author.extend({
  books: z.array(Book),
  series: z.array(BookSeriesSummary),
});
export type AuthorDetails = z.infer<typeof AuthorDetails>;

/** GET /api/v1/book/:id: the book with its author, linked library authors, series and files. */
export const BookDetails = Book.extend({
  author: AuthorSummary,
  /** Library authors linked through `book_authors` (co-authors, editors ...). */
  contributors: z.array(AuthorSummary.extend({ role: BookAuthorRole })),
  files: z.array(AudioFile),
});
export type BookDetails = z.infer<typeof BookDetails>;

/** GET /api/v1/bookseries/:id: the series with its books in position order and their authors. */
export const BookSeriesDetails = BookSeries.extend({
  books: z.array(Book),
  authors: z.array(AuthorSummary),
});
export type BookSeriesDetails = z.infer<typeof BookSeriesDetails>;

// ---------------------------------------------------------------------------------------
// Wanted
// ---------------------------------------------------------------------------------------

export const WantedBooksQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});
export type WantedBooksQuery = z.infer<typeof WantedBooksQuery>;

export const WantedBook = Book.extend({
  authorName: z.string(),
  qualityProfileId: z.number().int(),
});
export type WantedBook = z.infer<typeof WantedBook>;

export const WantedBooksPage = Paged(WantedBook);
export type WantedBooksPage = z.infer<typeof WantedBooksPage>;

// ---------------------------------------------------------------------------------------
// Commands (POST /api/v1/command, answered 202 with the started Job)
// ---------------------------------------------------------------------------------------

/**
 * Audiobook commands. `RefreshAuthor` re-fetches metadata (and new books) for the authors;
 * `RescanAuthor` re-reads their folders into `audio_files`; `AuthorSearch` / `BookSearch` search
 * the indexers for monitored missing books.
 */
export const AudiobookCommand = z.discriminatedUnion('name', [
  z.object({ name: z.literal('RefreshAuthor'), authorIds: idList().min(1) }),
  z.object({ name: z.literal('RescanAuthor'), authorIds: idList().min(1) }),
  z.object({ name: z.literal('AuthorSearch'), authorIds: idList().min(1) }),
  z.object({ name: z.literal('BookSearch'), bookIds: idList().min(1) }),
]);
export type AudiobookCommand = z.infer<typeof AudiobookCommand>;
export type AudiobookCommandName = AudiobookCommand['name'];

// ---------------------------------------------------------------------------------------
// Lookup (Audible catalogue / Audnexus / OpenLibrary search)
// ---------------------------------------------------------------------------------------

export const AuthorLookupQuery = z.object({
  term: z.string().trim().min(1),
  region: AudibleRegion.optional(),
});
export type AuthorLookupQuery = z.infer<typeof AuthorLookupQuery>;

export const AuthorSearchResult = z.object({
  asin: z.string().nullish(),
  olAuthorId: z.string().nullish(),
  name: z.string(),
  overview: z.string().nullish(),
  genres: z.array(z.string()),
  images: z.array(AudiobookImage),
  /** Titles the catalogue lists for the author, when the source says. */
  bookCount: z.number().int().nullish(),
  /** A few well-known titles, to tell namesakes apart. */
  topBooks: z.array(z.string()),
  /** Which catalogue the hit came from. */
  source: z.enum(['audible', 'audnexus', 'openlibrary']),
  /** Set when the author is already in the library. */
  authorId: z.number().int().nullish(),
});
export type AuthorSearchResult = z.infer<typeof AuthorSearchResult>;

export const AuthorSearchResponse = z.array(AuthorSearchResult);
export type AuthorSearchResponse = z.infer<typeof AuthorSearchResponse>;

/** Book search: free text, or title/author, or an exact ASIN/ISBN. */
export const BookLookupQuery = z
  .object({
    term: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1).optional(),
    author: z.string().trim().min(1).optional(),
    asin: Asin.optional(),
    isbn: Isbn.optional(),
    region: AudibleRegion.optional(),
  })
  .refine((q) => q.term !== undefined || q.title !== undefined || q.asin !== undefined || q.isbn !== undefined, {
    message: 'term, title, asin or isbn is required',
  });
export type BookLookupQuery = z.infer<typeof BookLookupQuery>;

export const BookSearchResult = z.object({
  asin: z.string().nullish(),
  isbn13: z.string().nullish(),
  olWorkId: z.string().nullish(),
  region: AudibleRegion.nullish(),
  title: z.string(),
  subtitle: z.string().nullish(),
  authors: z.array(BookAuthorCredit),
  narrators: z.array(z.string()),
  publisher: z.string().nullish(),
  language: z.string().nullish(),
  releaseDate: z.string().nullish(),
  year: z.number().int().nullish(),
  runtimeMinutes: z.number().int().nullish(),
  formatType: BookFormatType.nullish(),
  series: z.array(z.object({ name: z.string(), asin: z.string().nullish(), position: z.string().nullish() })),
  images: z.array(AudiobookImage),
  source: z.enum(['audible', 'audnexus', 'openlibrary']),
  /** Set when the book is already in the library. */
  bookId: z.number().int().nullish(),
  /** Set when its primary author is in the library. */
  authorId: z.number().int().nullish(),
});
export type BookSearchResult = z.infer<typeof BookSearchResult>;

export const BookSearchResponse = z.array(BookSearchResult);
export type BookSearchResponse = z.infer<typeof BookSearchResponse>;

// ---------------------------------------------------------------------------------------
// Settings: audiobookMetadata
// ---------------------------------------------------------------------------------------

export const AUDNEXUS_DEFAULT_BASE_URL = 'https://api.audnex.us/';

const rate = () => z.number().min(0.1).max(20);

/**
 * Stored form of the `audiobookMetadata` section; also the GET body of
 * /settings/audiobookmetadata (it holds no secrets). Rate limits are requests per second per
 * provider; every client honours 429 / Retry-After on top.
 */
export const AudiobookMetadataSettings = z.object({
  /** Marketplace for catalogue search, bibliographies and Audnexus lookups. */
  audibleRegion: AudibleRegion.default('us'),
  audnexusBaseUrl: z.string().url().default(AUDNEXUS_DEFAULT_BASE_URL),
  /** Fill gaps (authors or books Audible does not list) from OpenLibrary. */
  openLibraryFallback: z.boolean().default(true),
  /**
   * Book languages to keep when an author's bibliography is loaded, as the catalogue names them
   * (lower-case, e.g. `english`, `german`). Empty keeps every language.
   */
  languages: z.array(z.string().trim().min(1).toLowerCase()).default([]),
  audnexusRateLimitPerSecond: rate().default(1),
  audibleRateLimitPerSecond: rate().default(2),
  openLibraryRateLimitPerSecond: rate().default(1),
});
export type AudiobookMetadataSettings = z.infer<typeof AudiobookMetadataSettings>;
export type AudiobookMetadataSettingsInput = z.input<typeof AudiobookMetadataSettings>;

/** GET /api/v1/settings/audiobookmetadata. */
export const AudiobookMetadataSettingsResponse = AudiobookMetadataSettings;
export type AudiobookMetadataSettingsResponse = z.infer<typeof AudiobookMetadataSettingsResponse>;

/** PUT /api/v1/settings/audiobookmetadata: omitted fields keep their stored value. */
export const AudiobookMetadataSettingsUpdate = z.object({
  audibleRegion: AudibleRegion.optional(),
  audnexusBaseUrl: z.string().url().optional(),
  openLibraryFallback: z.boolean().optional(),
  languages: z.array(z.string().trim().min(1).toLowerCase()).optional(),
  audnexusRateLimitPerSecond: rate().optional(),
  audibleRateLimitPerSecond: rate().optional(),
  openLibraryRateLimitPerSecond: rate().optional(),
});
export type AudiobookMetadataSettingsUpdate = z.infer<typeof AudiobookMetadataSettingsUpdate>;

/** Merge a client update onto the stored section. */
export function applyAudiobookMetadataUpdate(
  current: AudiobookMetadataSettings,
  update: AudiobookMetadataSettingsUpdate,
): AudiobookMetadataSettings {
  return {
    audibleRegion: update.audibleRegion ?? current.audibleRegion,
    audnexusBaseUrl: update.audnexusBaseUrl ?? current.audnexusBaseUrl,
    openLibraryFallback: update.openLibraryFallback ?? current.openLibraryFallback,
    languages: update.languages ?? current.languages,
    audnexusRateLimitPerSecond: update.audnexusRateLimitPerSecond ?? current.audnexusRateLimitPerSecond,
    audibleRateLimitPerSecond: update.audibleRateLimitPerSecond ?? current.audibleRateLimitPerSecond,
    openLibraryRateLimitPerSecond: update.openLibraryRateLimitPerSecond ?? current.openLibraryRateLimitPerSecond,
  };
}

// Public API of the book and comic catalogue: the BookCatalog, its source clients and the
// pure merge helpers.

export {
  BOOK_CACHE_PROVIDERS,
  BOOK_CATALOG_DEFAULT_TTLS,
  createBookCatalog,
  type BookCatalogDeps,
  type BookCatalogTtls,
} from './catalog.js';
export {
  GOOGLE_BOOKS_DEFAULT_BASE_URL,
  GOOGLE_BOOKS_PROVIDER,
  bookFromGoogleVolume,
  createGoogleBooksClient,
  googleBooksQueryString,
  type GoogleBooksClient,
  type GoogleBooksClientOptions,
  type GoogleBooksPage,
  type GoogleBooksQuery,
  type GoogleBooksSearchOptions,
} from './google-books.js';
export {
  HARDCOVER_DEFAULT_URL,
  HARDCOVER_PROVIDER,
  HARDCOVER_QUERIES,
  authorFromHardcover,
  authorFromHardcoverSearchDoc,
  bookFromHardcover,
  bookFromHardcoverSearchDoc,
  createHardcoverClient,
  hardcoverAuthorization,
  type HardcoverAuthorWithBooks,
  type HardcoverClient,
  type HardcoverClientOptions,
  type HardcoverSearchOptions,
} from './hardcover.js';
export {
  COMICVINE_DEFAULT_BASE_URL,
  COMICVINE_PROVIDER,
  comicIssueFromComicVine,
  comicSeriesFromComicVine,
  createComicVineClient,
  type ComicVineClient,
  type ComicVineClientOptions,
  type ComicVineVolume,
} from './comicvine.js';
export {
  METRON_DEFAULT_BASE_URL,
  METRON_PROVIDER,
  comicIssueFromMetron,
  comicSeriesFromMetron,
  createMetronClient,
  metronAuthorization,
  type MetronClient,
  type MetronClientOptions,
} from './metron.js';
export {
  authorFromOpenLibrary,
  authorFromOpenLibrarySearch,
  bookFromOpenLibraryEdition,
  bookFromOpenLibrarySearchDoc,
  bookFromOpenLibraryWork,
  type OpenLibraryAuthorRef,
} from './map-openlibrary.js';
export {
  bookEarliestDate,
  bookHasAuthor,
  comicIssueNumberKey,
  filterBooksByLanguage,
  groupBookRecords,
  mergeAuthorRecords,
  mergeBookGroup,
  mergeBookRecords,
  mergeComicIssues,
  mergeComicSeries,
} from './merge.js';
export { bookLanguageCode, bookTitleKey, parseSeriesString as parseBookSeriesString } from './util.js';
export type * from './types.js';

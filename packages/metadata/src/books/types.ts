// Book and comic catalogue records (docs/books.md "Metadata"). Every source maps into these
// shapes; the catalog merges records of several sources into one. Keys are prefixed by source
// so they stay unique across catalogues:
//
//   authors: `ol:OL23919A`, `hc:<hardcover id>`, `gb-author:<name>` (Google Books has no author ids)
//   books:   `isbn:<isbn13>` (preferred), `ol:OL82563W`, `gb:<volume id>`, `hc:<hardcover id>`
//   comics:  `cv:<volume id>` / `cv-issue:<issue id>`, `metron:<series id>` / `metron-issue:<issue id>`

export type BookSourceName = 'openLibrary' | 'googleBooks' | 'hardcover' | 'comicVine' | 'metron';

/** How one source answered: live, fresh cache, expired cache (source failing), failed, or switched off. */
export type BookSourceState = 'ok' | 'cached' | 'stale' | 'failed' | 'disabled';

export interface BookSourceStatus {
  source: BookSourceName;
  state: BookSourceState;
  message?: string;
}

/** A catalogue answer plus how each source took part. */
export interface CatalogResult<T> {
  value: T;
  sources: BookSourceStatus[];
}

export interface BookSeriesRef {
  name: string;
  /** As the catalogue writes it: `3`, `2.5`, `1-3`; undefined when unnumbered. */
  position?: string;
}

export interface BookAuthorRecord {
  /** Best key (`ol:` first, then `hc:`, then `gb-author:`). */
  key: string;
  /** Every key the merged record is known by. */
  keys: string[];
  name: string;
  overview?: string;
  imageUrl?: string;
  /** A well-known title, for disambiguating search results. */
  topWork?: string;
  workCount?: number;
  olAuthorId?: string;
  hardcoverId?: string;
  sources: BookSourceName[];
}

export interface BookRecord {
  /** Best key (`isbn:` first, then `ol:`, `hc:`, `gb:`). */
  key: string;
  keys: string[];
  title: string;
  subtitle?: string;
  authors: Array<{ name: string; key?: string }>;
  isbn13?: string;
  /** Other ISBN-13s of the work's editions (release matching, de-duplication). */
  isbns: string[];
  olWorkId?: string;
  googleVolumeId?: string;
  hardcoverId?: string;
  publisher?: string;
  /** ISO 639-1 where known (`en`). */
  language?: string;
  /** `YYYY-MM-DD`, `YYYY-MM` or `YYYY`. */
  releaseDate?: string;
  pageCount?: number;
  overview?: string;
  genres: string[];
  coverUrl?: string;
  /** 0–5. */
  rating?: number;
  series: BookSeriesRef[];
  sources: BookSourceName[];
}

export interface AuthorWithBooks {
  author: BookAuthorRecord;
  books: BookRecord[];
}

export interface ComicSeriesRecord {
  /** `cv:` first, then `metron:`. */
  key: string;
  keys: string[];
  title: string;
  publisher?: string;
  startYear?: number;
  issueCount?: number;
  overview?: string;
  coverUrl?: string;
  comicVineId?: string;
  metronId?: string;
  /** Metron knows; ComicVine does not (undefined). */
  status?: 'continuing' | 'ended';
  sources: BookSourceName[];
}

export interface ComicIssueRecord {
  key: string;
  keys: string[];
  /** As published (`1`, `12.1`, `Annual 1`). */
  issueNumber: string;
  title?: string;
  /** `YYYY-MM-DD`. */
  coverDate?: string;
  storeDate?: string;
  overview?: string;
  coverUrl?: string;
  comicVineId?: string;
  metronId?: string;
  sources: BookSourceName[];
}

export interface ComicSeriesWithIssues {
  series: ComicSeriesRecord;
  issues: ComicIssueRecord[];
}

/**
 * Persistent cache the catalog reads and writes (the API passes its `metadata_cache` table).
 * `get` with `allowStale` returns expired entries too: that is how an outage is ridden out.
 */
export interface BookCatalogCache {
  get<T>(provider: string, key: string, opts?: { allowStale?: boolean }): { body: T; expiresAt: string } | undefined;
  set(provider: string, key: string, body: unknown, ttlMs: number): void;
}

/** Credentials and switches per source (from the `books.metadata` settings). */
export interface BookCatalogConfig {
  openLibrary: boolean;
  googleBooks: boolean;
  googleBooksApiKey?: string;
  hardcover: boolean;
  hardcoverApiKey?: string;
  comicVine: boolean;
  comicVineApiKey?: string;
  metron: boolean;
  metronUsername?: string;
  metronPassword?: string;
  /** Keep books in these languages (`en`, `eng`, `english` all work); empty keeps all. */
  languages: readonly string[];
}

export interface BookCatalog {
  searchAuthors(term: string): Promise<CatalogResult<BookAuthorRecord[]>>;
  searchBooks(term: string): Promise<CatalogResult<BookRecord[]>>;
  /** The author and their books, merged across sources. Throws `not-found` when no source knows the key. */
  getAuthorWithBooks(key: string, opts?: { name?: string; fresh?: boolean }): Promise<CatalogResult<AuthorWithBooks>>;
  /** One book by key (`isbn:`, `ol:`, `gb:`, `hc:`). Throws `not-found` when no source knows it. */
  getBook(key: string, opts?: { fresh?: boolean }): Promise<CatalogResult<BookRecord>>;
  searchComicSeries(term: string): Promise<CatalogResult<ComicSeriesRecord[]>>;
  /** The series and its issues (`cv:` or `metron:`), merged by issue number when both sources know it. */
  getComicSeries(key: string, opts?: { fresh?: boolean }): Promise<CatalogResult<ComicSeriesWithIssues>>;
}

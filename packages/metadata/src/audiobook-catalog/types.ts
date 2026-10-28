// Unified audiobook catalog types: one shape for books and authors whichever source (Audible
// catalog, Audnexus, OpenLibrary) they came from. Dates are `YYYY-MM-DD` (OpenLibrary may give
// only `YYYY`), runtimes minutes, languages lower-case English names ("english").

import type { AudibleRegion } from '../audible/regions.js';
import type { AnxChapters, AudiobookFormatType } from '../audnexus/types.js';

export type CatalogSource = 'audible' | 'audnexus' | 'openlibrary';

export interface CatalogPersonRef {
  name: string;
  /** Audible author ASIN. */
  asin?: string;
  /** OpenLibrary author id ("OL7234434A"). */
  olid?: string;
}

export interface CatalogSeriesRef {
  name: string;
  asin?: string;
  /** As printed: "3", "1.5", "1-6". */
  position?: string;
  positionNumber?: number;
}

export interface CatalogImages {
  /** Largest cover available. */
  cover?: string;
  /** A smaller rendition when the source offers one. */
  thumbnail?: string;
}

export interface CatalogBook {
  asin?: string;
  /** Preferred ISBN (the audiobook's own when Audnexus has it). */
  isbn?: string;
  /** Every ISBN known for the book; used for matching. */
  isbns: string[];
  /** OpenLibrary work id ("OL21745884W"). */
  olWorkId?: string;
  /** OpenLibrary edition id ("OL30036715M"). */
  olEditionId?: string;
  title: string;
  subtitle?: string;
  authors: CatalogPersonRef[];
  narrators: string[];
  series: CatalogSeriesRef[];
  runtimeMinutes?: number;
  formatType?: AudiobookFormatType;
  language?: string;
  releaseDate?: string;
  publisher?: string;
  overview?: string;
  genres: string[];
  images: CatalogImages;
  /** Average rating 0–5. */
  rating?: number;
  isAdult?: boolean;
  /** Audible marketplace the record came from. */
  region?: AudibleRegion;
  /** Every source that contributed, most authoritative first. */
  sources: CatalogSource[];
}

export interface CatalogAuthor {
  name: string;
  asin?: string;
  olid?: string;
  description?: string;
  image?: string;
  genres: string[];
  similar: CatalogPersonRef[];
  birthDate?: string;
  deathDate?: string;
  region?: AudibleRegion;
  sources: CatalogSource[];
}

export interface CatalogSeriesEntry {
  position?: string;
  positionNumber?: number;
  book: CatalogBook;
}

export interface CatalogSeries {
  name: string;
  asin?: string;
  /** Ordered by position (unnumbered last), then release date. */
  books: CatalogSeriesEntry[];
}

export interface CatalogAuthorWithBooks {
  author: CatalogAuthor;
  books: CatalogBook[];
  series: CatalogSeries[];
}

export type CatalogChapters = AnxChapters;

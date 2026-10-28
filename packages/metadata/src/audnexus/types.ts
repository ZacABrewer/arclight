// Clean Audnexus output types. The wire format never leaks past ./map.ts. Dates are
// `YYYY-MM-DD`, runtimes minutes, chapter offsets milliseconds, languages lower-case English
// names ("english").

import type { AudibleRegion } from '../audible/regions.js';

export interface AnxPersonRef {
  /** Audible author ASIN; narrators usually have none. */
  asin?: string;
  name: string;
}

export interface AnxGenre {
  /** Audible category id. */
  asin?: string;
  name: string;
  /** "genre" (top level) or "tag". */
  type: 'genre' | 'tag';
}

export interface AnxSeriesRef {
  asin?: string;
  name: string;
  /** As printed: "3", "1.5", "1-6". */
  position?: string;
  /** `position` when it is a plain number. */
  positionNumber?: number;
}

export type AudiobookFormatType = 'unabridged' | 'abridged';

export interface AnxBook {
  asin: string;
  region: AudibleRegion;
  title: string;
  subtitle?: string;
  authors: AnxPersonRef[];
  narrators: string[];
  /** Plain-text summary (the HTML one, stripped), else the short description. */
  overview?: string;
  /** Short teaser. */
  description?: string;
  /** Raw HTML summary. */
  summaryHtml?: string;
  runtimeMinutes?: number;
  formatType?: AudiobookFormatType;
  /** "fiction" / "nonfiction". */
  literatureType?: string;
  seriesPrimary?: AnxSeriesRef;
  seriesSecondary?: AnxSeriesRef;
  genres: AnxGenre[];
  image?: string;
  releaseDate?: string;
  copyrightYear?: number;
  publisher?: string;
  language?: string;
  isbn?: string;
  /** Average listener rating 0–5. */
  rating?: number;
  isAdult: boolean;
}

export interface AnxChapter {
  /** 1-based. */
  index: number;
  title: string;
  startMs: number;
  lengthMs: number;
}

export interface AnxChapters {
  asin: string;
  region: AudibleRegion;
  runtimeMs?: number;
  /** Audible marks chapter lists it believes are exact. */
  accurate: boolean;
  brandIntroMs: number;
  brandOutroMs: number;
  chapters: AnxChapter[];
}

export interface AnxAuthor {
  asin: string;
  region: AudibleRegion;
  name: string;
  description?: string;
  image?: string;
  genres: AnxGenre[];
  similar: AnxPersonRef[];
}

export interface AnxAuthorSearchResult {
  asin: string;
  name: string;
}

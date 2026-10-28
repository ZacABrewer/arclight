// Clean Audible catalog output types. The wire format never leaks past ./map.ts.

import type { AudiobookFormatType } from '../audnexus/types.js';
import type { AudibleRegion } from './regions.js';

export interface AudiblePersonRef {
  asin?: string;
  name: string;
}

export interface AudibleSeriesRef {
  asin?: string;
  name: string;
  /** As printed: "3", "1.5", "1-6". */
  position?: string;
  positionNumber?: number;
}

export interface AudibleProduct {
  asin: string;
  region: AudibleRegion;
  title: string;
  subtitle?: string;
  authors: AudiblePersonRef[];
  narrators: string[];
  series: AudibleSeriesRef[];
  /** Plain-text summary. */
  overview?: string;
  runtimeMinutes?: number;
  formatType?: AudiobookFormatType;
  /** "SinglePartBook", "MultiPartBook", "PodcastEpisode", ... */
  deliveryType?: string;
  /** "Product", "Podcast", ... */
  contentType?: string;
  language?: string;
  /** `YYYY-MM-DD`. */
  releaseDate?: string;
  publisher?: string;
  /** Category names from the genre ladders, broadest first, de-duplicated. */
  genres: string[];
  /** Largest product image. */
  image?: string;
  /** Every image Audible sent, keyed by pixel size ("500", "1024"). */
  images: Record<string, string>;
  rating?: { average: number; count: number };
  isAdult: boolean;
}

export interface AudiblePage<T> {
  /** Total matches Audible reports (it includes products it then does not return). */
  total: number;
  /** 1-based. */
  page: number;
  pageSize: number;
  results: T[];
}

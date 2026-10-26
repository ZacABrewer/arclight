import type { QualityDefinition, Revision } from '@arclight/shared';

// What the parser extracts from a release name or file name. Series and movie parsing
// share the quality/language/group layers; the title layer is per media type.

export interface ParsedQuality {
  quality: QualityDefinition;
  revision: Revision;
  /** 'name' when derived from the title, 'extension' when only the file extension told us. */
  detectionSource: 'name' | 'extension' | 'unknown';
}

export interface ParsedSeriesInfo {
  /** Series title as written in the release, with separators normalized to spaces. */
  title: string;
  /** Title with year/country/suffix info split out. */
  titleInfo: SeriesTitleInfo;
  seasons: number[];
  episodes: number[];
  absoluteEpisodes: number[];
  /** Daily shows: the air date as YYYY-MM-DD. */
  airDate: string | null;
  fullSeason: boolean;
  isPartialSeason: boolean;
  isMultiSeason: boolean;
  isSeasonExtra: boolean;
  isSplitEpisode: boolean;
  isMiniSeries: boolean;
  /** Season N Part M packs. */
  seasonPart: number;
  special: boolean;
  /** Anime: release version (v2, v3…). */
  releaseVersion: number;
  /** Anime: the [SubGroup] prefix. */
  subGroup: string | null;
}

export interface SeriesTitleInfo {
  title: string;
  titleWithoutYear: string;
  year: number;
  /** Country/variant suffix like "US", "UK", "AU" when present. */
  country: string | null;
}

export interface ParsedMovieInfo {
  title: string;
  /** Primary title with no year or edition. */
  titleWithoutYear: string;
  year: number;
  edition: string | null;
  imdbId: string | null;
  tmdbId: number | null;
}

export interface ParsedRelease {
  /** Release name after basic cleanup (extension stripped, website prefixes removed). */
  releaseTitle: string;
  quality: ParsedQuality;
  languages: string[];
  releaseGroup: string | null;
  releaseHash: string | null;
  /** Series interpretation, when the title has season/episode/date structure. */
  series: ParsedSeriesInfo | null;
  /** Movie interpretation, when the title looks like a movie (title + year, no episode structure). */
  movie: ParsedMovieInfo | null;
}

export type MediaTypeHint = 'series' | 'movie' | 'auto';

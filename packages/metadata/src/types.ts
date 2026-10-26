// Normalized metadata domain objects. Everything the rest of Media-Tron sees from the
// metadata package is one of these shapes; the TMDB wire format never leaks past
// `src/tmdb/map.ts`. Dates are ISO-8601 strings (YYYY-MM-DD), image URLs are absolute.

export type SeriesStatus = 'continuing' | 'ended' | 'upcoming' | 'unknown';

export type MovieStatus = 'announced' | 'inCinemas' | 'released' | 'unknown';

export interface Rating {
  value: number;
  votes: number;
}

export interface Ratings {
  tmdb: Rating;
}

export interface ImageSet {
  poster?: string;
  backdrop?: string;
  logo?: string;
}

export interface AlternateTitle {
  title: string;
  /** ISO-3166-1 country the title is used in, when TMDB knows it. */
  country?: string;
}

export interface SeasonSummary {
  seasonNumber: number;
  episodeCount: number;
  name?: string;
  overview?: string;
  poster?: string;
}

export interface SeriesMetadata {
  tmdbId: number;
  tvdbId?: number;
  imdbId?: string;
  title: string;
  originalTitle: string;
  sortTitle: string;
  year?: number;
  overview: string;
  status: SeriesStatus;
  network?: string;
  runtimeMinutes?: number;
  genres: string[];
  firstAired?: string;
  lastAired?: string;
  images: ImageSet;
  ratings: Ratings;
  certification?: string;
  originalLanguage: string;
  seasons: SeasonSummary[];
  alternateTitles: AlternateTitle[];
}

export interface EpisodeMetadata {
  tmdbId: number;
  seasonNumber: number;
  episodeNumber: number;
  /** TMDB does not publish absolute numbering; reserved for other sources. */
  absoluteEpisodeNumber?: number;
  title: string;
  overview: string;
  airDate?: string;
  runtimeMinutes?: number;
  still?: string;
  ratings: Ratings;
}

export interface MovieCollectionRef {
  tmdbId: number;
  name: string;
}

export interface MovieMetadata {
  tmdbId: number;
  imdbId?: string;
  title: string;
  originalTitle: string;
  sortTitle: string;
  year?: number;
  overview: string;
  status: MovieStatus;
  inCinemas?: string;
  digitalRelease?: string;
  physicalRelease?: string;
  runtimeMinutes?: number;
  genres: string[];
  studio?: string;
  images: ImageSet;
  ratings: Ratings;
  certification?: string;
  originalLanguage: string;
  collection?: MovieCollectionRef;
  alternateTitles: AlternateTitle[];
  youtubeTrailerId?: string;
}

interface SearchResultBase {
  tmdbId: number;
  title: string;
  originalTitle: string;
  year?: number;
  overview: string;
  originalLanguage: string;
  popularity?: number;
  images: ImageSet;
  ratings: Ratings;
}

export interface SeriesSearchResult extends SearchResultBase {
  mediaType: 'series';
  firstAired?: string;
}

export interface MovieSearchResult extends SearchResultBase {
  mediaType: 'movie';
  releaseDate?: string;
}

export type SearchResult = SeriesSearchResult | MovieSearchResult;

export interface Genre {
  tmdbId: number;
  name: string;
}

export type MetadataErrorCode =
  | 'not-found'
  | 'rate-limited'
  | 'unreachable'
  | 'bad-response'
  | 'unauthorized';

export class MetadataError extends Error {
  readonly code: MetadataErrorCode;
  readonly httpStatus?: number;

  constructor(
    code: MetadataErrorCode,
    message: string,
    options: { httpStatus?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'MetadataError';
    this.code = code;
    if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus;
  }
}

export function isMetadataError(err: unknown, code?: MetadataErrorCode): err is MetadataError {
  return err instanceof MetadataError && (code === undefined || err.code === code);
}

// ---------------------------------------------------------------------------
// Discover / title-page extras (Phase 4)

export interface CreditPerson {
  tmdbId: number;
  name: string;
  /** Cast only. */
  character?: string;
  /** Crew only. */
  job?: string;
  department?: string;
  profile?: string;
}

export interface VideoRef {
  name: string;
  key: string;
  site: string;
  type: string;
}

export interface CompanyRef {
  tmdbId: number;
  name: string;
  logo?: string;
}

export interface Keyword {
  tmdbId: number;
  name: string;
}

/** Everything a title page needs beyond the core metadata. */
export interface TitleExtras {
  tmdbId: number;
  mediaType: 'movie' | 'series';
  tagline?: string;
  genres: Genre[];
  keywords: Keyword[];
  /** Production companies (movies) or networks (series). */
  companies: CompanyRef[];
  cast: CreditPerson[];
  crew: CreditPerson[];
  videos: VideoRef[];
  similar: SearchResult[];
  recommendations: SearchResult[];
}

export type PersonCredit = SearchResult & { character?: string; job?: string };

export interface PersonMetadata {
  tmdbId: number;
  name: string;
  biography: string;
  birthday?: string;
  deathday?: string;
  placeOfBirth?: string;
  knownForDepartment?: string;
  profile?: string;
  cast: PersonCredit[];
  crew: PersonCredit[];
}

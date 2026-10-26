// Public API of @media-tron/metadata.

export {
  createTmdbClient,
  parseRetryAfter,
  type DiscoverOptions,
  type FetchLike,
  type MediaKind,
  type PagedResults,
  type SearchOptions,
  type TmdbClient,
  type TmdbClientOptions,
  type TrendingWindow,
} from './tmdb/client.js';

export {
  createImageUrlBuilder,
  deriveMovieStatus,
  mapMovie,
  mapSeason,
  mapSeries,
  mapSeriesStatus,
  pickReleaseDates,
  type ImageKind,
  type ImageUrlBuilder,
  type MovieReleaseDates,
} from './tmdb/map.js';

export { type TmdbConfiguration } from './tmdb/schemas.js';

export { mapCredits, mapMovieExtras, mapPerson, mapTvExtras, mapVideos } from './tmdb/extras.js';

export { cleanTitle, sortTitle } from './title.js';

export {
  MetadataError,
  isMetadataError,
  type AlternateTitle,
  type CompanyRef,
  type CreditPerson,
  type Keyword,
  type PersonCredit,
  type PersonMetadata,
  type TitleExtras,
  type VideoRef,
  type EpisodeMetadata,
  type Genre,
  type ImageSet,
  type MetadataErrorCode,
  type MovieCollectionRef,
  type MovieMetadata,
  type MovieSearchResult,
  type MovieStatus,
  type Rating,
  type Ratings,
  type SearchResult,
  type SeasonSummary,
  type SeriesMetadata,
  type SeriesSearchResult,
  type SeriesStatus,
} from './types.js';

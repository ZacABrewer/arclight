// Public API of @arclight/metadata.

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
  type CertificationRef,
  type CollectionMetadata,
  type LanguageRef,
  type PersonSearchResult,
  type TmdbListName,
  type WatchProviderRef,
  type WatchRegion,
} from './types.js';

// ---------------------------------------------------------------------------
// Music: rate limiting, MusicBrainz, Cover Art Archive, Wikidata/Commons, Fanart.tv

export {
  RateLimiter,
  computeBackoffMs,
  defaultRateLimiter,
  isThrottleStatus,
  systemClock,
  type AcquireOptions,
  type Clock,
  type ProviderLimit,
  type RateLimiterOptions,
  type RequestPriority,
  type ScheduleOptions,
} from './rate-limit.js';

export { type RequestOptions } from './http.js';

export * from './musicbrainz/index.js';

export {
  COVER_ART_ARCHIVE_BASE_URL,
  COVER_ART_SIZES,
  coverArtReleaseFrontUrl,
  coverArtReleaseGroupFrontUrl,
  createCoverArtUrlBuilder,
  type CoverArtSize,
  type CoverArtUrlBuilder,
  type CoverArtUrls,
} from './coverart/index.js';

export {
  COMMONS_BASE_URL,
  WIKIDATA_DEFAULT_API_URL,
  WIKIDATA_PROVIDER,
  commonsFilePageUrl,
  commonsThumbnailUrl,
  createWikidataClient,
  findWikidataId,
  wikidataIdFromUrl,
  type ArtistImage,
  type ResolveImageOptions,
  type WikidataClient,
  type WikidataClientOptions,
} from './wikidata/index.js';

export {
  FANART_DEFAULT_BASE_URL,
  FANART_PROVIDER,
  createFanartClient,
  type FanartAlbumImages,
  type FanartArtistImages,
  type FanartClient,
  type FanartClientOptions,
  type FanartImage,
} from './fanart/index.js';

// ---------------------------------------------------------------------------
// Audiobooks: Audnexus, Audible catalog (unofficial), OpenLibrary, and the combined catalog

export * from './audnexus/index.js';
export * from './audible/index.js';
export * from './openlibrary/index.js';
export * from './audiobook-catalog/index.js';
export { normalizeIsbn, toIsbn13 } from './audiobook-util.js';

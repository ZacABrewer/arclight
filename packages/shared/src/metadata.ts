import { z } from 'zod';

// Metadata lookup contract: normalized results from the metadata source (TMDB), served by
// /api/v1/metadata/*. These mirror the `@arclight/metadata` domain objects; they are what
// the add-series / add-movie screens show before anything is in the library. Prefixed
// `Metadata*` so they never clash with the library's own Series/Movie shapes.

export const MetadataRating = z.object({ value: z.number(), votes: z.number() });
export type MetadataRating = z.infer<typeof MetadataRating>;

export const MetadataRatings = z.object({ tmdb: MetadataRating });
export type MetadataRatings = z.infer<typeof MetadataRatings>;

export const MetadataImageSet = z.object({
  poster: z.string().optional(),
  backdrop: z.string().optional(),
  logo: z.string().optional(),
});
export type MetadataImageSet = z.infer<typeof MetadataImageSet>;

export const MetadataAlternateTitle = z.object({ title: z.string(), country: z.string().optional() });
export type MetadataAlternateTitle = z.infer<typeof MetadataAlternateTitle>;

export const MetadataSeriesStatus = z.enum(['continuing', 'ended', 'upcoming', 'unknown']);
export type MetadataSeriesStatus = z.infer<typeof MetadataSeriesStatus>;

export const MetadataMovieStatus = z.enum(['announced', 'inCinemas', 'released', 'unknown']);
export type MetadataMovieStatus = z.infer<typeof MetadataMovieStatus>;

export const MetadataSeasonSummary = z.object({
  seasonNumber: z.number().int(),
  episodeCount: z.number().int(),
  name: z.string().optional(),
  overview: z.string().optional(),
  poster: z.string().optional(),
});
export type MetadataSeasonSummary = z.infer<typeof MetadataSeasonSummary>;

export const MetadataSeries = z.object({
  tmdbId: z.number().int(),
  tvdbId: z.number().int().optional(),
  imdbId: z.string().optional(),
  title: z.string(),
  originalTitle: z.string(),
  sortTitle: z.string(),
  year: z.number().int().optional(),
  overview: z.string(),
  status: MetadataSeriesStatus,
  network: z.string().optional(),
  runtimeMinutes: z.number().optional(),
  genres: z.array(z.string()),
  firstAired: z.string().optional(),
  lastAired: z.string().optional(),
  images: MetadataImageSet,
  ratings: MetadataRatings,
  certification: z.string().optional(),
  originalLanguage: z.string(),
  seasons: z.array(MetadataSeasonSummary),
  alternateTitles: z.array(MetadataAlternateTitle),
});
export type MetadataSeries = z.infer<typeof MetadataSeries>;

export const MetadataMovie = z.object({
  tmdbId: z.number().int(),
  imdbId: z.string().optional(),
  title: z.string(),
  originalTitle: z.string(),
  sortTitle: z.string(),
  year: z.number().int().optional(),
  overview: z.string(),
  status: MetadataMovieStatus,
  inCinemas: z.string().optional(),
  digitalRelease: z.string().optional(),
  physicalRelease: z.string().optional(),
  runtimeMinutes: z.number().optional(),
  genres: z.array(z.string()),
  studio: z.string().optional(),
  images: MetadataImageSet,
  ratings: MetadataRatings,
  certification: z.string().optional(),
  originalLanguage: z.string(),
  collection: z.object({ tmdbId: z.number().int(), name: z.string() }).optional(),
  alternateTitles: z.array(MetadataAlternateTitle),
  youtubeTrailerId: z.string().optional(),
});
export type MetadataMovie = z.infer<typeof MetadataMovie>;

const SearchResultBase = z.object({
  tmdbId: z.number().int(),
  title: z.string(),
  originalTitle: z.string(),
  year: z.number().int().optional(),
  overview: z.string(),
  originalLanguage: z.string(),
  popularity: z.number().optional(),
  images: MetadataImageSet,
  ratings: MetadataRatings,
});

export const MetadataSearchResult = z.discriminatedUnion('mediaType', [
  SearchResultBase.extend({ mediaType: z.literal('series'), firstAired: z.string().optional() }),
  SearchResultBase.extend({ mediaType: z.literal('movie'), releaseDate: z.string().optional() }),
]);
export type MetadataSearchResult = z.infer<typeof MetadataSearchResult>;

export const MetadataSearchType = z.enum(['series', 'movie', 'all']);
export type MetadataSearchType = z.infer<typeof MetadataSearchType>;

export const MetadataSearchQuery = z.object({
  query: z.string().trim().min(1),
  type: MetadataSearchType.default('all'),
});
export type MetadataSearchQuery = z.infer<typeof MetadataSearchQuery>;

export const MetadataErrorResponse = z.object({ error: z.string(), code: z.string().optional() });
export type MetadataErrorResponse = z.infer<typeof MetadataErrorResponse>;

/** One movie of a TMDB collection (GET /metadata/collection/:tmdbId). */
export const MetadataCollectionPart = z.object({
  tmdbId: z.number().int(),
  title: z.string(),
  year: z.number().int().optional(),
  releaseDate: z.string().optional(),
  overview: z.string(),
  images: MetadataImageSet,
  originalLanguage: z.string(),
});
export type MetadataCollectionPart = z.infer<typeof MetadataCollectionPart>;

export const MetadataCollection = z.object({
  tmdbId: z.number().int(),
  name: z.string(),
  overview: z.string(),
  images: MetadataImageSet,
  /** Ordered by release date (undated last). */
  parts: z.array(MetadataCollectionPart),
});
export type MetadataCollection = z.infer<typeof MetadataCollection>;

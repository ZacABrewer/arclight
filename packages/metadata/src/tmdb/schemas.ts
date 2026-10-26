// Loose Zod schemas for the TMDB v3 payloads we consume. Every object is `.loose()` so
// unknown fields pass through; only the fields the mapper reads are declared, and
// almost all of them are optional/nullable because TMDB omits or nulls freely.

import { z } from 'zod';

const nullableString = z.string().nullable().optional();
const nullableNumber = z.number().nullable().optional();

export const tmdbConfigurationSchema = z
  .object({
    images: z
      .object({
        base_url: z.string().optional(),
        secure_base_url: z.string(),
        poster_sizes: z.array(z.string()).default([]),
        backdrop_sizes: z.array(z.string()).default([]),
        still_sizes: z.array(z.string()).default([]),
        logo_sizes: z.array(z.string()).default([]),
        profile_sizes: z.array(z.string()).default([]),
      })
      .loose(),
  })
  .loose();
export type TmdbConfiguration = z.infer<typeof tmdbConfigurationSchema>;

export const tmdbGenreSchema = z.object({ id: z.number(), name: z.string() }).loose();

export const tmdbGenreListSchema = z.object({ genres: z.array(tmdbGenreSchema) }).loose();

export const tmdbExternalIdsSchema = z
  .object({
    imdb_id: nullableString,
    tvdb_id: nullableNumber,
  })
  .loose();

export const tmdbImageSchema = z
  .object({
    file_path: z.string(),
    iso_639_1: nullableString,
    vote_average: nullableNumber,
    width: nullableNumber,
  })
  .loose();

export const tmdbImagesSchema = z
  .object({
    posters: z.array(tmdbImageSchema).optional(),
    backdrops: z.array(tmdbImageSchema).optional(),
    logos: z.array(tmdbImageSchema).optional(),
  })
  .loose();

export const tmdbVideoSchema = z
  .object({
    key: z.string(),
    site: z.string(),
    type: z.string().optional(),
    official: z.boolean().optional(),
    iso_639_1: nullableString,
  })
  .loose();

export const tmdbTvSearchItemSchema = z
  .object({
    id: z.number(),
    name: z.string().default(''),
    original_name: z.string().optional(),
    overview: nullableString,
    first_air_date: nullableString,
    poster_path: nullableString,
    backdrop_path: nullableString,
    original_language: z.string().optional(),
    popularity: nullableNumber,
    vote_average: nullableNumber,
    vote_count: nullableNumber,
    media_type: z.literal('tv').optional(),
  })
  .loose();

export const tmdbMovieSearchItemSchema = z
  .object({
    id: z.number(),
    title: z.string().default(''),
    original_title: z.string().optional(),
    overview: nullableString,
    release_date: nullableString,
    poster_path: nullableString,
    backdrop_path: nullableString,
    original_language: z.string().optional(),
    popularity: nullableNumber,
    vote_average: nullableNumber,
    vote_count: nullableNumber,
    media_type: z.literal('movie').optional(),
  })
  .loose();

const pagedSchema = z
  .object({
    page: z.number().optional(),
    total_pages: z.number().optional(),
    total_results: z.number().optional(),
  })
  .loose();

export const tmdbTvSearchResponseSchema = pagedSchema.extend({
  results: z.array(tmdbTvSearchItemSchema),
});

export const tmdbMovieSearchResponseSchema = pagedSchema.extend({
  results: z.array(tmdbMovieSearchItemSchema),
});

// Multi search mixes tv, movie and person rows; keep anything unrecognised as a loose
// object so a new media_type never breaks the whole page.
export const tmdbMultiSearchResponseSchema = pagedSchema.extend({
  results: z.array(z.object({ media_type: z.string().optional() }).loose()),
});

export const tmdbFindResponseSchema = z
  .object({
    movie_results: z.array(tmdbMovieSearchItemSchema).default([]),
    tv_results: z.array(tmdbTvSearchItemSchema).default([]),
  })
  .loose();

export const tmdbAlternativeTitleSchema = z
  .object({
    title: z.string(),
    iso_3166_1: nullableString,
    type: nullableString,
  })
  .loose();

export const tmdbSeasonSummarySchema = z
  .object({
    season_number: z.number(),
    episode_count: z.number().nullable().optional(),
    name: nullableString,
    overview: nullableString,
    poster_path: nullableString,
    air_date: nullableString,
  })
  .loose();

export const tmdbTvDetailsSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    original_name: z.string().optional(),
    overview: nullableString,
    status: nullableString,
    first_air_date: nullableString,
    last_air_date: nullableString,
    episode_run_time: z.array(z.number()).optional(),
    genres: z.array(tmdbGenreSchema).optional(),
    networks: z.array(z.object({ name: z.string() }).loose()).optional(),
    poster_path: nullableString,
    backdrop_path: nullableString,
    original_language: z.string().optional(),
    vote_average: nullableNumber,
    vote_count: nullableNumber,
    seasons: z.array(tmdbSeasonSummarySchema).optional(),
    external_ids: tmdbExternalIdsSchema.optional(),
    alternative_titles: z
      .object({ results: z.array(tmdbAlternativeTitleSchema).optional() })
      .loose()
      .optional(),
    content_ratings: z
      .object({
        results: z
          .array(z.object({ iso_3166_1: z.string(), rating: z.string() }).loose())
          .optional(),
      })
      .loose()
      .optional(),
    images: tmdbImagesSchema.optional(),
  })
  .loose();
export type TmdbTvDetails = z.infer<typeof tmdbTvDetailsSchema>;

export const tmdbEpisodeSchema = z
  .object({
    id: z.number(),
    season_number: z.number(),
    episode_number: z.number(),
    name: z.string().default(''),
    overview: nullableString,
    air_date: nullableString,
    runtime: nullableNumber,
    still_path: nullableString,
    vote_average: nullableNumber,
    vote_count: nullableNumber,
  })
  .loose();

export const tmdbSeasonDetailsSchema = z
  .object({
    id: z.number().optional(),
    season_number: z.number(),
    name: nullableString,
    episodes: z.array(tmdbEpisodeSchema).default([]),
  })
  .loose();
export type TmdbSeasonDetails = z.infer<typeof tmdbSeasonDetailsSchema>;

export const tmdbReleaseDateSchema = z
  .object({
    type: z.number(),
    release_date: z.string(),
    certification: nullableString,
    iso_639_1: nullableString,
    note: nullableString,
  })
  .loose();

export const tmdbReleaseDatesByCountrySchema = z
  .object({
    iso_3166_1: z.string(),
    release_dates: z.array(tmdbReleaseDateSchema).default([]),
  })
  .loose();
export type TmdbReleaseDatesByCountry = z.infer<typeof tmdbReleaseDatesByCountrySchema>;

export const tmdbMovieDetailsSchema = z
  .object({
    id: z.number(),
    imdb_id: nullableString,
    title: z.string(),
    original_title: z.string().optional(),
    overview: nullableString,
    status: nullableString,
    release_date: nullableString,
    runtime: nullableNumber,
    genres: z.array(tmdbGenreSchema).optional(),
    production_companies: z.array(z.object({ name: z.string() }).loose()).optional(),
    poster_path: nullableString,
    backdrop_path: nullableString,
    original_language: z.string().optional(),
    vote_average: nullableNumber,
    vote_count: nullableNumber,
    belongs_to_collection: z
      .object({ id: z.number(), name: z.string() })
      .loose()
      .nullable()
      .optional(),
    external_ids: tmdbExternalIdsSchema.optional(),
    alternative_titles: z
      .object({ titles: z.array(tmdbAlternativeTitleSchema).optional() })
      .loose()
      .optional(),
    release_dates: z
      .object({ results: z.array(tmdbReleaseDatesByCountrySchema).optional() })
      .loose()
      .optional(),
    images: tmdbImagesSchema.optional(),
    videos: z.object({ results: z.array(tmdbVideoSchema).optional() }).loose().optional(),
  })
  .loose();
export type TmdbMovieDetails = z.infer<typeof tmdbMovieDetailsSchema>;

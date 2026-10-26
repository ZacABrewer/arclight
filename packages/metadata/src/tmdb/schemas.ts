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

// ---------------------------------------------------------------------------
// Discover / title-page extras (Phase 4): credits, similar, recommendations, keywords,
// people and companies.

export const tmdbCastSchema = z
  .object({
    id: z.number(),
    name: z.string().default(''),
    character: nullableString,
    profile_path: nullableString,
    order: nullableNumber,
  })
  .loose();

export const tmdbCrewSchema = z
  .object({
    id: z.number(),
    name: z.string().default(''),
    job: nullableString,
    department: nullableString,
    profile_path: nullableString,
  })
  .loose();

export const tmdbCreditsSchema = z
  .object({
    cast: z.array(tmdbCastSchema).default([]),
    crew: z.array(tmdbCrewSchema).default([]),
  })
  .loose();

const tmdbKeywordSchema = z.object({ id: z.number(), name: z.string() }).loose();
const tmdbCompanySchema = z
  .object({ id: z.number(), name: z.string(), logo_path: nullableString })
  .loose();
const tmdbVideoListSchema = z.object({ results: z.array(tmdbVideoSchema).optional() }).loose();
const tmdbPagedMovieSchema = z
  .object({ results: z.array(tmdbMovieSearchItemSchema).default([]) })
  .loose();
const tmdbPagedTvSchema = z.object({ results: z.array(tmdbTvSearchItemSchema).default([]) }).loose();

export const tmdbMovieExtrasSchema = z
  .object({
    id: z.number(),
    tagline: nullableString,
    genres: z.array(tmdbGenreSchema).optional(),
    production_companies: z.array(tmdbCompanySchema).optional(),
    credits: tmdbCreditsSchema.optional(),
    similar: tmdbPagedMovieSchema.optional(),
    recommendations: tmdbPagedMovieSchema.optional(),
    videos: tmdbVideoListSchema.optional(),
    keywords: z.object({ keywords: z.array(tmdbKeywordSchema).optional() }).loose().optional(),
  })
  .loose();
export type TmdbMovieExtras = z.infer<typeof tmdbMovieExtrasSchema>;

export const tmdbTvExtrasSchema = z
  .object({
    id: z.number(),
    tagline: nullableString,
    genres: z.array(tmdbGenreSchema).optional(),
    networks: z.array(tmdbCompanySchema).optional(),
    credits: tmdbCreditsSchema.optional(),
    similar: tmdbPagedTvSchema.optional(),
    recommendations: tmdbPagedTvSchema.optional(),
    videos: tmdbVideoListSchema.optional(),
    keywords: z.object({ results: z.array(tmdbKeywordSchema).optional() }).loose().optional(),
  })
  .loose();
export type TmdbTvExtras = z.infer<typeof tmdbTvExtrasSchema>;

export const tmdbPersonSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    biography: nullableString,
    birthday: nullableString,
    deathday: nullableString,
    place_of_birth: nullableString,
    known_for_department: nullableString,
    profile_path: nullableString,
    combined_credits: z
      .object({
        cast: z.array(z.object({ media_type: z.string().optional() }).loose()).default([]),
        crew: z.array(z.object({ media_type: z.string().optional() }).loose()).default([]),
      })
      .loose()
      .optional(),
  })
  .loose();
export type TmdbPerson = z.infer<typeof tmdbPersonSchema>;

export const tmdbCompanyDetailsSchema = tmdbCompanySchema;

// ---------------------------------------------------------------------------
// Discover catalogue: people search, collections, watch providers, filter vocabularies.

export const tmdbPersonSearchResponseSchema = pagedSchema.extend({
  results: z.array(
    z
      .object({
        id: z.number(),
        name: z.string().default(''),
        profile_path: nullableString,
        known_for_department: nullableString,
        popularity: nullableNumber,
        known_for: z.array(z.object({ media_type: z.string().optional() }).loose()).default([]),
      })
      .loose(),
  ),
});

export const tmdbCollectionSchema = z
  .object({
    id: z.number(),
    name: z.string().default(''),
    overview: nullableString,
    poster_path: nullableString,
    backdrop_path: nullableString,
    parts: z.array(tmdbMovieSearchItemSchema).default([]),
  })
  .loose();

export const tmdbWatchProvidersSchema = z
  .object({
    results: z
      .array(
        z
          .object({
            provider_id: z.number(),
            provider_name: z.string().default(''),
            logo_path: nullableString,
            display_priority: nullableNumber,
          })
          .loose(),
      )
      .default([]),
  })
  .loose();

export const tmdbWatchRegionsSchema = z
  .object({
    results: z
      .array(
        z
          .object({ iso_3166_1: z.string(), english_name: z.string().default(''), native_name: nullableString })
          .loose(),
      )
      .default([]),
  })
  .loose();

export const tmdbCertificationsSchema = z
  .object({
    certifications: z
      .record(
        z.string(),
        z.array(
          z
            .object({ certification: z.string(), meaning: nullableString, order: nullableNumber })
            .loose(),
        ),
      )
      .default({}),
  })
  .loose();

export const tmdbLanguagesSchema = z.array(
  z.object({ iso_639_1: z.string(), english_name: z.string().default(''), name: nullableString }).loose(),
);

export const tmdbKeywordSearchResponseSchema = pagedSchema.extend({
  results: z.array(tmdbKeywordSchema),
});

export const tmdbKeywordDetailsSchema = tmdbKeywordSchema;

// TMDB v3 transport: URL building, auth, timeout, 429 retry, TTL cache, Zod validation.
// All shaping of responses happens in ./map.ts so this file stays about HTTP only.

import type { z } from 'zod';
import type {
  CompanyRef,
  EpisodeMetadata,
  Genre,
  MovieMetadata,
  PersonMetadata,
  SearchResult,
  SeriesMetadata,
  TitleExtras,
} from '../types.js';
import { mapMovieExtras, mapPerson, mapTvExtras } from './extras.js';
import { MetadataError } from '../types.js';
import {
  createImageUrlBuilder,
  mapFindResults,
  mapGenres,
  mapMovie,
  mapMovieSearchItem,
  mapMultiSearchResults,
  mapSeason,
  mapSeries,
  mapTvSearchItem,
  type ImageUrlBuilder,
} from './map.js';
import {
  tmdbCompanyDetailsSchema,
  tmdbConfigurationSchema,
  tmdbFindResponseSchema,
  tmdbMovieExtrasSchema,
  tmdbPersonSchema,
  tmdbTvExtrasSchema,
  tmdbGenreListSchema,
  tmdbMovieDetailsSchema,
  tmdbMovieSearchResponseSchema,
  tmdbMultiSearchResponseSchema,
  tmdbSeasonDetailsSchema,
  tmdbTvDetailsSchema,
  tmdbTvSearchResponseSchema,
  type TmdbConfiguration,
} from './schemas.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface TmdbClientOptions {
  /** v3 API key, sent as `api_key`. Ignored when `accessToken` is given. */
  apiKey?: string;
  /** v4 read access token, sent as a Bearer header. */
  accessToken?: string;
  language?: string;
  region?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** TTL for the in-memory response cache in milliseconds. */
  cacheTtlMs?: number;
  /** Max retries after a 429. */
  maxRetries?: number;
  /** Clock, injectable for tests. */
  now?: () => Date;
  /** Sleep, injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface PagedResults<T> {
  page: number;
  totalPages: number;
  totalResults: number;
  results: T[];
}

export interface SearchOptions {
  year?: number;
  page?: number;
  includeAdult?: boolean;
}

export type MediaKind = 'tv' | 'movie';
export type TrendingWindow = 'day' | 'week';

/** Discover filters. Keys map 1:1 to TMDB query params. */
export interface DiscoverOptions {
  page?: number;
  sortBy?: string;
  withGenres?: string;
  year?: number;
  voteAverageGte?: number;
  voteCountGte?: number;
  withOriginalLanguage?: string;
  includeAdult?: boolean;
  /** Primary release date (movies) or first air date (series) range, YYYY-MM-DD. */
  releaseDateGte?: string;
  releaseDateLte?: string;
  voteAverageLte?: number;
  withRuntimeGte?: number;
  withRuntimeLte?: number;
  withKeywords?: string;
  /** Movies only (TMDB company ids). */
  withCompanies?: string;
  /** Series only (TMDB network ids). */
  withNetworks?: string;
  withWatchProviders?: string;
  watchRegion?: string;
}

export interface TmdbClient {
  getConfiguration(): Promise<TmdbConfiguration>;
  searchSeries(query: string, options?: SearchOptions): Promise<PagedResults<SearchResult>>;
  searchMovies(query: string, options?: SearchOptions): Promise<PagedResults<SearchResult>>;
  searchMulti(query: string, options?: SearchOptions): Promise<PagedResults<SearchResult>>;
  findByImdbId(imdbId: string): Promise<SearchResult[]>;
  findByTvdbId(tvdbId: number): Promise<SearchResult[]>;
  getSeries(tmdbId: number): Promise<SeriesMetadata>;
  getSeason(tmdbId: number, seasonNumber: number): Promise<EpisodeMetadata[]>;
  getMovie(tmdbId: number): Promise<MovieMetadata>;
  getTrending(
    kind: MediaKind | 'all',
    window?: TrendingWindow,
    page?: number,
  ): Promise<PagedResults<SearchResult>>;
  discover(kind: MediaKind, options?: DiscoverOptions): Promise<PagedResults<SearchResult>>;
  getGenres(kind: MediaKind): Promise<Genre[]>;
  /** Credits, similar, recommendations, videos, keywords, companies for a movie. */
  getMovieExtras(tmdbId: number): Promise<TitleExtras>;
  /** Credits, similar, recommendations, videos, keywords, networks for a series. */
  getSeriesExtras(tmdbId: number): Promise<TitleExtras>;
  getPerson(personId: number): Promise<PersonMetadata>;
  getCompany(companyId: number): Promise<CompanyRef>;
  getNetwork(networkId: number): Promise<CompanyRef>;
  /** Clears the response cache (including /configuration). */
  clearCache(): void;
}

const DEFAULT_BASE_URL = 'https://api.themoviedb.org/3';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const CONFIGURATION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;

type Params = Record<string, string | number | boolean | undefined>;

interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry-After is either delta-seconds or an HTTP date. */
export function parseRetryAfter(header: string | null, now: Date): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now.getTime());
}

export function createTmdbClient(options: TmdbClientOptions = {}): TmdbClient {
  const {
    apiKey,
    accessToken,
    language = 'en-US',
    region = 'US',
    baseUrl = DEFAULT_BASE_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    now = () => new Date(),
    sleep = defaultSleep,
  } = options;

  const fetchImpl: FetchLike =
    options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const root = baseUrl.replace(/\/+$/, '');
  const cache = new Map<string, CacheEntry>();

  function buildUrl(path: string, params: Params): string {
    const url = new URL(`${root}${path.startsWith('/') ? path : `/${path}`}`);
    url.searchParams.set('language', language);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
    if (!accessToken && apiKey) url.searchParams.set('api_key', apiKey);
    return url.toString();
  }

  function cacheGet(key: string): unknown | undefined {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now().getTime()) {
      cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async function fetchOnce(url: string): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    try {
      return await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
      throw new MetadataError(
        'unreachable',
        timedOut ? `TMDB request timed out after ${timeoutMs}ms` : 'TMDB is unreachable',
        { cause },
      );
    }
  }

  async function request<S extends z.ZodType>(
    path: string,
    params: Params,
    schema: S,
    ttlMs: number = cacheTtlMs,
  ): Promise<z.infer<S>> {
    const url = buildUrl(path, params);
    const cached = cacheGet(url);
    if (cached !== undefined) return cached as z.infer<S>;

    let attempt = 0;
    for (;;) {
      const response = await fetchOnce(url);

      if (response.status === 429) {
        if (attempt >= maxRetries) {
          throw new MetadataError('rate-limited', 'TMDB rate limit exceeded', {
            httpStatus: 429,
          });
        }
        attempt += 1;
        const wait =
          parseRetryAfter(response.headers.get('retry-after'), now()) ??
          DEFAULT_RETRY_DELAY_MS * attempt;
        await sleep(wait);
        continue;
      }

      if (response.status === 404) {
        throw new MetadataError('not-found', `TMDB has no resource at ${path}`, {
          httpStatus: 404,
        });
      }
      if (response.status === 401 || response.status === 403) {
        throw new MetadataError('unauthorized', 'TMDB rejected the credentials', {
          httpStatus: response.status,
        });
      }
      if (!response.ok) {
        throw new MetadataError('bad-response', `TMDB answered HTTP ${response.status}`, {
          httpStatus: response.status,
        });
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (cause) {
        throw new MetadataError('bad-response', 'TMDB returned non-JSON content', {
          httpStatus: response.status,
          cause,
        });
      }

      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        throw new MetadataError('bad-response', `TMDB payload for ${path} has unexpected shape`, {
          httpStatus: response.status,
          cause: parsed.error,
        });
      }

      if (ttlMs > 0) cache.set(url, { expiresAt: now().getTime() + ttlMs, value: parsed.data });
      return parsed.data;
    }
  }

  async function getConfiguration(): Promise<TmdbConfiguration> {
    return request('/configuration', {}, tmdbConfigurationSchema, CONFIGURATION_TTL_MS);
  }

  async function imageBuilder(): Promise<ImageUrlBuilder> {
    return createImageUrlBuilder(await getConfiguration());
  }

  function paged<T>(
    raw: {
      page?: number | undefined;
      total_pages?: number | undefined;
      total_results?: number | undefined;
    },
    results: T[],
  ): PagedResults<T> {
    return {
      page: raw.page ?? 1,
      totalPages: raw.total_pages ?? 1,
      totalResults: raw.total_results ?? results.length,
      results,
    };
  }

  function discoverParams(opts: DiscoverOptions, kind: MediaKind): Params {
    return {
      page: opts.page,
      sort_by: opts.sortBy,
      with_genres: opts.withGenres,
      'vote_average.gte': opts.voteAverageGte,
      'vote_count.gte': opts.voteCountGte,
      with_original_language: opts.withOriginalLanguage,
      include_adult: opts.includeAdult,
      'vote_average.lte': opts.voteAverageLte,
      'with_runtime.gte': opts.withRuntimeGte,
      'with_runtime.lte': opts.withRuntimeLte,
      with_keywords: opts.withKeywords,
      with_watch_providers: opts.withWatchProviders,
      watch_region: opts.watchRegion ?? (opts.withWatchProviders ? region : undefined),
      ...(kind === 'movie'
        ? {
            primary_release_year: opts.year,
            region,
            'primary_release_date.gte': opts.releaseDateGte,
            'primary_release_date.lte': opts.releaseDateLte,
            with_companies: opts.withCompanies,
          }
        : {
            first_air_date_year: opts.year,
            'first_air_date.gte': opts.releaseDateGte,
            'first_air_date.lte': opts.releaseDateLte,
            with_networks: opts.withNetworks,
          }),
    };
  }

  const mapOptions = (images: ImageUrlBuilder) => ({ images, language, region });

  return {
    getConfiguration,

    async searchSeries(query, opts = {}) {
      const [images, raw] = await Promise.all([
        imageBuilder(),
        request(
          '/search/tv',
          { query, page: opts.page, first_air_date_year: opts.year, include_adult: opts.includeAdult },
          tmdbTvSearchResponseSchema,
        ),
      ]);
      return paged(raw, raw.results.map((item) => mapTvSearchItem(item, images)));
    },

    async searchMovies(query, opts = {}) {
      const [images, raw] = await Promise.all([
        imageBuilder(),
        request(
          '/search/movie',
          {
            query,
            page: opts.page,
            year: opts.year,
            region,
            include_adult: opts.includeAdult,
          },
          tmdbMovieSearchResponseSchema,
        ),
      ]);
      return paged(raw, raw.results.map((item) => mapMovieSearchItem(item, images)));
    },

    async searchMulti(query, opts = {}) {
      const [images, raw] = await Promise.all([
        imageBuilder(),
        request(
          '/search/multi',
          { query, page: opts.page, include_adult: opts.includeAdult },
          tmdbMultiSearchResponseSchema,
        ),
      ]);
      return paged(raw, mapMultiSearchResults(raw, images));
    },

    async findByImdbId(imdbId) {
      const [images, raw] = await Promise.all([
        imageBuilder(),
        request(
          `/find/${encodeURIComponent(imdbId)}`,
          { external_source: 'imdb_id' },
          tmdbFindResponseSchema,
        ),
      ]);
      return mapFindResults(raw, images);
    },

    async findByTvdbId(tvdbId) {
      const [images, raw] = await Promise.all([
        imageBuilder(),
        request(`/find/${tvdbId}`, { external_source: 'tvdb_id' }, tmdbFindResponseSchema),
      ]);
      return mapFindResults(raw, images);
    },

    async getSeries(tmdbId) {
      const [images, raw] = await Promise.all([
        imageBuilder(),
        request(
          `/tv/${tmdbId}`,
          {
            append_to_response: 'external_ids,alternative_titles,content_ratings,images,keywords',
            include_image_language: `${language.split('-')[0]},null`,
          },
          tmdbTvDetailsSchema,
        ),
      ]);
      return mapSeries(raw, mapOptions(images));
    },

    async getSeason(tmdbId, seasonNumber) {
      const [images, raw] = await Promise.all([
        imageBuilder(),
        request(`/tv/${tmdbId}/season/${seasonNumber}`, {}, tmdbSeasonDetailsSchema),
      ]);
      return mapSeason(raw, mapOptions(images));
    },

    async getMovie(tmdbId) {
      const [images, raw] = await Promise.all([
        imageBuilder(),
        request(
          `/movie/${tmdbId}`,
          {
            append_to_response: 'external_ids,alternative_titles,release_dates,images,videos,keywords',
            include_image_language: `${language.split('-')[0]},null`,
          },
          tmdbMovieDetailsSchema,
        ),
      ]);
      return mapMovie(raw, { ...mapOptions(images), now: now() });
    },

    async getTrending(kind, window = 'week', page) {
      const [images, raw] = await Promise.all([
        imageBuilder(),
        request(`/trending/${kind}/${window}`, { page }, tmdbMultiSearchResponseSchema),
      ]);
      // /trending/tv and /trending/movie omit media_type; stamp it so the multi mapper works.
      const stamped =
        kind === 'all'
          ? raw
          : { ...raw, results: raw.results.map((r) => ({ ...r, media_type: kind })) };
      return paged(raw, mapMultiSearchResults(stamped, images));
    },

    async discover(kind, opts = {}) {
      const images = await imageBuilder();
      if (kind === 'movie') {
        const raw = await request(
          '/discover/movie',
          discoverParams(opts, kind),
          tmdbMovieSearchResponseSchema,
        );
        return paged(raw, raw.results.map((item) => mapMovieSearchItem(item, images)));
      }
      const raw = await request('/discover/tv', discoverParams(opts, kind), tmdbTvSearchResponseSchema);
      return paged(raw, raw.results.map((item) => mapTvSearchItem(item, images)));
    },

    async getGenres(kind) {
      const raw = await request(`/genre/${kind}/list`, {}, tmdbGenreListSchema, CONFIGURATION_TTL_MS);
      return mapGenres(raw);
    },

    async getMovieExtras(tmdbId) {
      const [images, raw] = await Promise.all([
        imageBuilder(),
        request(`/movie/${tmdbId}`, { append_to_response: 'credits,similar,recommendations,videos,keywords' }, tmdbMovieExtrasSchema),
      ]);
      return mapMovieExtras(raw, images);
    },

    async getSeriesExtras(tmdbId) {
      const [images, raw] = await Promise.all([
        imageBuilder(),
        request(`/tv/${tmdbId}`, { append_to_response: 'credits,similar,recommendations,videos,keywords' }, tmdbTvExtrasSchema),
      ]);
      return mapTvExtras(raw, images);
    },

    async getPerson(personId) {
      const [images, raw] = await Promise.all([
        imageBuilder(),
        request(`/person/${personId}`, { append_to_response: 'combined_credits' }, tmdbPersonSchema),
      ]);
      return mapPerson(raw, images);
    },

    async getCompany(companyId) {
      const [images, raw] = await Promise.all([
        imageBuilder(),
        request(`/company/${companyId}`, {}, tmdbCompanyDetailsSchema, CONFIGURATION_TTL_MS),
      ]);
      const logo = images('logo', raw.logo_path);
      return { tmdbId: raw.id, name: raw.name, ...(logo ? { logo } : {}) };
    },

    async getNetwork(networkId) {
      const [images, raw] = await Promise.all([
        imageBuilder(),
        request(`/network/${networkId}`, {}, tmdbCompanyDetailsSchema, CONFIGURATION_TTL_MS),
      ]);
      const logo = images('logo', raw.logo_path);
      return { tmdbId: raw.id, name: raw.name, ...(logo ? { logo } : {}) };
    },

    clearCache() {
      cache.clear();
    },
  };
}

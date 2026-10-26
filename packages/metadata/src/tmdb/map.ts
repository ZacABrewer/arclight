// Pure functions turning validated TMDB payloads into normalized domain objects.
// No I/O here: everything is unit-testable with fixtures.

import { sortTitle } from '../title.js';
import type {
  AlternateTitle,
  EpisodeMetadata,
  Genre,
  ImageSet,
  MovieMetadata,
  MovieStatus,
  Ratings,
  SearchResult,
  SeriesMetadata,
  SeriesStatus,
} from '../types.js';
import {
  tmdbMovieSearchItemSchema,
  tmdbTvSearchItemSchema,
  type TmdbConfiguration,
  type TmdbMovieDetails,
  type TmdbReleaseDatesByCountry,
  type TmdbSeasonDetails,
  type TmdbTvDetails,
  type tmdbAlternativeTitleSchema,
  type tmdbFindResponseSchema,
  type tmdbGenreListSchema,
  type tmdbImageSchema,
  type tmdbMultiSearchResponseSchema,
  type tmdbVideoSchema,
} from './schemas.js';
import type { z } from 'zod';

type TvSearchItem = z.infer<typeof tmdbTvSearchItemSchema>;
type MovieSearchItem = z.infer<typeof tmdbMovieSearchItemSchema>;
type AltTitle = z.infer<typeof tmdbAlternativeTitleSchema>;
type TmdbImage = z.infer<typeof tmdbImageSchema>;
type TmdbVideo = z.infer<typeof tmdbVideoSchema>;

// ---------------------------------------------------------------------------
// Images

export type ImageKind = 'poster' | 'backdrop' | 'still' | 'logo';

const PREFERRED_SIZE: Record<ImageKind, string> = {
  poster: 'w500',
  backdrop: 'w1280',
  still: 'w300',
  logo: 'w500',
};

/** Builds absolute image URLs from /configuration; falls back to `original`. */
export interface ImageUrlBuilder {
  (kind: ImageKind, path: string | null | undefined): string | undefined;
}

export function createImageUrlBuilder(config: TmdbConfiguration): ImageUrlBuilder {
  const base = config.images.secure_base_url.replace(/\/+$/, '');
  const sizesFor: Record<ImageKind, string[]> = {
    poster: config.images.poster_sizes,
    backdrop: config.images.backdrop_sizes,
    still: config.images.still_sizes,
    logo: config.images.logo_sizes,
  };
  return (kind, path) => {
    if (!path) return undefined;
    const available = sizesFor[kind];
    const preferred = PREFERRED_SIZE[kind];
    const size = available.includes(preferred)
      ? preferred
      : available.includes('original') || available.length === 0
        ? 'original'
        : (available[available.length - 1] as string);
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    return `${base}/${size}${cleanPath}`;
  };
}

// ---------------------------------------------------------------------------
// Small helpers

/** Drops keys whose value is `undefined` so results satisfy exactOptionalPropertyTypes. */
type Compacted<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

function compact<T extends object>(obj: T): Compacted<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Compacted<T>;
}

function text(value: string | null | undefined): string {
  return value ?? '';
}

function optText(value: string | null | undefined): string | undefined {
  return value ? value : undefined;
}

/** TMDB dates are `YYYY-MM-DD` or a full ISO timestamp; keep the date part only. */
export function toIsoDate(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match ? match[1] : undefined;
}

export function yearOf(date: string | null | undefined): number | undefined {
  const iso = toIsoDate(date);
  if (!iso) return undefined;
  const year = Number(iso.slice(0, 4));
  return Number.isFinite(year) && year > 0 ? year : undefined;
}

function ratingsOf(value: number | null | undefined, votes: number | null | undefined): Ratings {
  return { tmdb: { value: value ?? 0, votes: votes ?? 0 } };
}

function mapAlternateTitles(items: AltTitle[] | undefined): AlternateTitle[] {
  if (!items) return [];
  const seen = new Set<string>();
  const out: AlternateTitle[] = [];
  for (const item of items) {
    const title = item.title.trim();
    if (!title) continue;
    const country = optText(item.iso_3166_1);
    const key = `${title}|${country ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(compact({ title, country }));
  }
  return out;
}

/** Prefers a logo in the requested language, then a language-neutral one, then any. */
function pickLogo(logos: TmdbImage[] | undefined, language: string): TmdbImage | undefined {
  if (!logos || logos.length === 0) return undefined;
  const lang = language.split('-')[0]?.toLowerCase();
  return (
    logos.find((l) => l.iso_639_1?.toLowerCase() === lang) ??
    logos.find((l) => l.iso_639_1 == null) ??
    logos[0]
  );
}

function pickYoutubeTrailer(videos: TmdbVideo[] | undefined): string | undefined {
  if (!videos) return undefined;
  const youtube = videos.filter((v) => v.site.toLowerCase() === 'youtube');
  const rank = (v: TmdbVideo): number => {
    const type = (v.type ?? '').toLowerCase();
    let score = type === 'trailer' ? 0 : type === 'teaser' ? 10 : 20;
    if (!v.official) score += 5;
    return score;
  };
  let best: TmdbVideo | undefined;
  for (const video of youtube) {
    if (best === undefined || rank(video) < rank(best)) best = video;
  }
  return best?.key;
}

// ---------------------------------------------------------------------------
// Series

export function mapSeriesStatus(raw: string | null | undefined): SeriesStatus {
  switch ((raw ?? '').trim().toLowerCase()) {
    case 'returning series':
      return 'continuing';
    case 'ended':
    case 'canceled':
    case 'cancelled':
      return 'ended';
    case 'in production':
    case 'planned':
    case 'pilot':
      return 'upcoming';
    default:
      return 'unknown';
  }
}

export interface MapOptions {
  images: ImageUrlBuilder;
  language: string;
  region: string;
}

function pickContentRating(
  results: { iso_3166_1: string; rating: string }[] | undefined,
  region: string,
): string | undefined {
  if (!results || results.length === 0) return undefined;
  const byCountry = (country: string) =>
    results.find((r) => r.iso_3166_1.toUpperCase() === country.toUpperCase() && r.rating.trim());
  return (byCountry(region) ?? byCountry('US') ?? results.find((r) => r.rating.trim()))?.rating;
}

export function mapSeries(raw: TmdbTvDetails, options: MapOptions): SeriesMetadata {
  const { images, language, region } = options;
  const runtime = raw.episode_run_time?.find((n) => n > 0);
  const logo = pickLogo(raw.images?.logos, language);

  const imageSet: ImageSet = compact({
    poster: images('poster', raw.poster_path),
    backdrop: images('backdrop', raw.backdrop_path),
    logo: images('logo', logo?.file_path),
  });

  return compact({
    tmdbId: raw.id,
    tvdbId: raw.external_ids?.tvdb_id ?? undefined,
    imdbId: optText(raw.external_ids?.imdb_id),
    title: raw.name,
    originalTitle: raw.original_name ?? raw.name,
    sortTitle: sortTitle(raw.name),
    year: yearOf(raw.first_air_date),
    overview: text(raw.overview),
    status: mapSeriesStatus(raw.status),
    network: raw.networks?.[0]?.name,
    runtimeMinutes: runtime,
    genres: (raw.genres ?? []).map((g) => g.name),
    firstAired: toIsoDate(raw.first_air_date),
    lastAired: toIsoDate(raw.last_air_date),
    images: imageSet,
    ratings: ratingsOf(raw.vote_average, raw.vote_count),
    certification: pickContentRating(raw.content_ratings?.results, region),
    originalLanguage: raw.original_language ?? '',
    seasons: (raw.seasons ?? []).map((s) =>
      compact({
        seasonNumber: s.season_number,
        episodeCount: s.episode_count ?? 0,
        name: optText(s.name),
        overview: optText(s.overview),
        poster: images('poster', s.poster_path),
      }),
    ),
    alternateTitles: mapAlternateTitles(raw.alternative_titles?.results),
  });
}

export function mapSeason(raw: TmdbSeasonDetails, options: MapOptions): EpisodeMetadata[] {
  return raw.episodes.map((ep) =>
    compact({
      tmdbId: ep.id,
      seasonNumber: ep.season_number,
      episodeNumber: ep.episode_number,
      title: ep.name,
      overview: text(ep.overview),
      airDate: toIsoDate(ep.air_date),
      runtimeMinutes: ep.runtime ?? undefined,
      still: options.images('still', ep.still_path),
      ratings: ratingsOf(ep.vote_average, ep.vote_count),
    }),
  );
}

// ---------------------------------------------------------------------------
// Movies

/** TMDB release_dates `type` values we care about. */
const RELEASE_TYPE = {
  theatrical: 3,
  digital: 4,
  physical: 5,
} as const;

export interface MovieReleaseDates {
  inCinemas?: string;
  digitalRelease?: string;
  physicalRelease?: string;
}

/**
 * For each release type, prefer the configured region, then US, then the earliest date
 * found in any country.
 */
export function pickReleaseDates(
  results: TmdbReleaseDatesByCountry[] | undefined,
  region: string,
): MovieReleaseDates {
  if (!results || results.length === 0) return {};

  const earliestOfType = (country: TmdbReleaseDatesByCountry, type: number): string | undefined => {
    let best: string | undefined;
    for (const entry of country.release_dates) {
      if (entry.type !== type) continue;
      const date = toIsoDate(entry.release_date);
      if (date && (best === undefined || date < best)) best = date;
    }
    return best;
  };

  const pick = (type: number): string | undefined => {
    const candidates = [region.toUpperCase(), 'US'];
    for (const code of candidates) {
      const country = results.find((r) => r.iso_3166_1.toUpperCase() === code);
      if (country) {
        const date = earliestOfType(country, type);
        if (date) return date;
      }
    }
    let best: string | undefined;
    for (const country of results) {
      const date = earliestOfType(country, type);
      if (date && (best === undefined || date < best)) best = date;
    }
    return best;
  };

  return compact({
    inCinemas: pick(RELEASE_TYPE.theatrical),
    digitalRelease: pick(RELEASE_TYPE.digital),
    physicalRelease: pick(RELEASE_TYPE.physical),
  });
}

const CINEMA_WINDOW_DAYS = 90;

/**
 * announced  → nothing has happened yet
 * inCinemas  → theatrical date passed, no home release yet (and the cinema run is recent)
 * released   → a digital/physical date passed, or the cinema run is older than 90 days
 *              with no home release on record
 * unknown    → no dates at all
 */
export function deriveMovieStatus(dates: MovieReleaseDates, now: Date): MovieStatus {
  const today = now.toISOString().slice(0, 10);
  const { inCinemas, digitalRelease, physicalRelease } = dates;

  if (!inCinemas && !digitalRelease && !physicalRelease) return 'unknown';

  if ((digitalRelease && digitalRelease <= today) || (physicalRelease && physicalRelease <= today)) {
    return 'released';
  }

  if (inCinemas && inCinemas <= today) {
    if (!digitalRelease && !physicalRelease) {
      const cutoff = new Date(`${inCinemas}T00:00:00Z`);
      cutoff.setUTCDate(cutoff.getUTCDate() + CINEMA_WINDOW_DAYS);
      if (now.getTime() > cutoff.getTime()) return 'released';
    }
    return 'inCinemas';
  }

  return 'announced';
}

function pickMovieCertification(
  results: TmdbReleaseDatesByCountry[] | undefined,
  region: string,
): string | undefined {
  if (!results) return undefined;
  const certFor = (code: string): string | undefined => {
    const country = results.find((r) => r.iso_3166_1.toUpperCase() === code.toUpperCase());
    return country?.release_dates.map((d) => d.certification?.trim()).find((c) => c)?.trim();
  };
  return certFor(region) ?? certFor('US');
}

export interface MovieMapOptions extends MapOptions {
  now: Date;
}

export function mapMovie(raw: TmdbMovieDetails, options: MovieMapOptions): MovieMetadata {
  const { images, language, region, now } = options;
  const releaseResults = raw.release_dates?.results;
  let dates = pickReleaseDates(releaseResults, region);
  // With no typed release calendar, the top-level release_date is the best cinema guess.
  if (!dates.inCinemas && !dates.digitalRelease && !dates.physicalRelease) {
    const fallback = toIsoDate(raw.release_date);
    if (fallback) dates = { inCinemas: fallback };
  }
  const logo = pickLogo(raw.images?.logos, language);

  const imageSet: ImageSet = compact({
    poster: images('poster', raw.poster_path),
    backdrop: images('backdrop', raw.backdrop_path),
    logo: images('logo', logo?.file_path),
  });

  const collection = raw.belongs_to_collection
    ? { tmdbId: raw.belongs_to_collection.id, name: raw.belongs_to_collection.name }
    : undefined;

  return compact({
    tmdbId: raw.id,
    imdbId: optText(raw.external_ids?.imdb_id) ?? optText(raw.imdb_id),
    title: raw.title,
    originalTitle: raw.original_title ?? raw.title,
    sortTitle: sortTitle(raw.title),
    year: yearOf(raw.release_date) ?? yearOf(dates.inCinemas),
    overview: text(raw.overview),
    status: deriveMovieStatus(dates, now),
    inCinemas: dates.inCinemas,
    digitalRelease: dates.digitalRelease,
    physicalRelease: dates.physicalRelease,
    runtimeMinutes: raw.runtime && raw.runtime > 0 ? raw.runtime : undefined,
    genres: (raw.genres ?? []).map((g) => g.name),
    studio: raw.production_companies?.[0]?.name,
    images: imageSet,
    ratings: ratingsOf(raw.vote_average, raw.vote_count),
    certification: pickMovieCertification(releaseResults, region),
    originalLanguage: raw.original_language ?? '',
    collection,
    alternateTitles: mapAlternateTitles(raw.alternative_titles?.titles),
    youtubeTrailerId: pickYoutubeTrailer(raw.videos?.results),
  });
}

// ---------------------------------------------------------------------------
// Search

export function mapTvSearchItem(item: TvSearchItem, images: ImageUrlBuilder): SearchResult {
  return compact({
    mediaType: 'series' as const,
    tmdbId: item.id,
    title: item.name,
    originalTitle: item.original_name ?? item.name,
    year: yearOf(item.first_air_date),
    firstAired: toIsoDate(item.first_air_date),
    overview: text(item.overview),
    originalLanguage: item.original_language ?? '',
    popularity: item.popularity ?? undefined,
    images: compact({
      poster: images('poster', item.poster_path),
      backdrop: images('backdrop', item.backdrop_path),
    }),
    ratings: ratingsOf(item.vote_average, item.vote_count),
  });
}

export function mapMovieSearchItem(item: MovieSearchItem, images: ImageUrlBuilder): SearchResult {
  return compact({
    mediaType: 'movie' as const,
    tmdbId: item.id,
    title: item.title,
    originalTitle: item.original_title ?? item.title,
    year: yearOf(item.release_date),
    releaseDate: toIsoDate(item.release_date),
    overview: text(item.overview),
    originalLanguage: item.original_language ?? '',
    popularity: item.popularity ?? undefined,
    images: compact({
      poster: images('poster', item.poster_path),
      backdrop: images('backdrop', item.backdrop_path),
    }),
    ratings: ratingsOf(item.vote_average, item.vote_count),
  });
}

/** Multi search: keep tv and movie rows, drop people and anything unrecognised. */
export function mapMultiSearchResults(
  raw: z.infer<typeof tmdbMultiSearchResponseSchema>,
  images: ImageUrlBuilder,
): SearchResult[] {
  const out: SearchResult[] = [];
  for (const row of raw.results) {
    if (row.media_type === 'tv') {
      const parsed = tmdbTvSearchItemSchema.safeParse(row);
      if (parsed.success) out.push(mapTvSearchItem(parsed.data, images));
    } else if (row.media_type === 'movie') {
      const parsed = tmdbMovieSearchItemSchema.safeParse(row);
      if (parsed.success) out.push(mapMovieSearchItem(parsed.data, images));
    }
  }
  return out;
}

export function mapFindResults(
  raw: z.infer<typeof tmdbFindResponseSchema>,
  images: ImageUrlBuilder,
): SearchResult[] {
  return [
    ...raw.tv_results.map((item) => mapTvSearchItem(item, images)),
    ...raw.movie_results.map((item) => mapMovieSearchItem(item, images)),
  ];
}

export function mapGenres(raw: z.infer<typeof tmdbGenreListSchema>): Genre[] {
  return raw.genres.map((g) => ({ tmdbId: g.id, name: g.name }));
}

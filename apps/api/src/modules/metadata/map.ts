import type { MediaImage, MovieStatus, Ratings, SeriesStatus } from '@arclight/shared';
import type {
  EpisodeMetadata,
  ImageSet,
  MovieMetadata,
  Ratings as SourceRatings,
  SeriesMetadata,
} from '@arclight/metadata';
import type { EpisodeMetadataInput, MovieMetadataInput, SeriesMetadataInput } from '../library/index.js';

// Explicit translation from the metadata package's normalized objects to the library's input
// shapes. The two vocabularies differ in a few places (status enums, image sets vs. image
// lists, optional vs. required year), and every difference is decided here, field by field.

/** Library status for a series. TMDB "unknown" becomes upcoming if it never aired, else continuing. */
export function toSeriesStatus(status: SeriesMetadata['status'], firstAired: string | undefined): SeriesStatus {
  switch (status) {
    case 'continuing':
    case 'ended':
    case 'upcoming':
      return status;
    case 'unknown':
      return firstAired ? 'continuing' : 'upcoming';
  }
}

/** Library status for a movie. "unknown" means nothing is scheduled yet: tba. */
export function toMovieStatus(status: MovieMetadata['status']): MovieStatus {
  switch (status) {
    case 'announced':
    case 'inCinemas':
    case 'released':
      return status;
    case 'unknown':
      return 'tba';
  }
}

/** Absolute remote URLs become library images; the remote URL doubles as `url` until cached. */
export function toMediaImages(images: ImageSet): MediaImage[] {
  const out: MediaImage[] = [];
  if (images.poster) out.push({ coverType: 'poster', url: images.poster, remoteUrl: images.poster });
  if (images.backdrop) out.push({ coverType: 'fanart', url: images.backdrop, remoteUrl: images.backdrop });
  if (images.logo) out.push({ coverType: 'clearlogo', url: images.logo, remoteUrl: images.logo });
  return out;
}

export function toRatings(ratings: SourceRatings): Ratings {
  return { tmdb: { value: ratings.tmdb.value, votes: Math.max(0, Math.round(ratings.tmdb.votes)) } };
}

/**
 * The library needs a year (it names folders with it). Prefer the source year, then the
 * year of the given date, then 0 which the library treats as "no year".
 */
export function toYear(year: number | undefined, date: string | undefined): number {
  if (year !== undefined && year > 0) return year;
  const fromDate = date ? Number.parseInt(date.slice(0, 4), 10) : Number.NaN;
  return Number.isFinite(fromDate) && fromDate > 0 ? fromDate : 0;
}

const orNull = (value: string | undefined): string | null => (value === undefined || value === '' ? null : value);

export function toEpisodeMetadataInput(ep: EpisodeMetadata): EpisodeMetadataInput {
  return {
    tmdbId: ep.tmdbId,
    seasonNumber: ep.seasonNumber,
    episodeNumber: ep.episodeNumber,
    absoluteEpisodeNumber: ep.absoluteEpisodeNumber ?? null,
    title: orNull(ep.title),
    overview: orNull(ep.overview),
    airDate: ep.airDate ?? null,
    // TMDB publishes air dates without a time or zone; the library derives UTC when absent.
    airDateUtc: null,
    runtimeMinutes: ep.runtimeMinutes ?? null,
  };
}

export function toSeriesMetadataInput(
  series: SeriesMetadata,
  episodes: ReadonlyArray<EpisodeMetadata>,
): SeriesMetadataInput {
  return {
    tmdbId: series.tmdbId,
    tvdbId: series.tvdbId ?? null,
    imdbId: series.imdbId ?? null,
    title: series.title,
    year: toYear(series.year, series.firstAired),
    overview: orNull(series.overview),
    status: toSeriesStatus(series.status, series.firstAired),
    network: series.network ?? null,
    runtimeMinutes: series.runtimeMinutes ?? null,
    genres: [...series.genres],
    images: toMediaImages(series.images),
    ratings: toRatings(series.ratings),
    certification: series.certification ?? null,
    originalLanguage: orNull(series.originalLanguage),
    seasons: series.seasons.map((s) => ({ seasonNumber: s.seasonNumber })),
    episodes: episodes.map(toEpisodeMetadataInput),
  };
}

export function toMovieMetadataInput(movie: MovieMetadata): MovieMetadataInput {
  return {
    tmdbId: movie.tmdbId,
    imdbId: movie.imdbId ?? null,
    title: movie.title,
    originalTitle: orNull(movie.originalTitle),
    year: toYear(movie.year, movie.inCinemas ?? movie.digitalRelease ?? movie.physicalRelease),
    overview: orNull(movie.overview),
    status: toMovieStatus(movie.status),
    inCinemas: movie.inCinemas ?? null,
    digitalRelease: movie.digitalRelease ?? null,
    physicalRelease: movie.physicalRelease ?? null,
    runtimeMinutes: movie.runtimeMinutes ?? null,
    studio: movie.studio ?? null,
    genres: [...movie.genres],
    images: toMediaImages(movie.images),
    ratings: toRatings(movie.ratings),
    certification: movie.certification ?? null,
    originalLanguage: orNull(movie.originalLanguage),
    collection: movie.collection ? { tmdbId: movie.collection.tmdbId, title: movie.collection.name } : null,
  };
}

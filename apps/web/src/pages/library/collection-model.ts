import type { MetadataCollection, MetadataCollectionPart, MetadataSearchResult, Movie } from '@arclight/shared';

// TMDB collections against the movie library: which parts are owned, which are missing.

export interface CollectionPartState {
  part: MetadataCollectionPart;
  /** The library movie for this part, when it is in the library. */
  movie: Movie | undefined;
}

export function partStates(collection: Pick<MetadataCollection, 'parts'>, movies: readonly Movie[]): CollectionPartState[] {
  const byTmdb = new Map(movies.map((m) => [m.tmdbId, m]));
  return collection.parts.map((part) => ({ part, movie: byTmdb.get(part.tmdbId) }));
}

/** Parts not in the library yet, skipping unreleased parts without a date (TMDB placeholders). */
export function missingParts(states: readonly CollectionPartState[]): MetadataCollectionPart[] {
  return states.filter((s) => !s.movie && s.part.releaseDate).map((s) => s.part);
}

/** Owned = in the library with a file; total = TMDB parts (library count until TMDB answered). */
export function collectionCounts(states: readonly CollectionPartState[]): { owned: number; inLibrary: number; total: number } {
  return {
    owned: states.filter((s) => s.movie?.hasFile).length,
    inLibrary: states.filter((s) => s.movie).length,
    total: states.length,
  };
}

/** The add dialog takes a search result; build one from a collection part. */
export function partAsSearchResult(part: MetadataCollectionPart): Extract<MetadataSearchResult, { mediaType: 'movie' }> {
  return {
    mediaType: 'movie',
    tmdbId: part.tmdbId,
    title: part.title,
    originalTitle: part.title,
    overview: part.overview,
    originalLanguage: part.originalLanguage,
    images: part.images,
    ratings: { tmdb: { value: 0, votes: 0 } },
    ...(part.year !== undefined ? { year: part.year } : {}),
    ...(part.releaseDate ? { releaseDate: part.releaseDate } : {}),
  };
}

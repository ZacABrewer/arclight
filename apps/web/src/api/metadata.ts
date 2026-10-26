import { MetadataCollection, MetadataMovie, MetadataSearchResult, MetadataSeries, type MetadataSearchType } from '@arclight/shared';
import { ApiError, request } from './client.js';

// Paths mirror apps/api/src/modules/metadata/routes.ts.

export const metadataApi = {
  search: (query: string, type: MetadataSearchType = 'all') =>
    request('/metadata/search', MetadataSearchResult.array(), { query: { query, type } }),
  series: (tmdbId: number) => request(`/metadata/series/${tmdbId}`, MetadataSeries),
  movie: (tmdbId: number) => request(`/metadata/movie/${tmdbId}`, MetadataMovie),
  collection: (tmdbId: number) => request(`/metadata/collection/${tmdbId}`, MetadataCollection),
};

/** The metadata routes answer 400 NOT_CONFIGURED (or 400 unauthorized) when there is no usable TMDB key. */
export function isMissingTmdbKey(err: unknown): boolean {
  return err instanceof ApiError && err.status === 400 && (err.code === 'NOT_CONFIGURED' || err.code === 'unauthorized');
}

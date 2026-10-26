/** Link props for a discover title page. */
export function titleLink(mediaType: 'movie' | 'series', tmdbId: number) {
  return mediaType === 'movie'
    ? ({ to: '/discover/movie/$tmdbId', params: { tmdbId: String(tmdbId) } } as const)
    : ({ to: '/discover/tv/$tmdbId', params: { tmdbId: String(tmdbId) } } as const);
}

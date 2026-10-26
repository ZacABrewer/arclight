import type { MetadataSearchType } from '@media-tron/shared';

// Query keys for the library pages. The first segment matches what live.ts invalidates on a
// `library` event (`[mediaType]`, `['library']`, `['wanted']`), so everything under
// ['series'] / ['movie'] refetches when the server says that resource changed.
export const libraryKeys = {
  series: {
    all: ['series'] as const,
    lists: ['series', 'list'] as const,
    list: () => ['series', 'list', 'all'] as const,
    detail: (id: number) => ['series', 'detail', id] as const,
    episodes: (id: number) => ['series', 'detail', id, 'episodes'] as const,
    files: (id: number) => ['series', 'detail', id, 'files'] as const,
  },
  movie: {
    all: ['movie'] as const,
    lists: ['movie', 'list'] as const,
    list: () => ['movie', 'list', 'all'] as const,
    detail: (id: number) => ['movie', 'detail', id] as const,
    files: (id: number) => ['movie', 'detail', id, 'files'] as const,
  },
  library: {
    all: ['library'] as const,
    rootFolders: ['library', 'rootfolders'] as const,
    tags: ['library', 'tags'] as const,
    statistics: ['library', 'statistics'] as const,
  },
  wanted: {
    all: ['wanted'] as const,
    missing: (kind: 'episodes' | 'movies', page: number, pageSize: number) =>
      ['wanted', 'missing', kind, page, pageSize] as const,
    cutoff: (kind: 'episodes' | 'movies', page: number, pageSize: number) =>
      ['wanted', 'cutoff', kind, page, pageSize] as const,
  },
  calendar: {
    all: ['calendar'] as const,
    range: (start: string, end: string, unmonitored: boolean) => ['calendar', start, end, unmonitored] as const,
  },
  /** Profiles change through settings; live.ts invalidates ['settings'] on a settings event. */
  qualityProfiles: ['settings', 'qualityprofiles'] as const,
  /** Interactive search results; not invalidated by events (a search is a snapshot). */
  releases: (target: object | null) => ['releases', 'search', target] as const,
  metadata: {
    search: (query: string, type: MetadataSearchType) => ['metadata', 'search', type, query] as const,
  },
};

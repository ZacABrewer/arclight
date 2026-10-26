import type { Episode, Movie, QualityProfile, RootFolder, Series } from '@media-tron/shared';

// Test fixtures for the library pages (only imported by *.test.ts[x]).

export function makeSeries(over: Partial<Series> & { id: number; title: string }): Series {
  return {
    tmdbId: 1000 + over.id,
    sortTitle: over.title.toLowerCase().replace(/^the /, ''),
    cleanTitle: over.title.toLowerCase().replace(/[^a-z0-9]/g, ''),
    year: 2020,
    overview: '',
    status: 'continuing',
    genres: [],
    images: [],
    ratings: {},
    originalLanguage: 'en',
    path: `/tv/${over.title}`,
    rootFolderPath: '/tv',
    qualityProfileId: 1,
    monitored: true,
    monitorNewItems: 'all',
    seriesType: 'standard',
    seasonFolder: true,
    useSceneNumbering: false,
    tags: [],
    added: '2026-01-01T00:00:00.000Z',
    seasons: [],
    statistics: {
      seasonCount: 1,
      episodeCount: 10,
      episodeFileCount: 10,
      totalEpisodeCount: 10,
      monitoredEpisodeCount: 10,
      sizeOnDisk: 1_000,
      percentOfEpisodes: 100,
    },
    ...over,
  };
}

export function makeMovie(over: Partial<Movie> & { id: number; title: string }): Movie {
  return {
    tmdbId: 5000 + over.id,
    originalTitle: over.title,
    sortTitle: over.title.toLowerCase(),
    cleanTitle: over.title.toLowerCase(),
    year: 2020,
    overview: '',
    status: 'released',
    genres: [],
    images: [],
    ratings: {},
    originalLanguage: 'en',
    path: `/movies/${over.title}`,
    rootFolderPath: '/movies',
    qualityProfileId: 1,
    minimumAvailability: 'released',
    monitored: true,
    tags: [],
    added: '2026-01-01T00:00:00.000Z',
    hasFile: false,
    isAvailable: true,
    ...over,
  };
}

export function makeEpisode(over: Partial<Episode> & { id: number }): Episode {
  return {
    seriesId: 1,
    seasonNumber: 1,
    episodeNumber: over.id,
    title: `Episode ${over.id}`,
    overview: '',
    monitored: true,
    hasFile: false,
    unverifiedSceneNumbering: false,
    ...over,
  };
}

export const rootFolders: RootFolder[] = [
  { id: 1, path: '/data/tv', mediaType: 'series', accessible: true, freeSpaceBytes: 1e12 },
  { id: 2, path: '/data/movies', mediaType: 'movie', accessible: true, freeSpaceBytes: 1e12 },
  { id: 3, path: 'D:\\Media\\TV', mediaType: 'series', accessible: true, freeSpaceBytes: null },
];

export const profiles = [
  { id: 1, name: 'HD-1080p' },
  { id: 2, name: 'Ultra-HD' },
] as unknown as QualityProfile[];

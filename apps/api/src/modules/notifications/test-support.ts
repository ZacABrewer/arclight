import { QUALITIES } from '@media-tron/shared';
import type { Db } from '../../db/index.js';
import { episodes, mediaFiles, movies, series, tags } from '../../db/schema.js';

// Direct library row inserts for tests (no metadata provider, no filesystem). Not used by
// production code.

const NOW = '2026-01-01T00:00:00.000Z';

export function insertTag(db: Db, label: string): number {
  return db.insert(tags).values({ label }).returning().get().id;
}

export function insertSeries(db: Db, overrides: Partial<typeof series.$inferInsert> = {}) {
  const tmdbId = overrides.tmdbId ?? Math.floor(Math.random() * 1e9);
  return db
    .insert(series)
    .values({
      tmdbId,
      tvdbId: 7000,
      title: 'Example Show',
      sortTitle: 'example show',
      cleanTitle: 'exampleshow',
      year: 2024,
      overview: 'A show.',
      status: 'continuing',
      network: 'HBO',
      runtimeMinutes: 45,
      genres: ['Drama'],
      images: [{ coverType: 'poster', url: '/cache/p.jpg', remoteUrl: 'https://img.example/p.jpg' }],
      ratings: { tmdb: { votes: 10, value: 8.1 } },
      originalLanguage: 'en',
      path: `/tv/Example Show ${tmdbId}`,
      rootFolderPath: '/tv',
      qualityProfileId: 1,
      monitored: true,
      tags: [],
      added: NOW,
      ...overrides,
    })
    .returning()
    .get();
}

export function insertMovie(db: Db, overrides: Partial<typeof movies.$inferInsert> = {}) {
  const tmdbId = overrides.tmdbId ?? Math.floor(Math.random() * 1e9);
  return db
    .insert(movies)
    .values({
      tmdbId,
      imdbId: 'tt0000001',
      title: 'Example Movie',
      originalTitle: 'Example Movie',
      sortTitle: 'example movie',
      cleanTitle: 'examplemovie',
      year: 2026,
      overview: 'A movie.',
      status: 'announced',
      studio: 'Studio',
      genres: ['Action'],
      images: [{ coverType: 'fanart', url: 'https://img.example/f.jpg' }],
      ratings: {},
      originalLanguage: 'en',
      path: `/movies/Example Movie ${tmdbId}`,
      rootFolderPath: '/movies',
      qualityProfileId: 1,
      monitored: true,
      tags: [],
      added: NOW,
      ...overrides,
    })
    .returning()
    .get();
}

export function insertEpisode(db: Db, seriesId: number, overrides: Partial<typeof episodes.$inferInsert> = {}) {
  return db
    .insert(episodes)
    .values({
      seriesId,
      seasonNumber: 1,
      episodeNumber: 1,
      title: 'Pilot',
      overview: 'It begins.',
      monitored: true,
      ...overrides,
    })
    .returning()
    .get();
}

export function insertFile(db: Db, overrides: Partial<typeof mediaFiles.$inferInsert> & { mediaType: 'series' | 'movie' }) {
  return db
    .insert(mediaFiles)
    .values({
      relativePath: 'Season 01/Example.S01E01.mkv',
      path: `/tv/Example/Season 01/Example.S01E01.${Math.random()}.mkv`,
      sizeBytes: 1_500_000_000,
      dateAdded: NOW,
      quality: { quality: { ...QUALITIES['WEBDL-1080p'], mediaTypes: [...QUALITIES['WEBDL-1080p'].mediaTypes] }, revision: { version: 2, real: 0, isRepack: false } },
      languages: ['English'],
      releaseGroup: 'GRP',
      mediaInfo: { videoCodec: 'x265', resolution: '1920x1080', audioLanguages: ['English'], subtitles: ['English'] },
      ...overrides,
    })
    .returning()
    .get();
}

import pino from 'pino';
import { QUALITIES, type QualityModel, type QualityName } from '@media-tron/shared';
import type { Db } from '../../db/index.js';
import { episodes, movies, series } from '../../db/schema.js';
import { createTestDb } from '../../db/test-utils.js';
import { EventBus } from '../../events.js';
import * as blocklistSchema from '../blocklist/schema.js';
import { BlocklistService } from '../blocklist/service.js';
import * as historySchema from './schema.js';
import { HistoryService } from './service.js';

// Shared fixtures for the history and blocklist tests.

export function quality(name: QualityName, version = 1): QualityModel {
  const q = QUALITIES[name];
  return { quality: { ...q, mediaTypes: [...q.mediaTypes] }, revision: { version, real: 0, isRepack: false } };
}

export class Clock {
  constructor(public t = new Date('2025-01-10T12:00:00.000Z').getTime()) {}
  now = (): Date => new Date(this.t);
  advance(ms: number): void {
    this.t += ms;
  }
}

export interface Fixture {
  db: Db;
  bus: EventBus;
  clock: Clock;
  history: HistoryService;
  blocklist: BlocklistService;
  seriesId: number;
  otherSeriesId: number;
  /** Season 1 episodes 1..3, season 2 episodes 1..2. */
  ep: { s1e1: number; s1e2: number; s1e3: number; s2e1: number; s2e2: number };
  movieId: number;
  otherMovieId: number;
}

function insertSeries(db: Db, tmdbId: number, title: string, sortTitle: string): number {
  return db
    .insert(series)
    .values({
      tmdbId,
      title,
      sortTitle,
      cleanTitle: sortTitle.replace(/\W/g, ''),
      year: 2020,
      status: 'continuing',
      genres: [],
      images: [],
      ratings: {},
      originalLanguage: 'en',
      path: `/tv/${title}`,
      rootFolderPath: '/tv',
      qualityProfileId: 1,
      tags: [],
      added: '2024-01-01T00:00:00.000Z',
    })
    .returning({ id: series.id })
    .get().id;
}

function insertEpisode(db: Db, seriesId: number, season: number, episode: number): number {
  return db
    .insert(episodes)
    .values({ seriesId, seasonNumber: season, episodeNumber: episode, title: `S${season}E${episode}` })
    .returning({ id: episodes.id })
    .get().id;
}

function insertMovie(db: Db, tmdbId: number, title: string, sortTitle: string): number {
  return db
    .insert(movies)
    .values({
      tmdbId,
      title,
      originalTitle: title,
      sortTitle,
      cleanTitle: sortTitle.replace(/\W/g, ''),
      year: 2021,
      status: 'released',
      genres: [],
      images: [],
      ratings: {},
      originalLanguage: 'en',
      path: `/movies/${title}`,
      rootFolderPath: '/movies',
      qualityProfileId: 2,
      tags: [],
      added: '2024-01-01T00:00:00.000Z',
    })
    .returning({ id: movies.id })
    .get().id;
}

export async function setup(): Promise<Fixture> {
  const db = await createTestDb({ ...historySchema, ...blocklistSchema });
  const bus = new EventBus();
  const clock = new Clock();
  const log = pino({ level: 'silent' });
  const history = new HistoryService({ db, log, bus, now: clock.now });
  const blocklist = new BlocklistService({ db, log, now: clock.now });
  history.onDownloadFailed((event) => {
    blocklist.addFromFailed(event);
  });

  const seriesId = insertSeries(db, 100, 'Zeta Show', 'zeta show');
  const otherSeriesId = insertSeries(db, 101, 'Alpha Show', 'alpha show');
  const ep = {
    s1e1: insertEpisode(db, seriesId, 1, 1),
    s1e2: insertEpisode(db, seriesId, 1, 2),
    s1e3: insertEpisode(db, seriesId, 1, 3),
    s2e1: insertEpisode(db, seriesId, 2, 1),
    s2e2: insertEpisode(db, seriesId, 2, 2),
  };
  const movieId = insertMovie(db, 200, 'Movie', 'movie');
  const otherMovieId = insertMovie(db, 201, 'Beta Movie', 'beta movie');
  return { db, bus, clock, history, blocklist, seriesId, otherSeriesId, ep, movieId, otherMovieId };
}

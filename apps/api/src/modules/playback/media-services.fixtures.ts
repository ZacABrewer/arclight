import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { QUALITIES, type MediaInfo, type QualityModel } from '@arclight/shared';
import { buildApp, type AppContext } from '../../app.js';
import type { AppConfig } from '../../config.js';
import type { Db } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { createTestDb, seedAdmin } from '../../db/test-utils.js';
import { authServiceFor, SESSION_COOKIE } from '../auth/index.js';
import { setSection } from '../settings/service.js';

// Library seeding and an app harness for the redesign's media-service tests (featured, chips,
// trickplay, segments). Test-only.

export const TEST_CONFIG: AppConfig = { configDir: '.', dbPath: ':memory:', logDir: '.', port: 0, host: '127.0.0.1', logLevel: 'silent', isDocker: false, webDist: null };

const quality = (): QualityModel => ({ quality: { ...QUALITIES['Bluray-1080p'], mediaTypes: [...QUALITIES['Bluray-1080p'].mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } });

export const SDR_1080: MediaInfo = {
  container: 'matroska',
  videoFormat: 'h264',
  videoBitDepth: 8,
  width: 1920,
  height: 1080,
  videoFps: 24,
  videoDynamicRangeType: 'SDR',
  overallBitrate: 6_000_000,
  durationMs: 600_000,
  audioStreams: [{ codec: 'eac3', channels: 6, language: 'eng', title: null, default: true }],
  subtitleStreams: [],
} as MediaInfo;

/** A tiny file with real bytes (fileStamp works on it). */
export function blob(dir: string, name: string, bytes: Buffer | string = 'x'.repeat(2000)): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

export interface MovieSeed {
  title: string;
  tmdbId: number;
  genres?: string[];
  runtimeMinutes?: number | null;
  score?: number;
  votes?: number;
  certification?: string | null;
  added?: string;
  fanart?: boolean;
  info?: MediaInfo;
  /** Existing file path (else a blob under `dir`). */
  path?: string;
  dateAdded?: string;
}

export function seedMovie(db: Db, dir: string, m: MovieSeed) {
  const added = m.added ?? '2025-01-01T00:00:00.000Z';
  const movie = db
    .insert(schema.movies)
    .values({
      tmdbId: m.tmdbId,
      title: m.title,
      originalTitle: m.title,
      sortTitle: m.title.toLowerCase(),
      cleanTitle: m.title.toLowerCase().replace(/\W/g, ''),
      year: 2021,
      status: 'released',
      runtimeMinutes: m.runtimeMinutes === undefined ? 100 : m.runtimeMinutes,
      genres: m.genres ?? ['Drama'],
      overview: `About ${m.title}.`,
      images: [
        { coverType: 'poster' as const, url: `https://image.tmdb.org/t/p/original/p${m.tmdbId}.jpg` },
        ...(m.fanart === false ? [] : [{ coverType: 'fanart' as const, url: `https://image.tmdb.org/t/p/original/f${m.tmdbId}.jpg` }]),
      ],
      ratings: { tmdb: { value: m.score ?? 6, votes: m.votes ?? 100 } },
      certification: m.certification === undefined ? 'PG-13' : m.certification,
      originalLanguage: 'en',
      path: join(dir, `movie-${m.tmdbId}`),
      rootFolderPath: dir,
      qualityProfileId: 1,
      tags: [],
      added,
      hasFile: true,
    })
    .returning()
    .get();
  const path = m.path ?? blob(join(dir, `movie-${m.tmdbId}`), `${m.tmdbId}.mkv`);
  const file = db
    .insert(schema.mediaFiles)
    .values({ mediaType: 'movie', movieId: movie.id, relativePath: `${m.tmdbId}.mkv`, path, sizeBytes: statSync(path).size, dateAdded: m.dateAdded ?? added, quality: quality(), languages: ['English'], mediaInfo: m.info ?? SDR_1080 })
    .returning()
    .get();
  db.update(schema.movies).set({ movieFileId: file.id }).where(eq(schema.movies.id, movie.id)).run();
  return { movie, file };
}

export interface EpisodeSeed {
  season: number;
  episode: number;
  airDate?: string | null;
  /** No file when false. */
  file?: boolean;
  dateAdded?: string;
  info?: MediaInfo;
  path?: string;
}

export interface SeriesSeed {
  title: string;
  tmdbId: number;
  status?: 'continuing' | 'ended';
  genres?: string[];
  score?: number;
  certification?: string | null;
  added?: string;
  fanart?: boolean;
  episodes: EpisodeSeed[];
}

export function seedSeries(db: Db, dir: string, s: SeriesSeed) {
  const added = s.added ?? '2025-01-01T00:00:00.000Z';
  const show = db
    .insert(schema.series)
    .values({
      tmdbId: s.tmdbId,
      title: s.title,
      sortTitle: s.title.toLowerCase(),
      cleanTitle: s.title.toLowerCase().replace(/\W/g, ''),
      year: 2020,
      status: s.status ?? 'continuing',
      genres: s.genres ?? ['Comedy'],
      overview: `About ${s.title}.`,
      images: s.fanart === false ? [] : [{ coverType: 'fanart' as const, url: `https://image.tmdb.org/t/p/original/s${s.tmdbId}.jpg` }],
      ratings: s.score ? { tmdb: { value: s.score, votes: 100 } } : {},
      certification: s.certification === undefined ? 'TV-14' : s.certification,
      originalLanguage: 'en',
      path: join(dir, `series-${s.tmdbId}`),
      rootFolderPath: dir,
      qualityProfileId: 1,
      tags: [],
      added,
      runtimeMinutes: 25,
    })
    .returning()
    .get();
  const eps = s.episodes.map((e) => {
    const hasFile = e.file !== false;
    let fileId: number | null = null;
    if (hasFile) {
      const name = `S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')}.mkv`;
      const path = e.path ?? blob(join(dir, `series-${s.tmdbId}`, `Season ${e.season}`), name);
      fileId = db
        .insert(schema.mediaFiles)
        .values({ mediaType: 'series', seriesId: show.id, seasonNumber: e.season, relativePath: `Season ${e.season}/${name}`, path, sizeBytes: statSync(path).size, dateAdded: e.dateAdded ?? added, quality: quality(), languages: ['English'], mediaInfo: e.info ?? SDR_1080 })
        .returning()
        .get().id;
    }
    return db
      .insert(schema.episodes)
      .values({ seriesId: show.id, seasonNumber: e.season, episodeNumber: e.episode, title: `Episode ${e.episode}`, overview: e.episode === 1 ? '' : `Episode ${e.episode} overview.`, airDate: e.airDate ?? null, hasFile, episodeFileId: fileId })
      .returning()
      .get();
  });
  return { show, episodes: eps };
}

export interface AppHarness {
  app: Awaited<ReturnType<typeof buildApp>>;
  ctx: AppContext;
  db: Db;
}

export async function appHarness(onContext?: (c: AppContext) => void): Promise<AppHarness> {
  const db = await createTestDb();
  seedAdmin(db);
  let ctx: AppContext | undefined;
  const app = await buildApp(TEST_CONFIG, db, pino({ level: 'silent' }), {
    probe: false,
    onContext: (c) => {
      ctx = c;
      onContext?.(c);
    },
  });
  await app.ready();
  setSection(db, 'player', { enabled: true });
  return { app, ctx: ctx!, db };
}

export async function signIn(h: AppHarness, opts: { role?: 'user' | 'admin'; restrictions?: unknown } = {}): Promise<{ cookie: string; id: number }> {
  const auth = authServiceFor(h.ctx);
  const user = await auth.createUser({
    username: `u${Math.random().toString(36).slice(2, 8)}`,
    password: 'password1',
    role: opts.role ?? 'user',
    settings: { player: { allowed: true }, ...(opts.restrictions ? { contentRestrictions: opts.restrictions } : {}) },
  });
  return { cookie: `${SESSION_COOKIE}=${auth.createSession(user.id).token}`, id: user.id };
}

/** A minimal JPEG header of `width` x `height` (SOI + SOF0), enough for jpegSize. */
export function fakeJpeg(width: number, height: number): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]), sof, Buffer.from([0xff, 0xd9])]);
}

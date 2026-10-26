import Fastify from 'fastify';
import { eq } from 'drizzle-orm';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import pino from 'pino';
import type { MovieMetadata, SearchResult, SeriesMetadata, TitleExtras, TmdbClient } from '@media-tron/metadata';
import type { NotificationAgent, NotificationEvent } from '@media-tron/notifications';
import { Permission, type QualityModel } from '@media-tron/shared';
import type { AppContext } from '../../app.js';
import type { Db } from '../../db/index.js';
import { episodes, mediaFiles, movies, qualityProfiles, rootFolders, series, users } from '../../db/schema.js';
import { createTestDb } from '../../db/test-utils.js';
import { EventBus } from '../../events.js';
import { Scheduler } from '../../scheduler.js';
import { authServiceFor, installAuth, SESSION_COOKIE } from '../auth/index.js';
import type { MovieMetadataInput, SeriesMetadataInput } from '../library/index.js';
import type { SearchTarget } from '../releases/index.js';
import { requestsModuleWith, requestsServicesFor, type RequestsModuleOptions } from './index.js';
import type { Actor } from './permissions.js';
import * as requestsSchema from './schema.js';
import type { TitleSource } from './service.js';
import type { WatchlistProvider } from './watchlist.js';

// Test-only helpers: an in-memory database with the requests tables, a fake TMDB, fake
// notification agents and a search spy.

export const NOW = new Date('2026-06-01T12:00:00Z');

export interface FakeMovie {
  tmdbId: number;
  title: string;
  year: number;
  originalLanguage?: string;
  genreIds?: number[];
  keywordIds?: number[];
}

export interface FakeSeries extends FakeMovie {
  tvdbId?: number;
  /** Episodes per season; index = season number (0 = specials). */
  seasons: number[];
}

function result(kind: 'movie' | 'series', m: FakeMovie): SearchResult {
  const base = {
    tmdbId: m.tmdbId,
    title: m.title,
    originalTitle: m.title,
    year: m.year,
    overview: `${m.title} overview`,
    originalLanguage: m.originalLanguage ?? 'en',
    images: { poster: `https://img/${m.tmdbId}.jpg` },
    ratings: { tmdb: { value: 7.5, votes: 100 } },
  };
  return kind === 'movie' ? { ...base, mediaType: 'movie', releaseDate: `${m.year}-01-01` } : { ...base, mediaType: 'series', firstAired: `${m.year}-01-01` };
}

export class FakeTmdb {
  movies = new Map<number, FakeMovie>();
  series = new Map<number, FakeSeries>();
  calls: string[] = [];

  addMovie(m: FakeMovie): this {
    this.movies.set(m.tmdbId, m);
    return this;
  }

  addSeries(s: FakeSeries): this {
    this.series.set(s.tmdbId, s);
    return this;
  }

  private movie(id: number): FakeMovie {
    const m = this.movies.get(id);
    if (!m) throw Object.assign(new Error('not found'), { code: 'not-found' });
    return m;
  }

  private show(id: number): FakeSeries {
    const s = this.series.get(id);
    if (!s) throw Object.assign(new Error('not found'), { code: 'not-found' });
    return s;
  }

  private extras(kind: 'movie' | 'series', m: FakeMovie): TitleExtras {
    return {
      tmdbId: m.tmdbId,
      mediaType: kind,
      tagline: 'A tagline',
      genres: (m.genreIds ?? []).map((id) => ({ tmdbId: id, name: `Genre ${id}` })),
      keywords: (m.keywordIds ?? []).map((id) => ({ tmdbId: id, name: `kw ${id}` })),
      companies: [],
      cast: [{ tmdbId: 1, name: 'Lead Actor', character: 'Hero' }],
      crew: [{ tmdbId: 2, name: 'Director Person', job: 'Director' }],
      videos: [{ name: 'Trailer', key: 'abc', site: 'YouTube', type: 'Trailer' }],
      similar: [...(kind === 'movie' ? this.movies : this.series).values()].filter((x) => x.tmdbId !== m.tmdbId).map((x) => result(kind, x)),
      recommendations: [],
    };
  }

  page(results: SearchResult[]) {
    return { page: 1, totalPages: 1, totalResults: results.length, results };
  }

  client(): TmdbClient {
    const self = this;
    const client: Partial<TmdbClient> = {
      async getMovie(id): Promise<MovieMetadata> {
        self.calls.push(`movie:${id}`);
        const m = self.movie(id);
        return {
          tmdbId: m.tmdbId,
          title: m.title,
          originalTitle: m.title,
          sortTitle: m.title.toLowerCase(),
          year: m.year,
          overview: `${m.title} overview`,
          status: 'released',
          genres: [],
          images: { poster: `https://img/${m.tmdbId}.jpg`, backdrop: `https://img/${m.tmdbId}-b.jpg` },
          ratings: { tmdb: { value: 7.5, votes: 100 } },
          originalLanguage: m.originalLanguage ?? 'en',
          alternateTitles: [],
          runtimeMinutes: 120,
        };
      },
      async getSeries(id): Promise<SeriesMetadata> {
        self.calls.push(`series:${id}`);
        const s = self.show(id);
        return {
          tmdbId: s.tmdbId,
          ...(s.tvdbId ? { tvdbId: s.tvdbId } : {}),
          title: s.title,
          originalTitle: s.title,
          sortTitle: s.title.toLowerCase(),
          year: s.year,
          overview: `${s.title} overview`,
          status: 'continuing',
          genres: [],
          images: { poster: `https://img/${s.tmdbId}.jpg` },
          ratings: { tmdb: { value: 8, votes: 50 } },
          originalLanguage: s.originalLanguage ?? 'en',
          seasons: s.seasons.map((count, n) => ({ seasonNumber: n, episodeCount: count, name: n === 0 ? 'Specials' : `Season ${n}` })),
          alternateTitles: [],
        };
      },
      async getMovieExtras(id) {
        self.calls.push(`movieExtras:${id}`);
        return self.extras('movie', self.movie(id));
      },
      async getSeriesExtras(id) {
        self.calls.push(`seriesExtras:${id}`);
        return self.extras('series', self.show(id));
      },
      async discover(kind, opts = {}) {
        self.calls.push(`discover:${kind}:${JSON.stringify(opts)}`);
        return kind === 'movie' ? self.page([...self.movies.values()].map((m) => result('movie', m))) : self.page([...self.series.values()].map((s) => result('series', s)));
      },
      async getTrending(kind) {
        self.calls.push(`trending:${kind}`);
        return self.page([...[...self.movies.values()].map((m) => result('movie', m)), ...[...self.series.values()].map((s) => result('series', s))]);
      },
      async searchMulti(query) {
        self.calls.push(`search:${query}`);
        return self.page([...self.movies.values()].filter((m) => m.title.toLowerCase().includes(query.toLowerCase())).map((m) => result('movie', m)));
      },
      async getGenres() {
        return [
          { tmdbId: 28, name: 'Action' },
          { tmdbId: 16, name: 'Animation' },
        ];
      },
      async getPerson(id) {
        return {
          tmdbId: id,
          name: 'Lead Actor',
          biography: 'Bio',
          cast: [...self.movies.values()].map((m) => ({ ...result('movie', m), character: 'Hero' })),
          crew: [],
        };
      },
      async getNetwork(id) {
        return { tmdbId: id, name: `Network ${id}` };
      },
      async getCompany(id) {
        return { tmdbId: id, name: `Studio ${id}` };
      },
      async findByImdbId() {
        return [];
      },
      async findByTvdbId(tvdbId) {
        return [...self.series.values()].filter((s) => s.tvdbId === tvdbId).map((s) => result('series', s));
      },
    };
    // Only the methods the requests module uses are implemented.
    return client as TmdbClient;
  }

  lookupMovie(id: number): MovieMetadataInput | null {
    const m = this.movies.get(id);
    if (!m) return null;
    return { tmdbId: m.tmdbId, title: m.title, year: m.year, status: 'released', originalLanguage: m.originalLanguage ?? 'en', images: [] };
  }

  lookupSeries(id: number): SeriesMetadataInput | null {
    const s = this.series.get(id);
    if (!s) return null;
    const eps = s.seasons.flatMap((count, season) =>
      Array.from({ length: count }, (_, i) => ({
        seasonNumber: season,
        episodeNumber: i + 1,
        title: `S${season}E${i + 1}`,
        airDateUtc: `${s.year}-0${Math.min(9, season + 1)}-0${Math.min(9, i + 1)}T00:00:00Z`,
      })),
    );
    return {
      tmdbId: s.tmdbId,
      tvdbId: s.tvdbId ?? null,
      title: s.title,
      year: s.year,
      status: 'continuing',
      seasons: s.seasons.map((_, n) => ({ seasonNumber: n })),
      episodes: eps,
    };
  }

  titles(): TitleSource {
    return {
      client: () => this.client(),
      lookupMovie: async (id) => this.lookupMovie(id),
      lookupSeries: async (id) => this.lookupSeries(id),
    };
  }
}

export interface SentNotification {
  kind: string;
  settings: Record<string, unknown>;
  event: NotificationEvent;
}

export function fakeAgents() {
  const sent: SentNotification[] = [];
  const factory = (kind: string, settings: unknown): NotificationAgent => ({
    kind: kind as NotificationAgent['kind'],
    supportedEvents: new Set(),
    async send(event) {
      sent.push({ kind, settings: settings as Record<string, unknown>, event });
    },
    async test() {},
  });
  return { sent, factory };
}

export function makeContext(db: Db): AppContext {
  const log = pino({ level: 'silent' });
  const bus = new EventBus();
  return {
    config: { configDir: '.', dbPath: ':memory:', logDir: '.', port: 0, host: '127.0.0.1', logLevel: 'silent', isDocker: false, webDist: null },
    db,
    bus,
    scheduler: new Scheduler(db, bus, log),
    log,
    startedAt: NOW,
  } as AppContext;
}

let userCounter = 0;

export function addUser(
  db: Db,
  opts: { username?: string; role?: 'admin' | 'user'; permissions?: number; settings?: Record<string, unknown>; email?: string } = {},
): { id: number; actor: Actor } {
  userCounter++;
  const username = opts.username ?? `user${userCounter}`;
  const role = opts.role ?? 'user';
  const permissions = role === 'admin' ? (opts.permissions ?? 0) | Permission.ADMIN : (opts.permissions ?? Permission.REQUEST);
  const row = db
    .insert(users)
    .values({
      username,
      usernameKey: username.toLowerCase(),
      passwordHash: 'x',
      role,
      permissions,
      email: opts.email ?? null,
      settings: opts.settings ?? {},
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    })
    .returning()
    .get();
  return { id: row.id, actor: { userId: row.id, permissions } };
}

export function seedLibraryDefaults(db: Db): { profileId: number } {
  db.insert(rootFolders).values({ path: '/media/movies', mediaType: 'movie' }).run();
  db.insert(rootFolders).values({ path: '/media/tv', mediaType: 'series' }).run();
  const profile = db
    .insert(qualityProfiles)
    .values({ name: 'Any', cutoff: 1, items: [], formatItems: [], languages: [] })
    .returning()
    .get();
  return { profileId: profile.id };
}

function quality(resolution: number): QualityModel {
  return {
    quality: { id: resolution >= 2160 ? 19 : 7, name: resolution >= 2160 ? 'Bluray-2160p' : 'Bluray-1080p', source: 'bluray', resolution, modifier: 'none' },
    revision: { version: 1, real: 0, isRepack: false },
  } as unknown as QualityModel;
}

/** Gives a library movie a file (resolution 1080 or 2160). */
export function giveMovieFile(db: Db, tmdbId: number, resolution = 1080): void {
  const movie = db.select().from(movies).where(eq(movies.tmdbId, tmdbId)).get()!;
  const file = db
    .insert(mediaFiles)
    .values({
      mediaType: 'movie',
      movieId: movie.id,
      relativePath: `${movie.title}.mkv`,
      path: `${movie.path}/${movie.title}-${resolution}.mkv`,
      sizeBytes: 1,
      dateAdded: NOW.toISOString(),
      quality: quality(resolution),
      languages: ['en'],
    })
    .returning()
    .get();
  db.update(movies).set({ hasFile: true, movieFileId: file.id }).where(eq(movies.id, movie.id)).run();
}

/** Gives every episode of one season of a library series a file. */
export function giveSeasonFiles(db: Db, tmdbId: number, seasonNumber: number, resolution = 1080): void {
  const show = db.select().from(series).where(eq(series.tmdbId, tmdbId)).get()!;
  const eps = db.select().from(episodes).where(eq(episodes.seriesId, show.id)).all().filter((e) => e.seasonNumber === seasonNumber);
  for (const e of eps) {
    const file = db
      .insert(mediaFiles)
      .values({
        mediaType: 'series',
        seriesId: show.id,
        seasonNumber,
        relativePath: `S${seasonNumber}E${e.episodeNumber}.mkv`,
        path: `${show.path}/S${seasonNumber}E${e.episodeNumber}-${resolution}.mkv`,
        sizeBytes: 1,
        dateAdded: NOW.toISOString(),
        quality: quality(resolution),
        languages: ['en'],
      })
      .returning()
      .get();
    db.update(episodes).set({ hasFile: true, episodeFileId: file.id }).where(eq(episodes.id, e.id)).run();
  }
}

export interface Harness {
  db: Db;
  ctx: AppContext;
  tmdb: FakeTmdb;
  sent: SentNotification[];
  searches: SearchTarget[];
  services: ReturnType<typeof requestsServicesFor>;
  profileId: number;
}

export async function setup(opts: { watchlistProviders?: WatchlistProvider[]; extra?: Partial<RequestsModuleOptions> } = {}): Promise<Harness> {
  const db = await createTestDb({ ...requestsSchema });
  const ctx = makeContext(db);
  const tmdb = new FakeTmdb();
  const { sent, factory } = fakeAgents();
  const searches: SearchTarget[] = [];
  const { profileId } = seedLibraryDefaults(db);
  const services = requestsServicesFor(ctx, {
    titles: tmdb.titles(),
    agentFactory: factory,
    systemDispatch: async () => [],
    search: async (t) => {
      searches.push(t);
    },
    now: () => NOW,
    ...(opts.watchlistProviders ? { watchlistProviders: opts.watchlistProviders } : {}),
    ...opts.extra,
  });
  return { db, ctx, tmdb, sent, searches, services, profileId };
}

/** Full HTTP stack: auth hook + the requests module, with session cookies per user. */
export async function buildApp(opts: Parameters<typeof setup>[0] = {}) {
  const h = await setup(opts);
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(
    async (api) => {
      installAuth(api, h.ctx);
      await api.register(requestsModuleWith({})(h.ctx));
    },
    { prefix: '/api/v1' },
  );
  await app.ready();
  const auth = authServiceFor(h.ctx);
  const cookieFor = (userId: number) => `${SESSION_COOKIE}=${auth.createSession(userId).token}`;
  return { ...h, app, cookieFor };
}

/** Pins requests to the test clock so quota windows are deterministic. */
export function backdateRequest(db: Db, id: number, iso: string): void {
  db.update(requestsSchema.mediaRequests).set({ createdAt: iso }).where(eq(requestsSchema.mediaRequests.id, id)).run();
}

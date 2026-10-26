import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MetadataError, type EpisodeMetadata, type SeriesMetadata, type TmdbClient, type TmdbClientOptions } from '@arclight/metadata';
import type { AppContext } from '../../app.js';
import type { AppConfig } from '../../config.js';
import type { Db } from '../../db/index.js';
import { createTestDb } from '../../db/test-utils.js';
import { EventBus } from '../../events.js';
import { Scheduler } from '../../scheduler.js';
import { libraryModuleWith, libraryService, type MetadataLookup } from '../library/index.js';
import { settingsService } from '../settings/index.js';
import { refreshAllSeries } from './jobs.js';
import { createMetadataLookup } from './lookup.js';
import { metadataRoutes } from './routes.js';
import { MetadataService } from './service.js';

const log = pino({ level: 'silent' });
let tmp: string;
let db: Db;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'arclight-metadata-'));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});
beforeEach(async () => {
  db = await createTestDb();
  await libraryService.addRootFolder(db, { path: tmp, mediaType: 'series' });
});

const seriesMeta = (overrides: Partial<SeriesMetadata> = {}): SeriesMetadata => ({
  tmdbId: 42,
  title: 'Test Show',
  originalTitle: 'Test Show',
  sortTitle: 'test show',
  year: 2020,
  overview: 'A show.',
  status: 'continuing',
  genres: ['Drama'],
  firstAired: '2020-01-01',
  images: {},
  ratings: { tmdb: { value: 7, votes: 10 } },
  originalLanguage: 'en',
  seasons: [{ seasonNumber: 1, episodeCount: 2 }],
  alternateTitles: [],
  ...overrides,
});

const ep = (n: number): EpisodeMetadata => ({
  tmdbId: 1000 + n,
  seasonNumber: 1,
  episodeNumber: n,
  title: `Episode ${n}`,
  overview: '',
  airDate: '2020-01-0' + n,
  ratings: { tmdb: { value: 0, votes: 0 } },
});

/** A TMDB client double serving one series; only the methods the service calls are real. */
function fakeClient(state: { series: SeriesMetadata; episodes: EpisodeMetadata[] }): TmdbClient {
  const client: Partial<TmdbClient> = {
    async getSeries(tmdbId) {
      if (tmdbId !== state.series.tmdbId) throw new MetadataError('not-found', 'nope', { httpStatus: 404 });
      return state.series;
    },
    async getSeason(_tmdbId, seasonNumber) {
      return state.episodes.filter((e) => e.seasonNumber === seasonNumber);
    },
    async searchMulti() {
      return {
        page: 1,
        totalPages: 1,
        totalResults: 1,
        results: [
          {
            mediaType: 'series',
            tmdbId: state.series.tmdbId,
            title: state.series.title,
            originalTitle: state.series.originalTitle,
            overview: state.series.overview,
            originalLanguage: 'en',
            images: {},
            ratings: state.series.ratings,
          },
        ],
      };
    },
  };
  // The service only touches the methods above; the cast keeps the double small.
  return client as TmdbClient;
}

function ctxFor(): AppContext {
  const bus = new EventBus();
  return {
    config: {} as AppConfig, // not read by the library routes
    db,
    bus,
    scheduler: new Scheduler(db, bus, log),
    log,
    startedAt: new Date(),
  };
}

async function libraryApp(metadata: MetadataLookup) {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(libraryModuleWith({ metadata })(ctxFor()), { prefix: '/api/v1' });
  return app;
}

const addSeries = { tmdbId: 42, qualityProfileId: 1 };

describe('POST /series through the metadata lookup', () => {
  it('answers 400 when no TMDB key is configured', async () => {
    const service = new MetadataService({ db, log, env: {} });
    const app = await libraryApp(createMetadataLookup(() => service));
    const res = await app.inject({ method: 'POST', url: '/api/v1/series', payload: { ...addSeries, rootFolderPath: tmp } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION' });
    expect(res.json().error).toMatch(/TMDB API key/);
  });

  it('adds the series with an injected lookup', async () => {
    const fake: MetadataLookup = {
      series: async (tmdbId) => ({ tmdbId, title: 'Injected', year: 2021, status: 'continuing', episodes: [{ seasonNumber: 1, episodeNumber: 1 }] }),
      movie: async () => null,
    };
    const app = await libraryApp(fake);
    const res = await app.inject({ method: 'POST', url: '/api/v1/series', payload: { ...addSeries, rootFolderPath: tmp } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ tmdbId: 42, title: 'Injected', year: 2021 });
  });

  it('adds the series end to end through MetadataService with a fake client', async () => {
    const service = new MetadataService({
      db,
      log,
      env: { ARCLIGHT_TMDB_API_KEY: 'env-key' },
      createClient: () => fakeClient({ series: seriesMeta(), episodes: [ep(1), ep(2)] }),
    });
    const app = await libraryApp(createMetadataLookup(() => service));
    const res = await app.inject({ method: 'POST', url: '/api/v1/series', payload: { ...addSeries, rootFolderPath: tmp } });
    expect(res.statusCode).toBe(201);
    const episodes = libraryService.listEpisodes(db, { seriesId: res.json().id });
    expect(episodes.map((e) => e.title)).toEqual(['Episode 1', 'Episode 2']);

    const missing = await app.inject({ method: 'POST', url: '/api/v1/series', payload: { ...addSeries, tmdbId: 7, rootFolderPath: tmp } });
    expect(missing.statusCode).toBe(404);
  });
});

describe('MetadataService client lifecycle', () => {
  it('builds lazily and rebuilds when settings change, preferring settings over env', () => {
    const built: TmdbClientOptions[] = [];
    const service = new MetadataService({
      db,
      log,
      env: { ARCLIGHT_TMDB_API_KEY: 'env-key' },
      createClient: (opts) => {
        built.push(opts);
        return fakeClient({ series: seriesMeta(), episodes: [] });
      },
    });
    expect(built).toHaveLength(0);
    const first = service.client();
    expect(service.client()).toBe(first);
    expect(built).toEqual([{ apiKey: 'env-key', language: 'en-US', region: 'US' }]);

    settingsService.setSection(db, 'metadata', { tmdbApiKey: 'ui-key', language: 'de-DE', region: 'DE' });
    expect(service.client()).not.toBe(first);
    expect(built[1]).toEqual({ apiKey: 'ui-key', language: 'de-DE', region: 'DE' });
  });
});

describe('metadata routes', () => {
  async function app(service: MetadataService) {
    const a = Fastify().withTypeProvider<ZodTypeProvider>();
    a.setValidatorCompiler(validatorCompiler);
    a.setSerializerCompiler(serializerCompiler);
    await a.register(metadataRoutes(service), { prefix: '/api/v1' });
    return a;
  }

  it('answers 400 NOT_CONFIGURED without a key', async () => {
    const a = await app(new MetadataService({ db, log, env: {} }));
    const res = await a.inject({ method: 'GET', url: '/api/v1/metadata/search?query=test' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('NOT_CONFIGURED');
  });

  it('searches and fetches series, mapping not-found to 404', async () => {
    const service = new MetadataService({
      db,
      log,
      env: { ARCLIGHT_TMDB_API_KEY: 'k' },
      createClient: () => fakeClient({ series: seriesMeta(), episodes: [] }),
    });
    const a = await app(service);
    const search = await a.inject({ method: 'GET', url: '/api/v1/metadata/search?query=test&type=all' });
    expect(search.statusCode).toBe(200);
    expect(search.json()).toEqual([expect.objectContaining({ mediaType: 'series', tmdbId: 42 })]);

    const one = await a.inject({ method: 'GET', url: '/api/v1/metadata/series/42' });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ tmdbId: 42, title: 'Test Show', seasons: [{ seasonNumber: 1 }] });

    const none = await a.inject({ method: 'GET', url: '/api/v1/metadata/series/9' });
    expect(none.statusCode).toBe(404);
  });
});

describe('RefreshSeries job', () => {
  it('re-fetches every series through the library upsert', async () => {
    const state = { series: seriesMeta(), episodes: [ep(1)] };
    const service = new MetadataService({ db, log, env: { ARCLIGHT_TMDB_API_KEY: 'k' }, createClient: () => fakeClient(state) });
    const meta = await service.lookupSeries(42);
    const added = libraryService.addSeries(db, meta!, {
      tmdbId: 42,
      rootFolderPath: tmp,
      qualityProfileId: 1,
      monitored: true,
      monitorOption: 'all',
      monitorNewItems: 'all',
      seriesType: 'standard',
      seasonFolder: true,
      tags: [],
      searchOnAdd: false,
    });

    state.series = seriesMeta({ overview: 'Updated overview', status: 'ended' });
    state.episodes = [ep(1), ep(2)];
    const message = await refreshAllSeries({ db, service }, { signal: new AbortController().signal, log });
    expect(message).toBe('refreshed 1 of 1 series');

    const after = libraryService.getSeries(db, added.id);
    expect(after).toMatchObject({ overview: 'Updated overview', status: 'ended' });
    expect(libraryService.listEpisodes(db, { seriesId: added.id })).toHaveLength(2);
  });

  it('skips cleanly without a key', async () => {
    const service = new MetadataService({ db, log, env: {} });
    expect(await refreshAllSeries({ db, service }, { signal: new AbortController().signal, log })).toMatch(/skipped/);
  });
});

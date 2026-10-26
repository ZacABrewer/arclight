import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import type { MovieMetadata, SearchResult, SeriesMetadata } from '@arclight/metadata';
import { QualityProfileInput, type ReleaseResource } from '@arclight/shared';
import { buildApp, type AppContext } from '../../app.js';
import type { AppConfig } from '../../config.js';
import { createTestDb } from '../../db/test-utils.js';
import { authServiceFor } from '../auth/index.js';
import { FakeDownloadClient, qbit } from '../download-clients/test-support.js';
import { getDownloadClientsService } from '../download-clients/index.js';
import { indexersServiceFor } from '../indexers/index.js';
import { libraryService as lib, type MetadataLookup, type MovieMetadataInput, type SeriesMetadataInput } from '../library/index.js';
import { ProfilesService } from '../profiles/index.js';
import { HD_ALLOWED, makeProfile, makeRelease, quality } from '../releases/test-support.js';
import { getSection } from '../settings/service.js';
import { parseHistoryEventType, queueRecordId, trackedIdFromQueueId } from './activity.js';
import { slugify, timeSpan } from './common.js';
import { fromV3IndexerCreate, fromV3QualityProfile, toV3Health } from './config.js';
import { compatApi, compatModule, isCompatPublicRoute, type CompatMetadata } from './index.js';
import { parseLookupTerm } from './lookup.js';
import { v3Language, v3QualityById } from './quality.js';

// ---------------------------------------------------------------------------------------
// Golden shapes: every key of the hand-written upstream-like fixture must exist in the
// response with the same JSON type; arrays compare their first elements recursively.
// ---------------------------------------------------------------------------------------

type Golden = Record<string, unknown>;
const load = (name: string): Record<string, Golden> =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Record<string, Golden>;
const GOLDEN = { sonarr: load('sonarr'), radarr: load('radarr'), shared: load('shared'), system: load('system') };

function jsonType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function expectShape(actual: unknown, golden: unknown, path = '$'): void {
  const want = jsonType(golden);
  expect(jsonType(actual), `${path}: expected ${want}, got ${jsonType(actual)} (${JSON.stringify(actual)?.slice(0, 120)})`).toBe(want);
  if (want === 'array') {
    const g = golden as unknown[];
    const a = actual as unknown[];
    if (g.length > 0 && a.length > 0) expectShape(a[0], g[0], `${path}[0]`);
  } else if (want === 'object') {
    const a = actual as Record<string, unknown>;
    for (const [key, value] of Object.entries(golden as Record<string, unknown>)) {
      if (key === '$comment') continue;
      expect(Object.prototype.hasOwnProperty.call(a, key), `${path}.${key} is missing`).toBe(true);
      expectShape(a[key], value, `${path}.${key}`);
    }
  }
}

// ---------------------------------------------------------------------------------------
// Fakes: metadata (TMDB), indexer search results, download client
// ---------------------------------------------------------------------------------------

const HASH = '0123456789abcdef0123456789abcdef01234567';
const TITLE = 'Breaking.Bad.S01E01.1080p.WEB-DL.DDP5.1.H.264-GRP';
const POSTER = 'https://image.tmdb.org/t/p/original/bb.jpg';

const bbMeta: SeriesMetadata = {
  tmdbId: 1396,
  tvdbId: 81189,
  imdbId: 'tt0903747',
  title: 'Breaking Bad',
  originalTitle: 'Breaking Bad',
  sortTitle: 'breaking bad',
  year: 2008,
  overview: 'A chemistry teacher turns to crime.',
  status: 'ended',
  network: 'AMC',
  runtimeMinutes: 47,
  genres: ['Drama'],
  firstAired: '2008-01-20',
  lastAired: '2013-09-29',
  images: { poster: POSTER, backdrop: 'https://image.tmdb.org/t/p/original/bb-fanart.jpg' },
  ratings: { tmdb: { value: 9.4, votes: 31714 } },
  certification: 'TV-MA',
  originalLanguage: 'en',
  seasons: [{ seasonNumber: 1, episodeCount: 2 }],
  alternateTitles: [],
};

const seriesInput = (tmdbId: number, title: string, tvdbId: number): SeriesMetadataInput => ({
  tmdbId,
  tvdbId,
  imdbId: tmdbId === 1396 ? 'tt0903747' : 'tt0944947',
  title,
  year: tmdbId === 1396 ? 2008 : 2011,
  overview: `${title} overview`,
  status: 'ended',
  network: 'AMC',
  runtimeMinutes: 47,
  genres: ['Drama'],
  images: [{ coverType: 'poster', url: POSTER, remoteUrl: POSTER }],
  ratings: { tmdb: { votes: 31714, value: 9.4 } },
  originalLanguage: 'en',
  seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }],
  episodes: [
    { seasonNumber: 1, episodeNumber: 1, title: 'Pilot', airDate: '2020-01-05', airDateUtc: '2020-01-06T02:00:00Z', overview: 'Walter White is diagnosed.', runtimeMinutes: 58 },
    { seasonNumber: 1, episodeNumber: 2, title: "Cat's in the Bag...", airDate: '2020-01-12', airDateUtc: '2020-01-13T02:00:00Z', overview: 'Disposal.', runtimeMinutes: 48 },
    { seasonNumber: 2, episodeNumber: 1, title: 'Seven Thirty-Seven', airDate: '2020-03-08', airDateUtc: '2020-03-09T02:00:00Z', overview: 'Season two.', runtimeMinutes: 47 },
  ],
});

const inceptionMeta: MovieMetadata = {
  tmdbId: 27205,
  imdbId: 'tt1375666',
  title: 'Inception',
  originalTitle: 'Inception',
  sortTitle: 'inception',
  year: 2010,
  overview: 'A thief who steals corporate secrets.',
  status: 'released',
  inCinemas: '2010-07-15',
  digitalRelease: '2010-12-07',
  runtimeMinutes: 148,
  genres: ['Action'],
  studio: 'Legendary Pictures',
  images: { poster: POSTER },
  ratings: { tmdb: { value: 8.4, votes: 35000 } },
  originalLanguage: 'en',
  collection: { tmdbId: 1000, name: 'Inception Collection' },
  alternateTitles: [],
};

const movieInput: MovieMetadataInput = {
  tmdbId: 27205,
  imdbId: 'tt1375666',
  title: 'Inception',
  originalTitle: 'Inception',
  year: 2010,
  overview: 'A thief who steals corporate secrets.',
  status: 'released',
  inCinemas: '2010-07-15',
  digitalRelease: '2010-12-07',
  runtimeMinutes: 148,
  studio: 'Legendary Pictures',
  genres: ['Action'],
  images: [{ coverType: 'poster', url: POSTER, remoteUrl: POSTER }],
  ratings: { tmdb: { votes: 35000, value: 8.4 } },
  originalLanguage: 'en',
  collection: { tmdbId: 1000, title: 'Inception Collection' },
};

const searchHit = (tmdbId: number, title: string, mediaType: 'series' | 'movie'): SearchResult =>
  mediaType === 'series'
    ? { mediaType, tmdbId, title, originalTitle: title, year: 2008, overview: '', originalLanguage: 'en', images: { poster: POSTER }, ratings: { tmdb: { value: 9, votes: 10 } }, firstAired: '2008-01-20' }
    : { mediaType, tmdbId, title, originalTitle: title, year: 2010, overview: '', originalLanguage: 'en', images: { poster: POSTER }, ratings: { tmdb: { value: 8, votes: 10 } }, releaseDate: '2010-07-15' };

const fakeMetadata: CompatMetadata = {
  searchSeries: async (term) => (term.toLowerCase().includes('breaking') ? [searchHit(1396, 'Breaking Bad', 'series')] : []),
  searchMovies: async (term) => (term.toLowerCase().includes('incep') ? [searchHit(27205, 'Inception', 'movie')] : []),
  findByTvdbId: async (id) =>
    id === 81189 ? [searchHit(1396, 'Breaking Bad', 'series')] : id === 121361 ? [searchHit(1399, 'Game of Thrones', 'series')] : [],
  findByImdbId: async (id) => (id === 'tt1375666' ? [searchHit(27205, 'Inception', 'movie')] : []),
  getSeries: async (id) => ({ ...bbMeta, tmdbId: id }),
  getMovie: async (id) => ({ ...inceptionMeta, tmdbId: id }),
  lookupSeries: async (id) => (id === 1396 ? seriesInput(1396, 'Breaking Bad', 81189) : id === 1399 ? seriesInput(1399, 'Game of Thrones', 121361) : null),
  lookupMovie: async (id) => (id === 27205 ? movieInput : null),
};

const libraryMetadata: MetadataLookup = { series: fakeMetadata.lookupSeries, movie: fakeMetadata.lookupMovie };

// ---------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

interface Harness {
  app: Awaited<ReturnType<typeof buildApp>>;
  ctx: AppContext;
  apiKey: string;
  tmp: string;
  tvRoot: string;
  movieRoot: string;
  fakes: FakeDownloadClient[];
  call(method: Method, url: string, payload?: unknown, headers?: Record<string, string>): Promise<LightMyRequestResponse>;
}

async function buildHarness(): Promise<Harness> {
  const tmp = await mkdtemp(join(tmpdir(), 'mt-compat-'));
  const tvRoot = join(tmp, 'tv');
  const movieRoot = join(tmp, 'movies');
  await mkdir(tvRoot, { recursive: true });
  await mkdir(movieRoot, { recursive: true });
  const db = await createTestDb();
  const config: AppConfig = {
    configDir: tmp,
    dbPath: ':memory:',
    logDir: tmp,
    port: 0,
    host: '127.0.0.1',
    logLevel: 'silent',
    isDocker: false,
    webDist: null,
  };
  const fakes: FakeDownloadClient[] = [];
  let ctxRef: AppContext | undefined;
  const app = await buildApp(config, db, pino({ level: 'silent' }), {
    metadata: libraryMetadata,
    compatMetadata: fakeMetadata,
    probe: false,
    onContext: (ctx) => {
      ctxRef = ctx;
      getDownloadClientsService(ctx, {
        directoryExists: async () => true,
        clientFactory: (cfg) => {
          const existing = fakes.find((f) => f.config.id === cfg.id);
          const fake = new FakeDownloadClient(cfg);
          fake.nextId = HASH;
          if (existing) {
            fake.items = existing.items;
            fake.added = existing.added;
          }
          if (cfg.id !== 0) fakes.push(fake);
          return fake;
        },
      });
      const indexers = indexersServiceFor(ctx);
      // Never touch the network: RSS and caps go nowhere.
      indexers.rss = async () => [];
      indexers.search = async () =>
        indexers.list().map(
          (ix): ReleaseResource =>
            makeRelease(TITLE, {
              guid: 'guid-1',
              indexerId: ix.id,
              indexerName: ix.name,
              downloadUrl: `magnet:?xt=urn:btih:${HASH}`,
              infoHash: HASH,
              publishDate: new Date(Date.now() - 60 * 60_000).toISOString(),
              ageMinutes: 60,
              ageHours: 1,
              age: 0,
            }),
        );
    },
  });
  const ctx = ctxRef!;
  // app.ts mounts the compat plugin (with our fake metadata) and the /api/v1 settings routes.
  await app.ready();
  const apiKey = authServiceFor(ctx).apiKey();
  return {
    app,
    ctx,
    apiKey,
    tmp,
    tvRoot,
    movieRoot,
    fakes,
    call: (method, url, payload, headers = {}) =>
      app.inject({
        method,
        url,
        headers: { 'x-api-key': apiKey, ...headers },
        ...(payload === undefined ? {} : { payload: payload as object }),
      }),
  };
}

async function waitForCommand(h: Harness, id: number): Promise<Record<string, unknown>> {
  for (let i = 0; i < 100; i++) {
    const res = await h.call('GET', `/api/v3/command/${id}`);
    const body = res.json<Record<string, unknown>>();
    if (body['status'] !== 'started' && body['status'] !== 'queued') return body;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`command ${id} did not finish`);
}

// ---------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------

describe('compat helpers', () => {
  it('parses lookup terms with tvdb:/tmdb:/imdb: prefixes', () => {
    expect(parseLookupTerm('tvdb:81189')).toEqual({ kind: 'tvdb', id: 81189 });
    expect(parseLookupTerm('TMDB: 1396')).toEqual({ kind: 'tmdb', id: 1396 });
    expect(parseLookupTerm('imdb:tt0903747')).toEqual({ kind: 'imdb', id: 'tt0903747' });
    expect(parseLookupTerm('tt1375666')).toEqual({ kind: 'imdb', id: 'tt1375666' });
    expect(parseLookupTerm('breaking bad')).toEqual({ kind: 'text', text: 'breaking bad' });
  });

  it('encodes per-episode queue ids reversibly', () => {
    expect(queueRecordId(42, 0)).toBe(42);
    const id = queueRecordId(42, 3);
    expect(id).not.toBe(42);
    expect(trackedIdFromQueueId(id)).toBe(42);
    expect(trackedIdFromQueueId(42)).toBe(42);
  });

  it('formats .NET time spans and slugs', () => {
    expect(timeSpan(3_723_000)).toBe('01:02:03');
    expect(timeSpan(90_061_000)).toBe('1.01:01:01');
    expect(timeSpan(undefined)).toBeUndefined();
    expect(slugify('The Office (US)')).toBe('the-office-us');
  });

  it('maps languages and qualities to upstream ids and spellings', () => {
    expect(v3Language('en')).toEqual({ id: 1, name: 'English' });
    expect(v3Language('pt-BR')).toEqual({ id: 18, name: 'Portuguese' });
    expect(v3Language('xx')).toEqual({ id: 0, name: 'Unknown' });
    expect(v3QualityById(3)).toMatchObject({ id: 3, name: 'WEBDL-1080p', source: 'web', resolution: 1080 });
    expect(v3QualityById(3, 'radarr')).toMatchObject({ source: 'webdl' });
  });

  it('parses history event types by number and name', () => {
    expect(parseHistoryEventType('1')).toBe('grabbed');
    expect(parseHistoryEventType('episodeFileDeleted')).toBe('fileDeleted');
    expect(parseHistoryEventType('movieFileRenamed')).toBe('fileRenamed');
    expect(parseHistoryEventType(undefined)).toBeUndefined();
  });

  it('maps a Prowlarr Torznab body onto indexer settings', () => {
    const create = fromV3IndexerCreate({
      name: 'Tracker (Prowlarr)',
      implementation: 'Torznab',
      configContract: 'TorznabSettings',
      priority: 99,
      fields: [
        { name: 'baseUrl', value: 'http://prowlarr:9696/3/' },
        { name: 'apiPath', value: '/api' },
        { name: 'apiKey', value: 'secret' },
        { name: 'categories', value: [5000, 5040] },
        { name: 'seedCriteria.seedTime', value: 60 },
        { name: 'seedCriteria.seedRatio', value: 1.5 },
        { name: 'minimumSeeders', value: 3 },
      ],
    });
    expect(create).toMatchObject({
      implementation: 'torznab',
      priority: 50,
      settings: { baseUrl: 'http://prowlarr:9696/3/', apiKey: 'secret', categories: [5000, 5040], seedTime: 3_600_000, seedRatio: 1.5, minimumSeeders: 3 },
    });
    expect(() => fromV3IndexerCreate({ implementation: 'Rarbg', fields: [] })).toThrow(/Unsupported indexer/);
    expect(() => fromV3IndexerCreate({ implementation: 'Newznab', fields: [] })).toThrow(/Base Url/);
  });

  it('maps a Sonarr quality profile with groups back to our items', () => {
    const input = fromV3QualityProfile({
      name: 'WEB',
      cutoff: 1001,
      items: [
        { quality: { id: 1 }, items: [], allowed: false },
        { id: 1001, name: 'WEB 1080p', items: [{ quality: { id: 3 } }, { quality: { id: 16 } }], allowed: true },
      ],
      formatItems: [{ format: 2, score: 0 }, { format: 3, score: 10 }],
    });
    expect(input.items).toEqual([
      { kind: 'quality', qualityId: 1, allowed: false },
      { kind: 'group', id: 1001, name: 'WEB 1080p', qualityIds: [3, 16], allowed: true },
    ]);
    expect(input.formatItems).toEqual([{ formatId: 3, score: 10 }]);
  });

  it('maps health checks and public probe routes', () => {
    expectShape(toV3Health({ source: 'IndexerStatusCheck', status: 'warning', message: 'x', wikiUrl: 'https://w' }), GOLDEN.system['health']);
    expect(isCompatPublicRoute('/initialize.json')).toBe(true);
    expect(isCompatPublicRoute('/api/v3/series')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// The API, end to end through Fastify inject
// ---------------------------------------------------------------------------------------

describe('compat api', () => {
  let h: Harness;
  let profileId: number;
  let seriesId: number;
  let movieId: number;
  let indexerId: number;

  beforeAll(async () => {
    h = await buildHarness();
    const { id: _id, ...draft } = makeProfile(HD_ALLOWED);
    const res = await h.call('POST', '/api/v1/qualityprofile', QualityProfileInput.parse({ ...draft, name: 'Compat HD' }));
    profileId = res.json<{ id: number }>().id;
  }, 60_000);

  afterAll(async () => {
    await h.app.close();
    await rm(h.tmp, { recursive: true, force: true });
  });

  // ---- auth & probes ----------------------------------------------------------------------
  it('requires an API key on /api/v3 (401 without, header or ?apikey= accepted)', async () => {
    const anon = await h.app.inject({ method: 'GET', url: '/api/v3/series' });
    expect(anon.statusCode).toBe(401);
    expect((await h.app.inject({ method: 'GET', url: '/api/v3/series', headers: { 'x-api-key': 'wrong' } })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'GET', url: '/api/v3/series', headers: { 'x-api-key': h.apiKey } })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: `/api/v3/series?apikey=${h.apiKey}` })).statusCode).toBe(200);
  });

  it('serves the public probes without credentials and leaves /api/v1 unaffected', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/ping' })).json()).toEqual({ status: 'OK' });
    expect((await h.app.inject({ method: 'GET', url: '/api' })).json()).toEqual({ current: 'v3', deprecated: [] });
    const init = await h.app.inject({ method: 'GET', url: '/initialize.json' });
    expect(init.statusCode).toBe(200);
    expectShape(init.json(), GOLDEN.system['initialize']);
    expect(init.json()).not.toHaveProperty('apiKey');
    const js = await h.app.inject({ method: 'GET', url: '/initialize.js' });
    expect(js.headers['content-type']).toContain('javascript');
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/system/ping' })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/series' })).statusCode).toBe(401);
  });

  it('system/status matches the golden shape and reports Arclight', async () => {
    const res = await h.call('GET', '/api/v3/system/status');
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expectShape(body, GOLDEN.system['systemStatus']);
    expect(body['appName']).toBe('Arclight');
    expect(body['instanceName']).toBe('Arclight');
    expect(res.headers['x-application-version']).toBe('4.0.4.0');
  });

  // ---- root folders, profiles ---------------------------------------------------------------
  it('adds root folders from a Sonarr-shaped body', async () => {
    const tv = await h.call('POST', '/api/v3/rootfolder', { path: h.tvRoot });
    expect(tv.statusCode).toBe(201);
    expectShape(tv.json(), GOLDEN.shared['rootFolder']);
    const movies = await h.call('POST', '/api/v3/rootfolder', { path: h.movieRoot });
    expect(movies.json<{ mediaType: string }>().mediaType).toBe('movie');
    const list = (await h.call('GET', '/api/v3/rootfolder')).json<unknown[]>();
    expect(list).toHaveLength(2);
    expectShape(list[0], GOLDEN.shared['rootFolder']);
  });

  it('quality profiles have the items/cutoff shape', async () => {
    const list = (await h.call('GET', '/api/v3/qualityprofile')).json<Array<Record<string, unknown>>>();
    expect(list.length).toBeGreaterThan(0);
    for (const p of list) expectShape(p, GOLDEN.shared['qualityProfile']);
    const one = (await h.call('GET', `/api/v3/qualityprofile/${profileId}`)).json<Record<string, unknown>>();
    expect(one['name']).toBe('Compat HD');
  });

  it('creates and updates a quality profile from a Sonarr body (round trip)', async () => {
    const current = (await h.call('GET', `/api/v3/qualityprofile/${profileId}`)).json<Record<string, unknown>>();
    const created = await h.call('POST', '/api/v3/qualityprofile', { ...current, id: undefined, name: 'Recyclarr Copy' });
    expect(created.statusCode).toBe(201);
    const copy = created.json<Record<string, unknown>>();
    expect(copy['items']).toEqual(current['items']);
    expect(copy['cutoff']).toBe(current['cutoff']);
    const updated = await h.call('PUT', `/api/v3/qualityprofile/${String(copy['id'])}`, { ...copy, upgradeAllowed: false });
    expect(updated.statusCode).toBe(202);
    expect(updated.json<{ upgradeAllowed: boolean }>().upgradeAllowed).toBe(false);
  });

  // ---- series ---------------------------------------------------------------------------------
  it('series/lookup resolves tvdb: terms to full series (golden shape)', async () => {
    const res = await h.call('GET', '/api/v3/series/lookup?term=tvdb:81189');
    expect(res.statusCode).toBe(200);
    const list = res.json<Array<Record<string, unknown>>>();
    expect(list).toHaveLength(1);
    expectShape(list[0], GOLDEN.sonarr['seriesLookup']);
    expect(list[0]).not.toHaveProperty('id');
    const text = (await h.call('GET', '/api/v3/series/lookup?term=breaking')).json<unknown[]>();
    expect(text).toHaveLength(1);
  });

  it('adds a series Overseerr-style (tvdbId only, seasons, addOptions) and returns the Sonarr shape', async () => {
    const res = await h.call('POST', '/api/v3/series', {
      tvdbId: 81189,
      title: 'Breaking Bad',
      qualityProfileId: profileId,
      languageProfileId: 1,
      rootFolderPath: h.tvRoot,
      seasonFolder: true,
      monitored: true,
      seriesType: 'standard',
      tags: [],
      seasons: [
        { seasonNumber: 1, monitored: true },
        { seasonNumber: 2, monitored: false },
      ],
      addOptions: { ignoreEpisodesWithFiles: true, searchForMissingEpisodes: false },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<Record<string, unknown> & { id: number; seasons: Array<{ seasonNumber: number; monitored: boolean }> }>();
    expectShape(body, GOLDEN.sonarr['series']);
    expect(body).toMatchObject({ tvdbId: 81189, tmdbId: 1396, languageProfileId: 1, useSceneNumbering: false, titleSlug: 'breaking-bad' });
    expect(body.seasons.find((s) => s.seasonNumber === 2)?.monitored).toBe(false);
    seriesId = body.id;
  });

  it('refuses a duplicate series with a Sonarr validation array', async () => {
    const res = await h.call('POST', '/api/v3/series', { tvdbId: 81189, qualityProfileId: profileId, rootFolderPath: h.tvRoot });
    expect(res.statusCode).toBe(400);
    const body = res.json<Array<{ propertyName: string; errorMessage: string }>>();
    expect(body[0]).toMatchObject({ propertyName: 'TvdbId', errorMessage: 'This series has already been added' });
  });

  it('lists series, filters by tvdbId and marks lookups that are already in the library', async () => {
    const list = (await h.call('GET', '/api/v3/series')).json<Array<Record<string, unknown>>>();
    expect(list).toHaveLength(1);
    expectShape(list[0], GOLDEN.sonarr['series']);
    expect((await h.call('GET', '/api/v3/series?tvdbId=81189')).json<unknown[]>()).toHaveLength(1);
    expect((await h.call('GET', '/api/v3/series?tvdbId=1')).json<unknown[]>()).toHaveLength(0);
    const lookup = (await h.call('GET', '/api/v3/series/lookup?term=tvdb:81189')).json<Array<{ id?: number; path?: string }>>();
    expect(lookup[0]?.id).toBe(seriesId);
    expect(lookup[0]?.path).toContain('Breaking Bad');
    expect((await h.call('GET', '/api/v3/series/999')).statusCode).toBe(404);
  });

  it('updates a series through PUT (full resource body, 202)', async () => {
    const current = (await h.call('GET', `/api/v3/series/${seriesId}`)).json<Record<string, unknown> & { seasons: Array<Record<string, unknown>> }>();
    const seasons = current.seasons.map((s) => ({ ...s, monitored: s['seasonNumber'] === 2 ? true : s['monitored'] }));
    const res = await h.call('PUT', `/api/v3/series/${seriesId}`, { ...current, monitorNewItems: 'none', seasons });
    expect(res.statusCode).toBe(202);
    const body = res.json<{ monitorNewItems: string; seasons: Array<{ seasonNumber: number; monitored: boolean }> }>();
    expect(body.monitorNewItems).toBe('none');
    expect(body.seasons.find((s) => s.seasonNumber === 2)?.monitored).toBe(true);
  });

  it('episodes match the golden shape and can be (un)monitored', async () => {
    const list = (await h.call('GET', `/api/v3/episode?seriesId=${seriesId}`)).json<Array<Record<string, unknown> & { id: number }>>();
    expect(list).toHaveLength(3);
    expectShape(list[0], GOLDEN.sonarr['episode']);
    const ep = list[2]!;
    const res = await h.call('PUT', `/api/v3/episode/${ep.id}`, { ...ep, monitored: false });
    expect(res.statusCode).toBe(202);
    expect(res.json<{ monitored: boolean }>().monitored).toBe(false);
    const bulk = await h.call('PUT', '/api/v3/episode/monitor', { episodeIds: [ep.id], monitored: true });
    expect(bulk.json<Array<{ monitored: boolean }>>()[0]?.monitored).toBe(true);
    expect((await h.call('GET', '/api/v3/episode')).statusCode).toBe(400);
  });

  it('episode files match the golden shape (and embed into episodes)', async () => {
    const series = lib.getSeries(h.ctx.db, seriesId);
    const ep1 = lib.listEpisodes(h.ctx.db, { seriesId, seasonNumber: 1 }).find((e) => e.episodeNumber === 1)!;
    lib.addMediaFile(h.ctx.db, {
      mediaType: 'series',
      seriesId,
      seasonNumber: 1,
      episodeIds: [ep1.id],
      relativePath: 'Season 01/Breaking Bad - S01E01 - Pilot WEBDL-1080p.mkv',
      path: join(series.path, 'Season 01', 'Breaking Bad - S01E01 - Pilot WEBDL-1080p.mkv'),
      sizeBytes: 1_500_000_000,
      quality: quality('WEBDL-1080p'),
      languages: ['en'],
      releaseGroup: 'GRP',
      sceneName: 'Breaking.Bad.S01E01.1080p.WEB-DL-GRP',
      mediaInfo: { videoCodec: 'h264', audioCodec: 'EAC3', audioChannels: 5.1, resolution: '1920x1080', runtimeSeconds: 3480, audioLanguages: ['eng'], subtitles: ['eng'] },
    });
    const files = (await h.call('GET', `/api/v3/episodefile?seriesId=${seriesId}`)).json<Array<Record<string, unknown> & { id: number }>>();
    expect(files).toHaveLength(1);
    expectShape(files[0], GOLDEN.sonarr['episodeFile']);
    expect((await h.call('GET', `/api/v3/episodefile/${files[0]!.id}`)).statusCode).toBe(200);
    const eps = (await h.call('GET', `/api/v3/episode?seriesId=${seriesId}&includeEpisodeFile=true`)).json<Array<{ episodeNumber: number; seasonNumber: number; episodeFile?: unknown }>>();
    const withFile = eps.find((e) => e.seasonNumber === 1 && e.episodeNumber === 1)!;
    expectShape(withFile.episodeFile, GOLDEN.sonarr['episodeFile']);
  });

  it('wanted/missing is a paged envelope of episodes with series', async () => {
    const res = await h.call('GET', '/api/v3/wanted/missing?page=1&pageSize=10&includeSeries=true&sortKey=airDateUtc&sortDirection=descending');
    expect(res.statusCode).toBe(200);
    const body = res.json<{ records: Array<{ episodeNumber: number; seasonNumber: number }>; totalRecords: number }>();
    expectShape(body, GOLDEN.sonarr['wantedMissing']);
    expect(body.records.some((r) => r.seasonNumber === 1 && r.episodeNumber === 1)).toBe(false);
    expect(body.totalRecords).toBe(body.records.length);
  });

  it('calendar returns Sonarr episodes with the series embedded', async () => {
    const res = await h.call('GET', '/api/v3/calendar?start=2020-01-01&end=2020-01-31&includeSeries=true&unmonitored=true');
    expect(res.statusCode).toBe(200);
    const list = res.json<unknown[]>();
    expect(list).toHaveLength(2);
    expectShape(list[0], GOLDEN.sonarr['calendarEpisode']);
  });

  // ---- movies ----------------------------------------------------------------------------------
  it('movie/lookup handles text, tmdb: and imdb: terms (golden shape)', async () => {
    const text = (await h.call('GET', '/api/v3/movie/lookup?term=inception')).json<unknown[]>();
    expect(text).toHaveLength(1);
    const tmdb = (await h.call('GET', '/api/v3/movie/lookup?term=tmdb:27205')).json<unknown[]>();
    expectShape(tmdb[0], GOLDEN.radarr['movieLookup']);
    const imdb = await h.call('GET', '/api/v3/movie/lookup/imdb?imdbId=tt1375666');
    expect(imdb.json<{ tmdbId: number }>().tmdbId).toBe(27205);
  });

  it('adds a movie Overseerr-style and returns the Radarr shape', async () => {
    const res = await h.call('POST', '/api/v3/movie', {
      title: 'Inception',
      tmdbId: 27205,
      year: 2010,
      qualityProfileId: profileId,
      rootFolderPath: h.movieRoot,
      minimumAvailability: 'released',
      monitored: true,
      tags: [],
      addOptions: { searchForMovie: false },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<Record<string, unknown> & { id: number }>();
    expectShape(body, GOLDEN.radarr['movie']);
    expect(body).toMatchObject({ tmdbId: 27205, titleSlug: '27205', isAvailable: true, hasFile: false });
    movieId = body.id;
    const dup = await h.call('POST', '/api/v3/movie', { tmdbId: 27205, qualityProfileId: profileId, rootFolderPath: h.movieRoot });
    expect(dup.statusCode).toBe(400);
  });

  it('movie files, list filtering, collections and PUT follow the Radarr shapes', async () => {
    const movie = lib.getMovie(h.ctx.db, movieId);
    lib.addMediaFile(h.ctx.db, {
      mediaType: 'movie',
      movieId,
      relativePath: 'Inception (2010) Bluray-1080p.mkv',
      path: join(movie.path, 'Inception (2010) Bluray-1080p.mkv'),
      sizeBytes: 9_000_000_000,
      quality: quality('Bluray-1080p'),
      languages: ['en'],
      releaseGroup: 'GRP',
    });
    const files = (await h.call('GET', `/api/v3/moviefile?movieId=${movieId}`)).json<unknown[]>();
    expect(files).toHaveLength(1);
    expectShape(files[0], GOLDEN.radarr['movieFile']);
    const list = (await h.call('GET', '/api/v3/movie?tmdbId=27205')).json<Array<{ hasFile: boolean; movieFile?: unknown }>>();
    expect(list).toHaveLength(1);
    expect(list[0]?.hasFile).toBe(true);
    expectShape(list[0]?.movieFile, GOLDEN.radarr['movieFile']);
    const collections = (await h.call('GET', '/api/v3/collection')).json<unknown[]>();
    expect(collections).toHaveLength(1);
    expectShape(collections[0], GOLDEN.radarr['collection']);
    const current = (await h.call('GET', `/api/v3/movie/${movieId}`)).json<Record<string, unknown>>();
    const put = await h.call('PUT', `/api/v3/movie/${movieId}`, { ...current, monitored: false, minimumAvailability: 'inCinemas' });
    expect(put.statusCode).toBe(202);
    expect(put.json()).toMatchObject({ monitored: false, minimumAvailability: 'inCinemas' });
  });

  // ---- Prowlarr indexer sync -------------------------------------------------------------------
  it('indexer/schema offers Torznab and Newznab templates with every field Prowlarr sets', async () => {
    const schemas = (await h.call('GET', '/api/v3/indexer/schema')).json<Array<{ implementation: string; fields: Array<{ name: string }> }>>();
    const torznab = schemas.find((s) => s.implementation === 'Torznab')!;
    const names = torznab.fields.map((f) => f.name);
    for (const required of ['baseUrl', 'apiPath', 'apiKey', 'categories', 'animeCategories', 'animeStandardFormatSearch', 'minimumSeeders', 'seedCriteria.seedRatio', 'seedCriteria.seedTime', 'seedCriteria.seasonPackSeedTime', 'rejectBlocklistedTorrentHashesWhileGrabbing']) {
      expect(names).toContain(required);
    }
    expect(schemas.some((s) => s.implementation === 'Newznab')).toBe(true);
  });

  it('accepts a Prowlarr application push and maps it onto a native indexer', async () => {
    const res = await h.call('POST', '/api/v3/indexer?forceSave=true', {
      name: '1337x (Prowlarr)',
      enableRss: true,
      enableAutomaticSearch: true,
      enableInteractiveSearch: true,
      priority: 25,
      implementationName: 'Torznab',
      implementation: 'Torznab',
      configContract: 'TorznabSettings',
      infoLink: 'https://wiki.servarr.com/sonarr/supported#torznab',
      tags: [],
      fields: [
        { name: 'baseUrl', value: 'http://prowlarr:9696/1/' },
        { name: 'apiPath', value: '/api' },
        { name: 'apiKey', value: 'prowlarr-key' },
        { name: 'categories', value: [5000, 5030, 5040] },
        { name: 'animeCategories', value: [5070] },
        { name: 'animeStandardFormatSearch', value: false },
        { name: 'minimumSeeders', value: 1 },
        { name: 'seedCriteria.seedRatio', value: 2 },
        { name: 'seedCriteria.seedTime', value: 120 },
        { name: 'seedCriteria.seasonPackSeedTime', value: 240 },
        { name: 'rejectBlocklistedTorrentHashesWhileGrabbing', value: false },
      ],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<Record<string, unknown> & { id: number; fields: Array<{ name: string; value: unknown }> }>();
    expectShape(body, GOLDEN.shared['indexer']);
    expect(body.fields.find((f) => f.name === 'apiKey')?.value).toBe('********');
    expect(body.fields.find((f) => f.name === 'seedCriteria.seedTime')?.value).toBe(120);
    indexerId = body.id;
    const native = indexersServiceFor(h.ctx).get(indexerId);
    expect(native).toMatchObject({
      implementation: 'torznab',
      protocol: 'torrent',
      settings: { baseUrl: 'http://prowlarr:9696/1', apiKey: 'prowlarr-key', categories: [5000, 5030, 5040], animeCategories: [5070], seedRatio: 2, seedTime: 7_200_000, seasonPackSeedTime: 14_400_000 },
    });
  });

  it('keeps the stored API key when Prowlarr PUTs back the masked value', async () => {
    const current = (await h.call('GET', `/api/v3/indexer/${indexerId}`)).json<Record<string, unknown> & { fields: Array<{ name: string; value: unknown }> }>();
    const fields = current.fields.map((f) => (f.name === 'categories' ? { ...f, value: [5000] } : f));
    const res = await h.call('PUT', `/api/v3/indexer/${indexerId}?forceSave=true`, { ...current, fields, priority: 10 });
    expect(res.statusCode).toBe(202);
    const native = indexersServiceFor(h.ctx).get(indexerId);
    expect(native.settings.apiKey).toBe('prowlarr-key');
    expect(native.settings.categories).toEqual([5000]);
    expect(native.priority).toBe(10);
    const list = (await h.call('GET', '/api/v3/indexer')).json<unknown[]>();
    expect(list).toHaveLength(1);
  });

  it('answers the Prowlarr connection test with X-Application-Version', async () => {
    const res = await h.call('POST', '/api/v3/indexer/test', {
      name: 'Test',
      implementation: 'Newznab',
      configContract: 'NewznabSettings',
      fields: [{ name: 'baseUrl', value: 'http://prowlarr:9696/0/' }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-application-version']).toBe('4.0.4.0');
  });

  // ---- download clients, releases, queue, history, blocklist --------------------------------------
  it('download clients are listed in the provider shape (secrets masked)', async () => {
    expect((await h.call('POST', '/api/v1/downloadclient', qbit('qBittorrent'))).statusCode).toBeLessThan(300);
    const list = (await h.call('GET', '/api/v3/downloadclient')).json<Array<{ fields: Array<{ name: string; value: unknown }> }>>();
    expect(list).toHaveLength(1);
    expectShape(list[0], GOLDEN.shared['downloadClient']);
    expect(list[0]!.fields.find((f) => f.name === 'password')?.value).toBe('********');
  });

  it('interactive search returns release decisions in the Sonarr shape', async () => {
    const ep = lib.listEpisodes(h.ctx.db, { seriesId, seasonNumber: 1 }).find((e) => e.episodeNumber === 2)!;
    const res = await h.call('GET', `/api/v3/release?episodeId=${ep.id}`);
    expect(res.statusCode).toBe(200);
    const list = res.json<Array<Record<string, unknown>>>();
    expect(list.length).toBeGreaterThan(0);
    expectShape(list[0], GOLDEN.shared['release']);
    expect((await h.call('GET', '/api/v3/release')).statusCode).toBe(400);
  });

  it('grabs a release via POST /release and shows it in the queue (golden page)', async () => {
    const ep = lib.listEpisodes(h.ctx.db, { seriesId, seasonNumber: 1 }).find((e) => e.episodeNumber === 2)!;
    const grab = await h.call('POST', '/api/v3/release', { guid: 'guid-1', indexerId, seriesId, episodeId: ep.id });
    expect(grab.statusCode).toBe(200);
    expect(grab.json()).toMatchObject({ downloadId: HASH });
    const queue = await h.call('GET', '/api/v3/queue?page=1&pageSize=10&includeEpisode=true&includeSeries=true');
    expect(queue.statusCode).toBe(200);
    const body = queue.json<{ records: Array<Record<string, unknown>> }>();
    expectShape(body, GOLDEN.shared['queuePage']);
    expect(body.records[0]).toMatchObject({ seriesId, episodeId: ep.id, downloadId: HASH, indexer: '1337x (Prowlarr)' });
    expect(body.records[0]).toHaveProperty('series');
    expect(body.records[0]).toHaveProperty('episode');
    const status = (await h.call('GET', '/api/v3/queue/status')).json();
    expectShape(status, GOLDEN.shared['queueStatus']);
    expect(status).toMatchObject({ totalCount: 1 });
  });

  it('history is a paged envelope with Sonarr event names and filters', async () => {
    const res = await h.call('GET', '/api/v3/history?page=1&pageSize=10&sortKey=date&sortDirection=descending&includeSeries=true&includeEpisode=true');
    expect(res.statusCode).toBe(200);
    const body = res.json<{ records: Array<{ eventType: string; data: Record<string, string> }> }>();
    expectShape(body, GOLDEN.shared['historyPage']);
    expect(body.records[0]?.eventType).toBe('grabbed');
    const grabbedOnly = (await h.call('GET', '/api/v3/history?eventType=1')).json<{ totalRecords: number }>();
    expect(grabbedOnly.totalRecords).toBe(1);
    const failedOnly = (await h.call('GET', '/api/v3/history?eventType=4')).json<{ totalRecords: number }>();
    expect(failedOnly.totalRecords).toBe(0);
    const since = (await h.call('GET', `/api/v3/history/since?date=${encodeURIComponent('2000-01-01T00:00:00Z')}`)).json<unknown[]>();
    expect(since.length).toBeGreaterThan(0);
    const forSeries = (await h.call('GET', `/api/v3/history/series?seriesId=${seriesId}`)).json<unknown[]>();
    expect(forSeries.length).toBe(1);
  });

  it('paging envelope honours page/pageSize/sortDirection', async () => {
    const page = (await h.call('GET', '/api/v3/history?page=2&pageSize=1&sortDirection=ascending')).json<Record<string, unknown>>();
    expect(page).toMatchObject({ page: 2, pageSize: 1, sortKey: 'date', sortDirection: 'ascending' });
    expect(page['records']).toEqual([]);
    const q = (await h.call('GET', '/api/v3/queue?page=1&pageSize=1')).json<Record<string, unknown>>();
    expect(q).toMatchObject({ page: 1, pageSize: 1, sortKey: 'timeleft', sortDirection: 'ascending', totalRecords: 1 });
    const missing = (await h.call('GET', '/api/v3/wanted/missing?pageSize=1')).json<Record<string, unknown> & { records: unknown[] }>();
    expect(missing['pageSize']).toBe(1);
    expect(missing.records.length).toBeLessThanOrEqual(1);
  });

  it('removing a queue item with blocklist=true fills the blocklist (golden page)', async () => {
    const queue = (await h.call('GET', '/api/v3/queue')).json<{ records: Array<{ id: number }> }>();
    const del = await h.call('DELETE', `/api/v3/queue/${queue.records[0]!.id}?removeFromClient=true&blocklist=true&skipRedownload=true`);
    expect(del.statusCode).toBe(200);
    expect((await h.call('GET', '/api/v3/queue')).json<{ totalRecords: number }>().totalRecords).toBe(0);
    const res = await h.call('GET', '/api/v3/blocklist?page=1&pageSize=10');
    const body = res.json<{ records: Array<{ id: number; sourceTitle: string }> }>();
    expectShape(body, GOLDEN.shared['blocklistPage']);
    expect(body.records[0]?.sourceTitle).toBe(TITLE);
    expect((await h.call('DELETE', `/api/v3/blocklist/${body.records[0]!.id}`)).statusCode).toBe(200);
    expect((await h.call('GET', '/api/v3/blocklist')).json<{ totalRecords: number }>().totalRecords).toBe(0);
  });

  it('release/push decides a pushed release and answers with the decision list', async () => {
    const res = await h.call('POST', '/api/v3/release/push', {
      title: 'Breaking.Bad.S02E01.1080p.WEB-DL.DDP5.1.H.264-GRP',
      downloadUrl: 'magnet:?xt=urn:btih:fedcba9876543210fedcba9876543210fedcba98',
      protocol: 'torrent',
      publishDate: new Date(Date.now() - 3_600_000).toISOString(),
      size: 1_500_000_000,
      indexer: 'autobrr',
    });
    expect(res.statusCode).toBe(200);
    const list = res.json<Array<Record<string, unknown>>>();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: 'Breaking.Bad.S02E01.1080p.WEB-DL.DDP5.1.H.264-GRP', protocol: 'torrent', seriesId });
  });

  // ---- commands ----------------------------------------------------------------------------------
  it('maps SeriesSearch to a tracked command resolvable through GET /command/:id', async () => {
    const res = await h.call('POST', '/api/v3/command', { name: 'SeriesSearch', seriesId });
    expect(res.statusCode).toBe(201);
    const cmd = res.json<Record<string, unknown> & { id: number; body: Record<string, unknown> }>();
    expectShape(cmd, GOLDEN.shared['command']);
    expect(cmd.body['seriesId']).toBe(seriesId);
    const done = await waitForCommand(h, cmd.id);
    expect(done).toMatchObject({ name: 'SeriesSearch', status: 'completed', result: 'successful' });
    expect(String(done['message'])).toMatch(/releases found/);
    const recent = (await h.call('GET', '/api/v3/command')).json<Array<{ id: number }>>();
    expect(recent.some((c) => c.id === cmd.id)).toBe(true);
  });

  it('maps scheduler commands (RssSync, MissingEpisodeSearch) onto job runs', async () => {
    for (const name of ['RssSync', 'MissingEpisodeSearch']) {
      const res = await h.call('POST', '/api/v3/command', { name });
      expect(res.statusCode).toBe(201);
      const cmd = res.json<{ id: number; name: string }>();
      expect(cmd.name).toBe(name);
      const done = await waitForCommand(h, cmd.id);
      expect(['completed', 'failed']).toContain(done['status']);
    }
  });

  it('runs RefreshSeries / RefreshMovie / RescanSeries for single items and rejects unknown commands', async () => {
    const refresh = (await h.call('POST', '/api/v3/command', { name: 'RefreshSeries', seriesId })).json<{ id: number }>();
    expect(await waitForCommand(h, refresh.id)).toMatchObject({ status: 'completed', message: 'refreshed Breaking Bad' });
    const movie = (await h.call('POST', '/api/v3/command', { name: 'RefreshMovie', movieIds: [movieId] })).json<{ id: number }>();
    expect(await waitForCommand(h, movie.id)).toMatchObject({ status: 'completed' });
    const rescan = (await h.call('POST', '/api/v3/command', { name: 'RescanSeries', seriesId })).json<{ id: number }>();
    expect((await waitForCommand(h, rescan.id))['status']).toBe('completed');
    const unknown = await h.call('POST', '/api/v3/command', { name: 'DoTheThing' });
    expect(unknown.statusCode).toBe(400);
    const missingBody = await h.call('POST', '/api/v3/command', { name: 'EpisodeSearch' });
    expect(missingBody.statusCode).toBe(400);
    expect((await h.call('GET', '/api/v3/command/99999')).statusCode).toBe(404);
  });

  // ---- shared resources ---------------------------------------------------------------------------
  it('tags support create (idempotent by label), rename and delete', async () => {
    const created = await h.call('POST', '/api/v3/tag', { label: 'anime' });
    expect(created.statusCode).toBe(201);
    expectShape(created.json(), GOLDEN.shared['tag']);
    const again = await h.call('POST', '/api/v3/tag', { label: 'Anime' });
    expect(again.json<{ id: number }>().id).toBe(created.json<{ id: number }>().id);
    const id = created.json<{ id: number }>().id;
    expect((await h.call('PUT', `/api/v3/tag/${id}`, { id, label: 'kids' })).json()).toEqual({ id, label: 'kids' });
    expect((await h.call('GET', '/api/v3/tag')).json<unknown[]>()).toHaveLength(1);
    expect((await h.call('DELETE', `/api/v3/tag/${id}`)).statusCode).toBe(200);
  });

  it('languages and the legacy language profile match the golden shapes', async () => {
    const langs = (await h.call('GET', '/api/v3/language')).json<Array<{ id: number; name: string }>>();
    expectShape(langs[0], GOLDEN.shared['language']);
    expect(langs.find((l) => l.name === 'English')?.id).toBe(1);
    const profiles = (await h.call('GET', '/api/v3/languageprofile')).json<unknown[]>();
    expectShape(profiles[0], GOLDEN.shared['languageProfile']);
  });

  it('quality definitions match the golden shape and accept PUT /update', async () => {
    const defs = (await h.call('GET', '/api/v3/qualitydefinition')).json<Array<Record<string, unknown> & { quality: { id: number } }>>();
    const web = defs.find((d) => d.quality.id === 3)!;
    expectShape(web, GOLDEN.shared['qualityDefinition']);
    const res = await h.call('PUT', '/api/v3/qualitydefinition/update', [{ ...web, minSize: 5, maxSize: 100, preferredSize: 50 }]);
    expect(res.statusCode).toBe(202);
    expect(res.json<Array<Record<string, unknown>>>()[0]).toMatchObject({ minSize: 5, maxSize: 100, preferredSize: 50 });
  });

  it('custom formats, delay and release profiles are listed in the Sonarr shape', async () => {
    const profiles = new ProfilesService({ db: h.ctx.db });
    profiles.createCustomFormat({ name: 'x265', includeWhenRenaming: false, specifications: [{ implementation: 'releaseTitle', name: 'x265', negate: false, required: false, fields: { pattern: 'x265' } }] });
    const formats = (await h.call('GET', '/api/v3/customformat')).json<Array<{ name: string }>>();
    expectShape(formats.find((f) => f.name === 'x265'), GOLDEN.shared['customFormat']);
    const delays = (await h.call('GET', '/api/v3/delayprofile')).json<unknown[]>();
    expect(delays.length).toBeGreaterThan(0);
    expectShape(delays[0], GOLDEN.shared['delayProfile']);
    expect((await h.call('GET', '/api/v3/releaseprofile')).statusCode).toBe(200);
    const qp = (await h.call('GET', `/api/v3/qualityprofile/${profileId}`)).json<{ formatItems: Array<{ name: string }> }>();
    expect(qp.formatItems.some((f) => f.name === 'x265')).toBe(true);
  });

  it('notification and import list lists answer in the provider shape', async () => {
    expect((await h.call('GET', '/api/v3/notification')).json()).toEqual([]);
    expect((await h.call('GET', '/api/v3/importlist')).json()).toEqual([]);
  });

  it('config/host, naming, mediamanagement and ui match the golden shapes', async () => {
    const host = (await h.call('GET', '/api/v3/config/host')).json<{ apiKey: string }>();
    expectShape(host, GOLDEN.system['configHost']);
    expect(host.apiKey).toBe(h.apiKey);
    expectShape((await h.call('GET', '/api/v3/config/naming')).json(), GOLDEN.system['configNaming']);
    expectShape((await h.call('GET', '/api/v3/config/mediamanagement')).json(), GOLDEN.system['configMediaManagement']);
    expectShape((await h.call('GET', '/api/v3/config/ui')).json(), GOLDEN.system['configUi']);
  });

  it('health, system/task, system/backup, diskspace and filesystem answer', async () => {
    const health = await h.call('GET', '/api/v3/health');
    expect(health.statusCode).toBe(200);
    for (const item of health.json<unknown[]>()) expectShape(item, GOLDEN.system['health']);
    const tasks = (await h.call('GET', '/api/v3/system/task')).json<Array<{ taskName: string; interval: number }>>();
    const rss = tasks.find((t) => t.taskName === 'RssSync')!;
    expectShape(rss, GOLDEN.system['systemTask']);
    expect(rss.interval).toBe(15);
    expect((await h.call('GET', '/api/v3/system/backup')).json()).toEqual([]);
    expect(Array.isArray((await h.call('GET', '/api/v3/diskspace')).json())).toBe(true);
    const fs = await h.call('GET', `/api/v3/filesystem?path=${encodeURIComponent(h.tmp)}`);
    expect(fs.statusCode).toBe(200);
    // The config dir also gains folders modules create at startup (e.g. indexers' definitions/).
    expect(fs.json<{ directories: Array<{ name: string; type: string }> }>().directories.map((d) => d.name)).toEqual(
      expect.arrayContaining(['movies', 'tv']),
    );
  });

  // ---- deletes, settings toggle ------------------------------------------------------------------
  it('adds a second series by tvdbId, then deletes it with an import exclusion', async () => {
    const added = await h.call('POST', '/api/v3/series', {
      tvdbId: 121361,
      qualityProfileId: profileId,
      path: join(h.tvRoot, 'Game of Thrones (2011)'),
      addOptions: { monitor: 'firstSeason', searchForMissingEpisodes: false },
    });
    expect(added.statusCode).toBe(201);
    const body = added.json<{ id: number; tmdbId: number; seasons: Array<{ seasonNumber: number; monitored: boolean }> }>();
    expect(body.tmdbId).toBe(1399);
    expect(body.seasons.find((s) => s.seasonNumber === 2)?.monitored).toBe(false);
    const del = await h.call('DELETE', `/api/v3/series/${body.id}?deleteFiles=false&addImportListExclusion=true`);
    expect(del.statusCode).toBe(200);
    expect(lib.listImportExclusions(h.ctx.db).some((e) => e.tmdbId === 1399)).toBe(true);
    expect((await h.call('GET', `/api/v3/series/${body.id}`)).statusCode).toBe(404);
  });

  it('deletes a movie file and the movie', async () => {
    const files = (await h.call('GET', `/api/v3/moviefile?movieId=${movieId}`)).json<Array<{ id: number }>>();
    expect((await h.call('DELETE', `/api/v3/moviefile/${files[0]!.id}`)).statusCode).toBe(200);
    expect((await h.call('DELETE', `/api/v3/movie/${movieId}?deleteFiles=false`)).statusCode).toBe(200);
    expect((await h.call('GET', '/api/v3/movie')).json()).toEqual([]);
  });

  it('honours compat.enabled and compat.instanceName from /api/v1/settings/compat', async () => {
    const current = (await h.call('GET', '/api/v1/settings/compat')).json<Record<string, unknown>>();
    expect(current).toMatchObject({ enabled: true, instanceName: 'Arclight' });
    const renamed = await h.call('PUT', '/api/v1/settings/compat', { ...current, instanceName: 'Basement' });
    expect(renamed.statusCode).toBe(200);
    expect((await h.call('GET', '/api/v3/system/status')).json<{ instanceName: string }>().instanceName).toBe('Basement');
    await h.call('PUT', '/api/v1/settings/compat', { ...current, enabled: false });
    expect(getSection(h.ctx.db, 'compat').enabled).toBe(false);
    expect((await h.call('GET', '/api/v3/system/status')).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: '/ping' })).statusCode).toBe(404);
    expect((await h.call('GET', '/api/v1/system/status')).statusCode).toBe(200);
    await h.call('PUT', '/api/v1/settings/compat', { ...current, enabled: true });
    expect((await h.call('GET', '/api/v3/system/status')).statusCode).toBe(200);
  });
});

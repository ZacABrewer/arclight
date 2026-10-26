import pino from 'pino';
import type { ImportListCreateInput } from '@media-tron/shared';
import { ImportListCreate } from '@media-tron/shared';
import type { Db } from '../../db/index.js';
import { qualityProfiles, rootFolders } from '../../db/schema.js';
import { createTestDb } from '../../db/test-utils.js';
import type { MetadataLookup } from '../library/index.js';
import { settingsService } from '../settings/index.js';
import type { FetchLike, ProviderContext } from './providers/index.js';
import { createTmdbAccess } from './providers/index.js';
import * as tables from './schema.js';
import { ImportListsService, type ImportListsServiceOptions } from './service.js';

// Test helpers; not used by production code.

export const silentLog = pino({ level: 'silent' });

export interface FakeCall {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (url: URL, call: FakeCall) => Response | unknown | Promise<Response | unknown>;

/** A routing fake fetch: first route whose pattern matches `host + path` answers. Unmatched: 404. */
export function fakeFetch(routes: Array<[RegExp, Handler]>): FetchLike & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const fn = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const call: FakeCall = { url, method: init.method ?? 'GET', headers, body };
    calls.push(call);
    const target = `${url.host}${url.pathname}`;
    for (const [pattern, handler] of routes) {
      if (pattern.test(target)) {
        const out = await handler(url, call);
        return out instanceof Response ? out : json(out);
      }
    }
    return new Response('not found', { status: 404 });
  };
  return Object.assign(fn, { calls });
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export const TMDB_CONFIGURATION: [RegExp, Handler] = [
  /themoviedb\.org\/3\/configuration$/,
  () => ({ images: { secure_base_url: 'https://image.tmdb.org/t/p/', poster_sizes: ['w500', 'original'], backdrop_sizes: ['original'] } }),
];

/** A provider context over a fake fetch with TMDB configured. */
export function providerCtx(fetch: FetchLike, overrides: Partial<ProviderContext> = {}): ProviderContext & { saved: Record<string, unknown>[] } {
  const saved: Record<string, unknown>[] = [];
  const access = createTmdbAccess({ apiKey: 'tmdb-key', language: 'en-US', region: 'US', fetch });
  return {
    fetch,
    log: silentLog,
    now: () => new Date('2026-10-25T12:00:00Z'),
    tmdb: () => access,
    saveSettings: (p) => saved.push(p),
    saved,
    ...overrides,
  };
}

/** Metadata lookup that fabricates minimal titles; ids in `missing` are "not found". */
export function fakeMetadata(missing: number[] = []): MetadataLookup & { calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    series: async (tmdbId) => {
      calls.push(tmdbId);
      if (missing.includes(tmdbId)) return null;
      return {
        tmdbId,
        title: `Show ${tmdbId}`,
        year: 2020,
        status: 'continuing',
        seasons: [{ seasonNumber: 1 }],
        episodes: [{ seasonNumber: 1, episodeNumber: 1, airDate: '2020-01-01', airDateUtc: '2020-01-01T00:00:00Z' }],
      };
    },
    movie: async (tmdbId) => {
      calls.push(tmdbId);
      if (missing.includes(tmdbId)) return null;
      return { tmdbId, title: `Movie ${tmdbId}`, year: 2021, status: 'released' };
    },
  };
}

export interface Setup {
  db: Db;
  service: ImportListsService;
  metadata: ReturnType<typeof fakeMetadata>;
  searches: Array<{ seriesId: number } | { movieId: number }>;
  clock: { now: Date };
  profileId: number;
}

export async function setup(
  fetch: FetchLike,
  opts: Partial<ImportListsServiceOptions> & { tmdbKey?: string | null } = {},
): Promise<Setup> {
  const db = await createTestDb({ ...tables });
  db.insert(rootFolders).values([{ path: '/tv', mediaType: 'series' }, { path: '/movies', mediaType: 'movie' }]).run();
  const profile = db
    .insert(qualityProfiles)
    .values({ name: 'Any', cutoff: 1, items: [], formatItems: [], languages: [] })
    .returning()
    .get();
  if (opts.tmdbKey !== null) {
    settingsService.setSection(db, 'metadata', { tmdbApiKey: opts.tmdbKey ?? 'tmdb-key', language: 'en-US', region: 'US' });
  }
  const metadata = fakeMetadata();
  const searches: Setup['searches'] = [];
  const clock = { now: new Date('2026-10-25T12:00:00Z') };
  const service = new ImportListsService({
    db,
    log: silentLog,
    metadata,
    fetch,
    env: {},
    now: () => clock.now,
    search: async (t) => {
      searches.push(t);
    },
    ...opts,
  });
  return { db, service, metadata, searches, clock, profileId: profile.id };
}

export function listInput(profileId: number, over: Partial<ImportListCreateInput> = {}): ImportListCreate {
  return ImportListCreate.parse({
    name: 'My list',
    implementation: 'rss',
    rootFolderPath: '/movies',
    qualityProfileId: profileId,
    mediaType: 'movie',
    settings: { url: 'https://feeds.example/list.json' },
    ...over,
  });
}

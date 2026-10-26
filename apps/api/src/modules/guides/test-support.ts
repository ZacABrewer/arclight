import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import type { NotificationEvent } from '@arclight/notifications';
import type { GuidesSettingsInput } from '@arclight/shared';
import { GuidesSettings } from '@arclight/shared';
import { createTestDb } from '../../db/test-utils.js';
import { ProfilesService } from '../profiles/service.js';
import { setSection } from '../settings/service.js';
import * as tables from './schema.js';
import { GuidesService } from './service.js';
import type { FetchLike } from './source.js';

// Test helpers: the recorded TRaSH response set (fixtures/trash) served by a fake fetch.
// Not used by production code.

const FIXTURES = fileURLToPath(new URL('./fixtures/trash/', import.meta.url));
export const RAW_BASE = 'https://raw.githubusercontent.com/TRaSH-Guides/Guides/master/';
export const API_BASE = 'https://api.github.com/repos/TRaSH-Guides/Guides/contents/';

export interface FakeResponse {
  status?: number;
  body: string;
  etag?: string;
}

/** Recorded guide files keyed by repo path (`metadata.json`, `docs/json/radarr/cf/x.json`). */
export function recordedFiles(): Map<string, string> {
  const out = new Map<string, string>();
  const root = join(FIXTURES, 'files');
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.set(relative(root, full).split('\\').join('/'), readFileSync(full, 'utf8'));
    }
  };
  walk(root);
  return out;
}

export function recordedEtag(path: string): string | undefined {
  const rec = JSON.parse(readFileSync(join(FIXTURES, 'recording.json'), 'utf8')) as { responses: Array<{ path: string; etag: string }> };
  return rec.responses.find((r) => r.path === path)?.etag;
}

export function listing(dir: string): string {
  return readFileSync(join(FIXTURES, 'listings', `${dir.split('/').join('_')}.json`), 'utf8');
}

/** URL → response map built from the recording (raw files + contents-API listings). */
export function recordedRoutes(): Map<string, FakeResponse> {
  const routes = new Map<string, FakeResponse>();
  for (const [path, body] of recordedFiles()) {
    const etag = recordedEtag(path);
    routes.set(`${RAW_BASE}${path}`, { body, ...(etag ? { etag } : {}) });
  }
  for (const dir of ['docs/json/radarr/cf', 'docs/json/radarr/quality-profiles']) {
    routes.set(`${API_BASE}${dir}?ref=master`, { body: listing(dir), etag: `"listing-${dir}"` });
  }
  return routes;
}

export interface FakeFetch extends FetchLike {
  calls: Array<{ url: string; ifNoneMatch: string | undefined }>;
  routes: Map<string, FakeResponse>;
}

/** Serves `routes`; honours If-None-Match against the route's etag (304); unknown URLs are 404. */
export function fakeFetch(routes: Map<string, FakeResponse> = recordedRoutes()): FakeFetch {
  const calls: FakeFetch['calls'] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const ifNoneMatch = headers['if-none-match'];
    calls.push({ url, ifNoneMatch });
    const r = routes.get(url);
    if (!r) return new Response('not found', { status: 404 });
    if (r.etag && ifNoneMatch === r.etag) return new Response(null, { status: 304, headers: { etag: r.etag } });
    return new Response(r.body, { status: r.status ?? 200, headers: r.etag ? { etag: r.etag } : {} });
  }) as FakeFetch;
  fn.calls = calls;
  fn.routes = routes;
  return fn;
}

/** Profile 4 of the seeded defaults is HD-1080p. */
export const HD1080_PROFILE_ID = 4;

export async function setup(settings: GuidesSettingsInput = {}, routes?: Map<string, FakeResponse>) {
  const db = await createTestDb(tables);
  const profiles = new ProfilesService({ db });
  profiles.seedDefaults();
  setSection(
    db,
    'guides',
    GuidesSettings.parse({
      enabled: true,
      profiles: [{ guideProfileName: 'HD Bluray + WEB', localQualityProfileId: HD1080_PROFILE_ID }],
      ...settings,
    }),
  );
  const fetch = fakeFetch(routes);
  const notifications: NotificationEvent[] = [];
  let clock = new Date('2026-10-26T12:00:00.000Z');
  const service = new GuidesService({
    db,
    fetch,
    log: pino({ level: 'silent' }),
    notify: async (e) => {
      notifications.push(e);
    },
    now: () => clock,
  });
  return {
    db,
    profiles,
    service,
    fetch,
    notifications,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

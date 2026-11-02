import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type AppContext } from '../../app.js';
import type { AppConfig } from '../../config.js';
import type { Db } from '../../db/index.js';
import { createTestDb, seedAdmin } from '../../db/test-utils.js';
import { authServiceFor } from '../auth/index.js';
import { setSection } from '../settings/service.js';
import type { Transport } from './http.js';
import { podcastsRuntimeFor } from './index.js';

// The podcast routes over the full app with the API key: the feature gate, subscribe, episode
// paging, played state, OPML export and settings. Feeds come from a scripted transport.

const config: AppConfig = { configDir: '.', dbPath: ':memory:', logDir: '.', port: 0, host: '127.0.0.1', logLevel: 'silent', isDocker: false, webDist: null };
const FEED = 'https://feeds.example.com/show.xml';
const XML = `<?xml version="1.0"?><rss version="2.0"><channel><title>Route Show</title>
<item><title>First</title><guid>r1</guid><pubDate>Wed, 01 Jan 2025 10:00:00 GMT</pubDate><enclosure url="https://cdn.example.com/r1.mp3" type="audio/mpeg"/></item>
<item><title>Second</title><guid>r2</guid><pubDate>Wed, 08 Jan 2025 10:00:00 GMT</pubDate><enclosure url="https://cdn.example.com/r2.mp3" type="audio/mpeg"/></item>
</channel></rss>`;

const transport: Transport = async (url) => (url === FEED ? new Response(XML, { status: 200 }) : new Response('nope', { status: 404 }));

let db: Db;
let root: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let key: string;

const api = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { 'x-api-key': key }, ...(payload === undefined ? {} : { payload: payload as object }) });

beforeEach(async () => {
  db = await createTestDb();
  seedAdmin(db);
  root = mkdtempSync(join(tmpdir(), 'arclight-podcast-routes-'));
  // Backlog 0: nothing is queued, so no download run starts behind the test's back.
  setSection(db, 'podcasts', { rootFolder: root, defaults: { backlog: 0 } });
  let ctxRef: AppContext | undefined;
  app = await buildApp(config, db, pino({ level: 'silent' }), {
    probe: false,
    onContext: (ctx) => {
      ctxRef = ctx;
      podcastsRuntimeFor(ctx, { transport: () => transport, tagger: { tag: async () => false }, notify: async () => undefined, refreshMediaServers: async () => undefined });
    },
  });
  await app.ready();
  key = authServiceFor(ctxRef!).apiKey();
});

afterEach(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

describe('podcast routes', () => {
  it('answer 404 while the feature is off, settings excepted', async () => {
    setSection(db, 'features', { music: false, audiobooks: false, podcasts: false });
    expect((await api('GET', '/podcast')).statusCode).toBe(404);
    expect((await api('GET', '/settings/podcasts')).statusCode).toBe(200);
  });

  it('subscribe, list episodes, mark played and export OPML', async () => {
    setSection(db, 'features', { music: false, audiobooks: false, podcasts: true });
    const added = await api('POST', '/podcast', { feedUrl: FEED });
    expect(added.statusCode).toBe(201);
    const podcast = added.json() as { id: number; title: string };
    expect(podcast.title).toBe('Route Show');
    expect((await api('POST', '/podcast', { feedUrl: FEED })).statusCode).toBe(409);

    const list = (await api('GET', '/podcast')).json() as unknown[];
    expect(list).toHaveLength(1);

    const page = (await api('GET', `/podcast/episode?podcastId=${podcast.id}&sortDirection=asc`)).json() as { totalRecords: number; records: { id: number; title: string }[] };
    expect(page.totalRecords).toBe(2);
    expect(page.records.map((r) => r.title)).toEqual(['First', 'Second']);

    const played = await api('PUT', `/podcast/episode/${page.records[0]!.id}`, { played: true });
    expect(played.statusCode).toBe(200);
    expect((played.json() as { played: boolean }).played).toBe(true);
    expect(((await api('GET', `/podcast/episode?podcastId=${podcast.id}&played=false`)).json() as { totalRecords: number }).totalRecords).toBe(1);

    const opml = await api('GET', '/podcast/opml');
    expect(opml.statusCode).toBe(200);
    expect(opml.headers['content-disposition']).toContain('attachment');
    expect(opml.body).toContain(FEED);

    expect((await api('GET', '/podcast/999')).statusCode).toBe(404);
    expect((await api('DELETE', `/podcast/${podcast.id}`)).statusCode).toBeLessThan(300);
    expect((await api('GET', '/podcast')).json()).toEqual([]);
  });

  it('validates the settings and masks the Podcast Index secret', async () => {
    const put = await api('PUT', '/settings/podcasts', { podcastIndexKey: 'KEY', podcastIndexSecret: 'SECRET', refreshIntervalMinutes: 30 });
    expect(put.statusCode).toBe(200);
    const got = (await api('GET', '/settings/podcasts')).json() as { podcastIndexSecret: string | null; refreshIntervalMinutes: number };
    expect(got.refreshIntervalMinutes).toBe(30);
    expect(got.podcastIndexSecret).not.toBe('SECRET');
    expect((await api('PUT', '/settings/podcasts', { refreshIntervalMinutes: 1 })).statusCode).toBe(400);
  });
});

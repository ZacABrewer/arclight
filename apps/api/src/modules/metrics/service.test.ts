import Fastify from 'fastify';
import pino from 'pino';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import type { Job } from '@arclight/shared';
import type { AppContext } from '../../app.js';
import type { AppConfig } from '../../config.js';
import { createTestDb } from '../../db/test-utils.js';
import type { Db } from '../../db/index.js';
import { downloadClients, indexerStats, indexerStatus, indexers, mediaRequests, movies, trackedDownloads } from '../../db/schema.js';
import { EventBus } from '../../events.js';
import { Scheduler } from '../../scheduler.js';
import { authServiceFor } from '../auth/context.js';
import { getSection, setSection } from '../settings/service.js';
import { installMetrics, metricsModule } from './index.js';
import { MetricsService } from './service.js';

const NOW = Date.parse('2026-06-01T12:00:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function job(id: number, name: string, status: Job['status'], durationMs: number | null = null): Job {
  return { id, name, status, trigger: 'scheduled', message: null, queuedAt: iso(0), startedAt: iso(0), endedAt: null, durationMs };
}

function value(text: string, sample: string): number | undefined {
  const line = text.split('\n').find((l) => l.startsWith(sample + ' '));
  return line === undefined ? undefined : Number(line.slice(sample.length + 1));
}

function tracked(db: Db, clientId: number, state: 'downloading' | 'importPending', size: number, sizeLeft: number, id: string) {
  db.insert(trackedDownloads)
    .values({ downloadId: id, clientId, title: id, state, statusMessages: [], protocol: 'torrent', size, sizeLeft, addedAt: iso(0), updatedAt: iso(0) })
    .run();
}

describe('metrics service', () => {
  it('counts job runs, failures, durations and running jobs from bus events', async () => {
    const service = new MetricsService({ db: await createTestDb(), now: () => NOW });
    service.onEvent({ type: 'job', job: job(1, 'RssSync', 'running') });
    expect(service.jobsRunning.get({ job: 'RssSync' })).toBe(1);
    service.onEvent({ type: 'job', job: job(1, 'RssSync', 'completed', 1500) });
    service.onEvent({ type: 'job', job: job(2, 'RssSync', 'running') });
    service.onEvent({ type: 'job', job: job(2, 'RssSync', 'failed', 200) });
    expect(service.jobsRunning.get({ job: 'RssSync' })).toBe(0);
    expect(service.jobRuns.get({ job: 'RssSync', status: 'completed' })).toBe(1);
    expect(service.jobRuns.get({ job: 'RssSync', status: 'failed' })).toBe(1);
    expect(service.jobFailures.get({ job: 'RssSync' })).toBe(1);
    expect(service.jobDuration.count({ job: 'RssSync' })).toBe(2);
    const text = await service.render();
    expect(text).toContain('arclight_job_duration_seconds_sum{job="RssSync"} 1.7');
  });

  it('counts grabs and imports', async () => {
    const service = new MetricsService({ db: await createTestDb() });
    service.onEvent({ type: 'release', action: 'grabbed', title: 'x' });
    service.onEvent({ type: 'release', action: 'rejected', title: 'y' });
    service.onEvent({ type: 'import', action: 'imported', title: 'x' });
    service.onEvent({ type: 'import', action: 'failed', title: 'z' });
    const text = await service.render();
    expect(value(text, 'arclight_releases_grabbed_total')).toBe(1);
    expect(value(text, 'arclight_imports_total{result="imported"}')).toBe(1);
    expect(value(text, 'arclight_imports_total{result="failed"}')).toBe(1);
  });

  it('reports process, queue, library and request gauges from the database', async () => {
    const db = await createTestDb();
    const c = db.insert(downloadClients).values({ name: 'qBit', implementation: 'qbittorrent', protocol: 'torrent', tags: [], settings: {}, updatedAt: iso(0) }).returning().get();
    tracked(db, c.id, 'downloading', 100, 40, 'a');
    tracked(db, c.id, 'downloading', 100, 100, 'b');
    tracked(db, c.id, 'importPending', 100, 0, 'c');
    db.insert(movies)
      .values({
        tmdbId: 1, title: 'M', originalTitle: 'M', sortTitle: 'm', cleanTitle: 'm', year: 2020, status: 'released', genres: [], images: [],
        ratings: {}, originalLanguage: 'en', path: '/m', rootFolderPath: '/', qualityProfileId: 1, tags: [], added: iso(0), hasFile: true,
        minimumAvailability: 'released',
      } as never)
      .run();
    for (const status of ['pending', 'pending', 'approved'] as const) {
      db.insert(mediaRequests).values({ type: 'movie', status, tmdbId: 1, title: 'M', requestedById: 1, tags: [], createdAt: iso(0), updatedAt: iso(0) } as never).run();
    }
    const text = await new MetricsService({ db }).render();
    expect(value(text, 'arclight_queue_items{state="downloading"}')).toBe(2);
    expect(value(text, 'arclight_queue_items{state="importPending"}')).toBe(1);
    expect(value(text, 'arclight_library_movies{has_file="true"}')).toBe(1);
    expect(value(text, 'arclight_library_movies{has_file="false"}')).toBe(0);
    expect(value(text, 'arclight_requests_pending')).toBe(2);
    expect(value(text, 'arclight_requests{status="approved"}')).toBe(1);
    expect(value(text, 'arclight_download_client_remaining_bytes{client="qBit"}')).toBe(140);
    expect(value(text, 'process_resident_memory_bytes')).toBeGreaterThan(0);
    expect(text).toContain('# TYPE process_cpu_seconds_total counter');
  });

  it('reports 24 h indexer queries, grabs, failures, response time and backoff', async () => {
    const db = await createTestDb();
    const ix = db.insert(indexers).values({ name: 'Geek', implementation: 'newznab', tags: [], settings: { baseUrl: 'x', apiPath: '/api', categories: [], animeCategories: [] }, addedAt: iso(0) }).returning().get();
    const stat = (kind: 'query' | 'rss' | 'grab', success: boolean, durationMs: number, ago: number) =>
      db.insert(indexerStats).values({ indexerId: ix.id, kind, success, durationMs, at: iso(ago) }).run();
    stat('query', true, 1000, 1000);
    stat('query', true, 3000, 1000);
    stat('query', false, 2000, 1000);
    stat('grab', true, 0, 1000);
    stat('query', true, 9000, 2 * 24 * 3_600_000); // outside the window
    db.insert(indexerStatus).values({ indexerId: ix.id, failureCount: 1, disabledTill: iso(-60_000) }).run();
    const text = await new MetricsService({ db, now: () => NOW }).render();
    expect(value(text, 'arclight_indexer_queries_24h{indexer="Geek",result="success"}')).toBe(2);
    expect(value(text, 'arclight_indexer_queries_24h{indexer="Geek",result="failure"}')).toBe(1);
    expect(value(text, 'arclight_indexer_grabs_24h{indexer="Geek",result="success"}')).toBe(1);
    expect(value(text, 'arclight_indexer_failures_24h{indexer="Geek"}')).toBe(1);
    expect(value(text, 'arclight_indexer_response_seconds_avg_24h{indexer="Geek"}')).toBe(2);
    expect(value(text, 'arclight_indexer_disabled{indexer="Geek"}')).toBe(1);
  });

  it('reads torrent engine, VPN, subtitles (cached) and client status from sources', async () => {
    const db = await createTestDb();
    const c = db.insert(downloadClients).values({ name: 'qBit', implementation: 'qbittorrent', protocol: 'torrent', tags: [], settings: {}, updatedAt: iso(0) }).returning().get();
    let now = NOW;
    let wantedCalls = 0;
    const service = new MetricsService({
      db,
      now: () => now,
      slowTtlMs: 60_000,
      sources: {
        torrent: () => ({ state: 'running', downloadRate: 1000, uploadRate: 50, peers: 3 }),
        vpn: () => ({ enabled: true, connected: false }),
        subtitlesWanted: () => ++wantedCalls * 10,
        clientStatuses: () => new Map([[c.id, { ok: true }]]),
      },
    });
    tracked(db, c.id, 'downloading', 10_000, 10_000, 'a');
    let text = await service.render();
    expect(value(text, 'arclight_torrent_engine_up')).toBe(1);
    expect(value(text, 'arclight_torrent_download_rate_bytes')).toBe(1000);
    expect(value(text, 'arclight_vpn_enabled')).toBe(1);
    expect(value(text, 'arclight_vpn_connected')).toBe(0);
    expect(value(text, 'arclight_subtitles_wanted')).toBe(10);
    expect(value(text, 'arclight_download_client_up{client="qBit"}')).toBe(1);
    expect(value(text, 'arclight_download_client_rate_bytes{client="qBit"}')).toBe(0);

    // 10 s later 5000 more bytes are done: 500 B/s; the wanted count is still cached.
    db.update(trackedDownloads).set({ sizeLeft: 5000 }).run();
    now += 10_000;
    text = await service.render();
    expect(value(text, 'arclight_download_client_rate_bytes{client="qBit"}')).toBe(500);
    expect(value(text, 'arclight_subtitles_wanted')).toBe(10);
    now += 60_000;
    text = await service.render();
    expect(value(text, 'arclight_subtitles_wanted')).toBe(20);
  });

  it('a failing source is counted as a collector error', async () => {
    const service = new MetricsService({
      db: await createTestDb(),
      sources: {
        vpn: () => {
          throw new Error('down');
        },
      },
    });
    const text = await service.render();
    expect(value(text, 'arclight_metrics_collector_errors_total{collector="vpn"}')).toBe(1);
  });
});

// ---- installMetrics: hook + route ---------------------------------------------------------

async function app(allowAnonymous = false) {
  const db = await createTestDb();
  if (allowAnonymous) setSection(db, 'metrics', { allowAnonymous: true });
  const log = pino({ level: 'silent' });
  const bus = new EventBus();
  const ctx: AppContext = {
    config: { configDir: '.', dbPath: ':memory:', logDir: '.', port: 0, host: '127.0.0.1', logLevel: 'silent', isDocker: false, webDist: null } satisfies AppConfig,
    db,
    bus,
    scheduler: new Scheduler(db, bus, log),
    log,
    startedAt: new Date(),
  };
  const server = Fastify().withTypeProvider<ZodTypeProvider>();
  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);
  const service = await installMetrics(server, ctx, { sources: {} });
  server.get('/api/v1/series/:id', async () => ({ ok: true }));
  const apiKey = authServiceFor(ctx).ensureApiKey();
  return { server, service, ctx, apiKey: apiKey ?? getSection(db, 'security').apiKey! };
}

describe('GET /metrics', () => {
  it('requires credentials unless metrics.allowAnonymous', async () => {
    const { server, apiKey } = await app();
    expect((await server.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
    const ok = await server.inject({ method: 'GET', url: `/metrics?apikey=${apiKey}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toMatch(/^text\/plain; version=0\.0\.4/);
    const anon = await app(true);
    expect((await anon.server.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(200);
    await server.close();
    await anon.server.close();
  });

  it('GET/PUT /settings/metrics under /api/v1', async () => {
    const { ctx } = await app();
    const server = Fastify().withTypeProvider<ZodTypeProvider>();
    server.setValidatorCompiler(validatorCompiler);
    server.setSerializerCompiler(serializerCompiler);
    await server.register(metricsModule(ctx), { prefix: '/api/v1' });
    expect((await server.inject({ method: 'GET', url: '/api/v1/settings/metrics' })).json()).toEqual({ allowAnonymous: false });
    const put = await server.inject({ method: 'PUT', url: '/api/v1/settings/metrics', payload: { allowAnonymous: true } });
    expect(put.json()).toEqual({ allowAnonymous: true });
    expect(getSection(ctx.db, 'metrics').allowAnonymous).toBe(true);
  });

  it('labels HTTP requests by route pattern, not by raw URL', async () => {
    const { server, apiKey } = await app();
    await server.inject({ method: 'GET', url: '/api/v1/series/1' });
    await server.inject({ method: 'GET', url: '/api/v1/series/2' });
    await server.inject({ method: 'GET', url: '/nope/123' });
    const text = (await server.inject({ method: 'GET', url: '/metrics', headers: { 'x-api-key': apiKey } })).body;
    expect(value(text, 'arclight_http_requests_total{method="GET",route="/api/v1/series/:id",status="200"}')).toBe(2);
    expect(value(text, 'arclight_http_requests_total{method="GET",route="(unmatched)",status="404"}')).toBe(1);
    expect(value(text, 'arclight_http_request_duration_seconds_count{method="GET",route="/api/v1/series/:id"}')).toBe(2);
    expect(text).not.toContain('/api/v1/series/1');
    await server.close();
  });
});

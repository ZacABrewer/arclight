import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IndexerCreate, IndexerHealth } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { createTestDb } from '../../db/test-utils.js';
import { DefinitionStore } from './definitions.js';
import { healthVerdict, INDEXER_HEALTH_THRESHOLDS, percentile, summarizeHealth, type HealthSample, type VerdictMetrics } from './health.js';
import { indexersRoutes } from './routes.js';
import { indexerStats, indexerStatus } from './schema.js';
import { IndexersService } from './service.js';

const NOW = Date.parse('2026-10-25T12:00:00.000Z');
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

const q = (indexerId: number, durationMs: number, results: number | null, success = true): HealthSample => ({
  indexerId,
  kind: 'query',
  success,
  durationMs,
  results: success ? results : null,
});

// ---- pure aggregation ---------------------------------------------------------------

describe('percentile', () => {
  it('uses nearest rank', () => {
    expect(percentile([], 95)).toBeNull();
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([5, 1, 4, 2, 3], 50)).toBe(3);
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(hundred, 95)).toBe(95);
    expect(percentile([10, 20], 95)).toBe(20);
  });
});

describe('healthVerdict', () => {
  const base: VerdictMetrics = {
    queries: 20,
    failureRate: 0,
    avgResponseMs: 300,
    p95ResponseMs: 800,
    zeroResultRate: 0.1,
    backingOff: false,
    countedQueries: 20,
  };
  const T = INDEXER_HEALTH_THRESHOLDS;

  it('is healthy under every threshold', () => {
    expect(healthVerdict(base)).toBe('healthy');
  });

  it('is unused without queries unless backing off', () => {
    expect(healthVerdict({ ...base, queries: 0, failureRate: null })).toBe('unused');
    expect(healthVerdict({ ...base, queries: 0, failureRate: null, backingOff: true })).toBe('failing');
  });

  it('is failing at the failure-rate threshold or while backing off', () => {
    expect(healthVerdict({ ...base, failureRate: T.failureRate - 0.01 })).toBe('healthy');
    expect(healthVerdict({ ...base, failureRate: T.failureRate })).toBe('failing');
    expect(healthVerdict({ ...base, backingOff: true })).toBe('failing');
  });

  it('flags no results only with enough counted queries', () => {
    expect(healthVerdict({ ...base, zeroResultRate: 1, countedQueries: T.minQueriesForNoResults - 1 })).toBe('healthy');
    expect(healthVerdict({ ...base, zeroResultRate: T.zeroResultRate, countedQueries: T.minQueriesForNoResults })).toBe('noResults');
  });

  it('is slow on average or p95', () => {
    expect(healthVerdict({ ...base, avgResponseMs: T.slowAvgMs })).toBe('slow');
    expect(healthVerdict({ ...base, p95ResponseMs: T.slowP95Ms })).toBe('slow');
  });

  it('ranks failing over no results over slow', () => {
    const all = { ...base, failureRate: 0.5, zeroResultRate: 1, avgResponseMs: 60_000 };
    expect(healthVerdict(all)).toBe('failing');
    expect(healthVerdict({ ...all, failureRate: 0 })).toBe('noResults');
  });

  it('accepts custom thresholds', () => {
    expect(healthVerdict({ ...base, avgResponseMs: 300 }, { ...T, slowAvgMs: 200 })).toBe('slow');
  });
});

describe('summarizeHealth', () => {
  const indexers = [
    { id: 1, name: 'Bravo', enabled: true },
    { id: 2, name: 'Alpha', enabled: true },
    { id: 3, name: 'Charlie', enabled: false },
  ];

  it('aggregates counts, rates, timings and results per indexer', () => {
    const samples: HealthSample[] = [
      q(1, 100, 10),
      q(1, 300, 0),
      { indexerId: 1, kind: 'rss', success: true, durationMs: 200, results: 50 },
      q(1, 900, null, false),
      q(1, 400, null), // older row without a result count
      { indexerId: 1, kind: 'grab', success: true, durationMs: 50, results: null },
      { indexerId: 1, kind: 'grab', success: false, durationMs: 50, results: null },
      q(2, 50, 3),
    ];
    const health = summarizeHealth({ days: 7, now: NOW, indexers, samples });
    expect(health.days).toBe(7);
    expect(health.since).toBe(new Date(NOW - 7 * DAY).toISOString());
    expect(health.thresholds).toEqual(INDEXER_HEALTH_THRESHOLDS);
    expect(health.indexers.map((e) => e.indexerName)).toEqual(['Alpha', 'Bravo', 'Charlie']);

    const bravo = health.indexers.find((e) => e.indexerId === 1)!;
    expect(bravo).toMatchObject({
      queries: 5,
      failures: 1,
      failureRate: 0.2,
      avgResponseMs: 250, // successful only: 100, 300, 200, 400
      p95ResponseMs: 400,
      avgResults: 20, // (10 + 0 + 50) / 3 counted
      zeroResultRate: 0.3333,
      grabs: 1,
      verdict: 'healthy',
      enabled: true,
    });

    const charlie = health.indexers.find((e) => e.indexerId === 3)!;
    expect(charlie).toMatchObject({
      queries: 0,
      failureRate: null,
      avgResponseMs: null,
      p95ResponseMs: null,
      avgResults: null,
      zeroResultRate: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      verdict: 'unused',
      enabled: false,
    });
  });

  it('reports backoff state and the newest failure', () => {
    const health = summarizeHealth({
      days: 1,
      now: NOW,
      indexers,
      samples: [q(1, 100, 5), q(1, 100, null, false)],
      latest: new Map([
        [1, { lastSuccessAt: '2026-10-25T10:00:00.000Z', lastFailureAt: '2026-10-25T11:00:00.000Z', lastFailureMessage: 'http-error: HTTP 503' }],
        [2, { lastSuccessAt: '2026-10-25T09:00:00.000Z', lastFailureAt: null, lastFailureMessage: null }],
      ]),
      statuses: new Map([
        [1, { failureCount: 2, disabledTill: new Date(NOW + HOUR).toISOString(), lastFailure: '2026-10-25T11:00:00.000Z', mostRecentFailure: 'http-error: HTTP 503' }],
        // Expired backoff and a newer caps-probe failure than the stats log knows about.
        [2, { failureCount: 1, disabledTill: new Date(NOW - HOUR).toISOString(), lastFailure: '2026-10-25T11:30:00.000Z', mostRecentFailure: 'timeout: timed out' }],
      ]),
    });
    const bravo = health.indexers.find((e) => e.indexerId === 1)!;
    expect(bravo).toMatchObject({
      verdict: 'failing',
      failureCount: 2,
      disabledTill: new Date(NOW + HOUR).toISOString(),
      lastSuccessAt: '2026-10-25T10:00:00.000Z',
      lastFailureAt: '2026-10-25T11:00:00.000Z',
      lastFailureMessage: 'http-error: HTTP 503',
    });
    const alpha = health.indexers.find((e) => e.indexerId === 2)!;
    expect(alpha).toMatchObject({
      verdict: 'unused',
      disabledTill: null,
      failureCount: 1,
      lastFailureAt: '2026-10-25T11:30:00.000Z',
      lastFailureMessage: 'timeout: timed out',
    });
  });

  it('flags indexers that answer but almost never return anything', () => {
    const samples = [...Array.from({ length: 10 }, () => q(2, 100, 0)), q(2, 100, 1)];
    const alpha = summarizeHealth({ days: 7, now: NOW, indexers, samples }).indexers.find((e) => e.indexerId === 2)!;
    expect(alpha.zeroResultRate).toBeCloseTo(10 / 11, 3);
    expect(alpha.verdict).toBe('noResults');
  });

  it('flags slow indexers by p95', () => {
    const samples = [...Array.from({ length: 18 }, () => q(2, 200, 4)), q(2, 15_000, 4), q(2, 16_000, 4)];
    const alpha = summarizeHealth({ days: 7, now: NOW, indexers, samples }).indexers.find((e) => e.indexerId === 2)!;
    expect(alpha.p95ResponseMs).toBe(15_000);
    expect(alpha.verdict).toBe('slow');
  });
});

// ---- recording and the API (fake network, no real indexers) --------------------------

const CAPS = `<?xml version="1.0" encoding="UTF-8"?>
<caps><server title="Fake" /><limits default="50" max="100" />
<searching><search available="yes" supportedParams="q" /><tv-search available="yes" supportedParams="q,season,ep" /><movie-search available="yes" supportedParams="q" /></searching>
<categories><category id="2000" name="Movies" /></categories></caps>`;

function feed(count: number): string {
  const items = Array.from(
    { length: count },
    (_, i) => `<item><title>Movie.${i}.2024.1080p</title><guid>g${i}</guid><pubDate>${new Date(NOW - HOUR).toUTCString()}</pubDate>
<size>1000000000</size><link>http://good.example/dl/${i}</link><category>2000</category><torznab:attr name="seeders" value="5" /></item>`,
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>Fake</title>${items}</channel></rss>`;
}

const xml = (body: string) => new Response(body, { headers: { 'content-type': 'application/xml' } });

function torznab(name: string): IndexerCreate {
  return { name, implementation: 'torznab', settings: { baseUrl: `http://${name.toLowerCase()}.example`, apiKey: 'k', categories: [2000] } };
}

describe('indexer health API', () => {
  let clock: number;
  let db: Db;
  let dir: string;
  let service: IndexersService;
  let app: FastifyInstance;
  let items: number;

  beforeEach(async () => {
    clock = NOW;
    items = 3;
    db = await createTestDb();
    dir = await mkdtemp(join(tmpdir(), 'mt-health-'));
    const store = new DefinitionStore({ customDir: dir });
    const fakeFetch: typeof fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname !== 'good.example') throw new TypeError(`fetch failed: ${url.hostname}`);
      clock += 100;
      return url.searchParams.get('t') === 'caps' ? xml(CAPS) : xml(feed(items));
    };
    service = new IndexersService({ db, fetch: fakeFetch, now: () => clock, sleep: async () => {}, definitions: store, indexerTimeoutMs: 5_000 });
    await store.ready();
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(indexersRoutes(service, {}));
  });

  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('records result counts on queries and RSS fetches, and messages on failures', async () => {
    const good = service.create(torznab('Good'));
    const bad = service.create(torznab('Bad'));
    await service.manualSearch({ query: 'movie' });
    await service.rss();
    clock += 1000;
    await service.rss(); // same items again: none are new, but the fetch still returned 3

    const rows = db.select().from(indexerStats).all();
    const goodRows = rows.filter((r) => r.indexerId === good.id);
    expect(goodRows.map((r) => [r.kind, r.results, r.error])).toEqual([
      ['query', 3, null],
      ['rss', 3, null],
      ['rss', 3, null],
    ]);
    const badRow = rows.find((r) => r.indexerId === bad.id)!;
    expect(badRow).toMatchObject({ kind: 'query', success: false, results: null });
    expect(badRow.error).toMatch(/^unreachable: /);
  });

  it('serves the summary with verdicts and validates the period', async () => {
    const good = service.create(torznab('Good'));
    const bad = service.create(torznab('Bad'));
    const idle = service.create({ ...torznab('Idle'), enableRss: false, enableAutomaticSearch: false, enableInteractiveSearch: false });
    await service.manualSearch({ query: 'movie' });

    const res = await app.inject({ method: 'GET', url: '/indexer/health' });
    expect(res.statusCode).toBe(200);
    const health = res.json() as IndexerHealth;
    expect(health.days).toBe(7);
    const by = (id: number) => health.indexers.find((e) => e.indexerId === id)!;
    expect(by(good.id)).toMatchObject({ verdict: 'healthy', queries: 1, failures: 0, avgResults: 3, zeroResultRate: 0 });
    expect(by(good.id).lastSuccessAt).not.toBeNull();
    expect(by(bad.id)).toMatchObject({ verdict: 'failing', queries: 1, failures: 1, failureRate: 1, failureCount: 1 });
    expect(by(bad.id).disabledTill).not.toBeNull();
    expect(by(bad.id).lastFailureMessage).toMatch(/^unreachable: /);
    expect(by(idle.id)).toMatchObject({ verdict: 'unused', enabled: false });

    expect((await app.inject({ method: 'GET', url: '/indexer/health?days=30' })).json()).toMatchObject({ days: 30 });
    expect((await app.inject({ method: 'GET', url: '/indexer/health?days=1' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/indexer/health?days=3' })).statusCode).toBe(400);
  });

  it('only counts rows inside the period', async () => {
    const good = service.create(torznab('Good'));
    db.insert(indexerStats)
      .values([
        { indexerId: good.id, kind: 'query', durationMs: 10, success: true, results: 0, at: new Date(NOW - 2 * DAY).toISOString() },
        { indexerId: good.id, kind: 'query', durationMs: 10, success: false, error: 'timeout: slow', at: new Date(NOW - 3 * HOUR).toISOString() },
      ])
      .run();
    db.insert(indexerStatus).values({ indexerId: good.id, failureCount: 0 }).run();
    const day = service.health(1).indexers[0]!;
    expect(day).toMatchObject({ queries: 1, failures: 1, verdict: 'failing', lastFailureMessage: 'timeout: slow' });
    expect(day.lastSuccessAt).toBe(new Date(NOW - 2 * DAY).toISOString());
    expect(service.health(7).indexers[0]).toMatchObject({ queries: 2, failures: 1 });
  });
});

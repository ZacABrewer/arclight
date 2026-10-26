import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { IndexerCreate, ReleaseResource } from '@arclight/shared';
import * as dbSchema from '../../db/schema.js';
import type { Db } from '../../db/index.js';
import * as indexerSchema from './schema.js';
import { indexersRoutes } from './routes.js';
import { BACKOFF_STEPS_MS, backoffFor, IndexersService, type IndexerStatusChange } from './service.js';

// ---- database from the module's own drizzle schema ---------------------------------

let ddl: string[] = [];

beforeAll(async () => {
  const empty = await generateSQLiteDrizzleJson({});
  const full = await generateSQLiteDrizzleJson({ ...indexerSchema });
  ddl = await generateSQLiteMigration(empty, full);
});

function makeDb(): Db {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  for (const statement of ddl) sqlite.exec(statement);
  return drizzle(sqlite, { schema: dbSchema });
}

// ---- fake network -------------------------------------------------------------------

const CAPS = (opts: { search?: boolean } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <server title="Fake" />
  <limits default="50" max="100" />
  <searching>
    <search available="${opts.search === false ? 'no' : 'yes'}" supportedParams="q" />
    <tv-search available="yes" supportedParams="q,season,ep,tvdbid,imdbid" />
    <movie-search available="yes" supportedParams="q,imdbid,tmdbid" />
  </searching>
  <categories>
    <category id="2000" name="Movies"><subcat id="2040" name="Movies/HD" /></category>
    <category id="5000" name="TV"><subcat id="5040" name="TV/HD" /></category>
  </categories>
</caps>`;

const AUTH_ERROR = '<?xml version="1.0" encoding="UTF-8"?><error code="100" description="Incorrect user credentials"/>';

interface Item {
  title: string;
  guid: string;
  /** ISO-8601. */
  date: string;
  size?: number;
  infohash?: string;
  seeders?: number;
}

function feed(items: Item[]): string {
  const body = items
    .map(
      (i) => `<item>
  <title>${i.title}</title>
  <guid>${i.guid}</guid>
  <pubDate>${new Date(i.date).toUTCString()}</pubDate>
  <size>${i.size ?? 1_000_000_000}</size>
  <link>http://dl.example.invalid/${encodeURIComponent(i.guid)}.torrent</link>
  <category>5040</category>
  <torznab:attr name="category" value="5040" />
  ${i.seeders === undefined ? '' : `<torznab:attr name="seeders" value="${i.seeders}" />`}
  ${i.infohash === undefined ? '' : `<torznab:attr name="infohash" value="${i.infohash}" />`}
</item>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>Fake</title>${body}</channel></rss>`;
}

type Reply = string | Error | { status: number; body: string } | 'hang';

interface HostBehaviour {
  caps?: () => Reply;
  search?: (url: URL) => Reply;
}

class FakeNet {
  readonly hosts = new Map<string, HostBehaviour>();
  readonly calls: URL[] = [];

  readonly fetch: typeof fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    this.calls.push(url);
    const host = this.hosts.get(url.hostname);
    if (!host) throw new TypeError(`fetch failed: ${url.hostname}`);
    const isCaps = url.searchParams.get('t') === 'caps';
    const reply: Reply = isCaps ? (host.caps ?? (() => CAPS()))() : (host.search ?? (() => feed([])))(url);
    if (reply === 'hang') return new Promise<Response>(() => {});
    if (reply instanceof Error) throw reply;
    const { status, body } = typeof reply === 'string' ? { status: 200, body: reply } : reply;
    return new Response(body, { status, headers: { 'content-type': 'application/xml' } });
  };

  set(host: string, behaviour: HostBehaviour): void {
    this.hosts.set(host, behaviour);
  }

  callsTo(host: string, kind?: 'caps' | 'search'): URL[] {
    return this.calls.filter(
      (u) =>
        u.hostname === host &&
        (kind === undefined || (kind === 'caps') === (u.searchParams.get('t') === 'caps')),
    );
  }
}

// ---- fixtures -----------------------------------------------------------------------

const T0 = Date.parse('2026-10-25T12:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

let clock = T0;
let net: FakeNet;
let db: Db;
let service: IndexersService;

function input(name: string, overrides: Partial<IndexerCreate> = {}): IndexerCreate {
  return {
    name,
    implementation: 'torznab',
    settings: { baseUrl: `http://${name.toLowerCase()}.test`, apiKey: 'k', categories: [5000, 2000] },
    ...overrides,
  };
}

function hoursAgo(h: number): string {
  return new Date(clock - h * HOUR).toISOString();
}

beforeEach(() => {
  clock = T0;
  net = new FakeNet();
  db = makeDb();
  service = new IndexersService({
    db,
    fetch: net.fetch,
    now: () => clock,
    indexerTimeoutMs: 200,
    requestTimeoutMs: 5_000,
  });
});

// ---- CRUD & validation ----------------------------------------------------------------

describe('CRUD and validation', () => {
  it('creates with defaults and derives the protocol', () => {
    const created = service.create(input('Alpha'));
    expect(created).toMatchObject({
      id: 1,
      name: 'Alpha',
      implementation: 'torznab',
      protocol: 'torrent',
      enableRss: true,
      enableAutomaticSearch: true,
      enableInteractiveSearch: true,
      priority: 25,
      tags: [],
      settings: { baseUrl: 'http://alpha.test', apiPath: '/api', apiKey: 'k', categories: [5000, 2000], animeCategories: [] },
    });
    expect(created.downloadClientId).toBeUndefined();
    expect(created.status).toBeUndefined();
  });

  it('maps newznab to usenet', () => {
    expect(service.create(input('Nzb', { implementation: 'newznab' })).protocol).toBe('usenet');
  });

  it('lists in id order and gets by id', () => {
    service.create(input('Alpha'));
    service.create(input('Beta'));
    expect(service.list().map((i) => i.name)).toEqual(['Alpha', 'Beta']);
    expect(service.get(2).name).toBe('Beta');
  });

  it('throws NOT_FOUND for unknown ids', () => {
    expect(() => service.get(99)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => service.delete(99)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('rejects duplicate names case-insensitively', () => {
    service.create(input('Alpha'));
    expect(() => service.create(input('alpha', { settings: { baseUrl: 'http://x.test', categories: [5000] } }))).toThrow(
      expect.objectContaining({ code: 'CONFLICT' }),
    );
  });

  it.each([
    ['not a url', 'not-a-url'],
    ['non-http scheme', 'ftp://host.test'],
    ['query string', 'http://host.test/?a=1'],
  ])('rejects a bad baseUrl (%s)', (_label, baseUrl) => {
    expect(() => service.create(input('Bad', { settings: { baseUrl, categories: [5000] } }))).toThrow(
      expect.objectContaining({ code: 'VALIDATION' }),
    );
  });

  it('rejects priority outside 1..50 and empty categories', () => {
    expect(() => service.create(input('P', { priority: 51 }))).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
    expect(() => service.create(input('P', { priority: 0 }))).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
    expect(() => service.create(input('C', { settings: { baseUrl: 'http://c.test', categories: [] } }))).toThrow(
      expect.objectContaining({ code: 'VALIDATION' }),
    );
  });

  it('normalizes baseUrl and apiPath', () => {
    const created = service.create(
      input('Norm', { settings: { baseUrl: 'http://norm.test/prefix/', apiPath: 'torznab/api', categories: [5000] } }),
    );
    expect(created.settings.baseUrl).toBe('http://norm.test/prefix');
    expect(created.settings.apiPath).toBe('/torznab/api');
  });

  it('updates partially, merging settings and keeping the api key', () => {
    service.create(input('Alpha', { downloadClientId: 3 }));
    const updated = service.update(1, { priority: 10, enableRss: false, settings: { minimumSeeders: 5 } });
    expect(updated).toMatchObject({ priority: 10, enableRss: false, downloadClientId: 3 });
    expect(updated.settings).toMatchObject({ apiKey: 'k', minimumSeeders: 5, categories: [5000, 2000] });
    expect(service.update(1, { downloadClientId: null }).downloadClientId).toBeUndefined();
  });

  it('rejects renaming onto another indexer but allows a case change of its own name', () => {
    service.create(input('Alpha'));
    service.create(input('Beta'));
    expect(() => service.update(2, { name: 'ALPHA' })).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    expect(service.update(2, { name: 'BETA' }).name).toBe('BETA');
  });

  it('deletes the indexer with its status, caps and rss rows', async () => {
    service.create(input('Alpha'));
    net.set('alpha.test', { search: () => new Error('boom') });
    await service.rss();
    await service.getCaps(1).catch(() => undefined);
    expect(db.select().from(indexerSchema.indexerStatus).all()).toHaveLength(1);
    expect(db.select().from(indexerSchema.indexerCapsCache).all()).toHaveLength(1);
    service.delete(1);
    expect(() => service.get(1)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(db.select().from(indexerSchema.indexerStatus).all()).toEqual([]);
    expect(db.select().from(indexerSchema.indexerCapsCache).all()).toEqual([]);
  });
});

// ---- search -------------------------------------------------------------------------

describe('search', () => {
  it('fans out to all enabled indexers and annotates releases', async () => {
    service.create(input('Alpha'));
    service.create(input('Beta'));
    net.set('alpha.test', { search: () => feed([{ title: 'Show.S01E01.1080p', guid: 'a1', date: hoursAgo(30) }]) });
    net.set('beta.test', { search: () => feed([{ title: 'Show.S01E01.720p', guid: 'b1', date: hoursAgo(1.5) }]) });

    const releases = await service.search({ kind: 'search', query: 'Show' }, { mode: 'interactive' });
    expect(releases.map((r) => r.guid)).toEqual(['b1', 'a1']); // newest first
    const a1 = releases.find((r) => r.guid === 'a1')!;
    expect(a1).toMatchObject({ indexerId: 1, indexerName: 'Alpha', indexerPriority: 25, protocol: 'torrent', age: 1, approved: false, rejections: [] });
    expect(a1.ageHours).toBeCloseTo(30);
    expect(a1.ageMinutes).toBeCloseTo(1800);
    expect(net.callsTo('alpha.test', 'search')[0]!.searchParams.get('q')).toBe('Show');
  });

  it('de-duplicates by info hash, keeping the higher-priority indexer', async () => {
    service.create(input('Low', { priority: 40 }));
    service.create(input('High', { priority: 5 }));
    const hash = '0123456789abcdef0123456789abcdef01234567';
    net.set('low.test', { search: () => feed([{ title: 'X', guid: 'low-1', date: hoursAgo(2), infohash: hash, seeders: 100 }]) });
    net.set('high.test', { search: () => feed([{ title: 'X', guid: 'high-1', date: hoursAgo(2), infohash: hash.toUpperCase(), seeders: 3 }]) });

    const releases = await service.search({ kind: 'search', query: 'X' }, { mode: 'automatic' });
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({ guid: 'high-1', indexerName: 'High' });
  });

  it('de-duplicates by guid, preferring more seeders at equal priority', async () => {
    service.create(input('Alpha'));
    service.create(input('Beta'));
    net.set('alpha.test', { search: () => feed([{ title: 'X', guid: 'same', date: hoursAgo(2), seeders: 1 }]) });
    net.set('beta.test', { search: () => feed([{ title: 'X', guid: 'same', date: hoursAgo(2), seeders: 9 }]) });
    const releases = await service.search({ kind: 'search', query: 'X' }, { mode: 'automatic' });
    expect(releases).toHaveLength(1);
    expect(releases[0]!.indexerName).toBe('Beta');
  });

  it('isolates a failing indexer and records its failure', async () => {
    service.create(input('Good'));
    service.create(input('Bad'));
    net.set('good.test', { search: () => feed([{ title: 'X', guid: 'g1', date: hoursAgo(1) }]) });
    net.set('bad.test', { search: () => ({ status: 500, body: 'oops' }) });

    const releases = await service.search({ kind: 'search', query: 'X' }, { mode: 'automatic' });
    expect(releases.map((r) => r.guid)).toEqual(['g1']);
    expect(service.get(2).status).toMatchObject({ failureCount: 1 });
    expect(service.get(1).status).toBeUndefined();
  });

  it('does not wait on a hanging indexer past the per-indexer timeout', async () => {
    service.create(input('Good'));
    service.create(input('Slow'));
    net.set('good.test', { search: () => feed([{ title: 'X', guid: 'g1', date: hoursAgo(1) }]) });
    net.set('slow.test', { search: () => 'hang' });

    const started = Date.now();
    const releases = await service.search({ kind: 'search', query: 'X' }, { mode: 'automatic' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(releases.map((r) => r.guid)).toEqual(['g1']);
    expect(service.get(2).status?.mostRecentFailure).toMatch(/timed out/);
  });

  it('records auth errors with their code', async () => {
    service.create(input('Alpha'));
    net.set('alpha.test', { search: () => AUTH_ERROR });
    await service.search({ kind: 'search', query: 'X' }, { mode: 'automatic' });
    expect(service.get(1).status?.mostRecentFailure).toMatch(/^auth:/);
  });

  it('respects the per-mode enable flags and the indexerIds filter', async () => {
    service.create(input('Auto', { enableInteractiveSearch: false }));
    service.create(input('Inter', { enableAutomaticSearch: false }));
    service.create(input('Both'));
    for (const h of ['auto.test', 'inter.test', 'both.test']) {
      net.set(h, { search: () => feed([{ title: 'X', guid: h, date: hoursAgo(1) }]) });
    }
    const auto = await service.search({ kind: 'search', query: 'X' }, { mode: 'automatic' });
    expect(auto.map((r) => r.indexerName).sort()).toEqual(['Auto', 'Both']);
    const inter = await service.search({ kind: 'search', query: 'X' }, { mode: 'interactive' });
    expect(inter.map((r) => r.indexerName).sort()).toEqual(['Both', 'Inter']);
    const only = await service.search({ kind: 'search', query: 'X' }, { mode: 'interactive', indexerIds: [3] });
    expect(only.map((r) => r.indexerName)).toEqual(['Both']);
  });

  it('does not count an unsupported search against the indexer', async () => {
    service.create(input('Alpha'));
    net.set('alpha.test', { caps: () => CAPS({ search: false }) });
    const releases = await service.search({ kind: 'search', query: 'X' }, { mode: 'interactive' });
    expect(releases).toEqual([]);
    expect(service.get(1).status).toBeUndefined();
  });

  it('caches caps for 24 hours', async () => {
    service.create(input('Alpha'));
    net.set('alpha.test', {});
    await service.search({ kind: 'search', query: 'X' }, { mode: 'automatic' });
    await service.search({ kind: 'search', query: 'Y' }, { mode: 'automatic' });
    expect(net.callsTo('alpha.test', 'caps')).toHaveLength(1);
    clock += 24 * HOUR + 1;
    await service.search({ kind: 'search', query: 'Z' }, { mode: 'automatic' });
    expect(net.callsTo('alpha.test', 'caps')).toHaveLength(2);
    expect((await service.getCaps(1)).fetchedAt).toBe(new Date(clock).toISOString());
  });

  it('getCaps refresh refetches and an endpoint change drops the cache', async () => {
    service.create(input('Alpha'));
    net.set('alpha.test', {});
    net.set('alpha2.test', {});
    const caps = await service.getCaps(1);
    expect(caps.searching.tvSearch.supportedParams).toContain('tvdbid');
    await service.getCaps(1, { refresh: true });
    expect(net.callsTo('alpha.test', 'caps')).toHaveLength(2);
    service.update(1, { settings: { baseUrl: 'http://alpha2.test' } });
    await service.getCaps(1);
    expect(net.callsTo('alpha2.test', 'caps')).toHaveLength(1);
  });

  it('manual search maps raw ids to a tv search', async () => {
    service.create(input('Alpha'));
    net.set('alpha.test', {});
    await service.manualSearch({ tvdbId: 123, season: 2, episode: 5 });
    const url = net.callsTo('alpha.test', 'search')[0]!;
    expect(url.searchParams.get('t')).toBe('tvsearch');
    expect(url.searchParams.get('tvdbid')).toBe('123');
    expect(url.searchParams.get('season')).toBe('2');
    expect(url.searchParams.get('ep')).toBe('5');
  });

  it('manual search by library id needs the resolver', async () => {
    service.create(input('Alpha'));
    net.set('alpha.test', {});
    await expect(service.manualSearch({ seriesId: 7 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(service.manualSearch({})).rejects.toMatchObject({ code: 'VALIDATION' });
    service.setManualSearchResolver((req) => ({ kind: 'tv', tvdbId: (req.seriesId ?? 0) * 100 }));
    await service.manualSearch({ seriesId: 7 });
    expect(net.callsTo('alpha.test', 'search')[0]!.searchParams.get('tvdbid')).toBe('700');
  });
});

// ---- backoff ------------------------------------------------------------------------

describe('failure backoff', () => {
  it('escalates 5m, 15m, 30m, 1h, 3h, 6h, 12h, 24h and then stays at 24h', () => {
    expect(BACKOFF_STEPS_MS.map((ms) => ms / MIN)).toEqual([5, 15, 30, 60, 180, 360, 720, 1440]);
    expect(backoffFor(1)).toBe(5 * MIN);
    expect(backoffFor(8)).toBe(24 * HOUR);
    expect(backoffFor(20)).toBe(24 * HOUR);
  });

  it('stores escalating disabledTill on consecutive failures', async () => {
    service.create(input('Bad'));
    net.set('bad.test', { search: () => new Error('down') });
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      await service.search({ kind: 'search', query: 'X' }, { mode: 'automatic' });
      const status = service.statuses()[0]!;
      expect(status.failureCount).toBe(i + 1);
      const till = Date.parse(status.disabledTill!);
      seen.push((till - clock) / MIN);
      clock = till + 1; // let the backoff expire
    }
    expect(seen).toEqual([5, 15, 30, 60]);
  });

  it('skips a disabled indexer in search and rss until the backoff expires', async () => {
    service.create(input('Bad'));
    net.set('bad.test', { search: () => new Error('down') });
    await service.search({ kind: 'search', query: 'X' }, { mode: 'automatic' });
    const before = net.calls.length;
    expect(service.isDisabled(1)).toBe(true);
    await service.search({ kind: 'search', query: 'X' }, { mode: 'automatic' });
    await service.rss();
    expect(net.calls.length).toBe(before);
    clock += 5 * MIN + 1;
    expect(service.isDisabled(1)).toBe(false);
    await service.rss();
    expect(net.calls.length).toBeGreaterThan(before);
  });

  it('does not escalate for failures that land while already disabled', async () => {
    service.create(input('Bad'));
    net.set('bad.test', { search: () => new Error('down') });
    await Promise.all([
      service.search({ kind: 'search', query: 'X' }, { mode: 'automatic' }),
      service.search({ kind: 'search', query: 'Y' }, { mode: 'automatic' }),
    ]);
    expect(service.statuses()[0]!.failureCount).toBe(1);
  });

  it('resets on success and emits failed/recovered changes', async () => {
    service.create(input('Flaky'));
    const changes: IndexerStatusChange[] = [];
    service.onIndexerStatusChanged((c) => changes.push(c));
    let up = false;
    net.set('flaky.test', { search: () => (up ? feed([]) : new Error('down')) });

    await service.search({ kind: 'search', query: 'X' }, { mode: 'automatic' });
    clock += 5 * MIN + 1;
    await service.search({ kind: 'search', query: 'X' }, { mode: 'automatic' });
    expect(service.statuses()[0]!.failureCount).toBe(2);

    clock += 15 * MIN + 1;
    up = true;
    await service.search({ kind: 'search', query: 'X' }, { mode: 'automatic' });
    const status = service.statuses()[0]!;
    expect(status.failureCount).toBe(0);
    expect(status.disabledTill).toBeUndefined();
    expect(changes.map((c) => c.kind)).toEqual(['failed', 'failed', 'recovered']);
    expect(changes[0]).toMatchObject({ indexerId: 1, indexerName: 'Flaky', error: { code: 'unreachable' } });

    // The next failure starts the ladder from the bottom again.
    up = false;
    await service.search({ kind: 'search', query: 'X' }, { mode: 'automatic' });
    const again = service.statuses()[0]!;
    expect(again.failureCount).toBe(1);
    expect(Date.parse(again.disabledTill!) - clock).toBe(5 * MIN);
  });

  it('status check re-probes expired failing indexers and recovers them', async () => {
    service.create(input('Flaky'));
    let up = false;
    net.set('flaky.test', { search: () => (up ? feed([]) : new Error('down')) });
    await service.search({ kind: 'search', query: 'X' }, { mode: 'automatic' });

    // Still inside the window: not probed.
    const callsBefore = net.calls.length;
    expect(await service.statusCheck()).toMatch(/^1 of 1 indexers unavailable; probed 0/);
    expect(net.calls.length).toBe(callsBefore);

    clock += 5 * MIN + 1;
    up = true;
    expect(await service.statusCheck()).toMatch(/^0 of 1 indexers unavailable; probed 1/);
    expect(service.statuses()[0]!.failureCount).toBe(0);
  });
});

// ---- RSS ----------------------------------------------------------------------------

describe('rss', () => {
  it('returns everything on the first sync and nothing new on an unchanged feed', async () => {
    service.create(input('Alpha'));
    const items = [
      { title: 'A', guid: 'a', date: hoursAgo(1) },
      { title: 'B', guid: 'b', date: hoursAgo(2) },
    ];
    net.set('alpha.test', { search: () => feed(items) });

    expect((await service.rss()).map((r) => r.guid)).toEqual(['a', 'b']);
    const state = db.select().from(indexerSchema.indexerRssState).get()!;
    expect(state).toMatchObject({ lastGuid: 'a', lastPublishDate: new Date(hoursAgo(1)).toISOString() });
    expect(service.statuses()[0]!.lastRssSyncAt).toBe(new Date(clock).toISOString());

    clock += 15 * MIN;
    expect(await service.rss()).toEqual([]);
  });

  it('advances the marker and returns only new releases', async () => {
    service.create(input('Alpha'));
    let items: Item[] = [{ title: 'A', guid: 'a', date: hoursAgo(1) }];
    net.set('alpha.test', { search: () => feed(items) });
    await service.rss();

    clock += 15 * MIN;
    items = [{ title: 'C', guid: 'c', date: hoursAgo(0.1) }, ...items];
    const fresh = await service.rss();
    expect(fresh.map((r) => r.guid)).toEqual(['c']);
    expect(db.select().from(indexerSchema.indexerRssState).get()!.lastGuid).toBe('c');
  });

  it('drops unseen releases far older than the marker but keeps late arrivals within tolerance', async () => {
    service.create(input('Alpha'));
    let items: Item[] = [{ title: 'A', guid: 'a', date: hoursAgo(1) }];
    net.set('alpha.test', { search: () => feed(items) });
    await service.rss();

    items = [...items, { title: 'Late', guid: 'late', date: hoursAgo(3) }, { title: 'Ancient', guid: 'old', date: hoursAgo(48) }];
    expect((await service.rss()).map((r) => r.guid)).toEqual(['late']);
  });

  it('only syncs RSS-enabled indexers and keeps markers per indexer', async () => {
    service.create(input('On'));
    service.create(input('Off', { enableRss: false }));
    net.set('on.test', { search: () => feed([{ title: 'A', guid: 'a', date: hoursAgo(1) }]) });
    net.set('off.test', { search: () => feed([{ title: 'B', guid: 'b', date: hoursAgo(1) }]) });
    expect((await service.rss()).map((r) => r.indexerName)).toEqual(['On']);
    expect(net.callsTo('off.test')).toHaveLength(0);
    expect(db.select().from(indexerSchema.indexerRssState).all().map((s) => s.indexerId)).toEqual([1]);
  });

  it('does not advance the marker of an indexer whose fetch failed', async () => {
    service.create(input('Alpha'));
    service.create(input('Beta'));
    let betaUp = true;
    net.set('alpha.test', { search: () => feed([{ title: 'A', guid: 'a', date: hoursAgo(1) }]) });
    net.set('beta.test', { search: () => (betaUp ? feed([{ title: 'B', guid: 'b', date: hoursAgo(1) }]) : new Error('down')) });
    await service.rss();
    const betaBefore = db.select().from(indexerSchema.indexerRssState).all().find((s) => s.indexerId === 2)!;

    clock += 15 * MIN;
    betaUp = false;
    const fresh = await service.rss();
    expect(fresh).toEqual([]);
    const betaAfter = db.select().from(indexerSchema.indexerRssState).all().find((s) => s.indexerId === 2)!;
    expect(betaAfter).toEqual(betaBefore);
    expect(service.get(2).status?.failureCount).toBe(1);
  });

  it('dispatches releases to registered handlers', async () => {
    const received: ReleaseResource[][] = [];
    const off = service.onReleases((r) => {
      received.push(r);
    });
    service.onReleases(() => {
      throw new Error('handler errors are contained');
    });
    await service.dispatchReleases([]);
    off();
    await service.dispatchReleases([]);
    expect(received).toHaveLength(1);
  });
});

// ---- testing ------------------------------------------------------------------------

describe('test and testAll', () => {
  it('test returns caps and the RSS release count for an unsaved definition', async () => {
    net.set('alpha.test', { search: () => feed([{ title: 'A', guid: 'a', date: hoursAgo(1) }]) });
    const result = await service.test(input('Alpha'));
    expect(result).toMatchObject({ ok: true, releaseCount: 1, caps: { serverTitle: 'Fake' } });
    expect(service.list()).toEqual([]);
  });

  it('test reports auth failures without throwing', async () => {
    net.set('alpha.test', { caps: () => AUTH_ERROR });
    const result = await service.test(input('Alpha'));
    expect(result).toMatchObject({ ok: false, error: { code: 'auth' } });
  });

  it('testAll refreshes caps and clears failure status on success', async () => {
    service.create(input('Alpha'));
    service.create(input('Gone'));
    let up = false;
    net.set('alpha.test', { search: () => (up ? feed([]) : new Error('down')) });
    await service.search({ kind: 'search', query: 'X' }, { mode: 'automatic' });
    expect(service.get(1).status?.failureCount).toBe(1);
    up = true;
    const results = await service.testAll();
    expect(results.map((r) => [r.name, r.ok])).toEqual([
      ['Alpha', true],
      ['Gone', false],
    ]);
    expect(service.get(1).status?.failureCount).toBe(0);
    expect(db.select().from(indexerSchema.indexerCapsCache).all().map((c) => c.indexerId)).toEqual([1]);
  });
});

// ---- routes -------------------------------------------------------------------------

describe('routes', () => {
  async function app() {
    const server = Fastify().withTypeProvider<ZodTypeProvider>();
    server.setValidatorCompiler(validatorCompiler);
    server.setSerializerCompiler(serializerCompiler);
    await server.register(indexersRoutes(service), { prefix: '/api/v1' });
    return server;
  }

  it('serves CRUD with typed error mapping', async () => {
    const server = await app();
    const created = await server.inject({ method: 'POST', url: '/api/v1/indexer', payload: input('Alpha') });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: 1, protocol: 'torrent' });

    const dup = await server.inject({ method: 'POST', url: '/api/v1/indexer', payload: input('Alpha') });
    expect(dup.statusCode).toBe(409);
    const bad = await server.inject({ method: 'POST', url: '/api/v1/indexer', payload: { name: 'x' } });
    expect(bad.statusCode).toBe(400);
    const badUrl = await server.inject({
      method: 'POST',
      url: '/api/v1/indexer',
      payload: input('B', { settings: { baseUrl: 'nope', categories: [5000] } }),
    });
    expect(badUrl.statusCode).toBe(400);

    const put = await server.inject({ method: 'PUT', url: '/api/v1/indexer/1', payload: { priority: 3 } });
    expect(put.json()).toMatchObject({ priority: 3 });
    expect((await server.inject({ method: 'GET', url: '/api/v1/indexer' })).json()).toHaveLength(1);
    expect((await server.inject({ method: 'DELETE', url: '/api/v1/indexer/1' })).statusCode).toBe(204);
    expect((await server.inject({ method: 'GET', url: '/api/v1/indexer/1' })).statusCode).toBe(404);
  });

  it('serves schema, categories, status, caps and search', async () => {
    const server = await app();
    service.create(input('Alpha'));
    net.set('alpha.test', { search: () => feed([{ title: 'Show', guid: 's1', date: hoursAgo(1) }]) });

    const templates = (await server.inject({ method: 'GET', url: '/api/v1/indexer/schema' })).json();
    expect(templates.map((t: { implementation: string }) => t.implementation)).toEqual(['torznab', 'newznab']);

    const categories = (await server.inject({ method: 'GET', url: '/api/v1/indexer/categories' })).json();
    expect(categories.find((c: { id: number }) => c.id === 5000).subCategories).toContainEqual({ id: 5070, name: 'TV/Anime' });

    expect((await server.inject({ method: 'GET', url: '/api/v1/indexer/status' })).json()).toEqual([
      { indexerId: 1, failureCount: 0 },
    ]);

    const caps = await server.inject({ method: 'GET', url: '/api/v1/indexer/1/caps?refresh=true' });
    expect(caps.statusCode).toBe(200);
    expect(caps.json()).toMatchObject({ serverTitle: 'Fake', limits: { max: 100 } });

    const search = await server.inject({ method: 'GET', url: '/api/v1/search?query=Show&indexerIds=1' });
    expect(search.statusCode).toBe(200);
    expect(search.json()).toMatchObject([{ guid: 's1', indexerId: 1, approved: false, rejections: [] }]);

    expect((await server.inject({ method: 'GET', url: '/api/v1/search' })).statusCode).toBe(400);
  });

  it('maps caps failures to 502 and tests unsaved definitions', async () => {
    const server = await app();
    service.create(input('Alpha'));
    net.set('alpha.test', { caps: () => AUTH_ERROR });
    const caps = await server.inject({ method: 'GET', url: '/api/v1/indexer/1/caps' });
    expect(caps.statusCode).toBe(502);
    expect(caps.json()).toMatchObject({ code: 'auth' });

    const test = await server.inject({ method: 'POST', url: '/api/v1/indexer/test', payload: input('Alpha') });
    expect(test.statusCode).toBe(200);
    expect(test.json()).toMatchObject({ ok: false, error: { code: 'auth' } });
  });
});

import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { BuiltinClient, BuiltinSettings, DownloadClientError } from '@arclight/download-clients';
import { createDefinitionIndexer, IndexerError, parseDefinitionYaml, type AccountStats } from '@arclight/indexers';
import { createTorrent, Session, type Torrent } from '@arclight/torrent-engine';
import { TrackerStatsResource, type Indexer } from '@arclight/shared';
import { createTestDb } from '../../db/test-utils.js';
import type { Db } from '../../db/index.js';
import { trackedDownloads } from '../../db/schema.js';
import { trackerStatsRoutes } from './routes.js';
import * as tables from './schema.js';
import { hostMatches, isFreeleech, ratioStatusOf, TrackerStatsError, TrackerStatsService, type TrackerIndexersPort } from './service.js';

// Tracker-stats: account settings, torrent attribution, H&R rules, freeleech-only filter,
// engine + account-page sync, ratio health findings and routes. Engines run on loopback with
// fake announce URLs that are never contacted; account pages come from an injected fetch.

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const PRIV = 1;
const NEWS = 2;
const OTHER = 3;
const GIB = 1024 ** 3;

class FakeIndexers implements TrackerIndexersPort {
  indexers: Array<Pick<Indexer, 'id' | 'name' | 'protocol'>> = [
    { id: PRIV, name: 'PrivTracker', protocol: 'torrent' },
    { id: NEWS, name: 'Newsgroup', protocol: 'usenet' },
    { id: OTHER, name: 'OtherTracker', protocol: 'torrent' },
  ];
  sites: Record<number, string[]> = { [PRIV]: ['www.privtracker.invalid'], [OTHER]: ['other.invalid'] };
  account: AccountStats | Error = { ratio: 1.25, uploaded: 300 * GIB, downloaded: 240 * GIB, hnrCount: 0 };
  scraped = 0;
  list() {
    return this.indexers;
  }
  siteHosts(id: number) {
    return this.sites[id] ?? [];
  }
  hasAccountPage(id: number) {
    return id === PRIV;
  }
  async accountStats(): Promise<AccountStats> {
    this.scraped++;
    if (this.account instanceof Error) throw this.account;
    return this.account;
  }
}

interface Setup {
  db: Db;
  fake: FakeIndexers;
  service: TrackerStatsService;
  session: Session | null;
  dir: string;
}

async function setup(opts: { engine?: boolean } = {}): Promise<Setup> {
  const db = await createTestDb({ ...tables });
  const fake = new FakeIndexers();
  const dir = await mkdtemp(join(tmpdir(), 'mt-tracker-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  let session: Session | null = null;
  if (opts.engine) {
    session = new Session({
      settings: { listenPort: 0, listenAddress: '127.0.0.1', dht: false, pex: false, dhtBootstrapNodes: [], tickIntervalMs: 50, savePath: dir, seedLimitAction: 'none' },
      trackerClientFactory: () => null,
    });
    await session.start();
    const s = session;
    cleanups.push(() => s.shutdown());
  }
  const service = new TrackerStatsService({ db, indexers: fake, session: () => session, log: pino({ level: 'silent' }), snapshotTtlMs: 0 });
  return { db, fake, service, session, dir };
}

/** Adds a seeding torrent whose payload is already on disk. */
async function seed(s: Setup, announce: string | null, name = `t-${randomBytes(3).toString('hex')}`): Promise<Torrent> {
  const data = randomBytes(40_000);
  await mkdir(join(s.dir, name), { recursive: true });
  await writeFile(join(s.dir, name, 'a.bin'), data);
  const { torrent } = createTorrent({ name, files: [{ path: ['a.bin'], data }], forceMultiFile: true, pieceLength: 16 * 1024, ...(announce ? { announce } : {}) });
  const t = await s.session!.addTorrent({ torrent });
  await waitFor(() => t.state === 'seeding');
  return t;
}

function waitFor<T>(cond: () => T | undefined | null | false, ms = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      const v = cond();
      if (v) {
        clearInterval(iv);
        resolve(v);
      } else if (Date.now() - start > ms) {
        clearInterval(iv);
        reject(new Error('timed out'));
      }
    }, 20);
  });
}

function trackGrab(db: Db, infoHash: string, indexerId: number): void {
  const at = new Date().toISOString();
  db.insert(trackedDownloads)
    .values({
      downloadId: infoHash,
      clientId: null,
      title: 'grab',
      state: 'downloading',
      statusMessages: [],
      protocol: 'torrent',
      addedAt: at,
      updatedAt: at,
      grabbedRelease: { indexerId, title: 'grab' },
    })
    .run();
}

describe('tracker account settings', () => {
  it('serves defaults, validates and persists per-indexer settings', async () => {
    const { service } = await setup();
    expect(service.getAccount(PRIV)).toMatchObject({ enabled: false, freeleechOnly: false, hnrRule: {}, announceHosts: [], scrapeAccount: true });
    const saved = service.setAccount(PRIV, { enabled: true, ratioRequired: 1, hnrRule: { minSeedHours: 72 }, announceHosts: ['Tracker.Priv.invalid'] });
    expect(saved).toMatchObject({ enabled: true, ratioRequired: 1, hnrRule: { minSeedHours: 72 }, announceHosts: ['tracker.priv.invalid'] });
    expect(service.getAccount(PRIV)).toEqual(saved);
    expect(() => service.setAccount(PRIV, { ratioRequired: -1 })).toThrow(TrackerStatsError);
  });

  it('refuses usenet and unknown indexers', async () => {
    const { service } = await setup();
    expect(() => service.getAccount(NEWS)).toThrow(/not a torrent indexer/);
    try {
      service.setAccount(99, {});
      expect.unreachable();
    } catch (err) {
      expect((err as TrackerStatsError).code).toBe('NOT_FOUND');
    }
  });
});

describe('attribution and hooks', () => {
  it('hostMatches ignores www. and accepts subdomains either way', () => {
    expect(hostMatches('tracker.privtracker.invalid', 'www.privtracker.invalid')).toBe(true);
    expect(hostMatches('privtracker.invalid', 'tracker.privtracker.invalid')).toBe(true);
    expect(hostMatches('notprivtracker.invalid', 'privtracker.invalid')).toBe(false);
    expect(hostMatches('', 'x')).toBe(false);
  });

  it('attributes torrents by resolver, then tracked grab, then announce hosts', async () => {
    const { db, service } = await setup();
    service.setAccount(OTHER, { enabled: true, announceHosts: ['announce.other.invalid'] });
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    expect(service.indexerForTorrent(a, ['tracker.privtracker.invalid'])).toBe(PRIV);
    expect(service.indexerForTorrent(a, ['announce.other.invalid'])).toBe(OTHER);
    // Explicit announce hosts replace the site hosts (no subdomain matching on other.invalid).
    expect(service.indexerForTorrent(a, ['x.other.invalid'])).toBeUndefined();
    trackGrab(db, b, OTHER);
    service.invalidate();
    expect(service.indexerForTorrent(b, ['tracker.privtracker.invalid'])).toBe(OTHER);
    const off = service.registerInfoHashResolver((h) => (h === b ? PRIV : undefined));
    expect(service.indexerForTorrent(b, [])).toBe(PRIV);
    off();
    expect(service.indexerForTorrent(b, [])).toBe(OTHER);
    expect(service.indexerForTorrent('c'.repeat(40), ['unrelated.invalid'])).toBeUndefined();
  });

  it('freeleech-only mode rejects non-freeleech releases of that indexer only', async () => {
    const { service } = await setup();
    expect(isFreeleech({ downloadVolumeFactor: 0 })).toBe(true);
    expect(isFreeleech({ indexerFlags: ['freeleech'] })).toBe(true);
    expect(isFreeleech({ downloadVolumeFactor: 0.5 })).toBe(false);
    expect(service.releaseFilter(PRIV, { downloadVolumeFactor: 1 })).toBeNull();
    service.setAccount(PRIV, { enabled: true, freeleechOnly: true });
    expect(service.releaseFilter(PRIV, { downloadVolumeFactor: 1 })).toEqual({
      reason: 'notFreeleech',
      message: 'PrivTracker is in freeleech-only mode and this release is not freeleech',
    });
    expect(service.releaseFilter(PRIV, {})).not.toBeNull();
    expect(service.releaseFilter(PRIV, { downloadVolumeFactor: 0 })).toBeNull();
    expect(service.releaseFilter(PRIV, { indexerFlags: ['freeleech'] })).toBeNull();
    expect(service.releaseFilter(OTHER, { downloadVolumeFactor: 1 })).toBeNull();
    service.setAccount(PRIV, { enabled: false, freeleechOnly: true });
    expect(service.releaseFilter(PRIV, { downloadVolumeFactor: 1 })).toBeNull();
  });

  it('provides hit-and-run rules by announce host, only for enabled accounts with a rule', async () => {
    const { service } = await setup();
    const rules = service.seedRuleProvider();
    const hash = 'd'.repeat(40);
    expect(rules(['tracker.privtracker.invalid'], hash)).toBeNull();
    service.setAccount(PRIV, { enabled: true, hnrRule: { minSeedHours: 72, minRatio: 1 } });
    expect(rules(['tracker.privtracker.invalid'], hash)).toEqual({ minSeedHours: 72, minRatio: 1, label: 'PrivTracker' });
    expect(rules(['elsewhere.invalid'], hash)).toBeNull();
    service.setAccount(PRIV, { enabled: true });
    expect(rules(['tracker.privtracker.invalid'], hash)).toBeNull();
  });

  it('the built-in client refuses to remove a torrent of that tracker before the H&R rule is met', async () => {
    const s = await setup({ engine: true });
    s.service.setAccount(PRIV, { enabled: true, hnrRule: { minSeedHours: 48 } });
    const client = new BuiltinClient(BuiltinSettings.parse({}), s.session!, { seedRules: s.service.seedRuleProvider() });
    const guarded = await seed(s, 'http://tracker.privtracker.invalid/announce');
    const free = await seed(s, 'http://open.invalid/announce');
    const items = await client.getItems('');
    expect(items.find((i) => i.id === guarded.infoHashHex)).toMatchObject({ isReadOnly: true, canBeRemoved: false });
    const err = await client.removeItem(guarded.infoHashHex, false).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DownloadClientError);
    expect((err as Error).message).toMatch(/PrivTracker requires 48 h of seeding/);
    await client.pause(free.infoHashHex);
    await client.removeItem(free.infoHashHex, false);
    expect(s.session!.getTorrents().map((t) => t.infoHashHex)).toEqual([guarded.infoHashHex]);
  });
});

describe('TrackerStatsSync', () => {
  it('aggregates engine torrents per tracker and counts torrents still under the H&R rule', async () => {
    const s = await setup({ engine: true });
    s.service.setAccount(PRIV, { enabled: true, hnrRule: { minSeedHours: 24 } });
    await seed(s, 'http://tracker.privtracker.invalid/announce');
    await seed(s, 'udp://tracker.privtracker.invalid:6969/announce');
    const grabbed = await seed(s, null);
    trackGrab(s.db, grabbed.infoHashHex, OTHER);
    await seed(s, 'http://open.invalid/announce');
    const message = await s.service.sync();
    expect(message).toMatch(/3 torrent\(s\) attributed/);
    const stats = s.service.list();
    const priv = stats.find((x) => x.indexerId === PRIV)!;
    expect(priv).toMatchObject({ torrents: 2, seeding: 2, hnrPending: 2, hosts: ['tracker.privtracker.invalid'] });
    expect(priv.engineUpdatedAt).not.toBeNull();
    expect(stats.find((x) => x.indexerId === OTHER)).toMatchObject({ torrents: 1, hnrPending: 0 });
    for (const x of stats) TrackerStatsResource.parse(x);
  });

  it('reads the account page of enabled accounts and keeps the error when it fails', async () => {
    const s = await setup();
    s.service.setAccount(PRIV, { enabled: true, ratioRequired: 1 });
    await s.service.sync();
    expect(s.fake.scraped).toBe(1);
    const ok = s.service.list().find((x) => x.indexerId === PRIV)!;
    expect(ok).toMatchObject({ accountRatio: 1.25, accountUploaded: 300 * GIB, accountHnrCount: 0, accountError: null, ratio: 1.25, ratioStatus: 'ok' });
    s.fake.account = new Error('login failed');
    await s.service.sync();
    const failed = s.service.list().find((x) => x.indexerId === PRIV)!;
    expect(failed.accountError).toBe('login failed');
    expect(failed.accountRatio).toBe(1.25);
    s.service.setAccount(PRIV, { enabled: true, scrapeAccount: false });
    await s.service.sync();
    expect(s.fake.scraped).toBe(2);
  });

  it('drops statistics of indexers that no longer exist', async () => {
    const s = await setup();
    s.service.setAccount(OTHER, { enabled: true });
    await s.service.sync();
    expect(s.service.list().map((x) => x.indexerId)).toEqual([OTHER]);
    s.fake.indexers = s.fake.indexers.filter((i) => i.id !== OTHER);
    await s.service.sync();
    expect(s.service.list()).toEqual([]);
    expect(s.db.select().from(tables.trackerStats).all()).toEqual([]);
  });
});

describe('ratio and buffer', () => {
  it('ratioStatusOf: low below the requirement, warning within 10 %', () => {
    expect(ratioStatusOf(null, 1)).toBe('unknown');
    expect(ratioStatusOf(0.9, undefined)).toBe('ok');
    expect(ratioStatusOf(0.99, 1)).toBe('low');
    expect(ratioStatusOf(1.05, 1)).toBe('warning');
    expect(ratioStatusOf(1.2, 1)).toBe('ok');
  });

  it('computes the buffer from the account totals when the page has none', async () => {
    const s = await setup();
    s.service.setAccount(PRIV, { enabled: true, ratioRequired: 1.5, bufferTracking: true, minBufferBytes: 10 * GIB });
    await s.service.sync();
    const priv = s.service.list()[0]!;
    expect(priv.buffer).toBe(Math.round((300 * GIB) / 1.5 - 240 * GIB));
    expect(priv.ratioStatus).toBe('low');
  });

  it('TrackerRatioLow reports low ratios, thin buffers and hit-and-runs of enabled accounts', async () => {
    const s = await setup();
    s.fake.account = { ratio: 0.8, uploaded: 80 * GIB, downloaded: 100 * GIB, buffer: 2 * GIB, hnrCount: 2 };
    s.service.setAccount(PRIV, { enabled: true, ratioRequired: 1, bufferTracking: true, minBufferBytes: 5 * GIB });
    await s.service.sync();
    const findings = s.service.healthFindings();
    expect(findings).toEqual([
      { source: 'TrackerRatioLow', status: 'error', message: 'PrivTracker: ratio 0.80 is below the required 1.00' },
      { source: 'TrackerRatioLow', status: 'warning', message: 'PrivTracker: upload buffer 2.0 GiB is below 5.0 GiB' },
      { source: 'TrackerRatioLow', status: 'warning', message: 'PrivTracker reports 2 hit-and-run(s) on your account' },
    ]);
    s.fake.account = { ratio: 1.05 };
    await s.service.sync();
    expect(s.service.healthFindings()[0]).toMatchObject({ status: 'warning', message: expect.stringMatching(/close to/) });
    s.service.setAccount(PRIV, { enabled: false, ratioRequired: 1 });
    expect(s.service.healthFindings()).toEqual([]);
  });
});

describe('definition account pages', () => {
  const DEF = `
id: privsite
name: PrivSite
type: private
links: [https://privsite.invalid/]
settings: []
caps:
  categorymappings:
    - {id: 1, cat: TV, desc: "TV"}
  modes:
    search: [q]
search:
  paths:
    - path: browse.php
  rows:
    selector: tr
  fields:
    title: {selector: td}
    download: {selector: a, attribute: href}
account:
  path: user.php
  inputs:
    id: me
  fields:
    ratio: {selector: "#ratio"}
    uploaded: {selector: "#up"}
    downloaded: {selector: "#down"}
    hnr_count: {selector: "#hnr", filters: [{name: regexp, args: "(\\\\d+)"}]}
    buffer: {selector: "#missing", optional: true}
`;
  const PAGE = `<html><body><span id="ratio">1.234</span><span id="up">1.5 TiB</span><span id="down">512 GiB</span><span id="hnr">HnR: 3 active</span></body></html>`;

  it('parses the optional account block and scrapes the logged-in page', async () => {
    const def = parseDefinitionYaml(DEF);
    expect(def.account?.path).toBe('user.php');
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;
    const stats = await createDefinitionIndexer(def, {}, { fetchImpl }).accountStats();
    expect(calls).toEqual(['https://privsite.invalid/user.php?id=me']);
    expect(stats).toEqual({ ratio: 1.234, uploaded: 1.5 * 1024 ** 4, downloaded: 512 * GIB, hnrCount: 3 });
  });

  it('a definition without an account block cannot be scraped', async () => {
    const def = parseDefinitionYaml(DEF.replace(/account:[\s\S]*$/, ''));
    expect(def.account).toBeUndefined();
    await expect(createDefinitionIndexer(def).accountStats()).rejects.toBeInstanceOf(IndexerError);
  });
});

describe('tracker routes', () => {
  async function build() {
    const s = await setup();
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(trackerStatsRoutes(s.service), { prefix: '/api/v1' });
    cleanups.push(() => app.close());
    return { ...s, app };
  }

  it('PUT/GET /indexer/:id/tracker saves and serves the account settings', async () => {
    const { app } = await build();
    const put = await app.inject({ method: 'PUT', url: '/api/v1/indexer/1/tracker', payload: { enabled: true, freeleechOnly: true, hnrRule: { minRatio: 1 } } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ enabled: true, freeleechOnly: true, hnrRule: { minRatio: 1 } });
    expect((await app.inject({ method: 'GET', url: '/api/v1/indexer/1/tracker' })).json()).toMatchObject({ freeleechOnly: true });
    expect((await app.inject({ method: 'PUT', url: '/api/v1/indexer/1/tracker', payload: { ratioRequired: 'x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/v1/indexer/2/tracker', payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/indexer/42/tracker' })).statusCode).toBe(404);
  });

  it('GET /tracker/stats lists trackers; POST /tracker/stats/sync refreshes them', async () => {
    const { app, service } = await build();
    expect((await app.inject({ method: 'GET', url: '/api/v1/tracker/stats' })).json()).toEqual([]);
    service.setAccount(PRIV, { enabled: true, ratioRequired: 1 });
    const synced = await app.inject({ method: 'POST', url: '/api/v1/tracker/stats/sync' });
    expect(synced.statusCode).toBe(200);
    expect(synced.json().stats[0]).toMatchObject({ indexerId: PRIV, indexerName: 'PrivTracker', accountRatio: 1.25, ratioStatus: 'ok' });
    const list = (await app.inject({ method: 'GET', url: '/api/v1/tracker/stats' })).json();
    expect(list).toHaveLength(1);
  });
});

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIGRATE_SECRET_MASK, type MigrateSourceInput, type MigrateStackStatus } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import * as t from '../../db/schema.js';
import { createTestDb } from '../../db/test-utils.js';
import { discoverNetwork } from './discovery.js';
import { MigrateError } from './errors.js';
import type { FetchLike } from './http.js';
import { migrateImported, migrateRuns, migrateStaging } from './schema.js';
import { MigrateService } from './service.js';
import { markProwlarrSynced, MigrateStackRunner, sourceLabels, stackOrder } from './stack.js';
import { detectDatabaseApp, testSource } from './test-connection.js';
import { ForeignDb } from './foreign-db.js';
import { makeRadarrDb, makeSeerrDb, makeSonarrDb } from './test-fixtures.js';
import type { SourceBundle } from './types.js';

// Each test imports a small Sonarr + Radarr (+ Seerr) library; slow under load.
vi.setConfig({ testTimeout: 60_000 });

let tmp: string;
let db: Db;
let service: MigrateService;
let stack: MigrateStackRunner;
let backups: number;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'mt-migrate-stack-'));
  db = await createTestDb({ migrateImported, migrateStaging, migrateRuns });
  backups = 0;
  service = new MigrateService({
    db,
    now: () => new Date('2024-06-01T00:00:00Z'),
    deps: {
      createBackup: async () => {
        backups++;
        return { id: `arclight_backup_${backups}.zip`, name: `arclight_backup_${backups}.zip` };
      },
    },
  });
  stack = new MigrateStackRunner(service);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const mappings = () => [
  { from: '/tv', to: join(tmp, 'tv') },
  { from: '/movies', to: join(tmp, 'movies') },
];

function sonarr(): MigrateSourceInput {
  const dbPath = join(tmp, 'sonarr', 'sonarr.db');
  makeSonarrDb(dbPath);
  mkdirSync(join(tmp, 'tv'), { recursive: true });
  return { app: 'sonarr', dbPath, pathMappings: mappings() };
}

function radarr(): MigrateSourceInput {
  const dbPath = join(tmp, 'radarr', 'radarr.db');
  makeRadarrDb(dbPath);
  return { app: 'radarr', dbPath, pathMappings: mappings() };
}

function seerr(): MigrateSourceInput {
  const dbPath = join(tmp, 'seerr', 'db', 'db.sqlite3');
  makeSeerrDb(dbPath, join(tmp, 'seerr', 'settings.json'));
  return { app: 'seerr', dbPath, pathMappings: mappings() };
}

async function settle(): Promise<MigrateStackStatus> {
  for (let i = 0; i < 600; i++) {
    const s = stack.status();
    if (s.state !== 'running') return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('stack run did not finish');
}

const count = (table: SQLiteTable) => db.select().from(table).all().length;

describe('stack helpers', () => {
  it('orders sources by dependency and labels second instances', () => {
    const sources = [{ app: 'seerr' as const }, { app: 'sonarr' as const }, { app: 'qbittorrent' as const }, { app: 'prowlarr' as const }, { app: 'sonarr' as const, label: 'Sonarr 4K' }, { app: 'bazarr' as const }];
    expect(stackOrder(sources).map((i) => sources[i]!.app)).toEqual(['prowlarr', 'sonarr', 'sonarr', 'qbittorrent', 'bazarr', 'seerr']);
    expect(sourceLabels([{ app: 'sonarr' }, { app: 'sonarr' }, { app: 'radarr' }, { app: 'radarr', label: 'Radarr 4K' }])).toEqual(['Sonarr 1', 'Sonarr 2', 'Radarr', 'Radarr 4K']);
  });

  it('marks indexers Prowlarr pushed into Sonarr/Radarr as duplicates', () => {
    const indexer = (name: string, baseUrl: string) => ({ sourceId: name, name, payload: { create: { name, implementation: 'torznab' as const, settings: { baseUrl } }, sourceTagIds: [], sourceDownloadClientId: null } });
    const bundle = {
      app: 'sonarr',
      schemaVersion: null,
      warnings: [],
      areas: { indexers: { mode: 'import', items: [indexer('Nyaa (Prowlarr)', 'http://prowlarr:9696/3/'), indexer('Mine', 'https://indexer.example/'), indexer('Other', 'http://prowlarr:9696/12/api')] } },
    } as unknown as SourceBundle;
    expect(markProwlarrSynced(bundle)).toBe(2);
    expect(bundle.areas.indexers!.items.map((i) => !!i.unsupported)).toEqual([true, false, true]);
  });
});

describe('stack preview', () => {
  it('plans every source and reports unreadable ones inline', async () => {
    const preview = await stack.preview({ sources: [radarr(), sonarr(), { app: 'bazarr', dbPath: join(tmp, 'missing.db') }] });
    expect(preview.sources.map((s) => [s.key, s.app, s.label])).toEqual([
      ['0', 'radarr', 'Radarr'],
      ['1', 'sonarr', 'Sonarr'],
      ['2', 'bazarr', 'Bazarr'],
    ]);
    expect(preview.sources[0]!.plan?.areas.find((a) => a.area === 'movies')).toMatchObject({ create: 1 });
    expect(preview.sources[1]!.plan?.areas.find((a) => a.area === 'series')).toMatchObject({ create: 2 });
    expect(preview.sources[2]).toMatchObject({ plan: null, error: expect.stringMatching(/not found/) });
    expect(count(t.series)).toBe(0);
  });

  it('masks API keys and passwords in plans', async () => {
    const fetch: FetchLike = async () => new Response('{}', { status: 401 });
    service = new MigrateService({ db, deps: { fetch } });
    stack = new MigrateStackRunner(service);
    const preview = await stack.preview({ sources: [{ app: 'sonarr', mode: 'api', url: 'http://sonarr:8989', apiKey: 'secret-key' }] });
    expect(preview.sources[0]!.error).toMatch(/rejected the API key/);
    expect(JSON.stringify(preview)).not.toContain('secret-key');
  });
});

describe('stack runs', () => {
  it('dry-runs the whole stack by default: later sources see what earlier ones would create, nothing is kept', async () => {
    const started = stack.start({ sources: [{ source: seerr() }, { source: sonarr() }, { source: radarr() }] });
    expect(started).toMatchObject({ state: 'running', dryRun: true });
    const done = await settle();
    expect(done.state).toBe('completed');
    expect(done.backup).toBeNull();
    expect(backups).toBe(0);
    expect(done.sources.map((s) => s.state)).toEqual(['completed', 'completed', 'completed']);
    const seerrResult = done.sources[0]!.result!;
    expect(seerrResult.dryRun).toBe(true);
    // Requests resolve their requester (users area) and are created against the would-be library.
    expect(seerrResult.areas.find((a) => a.area === 'requests')?.created).toBeGreaterThan(0);
    expect(done.sources[1]!.result!.areas.find((a) => a.area === 'series')).toMatchObject({ created: 2 });
    expect([count(t.series), count(t.movies), count(t.mediaRequests)]).toEqual([0, 0, 0]);
    expect(db.select().from(migrateImported).all()).toHaveLength(0);
    const row = db.select().from(migrateRuns).get()!;
    expect(row).toMatchObject({ state: 'completed', dryRun: true });
    expect(done.resumable).toBe(false);
  });

  it('takes a backup, imports for real, and re-running duplicates nothing', async () => {
    const request = { sources: [{ source: sonarr() }, { source: radarr() }, { source: seerr() }], dryRun: false };
    stack.start(request);
    const first = await settle();
    expect(first.state).toBe('completed');
    expect(backups).toBe(1);
    expect(first.backup).toEqual({ id: 'arclight_backup_1.zip', name: 'arclight_backup_1.zip' });
    const counts = () => [count(t.series), count(t.movies), count(t.mediaRequests), count(t.users)];
    const after = counts();
    expect(after[0]).toBe(2);
    expect(after[1]).toBe(1);
    expect(after[2]).toBeGreaterThan(0);

    stack.start(request);
    const second = await settle();
    expect(second.state).toBe('completed');
    expect(counts()).toEqual(after);
    const created = second.sources.reduce((n, s) => n + (s.result?.areas.reduce((m, a) => m + a.created, 0) ?? 0), 0);
    expect(created).toBe(0);

    const report = stack.report();
    expect(report).toMatchObject({ version: 1, runId: second.runId, dryRun: false });
    expect(report.totals.created).toBe(0);
    expect(stack.report(first.runId!).totals.created).toBeGreaterThan(5);
  });

  it('a failed source makes the run resumable; resume keeps completed sources', async () => {
    const radarrPath = join(tmp, 'radarr', 'radarr.db');
    stack.start({ sources: [{ source: sonarr() }, { source: { app: 'radarr', dbPath: radarrPath, pathMappings: mappings() } }], dryRun: false });
    const failed = await settle();
    expect(failed.state).toBe('failed');
    expect(failed.sources.map((s) => s.state)).toEqual(['completed', 'failed']);
    expect(failed.resumable).toBe(true);
    expect(count(t.series)).toBe(2);

    makeRadarrDb(radarrPath);
    const resumed = stack.resume();
    expect(resumed.state).toBe('running');
    const done = await settle();
    expect(done.state).toBe('completed');
    expect(done.sources.map((s) => s.state)).toEqual(['completed', 'completed']);
    expect(done.log.some((l) => /already imported by the earlier run/.test(l.message))).toBe(true);
    expect(count(t.movies)).toBe(1);
    expect(count(t.series)).toBe(2);
    // The backup of the first attempt is kept; no second backup is taken.
    expect(backups).toBe(1);
    expect(() => stack.resume()).toThrow(MigrateError);
  });

  it('runs cut short by a restart become interrupted and resumable', async () => {
    const source = sonarr();
    db.insert(migrateRuns)
      .values({
        state: 'running',
        dryRun: false,
        request: { sources: [{ source: { ...source, mode: 'files', pathMappings: mappings() }, areas: [] }], conflictPolicy: 'skip', areaPolicies: {}, dryRun: false, backup: false, torrents: { categories: {}, defaultAction: 'adopt', verify: 'recheck', pauseInSource: false, confirmSourceChanges: false } },
        sources: [{ key: '0', app: 'sonarr', label: 'Sonarr', mode: 'files', state: 'running', result: null, error: null }],
        log: [],
        startedAt: '2024-06-01T00:00:00Z',
      })
      .run();
    stack.recoverInterrupted();
    expect(stack.status()).toMatchObject({ state: 'interrupted', resumable: true });
    stack.resume();
    expect((await settle()).state).toBe('completed');
    expect(count(t.series)).toBe(2);
  });

  it('refuses masked secrets, a second concurrent run and a backup failure', async () => {
    expect(() => stack.start({ sources: [{ source: { app: 'sonarr', mode: 'api', url: 'http://sonarr:8989', apiKey: MIGRATE_SECRET_MASK } }] })).toThrow(/masked secret/);
    const src = sonarr();
    stack.start({ sources: [{ source: src }] });
    expect(() => stack.start({ sources: [{ source: src }] })).toThrow(/already running/);
    await settle();

    service = new MigrateService({ db, deps: { createBackup: async () => Promise.reject(new Error('disk full')) } });
    stack = new MigrateStackRunner(service);
    stack.start({ sources: [{ source: radarr() }], dryRun: false });
    const done = await settle();
    expect(done.state).toBe('failed');
    expect(done.error).toMatch(/disk full/);
    expect(count(t.movies)).toBe(0);
  });

  it('reports secrets masked', async () => {
    const fetch: FetchLike = async () => new Response('{}', { status: 401 });
    service = new MigrateService({ db, deps: { fetch } });
    stack = new MigrateStackRunner(service);
    stack.start({ sources: [{ source: { app: 'radarr', mode: 'api', url: 'http://radarr:7878', apiKey: 'top-secret' } }] });
    const done = await settle();
    expect(done.sources[0]).toMatchObject({ state: 'failed', error: expect.stringMatching(/rejected/) });
    const report = stack.report();
    expect(report.request.sources[0]!.source.apiKey).toBe(MIGRATE_SECRET_MASK);
    expect(JSON.stringify(report)).not.toContain('top-secret');
  });
});

describe('connection test and discovery', () => {
  it('names the app a database really belongs to', async () => {
    const src = radarr();
    expect(await testSource({ ...src, app: 'sonarr' })).toMatchObject({ ok: false, detected: 'radarr', message: expect.stringMatching(/Radarr database/) });
    expect(await testSource(src)).toMatchObject({ ok: true, app: 'radarr', version: '240' });
    expect(await testSource({ app: 'sonarr', dbPath: join(tmp, 'nope.db') })).toMatchObject({ ok: false, message: expect.stringMatching(/not found/) });
    const fdb = ForeignDb.open(src.dbPath!);
    expect(detectDatabaseApp(fdb)).toBe('radarr');
    fdb.close();
  });

  it('checks the API answer and the key', async () => {
    const calls: string[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push(`${url} ${(init?.headers as Record<string, string>)['X-Api-Key'] ?? ''}`);
      return new Response(JSON.stringify({ appName: 'Radarr', version: '5.8.0' }), { status: 200 });
    };
    expect(await testSource({ app: 'sonarr', mode: 'api', url: 'http://radarr:7878/', apiKey: 'k1' }, { fetch })).toMatchObject({ ok: false, detected: 'radarr', version: '5.8.0' });
    expect(await testSource({ app: 'radarr', mode: 'api', url: 'http://radarr:7878', apiKey: 'k1' }, { fetch })).toMatchObject({ ok: true, version: '5.8.0' });
    expect(calls[0]).toBe('http://radarr:7878/api/v3/system/status k1');
    const refused: FetchLike = async () => {
      throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND sonarr') });
    };
    expect(await testSource({ app: 'sonarr', mode: 'api', url: 'http://sonarr:8989', apiKey: 'k' }, { fetch: refused })).toMatchObject({ ok: false, message: expect.stringMatching(/could not be reached.*ENOTFOUND/) });
  });

  it('suggests apps whose container name resolves and port answers', async () => {
    const found = await discoverNetwork({
      resolveHost: async (h) => ['sonarr', 'jellyseerr', 'gluetun', 'radarr'].includes(h),
      probePort: async (h) => h !== 'radarr',
    });
    expect(found).toEqual([
      { app: 'sonarr', url: 'http://sonarr:8989', origin: 'docker network' },
      { app: 'seerr', url: 'http://jellyseerr:5055', origin: 'docker network' },
      { app: 'qbittorrent', url: 'http://gluetun:8080', origin: 'docker network' },
    ]);
  });
});

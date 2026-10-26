import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { ServerEvent } from '@arclight/shared';
import type { AppContext } from '../../app.js';
import { createTestDb } from '../../db/test-utils.js';
import { EventBus } from '../../events.js';
import { Scheduler } from '../../scheduler.js';
import * as notificationTables from '../notifications/schema.js';
import {
  configDiskSpaceCheck,
  createStaleImportCheck,
  dockerPermissionsCheck,
  downloadClientCheck,
  downloadClientRemovesCompletedCheck,
  downloadDiskSpaceCheck,
  indexerCheck,
  indexerLongTermStatusCheck,
  indexerRssCheck,
  indexerSearchCheck,
  indexerStatusCheck,
  metadataSourceCheck,
  mountReadOnlyCheck,
  notificationConfigCheck,
  notificationStatusCheck,
  recycleBinCheck,
  remotePathMappingCheck,
  rootFolderCheck,
  rootFolderFreeSpaceCheck,
  stalledDownloadsCheck,
  diskGuardCheck,
  systemTimeCheck,
  updateCheck,
  vpnDisconnectedCheck,
} from './checks/index.js';
import { findMount } from './deps.js';
import { healthModule } from './index.js';
import { HealthService } from './service.js';
import { GIB, type HealthCheckDef, type HealthClientStatus, type HealthDeps, type HealthIndexer } from './types.js';

const NOW = new Date('2026-06-01T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const inMinutes = (m: number) => new Date(NOW.getTime() + m * 60_000).toISOString();

interface FakeState {
  dirs: Set<string>;
  unwritable: Set<string>;
  empty: Set<string>;
  free: Map<string, number>;
  readOnlyMounts: Map<string, string>;
  clients: Array<{ id: number; name: string; host: string }>;
  polls: Map<number, { ok: boolean; message?: string }>;
  tests: Map<number, { ok: boolean; message?: string }>;
  statuses: Map<number, HealthClientStatus | Error>;
  mappings: Array<{ host: string; remote: string; local: string }>;
}

/** HealthDeps backed by in-memory state; override any member per test. */
function fakeDeps(overrides: Partial<HealthDeps> = {}, state: Partial<FakeState> = {}): HealthDeps & { state: FakeState } {
  const s: FakeState = {
    dirs: new Set(['/config', '/tv', '/movies', '/downloads']),
    unwritable: new Set(),
    empty: new Set(),
    free: new Map(),
    readOnlyMounts: new Map(),
    clients: [],
    polls: new Map(),
    tests: new Map(),
    statuses: new Map(),
    mappings: [],
    ...state,
  };
  const deps: HealthDeps = {
    appName: 'Arclight',
    isDocker: false,
    configDir: '/config',
    platform: 'posix',
    now: () => NOW,
    processIds: { uid: 1000, gid: 1000 },
    fs: {
      isDirectory: async (p) => s.dirs.has(p),
      canWrite: async (p) => s.dirs.has(p) && !s.unwritable.has(p),
      isEmpty: async (p) => s.empty.has(p),
      freeSpace: async (p) => s.free.get(p) ?? 100 * GIB,
      mountOf: async (p) => {
        for (const [mount, root] of s.readOnlyMounts) if (p === root) return { mountPoint: mount, readOnly: true };
        return { mountPoint: '/', readOnly: false };
      },
      owner: async () => ({ uid: 0, gid: 0 }),
    },
    rootFolders: async () => [
      { path: '/tv', mediaType: 'series', itemCount: 3 },
      { path: '/movies', mediaType: 'movie', itemCount: 0 },
    ],
    downloadClients: {
      enabled: () => s.clients,
      lastPoll: (id) => s.polls.get(id),
      test: async (id) => s.tests.get(id) ?? { ok: true },
      status: async (id) => {
        const st = s.statuses.get(id) ?? { outputRootDir: '/downloads', isLocalhost: true, removesCompletedDownloads: false };
        if (st instanceof Error) throw st;
        return st;
      },
      toLocal: (host, path) => {
        const m = s.mappings.find((x) => x.host === host && path.startsWith(x.remote));
        return m ? m.local + path.slice(m.remote.length) : path;
      },
    },
    indexers: () => [indexer(1, 'Alpha')],
    tmdbKeyConfigured: () => true,
    recycleBin: () => null,
    pendingImports: () => [],
    notifications: { enabled: () => [], misconfigured: () => [] },
    ...overrides,
  };
  return Object.assign(deps, { state: s });
}

function indexer(id: number, name: string, extra: Partial<HealthIndexer> = {}): HealthIndexer {
  return { id, name, enableRss: true, enableAutomaticSearch: true, enableInteractiveSearch: true, ...extra };
}

const qbit = { id: 1, name: 'qBittorrent', host: 'qbit' };

async function run(check: HealthCheckDef, deps: HealthDeps) {
  return check.run(deps);
}

// ---------------------------------------------------------------------------------------
// Root folders, disks, mounts
// ---------------------------------------------------------------------------------------

describe('root folder checks', () => {
  it('warns when no root folders exist', async () => {
    const [r] = await run(rootFolderCheck, fakeDeps({ rootFolders: async () => [] }));
    expect(r).toMatchObject({ source: 'RootFolderCheck', status: 'warning', wikiUrl: '/docs/system/health#no-root-folders' });
  });

  it('reports one or several missing root folders as an error', async () => {
    const one = await run(rootFolderCheck, fakeDeps({}, { dirs: new Set(['/movies']) }));
    expect(one).toEqual([expect.objectContaining({ status: 'error', message: 'Missing root folder: /tv' })]);
    const both = await run(rootFolderCheck, fakeDeps({}, { dirs: new Set() }));
    expect(both[0]?.message).toBe('Multiple root folders are missing: /tv | /movies');
    expect(both[0]?.wikiUrl).toContain('#missing-root-folder');
  });

  it('reports root folders that cannot be written', async () => {
    const [r] = await run(rootFolderCheck, fakeDeps({}, { unwritable: new Set(['/movies']) }));
    expect(r).toMatchObject({ status: 'error', wikiUrl: expect.stringContaining('#root-folder-not-writable') });
    expect(r?.message).toContain('/movies');
  });

  it('warns about an empty root folder only when items live there', async () => {
    const [r] = await run(rootFolderCheck, fakeDeps({}, { empty: new Set(['/tv', '/movies']) }));
    expect(r).toMatchObject({ status: 'warning', message: 'Empty root folder: /tv' });
    expect(await run(rootFolderCheck, fakeDeps())).toEqual([]);
  });

  it('warns when a root folder has less than 1 GiB free', async () => {
    const [r] = await run(rootFolderFreeSpaceCheck, fakeDeps({}, { free: new Map([['/movies', 512 * 1024 ** 2]]) }));
    expect(r).toMatchObject({ status: 'warning', message: 'Less than 1 GiB free on root folder(s): /movies (512 MiB)' });
    expect(await run(rootFolderFreeSpaceCheck, fakeDeps())).toEqual([]);
  });

  it('keeps the config volume free-space warning', async () => {
    expect(await run(configDiskSpaceCheck, fakeDeps({}, { free: new Map([['/config', 10 * 1024 ** 2]]) }))).toEqual([
      expect.objectContaining({ source: 'ConfigDiskSpace', status: 'warning' }),
    ]);
  });

  it('reports read-only mounts containing a root folder', async () => {
    const [r] = await run(mountReadOnlyCheck, fakeDeps({}, { readOnlyMounts: new Map([['/mnt/nas', '/tv']]) }));
    expect(r).toMatchObject({ status: 'error', message: 'Mount containing a library path is mounted read-only: /mnt/nas (/tv)' });
    expect(await run(mountReadOnlyCheck, fakeDeps())).toEqual([]);
  });

  it('parses /proc/mounts and picks the longest containing mount', () => {
    const mounts = ['overlay / overlay rw,relatime 0 0', '//nas/tv /mnt/my\\040tv cifs ro,relatime 0 0', ''].join('\n');
    expect(findMount(mounts, '/mnt/my tv/Show')).toEqual({ mountPoint: '/mnt/my tv', readOnly: true });
    expect(findMount(mounts, '/config')).toEqual({ mountPoint: '/', readOnly: false });
  });

  it('reports a configured recycle bin that is missing or unwritable', async () => {
    expect(await run(recycleBinCheck, fakeDeps())).toEqual([]);
    const [r] = await run(recycleBinCheck, fakeDeps({ recycleBin: () => '/recycle' }));
    expect(r).toMatchObject({ status: 'error', wikiUrl: expect.stringContaining('#cannot-write-recycle-bin') });
    expect(await run(recycleBinCheck, fakeDeps({ recycleBin: () => '/tv' }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
// Download clients
// ---------------------------------------------------------------------------------------

describe('download client checks', () => {
  it('warns when no download client is enabled', async () => {
    const [r] = await run(downloadClientCheck, fakeDeps());
    expect(r).toMatchObject({ status: 'warning', message: 'No download client is available' });
  });

  it('uses the poller outcome and names the first unreachable client', async () => {
    const deps = fakeDeps({}, {
      clients: [qbit, { id: 2, name: 'Other', host: 'o' }],
      polls: new Map([[1, { ok: false, message: 'Connection refused' }]]),
    });
    const [r] = await run(downloadClientCheck, deps);
    expect(r).toMatchObject({ status: 'error', message: 'Unable to communicate with qBittorrent. Connection refused' });
  });

  it('probes live when the poller has not run yet', async () => {
    const down = fakeDeps({}, { clients: [qbit], tests: new Map([[1, { ok: false, message: 'Unauthorized' }]]) });
    expect((await run(downloadClientCheck, down))[0]?.message).toBe('Unable to communicate with qBittorrent. Unauthorized');
    expect(await run(downloadClientCheck, fakeDeps({}, { clients: [qbit] }))).toEqual([]);
  });

  it('warns when a client removes completed downloads itself', async () => {
    const deps = fakeDeps({}, {
      clients: [qbit],
      statuses: new Map([[1, { outputRootDir: '/downloads', isLocalhost: true, removesCompletedDownloads: true }]]),
    });
    expect((await run(downloadClientRemovesCompletedCheck, deps))[0]?.message).toContain('qBittorrent is set to remove completed downloads');
  });

  it('flags stale completed downloads after the threshold as needing manual interaction', async () => {
    let now = NOW;
    const check = createStaleImportCheck(60 * 60_000);
    const deps = fakeDeps({ now: () => now, pendingImports: () => [{ id: 7, title: 'Show.S01E01' }] });
    expect(await run(check, deps)).toEqual([]);
    now = new Date(NOW.getTime() + 61 * 60_000);
    const [r] = await run(check, deps);
    expect(r).toMatchObject({ source: 'ImportPendingCheck', status: 'warning', wikiUrl: expect.stringContaining('#downloads-awaiting-manual-import') });
    expect(r?.message).toContain('manual interaction required: Show.S01E01');
  });
});

describe('remote path mapping check', () => {
  const status = (outputRootDir: string, isLocalhost: boolean) =>
    new Map([[1, { outputRootDir, isLocalhost, removesCompletedDownloads: false }]]);

  it('passes when the output folder exists locally (after mappings)', async () => {
    const deps = fakeDeps({}, {
      clients: [qbit],
      statuses: status('/data/torrents', false),
      mappings: [{ host: 'qbit', remote: '/data/torrents', local: '/downloads' }],
    });
    expect(await run(remotePathMappingCheck, deps)).toEqual([]);
  });

  it('remote client with a path that is not valid locally', async () => {
    const [r] = await run(remotePathMappingCheck, fakeDeps({}, { clients: [qbit], statuses: status('D:\\Torrents', false) }));
    expect(r).toMatchObject({ status: 'error', wikiUrl: expect.stringContaining('#bad-remote-path-mapping') });
    expect(r?.message).toBe(
      'Remote download client qBittorrent places downloads in D:\\Torrents but this is not a valid Linux path. Review your remote path mappings and download client settings.',
    );
  });

  it('docker: folder missing inside the container', async () => {
    const deps = fakeDeps({ isDocker: true }, { clients: [qbit], statuses: status('/data/torrents/tv', true) });
    const [r] = await run(remotePathMappingCheck, deps);
    expect(r?.message).toContain('does not appear to exist inside the container');
    expect(r?.wikiUrl).toContain('#docker-bad-remote-path-mapping');
  });

  it('remote vs local client with a missing folder', async () => {
    const remote = await run(remotePathMappingCheck, fakeDeps({}, { clients: [qbit], statuses: status('/data/x', false) }));
    expect(remote[0]?.message).toContain('Likely missing or incorrect remote path mapping');
    const local = await run(remotePathMappingCheck, fakeDeps({}, { clients: [qbit], statuses: status('/data/x', true) }));
    expect(local[0]?.message).toContain('Arclight cannot see this directory');
    expect(local[0]?.wikiUrl).toContain('#permissions-error');
  });

  it('skips clients that are unreachable or fail to report status', async () => {
    const deps = fakeDeps({}, {
      clients: [qbit, { id: 2, name: 'B', host: 'b' }],
      polls: new Map([[1, { ok: false, message: 'down' }]]),
      statuses: new Map<number, HealthClientStatus | Error>([[1, { outputRootDir: '/nope', isLocalhost: true, removesCompletedDownloads: false }], [2, new Error('boom')]]),
    });
    expect(await run(remotePathMappingCheck, deps)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
// Indexers
// ---------------------------------------------------------------------------------------

describe('indexer checks', () => {
  it('errors when no indexer is enabled and suppresses the RSS/search variants', async () => {
    const off = indexer(1, 'Off', { enableRss: false, enableAutomaticSearch: false, enableInteractiveSearch: false });
    const deps = fakeDeps({ indexers: () => [off] });
    expect((await run(indexerCheck, deps))[0]).toMatchObject({ status: 'error', message: 'No indexers enabled, Arclight will not return search results' });
    expect(await run(indexerRssCheck, deps)).toEqual([]);
    expect(await run(indexerSearchCheck, deps)).toEqual([]);
    expect(await run(indexerCheck, fakeDeps())).toEqual([]);
  });

  it('all indexers blocked is an error; some is a warning listing names', async () => {
    const blocked = { disabledTill: inMinutes(30), initialFailure: hoursAgo(1) };
    const all = fakeDeps({ indexers: () => [indexer(1, 'A', blocked), indexer(2, 'B', blocked)] });
    expect((await run(indexerStatusCheck, all))[0]).toMatchObject({ status: 'error', message: 'All indexers are unavailable due to failures' });
    const some = fakeDeps({ indexers: () => [indexer(1, 'A', blocked), indexer(2, 'B')] });
    expect((await run(indexerStatusCheck, some))[0]).toMatchObject({ status: 'warning', message: 'Indexers unavailable due to failures: A' });
    expect(await run(indexerLongTermStatusCheck, some)).toEqual([]);
  });

  it('splits short-term and long-term failures at 6 hours', async () => {
    const deps = fakeDeps({
      indexers: () => [
        indexer(1, 'Fresh', { disabledTill: inMinutes(5), initialFailure: hoursAgo(2) }),
        indexer(2, 'Old', { disabledTill: inMinutes(5), initialFailure: hoursAgo(8) }),
        indexer(3, 'Expired', { disabledTill: hoursAgo(1), initialFailure: hoursAgo(9) }),
      ],
    });
    expect((await run(indexerStatusCheck, deps))[0]?.message).toBe('Indexers unavailable due to failures: Fresh');
    expect((await run(indexerLongTermStatusCheck, deps))[0]?.message).toBe('Indexers unavailable due to failures for more than 6 hours: Old');
  });

  it('RSS disabled everywhere is an error; all RSS indexers blocked a warning', async () => {
    const noRss = fakeDeps({ indexers: () => [indexer(1, 'A', { enableRss: false })] });
    expect((await run(indexerRssCheck, noRss))[0]).toMatchObject({ status: 'error', wikiUrl: expect.stringContaining('#no-indexers-available-with-rss-sync-enabled') });
    const blocked = fakeDeps({ indexers: () => [indexer(1, 'A', { disabledTill: inMinutes(5) })] });
    expect((await run(indexerRssCheck, blocked))[0]?.status).toBe('warning');
  });

  it('search checks: automatic first, then interactive, then back-off', async () => {
    const noAuto = fakeDeps({ indexers: () => [indexer(1, 'A', { enableAutomaticSearch: false, enableInteractiveSearch: false })] });
    expect((await run(indexerSearchCheck, noAuto))[0]?.message).toContain('Automatic Search');
    const noInteractive = fakeDeps({ indexers: () => [indexer(1, 'A', { enableInteractiveSearch: false })] });
    expect((await run(indexerSearchCheck, noInteractive))[0]?.message).toContain('Interactive Search');
    const blocked = fakeDeps({ indexers: () => [indexer(1, 'A', { disabledTill: inMinutes(5) })] });
    expect((await run(indexerSearchCheck, blocked))[0]?.message).toBe('All search-capable indexers are temporarily unavailable due to recent indexer errors');
    expect(await run(indexerSearchCheck, fakeDeps())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
// System, metadata, notifications
// ---------------------------------------------------------------------------------------

describe('system checks', () => {
  it('errors when the TMDB key is missing', async () => {
    expect((await run(metadataSourceCheck, fakeDeps({ tmdbKeyConfigured: () => false })))[0]).toMatchObject({
      status: 'error',
      wikiUrl: '/docs/system/health#tmdb-api-key-missing',
    });
    expect(await run(metadataSourceCheck, fakeDeps())).toEqual([]);
  });

  it('update and system time checks are stubs that pass', async () => {
    expect(await run(updateCheck, fakeDeps())).toEqual([]);
    expect(await run(systemTimeCheck, fakeDeps())).toEqual([]);
  });

  it('docker: config volume not writable by the container user', async () => {
    expect(await run(dockerPermissionsCheck, fakeDeps({}, { unwritable: new Set(['/config']) }))).toEqual([]);
    const [r] = await run(dockerPermissionsCheck, fakeDeps({ isDocker: true }, { unwritable: new Set(['/config']) }));
    expect(r?.message).toContain('running as uid 1000, gid 1000');
    expect(r?.message).toContain('owned by uid 0, gid 0');
    expect(r?.wikiUrl).toContain('#docker-puid-pgid-mismatch');
    expect(await run(dockerPermissionsCheck, fakeDeps({ isDocker: true }))).toEqual([]);
  });

  it('notifications: misconfigured connections and failure status', async () => {
    const bad = fakeDeps({ notifications: { enabled: () => [], misconfigured: () => [{ id: 1, name: 'Discord', error: 'x' }] } });
    expect((await run(notificationConfigCheck, bad))[0]?.message).toContain('Notifications misconfigured: Discord');
    const some = fakeDeps({
      notifications: {
        enabled: () => [
          { id: 1, name: 'A', consecutiveFailures: 2 },
          { id: 2, name: 'B', consecutiveFailures: 0 },
        ],
        misconfigured: () => [],
      },
    });
    expect((await run(notificationStatusCheck, some))[0]).toMatchObject({ status: 'warning', message: 'Notifications unavailable due to failures: A' });
    const all = fakeDeps({ notifications: { enabled: () => [{ id: 1, name: 'A', consecutiveFailures: 1 }], misconfigured: () => [] } });
    expect((await run(notificationStatusCheck, all))[0]?.status).toBe('error');
  });
});

// ---------------------------------------------------------------------------------------
// Service and module
// ---------------------------------------------------------------------------------------

describe('HealthService', () => {
  it('isolates throwing checks, caches results and derives the overall status', async () => {
    let runs = 0;
    const checks: HealthCheckDef[] = [
      { id: 'Boom', run: async () => { throw new Error('boom'); } },
      { id: 'Warn', run: async () => { runs++; return [{ source: 'Warn', status: 'warning', message: 'w' }]; } },
    ];
    const service = new HealthService(checks, () => fakeDeps());
    const first = await service.current();
    expect(first).toEqual({ status: 'warning', checks: [{ source: 'Warn', status: 'warning', message: 'w' }] });
    await service.current();
    expect(runs).toBe(1);
    await service.run();
    expect(runs).toBe(2);
    expect(service.lastRunAt()).toEqual(NOW);
  });
});

describe('health module', () => {
  it('serves cached health, rechecks on demand and publishes a health event', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'arclight-health-'));
    try {
      const db = await createTestDb({ ...notificationTables });
      const bus = new EventBus();
      const log = pino({ level: 'silent' });
      const ctx: AppContext = {
        config: { configDir, dbPath: ':memory:', logDir: configDir, port: 0, host: '127.0.0.1', logLevel: 'silent', isDocker: false, webDist: null },
        db,
        bus,
        scheduler: new Scheduler(db, bus, log),
        log,
        startedAt: NOW,
      };
      const events: ServerEvent[] = [];
      bus.subscribe((e) => events.push(e));
      const app = Fastify().withTypeProvider<ZodTypeProvider>();
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);
      await app.register(healthModule(ctx), { prefix: '/api/v1' });

      const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
      expect(res.statusCode).toBe(200);
      const sources = (res.json().checks as Array<{ source: string }>).map((c) => c.source);
      expect(sources).toEqual(expect.arrayContaining(['RootFolderCheck', 'DownloadClientCheck', 'IndexerCheck']));
      expect(events).toEqual([]);

      const recheck = await app.inject({ method: 'POST', url: '/api/v1/health/recheck' });
      expect(recheck.statusCode).toBe(200);
      expect(recheck.json().status).toBe('error');
      expect(events).toEqual([expect.objectContaining({ type: 'health' })]);
      expect(ctx.scheduler.has('HealthCheck')).toBe(true);
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });
});

describe('VpnDisconnected', () => {
  const base = { enabled: true, provider: 'gluetun' as const, lastChecked: NOW.toISOString(), lastChanged: null };

  it('passes when the VPN is disabled or not wired', async () => {
    expect(await run(vpnDisconnectedCheck, fakeDeps())).toEqual([]);
    expect(await run(vpnDisconnectedCheck, fakeDeps({ vpn: async () => ({ ...base, enabled: false, connected: false }) }))).toEqual([]);
  });

  it('errors when enabled and not connected', async () => {
    const out = await run(vpnDisconnectedCheck, fakeDeps({ vpn: async () => ({ ...base, connected: false, error: 'Gluetun reports the VPN is stopped.' }) }));
    expect(out).toEqual([expect.objectContaining({ source: 'VpnDisconnected', status: 'error' })]);
    expect(out[0]!.message).toMatch(/not connected.*stopped/);
  });

  it('warns when the public IP equals the home IP', async () => {
    const out = await run(vpnDisconnectedCheck, fakeDeps({ vpn: async () => ({ ...base, connected: true, publicIp: '1.2.3.4', leak: true }) }));
    expect(out).toEqual([expect.objectContaining({ status: 'warning', wikiUrl: '/docs/system/health#vpn-leak' })]);
  });
});

describe('download checks', () => {
  const MIB = 1024 ** 2;
  const downloads = [
    { id: 1, title: 'A', path: '/downloads/tv/A', sizeLeft: 600 * MIB },
    { id: 2, title: 'B', path: '/downloads/tv/B', sizeLeft: 300 * MIB, stalledSince: hoursAgo(1) },
    { id: 3, title: 'C', sizeLeft: 5 * GIB },
  ];

  it('skips without the download dependency', async () => {
    expect(await run(downloadDiskSpaceCheck, fakeDeps())).toEqual([]);
    expect(await run(stalledDownloadsCheck, fakeDeps())).toEqual([]);
  });

  it('errors when the downloads cannot fit and warns when they would eat the minimum free space', async () => {
    const tight = fakeDeps({ activeDownloads: async () => downloads, minimumFreeSpaceBytes: () => 100 * MIB }, { free: new Map([['/downloads/tv', 500 * MIB]]) });
    const full = await run(downloadDiskSpaceCheck, tight);
    expect(full).toEqual([expect.objectContaining({ source: 'DownloadDiskSpace', status: 'error', wikiUrl: expect.stringContaining('download-disk-space-full') })]);
    expect(full[0]!.message).toContain('2 download(s) in /downloads/tv still need 900 MiB but only 500 MiB is free');

    const low = fakeDeps({ activeDownloads: async () => downloads, minimumFreeSpaceBytes: () => 200 * MIB }, { free: new Map([['/downloads/tv', 1000 * MIB]]) });
    expect(await run(downloadDiskSpaceCheck, low)).toEqual([expect.objectContaining({ status: 'warning', message: expect.stringContaining('100 MiB free') })]);

    const roomy = fakeDeps({ activeDownloads: async () => downloads, minimumFreeSpaceBytes: () => 100 * MIB });
    expect(await run(downloadDiskSpaceCheck, roomy)).toEqual([]);
  });

  it('looks at the parent folder while the download folder does not exist yet', async () => {
    const deps = fakeDeps({ activeDownloads: async () => [{ id: 1, title: 'A', path: '/downloads/new/A', sizeLeft: 2 * GIB }] });
    deps.fs.freeSpace = async (p) => (p === '/downloads' ? GIB : null);
    expect(await run(downloadDiskSpaceCheck, deps)).toEqual([expect.objectContaining({ status: 'error' })]);
  });

  it('reports what the disk-space guard paused or holds, and clears when nothing is', async () => {
    expect(await run(diskGuardCheck, fakeDeps())).toEqual([]);
    const idle = { pausedTitles: [], heldTitles: [], volumes: [], minimumFreeBytes: 100 * MIB };
    expect(await run(diskGuardCheck, fakeDeps({ diskGuard: async () => idle }))).toEqual([]);
    const busy = fakeDeps({
      diskGuard: async () => ({ ...idle, pausedTitles: ['A'], heldTitles: ['B', 'C'], volumes: [{ path: '/downloads/tv', freeBytes: 50 * MIB }] }),
    });
    const findings = await run(diskGuardCheck, busy);
    expect(findings).toEqual([
      expect.objectContaining({ source: 'DownloadDiskGuard', status: 'error', wikiUrl: expect.stringContaining('download-disk-guard-paused') }),
      expect.objectContaining({ status: 'warning', wikiUrl: expect.stringContaining('download-disk-guard-held') }),
    ]);
    expect(findings[0]!.message).toContain('Paused 1 download(s) because the download volume is below the 100 MiB minimum free space: /downloads/tv (50 MiB free)');
    expect(findings[1]!.message).toContain('2 grab(s) are held until the download volume has room');
  });

  it('lists stalled downloads', async () => {
    const findings = await run(stalledDownloadsCheck, fakeDeps({ activeDownloads: async () => downloads }));
    expect(findings).toEqual([expect.objectContaining({ source: 'DownloadStalled', status: 'warning' })]);
    expect(findings[0]!.message).toBe(`1 download(s) stopped receiving data: B (since ${hoursAgo(1)})`);
  });
});

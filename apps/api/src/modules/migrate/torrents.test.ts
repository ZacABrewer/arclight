import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bencode, createTorrent, Session, type Metainfo } from '@arclight/torrent-engine';
import type { MigrateApplyOptionsInput, MigrateSourceInput, MigrationResult } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import * as t from '../../db/schema.js';
import { createTestDb } from '../../db/test-utils.js';
import { adoptedHashes, cleanupSourceTorrents, ADOPTED_AREA } from './areas-torrents.js';
import { resolveRatio, resolveSeedTime, testQbittorrent } from './qbittorrent-reader.js';
import { migrateImported, migrateStaging } from './schema.js';
import { MigrateService, sourceInstance } from './service.js';

// qBittorrent import against temp folders, a real (loopback, DHT-off) engine Session and a
// fake qBittorrent WebUI. Nothing leaves the machine.

let tmp: string;
let db: Db;
let session: Session | null;

interface Fixture {
  torrent: Buffer;
  meta: Metainfo;
  files: { path: string[]; data: Buffer }[];
}

function makeTorrent(name: string): Fixture {
  const files = [
    { path: ['e01.mkv'], data: randomBytes(70_000) },
    { path: ['e02.mkv'], data: randomBytes(50_000) },
  ];
  const { torrent, metainfo } = createTorrent({ name, files, pieceLength: 16 * 1024 });
  return { torrent, meta: metainfo, files };
}

function writeData(root: string, f: Fixture, which: number[] = [0, 1]): void {
  for (const i of which) {
    const file = f.files[i]!;
    const full = join(root, f.meta.name, ...file.path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, file.data);
  }
}

function fastresume(f: Fixture, extra: Record<string, unknown> = {}) {
  return {
    'qBt-savePath': '/qbt/downloads',
    save_path: '/qbt/downloads',
    'qBt-category': 'tv-sonarr',
    'qBt-tags': ['keep'],
    total_uploaded: 900_000,
    total_downloaded: 120_000,
    seeding_time: 7200,
    active_time: 9000,
    added_time: 1_700_000_000,
    completed_time: 1_700_000_500,
    'qBt-ratioLimit': -2000,
    'qBt-seedingTimeLimit': 10_080,
    paused: 0,
    pieces: Buffer.alloc(f.meta.pieceCount, 1),
    ...extra,
  };
}

function writeBackup(dir: string, f: Fixture, resume: Record<string, unknown>, withTorrent = true): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${f.meta.infoHashHex}.fastresume`), bencode(resume as never));
  if (withTorrent) writeFileSync(join(dir, `${f.meta.infoHashHex}.torrent`), f.torrent);
}

function addGrab(hash: string, imported = false): void {
  const base = { mediaType: 'series' as const, seriesId: 7, movieId: null, sourceTitle: 'Show.S01.1080p', quality: {} as never, languages: [], data: {}, downloadId: hash.toUpperCase() };
  db.insert(t.history).values({ ...base, eventType: 'grabbed', episodeId: 11, date: '2024-01-01T00:00:00.000Z' }).run();
  if (imported) db.insert(t.history).values({ ...base, eventType: 'downloadFolderImported', episodeId: 11, date: '2024-01-02T00:00:00.000Z' }).run();
}

function service(fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>): MigrateService {
  return new MigrateService({
    db,
    now: () => new Date('2024-06-01T00:00:00Z'),
    deps: { torrentSession: () => session, ...(fetchImpl ? { fetch: fetchImpl } : {}) },
  });
}

function filesSource(): MigrateSourceInput {
  return { app: 'qbittorrent', mode: 'files', dbPath: join(tmp, 'qbt-config'), pathMappings: [{ from: '/qbt/downloads', to: join(tmp, 'downloads') }] };
}

const area = (r: MigrationResult) => r.areas.find((a) => a.area === 'torrents')!;

async function startSession(): Promise<Session> {
  const s = new Session({ settings: { listenPort: 0, listenAddress: '127.0.0.1', dht: false, savePath: join(tmp, 'engine') } });
  await s.start();
  return s;
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'mt-qbt-'));
  db = await createTestDb({ migrateImported, migrateStaging });
  session = await startSession();
});

afterEach(async () => {
  await session?.shutdown();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('limits', () => {
  it('resolves qBittorrent share limits without ever stopping earlier', () => {
    expect(resolveRatio(-1, { max_ratio_enabled: true, max_ratio: 1 })).toBeNull();
    expect(resolveRatio(-2, { max_ratio_enabled: true, max_ratio: 1.5 })).toBe(1.5);
    expect(resolveRatio(-2, { max_ratio_enabled: false, max_ratio: 1.5 })).toBeNull();
    expect(resolveRatio(3, null)).toBe(3);
    expect(resolveSeedTime(-2, { max_seeding_time_enabled: true, max_seeding_time: 60 })).toBe(3_600_000);
    expect(resolveSeedTime(-1, null)).toBeNull();
    expect(resolveSeedTime(30, null)).toBe(1_800_000);
  });
});

describe('files mode (BT_backup)', () => {
  it('plans torrents per category, links grab history by info-hash and flags torrents without metadata', async () => {
    const a = makeTorrent('Show.S01');
    const b = makeTorrent('Other');
    const backup = join(tmp, 'qbt-config', 'qBittorrent', 'BT_backup');
    writeBackup(backup, a, fastresume(a));
    writeBackup(backup, b, fastresume(b, { 'qBt-category': 'movies' }), false);
    writeData(join(tmp, 'downloads'), a);
    addGrab(a.meta.infoHashHex);

    const plan = await service().plan(filesSource());
    expect(plan.areas.find((x) => x.area === 'torrents')).toMatchObject({ total: 2, create: 1, unsupported: 1 });
    expect(plan.unsupported[0]!.reason).toMatch(/no metadata yet/);
    const tv = plan.torrentCategories!.find((c) => c.category === 'tv-sonarr')!;
    expect(tv).toMatchObject({ count: 1, complete: 1, linked: 1, savePath: join(tmp, 'downloads') });
    expect(tv.sizeBytes).toBe(120_000);
    expect(await testQbittorrent({ ...filesSource(), mode: 'files', pathMappings: [], app: 'qbittorrent' } as never, {})).toMatchObject({ ok: true });
  });

  it('adopts a complete torrent with recheck: seeding at once, nothing downloaded, totals and limits kept, paused until confirmed', async () => {
    const a = makeTorrent('Show.S01');
    writeBackup(join(tmp, 'qbt-config', 'BT_backup'), a, fastresume(a));
    writeData(join(tmp, 'downloads'), a);
    addGrab(a.meta.infoHashHex, true);

    const result = await service().apply(filesSource());
    expect(area(result)).toMatchObject({ created: 1, failed: 0 });
    const torrent = session!.getTorrent(a.meta.infoHashHex)!;
    expect(torrent.isComplete).toBe(true);
    const stats = torrent.getStats();
    // The engine re-hashed the existing data; nothing came from the network.
    expect(stats.downloaded).toBe(120_000);
    expect(stats.uploaded).toBe(900_000);
    expect(stats.progress).toBe(1);
    expect(stats.state).toBe('paused');
    expect(torrent.category).toBe('tv-sonarr');
    expect(torrent.tags).toEqual(['keep']);
    expect(torrent.seedRatioLimit).toBeNull();
    expect(torrent.seedTimeLimitMs).toBe(10_080 * 60_000);
    expect(result.items.find((i) => i.area === 'torrents')!.message).toMatch(/verified 100%.*paused in Arclight until qBittorrent stops using it.*linked to its import/);

    const tracked = db.select().from(t.trackedDownloads).all();
    expect(tracked).toHaveLength(1);
    expect(tracked[0]).toMatchObject({ downloadId: a.meta.infoHashHex, state: 'imported', seriesId: 7, episodeIds: [11] });
    expect(db.select().from(t.downloadClients).all().map((c) => c.implementation)).toEqual(['builtin']);
    const instance = sourceInstance({ app: 'qbittorrent', mode: 'files', dbPath: join(tmp, 'qbt-config') });
    expect(adoptedHashes(db, instance)).toEqual([a.meta.infoHashHex]);

    // Idempotent: a second run changes nothing.
    const again = await service().apply(filesSource());
    expect(area(again)).toMatchObject({ created: 0, failed: 0 });
    expect(db.select().from(t.trackedDownloads).all()).toHaveLength(1);
    expect(session!.getTorrents()).toHaveLength(1);
  });

  it('trust mode takes size-matching data as complete without hashing', async () => {
    const a = makeTorrent('Show.S01');
    writeBackup(join(tmp, 'qbt-config', 'BT_backup'), a, fastresume(a));
    writeData(join(tmp, 'downloads'), a);
    // Same size, different bytes: only hashing would notice.
    writeFileSync(join(tmp, 'downloads', 'Show.S01', 'e02.mkv'), Buffer.alloc(50_000, 7));
    const result = await service().apply(filesSource(), { torrents: { verify: 'trust' } });
    expect(result.items[0]!.message).toMatch(/taken as complete/);
    expect(session!.getTorrent(a.meta.infoHashHex)!.isComplete).toBe(true);
  });

  it('continues a partial torrent from its verified pieces', async () => {
    const a = makeTorrent('Show.S01');
    const pieces = Buffer.alloc(a.meta.pieceCount, 0);
    pieces.fill(1, 0, 4);
    writeBackup(join(tmp, 'qbt-config', 'BT_backup'), a, fastresume(a, { pieces, completed_time: 0 }));
    writeData(join(tmp, 'downloads'), a, [0]);
    const result = await service().apply(filesSource());
    expect(area(result)).toMatchObject({ created: 1 });
    const stats = session!.getTorrent(a.meta.infoHashHex)!.getStats();
    expect(stats.progress).toBeGreaterThan(0.5);
    expect(stats.progress).toBeLessThan(1);
    expect(result.items[0]!.message).toMatch(/downloads only the rest/);
  });

  it('skips a complete torrent whose files are missing instead of downloading it again', async () => {
    const a = makeTorrent('Show.S01');
    writeBackup(join(tmp, 'qbt-config', 'BT_backup'), a, fastresume(a));
    writeData(join(tmp, 'downloads'), a, [0]);
    const result = await service().apply(filesSource());
    expect(area(result)).toMatchObject({ created: 0, skipped: 1 });
    expect(result.items[0]!.message).toMatch(/missing, renamed.*download them again/);
    expect(session!.getTorrents()).toHaveLength(0);
  });

  it('a dry run checks everything and changes nothing', async () => {
    const a = makeTorrent('Show.S01');
    writeBackup(join(tmp, 'qbt-config', 'BT_backup'), a, fastresume(a));
    writeData(join(tmp, 'downloads'), a);
    addGrab(a.meta.infoHashHex);
    const result = await service().apply(filesSource(), { dryRun: true });
    expect(area(result)).toMatchObject({ created: 1 });
    expect(result.items[0]!.message).toMatch(/would adopt/);
    expect(session!.getTorrents()).toHaveLength(0);
    expect(db.select().from(t.trackedDownloads).all()).toHaveLength(0);
    expect(db.select().from(t.downloadClients).all()).toHaveLength(0);
    expect(db.select().from(migrateImported).all()).toHaveLength(0);
  });

  it('fails adoption clearly when the engine is off and skips categories set to skip', async () => {
    const a = makeTorrent('Show.S01');
    writeBackup(join(tmp, 'qbt-config', 'BT_backup'), a, fastresume(a));
    writeData(join(tmp, 'downloads'), a);
    await session!.shutdown();
    session = null;
    const off = await service().apply(filesSource());
    expect(area(off)).toMatchObject({ failed: 1 });
    expect(off.items[0]!.message).toMatch(/engine is not running/);
    const skipped = await service().apply(filesSource(), { torrents: { categories: { 'tv-sonarr': 'skip' } } });
    expect(area(skipped)).toMatchObject({ skipped: 1, failed: 0 });
  });
});

// ---- API mode -----------------------------------------------------------------------------------

interface FakeCall {
  method: string;
  path: string;
  form: Record<string, string>;
}

function fakeQbt(torrents: object[], exports: Map<string, Buffer>) {
  const calls: FakeCall[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const form: Record<string, string> = {};
    if (init?.body instanceof URLSearchParams) init.body.forEach((v, k) => (form[k] = v));
    const method = init?.method ?? 'GET';
    calls.push({ method, path: u.pathname, form });
    if (u.pathname === '/api/v2/auth/login') return form['password'] === 'pw' ? new Response('Ok.', { headers: { 'set-cookie': 'SID=s1; path=/' } }) : new Response('Fails.');
    if (!(new Headers(init?.headers).get('cookie') ?? '').includes('SID=s1')) return new Response('Forbidden', { status: 403 });
    switch (u.pathname) {
      case '/api/v2/app/webapiVersion':
        return new Response('2.11.2');
      case '/api/v2/app/version':
        return new Response('v5.0.2');
      case '/api/v2/app/preferences':
        return Response.json({ save_path: '/qbt/downloads', max_ratio_enabled: true, max_ratio: 2, max_seeding_time_enabled: false, max_seeding_time: 0 });
      case '/api/v2/torrents/info':
        return Response.json(torrents);
      case '/api/v2/torrents/files':
        return Response.json([]);
      case '/api/v2/torrents/export': {
        const bytes = exports.get(u.searchParams.get('hash') ?? '');
        return bytes ? new Response(new Uint8Array(bytes)) : new Response('', { status: 404 });
      }
      case '/api/v2/torrents/stop':
      case '/api/v2/torrents/start':
      case '/api/v2/torrents/delete':
        return new Response('');
      default:
        return new Response('Not Found', { status: 404 });
    }
  };
  return { calls, fetch: fetchImpl };
}

function apiTorrent(f: Fixture, category: string, extra: object = {}) {
  return {
    hash: f.meta.infoHashHex.toUpperCase(),
    name: f.meta.name,
    category,
    tags: 'a,b',
    save_path: '/qbt/downloads',
    content_path: `/qbt/downloads/${f.meta.name}`,
    size: 120_000,
    progress: 1,
    amount_left: 0,
    state: 'stalledUP',
    added_on: 1_700_000_000,
    completion_on: 1_700_000_100,
    uploaded: 500_000,
    downloaded: 120_000,
    ratio_limit: -2,
    seeding_time_limit: -1,
    seeding_time: 3600,
    ...extra,
  };
}

function apiSource(): MigrateSourceInput {
  return { app: 'qbittorrent', mode: 'api', url: 'http://qbittorrent:8080', username: 'admin', password: 'pw', pathMappings: [{ from: '/qbt/downloads', to: join(tmp, 'downloads') }] };
}

describe('API mode', () => {
  it('adopts after pausing in qBittorrent when confirmed, keeps it running in Arclight, and cleans up only adopted torrents', async () => {
    const a = makeTorrent('Show.S01');
    const b = makeTorrent('Movie');
    writeData(join(tmp, 'downloads'), a);
    const fake = fakeQbt([apiTorrent(a, 'tv-sonarr'), apiTorrent(b, 'radarr')], new Map([[a.meta.infoHashHex, a.torrent]]));
    const options: MigrateApplyOptionsInput = { torrents: { categories: { radarr: 'skip' }, pauseInSource: true, confirmSourceChanges: true } };

    const result = await service(fake.fetch).apply(apiSource(), options);
    expect(area(result)).toMatchObject({ created: 1, skipped: 1, failed: 0 });
    expect(fake.calls.filter((c) => c.path === '/api/v2/torrents/stop').map((c) => c.form['hashes'])).toEqual([a.meta.infoHashHex]);
    const torrent = session!.getTorrent(a.meta.infoHashHex)!;
    expect(torrent.getStats().state).not.toBe('paused');
    // -2 (global) resolved to qBittorrent's global ratio 2; seeding time -1 = unlimited.
    expect(torrent.seedRatioLimit).toBe(2);
    expect(torrent.seedTimeLimitMs).toBeNull();
    expect(torrent.tags).toEqual(['a', 'b']);

    const source = { app: 'qbittorrent' as const, mode: 'api' as const, url: 'http://qbittorrent:8080', username: 'admin', password: 'pw', pathMappings: [] };
    const hashes = adoptedHashes(db, sourceInstance(source));
    expect(hashes).toEqual([a.meta.infoHashHex]);
    const removed = await cleanupSourceTorrents(source, [...hashes, b.meta.infoHashHex], 'remove', { fetch: fake.fetch, torrentSession: () => session });
    expect(removed).toEqual({ action: 'remove', done: 1, failed: [] });
    expect(fake.calls.filter((c) => c.path === '/api/v2/torrents/delete').map((c) => c.form)).toEqual([{ hashes: a.meta.infoHashHex, deleteFiles: 'false' }]);
  });

  it('keeps a category in qBittorrent behind an external client and links its grabs', async () => {
    const a = makeTorrent('Show.S01');
    const fake = fakeQbt([apiTorrent(a, 'tv-sonarr', { progress: 0.5, amount_left: 60_000, state: 'downloading' })], new Map());
    addGrab(a.meta.infoHashHex);
    const result = await service(fake.fetch).apply(apiSource(), { torrents: { defaultAction: 'external' } });
    expect(area(result)).toMatchObject({ created: 1, failed: 0 });
    const clients = db.select().from(t.downloadClients).all();
    expect(clients).toHaveLength(1);
    expect(clients[0]).toMatchObject({ implementation: 'qbittorrent', name: 'qBittorrent (tv-sonarr)', priority: 50 });
    expect(clients[0]!.settings).toMatchObject({ host: 'qbittorrent', port: 8080, category: 'tv-sonarr', username: 'admin', password: 'pw' });
    expect(db.select().from(t.trackedDownloads).all()[0]).toMatchObject({ clientId: clients[0]!.id, state: 'downloading', seriesId: 7 });
    expect(session!.getTorrents()).toHaveLength(0);
    expect(fake.calls.some((c) => c.method === 'POST' && c.path !== '/api/v2/auth/login')).toBe(false);
    expect(db.select().from(migrateImported).all().some((r) => r.area === ADOPTED_AREA)).toBe(false);
  });

  it('reports a rejected login as an auth problem', async () => {
    const fake = fakeQbt([], new Map());
    await expect(service(fake.fetch).plan({ ...apiSource(), password: 'wrong' } as MigrateSourceInput)).rejects.toThrow(/rejected/);
    expect(await testQbittorrent({ ...apiSource(), mode: 'api', password: 'wrong' } as never, { fetch: fake.fetch })).toMatchObject({ ok: false });
  });
});

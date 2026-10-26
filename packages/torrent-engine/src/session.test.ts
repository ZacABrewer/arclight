import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTorrent } from './create.js';
import { DHT } from './dht/dht.js';
import { toMagnetUri } from './magnet.js';
import type { Metainfo } from './metainfo.js';
import { generatePeerId, Session, type SessionOptions } from './session.js';
import type { SessionSettings } from './settings.js';
import type { Torrent } from './torrent.js';
import { startHttpTracker, type TestHttpTracker } from './tracker/test-trackers.js';

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'mt-session-'));
  cleanups.push(() => rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return d;
}

const FAST: Partial<SessionSettings> = {
  listenPort: 0,
  listenAddress: '127.0.0.1',
  dht: false,
  tickIntervalMs: 50,
  chokeIntervalMs: 300,
  trackerMinIntervalSec: 0,
  trackerRetrySec: 0.2,
  peerRetryMs: 200,
  pexIntervalMs: 200,
  dhtAnnounceIntervalMs: 300,
  connectTimeoutMs: 2000,
  dhtBootstrapNodes: [],
};

async function session(settings: Partial<SessionSettings> = {}, opts: Omit<SessionOptions, 'settings'> = {}): Promise<Session> {
  const s = new Session({ ...opts, settings: { ...FAST, ...settings } });
  await s.start();
  cleanups.push(() => s.shutdown());
  return s;
}

async function tracker(): Promise<TestHttpTracker> {
  const t = await startHttpTracker({ interval: 1 });
  cleanups.push(() => t.close());
  return t;
}

interface Payload {
  files: { path: string[]; data: Buffer }[];
}

function payload(): Payload {
  return {
    files: [
      { path: ['a.bin'], data: randomBytes(150_000) },
      { path: ['dir', 'b.bin'], data: randomBytes(333) },
      { path: ['dir', 'c.bin'], data: randomBytes(260_000) },
    ],
  };
}

async function writePayload(dir: string, name: string, p: Payload): Promise<void> {
  for (const f of p.files) {
    const full = join(dir, name, ...f.path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, f.data);
  }
}

async function verifyPayload(dir: string, name: string, p: Payload): Promise<void> {
  for (const f of p.files) expect((await readFile(join(dir, name, ...f.path))).equals(f.data)).toBe(true);
}

function waitFor<T>(cond: () => T | undefined | false, ms = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      const v = cond();
      if (v) {
        clearInterval(iv);
        resolve(v);
      } else if (Date.now() - start > ms) {
        clearInterval(iv);
        reject(new Error('timed out waiting for condition'));
      }
    }, 20);
  });
}

function completed(t: Torrent): Promise<void> {
  if (t.isComplete) return Promise.resolve();
  return new Promise((resolve) => t.once('completed', () => resolve()));
}

async function seedSetup(announce?: string, settings: Partial<SessionSettings> = {}, opts: Omit<SessionOptions, 'settings'> = {}) {
  const p = payload();
  const seedDir = await tmp();
  await writePayload(seedDir, 'pack', p);
  const created = createTorrent({ name: 'pack', files: p.files, pieceLength: 32 * 1024, ...(announce ? { announce } : {}) });
  const seeder = await session({ savePath: seedDir, ...settings }, opts);
  const st = await seeder.addTorrent({ torrent: created.torrent });
  await waitFor(() => st.state === 'seeding');
  return { p, seedDir, torrent: created.torrent, meta: created.metainfo as Metainfo, seeder, st };
}

describe('Session end-to-end', () => {
  it('downloads a multi-file torrent from a seeder found via a local tracker', async () => {
    const tr = await tracker();
    const { p, seeder, torrent } = await seedSetup(tr.url);
    await waitFor(() => tr.announces.some((a) => a.event === 'started'));
    const leechDir = await tmp();
    const leecher = await session({ savePath: leechDir });
    const states: string[] = [];
    leecher.onStateChange((_t, _prev, next) => states.push(next));
    const done = new Promise<Torrent>((r) => leecher.onCompleted(r));
    const lt = await leecher.addTorrent({ torrent, category: 'tv' });
    await done;
    await verifyPayload(leechDir, 'pack', p);
    const stats = lt.getStats();
    expect(stats.progress).toBe(1);
    expect(stats.state).toBe('seeding');
    expect(stats.downloaded).toBeGreaterThanOrEqual(stats.totalBytes);
    expect(stats.etaSeconds).toBe(0);
    expect(stats.category).toBe('tv');
    expect(states).toContain('downloading');
    expect(states.at(-1)).toBe('seeding');
    expect(lt.hashFailureCount).toBe(0);
    await waitFor(() => tr.announces.some((a) => a.event === 'completed'));
    expect(seeder.getTorrents()[0]?.getStats().uploaded).toBeGreaterThan(0);
    expect(lt.getFiles().every((f) => f.progress === 1)).toBe(true);
  }, 30_000);

  it('downloads via DHT only (no trackers)', async () => {
    const boot = new DHT({ queryTimeoutMs: 300 });
    await boot.listen(0, '127.0.0.1');
    cleanups.push(() => boot.close());
    const dhtSettings: Partial<SessionSettings> = { dht: true, dhtBootstrapNodes: [`127.0.0.1:${boot.port}`] };
    const { p, torrent } = await seedSetup(undefined, dhtSettings, { dht: { queryTimeoutMs: 300 } });
    const leechDir = await tmp();
    const leecher = await session({ savePath: leechDir, ...dhtSettings }, { dht: { queryTimeoutMs: 300 } });
    const lt = await leecher.addTorrent({ torrent });
    await completed(lt);
    await verifyPayload(leechDir, 'pack', p);
    expect(lt.getPeers().some((x) => x.source === 'dht' || x.source === 'incoming')).toBe(true);
  }, 30_000);

  it('fetches metadata from peers for a magnet link (BEP 9) and downloads', async () => {
    const tr = await tracker();
    const { p, meta } = await seedSetup(tr.url);
    const leechDir = await tmp();
    const leecher = await session({ savePath: leechDir });
    const metadata = new Promise<void>((r) => leecher.once('metadata', () => r()));
    const lt = await leecher.addTorrent({ magnet: toMagnetUri({ infoHash: meta.infoHash, name: 'pack', trackers: [tr.url] }) });
    expect(['downloadingMetadata', 'queued']).toContain(lt.state);
    expect(lt.name).toBe('pack');
    await metadata;
    expect(lt.metainfo?.infoHashHex).toBe(meta.infoHashHex);
    await completed(lt);
    await verifyPayload(leechDir, 'pack', p);
  }, 30_000);

  it('downloads from magnets with x.pe peer hints and exchanges peers over PEX', async () => {
    const { p, meta, seeder } = await seedSetup();
    const magnet = toMagnetUri({ infoHash: meta.infoHash, peers: [{ host: '127.0.0.1', port: seeder.listenPort }] });
    const dirA = await tmp();
    const dirB = await tmp();
    // Rate-limited leechers stay incomplete long enough for the seeder to introduce them.
    const a = await session({ savePath: dirA, downloadLimit: 150_000 });
    const b = await session({ savePath: dirB, downloadLimit: 150_000 });
    const ta = await a.addTorrent({ magnet });
    const tb = await b.addTorrent({ magnet });
    await waitFor(() => [...ta.getPeers(), ...tb.getPeers()].some((x) => x.source === 'pex'));
    await Promise.all([completed(ta), completed(tb)]);
    await verifyPayload(dirA, 'pack', p);
    await verifyPayload(dirB, 'pack', p);
  }, 30_000);

  it('moves completed downloads and enforces seed ratio limits', async () => {
    const tr = await tracker();
    const { p, torrent } = await seedSetup(tr.url);
    const leechDir = await tmp();
    const doneDir = join(await tmp(), 'complete');
    const leecher = await session({ savePath: leechDir, completedSavePath: doneDir, seedRatioLimit: 0 });
    const limit = new Promise<Torrent>((r) => leecher.once('seedLimitReached', r));
    const lt = await leecher.addTorrent({ torrent });
    await completed(lt);
    await verifyPayload(doneDir, 'pack', p);
    await expect(stat(join(leechDir, 'pack'))).rejects.toThrow();
    expect(lt.savePath).toBe(doneDir);
    await limit;
    await waitFor(() => lt.state === 'paused');
  }, 30_000);
});

describe('Session management', () => {
  it('generates Azureus-style peer ids', () => {
    const id = generatePeerId('-MT0100-');
    expect(id.length).toBe(20);
    expect(id.subarray(0, 8).toString()).toBe('-MT0100-');
  });

  it('rejects duplicates and bad input', async () => {
    const s = await session({ savePath: await tmp() });
    const { torrent } = createTorrent({ name: 'x', files: [{ path: ['x'], data: randomBytes(100) }] });
    await s.addTorrent({ torrent, paused: true });
    await expect(s.addTorrent({ torrent })).rejects.toThrow('already added');
    await expect(s.addTorrent({})).rejects.toThrow('exactly one');
    await expect(s.addTorrent({ magnet: 'magnet:?dn=x' })).rejects.toThrow();
  });

  it('pauses, resumes, queues and removes torrents with their data', async () => {
    const dir = await tmp();
    const s = await session({ savePath: dir, maxActiveDownloads: 1 });
    const a = await s.addTorrent({ torrent: createTorrent({ name: 'a', files: [{ path: ['a'], data: randomBytes(5000) }] }).torrent });
    const b = await s.addTorrent({ torrent: createTorrent({ name: 'b', files: [{ path: ['b'], data: randomBytes(5000) }] }).torrent });
    await waitFor(() => a.state === 'downloading' && b.state === 'queued');
    await s.pauseTorrent(a.infoHashHex);
    expect(a.state).toBe('paused');
    await waitFor(() => b.state === 'downloading');
    await s.resumeTorrent(a.infoHashHex);
    await waitFor(() => a.state === 'downloading' && b.state === 'queued');
    // b wrote nothing, but a sparse file may exist; removing with deleteData cleans it up
    await s.removeTorrent(a.infoHashHex, true);
    expect(s.getTorrent(a.infoHashHex)).toBeUndefined();
    await expect(stat(join(dir, 'a'))).rejects.toThrow();
    await waitFor(() => b.state === 'downloading');
    expect(s.getSessionStats().torrents).toBe(1);
  });

  it('persists resume data and restores torrents without re-checking', async () => {
    const resumeDir = await tmp();
    const { seedDir, meta, seeder } = await seedSetup(undefined, { resumeDataDir: resumeDir });
    await seeder.shutdown();
    const saved = JSON.parse(await readFile(join(resumeDir, `${meta.infoHashHex}.resume.json`), 'utf8')) as { pieceCount: number };
    expect(saved.pieceCount).toBe(meta.pieceCount);
    // Corrupt a byte but keep size and mtime: a trusted fast-resume does not notice.
    const file = join(seedDir, 'pack', 'a.bin');
    const before = await stat(file);
    const data = await readFile(file);
    data[0] = (data[0] ?? 0) ^ 0xff;
    await writeFile(file, data);
    await utimes(file, before.atime, before.mtime);
    const s2 = await session({ savePath: seedDir, resumeDataDir: resumeDir });
    const restored = s2.getTorrents();
    expect(restored).toHaveLength(1);
    await waitFor(() => restored[0]?.state === 'seeding');
    // A forced re-check finds the damage.
    await restored[0]!.forceRecheck();
    expect(restored[0]!.getStats().piecesHave).toBe(meta.pieceCount - 1);
  });

  it('rebinds the listener at runtime and changes the listen port', async () => {
    const s = await session({ savePath: await tmp() });
    const before = s.listenPort;
    expect(s.getSessionStats().listenAddress).toBe('127.0.0.1');
    await s.bindTo('127.0.0.1');
    expect(s.listenPort).toBe(before);
    const probe = new Session({ settings: { ...FAST } });
    await probe.start();
    const freePort = probe.listenPort;
    await probe.shutdown();
    await s.setListenPort(freePort);
    expect(s.listenPort).toBe(freePort);
    await s.bindTo(null);
    expect(s.settings.listenAddress).toBeNull();
    expect(s.listenPort).toBe(freePort);
  });

  it('refuses blocked peers', async () => {
    const tr = await tracker();
    const { torrent } = await seedSetup(tr.url, {}, { isBlocked: (ip) => ip === '127.0.0.1' });
    const leecher = await session({ savePath: await tmp() }, { isBlocked: (ip) => ip === '127.0.0.1' });
    const lt = await leecher.addTorrent({ torrent });
    await new Promise((r) => setTimeout(r, 500));
    expect(lt.getStats().connectedPeers).toBe(0);
    expect(lt.getStats().progress).toBe(0);
  });

  it('applies global rate limits', async () => {
    const tr = await tracker();
    const { torrent, p } = await seedSetup(tr.url, { uploadLimit: 150_000 });
    const leechDir = await tmp();
    const leecher = await session({ savePath: leechDir });
    const start = Date.now();
    const lt = await leecher.addTorrent({ torrent });
    await completed(lt);
    // ~410 KB at 150 KB/s with a 150 KB burst needs well over a second
    expect(Date.now() - start).toBeGreaterThan(1200);
    await verifyPayload(leechDir, 'pack', p);
  }, 30_000);

  it('moves a torrent into the error state when storage fails and reports onError', async () => {
    const tr = await tracker();
    const { torrent } = await seedSetup(tr.url);
    const base = await tmp();
    const blocker = join(base, 'not-a-dir');
    await writeFile(blocker, 'x');
    const leecher = await session({ savePath: blocker });
    const failed = new Promise<Error>((r) => leecher.onError((_t, err) => r(err)));
    const lt = await leecher.addTorrent({ torrent });
    expect((await failed).message).toMatch(/failed|ENOTDIR|EEXIST|ENOENT/);
    expect(lt.state).toBe('error');
    expect(lt.getStats().error).toBeDefined();
  }, 30_000);

  it('skips unwanted files', async () => {
    const tr = await tracker();
    const { torrent, p } = await seedSetup(tr.url);
    const leechDir = await tmp();
    const leecher = await session({ savePath: leechDir });
    const lt = await leecher.addTorrent({ torrent, filePriorities: [1, 1, 0] });
    await completed(lt);
    expect((await readFile(join(leechDir, 'pack', 'a.bin'))).equals(p.files[0]!.data)).toBe(true);
    await expect(stat(join(leechDir, 'pack', 'dir', 'c.bin'))).rejects.toThrow();
    expect(lt.getStats().progress).toBe(1);
    expect(lt.getStats().piecesHave).toBeLessThan(lt.getStats().pieceCount);
  }, 30_000);
});

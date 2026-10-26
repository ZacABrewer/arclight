import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTorrent, Session, toMagnetUri, type SessionSettings, type Torrent } from '@arclight/torrent-engine';
import { afterEach, describe, expect, it } from 'vitest';
import { createBuiltinClient, createDownloadClient, DownloadClientError, type DownloadClient } from '../index.js';
import type { BuiltinSettingsInput } from './settings.js';

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'mt-builtin-'));
  cleanups.push(() => rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return d;
}

const FAST: Partial<SessionSettings> = {
  listenPort: 0,
  listenAddress: '127.0.0.1',
  dht: false,
  pex: false,
  dhtBootstrapNodes: [],
  tickIntervalMs: 50,
  chokeIntervalMs: 300,
  trackerMinIntervalSec: 0,
  trackerRetrySec: 0.2,
  peerRetryMs: 200,
  connectTimeoutMs: 2000,
};

async function session(settings: Partial<SessionSettings> = {}): Promise<Session> {
  const s = new Session({ settings: { ...FAST, ...settings } });
  await s.start();
  cleanups.push(() => s.shutdown());
  return s;
}

interface Pack {
  name: string;
  files: { path: string[]; data: Buffer }[];
  torrent: Buffer;
  infoHash: string;
  magnet: string;
}

function pack(opts: { name?: string; private?: boolean; announce?: string } = {}): Pack {
  const name = opts.name ?? `pack-${randomBytes(4).toString('hex')}`;
  const files = [
    { path: ['a.bin'], data: randomBytes(40_000) },
    { path: ['sub', 'b.bin'], data: randomBytes(25_000) },
  ];
  const created = createTorrent({
    name,
    files,
    pieceLength: 16 * 1024,
    ...(opts.private ? { private: true } : {}),
    ...(opts.announce ? { announce: opts.announce } : {}),
  });
  return {
    name,
    files,
    torrent: created.torrent,
    infoHash: created.metainfo.infoHash.toString('hex'),
    magnet: toMagnetUri({ infoHash: created.metainfo.infoHash, name }),
  };
}

async function writePack(dir: string, p: Pack): Promise<void> {
  for (const f of p.files) {
    const full = join(dir, p.name, ...f.path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, f.data);
  }
}

async function verifyPack(dir: string, p: Pack): Promise<void> {
  for (const f of p.files) expect((await readFile(join(dir, p.name, ...f.path))).equals(f.data)).toBe(true);
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

function waitFor<T>(cond: () => T | undefined | null | false, ms = 8_000): Promise<T> {
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

async function waitItem(client: DownloadClient, id: string, pred: (status: string) => boolean, ms = 8_000) {
  const start = Date.now();
  for (;;) {
    const item = (await client.getItems('')).find((i) => i.id === id);
    if (item && pred(item.status)) return item;
    if (Date.now() - start > ms) throw new Error(`timed out; last status ${item?.status ?? 'missing'}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A session with a seeding torrent whose payload already sits in its save path. */
async function seeder(p: Pack = pack()): Promise<{ s: Session; p: Pack; dir: string }> {
  const dir = await tmp();
  await writePack(dir, p);
  const s = await session({ savePath: dir });
  const t = await s.addTorrent({ torrent: p.torrent });
  await waitFor(() => t.state === 'seeding');
  return { s, p, dir };
}

/** A client over a fresh session; settings default to downloads under a temp root. */
async function leecher(settings: BuiltinSettingsInput = {}, sessionSettings: Partial<SessionSettings> = {}) {
  const dir = await tmp();
  const s = await session({ savePath: dir, ...sessionSettings });
  const client = createBuiltinClient(settings, s);
  return { s, dir, client };
}

/** Adds a pack to `client` with its payload already in place so it seeds right after checking. */
async function addSeeding(
  client: DownloadClient,
  s: Session,
  savePath: string,
  p: Pack,
  extra: Partial<Parameters<DownloadClient['addTorrent']>[0]> = {},
): Promise<Torrent> {
  await writePack(savePath, p);
  const { id } = await client.addTorrent({ torrentFile: p.torrent, title: p.name, category: 'tv', savePath, ...extra });
  const t = s.getTorrent(id) as Torrent;
  await waitFor(() => t.isComplete && t.state !== 'checking');
  return t;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => resolve(false));
  });
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DownloadClientError);
  return (error as DownloadClientError).code;
}

describe('BuiltinClient adding', () => {
  it('downloads a .torrent from a seeder and reports it as seeding', async () => {
    const { s: seed, p } = await seeder();
    const { s, dir, client } = await leecher();
    const { id, warnings } = await client.addTorrent({ torrentFile: p.torrent, title: p.name, category: 'tv' });
    expect(id).toBe(p.infoHash);
    expect(warnings).toEqual([]);
    s.getTorrent(id)?.addPeers([{ host: '127.0.0.1', port: seed.listenPort }]);
    const item = await waitItem(client, id, (st) => st === 'seeding');
    await verifyPack(join(dir, 'tv'), p);
    expect(item).toMatchObject({
      title: p.name,
      category: 'tv',
      progress: 1,
      remainingBytes: 0,
      totalBytes: 65_000,
      downloadedBytes: 65_000,
      etaSeconds: 0,
      outputPath: join(dir, 'tv', p.name),
      isReadOnly: false,
      canBeRemoved: false,
      canMoveFiles: false,
    });
    expect(item.outputPath).toBe(s.getTorrent(id)?.getStats().contentPath);
  });

  it('downloads a magnet (metadata first) from a seeder', async () => {
    const { s: seed, p } = await seeder();
    const { s, dir, client } = await leecher();
    const { id } = await client.addTorrent({ magnet: p.magnet, title: p.name, category: '' });
    expect(id).toBe(p.infoHash);
    const early = (await client.getItems(''))[0];
    expect(early?.status).toBe('downloading');
    expect(early?.statusMessage).toBe('Downloading metadata');
    expect(Object.values(early ?? {}).includes(undefined)).toBe(false);
    s.getTorrent(id)?.addPeers([{ host: '127.0.0.1', port: seed.listenPort }]);
    await waitItem(client, id, (st) => st === 'seeding');
    await verifyPack(dir, p);
  });

  it('maps categories to save paths: explicit folder, <root>/<category>, root', async () => {
    const root = await tmp();
    const tvDir = await tmp();
    const { s, client } = await leecher({ savePath: root, categories: [{ name: 'tv', savePath: tvDir }], initialState: 'pause' });
    const a = pack();
    const b = pack();
    const c = pack();
    const ra = await client.addTorrent({ torrentFile: a.torrent, title: 'a', category: 'tv' });
    const rb = await client.addTorrent({ torrentFile: b.torrent, title: 'b', category: 'movies' });
    const rc = await client.addTorrent({ torrentFile: c.torrent, title: 'c', category: '' });
    expect(s.getTorrent(ra.id)?.savePath).toBe(tvDir);
    expect(s.getTorrent(rb.id)?.savePath).toBe(join(root, 'movies'));
    expect(s.getTorrent(rc.id)?.savePath).toBe(root);
  });

  it('falls back to the session save path and honours an explicit savePath', async () => {
    const { s, dir, client } = await leecher({ initialState: 'pause' });
    const other = await tmp();
    const a = pack();
    const b = pack();
    const ra = await client.addTorrent({ torrentFile: a.torrent, title: 'a', category: 'tv' });
    const rb = await client.addTorrent({ torrentFile: b.torrent, title: 'b', category: 'tv', savePath: other });
    expect(s.getTorrent(ra.id)?.savePath).toBe(join(dir, 'tv'));
    expect(s.getTorrent(rb.id)?.savePath).toBe(other);
  });

  it('adds paused when initialState is pause; input.paused overrides either way', async () => {
    const paused = await leecher({ initialState: 'pause' });
    const a = pack();
    const b = pack();
    const ra = await paused.client.addTorrent({ magnet: a.magnet, title: 'a', category: 'tv' });
    const rb = await paused.client.addTorrent({ magnet: b.magnet, title: 'b', category: 'tv', paused: false });
    expect(paused.s.getTorrent(ra.id)?.state).toBe('paused');
    expect(paused.s.getTorrent(rb.id)?.isPaused).toBe(false);
    const items = await paused.client.getItems('tv');
    expect(items.find((i) => i.id === ra.id)?.status).toBe('paused');

    const started = await leecher();
    const c = pack();
    const rc = await started.client.addTorrent({ magnet: c.magnet, title: 'c', category: 'tv', paused: true });
    expect(started.s.getTorrent(rc.id)?.isPaused).toBe(true);
  });

  it('passes per-add seed limits, else the client settings, else the session default', async () => {
    const withDefaults = await leecher({ initialState: 'pause', seedRatioLimit: 2, seedTimeLimitMinutes: 30 });
    const a = pack();
    const b = pack();
    const ra = await withDefaults.client.addTorrent({
      magnet: a.magnet,
      title: 'a',
      category: 'tv',
      seedRatioLimit: 1.5,
      seedTimeLimitMinutes: 90,
    });
    const rb = await withDefaults.client.addTorrent({ magnet: b.magnet, title: 'b', category: 'tv' });
    expect(withDefaults.s.getTorrent(ra.id)).toMatchObject({ seedRatioLimit: 1.5, seedTimeLimitMs: 90 * 60_000 });
    expect(withDefaults.s.getTorrent(rb.id)).toMatchObject({ seedRatioLimit: 2, seedTimeLimitMs: 30 * 60_000 });

    const plain = await leecher({ initialState: 'pause' });
    const c = pack();
    const rc = await plain.client.addTorrent({ magnet: c.magnet, title: 'c', category: 'tv' });
    const tc = plain.s.getTorrent(rc.id);
    expect(tc?.seedRatioLimit).toBeUndefined();
    expect(tc?.seedTimeLimitMs).toBeUndefined();
  });

  it('returns the existing id with a warning on a duplicate add', async () => {
    const { s, client } = await leecher({ initialState: 'pause' });
    const p = pack();
    const first = await client.addTorrent({ torrentFile: p.torrent, title: p.name, category: 'tv' });
    const again = await client.addTorrent({ magnet: p.magnet, title: p.name, category: 'movies' });
    expect(again.id).toBe(first.id);
    expect(again.warnings).toHaveLength(1);
    expect(again.warnings[0]).toContain('already');
    expect(s.getTorrents()).toHaveLength(1);
    expect(s.getTorrent(first.id)?.category).toBe('tv');
  });

  it('rejects broken torrent files, bad magnets and empty input', async () => {
    const { s, client } = await leecher();
    expect(await codeOf(client.addTorrent({ torrentFile: new Uint8Array([1, 2, 3]), title: 'x', category: 'tv' }))).toBe('rejected');
    expect(await codeOf(client.addTorrent({ magnet: 'magnet:?dn=nohash', title: 'x', category: 'tv' }))).toBe('rejected');
    expect(await codeOf(client.addTorrent({ magnet: 'http://not-a-magnet', title: 'x', category: 'tv' }))).toBe('rejected');
    expect(await codeOf(client.addTorrent({ title: 'x', category: 'tv' }))).toBe('rejected');
    expect(s.getTorrents()).toHaveLength(0);
  });
});

describe('BuiltinClient queue', () => {
  it('filters items by category; an empty category lists everything', async () => {
    const { client } = await leecher({ initialState: 'pause' });
    const [a, b, c] = [pack(), pack(), pack()];
    await client.addTorrent({ magnet: a.magnet, title: 'a', category: 'tv' });
    await client.addTorrent({ magnet: b.magnet, title: 'b', category: 'movies' });
    await client.addTorrent({ magnet: c.magnet, title: 'c', category: 'tv' });
    expect((await client.getItems('tv')).map((i) => i.id).sort()).toEqual([a.infoHash, c.infoHash].sort());
    expect((await client.getItems('movies')).map((i) => i.id)).toEqual([b.infoHash]);
    expect(await client.getItems('music')).toEqual([]);
    expect(await client.getItems('')).toHaveLength(3);
  });

  it('reports a paused complete torrent as completed and removable', async () => {
    const { s, dir, client } = await leecher();
    const p = pack();
    const t = await addSeeding(client, s, dir, p);
    expect((await client.getItems('tv'))[0]).toMatchObject({ status: 'seeding', canBeRemoved: false });
    await client.pause(t.infoHashHex);
    const item = (await client.getItems('tv'))[0];
    expect(item).toMatchObject({ status: 'completed', canBeRemoved: true, canMoveFiles: true, isReadOnly: false, etaSeconds: 0 });
  });

  it('marks a private torrent read-only until its seed limits are met', async () => {
    const { s, dir, client } = await leecher({}, { seedLimitAction: 'none' });
    const notMet = await addSeeding(client, s, dir, pack({ private: true }));
    const met = await addSeeding(client, s, dir, pack({ private: true }), { seedRatioLimit: 0 });
    const items = await client.getItems('tv');
    expect(items.find((i) => i.id === notMet.infoHashHex)).toMatchObject({
      status: 'seeding',
      isReadOnly: true,
      canBeRemoved: false,
      canMoveFiles: false,
    });
    expect(items.find((i) => i.id === met.infoHashHex)).toMatchObject({
      status: 'seeding',
      isReadOnly: false,
      canBeRemoved: true,
      canMoveFiles: true,
    });
  });

  it('uses the session default seed limits when a torrent has none', async () => {
    const { s, dir, client } = await leecher({}, { seedLimitAction: 'none', seedTimeLimitMs: 0 });
    const t = await addSeeding(client, s, dir, pack({ private: true }));
    const item = (await client.getItems('tv')).find((i) => i.id === t.infoHashHex);
    expect(item).toMatchObject({ isReadOnly: false, canBeRemoved: true });
  });

  it('flags a download whose trackers all fail and has no peers as a warning', async () => {
    const dead = `http://127.0.0.1:${await freePort()}/announce`;
    const { client } = await leecher();
    const p = pack({ announce: dead });
    const { id } = await client.addTorrent({ torrentFile: p.torrent, title: p.name, category: 'tv' });
    const item = await waitItem(client, id, (st) => st === 'warning');
    expect(item.statusMessage).toBeTruthy();
    expect(item.progress).toBe(0);
    expect(item.remainingBytes).toBe(65_000);
    expect('etaSeconds' in item).toBe(false);
  });

  it('removes items keeping or deleting their data', async () => {
    const { s, dir, client } = await leecher();
    const keep = await addSeeding(client, s, dir, pack());
    const drop = await addSeeding(client, s, dir, pack());
    const keepPath = keep.getStats().contentPath;
    const dropPath = drop.getStats().contentPath;
    await client.removeItem(keep.infoHashHex, false);
    await client.removeItem(drop.infoHashHex.toUpperCase(), true);
    expect(s.getTorrents()).toHaveLength(0);
    expect(await exists(join(keepPath, 'a.bin'))).toBe(true);
    expect(await exists(join(dropPath, 'a.bin'))).toBe(false);
  });

  it('throws not-found for unknown ids', async () => {
    const { client } = await leecher();
    const id = 'f'.repeat(40);
    expect(await codeOf(client.removeItem(id, false))).toBe('not-found');
    expect(await codeOf(client.pause(id))).toBe('not-found');
    expect(await codeOf(client.resume(id))).toBe('not-found');
    expect(await codeOf(client.setCategory(id, 'x'))).toBe('not-found');
  });

  it('moves an item to another category without moving files', async () => {
    const { s, dir, client } = await leecher();
    const t = await addSeeding(client, s, dir, pack());
    await client.setCategory(t.infoHashHex, 'tv-imported');
    expect(await client.getItems('tv')).toEqual([]);
    const item = (await client.getItems('tv-imported'))[0];
    expect(item?.category).toBe('tv-imported');
    expect(t.savePath).toBe(dir);
  });

  it('pauses and resumes', async () => {
    const { s, client } = await leecher();
    const p = pack();
    const { id } = await client.addTorrent({ magnet: p.magnet, title: p.name, category: 'tv' });
    await client.pause(id);
    expect(s.getTorrent(id)?.state).toBe('paused');
    expect((await client.getItems('tv'))[0]?.status).toBe('paused');
    await client.resume(id);
    expect(s.getTorrent(id)?.isPaused).toBe(false);
    await waitItem(client, id, (st) => st === 'downloading');
  });
});

describe('BuiltinClient status and connection', () => {
  it('reports the output root for the configured category', async () => {
    const { dir, client } = await leecher({ category: 'arclight' });
    expect(await client.getStatus()).toEqual({
      outputRootDir: join(dir, 'arclight'),
      isLocalhost: true,
      removesCompletedDownloads: false,
    });
    const mapped = await leecher({ category: 'tv', categories: [{ name: 'tv', savePath: dir }] }, { seedLimitAction: 'remove' });
    expect(await mapped.client.getStatus()).toEqual({ outputRootDir: dir, isLocalhost: true, removesCompletedDownloads: true });
  });

  it('rebinds the listener on setListenPort and reports it', async () => {
    const { s, client } = await leecher();
    const before = await client.getListenPort?.();
    expect(before).toBe(s.listenPort);
    await client.setListenPort?.(before as number); // no-op
    expect(s.listenPort).toBe(before);
    const port = await freePort();
    await client.setListenPort?.(port);
    expect(await client.getListenPort?.()).toBe(port);
    expect(s.listenPort).toBe(port);
    expect(await canConnect(port)).toBe(true);
  });

  it('test() reports the engine version and configuration warnings', async () => {
    const { client } = await leecher();
    expect(await client.test()).toEqual({ version: 'Arclight engine 0.1.0', apiVersion: '1', warnings: [] });

    const s = await session();
    const dupes = createBuiltinClient(
      {
        categories: [
          { name: 'tv', savePath: '/a' },
          { name: 'tv', savePath: '/b' },
          { name: 'tv', savePath: '/c' },
          { name: 'movies', savePath: '/m' },
        ],
      },
      s,
    );
    const result = await dupes.test();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('"tv"');
  });

  it('test() warns when the engine is not listening', async () => {
    const idle = new Session({ settings: { ...FAST } }); // never started: no listener
    const result = await createBuiltinClient({}, idle).test();
    expect(result.warnings.some((w) => w.includes('not listening'))).toBe(true);
  });

  it('throws unreachable from every method while the getter yields null', async () => {
    let current: Session | null = null;
    const client = createBuiltinClient({}, () => current);
    const id = 'a'.repeat(40);
    const calls: Promise<unknown>[] = [
      client.test(),
      client.addTorrent({ magnet: `magnet:?xt=urn:btih:${id}`, title: 't', category: 'tv' }),
      client.getItems('tv'),
      client.removeItem(id, false),
      client.getStatus(),
      client.setCategory(id, 'x'),
      client.pause(id),
      client.resume(id),
      client.setListenPort?.(1234) ?? Promise.resolve(),
      client.getListenPort?.() ?? Promise.resolve(),
    ];
    expect(await Promise.all(calls.map(codeOf))).toEqual(calls.map(() => 'unreachable'));
    const error = await client.test().catch((e: unknown) => e);
    expect((error as Error).message).toContain('Settings > Torrent Engine');

    current = await session();
    expect((await client.test()).version).toContain('Arclight engine');
    expect(await client.getItems('')).toEqual([]);
  });

  it('is created by the dispatcher with a session dependency', async () => {
    const s = await session();
    const client = createDownloadClient('builtin', { category: 'tv' }, {}, { torrentSession: s });
    expect(client.name).toBe('Built-in');
    expect(client.protocol).toBe('torrent');
    expect((await client.test()).apiVersion).toBe('1');
    const p = pack();
    const { id } = await client.addTorrent({ magnet: p.magnet, title: p.name, category: 'tv', paused: true });
    expect(s.getTorrent(id)).toBeDefined();

    const getter = createDownloadClient('builtin', {}, {}, { torrentSession: () => s });
    expect(await getter.getItems('tv')).toHaveLength(1);

    const orphan = createDownloadClient('builtin', {});
    expect(await codeOf(orphan.test())).toBe('unreachable');
    expect(() => createDownloadClient('builtin', { initialState: 'later' } as never)).toThrow();
  });
});

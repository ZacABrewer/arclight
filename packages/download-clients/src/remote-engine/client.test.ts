import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentServer, EngineAgentCore } from '@arclight/engine-agent';
import { createTorrent, Session, type SessionSettings } from '@arclight/torrent-engine';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDownloadClient, createRemoteEngineClient, DownloadClientError, type DownloadClient, type RemoteEngineClient } from '../index.js';
import { PART_SUFFIX, PULL_STATE_DIR } from './pull.js';
import type { RemoteEngineSettingsInput } from './settings.js';

const TOKEN = 'remote-token-0123456789';
// Real swarms on loopback plus HTTP copies: allow more than the default 5 s.
vi.setConfig({ testTimeout: 30_000 });
const FAST: Partial<SessionSettings> = {
  listenPort: 0,
  listenAddress: '127.0.0.1',
  dht: false,
  pex: false,
  utp: false,
  dhtBootstrapNodes: [],
  tickIntervalMs: 50,
  chokeIntervalMs: 300,
  trackerMinIntervalSec: 0,
  trackerRetrySec: 0.2,
  peerRetryMs: 200,
  connectTimeoutMs: 2000,
};

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'mt-remote-'));
  cleanups.push(() => rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return d;
}

async function session(settings: Partial<SessionSettings>): Promise<Session> {
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
}

function pack(sizes = [40_000, 25_000]): Pack {
  const name = `rel-${randomBytes(4).toString('hex')}`;
  const files = sizes.map((size, i) => ({ path: i === 0 ? ['a.mkv'] : ['sub', `f${i}.srt`], data: randomBytes(size) }));
  const created = createTorrent({ name, files, pieceLength: 16 * 1024 });
  return { name, files, torrent: created.torrent, infoHash: created.metainfo.infoHash.toString('hex') };
}

async function writePack(dir: string, p: Pack): Promise<void> {
  for (const f of p.files) {
    const full = join(dir, p.name, ...f.path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, f.data);
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** Counts requests and Range headers going to the agent. */
function recordingFetch() {
  const calls: Array<{ url: string; range: string | null }> = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), range: headers.get('range') });
    return fetch(input, init);
  };
  return { calls, fetchImpl };
}

/** A seeder session with `p`, an agent (empty engine) and its URL. */
async function world(p: Pack = pack()) {
  const seedDir = await tmp();
  await writePack(seedDir, p);
  const seeder = await session({ savePath: seedDir });
  const t = await seeder.addTorrent({ torrent: p.torrent });
  await waitFor(() => t.state === 'seeding');

  const agentRoot = await tmp();
  const agentSession = await session({ savePath: agentRoot });
  const core = new EngineAgentCore({ session: agentSession, downloadsRoot: agentRoot, kind: 'standalone', sessionPollMs: 50 });
  const server = createAgentServer({ core, token: TOKEN });
  const { port } = await server.listen(0, '127.0.0.1');
  cleanups.push(() => server.close());
  return { p, seeder, agentSession, agentRoot, url: `http://127.0.0.1:${port}` };
}

function client(settings: RemoteEngineSettingsInput, fetchImpl?: typeof fetch, pullRetryBaseMs = 20): RemoteEngineClient {
  const c = createRemoteEngineClient(settings, fetchImpl ? { fetch: fetchImpl } : {}, { pullRetryBaseMs });
  cleanups.push(() => c.close());
  return c;
}

function waitFor<T>(cond: () => T | undefined | null | false, ms = 10_000): Promise<T> {
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

async function waitItem(c: DownloadClient, id: string, pred: (i: Awaited<ReturnType<DownloadClient['getItems']>>[number]) => boolean, ms = 15_000) {
  const start = Date.now();
  for (;;) {
    const item = (await c.getItems('tv')).find((i) => i.id === id);
    if (item && pred(item)) return item;
    if (Date.now() - start > ms) throw new Error(`timed out; last ${JSON.stringify(item)}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DownloadClientError);
  return (error as DownloadClientError).code;
}

/** Adds the pack through the client and connects the agent's torrent to the seeder. */
async function grab(c: DownloadClient, w: Awaited<ReturnType<typeof world>>) {
  const { id, warnings } = await c.addTorrent({ torrentFile: w.p.torrent, title: w.p.name, category: 'tv' });
  expect(id).toBe(w.p.infoHash);
  expect(warnings).toEqual([]);
  w.agentSession.getTorrent(id)!.addPeers([{ host: '127.0.0.1', port: w.seeder.listenPort }]);
  return id;
}

describe('remoteEngine client, shared storage', () => {
  it('downloads on the agent and reports the agent path once seeding', async () => {
    const w = await world();
    const c = client({ url: w.url, token: TOKEN });
    const id = await grab(c, w);
    const item = await waitItem(c, id, (i) => i.status === 'seeding');
    expect(item).toMatchObject({
      title: w.p.name,
      category: 'tv',
      progress: 1,
      totalBytes: 65_000,
      remainingBytes: 0,
      etaSeconds: 0,
      outputPath: join(w.agentRoot, 'tv', w.p.name),
      isReadOnly: false,
    });
    expect(await readFile(join(w.agentRoot, 'tv', w.p.name, 'a.mkv'))).toEqual(w.p.files[0]!.data);
    const status = await c.getStatus();
    expect(status).toEqual({ outputRootDir: join(w.agentRoot, 'arclight'), isLocalhost: false, removesCompletedDownloads: false });
  });

  it('is built by createDownloadClient("remoteEngine") and reports test() details', async () => {
    const w = await world();
    const c = createDownloadClient('remoteEngine', { url: w.url, token: TOKEN });
    expect(c.name).toBe('Remote engine');
    expect(c.protocol).toBe('torrent');
    const result = await c.test();
    expect(result.version).toContain('standalone');
    expect(result.apiVersion).toBe('1');
    (c as RemoteEngineClient).close();
  });

  it('pauses, resumes, recategorises, moves the listener and removes', async () => {
    const w = await world();
    const c = client({ url: w.url, token: TOKEN });
    const id = await grab(c, w);
    await waitItem(c, id, (i) => i.status === 'seeding');
    await c.pause(id);
    expect((await waitItem(c, id, (i) => i.status === 'completed')).canBeRemoved).toBe(true);
    await c.resume(id);
    await c.setCategory(id, 'tv-done');
    expect(w.agentSession.getTorrent(id)?.category).toBe('tv-done');
    const { createServer } = await import('node:net');
    const port = await new Promise<number>((resolve) => {
      const srv = createServer().listen(0, '127.0.0.1', () => {
        const a = srv.address();
        srv.close(() => resolve(typeof a === 'object' && a ? a.port : 0));
      });
    });
    await c.setListenPort!(port);
    expect(await c.getListenPort!()).toBe(port);
    await c.removeItem(id, true);
    expect(w.agentSession.getTorrent(id)).toBeUndefined();
  });

  it('reports a duplicate add as a warning and refuses NZBs', async () => {
    const w = await world();
    const c = client({ url: w.url, token: TOKEN });
    await grab(c, w);
    const again = await c.addTorrent({ torrentFile: w.p.torrent, title: w.p.name, category: 'tv' });
    expect(again.warnings[0]).toContain('already');
    expect(await codeOf((c as DownloadClient).addNzb!({ nzb: new Uint8Array([1]), title: 't', category: 'tv' }))).toBe('not-supported');
  });
});

describe('remoteEngine client, auth and reachability', () => {
  it('maps a wrong token to auth', async () => {
    const w = await world();
    const c = client({ url: w.url, token: 'wrong-token' });
    expect(await codeOf(c.test())).toBe('auth');
    expect(await codeOf(c.getItems('tv'))).toBe('auth');
    expect(await codeOf(c.addTorrent({ torrentFile: w.p.torrent, title: 't', category: 'tv' }))).toBe('auth');
  });

  it('maps a dead agent to unreachable', async () => {
    const c = createRemoteEngineClient({ url: 'http://127.0.0.1:1', token: TOKEN }, { requestTimeoutMs: 2000 });
    expect(await codeOf(c.test())).toBe('unreachable');
    expect(await codeOf(c.getStatus())).toBe('unreachable');
  });

  it('maps unknown ids to not-found and validates settings', async () => {
    const w = await world();
    const c = client({ url: w.url, token: TOKEN });
    expect(await codeOf(c.pause('b'.repeat(40)))).toBe('not-found');
    expect(() => createRemoteEngineClient({ url: 'seedbox:7879' })).toThrow();
    expect(await codeOf(client({ url: w.url, token: TOKEN, pullMode: true }).test())).toBe('rejected');
  });
});

describe('remoteEngine client, pull mode', () => {
  it('adds, completes on the agent, copies to the local folder and reports the local path', async () => {
    const w = await world();
    const local = await tmp();
    const c = client({ url: w.url, token: TOKEN, pullMode: true, localDownloadPath: local });
    expect((await c.test()).warnings).toEqual([]);
    const id = await grab(c, w);
    const item = await waitItem(c, id, (i) => i.status === 'seeding');
    expect(item).toMatchObject({
      outputPath: join(local, w.p.name),
      isReadOnly: false,
      canMoveFiles: true,
      progress: 1,
    });
    for (const f of w.p.files) expect(await readFile(join(local, w.p.name, ...f.path))).toEqual(f.data);
    expect(await exists(join(local, PULL_STATE_DIR, `${id}.json`))).toBe(true);
    expect(await c.getStatus()).toEqual({ outputRootDir: local, isLocalhost: true, removesCompletedDownloads: false });
  });

  it('keeps reporting completed after the importer moved the local copy (no second pull)', async () => {
    const w = await world();
    const local = await tmp();
    const { calls, fetchImpl } = recordingFetch();
    const c = client({ url: w.url, token: TOKEN, pullMode: true, localDownloadPath: local }, fetchImpl);
    const id = await grab(c, w);
    await waitItem(c, id, (i) => i.status === 'seeding' && i.outputPath.startsWith(local));
    await rm(join(local, w.p.name), { recursive: true });
    const contentCalls = calls.filter((x) => x.url.endsWith('/content')).length;
    const again = await waitItem(c, id, (i) => i.status === 'seeding');
    expect(again.outputPath).toBe(join(local, w.p.name));
    expect(calls.filter((x) => x.url.endsWith('/content')).length).toBe(contentCalls);
  });

  it('resumes a partial copy with a Range request', async () => {
    const w = await world();
    const local = await tmp();
    // The agent already has the payload (seeding), the local side 30000 of 40000 bytes.
    await writePack(join(w.agentRoot, 'tv'), w.p);
    const partial = join(local, w.p.name, 'a.mkv' + PART_SUFFIX);
    await mkdir(join(local, w.p.name), { recursive: true });
    await writeFile(partial, w.p.files[0]!.data.subarray(0, 30_000));
    const { calls, fetchImpl } = recordingFetch();
    const c = client({ url: w.url, token: TOKEN, pullMode: true, localDownloadPath: local }, fetchImpl);
    const { id } = await c.addTorrent({ torrentFile: w.p.torrent, title: w.p.name, category: 'tv' });
    await waitItem(c, id, (i) => i.outputPath === join(local, w.p.name) && i.status === 'seeding');
    expect(calls.find((x) => x.url.endsWith('/files/0/content'))?.range).toBe('bytes=30000-');
    expect(await readFile(join(local, w.p.name, 'a.mkv'))).toEqual(w.p.files[0]!.data);
    expect(await exists(partial)).toBe(false);
  });

  it('discards a copy whose checksum does not match and fetches it again', async () => {
    const w = await world();
    const local = await tmp();
    await writePack(join(w.agentRoot, 'tv'), w.p);
    // Corrupt "partial" bytes: the resumed copy will hash wrong and must be refetched.
    await mkdir(join(local, w.p.name), { recursive: true });
    await writeFile(join(local, w.p.name, 'a.mkv' + PART_SUFFIX), randomBytes(20_000));
    const { calls, fetchImpl } = recordingFetch();
    // Long enough between attempts for a poll to see the failure.
    const c = client({ url: w.url, token: TOKEN, pullMode: true, localDownloadPath: local }, fetchImpl, 1500);
    const { id } = await c.addTorrent({ torrentFile: w.p.torrent, title: w.p.name, category: 'tv' });
    const warned = await waitItem(c, id, (i) => i.status === 'warning');
    expect(warned.statusMessage).toContain('Checksum mismatch');
    await waitItem(c, id, (i) => i.status === 'seeding' && i.outputPath === join(local, w.p.name));
    expect(await readFile(join(local, w.p.name, 'a.mkv'))).toEqual(w.p.files[0]!.data);
    const ranges = calls.filter((x) => x.url.endsWith('/files/0/content')).map((x) => x.range);
    expect(ranges).toEqual(['bytes=20000-', null]);
  });

  it('reports copying progress while the pull runs (bandwidth limited)', async () => {
    const w = await world(pack([150_000, 50_000]));
    const local = await tmp();
    await writePack(join(w.agentRoot, 'tv'), w.p);
    const c = client({ url: w.url, token: TOKEN, pullMode: true, localDownloadPath: local, bandwidthLimitKbps: 200 });
    const { id } = await c.addTorrent({ torrentFile: w.p.torrent, title: w.p.name, category: 'tv' });
    const started = Date.now();
    const copying = await waitItem(c, id, (i) => i.status === 'downloading' && (i.statusMessage ?? '').startsWith('Copying'));
    expect(copying.outputPath).toBe(join(local, w.p.name));
    expect(copying.isReadOnly).toBe(false);
    await waitItem(c, id, (i) => i.status === 'seeding' && i.outputPath === join(local, w.p.name));
    // 200 000 bytes at 200 KiB/s take close to a second.
    expect(Date.now() - started).toBeGreaterThan(700);
  });

  it('removeItem with deleteData deletes the local copy and its manifest', async () => {
    const w = await world();
    const local = await tmp();
    const c = client({ url: w.url, token: TOKEN, pullMode: true, localDownloadPath: local });
    const id = await grab(c, w);
    await waitItem(c, id, (i) => i.status === 'seeding' && i.outputPath.startsWith(local));
    await c.removeItem(id, true);
    expect(await exists(join(local, w.p.name))).toBe(false);
    expect(await exists(join(local, PULL_STATE_DIR, `${id}.json`))).toBe(false);
    expect(w.agentSession.getTorrent(id)).toBeUndefined();
  });

  it('starts the copy from the event stream as soon as the agent completes', async () => {
    const w = await world();
    const local = await tmp();
    const c = client({ url: w.url, token: TOKEN, category: 'tv', pullMode: true, localDownloadPath: local });
    await c.test();
    await waitFor(() => c.watching);
    await grab(c, w);
    // No polling: the `completed` event alone triggers the pull.
    const deadline = Date.now() + 15_000;
    while (!(await exists(join(local, PULL_STATE_DIR, `${w.p.infoHash}.json`)))) {
      if (Date.now() > deadline) throw new Error('pull did not run');
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(await readFile(join(local, w.p.name, 'a.mkv'))).toEqual(w.p.files[0]!.data);
  });
});

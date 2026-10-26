import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTorrent, Session, toMagnetUri, type SessionSettings } from '@arclight/torrent-engine';
import { EngineAgentCore, type EngineAgentCoreOptions } from './core.js';
import { createAgentServer, type AgentServer } from './server.js';

// Test-only helpers: generated torrents, loopback sessions with fast timers and an agent
// server over them. Not used by production code (main.ts never imports this file).

export const FAST: Partial<SessionSettings> = {
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
  utp: false,
};

export const TOKEN = 'test-token-0123456789abcdef';

export interface Pack {
  name: string;
  files: { path: string[]; data: Buffer }[];
  torrent: Buffer;
  infoHash: string;
  magnet: string;
}

export function pack(opts: { name?: string; single?: boolean; sizes?: number[] } = {}): Pack {
  const name = opts.name ?? `pack-${randomBytes(4).toString('hex')}`;
  const sizes = opts.sizes ?? [40_000, 25_000];
  const files = opts.single
    ? [{ path: [name], data: randomBytes(sizes[0] ?? 30_000) }]
    : sizes.map((size, i) => ({ path: i === 0 ? ['a.bin'] : ['sub', `f${i}.bin`], data: randomBytes(size) }));
  const created = opts.single
    ? createTorrent({ name, files: [{ path: [], data: files[0]!.data }], pieceLength: 16 * 1024 })
    : createTorrent({ name, files, pieceLength: 16 * 1024 });
  return {
    name,
    files,
    torrent: created.torrent,
    infoHash: created.metainfo.infoHash.toString('hex'),
    magnet: toMagnetUri({ infoHash: created.metainfo.infoHash, name }),
  };
}

/** Writes the payload under `dir` the way the engine lays it out (<dir>/<name>/... or <dir>/<name>). */
export async function writePack(dir: string, p: Pack, single = p.files.length === 1 && p.files[0]!.path[0] === p.name): Promise<void> {
  for (const f of p.files) {
    const full = single ? join(dir, p.name) : join(dir, p.name, ...f.path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, f.data);
  }
}

export class Cleanup {
  private readonly fns: Array<() => unknown> = [];
  add(fn: () => unknown): void {
    this.fns.push(fn);
  }
  async run(): Promise<void> {
    for (const fn of this.fns.splice(0).reverse()) await fn();
  }
  async tmp(prefix = 'mt-agent-'): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), prefix));
    this.add(() => rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    return d;
  }
  async session(settings: Partial<SessionSettings> = {}): Promise<Session> {
    const s = new Session({ settings: { ...FAST, ...settings } });
    await s.start();
    this.add(() => s.shutdown());
    return s;
  }
  /** An agent server over a fresh session rooted at a temp dir. */
  async agent(
    opts: { session?: Partial<SessionSettings>; core?: Partial<EngineAgentCoreOptions>; token?: string } = {},
  ): Promise<{ session: Session; root: string; core: EngineAgentCore; server: AgentServer; url: string }> {
    const root = await this.tmp();
    const session = await this.session({ savePath: root, ...opts.session });
    const core = new EngineAgentCore({ session, downloadsRoot: root, kind: 'standalone', sessionPollMs: 50, ...opts.core });
    const server = createAgentServer({ core, token: opts.token ?? TOKEN });
    const address = await server.listen(0, '127.0.0.1');
    this.add(() => server.close());
    return { session, root, core, server, url: `http://127.0.0.1:${address.port}` };
  }
}

export function waitFor<T>(cond: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = async () => {
      let v: T | undefined | null | false;
      try {
        v = await cond();
      } catch (error) {
        return reject(error);
      }
      if (v) return resolve(v);
      if (Date.now() - start > ms) return reject(new Error('timed out waiting for condition'));
      setTimeout(() => void tick(), 25);
    };
    void tick();
  });
}

export function authed(extra: Record<string, string> = {}, token = TOKEN): Record<string, string> {
  return { 'x-agent-token': token, ...extra };
}

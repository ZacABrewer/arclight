/**
 * Helpers shared by the end-to-end test suites (not exported from the package index).
 */
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTorrent, type CreateTorrentOptions } from './create.js';
import type { Metainfo } from './metainfo.js';
import { Session, type SessionOptions } from './session.js';
import type { SessionSettings } from './settings.js';
import type { Torrent } from './torrent.js';

export const FAST: Partial<SessionSettings> = {
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

export interface Payload {
  files: { path: string[]; data: Buffer }[];
}

export function payload(): Payload {
  return {
    files: [
      { path: ['a.bin'], data: randomBytes(150_000) },
      { path: ['dir', 'b.bin'], data: randomBytes(333) },
      { path: ['dir', 'c.bin'], data: randomBytes(260_000) },
    ],
  };
}

export async function writePayload(dir: string, name: string, p: Payload): Promise<void> {
  for (const f of p.files) {
    const full = join(dir, name, ...f.path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, f.data);
  }
}

export async function payloadMatches(dir: string, name: string, p: Payload): Promise<boolean> {
  for (const f of p.files) if (!(await readFile(join(dir, name, ...f.path))).equals(f.data)) return false;
  return true;
}

export function waitFor<T>(cond: () => T | undefined | false | null, ms = 15_000): Promise<T> {
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

export function completed(t: Torrent): Promise<void> {
  if (t.isComplete) return Promise.resolve();
  return new Promise((resolve) => t.once('completed', () => resolve()));
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Owns temporary directories and sessions; call `cleanup()` from `afterEach`. */
export class TestEnv {
  private readonly cleanups: (() => Promise<unknown> | unknown)[] = [];

  defer(fn: () => Promise<unknown> | unknown): void {
    this.cleanups.push(fn);
  }

  async cleanup(): Promise<void> {
    for (const c of this.cleanups.splice(0).reverse()) await c();
  }

  async tmp(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), 'mt-test-'));
    this.defer(() => rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    return d;
  }

  async session(settings: Partial<SessionSettings> = {}, opts: Omit<SessionOptions, 'settings'> = {}): Promise<Session> {
    const s = new Session({ ...opts, settings: { ...FAST, ...settings } });
    await s.start();
    this.defer(() => s.shutdown());
    return s;
  }

  /** A seeding session for a generated 3-file torrent. */
  async seed(
    settings: Partial<SessionSettings> = {},
    opts: Omit<SessionOptions, 'settings'> = {},
    torrentOpts: Partial<CreateTorrentOptions> = {},
    addOpts: { superSeeding?: boolean; uploadLimit?: number } = {},
  ): Promise<{ p: Payload; seedDir: string; torrent: Buffer; meta: Metainfo; seeder: Session; st: Torrent }> {
    const p = payload();
    const seedDir = await this.tmp();
    await writePayload(seedDir, 'pack', p);
    const created = createTorrent({ name: 'pack', files: p.files, pieceLength: 32 * 1024, ...torrentOpts });
    const seeder = await this.session({ savePath: seedDir, ...settings }, opts);
    const st = await seeder.addTorrent({ torrent: created.torrent, ...addOpts });
    await waitFor(() => st.state === 'seeding');
    return { p, seedDir, torrent: created.torrent, meta: created.metainfo, seeder, st };
  }
}

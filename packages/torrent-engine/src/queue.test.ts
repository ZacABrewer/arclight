import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTorrent } from './create.js';
import { Session } from './session.js';
import type { SessionSettings } from './settings.js';
import type { Torrent } from './torrent.js';

// Queue order (move up/down/top/bottom, persisted across restarts) and force start. No peers:
// torrents without data stay "downloading" forever, which is all the queue needs.

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'mt-queue-'));
  cleanups.push(() => rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return d;
}

const LOCAL: Partial<SessionSettings> = { listenPort: 0, listenAddress: '127.0.0.1', dht: false, utp: false, dhtBootstrapNodes: [] };

async function session(settings: Partial<SessionSettings>): Promise<Session> {
  const s = new Session({ settings: { ...LOCAL, ...settings } });
  await s.start();
  cleanups.push(() => s.shutdown());
  return s;
}

function waitFor(cond: () => boolean, ms = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (cond()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - start > ms) {
        clearInterval(iv);
        reject(new Error('timed out waiting for condition'));
      }
    }, 10);
  });
}

const torrentFile = (name: string) => createTorrent({ name, files: [{ path: [name], data: randomBytes(4000) }] }).torrent;
const names = (s: Session) => s.getTorrents().map((t) => t.name);
const active = (ts: Torrent[]) => ts.filter((t) => t.state === 'downloading').map((t) => t.name);

describe('memory budget', () => {
  it('splits the session cache across downloading torrents, with a floor and a per-torrent cap', async () => {
    const MiB = 1024 * 1024;
    const s = await session({ savePath: await tmp(), maxActiveDownloads: 4, cacheBytesTotal: 32 * MiB, cacheBytesPerTorrent: 32 * MiB });
    const ts = [];
    for (const n of ['a', 'b', 'c', 'd', 'e']) ts.push(await s.addTorrent({ torrent: torrentFile(n) }));
    await waitFor(() => active(s.getTorrents()).length === 4);
    for (const t of ts.slice(0, 4)) expect(t.memoryShare).toEqual({ cacheBytes: 8 * MiB, writeBacklogBytes: 4 * MiB });

    s.updateSettings({ maxActiveDownloads: 1 });
    await waitFor(() => active(s.getTorrents()).length === 1);
    expect(ts[0]!.memoryShare).toEqual({ cacheBytes: 32 * MiB, writeBacklogBytes: 16 * MiB });
  }, 30_000);
});

describe('queue order', () => {
  it('moves torrents up, down, to the top and bottom and serves them in that order', async () => {
    const s = await session({ savePath: await tmp(), maxActiveDownloads: 1 });
    const [a, b, c] = [await s.addTorrent({ torrent: torrentFile('a') }), await s.addTorrent({ torrent: torrentFile('b') }), await s.addTorrent({ torrent: torrentFile('c') })];
    await waitFor(() => a.state === 'downloading' && b.state === 'queued' && c.state === 'queued');

    expect(await s.moveInQueue(c.infoHashHex, 'top')).toBe(true);
    expect(names(s)).toEqual(['c', 'a', 'b']);
    await waitFor(() => c.state === 'downloading' && a.state === 'queued');

    expect(await s.moveInQueue(c.infoHashHex, 'down')).toBe(true);
    expect(names(s)).toEqual(['a', 'c', 'b']);
    await waitFor(() => a.state === 'downloading' && c.state === 'queued');

    expect(await s.moveInQueue(a.infoHashHex, 'bottom')).toBe(true);
    expect(names(s)).toEqual(['c', 'b', 'a']);
    expect(await s.moveInQueue(a.infoHashHex, 'down')).toBe(false);
    expect(await s.moveInQueue(b.infoHashHex, 'up')).toBe(true);
    expect(names(s)).toEqual(['b', 'c', 'a']);
    expect(await s.moveInQueue(b.infoHashHex, 'top')).toBe(false);
    await waitFor(() => active(s.getTorrents()).join() === 'b');
  }, 30_000);

  it('force start runs a torrent past the limit without taking a slot', async () => {
    const s = await session({ savePath: await tmp(), maxActiveDownloads: 1 });
    const a = await s.addTorrent({ torrent: torrentFile('a') });
    const b = await s.addTorrent({ torrent: torrentFile('b') });
    const c = await s.addTorrent({ torrent: torrentFile('c') });
    await waitFor(() => a.state === 'downloading' && c.state === 'queued');
    await s.setForceStart(c.infoHashHex, true);
    await waitFor(() => c.state === 'downloading');
    expect(a.state).toBe('downloading');
    expect(b.state).toBe('queued');
    await s.setForceStart(c.infoHashHex, false);
    await waitFor(() => c.state === 'queued');
    expect(a.state).toBe('downloading');
  }, 30_000);

  it('keeps queue order and force start across a restart', async () => {
    const dir = await tmp();
    const resumeDataDir = await tmp();
    const s1 = new Session({ settings: { ...LOCAL, savePath: dir, resumeDataDir, maxActiveDownloads: 1 } });
    await s1.start();
    const a = await s1.addTorrent({ torrent: torrentFile('a') });
    await s1.addTorrent({ torrent: torrentFile('b') });
    const c = await s1.addTorrent({ torrent: torrentFile('c') });
    await s1.moveInQueue(c.infoHashHex, 'top');
    await s1.setForceStart(a.infoHashHex, true);
    await s1.shutdown();

    const s2 = await session({ savePath: dir, resumeDataDir, maxActiveDownloads: 1 });
    expect(names(s2)).toEqual(['c', 'a', 'b']);
    expect(s2.getTorrent(a.infoHashHex)?.forceStart).toBe(true);
    await waitFor(() => active(s2.getTorrents()).sort().join() === 'a,c');
  }, 30_000);
});

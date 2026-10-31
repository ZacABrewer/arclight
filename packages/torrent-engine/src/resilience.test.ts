import { randomBytes } from 'node:crypto';
import { copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTorrent } from './create.js';
import { Storage } from './storage/storage.js';
import { completed, TestEnv, waitFor, writePayload } from './test-utils.js';

// Disk-bound behaviour: bounded concurrent checks, the metadata timeout, incremental resume
// saves that survive a kill, and progress that counts verified pieces only.

const env = new TestEnv();
afterEach(() => env.cleanup());

/** Counts concurrent Storage.recheck calls (and their order) while installed. */
function watchRechecks(): { peak: () => number; order: string[]; restore: () => void } {
  const original = Storage.prototype.recheck;
  let running = 0;
  let peak = 0;
  const order: string[] = [];
  Storage.prototype.recheck = async function (this: Storage, ...args: Parameters<Storage['recheck']>) {
    running++;
    peak = Math.max(peak, running);
    order.push(this.torrent.name);
    try {
      await new Promise((r) => setTimeout(r, 40));
      return await original.apply(this, args);
    } finally {
      running--;
    }
  };
  return { peak: () => peak, order, restore: () => (Storage.prototype.recheck = original) };
}

/** `n` single-file-in-a-folder torrents whose data is already at `dir` (so adding them checks it). */
async function withData(dir: string, n: number): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    const files = [{ path: ['f.bin'], data: randomBytes(70_000) }];
    await writePayload(dir, `t${i}`, { files });
    out.push(createTorrent({ name: `t${i}`, files, pieceLength: 16 * 1024, forceMultiFile: true }).torrent);
  }
  return out;
}

describe('data checks', () => {
  it('checks at most maxActiveChecks torrents at once, user re-checks included', async () => {
    const dir = await env.tmp();
    const torrents = await withData(dir, 5);
    const watch = watchRechecks();
    env.defer(watch.restore);
    const s = await env.session({ savePath: dir, maxActiveChecks: 2 });
    const added = await Promise.all(torrents.map((torrent) => s.addTorrent({ torrent })));
    await waitFor(() => added.every((t) => t.state === 'seeding'));
    expect(watch.peak()).toBe(2);
    await Promise.all(added.map((t) => t.forceRecheck()));
    expect(watch.peak()).toBe(2);
    expect(watch.order).toHaveLength(10);
    expect(added.every((t) => t.getStats().progress === 1)).toBe(true);
  });

  it('serves waiting checks in queue order', async () => {
    const dir = await env.tmp();
    const torrents = await withData(dir, 4);
    const watch = watchRechecks();
    env.defer(watch.restore);
    const s = await env.session({ savePath: dir, maxActiveChecks: 1 });
    const first = s.addTorrent({ torrent: torrents[0]! });
    await waitFor(() => watch.order.length === 1);
    const rest = await Promise.all(torrents.slice(1).reverse().map((torrent) => s.addTorrent({ torrent })));
    await first;
    // Added t3, t2, t1: queue positions in that order, so checked in that order.
    expect(watch.order).toEqual(['t0', 't3', 't2', 't1']);
    expect(rest).toHaveLength(3);
  });

  it('starts a fresh download without waiting for a check slot', async () => {
    const dir = await env.tmp();
    const files = [{ path: ['f.bin'], data: randomBytes(70_000) }];
    await writePayload(dir, 'busy', { files });
    const busy = createTorrent({ name: 'busy', files, pieceLength: 16 * 1024, forceMultiFile: true }).torrent;
    const fresh = createTorrent({ name: 'fresh', files: [{ path: ['g.bin'], data: randomBytes(9000) }] }).torrent;
    const s = await env.session({ savePath: dir, maxActiveChecks: 1 });
    // Hold the only slot.
    const original = Storage.prototype.recheck;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    Storage.prototype.recheck = async function (this: Storage, ...args: Parameters<Storage['recheck']>) {
      await held;
      return original.apply(this, args);
    };
    env.defer(() => (Storage.prototype.recheck = original));
    const checking = s.addTorrent({ torrent: busy });
    await waitFor(() => s.getTorrents()[0]?.state === 'checking');
    const t = await s.addTorrent({ torrent: fresh });
    expect(t.state).toBe('downloading');
    release();
    expect((await checking).state).toBe('seeding');
  });
});

describe('metadata timeout', () => {
  it('fails a magnet that gets no metadata in time, with a reason the download client can show', async () => {
    const s = await env.session({ savePath: await env.tmp(), metadataTimeoutMs: 300 });
    const failed = new Promise<Error>((r) => s.onError((_t, err) => r(err)));
    const t = await s.addTorrent({ magnet: `magnet:?xt=urn:btih:${randomBytes(20).toString('hex')}` });
    expect(t.state).toBe('downloadingMetadata');
    const err = await failed;
    expect(err.message).toBe('no metadata after 1 second: no peers had this magnet');
    expect(t.state).toBe('error');
    expect(t.getStats().error).toBe(err.message);
    // Resuming gives it a fresh wait.
    await s.resumeTorrent(t.infoHashHex);
    await waitFor(() => t.state === 'downloadingMetadata');
  });

  it('never fires with a timeout of 0', async () => {
    const s = await env.session({ savePath: await env.tmp(), metadataTimeoutMs: 0 });
    const t = await s.addTorrent({ magnet: `magnet:?xt=urn:btih:${randomBytes(20).toString('hex')}` });
    await new Promise((r) => setTimeout(r, 400));
    expect(t.state).toBe('downloadingMetadata');
  });
});

describe('crash-safe resume', () => {
  it('saves resume data soon after pieces verify and resumes from it after a kill without a full re-check', async () => {
    const { torrent, meta, seeder } = await env.seed({ uploadLimit: 200_000 });
    const leechDir = await env.tmp();
    const resumeDir = await env.tmp();
    const leecher = await env.session({ savePath: leechDir, resumeDataDir: resumeDir, resumeSaveDelayMs: 100 });
    const lt = await leecher.addTorrent({ torrent, peers: [{ host: '127.0.0.1', port: seeder.listenPort }] });
    const file = join(resumeDir, `${meta.infoHashHex}.resume.json`);
    const savedPieces = async (): Promise<number> => {
      const bf = Buffer.from((JSON.parse(await readFile(file, 'utf8')) as { bitfield: string }).bitfield, 'base64');
      let n = 0;
      for (const byte of bf) for (let b = byte; b; b >>= 1) n += b & 1;
      return n;
    };
    // Written while downloading, long before the 5-minute periodic save.
    let snapshotPieces = 0;
    await waitFor(() => {
      void savedPieces().then((n) => (snapshotPieces = n), () => {});
      return snapshotPieces >= 3 && snapshotPieces < meta.pieceCount;
    });
    // "Kill": keep the resume file as it was at that moment, whatever the shutdown writes later.
    const snapshot = join(await env.tmp(), 'snapshot.json');
    await copyFile(file, snapshot);
    await completed(lt);
    await leecher.shutdown();
    await copyFile(snapshot, file);
    const watch = watchRechecks();
    env.defer(watch.restore);
    const restarted = await env.session({ savePath: leechDir, resumeDataDir: resumeDir });
    await restarted.whenRestored();
    const [rt] = restarted.getTorrents();
    expect(watch.order).toEqual([]);
    expect(rt!.getStats().piecesHave).toBeGreaterThanOrEqual(snapshotPieces);
  }, 30_000);

  it('lets received blocks finish verifying on shutdown and saves them', async () => {
    const { torrent, meta, seeder } = await env.seed();
    const original = Storage.prototype.verifyPiece;
    Storage.prototype.verifyPiece = async function (this: Storage, piece: number) {
      await new Promise((r) => setTimeout(r, 300));
      return original.call(this, piece);
    };
    env.defer(() => (Storage.prototype.verifyPiece = original));
    const leechDir = await env.tmp();
    const resumeDir = await env.tmp();
    const leecher = await env.session({ savePath: leechDir, resumeDataDir: resumeDir, resumeSaveDelayMs: 60_000 });
    const lt = await leecher.addTorrent({ torrent, peers: [{ host: '127.0.0.1', port: seeder.listenPort }] });
    // Every block is in, the hash checks are still running: stop now.
    await waitFor(() => lt.getStats().downloaded >= lt.getStats().wantedBytes);
    expect(lt.isComplete).toBe(false);
    await leecher.shutdown();
    const saved = JSON.parse(await readFile(join(resumeDir, `${meta.infoHashHex}.resume.json`), 'utf8')) as { bitfield: string };
    const bf = Buffer.from(saved.bitfield, 'base64');
    let n = 0;
    for (const byte of bf) for (let b = byte; b; b >>= 1) n += b & 1;
    expect(n).toBe(meta.pieceCount);
  }, 30_000);
});

describe('progress', () => {
  it('counts only verified pieces, not blocks received and waiting for their hash check', async () => {
    const { torrent, seeder } = await env.seed();
    const original = Storage.prototype.verifyPiece;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    Storage.prototype.verifyPiece = async function (this: Storage, piece: number) {
      await gate;
      return original.call(this, piece);
    };
    env.defer(() => (Storage.prototype.verifyPiece = original));
    const leecher = await env.session({ savePath: await env.tmp() });
    const lt = await leecher.addTorrent({ torrent, peers: [{ host: '127.0.0.1', port: seeder.listenPort }] });
    await waitFor(() => lt.getStats().downloaded >= lt.getStats().wantedBytes);
    const stats = lt.getStats();
    expect(stats.progress).toBe(0);
    expect(stats.piecesHave).toBe(0);
    expect(stats.bytesLeft).toBe(stats.wantedBytes);
    expect(lt.isComplete).toBe(false);
    release();
    await completed(lt);
    expect(lt.getStats().progress).toBe(1);
  }, 30_000);
});

describe('uploads while writes lag', () => {
  it('serves one disk read at a time while the disk is behind, several otherwise', async () => {
    const s = await env.session({ savePath: await env.tmp() });
    const internals = s as unknown as { writesLagging: () => boolean; uploadRead: <T>(f: () => Promise<T>) => Promise<T>; uploadBudgetAt: number };
    const peakOf = async (): Promise<number> => {
      let running = 0;
      let peak = 0;
      internals.uploadBudgetAt = 0;
      await Promise.all(
        Array.from({ length: 6 }, () =>
          internals.uploadRead(async () => {
            running++;
            peak = Math.max(peak, running);
            await new Promise((r) => setTimeout(r, 10));
            running--;
          }),
        ),
      );
      return peak;
    };
    expect(await peakOf()).toBe(6);
    internals.writesLagging = () => true;
    expect(await peakOf()).toBe(1);
  });
});

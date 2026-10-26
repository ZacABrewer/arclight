import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTorrent } from '../create.js';
import { encode } from '../bencode.js';
import { parseTorrent, type Metainfo } from '../metainfo.js';
import { BLOCK_SIZE } from '../peer/messages.js';
import { PieceLayout } from './layout.js';
import { deleteResumeData, listResumeData, loadResumeData, saveResumeData, type ResumeData } from './resume.js';
import { Storage } from './storage.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'mt-storage-'));
  dirs.push(d);
  return d;
}

const PIECE = 32 * 1024;
function fixture(): { meta: Metainfo; files: Buffer[]; payload: Buffer } {
  const files = [randomBytes(40_000), randomBytes(10), randomBytes(0), randomBytes(70_000)];
  const { metainfo } = createTorrent({
    name: 'pack',
    files: files.map((data, i) => ({ path: i === 3 ? ['sub', `f${i}.bin`] : [`f${i}.bin`], data })),
    pieceLength: PIECE,
  });
  return { meta: metainfo, files, payload: Buffer.concat(files) };
}

async function writeAll(s: Storage, payload: Buffer): Promise<void> {
  for (let p = 0; p < s.layout.pieceCount; p++) {
    for (let b = 0; b < s.layout.blocksInPiece(p); b++) {
      const off = p * PIECE + b * BLOCK_SIZE;
      await s.writeBlock(p, b * BLOCK_SIZE, payload.subarray(off, off + s.layout.blockSize(p, b)));
    }
    expect(await s.verifyPiece(p)).toBe(true);
  }
}

describe('PieceLayout', () => {
  it('maps pieces and blocks across files', () => {
    const { meta } = fixture();
    const l = new PieceLayout(meta.files, PIECE, meta.totalLength);
    expect(l.pieceCount).toBe(4);
    expect(l.pieceSize(3)).toBe(110_010 - 3 * PIECE);
    expect(l.blocksInPiece(0)).toBe(2);
    expect(l.blockSize(3, 0)).toBe(l.pieceSize(3));
    // piece 1 spans f0 (end), f1 (all), skips empty f2, then f3 start
    const spans = l.pieceSpans(1);
    expect(spans.map((s) => [s.file.index, s.fileOffset, s.length, s.rangeOffset])).toEqual([
      [0, PIECE, 40_000 - PIECE, 0],
      [1, 0, 10, 40_000 - PIECE],
      [3, 0, PIECE - (40_010 - PIECE), 40_010 - PIECE],
    ]);
    expect(l.filesForPiece(1)).toEqual([0, 1, 3]);
    expect(l.pieceRange(3)).toEqual([1, 3]);
    expect(l.pieceRange(2)).toBeNull();
    expect(l.isValidBlock(0, 0, BLOCK_SIZE)).toBe(true);
    expect(l.isValidBlock(3, 0, PIECE)).toBe(false);
    expect(l.isValidBlock(9, 0, 1)).toBe(false);
  });
});

describe('Storage', () => {
  it('writes blocks across files, verifies pieces and produces the exact files', async () => {
    const dir = await tmp();
    const { meta, files, payload } = fixture();
    const s = new Storage(meta, { savePath: dir });
    await s.createEmptyFiles();
    await writeAll(s, payload);
    expect(s.have.hasAll()).toBe(true);
    await s.close();
    expect((await readFile(join(dir, 'pack', 'f0.bin'))).equals(files[0]!)).toBe(true);
    expect((await readFile(join(dir, 'pack', 'f1.bin'))).equals(files[1]!)).toBe(true);
    expect((await readFile(join(dir, 'pack', 'f2.bin'))).length).toBe(0);
    expect((await readFile(join(dir, 'pack', 'sub', 'f3.bin'))).equals(files[3]!)).toBe(true);
  });

  it('rejects corrupt pieces and drops them from the cache', async () => {
    const dir = await tmp();
    const { meta } = fixture();
    const s = new Storage(meta, { savePath: dir });
    await s.writeBlock(0, 0, randomBytes(BLOCK_SIZE));
    await s.writeBlock(0, BLOCK_SIZE, randomBytes(BLOCK_SIZE));
    expect(await s.verifyPiece(0)).toBe(false);
    expect(s.have.get(0)).toBe(false);
    expect(s.cachedBytes).toBe(0);
    await expect(s.writeBlock(0, 1, Buffer.alloc(PIECE * 2))).rejects.toThrow('invalid block');
    await s.close();
  });

  it('verifies from disk when the cache was evicted and serves reads', async () => {
    const dir = await tmp();
    const { meta, payload } = fixture();
    const s = new Storage(meta, { savePath: dir, cacheBytes: 1 });
    await writeAll(s, payload);
    expect((await s.read(1, 100, 1000)).equals(payload.subarray(PIECE + 100, PIECE + 1100))).toBe(true);
    await s.close();
  });

  it('preallocates sparse files to their final size', async () => {
    const dir = await tmp();
    const { meta, payload } = fixture();
    const s = new Storage(meta, { savePath: dir });
    await s.writeBlock(3, 0, payload.subarray(3 * PIECE, 3 * PIECE + s.layout.blockSize(3, 0)));
    expect((await stat(join(dir, 'pack', 'sub', 'f3.bin'))).size).toBe(70_000);
    await s.close();
  });

  it('re-checks existing data and finds partial content', async () => {
    const dir = await tmp();
    const { meta, files } = fixture();
    await mkdir(join(dir, 'pack', 'sub'), { recursive: true });
    await writeFile(join(dir, 'pack', 'f0.bin'), files[0]!);
    await writeFile(join(dir, 'pack', 'f1.bin'), files[1]!);
    const broken = Buffer.from(files[3]!);
    broken[60_000] = (broken[60_000] ?? 0) ^ 0xff; // corrupt piece 3
    await writeFile(join(dir, 'pack', 'sub', 'f3.bin'), broken);
    const s = new Storage(meta, { savePath: dir });
    const progress: number[] = [];
    const bf = await s.recheck((d) => progress.push(d));
    expect([...bf.indices()]).toEqual([0, 1, 2]);
    expect(progress.at(-1)).toBe(4);
    await s.close();
    const empty = new Storage(meta, { savePath: await tmp() });
    expect((await empty.recheck()).count()).toBe(0);
  });

  it('resumes from a saved bitfield only when file stats match', async () => {
    const dir = await tmp();
    const { meta, payload } = fixture();
    const s = new Storage(meta, { savePath: dir });
    await writeAll(s, payload);
    await s.close();
    const stats = await s.fileStats();
    const s2 = new Storage(meta, { savePath: dir });
    expect(await s2.tryResume(s.have.toBuffer(), stats)).toBe(true);
    expect(s2.have.hasAll()).toBe(true);
    await utimes(join(dir, 'pack', 'f0.bin'), new Date(), new Date(Date.now() + 3600_000));
    const s3 = new Storage(meta, { savePath: dir });
    expect(await s3.tryResume(s.have.toBuffer(), stats)).toBe(false);
  });

  it('resumes a file written to after the save (crash) and spot-checks it', async () => {
    const dir = await tmp();
    const { meta, payload, files } = fixture();
    const s = new Storage(meta, { savePath: dir });
    await writeAll(s, payload);
    await s.close();
    const stats = await s.fileStats();
    // Saved before piece 3 arrived: sub/f3.bin (pieces 1..3) was still being written.
    const partial = s.have.clone();
    partial.set(3, false);
    const f3 = join(dir, 'pack', 'sub', 'f3.bin');
    const later = new Date(Date.now() + 3600_000);
    await utimes(f3, later, later);
    const s2 = new Storage(meta, { savePath: dir });
    expect(await s2.tryResume(partial.toBuffer(), stats)).toBe(true);
    expect([...s2.have.indices()]).toEqual([0, 1, 2]);
    await s2.close();
    // Same size, newer, but the claimed pieces no longer hash: fall back to a full re-check.
    const corrupt = Buffer.from(files[3]!);
    corrupt.fill(0, 0, 4096);
    await writeFile(f3, corrupt);
    await utimes(f3, later, later);
    const s3 = new Storage(meta, { savePath: dir });
    expect(await s3.tryResume(partial.toBuffer(), stats)).toBe(false);
    expect(s3.have.count()).toBe(0);
    await s3.close();
  });

  it('keeps skipped files out of the payload via a parts file and migrates on re-enable', async () => {
    const dir = await tmp();
    const { meta, files, payload } = fixture();
    const s = new Storage(meta, { savePath: dir, filePriorities: [1, 0, 1, 1] });
    await writeAll(s, payload);
    await expect(stat(join(dir, 'pack', 'f1.bin'))).rejects.toThrow();
    expect((await stat(s.partsPath)).size).toBeGreaterThan(0);
    // reads still work because the parts file holds the boundary bytes
    expect((await s.read(1, 0, s.layout.pieceSize(1))).equals(payload.subarray(PIECE, 2 * PIECE))).toBe(true);
    await s.setFilePriorities([1, 1, 1, 1]);
    await s.close();
    expect((await readFile(join(dir, 'pack', 'f1.bin'))).equals(files[1]!)).toBe(true);
  });

  it('uses an incomplete extension until each file completes', async () => {
    const dir = await tmp();
    const { meta, payload } = fixture();
    const s = new Storage(meta, { savePath: dir, incompleteExtension: '.part' });
    const p0 = payload.subarray(0, PIECE);
    await s.writeBlock(0, 0, p0.subarray(0, BLOCK_SIZE));
    await s.writeBlock(0, BLOCK_SIZE, p0.subarray(BLOCK_SIZE));
    expect(await s.verifyPiece(0)).toBe(true);
    expect((await stat(join(dir, 'pack', 'f0.bin.part'))).isFile()).toBe(true);
    await writeAll(s, payload);
    await expect(stat(join(dir, 'pack', 'f0.bin.part'))).rejects.toThrow();
    expect((await stat(join(dir, 'pack', 'f0.bin'))).size).toBe(40_000);
    expect((await stat(join(dir, 'pack', 'sub', 'f3.bin'))).size).toBe(70_000);
    await s.close();
  });

  it('moves payload to another directory and deletes it', async () => {
    const dir = await tmp();
    const dest = join(await tmp(), 'done');
    const { meta, files, payload } = fixture();
    const s = new Storage(meta, { savePath: dir });
    await writeAll(s, payload);
    await s.move(dest);
    expect(s.savePath).toBe(dest);
    expect((await readFile(join(dest, 'pack', 'sub', 'f3.bin'))).equals(files[3]!)).toBe(true);
    await expect(stat(join(dir, 'pack'))).rejects.toThrow();
    expect((await s.read(0, 0, 10)).equals(payload.subarray(0, 10))).toBe(true);
    await s.deleteFiles();
    await expect(stat(join(dest, 'pack'))).rejects.toThrow();
  });

  it('never writes padding files', async () => {
    const dir = await tmp();
    const a = randomBytes(10);
    const b = randomBytes(16);
    const payload = Buffer.concat([a, Buffer.alloc(6), b]);
    const { createHash } = await import('node:crypto');
    const h = (x: Buffer) => createHash('sha1').update(x).digest();
    const info = { name: 'p', 'piece length': 16, pieces: Buffer.concat([h(payload.subarray(0, 16)), h(payload.subarray(16))]), files: [{ length: 10, path: ['a'] }, { length: 6, path: ['.pad', '6'], attr: 'p' }, { length: 16, path: ['b'] }] };
    const meta = parseTorrent(encode({ info }));
    const s = new Storage(meta, { savePath: dir });
    await s.writeBlock(0, 0, payload.subarray(0, 16));
    await s.writeBlock(1, 0, payload.subarray(16));
    expect(await s.verifyPiece(0)).toBe(true);
    expect(await s.verifyPiece(1)).toBe(true);
    await s.close();
    await expect(stat(join(dir, 'p', '.pad'))).rejects.toThrow();
    expect((await readFile(join(dir, 'p', 'a'))).equals(a)).toBe(true);
  });
});

describe('resume data', () => {
  it('saves, lists, loads and deletes resume records atomically', async () => {
    const dir = await tmp();
    const data: ResumeData = {
      version: 1, infoHash: 'a'.repeat(40), name: 'x', bitfield: Buffer.from([0xff]).toString('base64'), pieceCount: 8,
      uploaded: 1, downloaded: 2, seedingTimeMs: 3, activeTimeMs: 4, addedAt: new Date(0).toISOString(), completedAt: null,
      savePath: dir, category: 'tv', tags: ['a'], filePriorities: [1], paused: false, sequential: false,
      fileStats: [null], magnet: null, seedRatioLimit: null, seedTimeLimitMs: null,
    };
    await saveResumeData(dir, data, Buffer.from('torrent'));
    expect(await listResumeData(dir)).toEqual(['a'.repeat(40)]);
    expect(await loadResumeData(dir, 'a'.repeat(40))).toEqual(data);
    expect(await readFile(join(dir, `${'a'.repeat(40)}.torrent`), 'utf8')).toBe('torrent');
    await writeFile(join(dir, `${'b'.repeat(40)}.resume.json`), '{"version":2}');
    expect(await loadResumeData(dir, 'b'.repeat(40))).toBeNull();
    await deleteResumeData(dir, 'a'.repeat(40));
    expect(await loadResumeData(dir, 'a'.repeat(40))).toBeNull();
    expect(await listResumeData(join(dir, 'missing'))).toEqual([]);
  });
});

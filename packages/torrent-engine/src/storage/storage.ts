import { createHash } from 'node:crypto';
import { copyFile, type FileHandle, mkdir, open, readdir, rename, rm, rmdir, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Bitfield } from '../bitfield.js';
import { copyExact, ownsBacking } from '../buffers.js';
import { errorMessage, TorrentEngineError } from '../errors.js';
import type { TorrentFileEntry } from '../metainfo.js';
import { type FileSpan, PieceLayout } from './layout.js';

/** Pieces re-hashed per file when resuming a file written to after the last resume save. */
const RESUME_SPOT_CHECKS = 4;
/** Disk reads per step when hashing a piece that is not (fully) in the cache. */
const VERIFY_CHUNK = 256 * 1024;
/**
 * Bytes of received blocks waiting for disk before the torrent stops requesting more. Without a
 * bound a download faster than the disk (spinning NAS disks, a parallel recheck) queued writes
 * without limit and the process ran out of memory.
 */
export const WRITE_BACKLOG_MAX = 32 * 1024 * 1024;

export interface StorageTorrent {
  infoHashHex: string;
  name: string;
  files: TorrentFileEntry[];
  pieceLength: number;
  totalLength: number;
  pieceHashes: Buffer[];
  isMultiFile: boolean;
}

export interface StorageOptions {
  savePath: string;
  /** Per-file priority 0..7 (0 = skip). Defaults to 1 for every file. */
  filePriorities?: number[];
  /** Suffix for files that are not complete yet (e.g. `.part`); renamed on completion. */
  incompleteExtension?: string;
  /** Block cache size in bytes (default 32 MiB). */
  cacheBytes?: number;
  /** Queued write bytes before backpressure (default WRITE_BACKLOG_MAX). */
  writeBacklogBytes?: number;
  maxOpenFiles?: number;
  /** `sparse` sets the final file size on creation (sparse on most filesystems). */
  preallocate?: 'sparse' | 'none';
  /** Called when queued writes fall back under half of WRITE_BACKLOG_MAX after being over it. */
  onWriteDrain?: () => void;
}

interface CachedPiece {
  blocks: Map<number, Buffer>;
  bytes: number;
}

interface Handle {
  fh: FileHandle;
  inUse: number;
}

type Location = 'file' | 'parts';

/**
 * Disk storage for one torrent: maps blocks onto files, writes through a block cache,
 * verifies pieces, keeps skipped files' boundary data in a `.parts` file and supports
 * re-check, move and delete.
 */
export class Storage {
  readonly layout: PieceLayout;
  /** Pieces verified on disk. */
  readonly have: Bitfield;
  private savePathValue: string;
  private priorities: number[];
  private readonly location: Location[];
  private readonly cache = new Map<number, CachedPiece>();
  private cacheSize = 0;
  private readonly handles = new Map<string, Handle>();
  private readonly finalized: boolean[];
  private closed = false;

  constructor(
    readonly torrent: StorageTorrent,
    private readonly opts: StorageOptions,
  ) {
    this.layout = new PieceLayout(torrent.files, torrent.pieceLength, torrent.totalLength);
    this.have = new Bitfield(this.layout.pieceCount);
    this.savePathValue = opts.savePath;
    this.priorities = torrent.files.map((_, i) => opts.filePriorities?.[i] ?? 1);
    this.location = this.priorities.map((p) => (p > 0 ? 'file' : 'parts'));
    this.finalized = torrent.files.map(() => !opts.incompleteExtension);
  }

  get savePath(): string {
    return this.savePathValue;
  }

  get filePriorities(): readonly number[] {
    return this.priorities;
  }

  /** Root of the payload: the torrent directory (multi-file) or the single file. */
  get contentPath(): string {
    return join(this.savePathValue, this.torrent.name);
  }

  get partsPath(): string {
    return join(this.savePathValue, `.${this.torrent.infoHashHex}.parts`);
  }

  filePath(f: TorrentFileEntry, final = this.finalized[f.index] ?? true): string {
    const p = join(this.savePathValue, ...f.pathSegments);
    return final || !this.opts.incompleteExtension ? p : p + this.opts.incompleteExtension;
  }

  // ---- file handles -----------------------------------------------------------------------

  private readonly opening = new Map<string, Promise<FileHandle | null>>();

  private async acquire(path: string, size: number | null, create: boolean): Promise<Handle | null> {
    for (;;) {
      if (this.closed) throw new TorrentEngineError('storage', 'storage is closed');
      const existing = this.handles.get(path);
      if (existing) {
        existing.inUse++;
        this.handles.delete(path);
        this.handles.set(path, existing); // LRU touch
        return existing;
      }
      const pending = this.opening.get(path);
      if (pending) {
        // Another caller is opening this file; wait and reuse its handle.
        await pending.catch(() => null);
        if (this.handles.has(path)) continue;
        if (!create) return null;
      }
      const p = this.openFile(path, size, create);
      this.opening.set(path, p);
      let fh: FileHandle | null;
      try {
        fh = await p;
      } finally {
        this.opening.delete(path);
      }
      if (!fh) return null;
      if (this.closed) {
        await fh.close().catch(() => {});
        throw new TorrentEngineError('storage', 'storage is closed');
      }
      const h: Handle = { fh, inUse: 1 };
      this.handles.set(path, h);
      await this.evictHandles();
      return h;
    }
  }

  private async openFile(path: string, size: number | null, create: boolean): Promise<FileHandle | null> {
    try {
      return await open(path, 'r+');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      if (!create) return null;
    }
    await mkdir(dirname(path), { recursive: true });
    let fh: FileHandle;
    try {
      fh = await open(path, 'wx+');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      return open(path, 'r+');
    }
    if (size !== null && size > 0 && (this.opts.preallocate ?? 'sparse') === 'sparse') await fh.truncate(size);
    return fh;
  }

  private release(h: Handle): void {
    h.inUse--;
  }

  private async evictHandles(): Promise<void> {
    const max = this.opts.maxOpenFiles ?? 32;
    for (const [path, h] of this.handles) {
      if (this.handles.size <= max) break;
      if (h.inUse === 0) await this.closeHandle(path);
    }
  }

  private async closeHandle(path: string): Promise<void> {
    const h = this.handles.get(path);
    if (!h) return;
    this.handles.delete(path);
    await h.fh.close().catch(() => {});
  }

  /** Closes all file handles (kept data stays on disk). */
  async closeFiles(): Promise<void> {
    for (const path of [...this.handles.keys()]) await this.closeHandle(path);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.closeFiles();
    this.cache.clear();
    this.cacheSize = 0;
  }

  private spanTarget(s: FileSpan): { path: string; position: number; size: number } {
    if (this.location[s.file.index] === 'parts')
      return { path: this.partsPath, position: s.file.offset + s.fileOffset, size: 0 };
    return { path: this.filePath(s.file), position: s.fileOffset, size: s.file.length };
  }

  // ---- block I/O ----------------------------------------------------------------------------

  /** Creates wanted empty files so the payload is complete even without bytes for them. */
  async createEmptyFiles(): Promise<void> {
    for (const f of this.torrent.files) {
      if (f.length !== 0 || f.padding || (this.priorities[f.index] ?? 1) === 0) continue;
      const p = this.filePath(f, true);
      await mkdir(dirname(p), { recursive: true });
      await (await open(p, 'a')).close();
    }
  }

  private readonly pendingWrites = new Map<number, Promise<void>>();
  private queuedWriteBytes = 0;
  private writeBlocked = false;

  /** Bytes received but not yet on disk. */
  get writeBacklog(): number {
    return this.queuedWriteBytes;
  }

  private get backlogMax(): number {
    return this.opts.writeBacklogBytes ?? WRITE_BACKLOG_MAX;
  }

  /** True while the write backlog is over its limit (until it drains to half). */
  get writeBackpressure(): boolean {
    return this.writeBlocked;
  }

  /**
   * Writes a block to disk (write-through) and keeps it in the cache for hashing. Writes to
   * the same piece are serialized so `verifyPiece` can wait for them.
   */
  writeBlock(piece: number, begin: number, data: Buffer): Promise<void> {
    if (this.closed) return Promise.reject(new TorrentEngineError('storage', 'storage is closed'));
    if (!this.layout.isValidBlock(piece, begin, data.length))
      return Promise.reject(new TorrentEngineError('storage', `invalid block ${piece}:${begin}:${data.length}`));
    this.cacheBlock(piece, begin, data);
    this.queuedWriteBytes += data.length;
    if (this.queuedWriteBytes > this.backlogMax) this.writeBlocked = true;
    const prev = this.pendingWrites.get(piece) ?? Promise.resolve();
    const p = prev.catch(() => {}).then(() => this.doWrite(piece, begin, data));
    this.pendingWrites.set(piece, p);
    const settled = (): void => {
      if (this.pendingWrites.get(piece) === p) this.pendingWrites.delete(piece);
      this.queuedWriteBytes -= data.length;
      if (this.writeBlocked && this.queuedWriteBytes <= this.backlogMax / 2) {
        this.writeBlocked = false;
        this.opts.onWriteDrain?.();
      }
    };
    void p.then(settled, settled);
    return p;
  }

  private async doWrite(piece: number, begin: number, data: Buffer): Promise<void> {
    for (const s of this.layout.pieceSpans(piece, begin, data.length)) {
      if (s.file.padding) continue;
      const t = this.spanTarget(s);
      const h = await this.acquire(t.path, t.size, true);
      try {
        await (h as Handle).fh.write(data, s.rangeOffset, s.length, t.position);
      } catch (err) {
        throw new TorrentEngineError('storage', `write to ${t.path} failed: ${errorMessage(err)}`, { cause: err });
      } finally {
        this.release(h as Handle);
      }
    }
  }

  private cacheBlock(piece: number, begin: number, data: Buffer): void {
    // A block that shares its backing store (a socket read chunk, a pool slab) would pin all of
    // it for as long as the piece stays unfinished. Keep an exactly-sized copy.
    if (!ownsBacking(data)) data = copyExact(data);
    let entry = this.cache.get(piece);
    if (entry) this.cache.delete(piece);
    else entry = { blocks: new Map(), bytes: 0 };
    this.cache.set(piece, entry);
    const old = entry.blocks.get(begin);
    if (old) {
      entry.bytes -= old.length;
      this.cacheSize -= old.length;
    }
    entry.blocks.set(begin, data);
    entry.bytes += data.length;
    this.cacheSize += data.length;
    const max = this.opts.cacheBytes ?? 32 * 1024 * 1024;
    for (const [p, e] of this.cache) {
      if (this.cacheSize <= max || p === piece) break;
      this.cache.delete(p);
      this.cacheSize -= e.bytes;
    }
  }

  /**
   * Changes the cache size and write backlog limit. A smaller cache drops the oldest unfinished
   * pieces at once (they are on disk; hashing reads them back).
   */
  setMemoryBudget(bytes: number, writeBacklogBytes: number): void {
    this.opts.cacheBytes = bytes;
    this.opts.writeBacklogBytes = writeBacklogBytes;
    if (this.writeBlocked && this.queuedWriteBytes <= writeBacklogBytes / 2) {
      this.writeBlocked = false;
      this.opts.onWriteDrain?.();
    } else if (this.queuedWriteBytes > writeBacklogBytes) this.writeBlocked = true;
    for (const [p, e] of this.cache) {
      if (this.cacheSize <= bytes) break;
      this.cache.delete(p);
      this.cacheSize -= e.bytes;
    }
  }

  private dropCache(piece: number): void {
    const e = this.cache.get(piece);
    if (!e) return;
    this.cache.delete(piece);
    this.cacheSize -= e.bytes;
  }

  /**
   * Drops every cached block (the torrent stopped). Safe at any time: blocks are written
   * through to disk, and a piece not complete in the cache is verified from disk.
   */
  releaseCache(): void {
    this.cache.clear();
    this.cacheSize = 0;
  }

  get cachedBytes(): number {
    return this.cacheSize;
  }

  /** Reads a range of a piece from cache or disk. Missing data throws. */
  async read(piece: number, begin: number, length: number): Promise<Buffer> {
    const cached = this.cache.get(piece)?.blocks.get(begin);
    if (cached && cached.length === length) return cached;
    const out = Buffer.alloc(length);
    await this.readInto(out, 0, piece, begin, length);
    return out;
  }

  /** Reads `length` bytes of a piece from disk into `out` at `at`. Missing data throws. */
  private async readInto(out: Buffer, at: number, piece: number, begin: number, length: number): Promise<void> {
    for (const s of this.layout.pieceSpans(piece, begin, length)) {
      if (s.file.padding) {
        out.fill(0, at + s.rangeOffset, at + s.rangeOffset + s.length);
        continue;
      }
      const t = this.spanTarget(s);
      const h = await this.acquire(t.path, null, false);
      if (!h) throw new TorrentEngineError('storage', `file missing: ${t.path}`);
      try {
        const { bytesRead } = await h.fh.read(out, at + s.rangeOffset, s.length, t.position);
        if (bytesRead < s.length) throw new TorrentEngineError('storage', `short read from ${t.path}`);
      } finally {
        this.release(h);
      }
    }
  }

  /** Hashes a piece (from cache when complete there, otherwise from disk). */
  async verifyPiece(piece: number): Promise<boolean> {
    const expected = this.torrent.pieceHashes[piece];
    if (!expected) return false;
    try {
      await this.pendingWrites.get(piece);
    } catch {
      this.dropCache(piece);
      return false;
    }
    const size = this.layout.pieceSize(piece);
    // Hashed block by block (cache) or in reused 256 KiB reads (disk): never a piece-sized
    // allocation, which at large piece sizes was most of the engine's garbage.
    let digest: Buffer | null = null;
    const e = this.cache.get(piece);
    if (e && e.bytes === size) {
      const parts = [...e.blocks.entries()].sort((a, b) => a[0] - b[0]);
      let pos = 0;
      if (parts.every(([b, d]) => (b === pos ? ((pos += d.length), true) : false)) && pos === size) {
        const h = createHash('sha1');
        for (const [, d] of parts) h.update(d);
        digest = h.digest();
      }
    }
    if (!digest) {
      try {
        const h = createHash('sha1');
        const chunk = Buffer.allocUnsafeSlow(Math.min(size, VERIFY_CHUNK));
        for (let off = 0; off < size; off += chunk.length) {
          const n = Math.min(chunk.length, size - off);
          await this.readInto(chunk, 0, piece, off, n);
          h.update(n === chunk.length ? chunk : chunk.subarray(0, n));
        }
        digest = h.digest();
      } catch {
        return false;
      }
    }
    const ok = digest.equals(expected);
    // The cache only holds a piece until it is hashed: kept afterwards, every torrent pinned up
    // to cacheBytes of finished data for good. Uploads read from disk (the OS caches hot data).
    this.dropCache(piece);
    if (ok) await this.markVerified(piece);
    else this.have.set(piece, false);
    return ok;
  }

  /** Marks a piece verified and finalizes files it completes. */
  async markVerified(piece: number): Promise<void> {
    this.have.set(piece);
    if (!this.opts.incompleteExtension) return;
    for (const idx of this.layout.filesForPiece(piece)) await this.maybeFinalize(idx);
  }

  /** True when every piece of file `idx` is verified. */
  isFileComplete(idx: number): boolean {
    const r = this.layout.pieceRange(idx);
    if (!r) return true;
    for (let i = r[0]; i <= r[1]; i++) if (!this.have.get(i)) return false;
    return true;
  }

  private async maybeFinalize(idx: number): Promise<void> {
    const f = this.torrent.files[idx];
    if (!f || this.finalized[idx] || f.padding || this.location[idx] !== 'file' || !this.isFileComplete(idx)) return;
    const from = this.filePath(f, false);
    const to = this.filePath(f, true);
    await this.closeHandle(from);
    try {
      await rename(from, to);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    this.finalized[idx] = true;
  }

  // ---- priorities ---------------------------------------------------------------------------

  /** Changes file priorities; data of files that become wanted is moved out of the parts file. */
  async setFilePriorities(priorities: number[]): Promise<void> {
    for (const f of this.torrent.files) {
      const next = priorities[f.index] ?? this.priorities[f.index] ?? 1;
      this.priorities[f.index] = next;
      if (next > 0 && this.location[f.index] === 'parts') await this.migrateFromParts(f);
    }
  }

  private async migrateFromParts(f: TorrentFileEntry): Promise<void> {
    const r = this.layout.pieceRange(f.index);
    this.location[f.index] = 'file';
    if (!r || f.padding) return;
    const parts = await this.acquire(this.partsPath, null, false);
    if (!parts) return;
    try {
      const dest = await this.acquire(this.filePath(f), f.length, true);
      try {
        for (let i = r[0]; i <= r[1]; i++) {
          if (!this.have.get(i)) continue;
          for (const s of this.layout.pieceSpans(i)) {
            if (s.file.index !== f.index) continue;
            const buf = Buffer.alloc(s.length);
            await parts.fh.read(buf, 0, s.length, f.offset + s.fileOffset);
            await (dest as Handle).fh.write(buf, 0, s.length, s.fileOffset);
          }
        }
      } finally {
        this.release(dest as Handle);
      }
    } finally {
      this.release(parts);
    }
    await this.maybeFinalize(f.index);
  }

  // ---- re-check and resume -------------------------------------------------------------------

  /** Hashes every piece with data on disk and rebuilds `have`. */
  async recheck(onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<Bitfield> {
    const total = this.layout.pieceCount;
    this.cache.clear();
    this.cacheSize = 0;
    // Files may exist under either name (finished or still carrying the incomplete suffix).
    for (const f of this.torrent.files) {
      if (!this.opts.incompleteExtension || f.padding) continue;
      this.finalized[f.index] = await exists(this.filePath(f, true));
    }
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw new TorrentEngineError('aborted', 're-check aborted');
      this.have.set(i, false);
      await this.verifyPiece(i);
      if (onProgress && (i % 16 === 0 || i === total - 1)) onProgress(i + 1, total);
    }
    return this.have;
  }

  /** Current size/mtime per file (null when the file has no data on disk). */
  async fileStats(): Promise<({ size: number; mtimeMs: number } | null)[]> {
    const out: ({ size: number; mtimeMs: number } | null)[] = [];
    for (const f of this.torrent.files) {
      if (f.padding || this.location[f.index] !== 'file') {
        out.push(null);
        continue;
      }
      const s = (await statOrNull(this.filePath(f, true))) ?? (await statOrNull(this.filePath(f, false)));
      out.push(s ? { size: s.size, mtimeMs: Math.floor(s.mtimeMs) } : null);
    }
    return out;
  }

  /**
   * Trusts a saved bitfield when the files on disk still match the saved sizes and mtimes;
   * returns false (caller should re-check) otherwise.
   */
  async tryResume(bitfield: Buffer, saved: ({ size: number; mtimeMs: number } | null)[]): Promise<boolean> {
    const current = await this.fileStats();
    const bf = new Bitfield(this.layout.pieceCount, bitfield);
    // Files written to after the save (the process stopped before saving again): the saved
    // bitfield is still a subset of what is on disk, so it is kept, and a few of the file's
    // pieces are re-hashed as a spot check. A file that was already complete must not change.
    const touched: number[] = [];
    for (let i = 0; i < current.length; i++) {
      const a = saved[i] ?? null;
      const b = current[i] ?? null;
      if (a === null && b === null) continue;
      if (a === null || b === null || a.size !== b.size) return false;
      const drift = b.mtimeMs - a.mtimeMs;
      if (Math.abs(drift) <= 2000) continue;
      if (drift < 0 || this.fileComplete(i, bf)) return false;
      touched.push(i);
    }
    for (let i = 0; i < bf.length; i++) this.have.set(i, bf.get(i));
    for (const fileIndex of touched) {
      for (const piece of this.spotCheckPieces(fileIndex, bf)) {
        if (!(await this.verifyPiece(piece))) {
          for (let i = 0; i < this.have.length; i++) this.have.set(i, false);
          return false;
        }
      }
    }
    for (const f of this.torrent.files) {
      if (this.opts.incompleteExtension && !f.padding) this.finalized[f.index] = await exists(this.filePath(f, true));
    }
    return true;
  }

  private fileComplete(fileIndex: number, bf: Bitfield): boolean {
    const range = this.layout.pieceRange(fileIndex);
    if (!range) return true;
    for (let p = range[0]; p <= range[1]; p++) if (!bf.get(p)) return false;
    return true;
  }

  /** Up to RESUME_SPOT_CHECKS pieces of a file the bitfield claims, spread across the file. */
  private spotCheckPieces(fileIndex: number, bf: Bitfield): number[] {
    const range = this.layout.pieceRange(fileIndex);
    if (!range) return [];
    const have: number[] = [];
    for (let p = range[0]; p <= range[1]; p++) if (bf.get(p)) have.push(p);
    if (have.length <= RESUME_SPOT_CHECKS) return have;
    const step = have.length / RESUME_SPOT_CHECKS;
    return Array.from({ length: RESUME_SPOT_CHECKS }, (_, k) => have[Math.floor(k * step)]!);
  }

  // ---- move and delete -----------------------------------------------------------------------

  /** Moves all payload files (and the parts file) under `newSavePath`. */
  async move(newSavePath: string): Promise<void> {
    if (newSavePath === this.savePathValue) return;
    await this.closeFiles();
    const oldRoot = this.savePathValue;
    const moves: [string, string][] = [];
    for (const f of this.torrent.files) {
      if (f.padding) continue;
      for (const final of [true, false]) {
        const from = this.filePath(f, final);
        this.savePathValue = newSavePath;
        const to = this.filePath(f, final);
        this.savePathValue = oldRoot;
        if (!moves.some(([m]) => m === from) && (await exists(from))) moves.push([from, to]);
      }
    }
    const oldParts = this.partsPath;
    this.savePathValue = newSavePath;
    if (await exists(oldParts)) moves.push([oldParts, this.partsPath]);
    this.savePathValue = oldRoot;
    for (const [from, to] of moves) await moveFile(from, to);
    if (this.torrent.isMultiFile) await removeEmptyDirs(join(oldRoot, this.torrent.name));
    this.savePathValue = newSavePath;
  }

  /** Deletes payload files, the parts file and empty directories. */
  async deleteFiles(): Promise<void> {
    await this.closeFiles();
    for (const f of this.torrent.files) {
      if (f.padding) continue;
      await rm(this.filePath(f, true), { force: true });
      if (this.opts.incompleteExtension) await rm(this.filePath(f, false), { force: true });
    }
    await rm(this.partsPath, { force: true });
    if (this.torrent.isMultiFile) await removeEmptyDirs(join(this.savePathValue, this.torrent.name));
  }
}

async function statOrNull(p: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  return (await statOrNull(p)) !== null;
}

async function moveFile(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await copyFile(from, to);
    await unlink(from);
  }
}

/** Removes `dir` and its subdirectories when they contain no files. */
async function removeEmptyDirs(dir: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  let empty = true;
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!(await removeEmptyDirs(join(dir, e.name)))) empty = false;
    } else empty = false;
  }
  if (empty) await rmdir(dir).catch(() => {});
  return empty;
}

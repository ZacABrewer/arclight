import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ImportFileError, RecycleBin, deleteEmptyFolders, importExtraFiles, parseMode, transferFile } from './mover.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mt-mover-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function file(rel: string, content = 'data'): Promise<string> {
  const full = join(tmp, rel);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content);
  return full;
}

const exists = (p: string) => stat(p).then(() => true, () => false);

describe('transferFile', () => {
  it('moves and creates parent folders', async () => {
    const src = await file('dl/a.mkv', 'abc');
    const dst = join(tmp, 'lib', 'Show', 'Season 1', 'a.mkv');
    expect(await transferFile(src, dst, 'move')).toBe('move');
    expect(await exists(src)).toBe(false);
    expect(await readFile(dst, 'utf8')).toBe('abc');
  });

  it('copies, keeping the source', async () => {
    const src = await file('dl/a.mkv', 'abc');
    const dst = join(tmp, 'lib', 'a.mkv');
    expect(await transferFile(src, dst, 'copy')).toBe('copy');
    expect(await exists(src)).toBe(true);
    expect(await readFile(dst, 'utf8')).toBe('abc');
  });

  it('hard-links when possible', async () => {
    const src = await file('dl/a.mkv', 'abc');
    const dst = join(tmp, 'lib', 'a.mkv');
    expect(await transferFile(src, dst, 'hardlinkOrCopy')).toBe('hardlink');
    expect((await stat(dst)).nlink).toBeGreaterThanOrEqual(2);
  });

  it('falls back to copy when the hard link fails', async () => {
    const src = await file('dl/a.mkv', 'abc');
    const dst = join(tmp, 'lib', 'a.mkv');
    const ops = { link: async () => Promise.reject(Object.assign(new Error('cross-device'), { code: 'EXDEV' })) };
    expect(await transferFile(src, dst, 'hardlinkOrCopy', { ops })).toBe('copy');
    await expect(transferFile(src, join(tmp, 'lib', 'b.mkv'), 'hardlink', { ops })).rejects.toMatchObject({ code: 'HARDLINK_FAILED' });
  });

  it('copies under a temporary name, reports progress and leaves no partial file', async () => {
    const src = await file('dl/a.mkv', 'abcdef');
    const dst = join(tmp, 'lib', 'a.mkv');
    const progress: Array<[number, number]> = [];
    const ops = { link: async () => Promise.reject(Object.assign(new Error('cross-device'), { code: 'EXDEV' })) };
    expect(await transferFile(src, dst, 'hardlinkOrCopy', { ops, onProgress: (c, t) => progress.push([c, t]) })).toBe('copy');
    expect(progress.at(-1)).toEqual([6, 6]);
    expect(await readdir(join(tmp, 'lib'))).toEqual(['a.mkv']);
  });

  it('hard links report no copy progress', async () => {
    const src = await file('dl/a.mkv', 'abc');
    const progress: number[] = [];
    expect(await transferFile(src, join(tmp, 'lib', 'a.mkv'), 'hardlinkOrCopy', { onProgress: (c) => progress.push(c) })).toBe('hardlink');
    expect(progress).toEqual([]);
  });

  it('falls back to verified copy + delete on a cross-device move', async () => {
    const src = await file('dl/a.mkv', 'abcdef');
    const dst = join(tmp, 'lib', 'a.mkv');
    const ops = { rename: async () => Promise.reject(Object.assign(new Error('xdev'), { code: 'EXDEV' })) };
    expect(await transferFile(src, dst, 'move', { ops })).toBe('move');
    expect(await exists(src)).toBe(false);
    expect((await stat(dst)).size).toBe(6);
  });

  it('refuses an existing destination, the same file and a missing source', async () => {
    const src = await file('dl/a.mkv');
    const dst = await file('lib/a.mkv');
    await expect(transferFile(src, dst, 'copy')).rejects.toMatchObject({ code: 'DESTINATION_EXISTS' });
    await expect(transferFile(src, src, 'move')).rejects.toMatchObject({ code: 'SAME_FILE' });
    await expect(transferFile(join(tmp, 'none.mkv'), dst, 'move')).rejects.toBeInstanceOf(ImportFileError);
    expect(await transferFile(src, dst, 'copy', { overwrite: true })).toBe('copy');
  });

  it('derives file modes from the folder mode', () => {
    expect(parseMode('755')).toEqual({ folder: 0o755, file: 0o644 });
    expect(parseMode('775')).toEqual({ folder: 0o775, file: 0o664 });
  });
});

describe('RecycleBin', () => {
  it('moves into the bin with a sub-folder, suffixes clashes and stamps the time', async () => {
    const now = new Date('2030-01-01T00:00:00Z');
    const bin = new RecycleBin(join(tmp, 'bin'), () => now);
    const a = await file('lib/Show/Season 1/ep.mkv', '1');
    const first = await bin.recycle(a, join('Show', 'Season 1'));
    expect(first).toBe(join(tmp, 'bin', 'Show', 'Season 1', 'ep.mkv'));
    expect((await stat(first!)).mtime.toISOString()).toBe(now.toISOString());
    const b = await file('lib/Show/Season 1/ep.mkv', '2');
    expect(await bin.recycle(b, join('Show', 'Season 1'))).toBe(join(tmp, 'bin', 'Show', 'Season 1', 'ep_2.mkv'));
  });

  it('deletes permanently without a bin path', async () => {
    const a = await file('lib/ep.mkv');
    expect(await new RecycleBin(undefined).recycle(a)).toBeNull();
    expect(await exists(a)).toBe(false);
  });

  it('cleans up old files and empty folders', async () => {
    const now = new Date();
    const bin = new RecycleBin(join(tmp, 'bin'), () => now);
    const old = await file('bin/Show/old.mkv');
    const fresh = await file('bin/Other/new.mkv');
    const past = new Date(now.getTime() - 10 * 24 * 3600 * 1000);
    await utimes(old, past, past);
    const r = await bin.cleanup(7);
    expect(r.deletedFiles).toBe(1);
    expect(await exists(join(tmp, 'bin', 'Show'))).toBe(false);
    expect(await exists(fresh)).toBe(true);
    expect((await bin.cleanup(0)).deletedFiles).toBe(0);
  });
});

describe('deleteEmptyFolders', () => {
  it('removes nested empty folders but keeps the root and non-empty ones', async () => {
    await mkdir(join(tmp, 'root', 'a', 'b', 'c'), { recursive: true });
    await file('root/keep/file.txt');
    expect(await deleteEmptyFolders(join(tmp, 'root'))).toBe(3);
    expect((await readdir(join(tmp, 'root'))).sort()).toEqual(['keep']);
  });
});

describe('importExtraFiles', () => {
  it('renames matching subtitles and nfo alongside the video', async () => {
    const video = await file('dl/Show.S01E01.720p.mkv', 'v');
    await file('dl/Show.S01E01.720p.en.srt');
    await file('dl/Show.S01E01.720p.nfo');
    await file('dl/other.jpg');
    const dst = join(tmp, 'lib', 'Show - S01E01.mkv');
    const out = await importExtraFiles(video, dst, { extensions: ['srt', 'nfo'], recursive: false, mode: 'copy' });
    expect(out.sort()).toEqual([join(tmp, 'lib', 'Show - S01E01.en.srt'), join(tmp, 'lib', 'Show - S01E01.nfo')].sort());
  });

  it('falls back to all subtitles when the folder holds one video', async () => {
    const video = await file('dl/abc123.mkv', 'v');
    await file('dl/Subs/English.eng.srt');
    const dst = join(tmp, 'lib', 'Movie (2020).mkv');
    const out = await importExtraFiles(video, dst, { extensions: ['srt'], recursive: true, mode: 'move' });
    expect(out).toEqual([join(tmp, 'lib', 'Movie (2020).eng.srt')]);
  });
});

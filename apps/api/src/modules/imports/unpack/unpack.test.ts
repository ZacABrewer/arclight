import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { findArchiveSets, isUnpackableArchive } from './archives.js';
import { classifyFailure, findSevenZip, parseProgress, parseSltListing, SevenZip, type Runner } from './sevenzip.js';
import { stagingDirFor, STAGING_FOLDER, UnpackError, unpackArchives } from './unpacker.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const MOVIE = 'Fixture.Movie.2020.1080p.mkv';

describe('findArchiveSets', () => {
  it('groups .partNN.rar volumes and starts on the first', () => {
    const sets = findArchiveSets(['/d/M.part02.rar', '/d/M.part01.rar', '/d/M.part03.rar', '/d/M.nfo']);
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ first: '/d/M.part01.rar', format: 'rar', volumes: ['/d/M.part01.rar', '/d/M.part02.rar', '/d/M.part03.rar'] });
  });

  it('groups old-style .rar + .r00 volumes with the .rar first', () => {
    const sets = findArchiveSets(['/d/m.r01', '/d/m.r00', '/d/m.rar']);
    expect(sets).toEqual([{ first: '/d/m.rar', volumes: ['/d/m.rar', '/d/m.r00', '/d/m.r01'], format: 'rar', name: 'm.rar' }]);
  });

  it('groups split 7z / zip volumes', () => {
    const sets = findArchiveSets(['/d/a.7z.002', '/d/a.7z.001', '/d/b.zip.001', '/d/b.zip.002']);
    expect(sets.map((s) => [s.first, s.format, s.volumes.length])).toEqual([
      ['/d/a.7z.001', '7z', 2],
      ['/d/b.zip.001', 'zip', 2],
    ]);
  });

  it('keeps single archives and separate folders apart', () => {
    const sets = findArchiveSets(['/d/E01/e.rar', '/d/E02/e.rar', '/d/x.zip', '/d/y.7z', '/d/movie.mkv']);
    expect(sets.map((s) => s.first)).toEqual(['/d/E01/e.rar', '/d/E02/e.rar', '/d/x.zip', '/d/y.7z']);
  });

  it('reports a set whose first volume is missing as incomplete', () => {
    expect(findArchiveSets(['/d/M.part02.rar', '/d/M.part03.rar'])[0]?.incomplete).toMatch(/M\.part1\.rar/);
    expect(findArchiveSets(['/d/m.r00', '/d/m.r01'])[0]?.incomplete).toMatch(/m\.rar/);
    expect(findArchiveSets(['/d/a.7z.002'])[0]?.incomplete).toMatch(/a\.7z\.001/);
  });

  it('recognises unpackable names', () => {
    for (const name of ['a.rar', 'a.part1.rar', 'a.r00', 'a.7z', 'a.7z.001', 'a.zip', 'a.zip.003']) expect(isUnpackableArchive(name)).toBe(true);
    for (const name of ['a.mkv', 'a.zipx', 'a.nfo', 'a.tar.gz']) expect(isUnpackableArchive(name)).toBe(false);
  });
});

describe('7-Zip output parsing', () => {
  it('parses an -slt listing', () => {
    const out = [
      '7-Zip 26.03', '', 'Listing archive: x.rar', '', '--', 'Path = x.rar', 'Type = Rar5', '', '----------',
      'Path = Movie.mkv', 'Folder = -', 'Size = 12288', 'Encrypted = +', '', 'Path = Subs', 'Folder = +', 'Size = 0', 'Encrypted = -', '',
    ].join('\r\n');
    expect(parseSltListing(out)).toEqual({
      type: 'Rar5',
      entries: [
        { path: 'Movie.mkv', sizeBytes: 12288, folder: false, encrypted: true },
        { path: 'Subs', sizeBytes: 0, folder: true, encrypted: false },
      ],
    });
  });

  it('reads the last percentage of a progress chunk', () => {
    expect(parseProgress('  0%\b\b\b\b 12% 1 - a.mkv\r 42%')).toBe(0.42);
    expect(parseProgress('Scanning')).toBeNull();
  });

  it('classifies failures', () => {
    expect(classifyFailure('ERROR: a.rar : Cannot open encrypted archive. Wrong password?')).toBe('encrypted');
    expect(classifyFailure('ERROR: Wrong password : Movie.mkv')).toBe('encrypted');
    expect(classifyFailure('ERROR = Missing volume : multi.part3.rar')).toBe('missingVolume');
    expect(classifyFailure('ERROR: Data Error : Movie.mkv\nUnexpected end of archive')).toBe('corrupt');
    expect(classifyFailure('Can not open the file as archive')).toBe('corrupt');
  });

  it('finds no binary when none runs, and honours ARCLIGHT_7ZIP', async () => {
    const missing: Runner = async () => {
      throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    };
    expect(await findSevenZip({ runner: missing, env: {} })).toBeNull();
    const seen: string[] = [];
    const ok: Runner = async (bin) => {
      seen.push(bin);
      return { code: 0, stdout: '7-Zip (z) 26.03 (x64)', stderr: '' };
    };
    expect(await findSevenZip({ runner: ok, env: { ARCLIGHT_7ZIP: '/opt/7zz' } })).toBe('/opt/7zz');
    expect(seen).toEqual(['/opt/7zz']);
  });
});

describe('stagingDirFor', () => {
  it('puts staging next to the download, never inside it', () => {
    expect(stagingDirFor(join('/dl', 'Movie.2020'), false)).toBe(join('/dl', STAGING_FOLDER, 'Movie.2020'));
    expect(stagingDirFor(join('/dl', 'movie.rar'), true)).toBe(join('/dl', STAGING_FOLDER, 'movie'));
  });
});

// Real extraction with the fixtures; skipped when no 7-Zip binary is installed.
let binary: string | null = null;
beforeAll(async () => {
  binary = await findSevenZip({ refresh: true });
});

describe('unpackArchives (real 7-Zip)', () => {
  let work: string | undefined;
  afterEach(async () => {
    if (work) await rm(work, { recursive: true, force: true });
    work = undefined;
  });

  async function download(...names: string[]): Promise<{ root: string; files: string[]; staging: string }> {
    work = await mkdtemp(join(tmpdir(), 'arclight-unpack-'));
    const root = join(work, 'Fixture.Movie.2020.1080p');
    await mkdir(root);
    const files: string[] = [];
    for (const n of names) {
      await copyFile(join(FIXTURES, n), join(root, n));
      files.push(join(root, n));
    }
    return { root, files, staging: stagingDirFor(root, false) };
  }

  const options = (sevenZip: SevenZip, progress?: number[]) => ({
    sevenZip,
    freeSpace: async () => 100 * 1024 ** 3,
    minimumFreeBytes: 0,
    ...(progress ? { onProgress: (f: number) => progress.push(f) } : {}),
  });

  async function expectMovie(staging: string): Promise<void> {
    const expected = (await readFile(join(FIXTURES, 'expected.sha256'), 'utf8')).trim().split(/\s+/)[0];
    const data = await readFile(join(staging, MOVIE));
    expect(createHash('sha256').update(data).digest('hex')).toBe(expected);
  }

  for (const fixture of [['single.rar'], ['single.7z'], ['single.zip'], ['multi.part1.rar', 'multi.part2.rar', 'multi.part3.rar'], ['split.7z.001', 'split.7z.002', 'split.7z.003']]) {
    it(`extracts ${fixture[0]}`, async (ctx) => {
      if (!binary) return ctx.skip();
      const d = await download(...fixture);
      const progress: number[] = [];
      const result = await unpackArchives(d.root, d.files, d.staging, options(new SevenZip(binary), progress));
      await expectMovie(d.staging);
      expect(result.files.map((f) => basename(f))).toContain(MOVIE);
      expect(progress.at(-1)).toBe(1);
      // The originals stay in place (a torrent keeps seeding them).
      expect((await readdir(d.root)).sort()).toEqual([...fixture].sort());
    });
  }

  it('extracts a nested archive once and removes the inner copy', async (ctx) => {
    if (!binary) return ctx.skip();
    const d = await download('nested.zip');
    const result = await unpackArchives(d.root, d.files, d.staging, options(new SevenZip(binary)));
    await expectMovie(d.staging);
    expect(result.sets).toBe(2);
    expect(result.files.map((f) => basename(f))).not.toContain('inner.rar');
  });

  for (const fixture of ['password.rar', 'password-headers.rar', 'password.7z', 'password.zip']) {
    it(`detects the password on ${fixture}`, async (ctx) => {
      if (!binary) return ctx.skip();
      const d = await download(fixture);
      const err = await unpackArchives(d.root, d.files, d.staging, options(new SevenZip(binary))).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnpackError);
      expect((err as UnpackError).kind).toBe('encrypted');
      expect((err as UnpackError).rejectsRelease).toBe(true);
      expect((err as UnpackError).message).toMatch(/password-protected/);
    });
  }

  it('reports a missing volume', async (ctx) => {
    if (!binary) return ctx.skip();
    const d = await download('multi.part1.rar', 'multi.part2.rar');
    const err = (await unpackArchives(d.root, d.files, d.staging, options(new SevenZip(binary))).catch((e: unknown) => e)) as UnpackError;
    expect(err.kind).toBe('missingVolume');
    expect(err.rejectsRelease).toBe(true);
  });

  it('reports a damaged archive and leaves no staging behind', async (ctx) => {
    if (!binary) return ctx.skip();
    const d = await download('corrupt.rar');
    const err = (await unpackArchives(d.root, d.files, d.staging, options(new SevenZip(binary))).catch((e: unknown) => e)) as UnpackError;
    expect(err).toBeInstanceOf(UnpackError);
    expect(['corrupt', 'missingVolume']).toContain(err.kind);
    await expect(readdir(d.staging)).rejects.toThrow();
  });

  it('refuses to unpack when the volume would drop below the minimum free space', async (ctx) => {
    if (!binary) return ctx.skip();
    const d = await download('single.rar');
    const err = (await unpackArchives(d.root, d.files, d.staging, {
      sevenZip: new SevenZip(binary),
      freeSpace: async () => 20_000,
      minimumFreeBytes: 10_000,
    }).catch((e: unknown) => e)) as UnpackError;
    expect(err.kind).toBe('diskSpace');
    expect(err.rejectsRelease).toBe(false);
  });
});

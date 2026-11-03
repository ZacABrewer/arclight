import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeSevenZip, parseSevenZipVersion, parseSltListing, SevenZip, type ArchiveListing, type Runner, type SevenZipInfo } from './sevenzip.js';
import { MAX_ENTRIES, stagingDirFor, STAGING_FOLDER, UnpackError, unpackArchives } from './unpacker.js';

// Decompression-bomb caps, nested disk checks and link safety with a fake 7-Zip: no binary needed.

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

interface FakeArchive {
  listing: ArchiveListing;
  /** Files the fake writes into the output folder on extract (name -> content). */
  writes?: Record<string, string>;
}

class FakeSevenZip {
  readonly extracted: string[] = [];
  constructor(
    private readonly archives: Record<string, FakeArchive>,
    readonly info: SevenZipInfo | null = { version: '26.03', linkSafe: true, snldSwitch: true },
  ) {}
  async list(archive: string): Promise<ArchiveListing> {
    const a = this.archives[nameOf(archive)];
    if (!a) throw new Error(`no fake for ${archive}`);
    return a.listing;
  }
  async extract(archive: string, outDir: string): Promise<void> {
    const name = nameOf(archive);
    this.extracted.push(name);
    await mkdir(outDir, { recursive: true });
    for (const [file, content] of Object.entries(this.archives[name]?.writes ?? {})) await writeFile(join(outDir, file), content);
  }
}

const nameOf = (path: string): string => path.split(/[\\/]/).at(-1)!;

const entry = (path: string, sizeBytes: number, extra: Partial<ArchiveListing['entries'][number]> = {}) => ({
  path,
  sizeBytes,
  folder: false,
  encrypted: false,
  ...extra,
});

let work: string | undefined;
afterEach(async () => {
  if (work) await rm(work, { recursive: true, force: true });
  work = undefined;
});

async function download(files: Record<string, number>): Promise<{ root: string; paths: string[]; staging: string }> {
  work = await mkdtemp(join(tmpdir(), 'arclight-bomb-'));
  const root = join(work, 'Some.Release');
  await mkdir(root);
  const paths: string[] = [];
  for (const [name, size] of Object.entries(files)) {
    await writeFile(join(root, name), Buffer.alloc(size));
    paths.push(join(root, name));
  }
  return { root, paths, staging: stagingDirFor(root, false) };
}

const opts = (sevenZip: FakeSevenZip, free = 1000 * GiB) => ({
  sevenZip: sevenZip as unknown as SevenZip,
  freeSpace: async () => free,
  minimumFreeBytes: 0,
});

describe('nested archives (DATA-10)', () => {
  it('checks free space for nested archives before extracting them', async () => {
    const d = await download({ 'outer.zip': MiB });
    const fake = new FakeSevenZip({
      'outer.zip': { listing: { type: 'zip', entries: [entry('inner.zip', 1024)] }, writes: { 'inner.zip': 'x'.repeat(1024) } },
      'inner.zip': { listing: { type: 'zip', entries: [entry('Movie.mkv', 200 * MiB)] } },
    });
    const err = (await unpackArchives(d.root, d.paths, d.staging, opts(fake, 100 * MiB)).catch((e: unknown) => e)) as UnpackError;
    expect(err).toBeInstanceOf(UnpackError);
    expect(err.kind).toBe('diskSpace');
    expect(err.rejectsRelease).toBe(false);
    expect(fake.extracted).toEqual(['outer.zip']);
    await expect(readdir(d.staging)).rejects.toThrow();
  });

  it('rejects a nested archive that lists terabytes, extracting nothing from it', async () => {
    const d = await download({ 'outer.rar': MiB });
    const fake = new FakeSevenZip({
      'outer.rar': { listing: { type: 'rar', entries: [entry('inner.zip', 4096)] }, writes: { 'inner.zip': 'x'.repeat(4096) } },
      'inner.zip': { listing: { type: 'zip', entries: [entry('a.bin', 4 * 1024 * GiB)] } },
    });
    const err = (await unpackArchives(d.root, d.paths, d.staging, opts(fake, 100_000 * GiB)).catch((e: unknown) => e)) as UnpackError;
    expect(err.kind).toBe('tooLarge');
    expect(err.rejectsRelease).toBe(true);
    expect(fake.extracted).toEqual(['outer.rar']);
    await expect(readdir(d.staging)).rejects.toThrow();
  });

  it('caps the total of all nested sets against the download size', async () => {
    // Each inner set alone passes its ratio check (slack covers it), together they are far
    // beyond 20x the 1 MiB download.
    const inner = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`in${i}.zip`, { listing: { type: 'zip', entries: [entry('a.bin', 200 * MiB)] } }]));
    const writes = Object.fromEntries(Object.keys(inner).map((n) => [n, 'x']));
    const d = await download({ 'outer.zip': MiB });
    const fake = new FakeSevenZip({
      'outer.zip': { listing: { type: 'zip', entries: Object.keys(inner).map((n) => entry(n, 1)) }, writes },
      ...inner,
    });
    const err = (await unpackArchives(d.root, d.paths, d.staging, opts(fake)).catch((e: unknown) => e)) as UnpackError;
    expect(err.kind).toBe('tooLarge');
    expect(fake.extracted).toEqual(['outer.zip']);
  });

  it('rejects a first-level archive whose listing is far larger than the archive', async () => {
    const d = await download({ 'bomb.zip': 10 * 1024 });
    const fake = new FakeSevenZip({ 'bomb.zip': { listing: { type: 'zip', entries: [entry('a.bin', 50 * GiB)] } } });
    const err = (await unpackArchives(d.root, d.paths, d.staging, opts(fake)).catch((e: unknown) => e)) as UnpackError;
    expect(err.kind).toBe('tooLarge');
    expect(fake.extracted).toEqual([]);
  });

  it('rejects an archive with too many entries', async () => {
    const d = await download({ 'many.zip': 1024 });
    const entries = Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => entry(`f${i}`, 0));
    const fake = new FakeSevenZip({ 'many.zip': { listing: { type: 'zip', entries } } });
    const err = (await unpackArchives(d.root, d.paths, d.staging, opts(fake)).catch((e: unknown) => e)) as UnpackError;
    expect(err.kind).toBe('tooLarge');
    expect(fake.extracted).toEqual([]);
  });

  it('still unpacks an ordinary archive and its nested set', async () => {
    const d = await download({ 'outer.zip': 2048 });
    const fake = new FakeSevenZip({
      'outer.zip': { listing: { type: 'zip', entries: [entry('inner.rar', 2000)] }, writes: { 'inner.rar': 'x'.repeat(2000) } },
      'inner.rar': { listing: { type: 'rar', entries: [entry('Movie.mkv', 1990)] }, writes: { 'Movie.mkv': 'm' } },
    });
    const result = await unpackArchives(d.root, d.paths, d.staging, opts(fake));
    expect(result.sets).toBe(2);
    expect(fake.extracted).toEqual(['outer.zip', 'inner.rar']);
  });
});

describe('7-Zip version and links (DATA-33)', () => {
  it('parses the version from 7-Zip, 7zz and p7zip banners', () => {
    expect(parseSevenZipVersion('7-Zip (z) 26.03 (x64) : Copyright (c) 1999-2026 Igor Pavlov')).toMatchObject({ major: 26, minor: 3, text: '26.03' });
    expect(parseSevenZipVersion('\r\n7-Zip 24.09 (x64) : Copyright (c) 1999-2024 Igor Pavlov')).toMatchObject({ major: 24, text: '24.09' });
    expect(parseSevenZipVersion('7-Zip [64] 16.02 : Copyright (c) 1999-2016 Igor Pavlov')).toMatchObject({ major: 16, minor: 2 });
    expect(parseSevenZipVersion('7-Zip (a) 25.00 (arm64)')).toMatchObject({ major: 25, minor: 0 });
    expect(parseSevenZipVersion('something else')).toBeNull();
  });

  it('marks 25.00+ as link-safe and probes -snld- support', async () => {
    const runner =
      (banner: string, knowsSnld: boolean): Runner =>
      async (_bin, args) =>
        args[0] === 'i'
          ? { code: 0, stdout: banner, stderr: '' }
          : knowsSnld
            ? { code: 2, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' }
            : { code: 7, stdout: 'Command Line Error:\nUnknown switch:\n-snld-', stderr: '' };
    expect(await describeSevenZip('7zz', runner('7-Zip (z) 26.03 (x64)', true))).toEqual({ version: '26.03', linkSafe: true, snldSwitch: true });
    expect(await describeSevenZip('7z', runner('7-Zip 24.09 (x64)', true))).toEqual({ version: '24.09', linkSafe: false, snldSwitch: true });
    expect(await describeSevenZip('7za', runner('7-Zip [64] 16.02', false))).toEqual({ version: '16.02', linkSafe: false, snldSwitch: false });
  });

  it('passes -snld- on extraction only when the binary accepts it', async () => {
    const calls: (readonly string[])[] = [];
    const runner: Runner = async (_bin, args) => {
      calls.push(args);
      return { code: 0, stdout: '', stderr: '' };
    };
    await new SevenZip('7zz', runner, 1000, { version: '26.03', linkSafe: true, snldSwitch: true }).extract('/a.rar', '/out');
    await new SevenZip('7za', runner, 1000, { version: '16.02', linkSafe: false, snldSwitch: false }).extract('/a.rar', '/out');
    expect(calls[0]).toContain('-snld-');
    expect(calls[0]!.indexOf('-snld-')).toBeLessThan(calls[0]!.indexOf('--'));
    expect(calls[1]).not.toContain('-snld-');
  });

  it('reads links from a -slt listing', () => {
    const out = [
      'Type = zip', '', '----------',
      'Path = link', 'Attributes = _ lrwxrwxrwx', 'Size = 4', '',
      'Path = real.mkv', 'Attributes = A_ -rw-r--r--', 'Size = 9', '',
      'Path = t', 'Symbolic Link = /etc', 'Size = 0', '',
    ].join('\n');
    expect(parseSltListing(out).entries.map((e) => [e.path, e.link === true])).toEqual([
      ['link', true],
      ['real.mkv', false],
      ['t', true],
    ]);
  });

  it('refuses archives with links on an old 7-Zip, but unpacks them on 25.00+', async () => {
    const listing = { type: 'tar', entries: [entry('evil', 0, { link: true }), entry('Movie.mkv', 10)] };
    const d = await download({ 'x.zip': 1024 });
    const old = new FakeSevenZip({ 'x.zip': { listing } }, { version: '16.02', linkSafe: false, snldSwitch: false });
    const err = (await unpackArchives(d.root, d.paths, d.staging, opts(old)).catch((e: unknown) => e)) as UnpackError;
    expect(err.kind).toBe('links');
    expect(err.rejectsRelease).toBe(true);
    expect(err.message).toMatch(/16\.02/);
    expect(old.extracted).toEqual([]);
    const current = new FakeSevenZip({ 'x.zip': { listing } });
    await unpackArchives(d.root, d.paths, d.staging, opts(current));
    expect(current.extracted).toEqual(['x.zip']);
  });
});

describe('stagingDirFor (DATA-54)', () => {
  it('never resolves to the shared staging folder or the downloads folder', () => {
    const dl = join('/dl');
    expect(stagingDirFor(join(dl, 'x') + '/..', false)).toBe(join(dl, 'x', STAGING_FOLDER, '__'));
    expect(stagingDirFor(join(dl, 'x') + '/.', false)).toBe(join(dl, 'x', STAGING_FOLDER, '_'));
    expect(stagingDirFor(join(dl, '.rar'), true)).not.toBe(join(dl, STAGING_FOLDER));
    expect(stagingDirFor(join(dl, 'Movie: Part 1'), false)).toBe(join(dl, STAGING_FOLDER, 'Movie_ Part 1'));
  });
});

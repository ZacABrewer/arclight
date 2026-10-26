import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ScanError,
  detectSample,
  isArchive,
  isSampleByName,
  isUnpacking,
  minimumRuntimeSeconds,
  parseFfprobeJson,
  qualityForExtension,
  scanPath,
  shouldDeleteFolder,
} from './scan.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mt-scan-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function touch(rel: string, size = 10): Promise<string> {
  const full = join(tmp, rel);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, Buffer.alloc(size));
  return full;
}

describe('scanPath', () => {
  it('classifies videos, archives, dangerous, executables and others recursively', async () => {
    await touch('Rel/Show.S01E01.mkv', 100);
    await touch('Rel/Sub/Show.S01E02.mp4', 50);
    await touch('Rel/show.rar', 5);
    await touch('Rel/show.r01', 5);
    await touch('Rel/readme.nfo');
    await touch('Rel/virus.scr');
    await touch('Rel/setup.exe');
    const r = await scanPath(join(tmp, 'Rel'));
    expect(r.isFile).toBe(false);
    expect(r.videos.map((v) => v.name).sort()).toEqual(['Show.S01E01.mkv', 'Show.S01E02.mp4']);
    expect(r.archives.map((a) => a.name).sort()).toEqual(['show.r01', 'show.rar']);
    expect(r.dangerous.map((d) => d.name)).toEqual(['virus.scr']);
    expect(r.executables.map((d) => d.name)).toEqual(['setup.exe']);
    expect(r.others.map((d) => d.name)).toEqual(['readme.nfo']);
    expect(r.videos.find((v) => v.name === 'Show.S01E02.mp4')!.relativePath).toBe(join('Sub', 'Show.S01E02.mp4'));
  });

  it('skips excluded folders/files and extras', async () => {
    await touch('Rel/movie.mkv');
    await touch('Rel/@eaDir/thumb.mkv');
    await touch('Rel/.hidden/x.mkv');
    await touch('Rel/._movie.mkv');
    await touch('Rel/Featurettes/making.mkv');
    await touch('Rel/movie-trailer.mkv');
    const r = await scanPath(join(tmp, 'Rel'));
    expect(r.videos.map((v) => v.name)).toEqual(['movie.mkv']);
    const unfiltered = await scanPath(join(tmp, 'Rel'), { filterExtras: false });
    expect(unfiltered.videos.map((v) => v.name).sort()).toEqual(['making.mkv', 'movie-trailer.mkv', 'movie.mkv']);
  });

  it('scans a single file', async () => {
    const f = await touch('Show.S01E01.mkv', 42);
    const r = await scanPath(f);
    expect(r.isFile).toBe(true);
    expect(r.videos).toHaveLength(1);
    expect(r.videos[0]!.sizeBytes).toBe(42);
  });

  it('detects an unpack in progress from a working folder', async () => {
    await touch('Rel/_UNPACK_Show/Show.S01E01.mkv');
    await touch('Rel/show.rar');
    const r = await scanPath(join(tmp, 'Rel'));
    expect(r.unpacking).toBe(true);
    expect((await scanPath(join(tmp, 'Rel'), { workingFolders: ['_TMP_'] })).unpacking).toBe(false);
  });

  it('throws ScanError for a missing path', async () => {
    await expect(scanPath(join(tmp, 'nope'))).rejects.toBeInstanceOf(ScanError);
  });
});

describe('samples', () => {
  it('detects samples by name and folder', () => {
    expect(isSampleByName('/d/Show.S01E01.sample.mkv')).toBe(true);
    expect(isSampleByName('/d/sample-show.mkv')).toBe(true);
    expect(isSampleByName('/d/Sample/show.mkv')).toBe(true);
    expect(isSampleByName('/d/Samplers.S01E01.mkv')).toBe(false);
  });

  it('maps expected runtime to the minimum runtime table', () => {
    expect(minimumRuntimeSeconds(3)).toBe(15);
    expect(minimumRuntimeSeconds(10)).toBe(90);
    expect(minimumRuntimeSeconds(30)).toBe(300);
    expect(minimumRuntimeSeconds(44)).toBe(600);
  });

  it('applies the runtime rule only when probed (spec 8 worked example)', () => {
    const base = { path: '/d/Show.S01E01E02.mkv', mediaType: 'series' as const, seasonNumber: 1, existingFile: false, expectedRuntimeMinutes: 44 };
    expect(detectSample({ ...base, runtimeSeconds: 540 })).toBe('sample');
    expect(detectSample({ ...base, runtimeSeconds: 41 * 60 })).toBe('notSample');
    expect(detectSample({ ...base, runtimeSeconds: 0 })).toBe('sample');
    expect(detectSample({ ...base, runtimeSeconds: null })).toBe('indeterminate');
    expect(detectSample({ ...base, runtimeSeconds: undefined })).toBe('notSample');
  });

  it('exempts specials, existing files and some extensions', () => {
    const base = { mediaType: 'series' as const, existingFile: false, runtimeSeconds: 5 };
    expect(detectSample({ ...base, path: '/d/a.mkv', seasonNumber: 0 })).toBe('notSample');
    expect(detectSample({ ...base, path: '/d/a.strm', seasonNumber: 1 })).toBe('notSample');
    expect(detectSample({ ...base, path: '/d/a.mkv', seasonNumber: 1, existingFile: true })).toBe('notSample');
    expect(detectSample({ ...base, path: '/d/a.iso', mediaType: 'movie' })).toBe('notSample');
  });
});

describe('helpers', () => {
  it('detects unpacking per platform', () => {
    const now = Date.now();
    const file = { path: join('/dl', '_UNPACK_x', 'a.mkv'), mtimeMs: now - 10 * 60 * 1000 };
    expect(isUnpacking(file, ['_UNPACK_'], 'linux', now)).toBe(true);
    expect(isUnpacking(file, ['_UNPACK_'], 'win32', now)).toBe(false);
    expect(isUnpacking({ ...file, mtimeMs: now }, ['_UNPACK_'], 'win32', now)).toBe(true);
    expect(isUnpacking({ path: join('/dl', 'x', 'a.mkv'), mtimeMs: now }, ['_UNPACK_'], 'linux', now)).toBe(false);
  });

  it('recognises archives and extension qualities', () => {
    expect(isArchive('a.tar.gz')).toBe(true);
    expect(isArchive('a.r05')).toBe(true);
    expect(isArchive('a.mkv')).toBe(false);
    expect(qualityForExtension('.mkv').name).toBe('HDTV-720p');
    expect(qualityForExtension('.avi').name).toBe('SDTV');
    expect(qualityForExtension('.xyz').name).toBe('Unknown');
  });

  it('decides whether a source folder may be deleted', () => {
    const file = (name: string, extension: string, sizeBytes: number) => ({ path: name, relativePath: name, name, extension, sizeBytes, mtimeMs: 0 });
    const base = { root: '/x', isFile: false, dangerous: [], executables: [], others: [], unpacking: false };
    const sample = file('sample.mkv', '.mkv', 1);
    expect(shouldDeleteFolder({ ...base, videos: [sample], archives: [] }, () => true)).toBe(true);
    expect(shouldDeleteFolder({ ...base, videos: [sample], archives: [file('a.rar', '.rar', 3e9)] }, () => true)).toBe(false);
    expect(shouldDeleteFolder({ ...base, videos: [file('ep.mkv', '.mkv', 1)], archives: [] }, () => false)).toBe(false);
  });

  it('parses ffprobe output', () => {
    const r = parseFfprobeJson(
      JSON.stringify({ format: { duration: '1234.5' }, streams: [{ codec_type: 'video', codec_name: 'hevc', width: 1920, height: 1080 }, { codec_type: 'audio', codec_name: 'eac3', channels: 6 }] }),
    );
    expect(r).toMatchObject({ runtimeSeconds: 1235, audioStreams: 1, width: 1920, videoCodec: 'hevc', audioChannels: 6 });
  });
});

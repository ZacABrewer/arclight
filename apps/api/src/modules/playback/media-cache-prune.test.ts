import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cacheEntryKey, removeOtherStamps, sweepMediaCache } from './media-cache-prune.js';
import { MediaCache } from './video-stream.js';

const tmp = mkdtempSync(join(tmpdir(), 'arclight-media-cache-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function cacheWithFakeFfmpeg(dir: string): MediaCache {
  return new MediaCache({
    dir,
    locate: async () => '/fake/ffmpeg',
    sweepIntervalMs: 0,
    exec: async (_bin, args) => {
      writeFileSync(args.at(-1)!, 'WEBVTT\n');
      return { code: 0, stdout: '' };
    },
  });
}

describe('player media cache pruning', () => {
  it('parses entry keys', () => {
    expect(cacheEntryKey('f12-e0-1024-1700000000000.vtt')).toEqual({ key: 'f12-e0-', ext: '.vtt' });
    expect(cacheEntryKey('x5-10-20.vtt')).toEqual({ key: 'x5-', ext: '.vtt' });
    expect(cacheEntryKey('f12-10-20.jpg')).toEqual({ key: 'f12-', ext: '.jpg' });
    expect(cacheEntryKey('.123-abc.vtt')).toBeNull();
    expect(cacheEntryKey('readme')).toBeNull();
  });

  it('a rebuilt thumbnail replaces the copy made for the old version of the file', async () => {
    const dir = mkdtempSync(join(tmp, 'thumb-'));
    const video = join(dir, 'ep.mkv');
    writeFileSync(video, 'video');
    const other = join(dir, 'other.mkv');
    writeFileSync(other, 'video2');
    const cache = cacheWithFakeFfmpeg(join(dir, 'cache'));
    await cache.thumbnail(1, video, 60_000);
    await cache.thumbnail(12, other, 60_000);
    utimesSync(video, new Date(2020, 0, 1), new Date(2020, 0, 1));
    const second = await cache.thumbnail(1, video, 60_000);
    const files = readdirSync(join(dir, 'cache', 'thumbs')).sort();
    // f1 keeps only its new stamp; f12 (a different entry with a similar prefix) is untouched.
    expect(files.filter((f) => f.startsWith('f1-'))).toEqual([second.split(/[\\/]/).at(-1)]);
    expect(files.filter((f) => f.startsWith('f12-'))).toHaveLength(1);
  });

  it('a rebuilt subtitle conversion keeps other streams of the same file', async () => {
    const dir = mkdtempSync(join(tmp, 'subs-'));
    const subs = join(dir, 'subtitles');
    mkdirSync(subs);
    for (const n of ['f3-e0-1-1.vtt', 'f3-e0-2-2.vtt', 'f3-e1-1-1.vtt', 'f30-e0-1-1.vtt', 'x3-1-1.vtt']) writeFileSync(join(subs, n), 'x');
    expect(await removeOtherStamps(subs, 'f3-e0-2-2.vtt')).toBe(1);
    expect(readdirSync(subs).sort()).toEqual(['f3-e0-2-2.vtt', 'f3-e1-1-1.vtt', 'f30-e0-1-1.vtt', 'x3-1-1.vtt']);
  });

  it('the sweep removes the oldest entries over the size cap and stale temp files, and leaves trickplay alone', async () => {
    const root = mkdtempSync(join(tmp, 'sweep-'));
    for (const sub of ['subtitles', 'thumbs', 'trickplay']) mkdirSync(join(root, sub));
    const write = (sub: string, name: string, bytes: number, ageMin: number) => {
      const p = join(root, sub, name);
      writeFileSync(p, Buffer.alloc(bytes));
      const t = new Date(Date.now() - ageMin * 60_000);
      utimesSync(p, t, t);
    };
    write('thumbs', 'f1-1-1.jpg', 400, 30);
    write('thumbs', 'f2-1-1.jpg', 400, 20);
    write('subtitles', 'x1-1-1.vtt', 400, 10);
    write('subtitles', '.123-tmp.vtt', 10, 120);
    write('trickplay', 'big.bin', 5000, 999);
    const r = await sweepMediaCache(root, 900);
    expect(r.bytes).toBe(800);
    expect(readdirSync(join(root, 'thumbs'))).toEqual(['f2-1-1.jpg']);
    expect(readdirSync(join(root, 'subtitles'))).toEqual(['x1-1-1.vtt']);
    expect(readdirSync(join(root, 'trickplay'))).toEqual(['big.bin']);
  });
});

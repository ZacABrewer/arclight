import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { MediaInfo } from '@arclight/shared';
import { setSection } from '../settings/service.js';
import type { Db } from '../../db/index.js';
import { createTestDb, seedAdmin } from '../../db/test-utils.js';
import { backgroundServicesFor } from './index.js';
import { appHarness, fakeJpeg, SDR_1080, seedMovie, signIn, type AppHarness } from './media-services.fixtures.js';
import { buildTrickplayArgs, jpegSize, tileCountOf, TrickplayService, type TrickplayRunner } from './trickplay.js';
import { TONEMAP_ZSCALE } from './video-info.js';
import { Limiter } from './video-stream.js';

// Scrub thumbnails (redesign spec §3.3): ffmpeg arguments, sheet sizes, the background queue
// (dedup, waits for live streams, failures not retried) and the signed sheet links.

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'arclight-trickplay-'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A fake ffmpeg that writes `sheets` fake 3200x1800 JPEGs into the output folder. */
function fakeRun(sheets: number, calls: string[][], code = 0): TrickplayRunner {
  return async (_bin, args) => {
    calls.push([...args]);
    const out = args[args.length - 1]!.replace(/[\\/]%d\.jpg$/, '');
    for (let n = 0; n < sheets; n++) writeFileSync(join(out, `${n}.jpg`), fakeJpeg(3200, 1800));
    return code;
  };
}

describe('pure helpers', () => {
  it('ffmpeg arguments with and without tone mapping', () => {
    const sdr = buildTrickplayArgs('/m/a.mkv', '/c/1/s.tmp', { tonemap: false });
    expect(sdr.slice(0, 10)).toEqual(['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '2', '-skip_frame', 'nokey', '-i', '/m/a.mkv']);
    expect(sdr[sdr.indexOf('-vf') + 1]).toBe('fps=1/10,scale=320:-2:flags=fast_bilinear,tile=10x10');
    expect(sdr.slice(-7, -1)).toEqual(['-q:v', '6', '-start_number', '0', '-f', 'image2']);
    expect(sdr.at(-1)).toBe(join('/c/1/s.tmp', '%d.jpg'));
    expect(sdr).toContain('-an');
    const hdr = buildTrickplayArgs('/m/a.mkv', '/c/1/s.tmp', { tonemap: true });
    expect(hdr[hdr.indexOf('-vf') + 1]).toBe(`fps=1/10,scale=320:-2:flags=fast_bilinear,${TONEMAP_ZSCALE},tile=10x10`);
  });

  it('JPEG size and tile counts', () => {
    expect(jpegSize(fakeJpeg(3200, 1800))).toEqual({ width: 3200, height: 1800 });
    expect(jpegSize(Buffer.from('not a jpeg'))).toBeNull();
    expect(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
    expect(tileCountOf(30_000, 1)).toBe(3);
    expect(tileCountOf(1_000_000, 1)).toBe(100);
    expect(tileCountOf(1_500_000, 2)).toBe(150);
    // The duration says fewer tiles than the sheets hold: at least one tile on the last sheet.
    expect(tileCountOf(500_000, 2)).toBe(101);
    expect(tileCountOf(0, 2)).toBe(200);
    expect(tileCountOf(10_000, 0)).toBe(0);
  });
});

async function library(): Promise<{ db: Db; dir: string; fileId: number; path: string }> {
  const db = await createTestDb();
  seedAdmin(db);
  setSection(db, 'player', { enabled: true });
  const dir = mkdtempSync(join(tmp, 'lib-'));
  const { file } = seedMovie(db, dir, { title: 'Thumbs', tmdbId: 42 });
  return { db, dir, fileId: file.id, path: file.path };
}

function service(db: Db, dir: string, run: TrickplayRunner, opts: { busy?: () => boolean; mode?: 'off' | 'on-play' | 'library'; zscale?: boolean } = {}) {
  return new TrickplayService({
    db,
    dir: join(dir, 'cache'),
    locate: async () => '/fake/ffmpeg',
    zscale: async () => opts.zscale ?? true,
    settings: () => ({ trickplay: opts.mode ?? 'on-play' }) as never,
    liveBusy: opts.busy ?? (() => false),
    limiter: new Limiter(1, 100),
    run,
    pollMs: 5,
  });
}

describe('TrickplayService', () => {
  it('queues once, waits while live slots are full, then stores sheets and a manifest', async () => {
    const lib = await library();
    const calls: string[][] = [];
    let busy = true;
    const svc = service(lib.db, lib.dir, fakeRun(2, calls), { busy: () => busy });
    expect(await svc.status(lib.fileId, { enqueue: false })).toEqual({ status: 'unavailable' });
    expect(await svc.status(lib.fileId, { enqueue: true })).toEqual({ status: 'pending' });
    svc.enqueue(lib.fileId);
    expect(svc.pending).toBe(1);
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toEqual([]);
    busy = false;
    await svc.idle();
    expect(calls).toHaveLength(1);
    // SDR: no tone mapping even though zscale is there.
    expect(calls[0]![calls[0]!.indexOf('-vf') + 1]).not.toContain('zscale');
    const st = await svc.status(lib.fileId, { enqueue: true });
    expect(st.status).toBe('ready');
    const m = (st as { manifest: { stamp: string } & Record<string, unknown> }).manifest;
    expect(m).toMatchObject({ mediaFileId: lib.fileId, intervalMs: 10_000, tileWidth: 320, tileHeight: 180, columns: 10, rows: 10, tileCount: 101, sheetCount: 2 });
    expect(await svc.sheetPath(lib.fileId, 1, m.stamp)).toBe(join(lib.dir, 'cache', String(lib.fileId), m.stamp, '1.jpg'));
    expect(await svc.sheetPath(lib.fileId, 2, m.stamp)).toBeNull();
    expect(await svc.sheetPath(lib.fileId, 0, '../x')).toBeNull();
    expect(await svc.cacheSize()).toMatchObject({ files: 3 });
    // A replaced file makes new sheets; the old stamp's folder goes away.
    writeFileSync(lib.path, 'z'.repeat(5000));
    utimesSync(lib.path, new Date('2026-04-01T00:00:00Z'), new Date('2026-04-01T00:00:00Z'));
    expect(await svc.status(lib.fileId, { enqueue: true })).toEqual({ status: 'pending' });
    await svc.idle();
    expect(calls).toHaveLength(2);
    expect(await svc.sheetPath(lib.fileId, 0, m.stamp)).toBeNull();
    expect(await svc.cacheSize()).toMatchObject({ files: 3 });
    await svc.clear();
    expect(await svc.cacheSize()).toEqual({ bytes: 0, files: 0 });
  });

  it('HDR files are tone mapped when zscale is there', async () => {
    const db = await createTestDb();
    seedAdmin(db);
    const dir = mkdtempSync(join(tmp, 'hdr-'));
    const { file } = seedMovie(db, dir, { title: 'Bright', tmdbId: 43, info: { ...SDR_1080, videoDynamicRangeType: 'HDR10', videoBitDepth: 10 } as MediaInfo });
    const calls: string[][] = [];
    const svc = service(db, dir, fakeRun(1, calls));
    svc.enqueue(file.id);
    await svc.idle();
    expect(calls[0]![calls[0]!.indexOf('-vf') + 1]).toContain('zscale');
    const plain: string[][] = [];
    const noZscale = service(db, mkdtempSync(join(tmp, 'hdr2-')), fakeRun(1, plain), { zscale: false });
    noZscale.enqueue(file.id);
    await noZscale.idle();
    expect(plain[0]![plain[0]!.indexOf('-vf') + 1]).not.toContain('zscale');
  });

  it('a failed run is remembered until the file changes; off means unavailable', async () => {
    const lib = await library();
    const calls: string[][] = [];
    const svc = service(lib.db, lib.dir, fakeRun(0, calls, 1));
    svc.enqueue(lib.fileId);
    await svc.idle();
    expect(calls).toHaveLength(1);
    expect(await svc.status(lib.fileId, { enqueue: true })).toEqual({ status: 'unavailable' });
    expect(svc.pending).toBe(0);
    expect(await svc.cacheSize()).toEqual({ bytes: 0, files: 0 });
    writeFileSync(lib.path, 'q'.repeat(4000));
    utimesSync(lib.path, new Date('2026-04-02T00:00:00Z'), new Date('2026-04-02T00:00:00Z'));
    expect(await svc.status(lib.fileId, { enqueue: true })).toEqual({ status: 'pending' });
    await svc.idle();
    expect(calls).toHaveLength(2);

    const off = service(lib.db, lib.dir, fakeRun(1, []), { mode: 'off' });
    expect(await off.status(lib.fileId, { enqueue: true })).toEqual({ status: 'unavailable' });
  });

  it('clear() during a run leaves the running job alone, forgets failures and drops queued files', async () => {
    const lib = await library();
    const { file: other } = seedMovie(lib.db, lib.dir, { title: 'Second', tmdbId: 44 });
    const calls: string[][] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const inner = fakeRun(2, calls);
    const svc = service(lib.db, lib.dir, async (bin, args, timeoutMs) => {
      started();
      await gate;
      return inner(bin, args, timeoutMs);
    });
    svc.enqueue(lib.fileId);
    svc.enqueue(other.id);
    await running;
    await svc.clear();
    expect(svc.pending).toBe(1);
    release();
    await svc.idle();
    // The running file finished into its own folder; the queued one was dropped.
    expect(calls).toHaveLength(1);
    expect((await svc.status(lib.fileId, { enqueue: false })).status).toBe('ready');
    expect(await svc.status(other.id, { enqueue: false })).toEqual({ status: 'unavailable' });
  });

  it('clear() forgets failed files so they are tried again', async () => {
    const lib = await library();
    const calls: string[][] = [];
    const svc = service(lib.db, lib.dir, fakeRun(0, calls, 1));
    svc.enqueue(lib.fileId);
    await svc.idle();
    expect(await svc.status(lib.fileId, { enqueue: true })).toEqual({ status: 'unavailable' });
    await svc.clear();
    expect(await svc.status(lib.fileId, { enqueue: true })).toEqual({ status: 'pending' });
    await svc.idle();
    expect(calls).toHaveLength(2);
  });

  it('nightly: removes folders of deleted files and, for the whole library, queues files without sheets', async () => {
    const lib = await library();
    const calls: string[][] = [];
    mkdirSync(join(lib.dir, 'cache', '99999', 'x'), { recursive: true });
    mkdirSync(join(lib.dir, 'cache', 'junk'), { recursive: true });
    expect(await service(lib.db, lib.dir, fakeRun(1, calls)).nightly()).toBe('removed 2 stale folders');
    const all = service(lib.db, lib.dir, fakeRun(1, calls), { mode: 'library' });
    expect(await all.nightly()).toBe('queued 1 files, removed 0 stale folders');
    await all.idle();
    expect(await all.nightly()).toBe('queued 0 files, removed 0 stale folders');
    expect(calls).toHaveLength(1);
  });
});

describe('routes', () => {
  const open: AppHarness[] = [];
  afterEach(async () => {
    for (const h of open.splice(0)) await h.app.close();
  });

  it('manifest, signed sheets without a cookie, stale and forged links, admin cache', async () => {
    const calls: string[][] = [];
    const cache = mkdtempSync(join(tmp, 'routes-'));
    const h = await appHarness((c) => {
      backgroundServicesFor(c, { trickplay: { dir: cache, run: fakeRun(1, calls), locate: async () => '/fake/ffmpeg', zscale: async () => false, liveBusy: () => false, pollMs: 5 } });
    });
    open.push(h);
    const { movie, file } = seedMovie(h.db, mkdtempSync(join(tmp, 'routes-lib-')), { title: 'Scrub', tmdbId: 77 });
    const user = await signIn(h);
    const admin = await signIn(h, { role: 'admin' });
    const manifestUrl = `/api/v1/playback/video/trickplay/${file.id}`;

    const pending = (await h.app.inject({ method: 'GET', url: manifestUrl, headers: { cookie: user.cookie } })).json();
    expect(pending).toMatchObject({ mediaFileId: file.id, status: 'pending', sheets: [] });
    await backgroundServicesFor(h.ctx).trickplay.idle();
    const ready = (await h.app.inject({ method: 'GET', url: manifestUrl, headers: { cookie: user.cookie } })).json();
    expect(ready).toMatchObject({ status: 'ready', tileWidth: 320, tileHeight: 180, tileCount: 60 });
    expect(ready.sheets).toHaveLength(1);
    const sheet = new URL(ready.sheets[0]);
    expect(sheet.pathname).toBe(`/api/v1/stream/trickplay/${file.id}/0.jpg`);
    expect(sheet.searchParams.get('v')).toMatch(/^\d+-\d+$/);

    const path = `${sheet.pathname}${sheet.search}`;
    const img = await h.app.inject({ method: 'GET', url: path });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect(img.headers['cache-control']).toBe('private, max-age=86400');
    expect(jpegSize(img.rawPayload)).toEqual({ width: 3200, height: 1800 });

    const stale = new URL(sheet);
    stale.searchParams.set('v', '1-1');
    expect((await h.app.inject({ method: 'GET', url: `${stale.pathname}${stale.search}` })).statusCode).toBe(404);
    const forged = new URL(sheet);
    forged.searchParams.set('sig', 'A'.repeat(43));
    expect((await h.app.inject({ method: 'GET', url: `${forged.pathname}${forged.search}` })).statusCode).toBe(403);
    // No link and no cookie: sign-in required.
    expect((await h.app.inject({ method: 'GET', url: sheet.pathname })).statusCode).toBe(401);

    // The playback session carries the manifest.
    const session = (
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/playback/video/session',
        headers: { cookie: user.cookie },
        payload: { itemKey: `movie:${movie.id}`, profile: { containers: ['mp4', 'webm'], videoCodecs: ['h264', 'vp9'], audioCodecs: ['aac'], maxAudioChannels: 2, maxHeight: 2160 } },
      })
    ).json();
    expect(session.trickplay).toMatchObject({ mediaFileId: file.id, status: 'ready' });
    expect(session.trickplay.sheets).toHaveLength(1);

    // Admin cache size and clear.
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/settings/player/trickplay-cache', headers: { cookie: user.cookie } })).statusCode).toBe(403);
    const size = (await h.app.inject({ method: 'GET', url: '/api/v1/settings/player/trickplay-cache', headers: { cookie: admin.cookie } })).json();
    expect(size.files).toBe(2);
    expect(size.bytes).toBeGreaterThan(0);
    expect((await h.app.inject({ method: 'DELETE', url: '/api/v1/settings/player/trickplay-cache', headers: { cookie: admin.cookie } })).statusCode).toBe(204);
    expect((await h.app.inject({ method: 'GET', url: path })).statusCode).toBe(404);

    // Turned off: the session and the manifest say so.
    setSection(h.db, 'player', { enabled: true, trickplay: 'off' });
    expect((await h.app.inject({ method: 'GET', url: manifestUrl, headers: { cookie: user.cookie } })).json()).toMatchObject({ status: 'unavailable' });
    expect((await h.app.inject({ method: 'GET', url: `/api/v1/playback/video/trickplay/999999`, headers: { cookie: user.cookie } })).statusCode).toBe(404);
  });
});

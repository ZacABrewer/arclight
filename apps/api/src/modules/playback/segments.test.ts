import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setSection } from '../settings/service.js';
import type { Db } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { createTestDb, seedAdmin } from '../../db/test-utils.js';
import { fingerprint, SAMPLE_RATE } from './fingerprint.js';
import { episode, theme } from './fingerprint.fixtures.js';
import { backgroundServicesFor } from './index.js';
import { appHarness, SDR_1080, seedSeries, signIn, type AppHarness } from './media-services.fixtures.js';
import {
  buildAudioExtractArgs,
  defaultAudioOrdinal,
  detectSeason,
  effectiveSegments,
  mergeSegments,
  neighbourIndexes,
  SegmentService,
  setManualSegments,
  windowOf,
  type EpisodeCodes,
  type PcmExtractor,
} from './segments.js';
import type { LogRunner } from './segment-boundaries.js';
import { Limiter } from './video-stream.js';
import type { MediaInfo } from '@arclight/shared';

// Intro and credits detection (redesign spec §3.4): the season consensus on synthetic audio, the
// precedence of manual > chapter > fingerprint, stamp invalidation, the queue and the routes.

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'arclight-segments-'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// 240 s: a 96 s head window holds every intro below, an 84 s tail window holds the credits.
const EP_SECONDS = 240;
const INTRO_STARTS = [12.3456, 47.1, 3.77, 30.0213];
const CREDITS_SECONDS = 25;
const intro = theme(40, 7);
const credits = theme(CREDITS_SECONDS, 99);

const episodes = new Map<number, Int16Array>();

/**
 * Full PCM of fake episode i: the intro theme at its start, the credits theme at the very end.
 * Made once per file (4 minutes of synthetic audio each; nothing writes to it).
 */
function episodePcm(i: number): Int16Array {
  let pcm = episodes.get(i);
  if (!pcm) {
    pcm = episode(EP_SECONDS, 1000 + i, intro, Math.round(INTRO_STARTS[i]! * SAMPLE_RATE));
    pcm.set(credits, (EP_SECONDS - CREDITS_SECONDS) * SAMPLE_RATE);
    episodes.set(i, pcm);
  }
  return pcm;
}

/** A fake ffmpeg: slices the episode PCM for `-ss` / `-t`, keyed by input path. */
function fakeExtract(byPath: Map<string, Int16Array>, calls: string[]): PcmExtractor {
  return async (_bin, args) => {
    const input = args[args.indexOf('-i') + 1]!;
    calls.push(input);
    const ss = args.includes('-ss') ? Number(args[args.indexOf('-ss') + 1]) : 0;
    const t = Number(args[args.indexOf('-t') + 1]);
    const pcm = byPath.get(input);
    if (!pcm) throw new Error(`no audio for ${input}`);
    const part = pcm.subarray(Math.round(ss * SAMPLE_RATE), Math.round((ss + t) * SAMPLE_RATE));
    return Buffer.from(part.buffer, part.byteOffset, part.byteLength);
  };
}

const info = (durationMs: number): MediaInfo => ({ ...SDR_1080, durationMs }) as MediaInfo;

describe('pure helpers', () => {
  it('windows, extraction args and neighbours', () => {
    expect(windowOf('head', 3_000_000)).toEqual({ startMs: 0, lengthMs: 600_000 });
    expect(windowOf('head', 150_000)).toEqual({ startMs: 0, lengthMs: 60_000 });
    expect(windowOf('tail', 3_000_000)).toEqual({ startMs: 2_580_000, lengthMs: 420_000 });
    expect(windowOf('tail', 150_000)).toEqual({ startMs: 97_500, lengthMs: 52_500 });
    expect(buildAudioExtractArgs('/m/e.mkv', 1, 97_500, 52_500)).toEqual(['-nostdin', '-v', 'error', '-ss', '97.500', '-t', '52.500', '-protocol_whitelist', 'file,pipe', '-i', '/m/e.mkv', '-map', '0:a:1', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1']);
    expect(buildAudioExtractArgs('/m/e.mkv', 0, 0, 60_000)).not.toContain('-ss');
    expect(defaultAudioOrdinal({ audioStreams: [{ default: false }, { default: true }] } as MediaInfo)).toBe(1);
    expect(defaultAudioOrdinal(null)).toBe(0);
    expect(neighbourIndexes(0, 5)).toEqual([1, 2, 3]);
    expect(neighbourIndexes(2, 5)).toEqual([1, 3, 0]);
    expect(neighbourIndexes(1, 2)).toEqual([0]);
  });

  it('a season of 4 episodes: intros within half a second, credits run to the end of the file', () => {
    const durationMs = EP_SECONDS * 1000;
    const eps: EpisodeCodes[] = INTRO_STARTS.map((_, i) => {
      const pcm = episodePcm(i);
      const head = windowOf('head', durationMs);
      const tail = windowOf('tail', durationMs);
      const slice = (w: { startMs: number; lengthMs: number }) => pcm.subarray((w.startMs * SAMPLE_RATE) / 1000, ((w.startMs + w.lengthMs) * SAMPLE_RATE) / 1000);
      return {
        mediaFileId: i + 1,
        durationMs,
        head: { ...head, codes: fingerprint(slice(head)) },
        tail: { ...tail, codes: fingerprint(slice(tail)) },
      };
    });
    const found = detectSeason(eps);
    for (let i = 0; i < 4; i++) {
      const introSeg = found.find((s) => s.mediaFileId === i + 1 && s.type === 'intro');
      expect(introSeg, `intro of episode ${i + 1}`).toBeDefined();
      expect(Math.abs(introSeg!.startMs - INTRO_STARTS[i]! * 1000)).toBeLessThanOrEqual(500);
      expect(Math.abs(introSeg!.endMs - (INTRO_STARTS[i]! + 40) * 1000)).toBeLessThanOrEqual(500);
      expect(introSeg!.confidence).toBe(1);
      const creditsSeg = found.find((s) => s.mediaFileId === i + 1 && s.type === 'credits');
      expect(creditsSeg, `credits of episode ${i + 1}`).toBeDefined();
      expect(Math.abs(creditsSeg!.startMs - (EP_SECONDS - CREDITS_SECONDS) * 1000)).toBeLessThanOrEqual(500);
      expect(creditsSeg!.endMs).toBe(durationMs);
    }
  });

  it('a season with one episode, or unrelated episodes, finds nothing', () => {
    const durationMs = EP_SECONDS * 1000;
    const head = windowOf('head', durationMs);
    const noise = (seed: number) => ({ mediaFileId: seed, durationMs, head: { ...head, codes: fingerprint(episode(60, seed, new Int16Array(0), 0)) }, tail: null });
    expect(detectSeason([noise(1)])).toEqual([]);
    expect(detectSeason([noise(1), noise(2), noise(3)])).toEqual([]);
  });

  it('precedence: manual (override) > chapter > fingerprint; stale fingerprints are ignored', () => {
    const chapter = [{ type: 'intro' as const, startMs: 0, endMs: 30_000 }];
    const stored = [
      { type: 'intro' as const, startMs: 5_000, endMs: 50_000, source: 'fingerprint' as const, fileStamp: 's1' },
      { type: 'credits' as const, startMs: 1_000_000, endMs: 1_200_000, source: 'fingerprint' as const, fileStamp: 's1' },
      { type: 'credits' as const, startMs: 1_100_000, endMs: 1_200_000, source: 'manual' as const, fileStamp: null },
    ];
    expect(mergeSegments(chapter, stored, false, 's1')).toEqual([
      { type: 'intro', startMs: 0, endMs: 30_000, source: 'chapter' },
      { type: 'credits', startMs: 1_000_000, endMs: 1_200_000, source: 'fingerprint' },
    ]);
    expect(mergeSegments(chapter, stored, false, 's2')).toEqual([{ type: 'intro', startMs: 0, endMs: 30_000, source: 'chapter' }]);
    expect(mergeSegments(chapter, stored, true, 's1')).toEqual([{ type: 'credits', startMs: 1_100_000, endMs: 1_200_000, source: 'manual' }]);
    expect(mergeSegments(chapter, [], true, null)).toEqual([]);
  });
});

interface SeasonLib {
  db: Db;
  seriesId: number;
  files: Array<{ id: number; path: string }>;
  byPath: Map<string, Int16Array>;
}

async function seasonLib(count = 4): Promise<SeasonLib> {
  const db = await createTestDb();
  seedAdmin(db);
  const dir = mkdtempSync(join(tmp, 'season-'));
  const { show } = seedSeries(db, dir, {
    title: 'Scan Show',
    tmdbId: 500 + count,
    episodes: Array.from({ length: count }, (_, i) => ({ season: 1, episode: i + 1, info: info(EP_SECONDS * 1000), dateAdded: `2026-01-0${i + 1}T00:00:00.000Z` })),
  });
  const files = db
    .select({ id: schema.mediaFiles.id, path: schema.mediaFiles.path })
    .from(schema.mediaFiles)
    .all()
    .sort((a, b) => a.id - b.id);
  const byPath = new Map(files.map((f, i) => [f.path, episodePcm(i)]));
  return { db, seriesId: show.id, files, byPath };
}

function service(lib: SeasonLib, calls: string[], opts: { busy?: () => boolean; detection?: boolean; recaps?: boolean; probe?: LogRunner } = {}) {
  return new SegmentService({
    db: lib.db,
    locate: async () => '/fake/ffmpeg',
    // Recaps (and their body reads) are off here unless a test turns them on.
    settings: () => ({ segmentDetection: opts.detection ?? true, segmentDetectionRecaps: opts.recaps ?? false }) as never,
    probe: opts.probe ?? (async () => ''),
    liveBusy: opts.busy ?? (() => false),
    limiter: new Limiter(1, 100),
    extract: fakeExtract(lib.byPath, calls),
    pollMs: 5,
    now: () => Date.parse('2026-05-01T00:00:00.000Z'),
  });
}

describe('SegmentService', () => {
  it('scans a season, stores fingerprint segments, and skips an unchanged season', async () => {
    const lib = await seasonLib();
    const calls: string[] = [];
    const svc = service(lib, calls);
    expect(await svc.changedSeasons()).toEqual([{ seriesId: lib.seriesId, seasonNumber: 1 }]);
    const stored = await svc.scanSeason(lib.seriesId, 1);
    expect(stored).toBe(8);
    expect(calls).toHaveLength(8);
    const segs = await effectiveSegments(lib.db, lib.files[1]!, []);
    expect(segs.map((s) => [s.type, s.source])).toEqual([
      ['intro', 'fingerprint'],
      ['credits', 'fingerprint'],
    ]);
    expect(Math.abs(segs[0]!.startMs - INTRO_STARTS[1]! * 1000)).toBeLessThanOrEqual(500);
    // Unchanged: nothing is extracted again.
    expect(await svc.changedSeasons()).toEqual([]);
    expect(await svc.scanSeason(lib.seriesId, 1)).toBe(0);
    expect(calls).toHaveLength(8);
    // Forced: the stored fingerprints are reused (no ffmpeg), detection runs again.
    expect(await svc.scanSeason(lib.seriesId, 1, true)).toBe(8);
    expect(calls).toHaveLength(8);
  });

  it('a replaced file invalidates its fingerprint segments and its season', async () => {
    const lib = await seasonLib();
    const calls: string[] = [];
    const svc = service(lib, calls);
    await svc.scanSeason(lib.seriesId, 1);
    const f = lib.files[0]!;
    writeFileSync(f.path, 'y'.repeat(3000));
    utimesSync(f.path, new Date('2026-04-01T00:00:00Z'), new Date('2026-04-01T00:00:00Z'));
    expect(await effectiveSegments(lib.db, f, [])).toEqual([]);
    expect(await svc.changedSeasons(lib.seriesId)).toEqual([{ seriesId: lib.seriesId, seasonNumber: 1 }]);
    await svc.scanSeason(lib.seriesId, 1);
    // Only the changed file is extracted again (head and tail).
    expect(calls.slice(8)).toEqual([f.path, f.path]);
    expect((await effectiveSegments(lib.db, f, [])).length).toBe(2);
  });

  it('manual edits win until reset', async () => {
    const lib = await seasonLib();
    const svc = service(lib, []);
    await svc.scanSeason(lib.seriesId, 1);
    const f = lib.files[2]!;
    setManualSegments(lib.db, f.id, [{ type: 'intro', startMs: 1000, endMs: 2000 }], '2026-05-01T00:00:00.000Z');
    expect(await effectiveSegments(lib.db, f, [{ type: 'credits', startMs: 0, endMs: 1 }])).toEqual([{ type: 'intro', startMs: 1000, endMs: 2000, source: 'manual' }]);
    // A rescan keeps manual rows.
    await svc.scanSeason(lib.seriesId, 1, true);
    expect((await effectiveSegments(lib.db, f, [])).map((s) => s.source)).toEqual(['manual']);
  });

  it('the queue deduplicates seasons, waits while live slots are full, and does nothing when off', async () => {
    const lib = await seasonLib(2);
    const calls: string[] = [];
    let busy = true;
    const svc = service(lib, calls, { busy: () => busy });
    expect(svc.enqueue(lib.seriesId, 1)).toBe(true);
    expect(svc.enqueue(lib.seriesId, 1)).toBe(false);
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toEqual([]);
    expect(svc.isQueued(lib.seriesId, 1)).toBe(true);
    busy = false;
    await svc.idle();
    expect(calls).toHaveLength(4);
    expect(svc.isQueued(lib.seriesId, 1)).toBe(false);

    const off = service(await seasonLib(3), [], { detection: false });
    expect(await off.nightly()).toBe('intro and credits detection is turned off');
  });

  it('reuses a stored head only for the same window length', async () => {
    const lib = await seasonLib();
    const calls: string[] = [];
    const svc = service(lib, calls);
    await svc.scanSeason(lib.seriesId, 1);
    expect(calls).toHaveLength(8);
    const f = lib.files[0]!;
    // A head stored for another window length (it starts at 0 all the same).
    lib.db.update(schema.videoFingerprints).set({ lengthMs: 1234 }).where(and(eq(schema.videoFingerprints.mediaFileId, f.id), eq(schema.videoFingerprints.part, 'head'))).run();
    await svc.scanSeason(lib.seriesId, 1, true);
    expect(calls.slice(8)).toEqual([f.path]);
  });

  it('keeps the earlier segments of a file whose audio could not be read this time', async () => {
    const lib = await seasonLib();
    const svc = service(lib, []);
    await svc.scanSeason(lib.seriesId, 1);
    const f = lib.files[0]!;
    const before = await effectiveSegments(lib.db, f, []);
    expect(before).toHaveLength(2);
    // Its stored codes are gone and ffmpeg now fails on it.
    lib.db.delete(schema.videoFingerprints).where(eq(schema.videoFingerprints.mediaFileId, f.id)).run();
    lib.byPath.delete(f.path);
    await svc.scanSeason(lib.seriesId, 1, true);
    expect(await effectiveSegments(lib.db, f, [])).toEqual(before);
    expect((await effectiveSegments(lib.db, lib.files[1]!, [])).length).toBe(2);
  });

  it('nightly stops on abort and drops the seasons it queued that have not started', async () => {
    const db = await createTestDb();
    seedAdmin(db);
    const dir = mkdtempSync(join(tmp, 'abort-'));
    const { show } = seedSeries(db, dir, {
      title: 'Abort Show',
      tmdbId: 777,
      episodes: [1, 2].flatMap((season) => [1, 2].map((e) => ({ season, episode: e, info: info(EP_SECONDS * 1000), dateAdded: `2026-01-0${season}T00:00:00.000Z` }))),
    });
    const files = db.select({ id: schema.mediaFiles.id, path: schema.mediaFiles.path }).from(schema.mediaFiles).all().sort((a, b) => a.id - b.id);
    const lib: SeasonLib = { db, seriesId: show.id, files, byPath: new Map(files.map((f, i) => [f.path, episodePcm(i)])) };
    const calls: string[] = [];
    let busy = true;
    const svc = service(lib, calls, { busy: () => busy });
    const ctrl = new AbortController();
    const run = svc.nightly(ctrl.signal);
    await new Promise((r) => setTimeout(r, 30));
    ctrl.abort();
    expect(await run).toBe('stopped: 1 seasons left for the next run');
    // The season already started finishes; the other one is no longer queued.
    busy = false;
    await svc.idle();
    expect(calls).toHaveLength(4);
    expect(svc.isQueued(show.id, 1) || svc.isQueued(show.id, 2)).toBe(false);
    expect(await svc.changedSeasons()).toHaveLength(1);
  });

  it('recaps on: bodies are read (codes only), heads keep chroma, and the setting is part of the season stamp', async () => {
    const lib = await seasonLib();
    const calls: string[] = [];
    let recaps = true;
    const svc = new SegmentService({
      db: lib.db,
      locate: async () => '/fake/ffmpeg',
      settings: () => ({ segmentDetection: true, segmentDetectionRecaps: recaps }) as never,
      probe: async () => '',
      liveBusy: () => false,
      limiter: new Limiter(1, 100),
      extract: fakeExtract(lib.byPath, calls),
      pollMs: 5,
      now: () => Date.parse('2026-05-01T00:00:00.000Z'),
    });
    await svc.scanSeason(lib.seriesId, 1);
    // head, tail and body of 4 episodes.
    expect(calls).toHaveLength(12);
    const rows = lib.db.select().from(schema.videoFingerprints).all();
    expect(rows.filter((r) => r.part === 'body')).toHaveLength(4);
    expect(rows.filter((r) => r.part === 'body').every((r) => r.chroma === null)).toBe(true);
    expect(rows.filter((r) => r.part !== 'body').every((r) => r.chroma !== null && r.chroma.length > 0)).toBe(true);
    const body = rows.find((r) => r.part === 'body')!;
    expect({ startMs: body.startMs, lengthMs: body.lengthMs }).toEqual(windowOf('body', EP_SECONDS * 1000));
    // No episode here opens with a recap.
    expect(lib.db.select().from(schema.videoSegments).all().some((r) => r.type === 'recap')).toBe(false);
    expect(await svc.changedSeasons()).toEqual([]);
    recaps = false;
    expect(await svc.changedSeasons()).toEqual([{ seriesId: lib.seriesId, seasonNumber: 1 }]);
    // Heads and tails from before chroma are read again; bodies are not needed with recaps off.
    lib.db.update(schema.videoFingerprints).set({ chroma: null }).where(eq(schema.videoFingerprints.mediaFileId, lib.files[0]!.id)).run();
    await svc.scanSeason(lib.seriesId, 1);
    expect(calls.slice(12)).toEqual([lib.files[0]!.path, lib.files[0]!.path]);
  });

  it('moves intro edges onto a black frame or silence found by the probe', async () => {
    const lib = await seasonLib();
    const probes: string[][] = [];
    // A black frame ending 1.2 s before every probed edge, as ffmpeg logs it (from the window start).
    const probe: LogRunner = async (_bin, args) => {
      probes.push([...args]);
      const ss = args.includes('-ss') ? Number(args[args.indexOf('-ss') + 1]) : 0;
      const t = Number(args[args.indexOf('-t') + 1]);
      const edge = ss + Math.min(2.5, t / 2);
      const end = edge - 1.2 - ss;
      return `[blackdetect @ 0x1] black_start:${(end - 0.3).toFixed(3)} black_end:${end.toFixed(3)} black_duration:0.300\n`;
    };
    const plain = service(lib, []);
    await plain.scanSeason(lib.seriesId, 1);
    const before = await effectiveSegments(lib.db, lib.files[1]!, []);
    const svc = service(lib, [], { probe });
    await svc.scanSeason(lib.seriesId, 1, true);
    const after = await effectiveSegments(lib.db, lib.files[1]!, []);
    // Intro start and end moved by 1.2 s (within a few ms of window rounding); credits untouched.
    expect(Math.abs(after[0]!.startMs - (before[0]!.startMs - 1200))).toBeLessThanOrEqual(5);
    expect(Math.abs(after[0]!.endMs - (before[0]!.endMs - 1200))).toBeLessThanOrEqual(5);
    expect(after[1]).toEqual(before[1]);
    // Two probes per episode (intro start and end), the file has video: blackdetect is asked for.
    expect(probes).toHaveLength(8);
    expect(probes[0]).toContain('0:v:0');
    // A failing probe keeps the audio edges.
    const failing = service(lib, [], { probe: async () => Promise.reject(new Error('no ffmpeg')) });
    await failing.scanSeason(lib.seriesId, 1, true);
    expect(await effectiveSegments(lib.db, lib.files[1]!, [])).toEqual(before);
  });

  it('a season with one file is marked done without ffmpeg', async () => {
    const lib = await seasonLib(1);
    const calls: string[] = [];
    const svc = service(lib, calls);
    expect(await svc.scanSeason(lib.seriesId, 1)).toBe(0);
    expect(calls).toEqual([]);
    expect(await svc.changedSeasons()).toEqual([]);
  });
});

describe('routes', () => {
  const open: AppHarness[] = [];
  afterEach(async () => {
    for (const h of open.splice(0)) await h.app.close();
  });

  it('admin only: season view, manual edits, reset and scan', async () => {
    const calls: string[] = [];
    const byPath = new Map<string, Int16Array>();
    const h = await appHarness((c) => {
      backgroundServicesFor(c, { segments: { locate: async () => '/fake/ffmpeg', extract: fakeExtract(byPath, calls), probe: async () => '', pollMs: 5, liveBusy: () => false } });
    });
    open.push(h);
    const dir = mkdtempSync(join(tmp, 'routes-'));
    const { show } = seedSeries(h.db, dir, { title: 'Route Show', tmdbId: 777, episodes: [1, 2, 3].map((n) => ({ season: 1, episode: n, info: info(EP_SECONDS * 1000) })) });
    const files = h.db.select({ id: schema.mediaFiles.id, path: schema.mediaFiles.path }).from(schema.mediaFiles).all();
    files.forEach((f, i) => byPath.set(f.path, episodePcm(i)));
    const admin = await signIn(h, { role: 'admin' });
    const user = await signIn(h);
    const url = `/api/v1/playback/segments/series/${show.id}/season/1`;

    expect((await h.app.inject({ method: 'GET', url, headers: { cookie: user.cookie } })).statusCode).toBe(403);
    const before = (await h.app.inject({ method: 'GET', url, headers: { cookie: admin.cookie } })).json();
    expect(before.scan.status).toBe('never');
    expect(before.episodes).toHaveLength(3);
    expect(before.episodes[0].segments).toEqual([]);

    const scan = await h.app.inject({ method: 'POST', url: '/api/v1/playback/segments/scan', headers: { cookie: admin.cookie }, payload: { seriesId: show.id, seasonNumber: 1 } });
    expect(scan.statusCode).toBe(202);
    expect(scan.json()).toEqual({ queued: 1 });
    await backgroundServicesFor(h.ctx).segments.idle();
    const after = (await h.app.inject({ method: 'GET', url, headers: { cookie: admin.cookie } })).json();
    expect(after.scan.status).toBe('done');
    expect(after.episodes[1].segments.map((s: { type: string; source: string }) => `${s.type}:${s.source}`)).toEqual(['intro:fingerprint', 'credits:fingerprint']);

    const fileId = after.episodes[0].mediaFileId;
    const put = await h.app.inject({ method: 'PUT', url: `/api/v1/playback/segments/file/${fileId}`, headers: { cookie: admin.cookie }, payload: { segments: [{ type: 'intro', startMs: 0, endMs: 45_000 }] } });
    expect(put.statusCode).toBe(204);
    const edited = (await h.app.inject({ method: 'GET', url, headers: { cookie: admin.cookie } })).json();
    expect(edited.episodes[0]).toMatchObject({ manual: true, segments: [{ type: 'intro', startMs: 0, endMs: 45_000, source: 'manual' }] });
    // The player sees the manual segments too.
    const item = (await h.app.inject({ method: 'GET', url: `/api/v1/playback/item/episode:${edited.episodes[0].episodeId}`, headers: { cookie: user.cookie } })).json();
    expect(item.segments).toEqual([{ type: 'intro', startMs: 0, endMs: 45_000, source: 'manual' }]);

    expect((await h.app.inject({ method: 'DELETE', url: `/api/v1/playback/segments/file/${fileId}`, headers: { cookie: admin.cookie } })).statusCode).toBe(204);
    const reset = (await h.app.inject({ method: 'GET', url, headers: { cookie: admin.cookie } })).json();
    expect(reset.episodes[0].manual).toBe(false);
    expect(reset.episodes[0].segments.map((s: { source: string }) => s.source)).toEqual(['fingerprint', 'fingerprint']);

    expect((await h.app.inject({ method: 'PUT', url: `/api/v1/playback/segments/file/999999`, headers: { cookie: admin.cookie }, payload: { segments: [] } })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: `/api/v1/playback/segments/series/999999/season/1`, headers: { cookie: admin.cookie } })).statusCode).toBe(404);

    // Without a season number every season with files is queued; 409 when detection is off.
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/playback/segments/scan', headers: { cookie: admin.cookie }, payload: { seriesId: show.id } })).json()).toEqual({ queued: 1 });
    await backgroundServicesFor(h.ctx).segments.idle();
    setSection(h.db, 'player', { enabled: true, segmentDetection: false });
    const off = await h.app.inject({ method: 'POST', url: '/api/v1/playback/segments/scan', headers: { cookie: admin.cookie }, payload: { seriesId: show.id } });
    expect(off.statusCode).toBe(409);
    expect(off.json().code).toBe('DETECTION_OFF');
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/playback/segments/scan', headers: { cookie: user.cookie }, payload: { seriesId: show.id } })).statusCode).toBe(403);
  }, 120_000); // a real scan of three episodes, recaps included
});

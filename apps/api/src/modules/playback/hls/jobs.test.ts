import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VideoInfo } from '@arclight/shared';
import { TranscodeBusy } from '../transcode.js';
import { CapacityModel, type JobClass } from './capacity.js';
import { AUDIO_ID, AUDIO_TS, decodeTimes, fragment, initSegment, VIDEO_ID, VIDEO_TS } from './fmp4.fixtures.js';
import { HlsSessions, RungUnsustainable, type HlsProc, type HlsSessionInit } from './jobs.js';
import type { Ladder, LadderRung } from './ladder.js';
import { SOFTWARE_CAPS, type PipelineCaps } from './pipeline.js';
import { segmentPlan } from './plan.js';

// Segment-on-demand HLS jobs against a fake ffmpeg: it writes synthetic fragmented MP4 (decode
// times from 0, like ffmpeg's muxer) and `out_time_us` progress lines when the test says so.

class FakeProc implements HlsProc {
  stdout = new PassThrough();
  stderr = new PassThrough();
  paused = false;
  killed = false;
  private finish!: (code: number | null) => void;
  done = new Promise<number | null>((r) => (this.finish = r));
  readonly startSec: number;
  private sentInit = false;

  constructor(
    readonly args: readonly string[],
    readonly starts: readonly number[],
  ) {
    const i = args.indexOf('-ss');
    this.startSec = Number(args[i + 1]);
  }
  pause() {
    this.paused = true;
    return true;
  }
  resume() {
    this.paused = false;
  }
  kill() {
    if (this.killed) return;
    this.killed = true;
    this.finish(null);
  }
  exit(code: number) {
    this.stdout.end();
    this.finish(code);
  }
  /** Writes the fragments of segments [from, to) (one fragment per segment), plus the init first. */
  emit(from: number, to: number, payload = 100) {
    if (!this.sentInit) {
      this.stdout.write(initSegment());
      this.sentInit = true;
    }
    for (let n = from; n < to; n++) {
      // Source time (-copyts, frag_discont): a keyframe at the segment start behind a B-frame delay
      // of 7500 ticks, and the audio priming frame 1024 samples before it.
      const t = this.starts[n]!;
      this.stdout.write(fragment(BigInt(Math.round(t * VIDEO_TS)) - 7500n, BigInt(Math.round(t * AUDIO_TS)) - 1024n, 7500, payload));
    }
  }
  progress(outSec: number) {
    this.stderr.write(`out_time_us=${Math.round(outSec * 1e6)}\nprogress=continue\n`);
  }
  get preset() {
    return this.args[this.args.indexOf('-preset') + 1];
  }
}

const INFO = {
  mediaFileId: 1,
  versionTag: null,
  container: 'mkv',
  videoCodec: 'h264',
  videoProfile: 'High',
  bitDepth: 8,
  width: 1920,
  height: 1080,
  fps: 24,
  dynamicRange: 'sdr',
  sizeBytes: 1,
  bitrateKbps: 6000,
  audioTracks: [{ index: 0, codec: 'aac', channels: 2, language: 'eng', title: null, default: true, label: 'English' }],
  subtitleTracks: [],
} as unknown as VideoInfo;

const job = (outHeight: number): JobClass => ({ pipeline: 'software', hwDecode: false, srcCodec: 'h264', srcHeight: 1080, srcHdr: false, outHeight, outCodec: 'h264', tonemap: false, tonemapx: false, burn: false });
const rung = (id: '720' | '480', height: number, kbps: number): LadderRung => ({
  id,
  mode: 'transcode',
  width: Math.round((height * 16) / 9 / 2) * 2,
  height,
  videoKbps: kbps,
  codec: 'h264',
  range: 'sdr',
  bandwidth: kbps * 1100,
  avgBandwidth: kbps * 1000,
  codecs: 'avc1.64001f',
  tonemap: false,
  hdrKeep: false,
  speed: 5,
  job: job(height),
});
const LADDER: Ladder = { rungs: [rung('720', 720, 4000), rung('480', 480, 1600)], startRung: '720', audio: { ordinal: 0, codec: 'aac', channels: 2, kbps: 192 }, burn: null, busy: false };
const PLAN = segmentPlan(null, 600); // 100 segments of 6 s

let root: string;
let clock: number;
let procs: FakeProc[];
let launches: number;
let failFirst: boolean;
let sessions: HlsSessions;
let cacheBytes: number;

function make(over: { maxStreams?: number; maxPerDevice?: number } = {}) {
  sessions = new HlsSessions({
    root: () => root,
    cacheBytes: () => cacheBytes,
    maxStreams: () => over.maxStreams ?? 3,
    maxPerDevice: () => over.maxPerDevice ?? 1,
    locate: async () => 'ffmpeg',
    capacity: new CapacityModel({ file: null, cpus: 4 }),
    now: () => clock,
    launcher: (_bin, args) => {
      launches++;
      const p = new FakeProc(args, PLAN.starts);
      procs.push(p);
      if (failFirst && launches === 1) setImmediate(() => p.exit(1));
      return p;
    },
  });
  sessions.waitMs = 300;
  return sessions;
}

const init = (over: Partial<HlsSessionInit> = {}): HlsSessionInit => ({
  userId: 1,
  deviceKey: 'tv',
  mediaFileId: 1,
  input: '/media/film.mkv',
  info: INFO,
  plan: PLAN,
  index: null,
  ladder: LADDER,
  caps: SOFTWARE_CAPS,
  burnSource: null,
  ...over,
});

async function until(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
const last = () => procs[procs.length - 1]!;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'arclight-hls-'));
  clock = 1_000_000;
  procs = [];
  launches = 0;
  failFirst = false;
  cacheBytes = 100e9;
});
afterEach(async () => {
  await sessions?.close();
  await rm(root, { recursive: true, force: true });
});

describe('HLS jobs', () => {
  it('long-polls a segment, writes it at media time and serves cached ones at once', async () => {
    const s = await make().create(init());
    const first = s.segment('720', 0);
    await until(() => procs.length === 1);
    expect(last().args.join(' ')).toContain('-copyts -ss 0.000');
    last().emit(0, 3);
    const path = await first;
    expect(path).toBe(join(s.dir, '720', 's0.m4s'));
    expect(decodeTimes(await readFile(path))).toEqual([
      { track: VIDEO_ID, t: 0n },
      { track: AUDIO_ID, t: 0n },
    ]);
    expect((await stat(join(s.dir, '720', 'init.mp4'))).size).toBeGreaterThan(0);
    expect(await s.initSegment('720')).toBe(join(s.dir, '720', 'init.mp4'));
    // Segment 1 is complete (2's fragment arrived); 2 is in progress and 3 is waited for.
    expect(await s.segment('720', 1)).toBe(join(s.dir, '720', 's1.m4s'));
    const third = s.segment('720', 3);
    last().emit(3, 5);
    expect(await third).toBe(join(s.dir, '720', 's3.m4s'));
    expect(procs).toHaveLength(1);
  });

  it('restarts on a seek: the new run writes continuous timestamps from its segment', async () => {
    const s = await make().create(init());
    const a = s.segment('720', 0);
    await until(() => procs.length === 1);
    last().emit(0, 2);
    await a;
    const seek = s.segment('720', 20);
    await until(() => procs.length === 2);
    expect(procs[0]!.killed).toBe(true);
    expect(last().args.join(' ')).toContain('-copyts -ss 120.000');
    // Forced keyframes from the next boundary, at most RUN_SEGMENTS ahead.
    expect(last().args.join(' ')).toMatch(/-force_key_frames 125\.995,131\.995,/);
    last().emit(20, 23);
    const s20 = decodeTimes(await readFile(await seek));
    const s21 = decodeTimes(await readFile(await s.segment('720', 21)));
    expect(s20.find((t) => t.track === VIDEO_ID)!.t + 7500n).toBe(BigInt(120 * VIDEO_TS));
    expect(s21.find((t) => t.track === VIDEO_ID)!.t + 7500n).toBe(BigInt(126 * VIDEO_TS));
    // Audio keeps its source time (the priming frame before the boundary).
    expect(s20.find((t) => t.track === AUDIO_ID)!.t).toBe(BigInt(120 * AUDIO_TS - 1024));
    expect(s21.find((t) => t.track === AUDIO_ID)!.t).toBe(BigInt(126 * AUDIO_TS - 1024));
    // A rung switch is a restart too.
    const low = s.segment('480', 22);
    await until(() => procs.length === 3);
    expect(last().args.join(' ')).toContain('scale=854:480');
    last().emit(22, 24);
    await low;
  });

  it('pauses far ahead of the playhead and resumes when the client gets close', async () => {
    const s = await make().create(init());
    const a = s.segment('720', 0);
    await until(() => procs.length === 1);
    last().emit(0, 32);
    await a;
    await until(() => s.isCached('720', 30));
    await sessions.tick();
    expect(last().paused).toBe(true);
    await s.segment('720', 20);
    expect(last().paused).toBe(false);
  });

  it('a 10 minute pause stops the encoder at 2 minutes and picks up where the cache ends', async () => {
    const s = await make().create(init());
    const a = s.segment('720', 0);
    await until(() => procs.length === 1);
    last().emit(0, 33);
    await a;
    await until(() => s.isCached('720', 31));
    clock += 121_000;
    await sessions.tick();
    expect(procs[0]!.killed).toBe(true);
    clock += 480_000;
    await sessions.tick();
    expect(sessions.get(s.id)).not.toBeNull();
    // Resume: cached segments are served; nearing the end of the cache starts a run there.
    expect(await s.segment('720', 1)).toBe(join(s.dir, '720', 's1.m4s'));
    expect(procs).toHaveLength(1);
    await s.segment('720', 20);
    await until(() => procs.length === 2);
    expect(last().args.join(' ')).toContain('-ss 192.000');
  });

  it('removes an idle session after 15 minutes', async () => {
    const s = await make().create(init());
    clock += 15 * 60_000;
    await sessions.tick();
    expect(sessions.get(s.id)).toBeNull();
    await expect(stat(s.dir)).rejects.toThrow();
  });

  it('too slow: a faster preset, then advice, then 409 for the rung', async () => {
    const s = await make().create(init());
    const wait = s.segment('720', 0).catch((e: unknown) => e);
    await until(() => procs.length === 1);
    expect(last().preset).toBe('veryfast');
    let out = 0;
    const run = (speed: number, secs: number) => {
      for (let i = 0; i < secs; i++) {
        clock += 1000;
        out += speed;
        last().progress(out);
      }
    };
    run(1.1, 22);
    await until(() => procs.length === 2);
    expect(last().preset).toBe('superfast');
    out = 0;
    last().progress(0);
    run(1.1, 22);
    await until(() => s.health().maxSustainableRung === '480');
    expect(s.health().encodeSpeed).toBeCloseTo(1.1);
    expect(s.encodeHeader()).toBe('speed=1.10;advice=480');
    run(0.9, 12);
    await until(() => s.flagged.has('720'));
    // The waiting request gets the 409 at once.
    expect(await wait).toBeInstanceOf(RungUnsustainable);
    await expect(s.segment('720', 0)).rejects.toBeInstanceOf(RungUnsustainable);
  });

  it('a GPU chain that fails before any output is retried in software', async () => {
    failFirst = true;
    const qsv: PipelineCaps = { ...SOFTWARE_CAPS, hwaccel: 'qsv', pipeline: 'qsv', hwDecode: ['h264'] };
    const s = await make().create(init({ caps: qsv }));
    const a = s.segment('720', 0);
    await until(() => procs.length === 2);
    expect(procs[0]!.args.join(' ')).toContain('h264_qsv');
    expect(last().args.join(' ')).toContain('libx264');
    last().emit(0, 2);
    await a;
  });

  it('DELETE ends the session: encoder killed, files gone', async () => {
    const s = await make().create(init());
    const a = s.segment('720', 0);
    await until(() => procs.length === 1);
    last().emit(0, 2);
    await a;
    await sessions.delete(s.id);
    expect(last().killed).toBe(true);
    await expect(stat(s.dir)).rejects.toThrow();
    expect(sessions.get(s.id)).toBeNull();
  });

  it('the startup sweep removes leftover session folders only', async () => {
    await mkdir(join(root, 'f'.repeat(32), '720'), { recursive: true });
    await mkdir(join(root, 'keep-me'), { recursive: true });
    await make().start();
    expect(await readdir(root)).toEqual(['keep-me']);
  });

  it('the disk cap removes segments well behind the playhead only', async () => {
    cacheBytes = 3000;
    const s = await make().create(init());
    const a = s.segment('720', 0);
    await until(() => procs.length === 1);
    last().emit(0, 16, 300);
    await a;
    await until(() => s.isCached('720', 14));
    // All ahead of the playhead: kept, over the cap or not.
    expect([...s.cached.get('720')!.keys()]).toHaveLength(15);
    await s.segment('720', 14);
    last().emit(16, 17, 300);
    await until(() => !s.isCached('720', 7));
    // Playhead at 84 s: segments ending before 54 s (0-7) go; 8 and later stay, even over the cap.
    for (let n = 0; n <= 7; n++) expect(s.isCached('720', n)).toBe(false);
    for (let n = 8; n <= 15; n++) expect(s.isCached('720', n)).toBe(true);
    expect(s.bytes).toBeGreaterThan(3000);
    await expect(stat(join(s.dir, '720', 's0.m4s'))).rejects.toThrow();
  });

  it('counts slots: a device replaces its own session, others get busy at the cap', async () => {
    const all = make({ maxStreams: 1 });
    const a = await all.create(init());
    const b = await all.create(init());
    expect(all.get(a.id)).toBeNull();
    expect(all.get(b.id)).not.toBeNull();
    await expect(all.create(init({ deviceKey: 'phone' }))).rejects.toBeInstanceOf(TranscodeBusy);
    // A copy costs a quarter slot.
    const copyLadder: Ladder = { ...LADDER, rungs: [{ ...LADDER.rungs[0]!, id: 'src', mode: 'copy', job: null }], startRung: 'src' };
    const many = make({ maxStreams: 1, maxPerDevice: 4 });
    for (const d of ['a', 'b', 'c', 'd']) await many.create(init({ deviceKey: d, ladder: copyLadder }));
    await expect(many.create(init({ deviceKey: 'e', ladder: copyLadder }))).rejects.toBeInstanceOf(TranscodeBusy);
    await all.close();
  });
});

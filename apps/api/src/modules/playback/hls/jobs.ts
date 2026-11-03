import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { TranscodeHwaccel, VideoHlsHealth, VideoHlsRungId, VideoInfo } from '@arclight/shared';
import { TranscodeBusy } from '../transcode.js';
import { resourceOf, SAFE_SPEED, type CapacityModel } from './capacity.js';
import { Fmp4Splitter, initSignature, initTracks, shiftFragment, type Fmp4Fragment, type Fmp4Track } from './fmp4.js';
import { copySeekTarget, type KeyframeIndex } from './keyframes.js';
import type { Ladder, LadderRung } from './ladder.js';
import { AUDIO_PRIMING, buildHlsArgs, isSoftware, pipelineFor, type HlsRunSpec, type PipelineCaps } from './pipeline.js';
import { ffmpegSeek, segmentAt, sourceTime, type SegmentPlan } from './plan.js';

// Segment-on-demand HLS encoding. One HlsSession per playback session holds at most one ffmpeg
// (the rung the client is fetching), which writes fragmented MP4 to stdout; we split it into the
// planned segments, move each track's timestamps to media time and write `s<n>.m4s` atomically.
// A request for a cached segment is served at once; one just ahead of the encoder waits for it
// (long-poll); anything else (a seek, a rung switch) restarts the encoder at that segment. The
// encoder is paused (SIGSTOP) once far enough ahead of the client and resumed when it gets
// closer, so a paused player costs nothing and never ends the stream.

export const AHEAD_MAX_SEC = 180;
export const AHEAD_MIN_SEC = 90;
/** A transcode run forces keyframes this many segments ahead, then the job restarts there. */
export const RUN_SEGMENTS = 150;
const WAIT_MS = 20_000;
const IDLE_KILL_MS = 120_000;
const IDLE_DELETE_MS = 15 * 60_000;
const WARMUP_MS = 5_000;
const EWMA_SEC = 10;
const LOW_SPEED_MS = 15_000;
const ALONE_MS = 30_000;
const KEEP_BEHIND_SEC = 30;
/** A request this close ahead of the encoder waits for it instead of restarting. */
const WAIT_AHEAD_SEGMENTS = 2;

export interface HlsProc {
  stdout: Readable;
  stderr: Readable;
  /** SIGSTOP / SIGCONT; false when the platform has no job control (Windows). */
  pause(): boolean;
  resume(): void;
  kill(): void;
  /** Exit code (null: killed by a signal). */
  done: Promise<number | null>;
}

export type HlsLauncher = (bin: string, args: readonly string[]) => HlsProc;

export const spawnHls: HlsLauncher = (bin, args) => {
  const child = spawn(bin, [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const done = new Promise<number | null>((resolve) => {
    child.once('close', (code) => resolve(code));
    child.once('error', () => resolve(1));
  });
  const alive = () => child.exitCode === null && child.signalCode === null;
  return {
    stdout: child.stdout!,
    stderr: child.stderr!,
    pause: () => (process.platform === 'win32' || !alive() ? false : child.kill('SIGSTOP')),
    resume: () => {
      if (process.platform !== 'win32' && alive()) child.kill('SIGCONT');
    },
    kill: () => {
      if (!alive()) return;
      // A stopped process does not act on SIGKILL until continued on some systems.
      if (process.platform !== 'win32') child.kill('SIGCONT');
      child.kill('SIGKILL');
    },
    done,
  };
};

export class RungUnsustainable extends Error {
  readonly code = 'RUNG_UNSUSTAINABLE';
}
export class SegmentNotReady extends Error {
  readonly code = 'SEGMENT_NOT_READY';
}
export class SegmentFailed extends Error {
  readonly code = 'SEGMENT_FAILED';
}

export interface HlsSessionInit {
  userId: number;
  deviceKey: string;
  mediaFileId: number;
  /** The media file path. */
  input: string;
  info: VideoInfo;
  plan: SegmentPlan;
  index: KeyframeIndex | null;
  ladder: Ladder;
  caps: PipelineCaps;
  /** Burn-in source: an embedded subtitle ordinal or an extracted subtitle file. */
  burnSource: { ordinal: number } | { path: string } | null;
}

export interface HlsSessionsOptions {
  /** The segment cache directory (only ever holds our session dirs). */
  root: () => string;
  /** Disk cap in bytes for all sessions. */
  cacheBytes: () => number;
  maxStreams: () => number;
  maxPerDevice: () => number;
  /** Running legacy (progressive) video remuxes/transcodes, counted against `maxStreams`. */
  legacyActive?: () => number;
  locate: () => Promise<string | null>;
  capacity: CapacityModel;
  launcher?: HlsLauncher;
  now?: () => number;
  log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
}

interface Waiter {
  n: number;
  resolve: (path: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** One ffmpeg run of one rung, from segment `start` to (at most) `end`. */
class Encoder {
  proc: HlsProc;
  /** The segment being produced (the first not yet complete). */
  next: number;
  paused = false;
  killed = false;
  ended = false;
  /** Fragments of the segment in progress. */
  private pending: Buffer[] = [];
  private pendingSeg: number;
  private tracks: Fmp4Track[] = [];
  private deltas: Map<number, bigint> | null = null;
  private writes: Promise<void> = Promise.resolve();
  readonly startedAt: number;
  /** Speed monitor. */
  speed: number | null = null;
  private lastOut: { us: number; at: number } | null = null;
  private pausedMs = 0;
  private pausedAt: number | null = null;
  lowSince: number | null = null;
  aloneSince: number | null;
  aloneMs = 0;
  produced = 0;
  readonly stderrTail: string[] = [];

  constructor(
    readonly session: HlsSession,
    readonly rung: LadderRung,
    readonly start: number,
    readonly end: number,
    readonly spec: HlsRunSpec,
    bin: string,
    launcher: HlsLauncher,
    readonly now: () => number,
  ) {
    this.next = start;
    this.pendingSeg = start;
    this.startedAt = now();
    this.aloneSince = now();
    this.proc = launcher(bin, buildHlsArgs(spec));
    const splitter = new Fmp4Splitter(
      (init) => this.onInit(init),
      (frag) => this.onFragment(frag),
    );
    this.proc.stdout.on('data', (chunk: Buffer) => {
      try {
        splitter.push(chunk);
      } catch (err) {
        session.log?.warn({ err, session: session.id }, 'bad fragmented MP4 from ffmpeg');
        this.kill();
      }
    });
    let carry = '';
    this.proc.stderr.on('data', (chunk: Buffer) => {
      const text = carry + chunk.toString('utf8');
      const lines = text.split(/\r?\n/);
      carry = lines.pop() ?? '';
      for (const line of lines) this.onStderr(line);
    });
    void this.proc.done.then((code) => this.onExit(code));
  }

  private onInit(init: Buffer): void {
    this.tracks = initTracks(init);
    this.writes = this.writes.then(() => this.session.saveInit(this.rung.id, init));
  }

  private onFragment(frag: Fmp4Fragment): void {
    if (this.killed) return;
    const plan = this.session.plan;
    const startSec = plan.starts[this.start]!;
    if (!this.deltas) {
      // The first fragment of the run: offsets that put each track at media time.
      this.deltas = new Map();
      for (const t of frag.trafs) {
        const track = this.tracks.find((x) => x.id === t.trackId);
        if (!track) continue;
        const target = BigInt(Math.round(startSec * track.timescale));
        if (track.kind === 'video') this.deltas.set(t.trackId, target - t.decodeTime - BigInt(t.firstCts));
        else if (track.kind === 'audio') {
          const priming = this.spec.audio ? AUDIO_PRIMING[this.spec.audio.codec] : 0;
          this.deltas.set(t.trackId, target - t.decodeTime - BigInt(Math.round((priming * track.timescale) / 48_000)));
        }
      }
    }
    shiftFragment(frag, this.deltas);
    const video = frag.trafs.find((t) => this.tracks.find((x) => x.id === t.trackId)?.kind === 'video');
    let seg = this.pendingSeg;
    if (video) {
      const track = this.tracks.find((x) => x.id === video.trackId)!;
      const pts = Number(video.decodeTime + BigInt(video.firstCts)) / track.timescale;
      // A forced keyframe may land a few ms before its boundary.
      seg = Math.max(this.pendingSeg, segmentAt(plan, pts + 0.006));
    }
    if (seg !== this.pendingSeg) {
      this.complete(this.pendingSeg);
      this.pendingSeg = seg;
      this.next = seg;
      if (seg >= this.end) {
        // The run's window is done: the next run starts here.
        this.kill();
        return;
      }
    }
    this.pending.push(frag.bytes);
  }

  private complete(n: number): void {
    if (this.pending.length === 0) return;
    const bytes = Buffer.concat(this.pending);
    this.pending = [];
    this.produced++;
    this.writes = this.writes.then(() => this.session.saveSegment(this.rung.id, n, bytes));
  }

  private onStderr(line: string): void {
    const m = /^out_time_us=(-?\d+)/.exec(line);
    if (m) {
      this.onProgress(Number(m[1]));
      return;
    }
    if (/^[a-z_0-9]+=/.test(line)) return;
    if (line.trim()) {
      this.stderrTail.push(line.slice(0, 300));
      if (this.stderrTail.length > 20) this.stderrTail.shift();
    }
  }

  private onProgress(outUs: number): void {
    if (!Number.isFinite(outUs) || outUs < 0) return;
    const at = this.now();
    if (this.lastOut && outUs > this.lastOut.us && at > this.lastOut.at) {
      const dtWall = (at - this.lastOut.at - this.pausedMs) / 1000;
      if (dtWall > 0.05 && at - this.startedAt >= WARMUP_MS) {
        const inst = (outUs - this.lastOut.us) / 1e6 / dtWall;
        const alpha = 1 - Math.exp(-dtWall / EWMA_SEC);
        this.speed = this.speed === null ? inst : this.speed + alpha * (inst - this.speed);
      }
    }
    this.pausedMs = 0;
    this.lastOut = { us: outUs, at };
    this.session.onSpeed(this);
  }

  pause(): void {
    if (this.paused || this.ended) return;
    if (this.proc.pause()) {
      this.paused = true;
      this.pausedAt = this.now();
      this.trackAlone(false);
    } else {
      // No job control: stop here; a later request (or pump) restarts at the first missing segment.
      this.kill();
    }
  }

  resume(): void {
    if (!this.paused) return;
    this.proc.resume();
    this.paused = false;
    if (this.pausedAt !== null) this.pausedMs += this.now() - this.pausedAt;
    this.pausedAt = null;
    this.aloneSince = this.now();
  }

  /** Alone-on-the-resource bookkeeping (capacity history). */
  trackAlone(alone: boolean): void {
    const at = this.now();
    if (this.aloneSince !== null) this.aloneMs += at - this.aloneSince;
    this.aloneSince = alone && !this.paused ? at : null;
    if (!alone) this.aloneMs = 0;
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.proc.kill();
  }

  private async onExit(code: number | null): Promise<void> {
    // A clean exit is the end of the file: the segment in progress is complete.
    if (!this.killed && code === 0) this.complete(this.pendingSeg);
    this.pending = [];
    await this.writes.catch(() => undefined);
    this.ended = true;
    this.trackAlone(false);
    this.session.onEncoderEnd(this, code);
  }
}

export class HlsSession {
  readonly id: string;
  readonly dir: string;
  readonly createdAt: number;
  lastSeen: number;
  readonly rungs: Map<VideoHlsRungId, LadderRung>;
  encoder: Encoder | null = null;
  /** The latest requested segment (the playhead, as far as the server knows). */
  playhead: { rung: VideoHlsRungId; n: number } | null = null;
  readonly cached = new Map<VideoHlsRungId, Map<number, number>>();
  private readonly inits = new Map<VideoHlsRungId, string>();
  private readonly waiters = new Map<VideoHlsRungId, Waiter[]>();
  /** Rungs the encoder cannot keep up with (409 for their uncached segments). */
  readonly flagged = new Set<VideoHlsRungId>();
  advice: { speed: number; rung: VideoHlsRungId | null } | null = null;
  private readonly presets = new Map<VideoHlsRungId, 'veryfast' | 'superfast'>();
  private softwareOnly = false;
  private failures = 0;
  closed = false;

  constructor(
    readonly init: HlsSessionInit,
    private readonly owner: HlsSessions,
    root: string,
  ) {
    this.id = randomBytes(16).toString('hex');
    this.dir = join(root, this.id);
    this.createdAt = owner.now();
    this.lastSeen = this.createdAt;
    this.rungs = new Map(init.ladder.rungs.map((r) => [r.id, r]));
  }

  get log() {
    return this.owner.log;
  }
  get plan(): SegmentPlan {
    return this.init.plan;
  }
  get userId(): number {
    return this.init.userId;
  }

  touch(): void {
    this.lastSeen = this.owner.now();
  }

  /** Slot cost: a transcode 1, a copy 0.25. */
  get cost(): number {
    const rung = this.encoder?.rung ?? this.rungs.get(this.playhead?.rung ?? this.init.ladder.startRung);
    return rung?.mode === 'copy' ? 0.25 : 1;
  }

  private segPath(rung: VideoHlsRungId, n: number): string {
    return join(this.dir, rung, `s${n}.m4s`);
  }

  initPath(rung: VideoHlsRungId): string {
    return join(this.dir, rung, 'init.mp4');
  }

  async saveInit(rung: VideoHlsRungId, init: Buffer): Promise<void> {
    if (this.closed) return;
    const sig = initSignature(init);
    const had = this.inits.get(rung);
    if (had !== undefined && had !== sig) this.log?.warn({ session: this.id, rung }, 'HLS init segment changed between encoder runs');
    if (had === sig) return;
    this.inits.set(rung, sig);
    await this.atomicWrite(this.initPath(rung), init);
    this.wake(rung, -1);
  }

  async saveSegment(rung: VideoHlsRungId, n: number, bytes: Buffer): Promise<void> {
    if (this.closed) return;
    await this.atomicWrite(this.segPath(rung, n), bytes);
    let map = this.cached.get(rung);
    if (!map) this.cached.set(rung, (map = new Map()));
    map.set(n, bytes.length);
    this.wake(rung, n);
    this.owner.enforceCap();
  }

  private async atomicWrite(path: string, bytes: Buffer): Promise<void> {
    await mkdir(join(path, '..'), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, path);
  }

  private wake(rung: VideoHlsRungId, n: number): void {
    const list = this.waiters.get(rung);
    if (!list) return;
    const path = n < 0 ? this.initPath(rung) : this.segPath(rung, n);
    const rest: Waiter[] = [];
    for (const w of list) {
      if (w.n === n) {
        clearTimeout(w.timer);
        w.resolve(path);
      } else rest.push(w);
    }
    this.waiters.set(rung, rest);
  }

  private failWaiters(rung: VideoHlsRungId, err: Error, filter: (n: number) => boolean = () => true): void {
    const list = this.waiters.get(rung) ?? [];
    const rest: Waiter[] = [];
    for (const w of list) {
      if (filter(w.n)) {
        clearTimeout(w.timer);
        w.reject(err);
      } else rest.push(w);
    }
    this.waiters.set(rung, rest);
  }

  private wait(rung: VideoHlsRungId, n: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = this.waiters.get(rung) ?? [];
        this.waiters.set(rung, list.filter((w) => w.timer !== timer));
        reject(new SegmentNotReady('segment not ready'));
      }, this.owner.waitMs);
      timer.unref?.();
      const list = this.waiters.get(rung) ?? [];
      list.push({ n, resolve, reject, timer });
      this.waiters.set(rung, list);
    });
  }

  isCached(rung: VideoHlsRungId, n: number): boolean {
    return this.cached.get(rung)?.has(n) ?? false;
  }

  /** The init segment path, starting the rung's encoder if nothing produced it yet. */
  async initSegment(rung: VideoHlsRungId): Promise<string> {
    this.touch();
    if (!this.rungs.has(rung)) throw new SegmentFailed('no such rung');
    if (this.inits.has(rung)) return this.initPath(rung);
    if (!this.encoder || this.encoder.rung.id !== rung || this.encoder.ended) {
      if (this.flagged.has(rung)) throw new RungUnsustainable('rung unsustainable');
      // Start where the client is (or will be) so the work is not wasted.
      const n = this.playhead?.rung === rung ? this.playhead.n : this.playhead ? this.playhead.n : segmentAt(this.plan, this.owner.startHint.get(this.id) ?? 0);
      await this.restart(rung, n);
    }
    this.encoder?.resume();
    return this.wait(rung, -1);
  }

  /** A segment's file path once it exists (waits, or restarts the encoder at `n`). */
  async segment(rung: VideoHlsRungId, n: number): Promise<string> {
    this.touch();
    if (!this.rungs.has(rung) || n < 0 || n >= this.plan.starts.length) throw new SegmentFailed('no such segment');
    this.playhead = { rung, n };
    if (this.isCached(rung, n)) {
      this.pump();
      return this.segPath(rung, n);
    }
    if (this.flagged.has(rung)) throw new RungUnsustainable('rung unsustainable');
    const enc = this.encoder;
    const near = enc && !enc.killed && !enc.ended && enc.rung.id === rung && n >= enc.next && n <= enc.next + WAIT_AHEAD_SEGMENTS;
    if (!near) await this.restart(rung, n);
    else enc.resume();
    return this.wait(rung, n);
  }

  /** Kill the running encoder and start a new one for `rung` at segment `n`. */
  async restart(rung: VideoHlsRungId, n: number): Promise<void> {
    const r = this.rungs.get(rung);
    if (!r || this.closed) throw new SegmentFailed('no such rung');
    this.stopEncoder();
    const bin = await this.owner.binary();
    if (!bin) throw new SegmentFailed('ffmpeg is not installed');
    const end = r.mode === 'copy' ? this.plan.starts.length : Math.min(this.plan.starts.length, n + RUN_SEGMENTS);
    const spec = this.runSpec(r, n, end);
    const enc = new Encoder(this, r, n, end, spec, bin, this.owner.launcher, this.owner.now);
    this.encoder = enc;
    if (r.job) this.owner.capacity.begin(this.id, r.job);
    this.owner.refreshAlone();
    this.log?.info({ session: this.id, rung, segment: n, mode: r.mode, pipeline: spec.pipeline, preset: spec.preset }, 'HLS encoder started');
  }

  runSpec(r: LadderRung, n: number, end: number): HlsRunSpec {
    const { plan, info, index } = this.init;
    const startSec = plan.starts[n]!;
    const caps = this.softwareOnly ? { ...this.init.caps, pipeline: 'none' as const, hwaccel: 'none' as const } : this.init.caps;
    const pipeline = r.hdrKeep ? caps.pipeline : pipelineFor(caps, { tonemap: r.tonemap, burn: this.init.burnSource !== null });
    const keyframeTimes: number[] = [];
    for (let k = n + 1; k <= end && k < plan.starts.length; k++) keyframeTimes.push(sourceTime(plan, plan.starts[k]!));
    return {
      input: this.init.input,
      mode: r.mode,
      pipeline: r.mode === 'copy' ? 'none' : pipeline,
      caps,
      source: { codec: info.videoCodec, range: info.dynamicRange, width: info.width, height: info.height, fps: info.fps },
      ...(r.mode === 'transcode' ? { out: { width: r.width, height: r.height, kbps: r.videoKbps, codec: r.codec === 'hevc' ? 'hevc' : 'h264', hdrKeep: r.hdrKeep, tonemap: r.tonemap, ...(r.h264Level ? { h264Level: r.h264Level } : {}) } } : {}),
      audio: this.init.ladder.audio,
      burn: r.mode === 'copy' ? null : this.init.burnSource,
      seekSec: ffmpegSeek(plan, startSec),
      ...(r.mode === 'copy' && index ? { copySeekSec: Math.max(0, copySeekTarget(index, sourceTime(plan, startSec)) - plan.startTime) } : {}),
      keyframeTimes,
      preset: this.presets.get(r.id) ?? 'veryfast',
    };
  }

  stopEncoder(): void {
    const enc = this.encoder;
    if (!enc) return;
    this.encoder = null;
    enc.kill();
    this.owner.capacity.end(this.id);
    this.owner.refreshAlone();
  }

  /** Seconds the encoder is ahead of the playhead on the playhead's rung. */
  aheadSec(): number {
    const ph = this.playhead;
    if (!ph) return 0;
    const plan = this.plan;
    const enc = this.encoder;
    let edge = ph.n;
    if (enc && enc.rung.id === ph.rung && !enc.ended && enc.start <= ph.n + 1) edge = Math.max(edge, enc.next);
    else {
      const map = this.cached.get(ph.rung);
      while (map?.has(edge)) edge++;
    }
    const edgeSec = edge >= plan.starts.length ? plan.durationSec : plan.starts[edge]!;
    return Math.max(0, edgeSec - plan.starts[ph.n]!);
  }

  /** Keep the encoder between AHEAD_MIN and AHEAD_MAX ahead of the playhead. */
  pump(): void {
    if (this.closed) return;
    const ph = this.playhead;
    const enc = this.encoder;
    const idle = this.owner.now() - this.lastSeen;
    if (enc && !enc.ended && idle >= IDLE_KILL_MS) {
      this.log?.info({ session: this.id }, 'HLS encoder idle, stopped');
      this.stopEncoder();
      return;
    }
    if (!ph || idle >= IDLE_KILL_MS) return;
    const ahead = this.aheadSec();
    if (enc && !enc.ended && !enc.killed) {
      if (enc.rung.id !== ph.rung) return;
      if (ahead >= AHEAD_MAX_SEC) enc.pause();
      else if (enc.paused && ahead < AHEAD_MIN_SEC) enc.resume();
      return;
    }
    // No encoder: start one at the first missing segment when the client gets close to it.
    if (ahead >= AHEAD_MIN_SEC || this.flagged.has(ph.rung)) return;
    const map = this.cached.get(ph.rung);
    let n = ph.n;
    while (map?.has(n)) n++;
    if (n >= this.plan.starts.length) return;
    void this.restart(ph.rung, n).catch((err: unknown) => this.log?.warn({ err, session: this.id }, 'HLS encoder restart failed'));
  }

  /** Speed rules (§4.5): a preset step, then advice, then 409. */
  onSpeed(enc: Encoder): void {
    if (enc !== this.encoder || enc.speed === null || enc.rung.mode === 'copy') return;
    const at = this.owner.now();
    const ahead = this.aheadSec();
    if (enc.speed >= SAFE_SPEED) {
      enc.lowSince = null;
      if (this.advice && this.advice.rung !== null && enc.rung.id === this.advice.rung) this.advice = null;
      return;
    }
    enc.lowSince ??= at;
    if (enc.speed < 1.0 && ahead < 20) {
      this.log?.warn({ session: this.id, rung: enc.rung.id, speed: enc.speed }, 'HLS rung unsustainable');
      this.flagged.add(enc.rung.id);
      this.advice = { speed: enc.speed, rung: this.lowerRung(enc.rung.id) };
      this.stopEncoder();
      this.failWaiters(enc.rung.id, new RungUnsustainable('rung unsustainable'), (n) => !this.isCached(enc.rung.id, n));
      return;
    }
    if (at - enc.lowSince < LOW_SPEED_MS || ahead >= 60) return;
    if (isSoftware(enc.spec) && enc.spec.preset === 'veryfast') {
      this.presets.set(enc.rung.id, 'superfast');
      this.log?.info({ session: this.id, rung: enc.rung.id, speed: enc.speed }, 'HLS encoder too slow, faster preset');
      const n = enc.next;
      void this.restart(enc.rung.id, n).catch(() => undefined);
      return;
    }
    if (!this.advice) this.advice = { speed: enc.speed, rung: this.lowerRung(enc.rung.id) };
  }

  private lowerRung(id: VideoHlsRungId): VideoHlsRungId | null {
    const list = this.init.ladder.rungs;
    const i = list.findIndex((r) => r.id === id);
    return list.slice(i + 1).find((r) => !this.flagged.has(r.id))?.id ?? null;
  }

  onEncoderEnd(enc: Encoder, code: number | null): void {
    if (enc.rung.job && enc.aloneMs >= ALONE_MS && enc.speed !== null && enc.speed > 0) {
      void this.owner.capacity.record(enc.rung.job, enc.speed);
    }
    if (this.encoder === enc) {
      this.encoder = null;
      this.owner.capacity.end(this.id);
      this.owner.refreshAlone();
    }
    if (!enc.killed && code !== 0) {
      this.log?.warn({ session: this.id, rung: enc.rung.id, code, stderr: enc.stderrTail.slice(-5) }, 'HLS encoder failed');
      if (enc.produced === 0 && enc.spec.pipeline !== 'none' && !this.softwareOnly) {
        // A GPU chain that does not work for this file: software from here on.
        this.softwareOnly = true;
        const n = enc.next;
        void this.restart(enc.rung.id, n).catch(() => this.failWaiters(enc.rung.id, new SegmentFailed('encoder failed')));
        return;
      }
      this.failures++;
      this.failWaiters(enc.rung.id, new SegmentFailed('encoder failed'), (n) => !this.isCached(enc.rung.id, n));
      return;
    }
    if (enc.killed) return;
    // Clean end of the file: anything still waiting past the last segment cannot come.
    this.failWaiters(enc.rung.id, new SegmentFailed('past the end'), (n) => n >= 0 && !this.isCached(enc.rung.id, n));
    this.pump();
  }

  health(): VideoHlsHealth {
    const enc = this.encoder;
    return {
      encodeSpeed: enc?.speed !== null && enc?.speed !== undefined ? Math.round(enc.speed * 100) / 100 : null,
      aheadSec: Math.round(this.aheadSec()),
      maxSustainableRung: this.advice?.rung ?? null,
      hwaccel: (enc ? (enc.spec.mode === 'copy' ? 'none' : enc.spec.pipeline !== 'none' ? enc.spec.pipeline : isSoftware(enc.spec) ? 'none' : enc.spec.caps.hwaccel) : this.init.caps.hwaccel) as TranscodeHwaccel,
    };
  }

  /** `X-Arclight-Encode` value. */
  encodeHeader(): string | null {
    const enc = this.encoder;
    if (!enc || enc.speed === null) return this.advice ? `speed=${this.advice.speed.toFixed(2)};advice=${this.advice.rung ?? 'none'}` : null;
    const base = `speed=${enc.speed.toFixed(2)}`;
    return this.advice ? `${base};advice=${this.advice.rung ?? 'none'}` : base;
  }

  /** Evictable segments (behind the playhead only), furthest behind first. */
  evictable(): Array<{ rung: VideoHlsRungId; n: number; bytes: number }> {
    const ph = this.playhead;
    if (!ph) return [];
    const phSec = this.plan.starts[ph.n]!;
    const out: Array<{ rung: VideoHlsRungId; n: number; bytes: number; end: number }> = [];
    for (const [rung, map] of this.cached) {
      for (const [n, bytes] of map) {
        const end = n + 1 < this.plan.starts.length ? this.plan.starts[n + 1]! : this.plan.durationSec;
        if (end < phSec - KEEP_BEHIND_SEC) out.push({ rung, n, bytes, end });
      }
    }
    return out.sort((a, b) => a.end - b.end).map(({ end: _e, ...x }) => x);
  }

  async evict(rung: VideoHlsRungId, n: number): Promise<void> {
    this.cached.get(rung)?.delete(n);
    await rm(this.segPath(rung, n), { force: true });
  }

  get bytes(): number {
    let sum = 0;
    for (const map of this.cached.values()) for (const b of map.values()) sum += b;
    return sum;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopEncoder();
    for (const rung of this.waiters.keys()) this.failWaiters(rung, new SegmentFailed('session closed'));
    await rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** All HLS sessions of the server. */
export class HlsSessions {
  private readonly sessions = new Map<string, HlsSession>();
  readonly launcher: HlsLauncher;
  readonly now: () => number;
  readonly capacity: CapacityModel;
  readonly log: HlsSessionsOptions['log'];
  /** Media time the session was created for (for an init request before any segment). */
  readonly startHint = new Map<string, number>();
  waitMs = WAIT_MS;
  private bin: Promise<string | null> | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private evicting = false;

  constructor(private readonly opts: HlsSessionsOptions) {
    this.launcher = opts.launcher ?? spawnHls;
    this.now = opts.now ?? Date.now;
    this.capacity = opts.capacity;
    this.log = opts.log;
  }

  binary(): Promise<string | null> {
    this.bin ??= this.opts.locate().then((b) => {
      if (!b) this.bin = undefined;
      return b;
    });
    return this.bin;
  }

  /** Removes everything in the cache directory (left over from a previous run) and starts the timer. */
  async start(): Promise<void> {
    await this.sweep();
    await this.capacity.load();
    this.timer ??= setInterval(() => void this.tick(), 1000);
    this.timer.unref?.();
  }

  async sweep(): Promise<void> {
    const root = this.opts.root();
    try {
      for (const name of await readdir(root)) if (/^[0-9a-f]{32}$/.test(name)) await rm(join(root, name), { recursive: true, force: true });
    } catch {
      // nothing there yet
    }
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Slots in use (transcode 1, copy 0.25), legacy streams included. */
  slotsInUse(exceptDevice?: string): number {
    let used = this.opts.legacyActive?.() ?? 0;
    for (const s of this.sessions.values()) {
      if (s.init.deviceKey === exceptDevice) continue;
      if (this.now() - s.lastSeen < IDLE_KILL_MS || (s.encoder && !s.encoder.ended)) used += s.cost;
    }
    return used;
  }

  /**
   * A new session. One on the same device replaces the old one; the server-wide slot cap counts
   * running work (copy 0.25, transcode 1). Throws TranscodeBusy when full.
   */
  async create(init: HlsSessionInit, startSec = 0): Promise<HlsSession> {
    const sameDevice = [...this.sessions.values()].filter((s) => s.init.userId === init.userId && s.init.deviceKey === init.deviceKey);
    const cost = init.ladder.rungs.find((r) => r.id === init.ladder.startRung)?.mode === 'copy' ? 0.25 : 1;
    const used = this.slotsInUse(init.deviceKey);
    if (used + cost > this.opts.maxStreams() + 1e-9) throw new TranscodeBusy('video streams are all in use');
    const perDevice = this.opts.maxPerDevice();
    // Older sessions of this device beyond its cap make way (the newest replaces the oldest).
    const sorted = sameDevice.sort((a, b) => a.createdAt - b.createdAt);
    const drop = sorted.slice(0, Math.max(0, sorted.length - perDevice + 1));
    for (const s of drop) await this.delete(s.id);
    const session = new HlsSession(init, this, this.opts.root());
    this.sessions.set(session.id, session);
    this.startHint.set(session.id, startSec);
    await mkdir(session.dir, { recursive: true });
    return session;
  }

  get(id: string): HlsSession | null {
    return this.sessions.get(id) ?? null;
  }

  async delete(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    this.sessions.delete(id);
    this.startHint.delete(id);
    await s.close();
    return true;
  }

  /** Every second: ahead window, idle encoders and sessions. */
  async tick(): Promise<void> {
    const at = this.now();
    for (const s of [...this.sessions.values()]) {
      if (at - s.lastSeen >= IDLE_DELETE_MS) {
        this.log?.info({ session: s.id }, 'HLS session idle, removed');
        await this.delete(s.id);
        continue;
      }
      s.pump();
    }
  }

  /** Who is alone on their resource (capacity history is only recorded for those). */
  refreshAlone(): void {
    const running = [...this.sessions.values()].map((s) => s.encoder).filter((e): e is Encoder => !!e && !e.ended && !e.killed && e.rung.job !== null);
    for (const e of running) {
      const res = resourceOf(e.rung.job!);
      const alone = running.filter((o) => o !== e && resourceOf(o.rung.job!) === res).length === 0;
      e.trackAlone(alone);
    }
  }

  totalBytes(): number {
    let sum = 0;
    for (const s of this.sessions.values()) sum += s.bytes;
    return sum;
  }

  /** Disk cap: segments behind the playhead go, oldest sessions first. */
  enforceCap(): void {
    if (this.evicting) return;
    const cap = this.opts.cacheBytes();
    if (this.totalBytes() <= cap) return;
    this.evicting = true;
    void (async () => {
      try {
        const sessions = [...this.sessions.values()].sort((a, b) => a.createdAt - b.createdAt);
        for (const s of sessions) {
          for (const seg of s.evictable()) {
            if (this.totalBytes() <= cap) return;
            await s.evict(seg.rung, seg.n);
          }
        }
      } finally {
        this.evicting = false;
      }
    })();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const id of [...this.sessions.keys()]) await this.delete(id);
  }

  /** For tests and the health route. */
  sessionsOf(userId: number): HlsSession[] {
    return [...this.sessions.values()].filter((s) => s.userId === userId);
  }
}

/** The segment cache directory: the setting's folder gets our own subfolder (never swept itself). */
export function hlsCacheRoot(configDir: string, customPath: string | null): string {
  return customPath ? join(customPath, 'arclight-hls') : join(configDir, 'cache', 'player', 'hls');
}

/** Bytes of a file (0 when missing). */
export async function fileBytes(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

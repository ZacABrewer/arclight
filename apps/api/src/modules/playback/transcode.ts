import { spawn, type ChildProcess } from 'node:child_process';
import { Transform, pipeline, type Readable } from 'node:stream';
import { locateFfmpeg } from '../transcode/runner.js';
import { fileInput } from '../transcode/input-protocols.js';

// Live audio transcodes for the player: one ffmpeg per request, writing to stdout, which the
// stream route pipes to the client (chunked, no ranges; seeking restarts with `startMs`). Audio
// is cheap enough for software encoding, so there is no hardware path. A small cap keeps a burst
// of clients from starving the box, and a per-user cap keeps one user from taking every slot (a
// user's newest request replaces their oldest: seeks and skips start a new transcode before the
// old connection is gone). The process is killed as soon as the client goes away, and also when
// the client stops reading for STALL_KILL_MS (a paused tab holding the connection open).

export type TranscodeFormat = 'aac' | 'opus' | 'mp3';

/** Default bitrate per format when the client names none. */
export const DEFAULT_BITRATE_KBPS: Record<TranscodeFormat, number> = { aac: 192, opus: 128, mp3: 256 };
/** At most this many audio transcodes run at once (the next one gets 503). */
export const MAX_AUDIO_TRANSCODES = 6;
/** At most this many per user; a newer request replaces that user's oldest. */
export const MAX_AUDIO_TRANSCODES_PER_USER = 2;
/** A transcode whose output nobody read for this long is killed. */
export const STALL_KILL_MS = 60_000;

/** What the client receives for each format. */
export const TRANSCODE_MIME: Record<TranscodeFormat, string> = { aac: 'audio/aac', opus: 'audio/ogg', mp3: 'audio/mpeg' };

export interface AudioTranscodeSpec {
  format: TranscodeFormat;
  bitrateKbps: number;
  /** Start this far into the file. */
  startMs?: number | undefined;
  /** Source channel count when known; more than two are downmixed to stereo. */
  channels?: number | null | undefined;
}

/** The ffmpeg argv for a live audio transcode of `input` to stdout. */
export function buildAudioTranscodeArgs(input: string, spec: AudioTranscodeSpec): string[] {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (spec.startMs && spec.startMs > 0) args.push('-ss', (spec.startMs / 1000).toFixed(3));
  args.push(...fileInput(input), '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1');
  if (spec.channels && spec.channels > 2) args.push('-ac', '2');
  const kbps = `${Math.round(spec.bitrateKbps)}k`;
  switch (spec.format) {
    case 'aac':
      args.push('-c:a', 'aac', '-b:a', kbps, '-f', 'adts');
      break;
    case 'opus':
      // libopus takes 48 kHz (or a fraction of it); ask for it so any source rate works.
      args.push('-c:a', 'libopus', '-b:a', kbps, '-vbr', 'on', '-ar', '48000', '-f', 'ogg');
      break;
    case 'mp3':
      args.push('-c:a', 'libmp3lame', '-b:a', kbps, '-f', 'mp3');
      break;
  }
  args.push('pipe:1');
  return args;
}

/** A running transcode: its output and a way to stop it. */
export interface RunningTranscode {
  stdout: Readable;
  kill(): void;
  /** Resolves when the process has ended (normally or killed). */
  done: Promise<void>;
}

/** Starts ffmpeg; tests pass a fake. */
export type TranscodeLauncher = (binary: string, args: readonly string[]) => RunningTranscode;

export const spawnTranscode: TranscodeLauncher = (binary, args) => {
  const child: ChildProcess = spawn(binary, [...args], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const done = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
    child.once('error', () => resolve());
  });
  return {
    stdout: child.stdout!,
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    },
    done,
  };
};

export class TranscodeBusy extends Error {
  readonly code = 'TRANSCODE_BUSY';
}
export class FfmpegMissing extends Error {
  readonly code = 'FFMPEG_MISSING';
}

export interface AudioTranscoderOptions {
  launcher?: TranscodeLauncher;
  /** Resolves the ffmpeg binary (default: locateFfmpeg, cached). */
  locate?: () => Promise<string | null>;
  /** A number, or a getter read on every start (limits that follow settings). */
  max?: number | (() => number);
  maxPerUser?: number | (() => number);
  stallMs?: number;
  /** Names the work in busy errors (default "audio"). */
  label?: string;
}

/** Who a transcode runs for: the user id, or null (an API key without a user: no per-user cap). */
export type TranscodeOwner = number | null;

interface Slot {
  owner: TranscodeOwner;
  kill: () => void;
}

/** Runs live audio transcodes under a global and a per-user concurrency cap. */
export class AudioTranscoder {
  private readonly launcher: TranscodeLauncher;
  private readonly locate: () => Promise<string | null>;
  private readonly maxOf: () => number;
  private readonly maxPerUserOf: () => number;
  private readonly stallMs: number;
  private readonly label: string;
  private binary: Promise<string | null> | undefined;
  /** Running transcodes, oldest first. */
  private readonly slots: Slot[] = [];

  constructor(opts: AudioTranscoderOptions = {}) {
    this.launcher = opts.launcher ?? spawnTranscode;
    this.locate = opts.locate ?? (() => locateFfmpeg());
    const max = opts.max ?? MAX_AUDIO_TRANSCODES;
    const maxPerUser = opts.maxPerUser ?? MAX_AUDIO_TRANSCODES_PER_USER;
    this.maxOf = typeof max === 'function' ? max : () => max;
    this.maxPerUserOf = typeof maxPerUser === 'function' ? maxPerUser : () => maxPerUser;
    this.stallMs = opts.stallMs ?? STALL_KILL_MS;
    this.label = opts.label ?? 'audio';
  }

  private get max(): number {
    return Math.max(1, this.maxOf());
  }

  private get maxPerUser(): number {
    return Math.max(1, this.maxPerUserOf());
  }

  get active(): number {
    return this.slots.length;
  }

  /** Running transcodes of one owner. */
  activeFor(owner: TranscodeOwner): number {
    return this.slots.filter((s) => s.owner === owner).length;
  }

  /** Whether start() for `owner` would get a slot now (it may preempt their own oldest). */
  canStart(owner: TranscodeOwner): boolean {
    return this.slots.length < this.max || (owner !== null && this.activeFor(owner) > 0);
  }

  /**
   * Makes room for `owner`: at their own cap, or at the global cap while they hold a slot, their
   * oldest transcode is killed. Throws TranscodeBusy when the box is full with other users' work.
   */
  private makeRoom(owner: TranscodeOwner): void {
    const mine = owner === null ? [] : this.slots.filter((s) => s.owner === owner);
    if (owner !== null && mine.length >= this.maxPerUser) mine[0]!.kill();
    if (this.slots.length < this.max) return;
    const oldestMine = owner === null ? undefined : this.slots.find((s) => s.owner === owner);
    if (oldestMine) oldestMine.kill();
    if (this.slots.length >= this.max) throw new TranscodeBusy(`too many ${this.label} transcodes running (${this.max}); try again shortly`);
  }

  /** Starts a transcode; throws TranscodeBusy at the cap and FfmpegMissing without ffmpeg. */
  start(input: string, spec: AudioTranscodeSpec, owner: TranscodeOwner = null): Promise<RunningTranscode> {
    return this.startArgs(buildAudioTranscodeArgs(input, spec), owner);
  }

  /** The ffmpeg binary this transcoder runs, or null when there is none. */
  async binaryPath(): Promise<string | null> {
    this.binary ??= this.locate();
    const bin = await this.binary;
    if (!bin) this.binary = undefined;
    return bin;
  }

  /** Starts ffmpeg with a ready argv (writing to pipe:1) under the same caps and watchdog. */
  async startArgs(args: readonly string[], owner: TranscodeOwner = null): Promise<RunningTranscode> {
    if (!this.canStart(owner)) {
      throw new TranscodeBusy(`too many ${this.label} transcodes running (${this.max}); try again shortly`);
    }
    this.binary ??= this.locate();
    const bin = await this.binary;
    if (!bin) {
      // Look again next time: ffmpeg may be installed later.
      this.binary = undefined;
      throw new FfmpegMissing('ffmpeg was not found (set ARCLIGHT_FFMPEG or put ffmpeg on PATH)');
    }
    this.makeRoom(owner);
    const proc = this.launcher(bin, args);
    let released = false;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const slot: Slot = {
      owner,
      kill: () => {
        proc.kill();
        release();
      },
    };
    const release = () => {
      if (released) return;
      released = true;
      if (stallTimer) clearTimeout(stallTimer);
      const i = this.slots.indexOf(slot);
      if (i >= 0) this.slots.splice(i, 1);
    };
    this.slots.push(slot);
    void proc.done.then(release);

    // Output passes through a watchdog: the pipe only moves chunks while the client reads (it
    // respects backpressure), so no chunk for stallMs means a stalled client.
    stallTimer = setTimeout(() => slot.kill(), this.stallMs);
    stallTimer.unref?.();
    const watched = new Transform({
      transform(chunk, _enc, cb) {
        stallTimer?.refresh();
        cb(null, chunk);
      },
    });
    // A kill (stall, preempted) ends ffmpeg's stdout, and with it the client's response.
    pipeline(proc.stdout, watched, () => {
      if (stallTimer) clearTimeout(stallTimer);
    });
    return { stdout: watched, done: proc.done, kill: slot.kill };
  }
}

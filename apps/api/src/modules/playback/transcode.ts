import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { locateFfmpeg } from '../transcode/runner.js';

// Live audio transcodes for the player: one ffmpeg per request, writing to stdout, which the
// stream route pipes to the client (chunked, no ranges; seeking restarts with `startMs`). Audio
// is cheap enough for software encoding, so there is no hardware path. A small cap keeps a burst
// of clients from starving the box; the process is killed as soon as the client goes away.

export type TranscodeFormat = 'aac' | 'opus' | 'mp3';

/** Default bitrate per format when the client names none. */
export const DEFAULT_BITRATE_KBPS: Record<TranscodeFormat, number> = { aac: 192, opus: 128, mp3: 256 };
/** At most this many audio transcodes run at once (the next one gets 503). */
export const MAX_AUDIO_TRANSCODES = 6;

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
  args.push('-i', input, '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1');
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
  max?: number;
}

/** Runs live audio transcodes under a concurrency cap. */
export class AudioTranscoder {
  private readonly launcher: TranscodeLauncher;
  private readonly locate: () => Promise<string | null>;
  private readonly max: number;
  private binary: Promise<string | null> | undefined;
  private running = 0;

  constructor(opts: AudioTranscoderOptions = {}) {
    this.launcher = opts.launcher ?? spawnTranscode;
    this.locate = opts.locate ?? (() => locateFfmpeg());
    this.max = opts.max ?? MAX_AUDIO_TRANSCODES;
  }

  get active(): number {
    return this.running;
  }

  /** Starts a transcode; throws TranscodeBusy at the cap and FfmpegMissing without ffmpeg. */
  async start(input: string, spec: AudioTranscodeSpec): Promise<RunningTranscode> {
    if (this.running >= this.max) throw new TranscodeBusy(`too many audio transcodes running (${this.max}); try again shortly`);
    this.binary ??= this.locate();
    const bin = await this.binary;
    if (!bin) {
      // Look again next time: ffmpeg may be installed later.
      this.binary = undefined;
      throw new FfmpegMissing('ffmpeg was not found (set ARCLIGHT_FFMPEG or put ffmpeg on PATH)');
    }
    if (this.running >= this.max) throw new TranscodeBusy(`too many audio transcodes running (${this.max}); try again shortly`);
    this.running += 1;
    const proc = this.launcher(bin, buildAudioTranscodeArgs(input, spec));
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.running -= 1;
    };
    void proc.done.then(release);
    return {
      stdout: proc.stdout,
      done: proc.done,
      kill: () => {
        proc.kill();
        release();
      },
    };
  }
}

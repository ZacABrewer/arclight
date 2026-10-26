import type { MediaInfo } from '@arclight/shared';

// `ffmpeg -progress pipe:1` writes blocks of key=value lines, each closed by
// `progress=continue` (or `progress=end` for the last one). The position is reported as
// `out_time_us` (microseconds), `out_time_ms` (also microseconds, despite the name) and
// `out_time` (HH:MM:SS.micro); any may be `N/A` early on.

export interface ProgressUpdate {
  /** Output position in ms; null when ffmpeg has not reported one yet. */
  outTimeMs: number | null;
  /** 0-100, or null when the duration is unknown. `progress=end` always gives 100. */
  percent: number | null;
  done: boolean;
}

/** Source duration in ms from media info; null when unknown. */
export function durationMsOf(info: MediaInfo | null | undefined): number | null {
  if (!info) return null;
  if (info.durationMs != null && info.durationMs > 0) return info.durationMs;
  if (info.runtimeSeconds != null && info.runtimeSeconds > 0) return info.runtimeSeconds * 1000;
  return null;
}

function parseClock(value: string): number | null {
  const m = /^(-)?(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(value.trim());
  if (!m) return null;
  const ms = (Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4])) * 1000;
  return m[1] ? 0 : ms;
}

function micros(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value.trim());
  return Number.isFinite(n) && value.trim() !== '' ? Math.max(0, n / 1000) : null;
}

/** One block's key/values -> an update. */
export function progressFromBlock(values: ReadonlyMap<string, string>, durationMs: number | null): ProgressUpdate {
  const done = values.get('progress') === 'end';
  let outTimeMs = micros(values.get('out_time_us')) ?? micros(values.get('out_time_ms'));
  if (outTimeMs === null) {
    const clock = values.get('out_time');
    outTimeMs = clock ? parseClock(clock) : null;
  }
  let percent: number | null = null;
  if (done) percent = 100;
  else if (outTimeMs !== null && durationMs !== null && durationMs > 0) {
    percent = Math.min(99.9, Math.max(0, (outTimeMs / durationMs) * 100));
    percent = Math.round(percent * 10) / 10;
  }
  return { outTimeMs, percent, done };
}

/** Streaming parser: feed stdout chunks, get one update per completed block. */
export class FfmpegProgressParser {
  private buffer = '';
  private block = new Map<string, string>();

  constructor(private readonly durationMs: number | null) {}

  push(chunk: string): ProgressUpdate[] {
    this.buffer += chunk;
    const out: ProgressUpdate[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '').trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      this.block.set(key, value);
      if (key === 'progress') {
        out.push(progressFromBlock(this.block, this.durationMs));
        this.block = new Map();
      }
    }
    return out;
  }
}

/** Convenience for whole outputs (tests). Returns the last update, or null. */
export function parseProgressOutput(text: string, durationMs: number | null): ProgressUpdate | null {
  const updates = new FfmpegProgressParser(durationMs).push(text.endsWith('\n') ? text : `${text}\n`);
  return updates.at(-1) ?? null;
}

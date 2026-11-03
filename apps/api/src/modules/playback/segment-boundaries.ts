import { spawn } from 'node:child_process';
import { setPriority } from 'node:os';

// Boundary snapping for detected intros and recaps. An audio match puts an edge within a second
// or two of where the shared audio starts or stops; the cut itself is usually a short black frame
// or a moment of silence. A few seconds around each edge are decoded with ffmpeg's `blackdetect`
// (video) and `silencedetect` (audio) filters, and the edge moves to the end of the nearest such
// gap within ±2 s: the point where the next thing (the intro, the episode) begins.

/** How far an edge may move. */
export const SNAP_MS = 2_000;
/** Decoded around each edge: SNAP_MS either side plus room for a gap that reaches past it. */
const PROBE_PAD_MS = 2_500;

/** A black or silent stretch, on the file's timeline. */
export interface QuietGap {
  kind: 'black' | 'silence';
  startMs: number;
  endMs: number;
}

/** The window decoded around an edge at `atMs`. */
export function probeWindow(atMs: number, durationMs: number): { startMs: number; lengthMs: number } {
  const startMs = Math.max(0, Math.round(atMs - PROBE_PAD_MS));
  const endMs = Math.min(durationMs > 0 ? durationMs : Number.POSITIVE_INFINITY, Math.round(atMs + PROBE_PAD_MS));
  return { startMs, lengthMs: Math.max(0, endMs - startMs) };
}

/**
 * ffmpeg arguments that decode one window and log black frames (≥ 0.1 s, video scaled down first:
 * blackdetect only looks at luma) and silence (≤ -50 dB for ≥ 0.3 s) to stderr, writing nothing.
 */
export function buildBoundaryProbeArgs(input: string, audioOrdinal: number, hasVideo: boolean, startMs: number, lengthMs: number): string[] {
  const secs = (ms: number) => (ms / 1000).toFixed(3);
  return [
    '-nostdin',
    '-hide_banner',
    '-nostats',
    '-v',
    'info',
    ...(startMs > 0 ? ['-ss', secs(startMs)] : []),
    '-t',
    secs(lengthMs),
    '-i',
    input,
    ...(hasVideo ? ['-map', '0:v:0', '-vf', 'scale=160:-2,blackdetect=d=0.1:pix_th=0.10'] : []),
    '-map',
    `0:a:${audioOrdinal}`,
    '-af',
    'silencedetect=n=-50dB:d=0.3',
    '-f',
    'null',
    '-',
  ];
}

/**
 * The gaps logged by one probe, moved onto the file's timeline (`startMs`: where the window
 * starts; the filters count from 0). A gap still open when the window ends runs to its end.
 */
export function parseQuietGaps(log: string, startMs: number, lengthMs: number): QuietGap[] {
  const out: QuietGap[] = [];
  const ms = (s: string) => Math.round(startMs + Math.max(0, Number(s)) * 1000);
  for (const m of log.matchAll(/black_start:\s*(-?[\d.]+)\s+black_end:\s*(-?[\d.]+)/g)) out.push({ kind: 'black', startMs: ms(m[1]!), endMs: ms(m[2]!) });
  let open: number | null = null;
  for (const m of log.matchAll(/silence_(start|end):\s*(-?[\d.]+)/g)) {
    if (m[1] === 'start') open = ms(m[2]!);
    else if (open !== null) {
      out.push({ kind: 'silence', startMs: open, endMs: ms(m[2]!) });
      open = null;
    }
  }
  if (open !== null) out.push({ kind: 'silence', startMs: open, endMs: startMs + lengthMs });
  return out.filter((g) => g.endMs > g.startMs).sort((a, b) => a.startMs - b.startMs);
}

/** `atMs` moved to the end of the nearest gap whose end lies within ±SNAP_MS; unchanged when none does. */
export function snapToGap(atMs: number, gaps: readonly QuietGap[]): number {
  let best: number | null = null;
  for (const g of gaps) {
    const d = Math.abs(g.endMs - atMs);
    // A gap that contains the edge counts too (the edge is inside the black/silence).
    const inside = atMs >= g.startMs && atMs <= g.endMs;
    if (d > SNAP_MS && !inside) continue;
    if (best === null || d < Math.abs(best - atMs)) best = g.endMs;
  }
  return best ?? atMs;
}

/** Runs ffmpeg at low priority and returns its stderr (the filters' log); rejects on a non-zero exit. */
export type LogRunner = (bin: string, args: readonly string[], timeoutMs: number) => Promise<string>;

export const ffmpegLog: LogRunner = (bin, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    if (child.pid !== undefined) {
      try {
        setPriority(child.pid, 10);
      } catch {
        // not permitted here: normal priority
      }
    }
    let err = '';
    child.stderr!.on('data', (c: Buffer) => {
      if (err.length < 256_000) err += c.toString();
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(err);
      else reject(new Error(`ffmpeg exited with ${code}: ${err.trim().slice(-300)}`));
    });
  });

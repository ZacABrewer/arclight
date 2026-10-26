import { convertToSrt, detectFormat, parseSrt, type Cue } from './formats.js';
import { buildAlassCommand, buildFfsubsyncCommand, type CommandDescriptor } from './postprocess.js';

// Sync-quality scoring. Two ways to measure how well a subtitle's timing matches its video:
//
//  - builtin: ffmpeg reports where the audio is active (silencedetect or ebur128) over one or
//    more windows; speech onsets are compared to cue starts by cross-correlating the two sparse
//    event sets (Gaussian kernel, symmetric score) over a grid of offsets and frame-rate ratios,
//    then refined by a trimmed least-squares fit over the matched pairs.
//  - tool: the configured sync tool (ffsubsync / alass) writes a corrected copy to a scratch
//    path; the per-cue difference between the original and the corrected copy is the error.
//
// Either way the result is `offsetMs` (add to the subtitle's times to align them at t = 0),
// `driftPpm` (scale error: corrected = offset + (1 + drift / 1e6) x original) and a 0-100
// `syncScore` derived from the mean absolute timing error over every cue. Nothing here runs a
// process; the api module runs the descriptors through its process runner.

export interface TimeInterval {
  startMs: number;
  endMs: number;
}

/** A stretch of the media whose audio was analysed (absolute media time). */
export interface AudioWindow {
  startMs: number;
  durationMs: number;
}

export type AudioDetector = 'silencedetect' | 'ebur128';
export type SyncCheckMethod = 'builtin' | 'ffsubsync' | 'alass';

export interface AudioActivityOptions {
  ffmpegPath?: string | undefined;
  input: string;
  window: AudioWindow;
  detector?: AudioDetector | undefined;
  /** ffmpeg stream specifier of the audio to analyse. Default first audio stream. */
  audioStream?: string | undefined;
  /** silencedetect: level below which audio counts as silence (dB). Default -30. */
  noiseDb?: number | undefined;
  /** silencedetect: shortest silence that splits speech (ms). Default 300. */
  minSilenceMs?: number | undefined;
  timeoutMs?: number | undefined;
}

const secs = (ms: number) => (Math.round(ms) / 1000).toFixed(3);

/**
 * ffmpeg reading one window of audio and logging its activity to stderr. Input seeking
 * (`-ss` before `-i`) makes the logged timestamps relative to the window start.
 */
export function buildAudioActivityCommand(o: AudioActivityOptions): CommandDescriptor {
  const detector = o.detector ?? 'silencedetect';
  const filter =
    detector === 'ebur128'
      ? 'ebur128=framelog=info'
      : `silencedetect=noise=${o.noiseDb ?? -30}dB:d=${secs(o.minSilenceMs ?? 300)}`;
  const args = [
    '-nostdin', '-hide_banner', '-nostats',
    '-ss', secs(o.window.startMs),
    '-t', secs(o.window.durationMs),
    '-i', o.input,
    '-map', o.audioStream ?? '0:a:0',
    '-vn', '-sn', '-dn',
    '-af', filter,
    '-f', 'null', '-',
  ];
  return { command: o.ffmpegPath ?? 'ffmpeg', args, timeoutMs: o.timeoutMs ?? 300_000 };
}

/** Windows to analyse: the start, plus a second one later on for long media (drift). */
export function planAudioWindows(lastCueMs: number, windowMs: number): AudioWindow[] {
  const first: AudioWindow = { startMs: 0, durationMs: windowMs };
  if (lastCueMs <= windowMs * 3) return [first];
  const second = Math.max(windowMs, Math.round(lastCueMs * 0.6));
  return [first, { startMs: second, durationMs: Math.round(windowMs / 2) }];
}

/** Speech (non-silent) intervals from silencedetect output, in absolute media time. */
export function parseSilenceDetect(stderr: string, window: AudioWindow): TimeInterval[] {
  const silences: TimeInterval[] = [];
  let open: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const start = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (start) {
      open = Math.max(0, Number(start[1]) * 1000);
      continue;
    }
    const end = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (end) {
      silences.push({ startMs: open ?? 0, endMs: Number(end[1]) * 1000 });
      open = null;
    }
  }
  if (open !== null) silences.push({ startMs: open, endMs: window.durationMs });
  const speech: TimeInterval[] = [];
  let cursor = 0;
  for (const s of silences) {
    if (s.startMs > cursor) speech.push({ startMs: cursor, endMs: Math.min(s.startMs, window.durationMs) });
    cursor = Math.max(cursor, s.endMs);
  }
  if (cursor < window.durationMs) speech.push({ startMs: cursor, endMs: window.durationMs });
  return speech
    .filter((i) => i.endMs - i.startMs >= 1)
    .map((i) => ({ startMs: Math.round(window.startMs + i.startMs), endMs: Math.round(window.startMs + i.endMs) }));
}

export interface Ebur128Options {
  /** Momentary loudness at or above this counts as active (LUFS). Default -40. */
  gateLufs?: number | undefined;
  /** Gaps shorter than this are bridged (ms). Default 300. */
  bridgeMs?: number | undefined;
  /** Shorter activity is dropped (ms). Default 200. */
  minActiveMs?: number | undefined;
}

/** Active intervals from ebur128 frame logs (`t: … M: …`), in absolute media time. */
export function parseEbur128(stderr: string, window: AudioWindow, o: Ebur128Options = {}): TimeInterval[] {
  const gate = o.gateLufs ?? -40;
  const frames: Array<{ t: number; active: boolean }> = [];
  for (const line of stderr.split(/\r?\n/)) {
    const m = /\bt:\s*([\d.]+)\s.*?\bM:\s*(-?[\d.]+|-?inf|nan)/i.exec(line);
    if (!m) continue;
    const loud = Number(m[2]);
    frames.push({ t: Number(m[1]) * 1000, active: Number.isFinite(loud) && loud >= gate });
  }
  const raw: TimeInterval[] = [];
  let prevT = 0;
  for (const f of frames) {
    const from = Math.max(0, Math.min(prevT, f.t - 100));
    if (f.active) {
      const last = raw[raw.length - 1];
      if (last && from - last.endMs <= (o.bridgeMs ?? 300)) last.endMs = f.t;
      else raw.push({ startMs: from, endMs: f.t });
    }
    prevT = f.t;
  }
  return raw
    .filter((i) => i.endMs - i.startMs >= (o.minActiveMs ?? 200))
    .map((i) => ({ startMs: Math.round(window.startMs + i.startMs), endMs: Math.round(window.startMs + i.endMs) }));
}

/** Cues from subtitle text in any supported text format (sorted by start). */
export function parseCues(text: string, fileName?: string): Cue[] {
  const format = detectFormat(text, fileName);
  const srt = format === 'srt' ? text : convertToSrt(text, format === 'unknown' ? undefined : format);
  if (!srt) return [];
  return parseSrt(srt).sort((a, b) => a.startMs - b.startMs);
}

// ---------------------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------------------

export interface SyncEstimate {
  method: SyncCheckMethod;
  /** Enough signal to trust the numbers; when false the numbers are null. */
  reliable: boolean;
  /** 0-100 (100 = within ~0.1 s everywhere). */
  syncScore: number | null;
  /** Shift to add to the subtitle at t = 0, ms (positive: the subtitle is early). */
  offsetMs: number | null;
  /** Scale error in parts per million (25 vs 23.976 fps is about 42 700). */
  driftPpm: number | null;
  /** Mean absolute timing error over all cues, ms. */
  meanErrorMs: number | null;
  /** Correlation peak above the chance level (builtin) or 1 (tool), 0..1. */
  confidence: number;
  /** Cue starts matched to speech onsets (builtin) or cues compared (tool). */
  matched: number;
  message: string;
}

/** Mean absolute error (ms) -> 0-100: 100 up to 100 ms, 86 at 300 ms, 50 at 600 ms, 20 at 1.1 s. */
export function syncScoreFromError(meanAbsErrorMs: number): number {
  const over = Math.max(0, meanAbsErrorMs - 100) / 500;
  return Math.round(100 / (1 + over * over));
}

/** Frame-rate ratios searched besides 1 (the usual 23.976/24/25 mix-ups). */
export const DEFAULT_SYNC_RATIOS: readonly number[] = [1, 25 / 23.976, 23.976 / 25, 24 / 23.976, 23.976 / 24, 25 / 24, 24 / 25];

export interface EstimateOptions {
  /** Windows the speech intervals cover; cues outside them are not correlated. */
  windows: readonly AudioWindow[];
  maxOffsetMs?: number | undefined;
  ratios?: readonly number[] | undefined;
  /** Kernel width (ms). Default 300. */
  sigmaMs?: number | undefined;
  /** Minimum matched pairs for a reliable result. Default 8. */
  minMatched?: number | undefined;
  /** Minimum peak-above-chance for a reliable result. Default 0.2 (aligned ~0.55, unrelated ~0.1). */
  minConfidence?: number | undefined;
}

/** Index of the first element >= x in a sorted array. */
function lowerBound(sorted: readonly number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function nearestDistance(sorted: readonly number[], x: number): number {
  if (sorted.length === 0) return Infinity;
  const i = lowerBound(sorted, x);
  let best = Infinity;
  if (i < sorted.length) best = sorted[i]! - x;
  if (i > 0) best = Math.min(best, x - sorted[i - 1]!);
  return best;
}

function nearest(sorted: readonly number[], x: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const i = lowerBound(sorted, x);
  const a = i < sorted.length ? sorted[i]! : undefined;
  const b = i > 0 ? sorted[i - 1]! : undefined;
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a - x <= x - b ? a : b;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const inWindows = (t: number, windows: readonly AudioWindow[]) => windows.some((w) => t >= w.startMs && t <= w.startMs + w.durationMs);

/** Speech onsets: interval starts, minus those that only mark the start of a window. */
export function speechOnsets(intervals: readonly TimeInterval[], windows: readonly AudioWindow[]): number[] {
  return intervals
    .map((i) => i.startMs)
    .filter((t) => !windows.some((w) => Math.abs(t - w.startMs) < 50))
    .sort((a, b) => a - b);
}

/**
 * Symmetric kernel agreement between transformed cue starts and speech onsets, both limited
 * to the analysed windows: (sum over cues of K(nearest onset) + sum over onsets of K(nearest
 * cue)) / (cues + onsets). 1 = every event has a partner at the same instant.
 */
function agreement(cueStarts: readonly number[], onsets: readonly number[], windows: readonly AudioWindow[], offset: number, ratio: number, inv2s2: number, minCues: number): number {
  const moved: number[] = [];
  for (const t of cueStarts) {
    const x = ratio * t + offset;
    if (inWindows(x, windows)) moved.push(x);
  }
  if (moved.length < minCues || onsets.length === 0) return 0;
  let sum = 0;
  for (const x of moved) {
    const d = nearestDistance(onsets, x);
    sum += Math.exp(-d * d * inv2s2);
  }
  for (const o of onsets) {
    const d = nearestDistance(moved, o);
    sum += Math.exp(-d * d * inv2s2);
  }
  return sum / (moved.length + onsets.length);
}

interface LineFit {
  a: number;
  b: number;
  n: number;
  /** Standard error of the slope. */
  seB: number;
}

function fitLine(xs: readonly number[], ys: readonly number[]): LineFit | null {
  const n = xs.length;
  if (n < 2) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i]!;
    my += ys[i]!;
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i]! - mx) ** 2;
    sxy += (xs[i]! - mx) * (ys[i]! - my);
  }
  if (sxx === 0) return { a: my - mx, b: 1, n, seB: Infinity };
  const b = sxy / sxx;
  const a = my - b * mx;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (ys[i]! - a - b * xs[i]!) ** 2;
  const seB = n > 2 ? Math.sqrt(ss / (n - 2)) / Math.sqrt(sxx) : Infinity;
  return { a, b, n, seB };
}

/**
 * Robust fit y = a + b x: least squares, drop residuals beyond 3 MAD (floor 50 ms), refit.
 * A slope not significantly different from `prior` (3 standard errors) is snapped to it and the
 * intercept becomes the median residual, so noise does not turn into a fake drift.
 */
export function robustTimingFit(xs: readonly number[], ys: readonly number[], prior = 1): { a: number; b: number; n: number } | null {
  let fit = fitLine(xs, ys);
  if (!fit) return null;
  const resid = xs.map((x, i) => ys[i]! - fit!.a - fit!.b * x);
  const mad = median(resid.map((r) => Math.abs(r - median(resid)))) * 1.4826;
  const limit = Math.max(50, 3 * mad);
  const keepX: number[] = [];
  const keepY: number[] = [];
  resid.forEach((r, i) => {
    if (Math.abs(r) <= limit) {
      keepX.push(xs[i]!);
      keepY.push(ys[i]!);
    }
  });
  if (keepX.length >= 2 && keepX.length < xs.length) fit = fitLine(keepX, keepY) ?? fit;
  const usedX = keepX.length >= 2 ? keepX : [...xs];
  const usedY = keepX.length >= 2 ? keepY : [...ys];
  if (!Number.isFinite(fit.seB) || Math.abs(fit.b - prior) < 3 * fit.seB) {
    const a = median(usedY.map((y, i) => y - prior * usedX[i]!));
    return { a, b: prior, n: usedX.length };
  }
  return { a: fit.a, b: fit.b, n: usedX.length };
}

/** Mean |correction| over every cue start for corrected = a + b t. */
function meanError(cueStarts: readonly number[], a: number, b: number): number {
  if (cueStarts.length === 0) return 0;
  let s = 0;
  for (const t of cueStarts) s += Math.abs(a + (b - 1) * t);
  return s / cueStarts.length;
}

function unreliable(method: SyncCheckMethod, message: string, confidence = 0, matched = 0): SyncEstimate {
  return { method, reliable: false, syncScore: null, offsetMs: null, driftPpm: null, meanErrorMs: null, confidence, matched, message };
}

/**
 * Builtin estimate: correlate cue starts with speech onsets over a grid of offsets (step sigma/2,
 * +-maxOffset) and frame-rate ratios, refine the offset (10 ms) and the ratio (+-2000 ppm in
 * 250 ppm steps), then fit the matched pairs.
 */
export function estimateSync(speech: readonly TimeInterval[], cues: readonly Cue[], o: EstimateOptions): SyncEstimate {
  const sigma = o.sigmaMs ?? 300;
  const inv2s2 = 1 / (2 * sigma * sigma);
  const maxOffset = o.maxOffsetMs ?? 60_000;
  const minMatched = o.minMatched ?? 8;
  const allStarts = cues.map((c) => c.startMs).sort((a, b) => a - b);
  const onsets = speechOnsets(speech, o.windows);
  if (allStarts.length < minMatched) return unreliable('builtin', `only ${allStarts.length} cue(s) in the subtitle`);
  if (onsets.length < minMatched) return unreliable('builtin', `only ${onsets.length} speech onset(s) detected`);
  // Cues that can land in a window under any searched transform.
  const maxRatio = Math.max(...(o.ratios ?? DEFAULT_SYNC_RATIOS)) * 1.01;
  const minRatio = Math.min(...(o.ratios ?? DEFAULT_SYNC_RATIOS)) * 0.99;
  const candidates = allStarts.filter((t) =>
    o.windows.some((w) => maxRatio * t + maxOffset >= w.startMs && minRatio * t - maxOffset <= w.startMs + w.durationMs),
  );

  const score = (offset: number, ratio: number) => agreement(candidates, onsets, o.windows, offset, ratio, inv2s2, minMatched);
  const coarseStep = Math.max(10, sigma / 2);
  let best = { offset: 0, ratio: 1, value: -1 };
  const valuesByRatio = new Map<number, number[]>();
  for (const ratio of o.ratios ?? DEFAULT_SYNC_RATIOS) {
    const values: number[] = [];
    valuesByRatio.set(ratio, values);
    for (let off = -maxOffset; off <= maxOffset; off += coarseStep) {
      const v = score(off, ratio);
      values.push(v);
      // Ties go to the smaller correction (ratio 1 is searched first).
      if (v > best.value + 1e-9 || (Math.abs(v - best.value) <= 1e-9 && ratio === best.ratio && Math.abs(off) < Math.abs(best.offset))) {
        best = { offset: off, ratio, value: v };
      }
    }
  }
  const bestRatioValues = valuesByRatio.get(best.ratio) ?? [];
  const coarseRatio = best.ratio;
  // Ratio refinement around the coarse winner (small drifts are not in the ratio list).
  for (let ppm = -2000; ppm <= 2000; ppm += 250) {
    if (ppm === 0) continue;
    const ratio = best.ratio * (1 + ppm / 1e6);
    for (let off = best.offset - 5000; off <= best.offset + 5000; off += coarseStep) {
      const v = score(off, ratio);
      if (v > best.value + 1e-12) best = { offset: off, ratio, value: v };
    }
  }
  for (let off = best.offset - sigma; off <= best.offset + sigma; off += 10) {
    const v = score(off, best.ratio);
    if (v > best.value + 1e-12) best = { offset: off, ratio: best.ratio, value: v };
  }
  const chance = median(bestRatioValues);
  const confidence = Math.max(0, best.value - chance);

  // Pairs: cue start (original time) -> nearest onset under the best transform.
  const xs: number[] = [];
  const ys: number[] = [];
  for (const t of candidates) {
    const x = best.ratio * t + best.offset;
    if (!inWindows(x, o.windows)) continue;
    const on = nearest(onsets, x);
    if (on !== undefined && Math.abs(on - x) <= 2 * sigma) {
      xs.push(t);
      ys.push(on);
    }
  }
  const round3 = (n: number) => Math.round(n * 1000) / 1000;
  if (xs.length < minMatched || confidence < (o.minConfidence ?? 0.2)) {
    return unreliable('builtin', `no clear alignment (confidence ${round3(confidence)}, ${xs.length} matched cue(s))`, round3(confidence), xs.length);
  }
  const fit = robustTimingFit(xs, ys, coarseRatio) ?? { a: best.offset, b: best.ratio, n: xs.length };
  const mae = meanError(allStarts, fit.a, fit.b);
  const syncScore = syncScoreFromError(mae);
  const offsetMs = Math.round(fit.a) || 0;
  const driftPpm = Math.round((fit.b - 1) * 1e6) || 0;
  return {
    method: 'builtin',
    reliable: true,
    syncScore,
    offsetMs,
    driftPpm,
    meanErrorMs: Math.round(mae),
    confidence: round3(confidence),
    matched: fit.n,
    message: describeEstimate(syncScore, offsetMs, driftPpm),
  };
}

export function describeEstimate(score: number, offsetMs: number, driftPpm: number): string {
  const off = `${offsetMs >= 0 ? '+' : ''}${(offsetMs / 1000).toFixed(3)} s`;
  const drift = driftPpm === 0 ? 'no drift' : `drift ${driftPpm > 0 ? '+' : ''}${driftPpm} ppm`;
  return `Sync score ${score}: offset ${off}, ${drift}.`;
}

/**
 * Tool estimate: compare cue starts of the original and the tool's corrected copy (paired by
 * index; tools keep the cue list). The tool's correction is the error.
 */
export function compareTimings(original: readonly Cue[], corrected: readonly Cue[], method: Exclude<SyncCheckMethod, 'builtin'>): SyncEstimate {
  const n = Math.min(original.length, corrected.length);
  if (n < 3) return unreliable(method, `${method} output has ${corrected.length} cue(s)`);
  if (Math.abs(original.length - corrected.length) > Math.max(2, original.length * 0.1)) {
    return unreliable(method, `${method} output has ${corrected.length} cues, the original ${original.length}`);
  }
  const xs: number[] = [];
  const ys: number[] = [];
  let abs = 0;
  for (let i = 0; i < n; i++) {
    xs.push(original[i]!.startMs);
    ys.push(corrected[i]!.startMs);
    abs += Math.abs(corrected[i]!.startMs - original[i]!.startMs);
  }
  const fit = robustTimingFit(xs, ys, 1) ?? { a: 0, b: 1, n };
  const mae = abs / n;
  const syncScore = syncScoreFromError(mae);
  const offsetMs = Math.round(fit.a) || 0;
  const driftPpm = Math.round((fit.b - 1) * 1e6) || 0;
  return { method, reliable: true, syncScore, offsetMs, driftPpm, meanErrorMs: Math.round(mae), confidence: 1, matched: n, message: describeEstimate(syncScore, offsetMs, driftPpm) };
}

/** Scratch output for a tool check: `<name>.synccheck.<ext>`. */
export function syncCheckOutputPath(subtitlePath: string): string {
  const dot = subtitlePath.lastIndexOf('.');
  return dot > 0 ? `${subtitlePath.slice(0, dot)}.synccheck${subtitlePath.slice(dot)}` : `${subtitlePath}.synccheck`;
}

export interface SyncCheckCommandOptions {
  tool: 'ffsubsync' | 'alass';
  binary?: string | undefined;
  video: string;
  subtitle: string;
  maxOffsetSeconds?: number | undefined;
  gss?: boolean | undefined;
  timeoutMs?: number | undefined;
}

/**
 * The sync tool in "check" mode: it writes its corrected copy to the scratch path (deleted after
 * comparison). ffsubsync runs with --no-fix-framerate so the measured offset is a pure shift;
 * alass runs with fps guessing disabled for the same reason.
 */
export function buildSyncCheckCommand(o: SyncCheckCommandOptions): CommandDescriptor & { output: string } {
  const output = syncCheckOutputPath(o.subtitle);
  const cmd =
    o.tool === 'alass'
      ? buildAlassCommand({ binary: o.binary, reference: o.video, subtitle: o.subtitle, output, disableFpsGuessing: true, timeoutMs: o.timeoutMs })
      : buildFfsubsyncCommand({
          binary: o.binary,
          reference: o.video,
          subtitle: o.subtitle,
          output,
          maxOffsetSeconds: o.maxOffsetSeconds,
          noFixFramerate: true,
          gss: o.gss,
          timeoutMs: o.timeoutMs,
        });
  return { ...cmd, output };
}

/** R-style auto actions: what to do after a check. Thresholds of 0 disable an action. */
export interface SyncAutoActionSettings {
  autoFixBelow: number;
  autoRetryProviderBelow: number;
}

export type SyncAutoAction = 'none' | 'fix' | 'retry';

/**
 * Decide the next step for a reliable estimate: fix when the score is below `autoFixBelow`
 * (and no fix was tried yet), else retry the provider when below `autoRetryProviderBelow`
 * (only for provider downloads). Unreliable estimates never trigger anything.
 */
export function syncAutoAction(estimate: Pick<SyncEstimate, 'reliable' | 'syncScore'>, s: SyncAutoActionSettings, state: { fixed: boolean; fromProvider: boolean }): SyncAutoAction {
  if (!estimate.reliable || estimate.syncScore === null) return 'none';
  if (!state.fixed && s.autoFixBelow > 0 && estimate.syncScore < s.autoFixBelow) return 'fix';
  if (state.fromProvider && s.autoRetryProviderBelow > 0 && estimate.syncScore < s.autoRetryProviderBelow) return 'retry';
  return 'none';
}

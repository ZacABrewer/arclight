import type { KeyframeIndex } from './keyframes.js';

// The segment plan of a file: where every HLS segment starts, shared by all rungs of a session.
// With a keyframe index the boundaries are source keyframes (copied segments can only start
// there), grouped greedily towards 6 s (3 s minimum, 10 s maximum; a longer GOP is one segment).
// Transcode rungs force keyframes at exactly these times, so all variants line up and players
// switch between them at any segment. Without an index: a uniform 6 s grid (transcode rungs only).

export const SEGMENT_TARGET_SEC = 6;
export const SEGMENT_MIN_SEC = 3;
export const SEGMENT_MAX_SEC = 10;

export interface SegmentPlan {
  /** Start of each segment, seconds of media time. starts[0] is the first keyframe (usually 0). */
  starts: number[];
  /** Duration of each segment (the first one counts from 0). */
  durations: number[];
  durationSec: number;
  /** True: boundaries are source keyframes (the src rung may be offered). */
  keyframeAligned: boolean;
  /** Bytes of the file inside each segment (from keyframe positions), when known. */
  bytes: number[] | null;
  /** Source timestamp of media time 0 (MPEG-TS files start at about 1.4 s; others at 0). */
  base: number;
  /** Container start time: ffmpeg's input -ss counts from it. */
  startTime: number;
}

const EPS = 1e-6;

/** Greedy keyframe groups towards `target`. */
export function planFromKeyframes(keyframes: readonly number[], durationSec: number, opts: { target?: number; min?: number; max?: number } = {}): number[] {
  const target = opts.target ?? SEGMENT_TARGET_SEC;
  const min = opts.min ?? SEGMENT_MIN_SEC;
  const max = opts.max ?? SEGMENT_MAX_SEC;
  const kf = keyframes.filter((t) => t >= 0 && t < durationSec - EPS);
  if (kf.length === 0) return [0];
  const starts = [kf[0]!];
  let i = 0;
  for (;;) {
    const s = starts[starts.length - 1]!;
    // Candidates within [s + min, s + max]: the one closest to s + target.
    let best = -1;
    let bestDist = Infinity;
    for (let j = i + 1; j < kf.length; j++) {
      const d = kf[j]! - s;
      if (d > max + EPS) break;
      if (d + EPS >= min) {
        const dist = Math.abs(d - target);
        if (dist < bestDist) {
          bestDist = dist;
          best = j;
        }
      }
    }
    // No keyframe in range: the first one past the maximum (a long GOP is one segment); none: the tail.
    if (best < 0) {
      best = kf.findIndex((t) => t - s > max + EPS);
      if (best < 0) break;
    }
    starts.push(kf[best]!);
    i = best;
  }
  // A tail shorter than the minimum joins the previous segment.
  while (starts.length > 1 && durationSec - starts[starts.length - 1]! < min - EPS) starts.pop();
  return starts;
}

/** A uniform grid (no keyframe index yet). */
export function uniformStarts(durationSec: number, target = SEGMENT_TARGET_SEC): number[] {
  const starts: number[] = [];
  for (let t = 0; t < durationSec - EPS; t += target) starts.push(Math.round(t * 1000) / 1000);
  if (starts.length === 0) starts.push(0);
  while (starts.length > 1 && durationSec - starts[starts.length - 1]! < SEGMENT_MIN_SEC - EPS) starts.pop();
  return starts;
}

function withDurations(starts: number[], durationSec: number, keyframeAligned: boolean, bytes: number[] | null, base = 0, startTime = 0): SegmentPlan {
  const durations = starts.map((s, i) => (i + 1 < starts.length ? starts[i + 1]! : durationSec) - (i === 0 ? 0 : s));
  return { starts, durations: durations.map((d) => Math.max(0.001, Math.round(d * 1e6) / 1e6)), durationSec, keyframeAligned, bytes, base, startTime };
}

/** A container whose timestamps start later than this keeps its offset out of media time. */
const BASE_THRESHOLD_SEC = 0.5;

/** ffmpeg's input -ss for media time `sec`. */
export const ffmpegSeek = (plan: Pick<SegmentPlan, 'base' | 'startTime'>, sec: number): number => Math.max(0, sec + plan.base - plan.startTime);

/** The source timestamp of media time `sec` (what -copyts outputs and -force_key_frames compares). */
export const sourceTime = (plan: Pick<SegmentPlan, 'base'>, sec: number): number => sec + plan.base;

/** The plan for a file: from its keyframe index, else the uniform grid. */
export function segmentPlan(index: KeyframeIndex | null, durationSec: number): SegmentPlan {
  const startTime = index?.startTime ?? 0;
  const base = startTime > BASE_THRESHOLD_SEC ? startTime : 0;
  if (!index || index.keyframes.length < 2 || durationSec <= 0) return withDurations(uniformStarts(Math.max(durationSec, 1)), Math.max(durationSec, 1), false, null, base, startTime);
  const media = index.keyframes.map((t) => Math.round((t - base) * 1e6) / 1e6);
  const starts = planFromKeyframes(media, durationSec);
  let bytes: number[] | null = null;
  if (index.positions) {
    const pos = new Map(media.map((t, i) => [t, index.positions![i]!]));
    const at = starts.map((s) => pos.get(s) ?? -1);
    if (at.every((p) => p >= 0)) bytes = at.map((p, i) => Math.max(0, (i + 1 < at.length ? at[i + 1]! : index.fileSize) - p));
  }
  return withDurations(starts, durationSec, true, bytes, base, startTime);
}

/** Peak and average kbit/s of the file over the plan's segments (null without byte positions). */
export function planBitrates(plan: SegmentPlan, fileSize: number): { peakKbps: number; avgKbps: number } | null {
  if (plan.durationSec <= 0) return null;
  const avgKbps = Math.round((fileSize * 8) / plan.durationSec / 1000);
  if (!plan.bytes) return null;
  let peak = 0;
  plan.bytes.forEach((b, i) => {
    const d = plan.durations[i]!;
    if (d >= 1) peak = Math.max(peak, (b * 8) / d / 1000);
  });
  return { peakKbps: Math.round(Math.max(peak, avgKbps)), avgKbps };
}

/** The segment that contains media time `sec`. */
export function segmentAt(plan: Pick<SegmentPlan, 'starts'>, sec: number): number {
  const s = plan.starts;
  let lo = 0;
  let hi = s.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid]! <= sec + 1e-3) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

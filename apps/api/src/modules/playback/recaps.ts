import { CHROMA_BYTES, CHROMA_STEP, FRAME_MS, matchClipsSteps, mergeRanges, runSteps, type Print, type Steps } from './fingerprint.js';

// Recap ("Previously on ...") detection. A recap is a run of short clips from earlier episodes
// near the start of an episode, before its intro. The episode's first minutes (the candidate)
// are matched clip by clip against the rest of up to three earlier episodes: their head, body and
// tail fingerprints with their own intro and credits blanked out (those are shared by every
// episode and are not a recap). Every stretch of at least 3 s found at any offset counts.
//
// The matches are grouped (a gap of more than GROUP_GAP_MS ends a group); the first group is the
// recap when it starts within RECAP_START_MS, its clips cover at least RECAP_COVERAGE of it and at
// least RECAP_MIN_MS in total. It then runs from its first clip to its last, from 0 when the first
// clip is that close to the start, and up to the intro when its end is within 3 s of it.
//
// Matching uses the band codes only. Recap clips are the same recording as the scene they come
// from, which the codes find even with speech; chroma at clip length (1-3 s) would also match
// recurring score cues that are not a recap.

/** The candidate is at most this long, and never reaches into the intro. */
export const RECAP_WINDOW_MS = 180_000;
/** The share of the recap span its clips must cover, and their least total. */
export const RECAP_COVERAGE = 0.4;
export const RECAP_MIN_MS = 10_000;
/** The first clip must start this early. */
export const RECAP_START_MS = 30_000;
/** Clips further apart than this are different groups. */
const GROUP_GAP_MS = 15_000;
/** Edges this close to the start of the file or to the intro move onto them. */
const EDGE_SNAP_MS = 3_000;

export interface RecapPart {
  /** Where the part starts in its file. */
  startMs: number;
  print: Print;
}

/** One earlier episode: its parts, and the ranges (its intro, its credits) not to match against. */
export interface RecapReference {
  parts: readonly RecapPart[];
  blank: ReadonlyArray<{ startMs: number; endMs: number }>;
}

export interface FoundRecap {
  startMs: number;
  endMs: number;
  /** Share of the recap span covered by matched clips (0-1). */
  confidence: number;
}

/** The first `frames` codes of a print (and the chroma vectors they own). */
function head(p: Print, frames: number): Print {
  const n = Math.min(frames, p.codes.length);
  return { codes: p.codes.subarray(0, n), chroma: null };
}

/** A part with the `blank` ranges zeroed (zero codes never vote and match at chance). */
function blanked(part: RecapPart, blank: RecapReference['blank']): Print {
  const codes = Uint32Array.from(part.print.codes);
  for (const r of blank) {
    const from = Math.max(0, Math.floor((r.startMs - part.startMs) / FRAME_MS));
    const to = Math.min(codes.length, Math.ceil((r.endMs - part.startMs) / FRAME_MS));
    if (to > from) codes.fill(0, from, to);
  }
  return { codes, chroma: null };
}

/** Recap of an episode from its head print and earlier episodes, or null. */
export function findRecap(headPart: RecapPart, introStartMs: number | null, refs: readonly RecapReference[]): FoundRecap | null {
  return runSteps(findRecapSteps(headPart, introStartMs, refs));
}

export function* findRecapSteps(headPart: RecapPart, introStartMs: number | null, refs: readonly RecapReference[]): Steps<FoundRecap | null> {
  if (headPart.startMs !== 0) return null;
  const candMs = Math.min(RECAP_WINDOW_MS, introStartMs ?? RECAP_WINDOW_MS, headPart.print.codes.length * FRAME_MS);
  if (candMs < RECAP_MIN_MS) return null;
  const cand = head(headPart.print, Math.floor(candMs / FRAME_MS));
  const found: Array<{ start: number; end: number }> = [];
  for (const ref of refs) {
    for (const part of ref.parts) {
      if (part.print.codes.length === 0) continue;
      found.push(...(yield* matchClipsSteps(cand, blanked(part, ref.blank))));
    }
  }
  const clips = mergeRanges(found).map((r) => ({ startMs: r.start * FRAME_MS, endMs: Math.min(candMs, r.end * FRAME_MS) }));
  if (clips.length === 0 || clips[0]!.startMs > RECAP_START_MS) return null;
  const group = [clips[0]!];
  for (const c of clips.slice(1)) {
    if (c.startMs - group[group.length - 1]!.endMs > GROUP_GAP_MS) break;
    group.push(c);
  }
  const covered = group.reduce((s, c) => s + (c.endMs - c.startMs), 0);
  let startMs = group[0]!.startMs;
  let endMs = group[group.length - 1]!.endMs;
  const span = endMs - startMs;
  if (covered < RECAP_MIN_MS || covered < RECAP_COVERAGE * span) return null;
  if (startMs <= EDGE_SNAP_MS) startMs = 0;
  if (introStartMs !== null && Math.abs(introStartMs - endMs) <= EDGE_SNAP_MS) endMs = introStartMs;
  if (introStartMs !== null) endMs = Math.min(endMs, introStartMs);
  if (endMs - startMs < RECAP_MIN_MS) return null;
  return { startMs: Math.round(startMs), endMs: Math.round(endMs), confidence: Math.min(1, Math.round((covered / span) * 100) / 100) };
}

/** Chroma bytes a print of `codes` codes carries (for cost estimates). */
export const chromaBytesFor = (codes: number) => Math.ceil(codes / CHROMA_STEP) * CHROMA_BYTES;

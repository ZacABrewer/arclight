import { describe, expect, it } from 'vitest';
import { alignCodes, alignPrints, analyse, CHROMA_BYTES, CHROMA_STEP, chromaCorr, chromaFromBlob, chromaToBlob, chromaUnits, fingerprint, FRAME_MS, SAMPLE_RATE } from './fingerprint.js';
import { chordTheme, episode, mix, speechLike } from './fingerprint.fixtures.js';
import { detectSeason, windowOf, type EpisodeCodes } from './segments.js';

// The chroma fingerprint (features-spec §5.9): an intro with dialogue over its music. The band
// codes follow 300-3000 Hz, where speech is loudest, so they lose such an intro; the chroma
// follows the harmony and keeps it.

const S = SAMPLE_RATE;
// 240 s: the 96 s head window holds every intro below.
const EP_SECONDS = 240;
const INTRO_SECONDS = 40;
const STARTS = [12.3456, 31.1, 5.77, 22.0213];
const theme = chordTheme(INTRO_SECONDS, 11);

/** Quiet low-passed noise (room tone): white noise through a one-pole filter. */
function bed(seconds: number, seed: number): Int16Array {
  const n = episode(seconds, seed, new Int16Array(0), 0);
  let y = 0;
  return n.map((v) => {
    y = 0.95 * y + 0.05 * v;
    return Math.round(y * 2);
  }) as Int16Array;
}

/**
 * Episode i: a quiet noise bed, dialogue (its own) all the way through, and the theme mixed in
 * at half level at STARTS[i]. With `clearTail` the dialogue pauses for the theme's last 10 s.
 */
function dialogueEpisode(i: number, clearTail: boolean): Int16Array {
  const speech = speechLike(EP_SECONDS, 700 + i);
  const at = Math.round(STARTS[i]! * S);
  if (clearTail) speech.fill(0, at + (INTRO_SECONDS - 10) * S, at + INTRO_SECONDS * S);
  const music = new Int16Array(EP_SECONDS * S);
  music.set(theme, at);
  return mix(mix(bed(EP_SECONDS, 300 + i), speech), music, 0.5);
}

const headOf = (pcm: Int16Array) => pcm.subarray(0, (windowOf('head', EP_SECONDS * 1000).lengthMs * S) / 1000);

function pairResults(clearTail: boolean) {
  const prints = STARTS.map((_, i) => analyse(headOf(dialogueEpisode(i, clearTail))));
  let codeHits = 0;
  let printHits = 0;
  let pairs = 0;
  const errors: number[] = [];
  for (let a = 0; a < prints.length; a++) {
    for (let b = 0; b < prints.length; b++) {
      if (a === b) continue;
      pairs++;
      const ok = (run: { startA: number; endA: number } | null) => {
        if (!run || (run.endA - run.startA) * FRAME_MS < 15_000) return null;
        return Math.max(Math.abs(run.startA * FRAME_MS - STARTS[a]! * 1000), Math.abs(run.endA * FRAME_MS - (STARTS[a]! + INTRO_SECONDS) * 1000));
      };
      const c = ok(alignCodes(prints[a]!.codes, prints[b]!.codes));
      if (c !== null && c <= 3000) codeHits++;
      const p = ok(alignPrints(prints[a]!, prints[b]!));
      if (p !== null) errors.push(p);
      if (p !== null && p <= 3000) printHits++;
    }
  }
  return { prints, codeHits, printHits, pairs, errors };
}

// Whole-episode FFTs: slow on a busy machine.
describe('chroma fingerprint', { timeout: 120_000 }, () => {
  it('stores 12 four-bit classes per vector and round-trips the blob', () => {
    const p = analyse(theme);
    expect(p.chroma).not.toBeNull();
    expect(p.chroma!.length).toBe(Math.ceil(p.codes.length / CHROMA_STEP) * CHROMA_BYTES);
    expect(chromaFromBlob(chromaToBlob(p.chroma!))).toEqual(p.chroma);
    // Same codes as the plain fingerprint.
    expect(p.codes).toEqual(fingerprint(theme));
  });

  it('noise and silence are hardly tonal; the same chords correlate under dialogue, other chords do not', () => {
    const noise = chromaUnits(analyse(episode(10, 3, new Int16Array(0), 0)).chroma!);
    const count = noise.length / 12;
    const live = Array.from({ length: count }, (_, i) => noise.subarray(i * 12, i * 12 + 12).some((v) => v !== 0)).filter(Boolean).length;
    expect(live).toBeLessThanOrEqual(count / 4);
    expect(analyse(new Int16Array(10 * S)).chroma!.every((v) => v === 0)).toBe(true);
    const a = chromaUnits(analyse(theme).chroma!);
    const b = chromaUnits(analyse(mix(theme, speechLike(INTRO_SECONDS, 5), 1)).chroma!);
    const other = chromaUnits(analyse(chordTheme(INTRO_SECONDS, 23)).chroma!);
    const n = a.length / 12;
    let same = 0;
    let diff = 0;
    for (let i = 8; i < n - 8; i++) {
      same += chromaCorr(a, i, b, i);
      diff += chromaCorr(a, i, other, i);
    }
    expect(same / (n - 16)).toBeGreaterThan(diff / (n - 16) + 0.2);
  });

  const seasonOf = (prints: ReturnType<typeof analyse>[]): EpisodeCodes[] =>
    prints.map((p, i) => ({ mediaFileId: i + 1, durationMs: EP_SECONDS * 1000, head: { ...windowOf('head', EP_SECONDS * 1000), codes: p.codes, chroma: p.chroma }, tail: null }));

  for (const clearTail of [true, false]) {
    it(`dialogue over ${clearTail ? 'the first 30 s' : 'all 40 s'} of the theme: codes lose the intro, prints find it`, () => {
      const r = pairResults(clearTail);
      // Pairs (of 12) with a run within 3 s of the intro's edges.
      expect(r.codeHits).toBe(0);
      expect(r.printHits).toBeGreaterThanOrEqual(9);
      const found = detectSeason(seasonOf(r.prints));
      expect(found.filter((s) => s.type === 'intro')).toHaveLength(4);
      for (const s of found) {
        const at = STARTS[s.mediaFileId - 1]! * 1000;
        expect(Math.abs(s.startMs - at), `start of ${s.mediaFileId}`).toBeLessThanOrEqual(2500);
        expect(Math.abs(s.endMs - (at + INTRO_SECONDS * 1000)), `end of ${s.mediaFileId}`).toBeLessThanOrEqual(1000);
      }
    });
  }

  it('different music in the same key, under dialogue, is not an intro', () => {
    const prints = STARTS.map((start, i) => {
      const music = new Int16Array(EP_SECONDS * S);
      music.set(chordTheme(INTRO_SECONDS, 40 + i), Math.round(start * S));
      return analyse(headOf(mix(mix(bed(EP_SECONDS, 300 + i), speechLike(EP_SECONDS, 700 + i)), music, 0.5)));
    });
    expect(detectSeason(seasonOf(prints))).toEqual([]);
  });
});

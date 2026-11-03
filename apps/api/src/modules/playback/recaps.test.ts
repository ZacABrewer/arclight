import { describe, expect, it } from 'vitest';
import { analyse, fingerprint, FRAME_MS, SAMPLE_RATE } from './fingerprint.js';
import { episode, rng } from './fingerprint.fixtures.js';
import { findRecap, RECAP_MIN_MS, type RecapReference } from './recaps.js';
import { detectSeason, windowOf, type EpisodeCodes } from './segments.js';

// Recap detection (features-spec §5.9): an episode opens with clips of earlier episodes, then the
// intro. Synthetic: every episode is its own noise "scenes" with a shared intro; episode N's recap
// is cut from scenes of N-1 (and N-2).

const S = SAMPLE_RATE;
const EP_SECONDS = 300;

/** Episode i: its own noise, the shared intro at `introAt` s, and `recap` clips copied in at the start. */
function makeEpisode(i: number, intro: Int16Array, introAt: number, recap: ReadonlyArray<{ from: Int16Array; fromS: number; lenS: number }>): Int16Array {
  const pcm = episode(EP_SECONDS, 5000 + i, intro, Math.round(introAt * S));
  let at = 0;
  for (const c of recap) {
    pcm.set(c.from.subarray(Math.round(c.fromS * S), Math.round((c.fromS + c.lenS) * S)), Math.round(at * S));
    at += c.lenS;
  }
  return pcm;
}

/** A tonal "intro" that the noise episodes do not share otherwise. */
function introTheme(seconds: number): Int16Array {
  const out = new Int16Array(seconds * S);
  const r = rng(77);
  for (let i = 0; i < out.length; i++) {
    const t = i / S;
    out[i] = Math.round(5000 * Math.sin(2 * Math.PI * (500 + 300 * (Math.floor(t * 2) % 5)) * t) + 2500 * (r() * 2 - 1));
  }
  return out;
}

const slice = (pcm: Int16Array, w: { startMs: number; lengthMs: number }) => pcm.subarray(Math.round((w.startMs * S) / 1000), Math.round(((w.startMs + w.lengthMs) * S) / 1000));

function codesOf(pcm: Int16Array, durationMs: number, id: number, withBody: boolean): EpisodeCodes {
  const head = windowOf('head', durationMs);
  const tail = windowOf('tail', durationMs);
  const body = windowOf('body', durationMs);
  const h = analyse(slice(pcm, head));
  const t = analyse(slice(pcm, tail));
  return {
    mediaFileId: id,
    durationMs,
    head: { ...head, codes: h.codes, chroma: h.chroma },
    tail: { ...tail, codes: t.codes, chroma: t.chroma },
    body: withBody ? { ...body, codes: fingerprint(slice(pcm, body)) } : null,
  };
}

describe('recaps', () => {
  const intro = introTheme(40);
  const introAt = [20, 60, 30, 45];
  // Episode 1 has none; 2 recaps 1; 3 recaps 2 and 1; 4 recaps 3.
  const pcms: Int16Array[] = [];
  pcms[0] = makeEpisode(0, intro, introAt[0]!, []);
  pcms[1] = makeEpisode(1, intro, introAt[1]!, [
    { from: pcms[0]!, fromS: 150, lenS: 6 },
    { from: pcms[0]!, fromS: 200, lenS: 4 },
    { from: pcms[0]!, fromS: 95, lenS: 5 },
    { from: pcms[0]!, fromS: 250, lenS: 7 },
    { from: pcms[0]!, fromS: 175, lenS: 4 },
    { from: pcms[0]!, fromS: 230, lenS: 8 },
    { from: pcms[0]!, fromS: 120, lenS: 6 },
    { from: pcms[0]!, fromS: 270, lenS: 5 },
    { from: pcms[0]!, fromS: 140, lenS: 4 },
    { from: pcms[0]!, fromS: 210, lenS: 7 },
  ]);
  pcms[2] = makeEpisode(2, intro, introAt[2]!, [
    { from: pcms[1]!, fromS: 160, lenS: 8 },
    { from: pcms[1]!, fromS: 125, lenS: 5 },
    { from: pcms[0]!, fromS: 110, lenS: 5 },
    { from: pcms[1]!, fromS: 260, lenS: 6 },
    { from: pcms[1]!, fromS: 186, lenS: 6 },
  ]);
  pcms[3] = makeEpisode(3, intro, introAt[3]!, [
    { from: pcms[2]!, fromS: 100, lenS: 10 },
    { from: pcms[2]!, fromS: 200, lenS: 15 },
    { from: pcms[2]!, fromS: 280, lenS: 10 },
    { from: pcms[2]!, fromS: 150, lenS: 10 },
  ]);
  const recapEnd = [0, 56, 30, 45];

  it('finds each recap from its start to the intro, and none in the first episode', () => {
    const durationMs = EP_SECONDS * 1000;
    const eps = pcms.map((p, i) => codesOf(p, durationMs, i + 1, true));
    const found = detectSeason(eps, { recaps: true });
    for (let i = 0; i < 4; i++) {
      const introSeg = found.find((s) => s.mediaFileId === i + 1 && s.type === 'intro');
      expect(introSeg, `intro ${i + 1}`).toBeDefined();
      const recap = found.find((s) => s.mediaFileId === i + 1 && s.type === 'recap');
      if (i === 0) {
        expect(recap, 'episode 1 has no recap').toBeUndefined();
        continue;
      }
      expect(recap, `recap ${i + 1}`).toBeDefined();
      expect(recap!.startMs).toBe(0);
      expect(Math.abs(recap!.endMs - recapEnd[i]! * 1000), `recap end ${i + 1}`).toBeLessThanOrEqual(3000);
      expect(recap!.endMs).toBeLessThanOrEqual(introSeg!.startMs);
      expect(recap!.confidence).toBeGreaterThan(0.5);
    }
  });

  it('recaps off: nothing is looked for', () => {
    const durationMs = EP_SECONDS * 1000;
    const eps = pcms.map((p, i) => codesOf(p, durationMs, i + 1, true));
    expect(detectSeason(eps, { recaps: false }).some((s) => s.type === 'recap')).toBe(false);
  });

  it('the intro is never a recap, and a short match is not enough', () => {
    const headMs = windowOf('head', EP_SECONDS * 1000);
    // Episode 1's own intro is shared with episode 2 but is blanked in the reference.
    const a = analyse(slice(pcms[0]!, headMs));
    const b = analyse(slice(pcms[2]!, headMs));
    const ref: RecapReference = { parts: [{ startMs: 0, print: { codes: a.codes, chroma: null } }], blank: [{ startMs: introAt[0]! * 1000, endMs: (introAt[0]! + 40) * 1000 }] };
    // Episode 3's candidate stops at its intro (30 s); its recap is not from episode 1's head.
    expect(findRecap({ startMs: 0, print: { codes: b.codes, chroma: null } }, null, [ref])).toBeNull();
    // A lone 6 s clip at the start is below RECAP_MIN_MS.
    const lone = makeEpisode(9, intro, 80, [{ from: pcms[0]!, fromS: 10, lenS: 6 }]);
    const l = fingerprint(slice(lone, headMs));
    const r0: RecapReference = { parts: [{ startMs: 0, print: { codes: a.codes, chroma: null } }], blank: [] };
    expect(RECAP_MIN_MS).toBeGreaterThan(6000);
    expect(findRecap({ startMs: 0, print: { codes: l, chroma: null } }, 80_000, [r0])).toBeNull();
    expect(FRAME_MS).toBe(64);
  });
});

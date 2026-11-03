import { describe, expect, it } from 'vitest';
import {
  alignCodes,
  BANDS,
  BIN_BAND,
  codeOf,
  codesFromBlob,
  codesToBlob,
  fft,
  fingerprint,
  FRAME_MS,
  longestRun,
  pcmFromS16le,
  popcount32,
  realPowerSpectrum,
  SAMPLE_RATE,
  SPAN,
  smooth,
  voteOffsets,
} from './fingerprint.js';
import { episode, rng, theme } from './fingerprint.fixtures.js';

// The fingerprint maths (FFT, bands, code bits) against known vectors, and pair alignment on
// synthetic PCM: one 40 s "theme" (a chirp over seeded noise) dropped into four noise episodes
// at different, sample-exact offsets.

describe('fft', () => {
  it('matches a direct DFT', () => {
    const n = 16;
    const x = Array.from({ length: n }, (_, i) => Math.sin(i) + 0.5 * Math.cos(3 * i) + (i % 3));
    const re = Float64Array.from(x);
    const im = new Float64Array(n);
    fft(re, im);
    for (let k = 0; k < n; k++) {
      let dr = 0;
      let di = 0;
      for (let t = 0; t < n; t++) {
        dr += x[t]! * Math.cos((-2 * Math.PI * k * t) / n);
        di += x[t]! * Math.sin((-2 * Math.PI * k * t) / n);
      }
      expect(re[k]).toBeCloseTo(dr, 9);
      expect(im[k]).toBeCloseTo(di, 9);
    }
  });

  it('puts an impulse flat and a pure tone in its bin', () => {
    const imp = new Float64Array(8);
    imp[0] = 1;
    expect([...realPowerSpectrum(imp)]).toEqual([1, 1, 1, 1, 1].map(() => expect.closeTo(1, 12)));
    const n = 1024;
    const tone = Float64Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * 64 * i) / n));
    const p = realPowerSpectrum(tone);
    expect(p.length).toBe(513);
    expect(p[64]).toBeCloseTo((n / 2) ** 2, 6);
    for (let k = 0; k < p.length; k++) if (k !== 64) expect(p[k]).toBeLessThan(1e-12);
  });

  it('real spectrum equals the complex FFT of the same signal', () => {
    const r = rng(3);
    const x = Float64Array.from({ length: 64 }, () => r() - 0.5);
    const re = Float64Array.from(x);
    const im = new Float64Array(64);
    fft(re, im);
    const p = realPowerSpectrum(x);
    for (let k = 0; k <= 32; k++) expect(p[k]).toBeCloseTo(re[k]! ** 2 + im[k]! ** 2, 9);
  });

  it('refuses lengths that are not powers of two', () => {
    expect(() => fft(new Float64Array(6), new Float64Array(6))).toThrow();
  });
});

describe('bands and codes', () => {
  it('covers 300-3000 Hz with 33 increasing bands, each non-empty', () => {
    const hz = (k: number) => (k * SAMPLE_RATE) / 1024;
    const used = new Set<number>();
    let last = -1;
    for (let k = 0; k < BIN_BAND.length; k++) {
      const b = BIN_BAND[k]!;
      if (hz(k) < 300 || hz(k) >= 3000) expect(b).toBe(-1);
      else {
        expect(b).toBeGreaterThanOrEqual(last);
        last = b;
        used.add(b);
      }
    }
    expect(used.size).toBe(BANDS);
    expect(FRAME_MS).toBe(64);
  });

  it('sets bit b when the band-b step grew since the previous frame', () => {
    const prev = new Float64Array(BANDS).fill(1);
    const cur = new Float64Array(BANDS).fill(1);
    cur[0] = 5; // band 0 - band 1 grew: bit 0
    cur[3] = 0; // band 2 - band 3 grew (bit 2), band 3 - band 4 shrank (bit 3 clear)
    expect(codeOf(cur, prev)).toBe(0b101);
    const all = Float64Array.from({ length: BANDS }, (_, b) => BANDS - b);
    expect(codeOf(all, new Float64Array(BANDS))).toBe(0xffffffff);
    expect(codeOf(prev, prev)).toBe(0);
  });

  it('counts bits and round-trips the blob', () => {
    expect(popcount32(0)).toBe(0);
    expect(popcount32(0xffffffff)).toBe(32);
    expect(popcount32(0x80000001)).toBe(2);
    const codes = Uint32Array.from([0, 1, 0xdeadbeef, 0xffffffff]);
    const blob = codesToBlob(codes);
    expect(blob.toString('hex')).toBe('0000000001000000efbeaddeffffffff');
    expect([...codesFromBlob(blob)]).toEqual([...codes]);
    expect([...pcmFromS16le(Buffer.from([0x01, 0x00, 0xff, 0xff]))]).toEqual([1, -1]);
  });

  it('gives one code per 64 ms and zero for silence', () => {
    const codes = fingerprint(new Int16Array(SAMPLE_RATE * 2));
    expect(codes.length).toBe(Math.floor((16000 - 1024) / 512) + 1 - SPAN + 1);
    expect(codes.every((c) => c === 0)).toBe(true);
    expect(fingerprint(new Int16Array(100)).length).toBe(0);
  });
});

describe('run helpers', () => {
  it('smooths and bridges short gaps', () => {
    const x = Float64Array.from([0, 1, 1, 1, 0, 1, 1, 0, 0, 0, 1]);
    expect(longestRun(x, 0.7, 1)).toEqual({ start: 1, end: 7 });
    expect(longestRun(x, 0.7, 0)).toEqual({ start: 1, end: 4 });
    expect(longestRun(new Float64Array(3), 0.7, 1)).toBeNull();
    const s = smooth(Float64Array.from([0, 3, 0, Number.NaN]), 3);
    expect(s[0]).toBeCloseTo(1.5);
    expect(s[1]).toBeCloseTo(1);
    expect(Number.isNaN(s[3]!)).toBe(true);
  });
});

describe('pair alignment on synthetic episodes', () => {
  const intro = theme(40);
  // Sample-exact starts that do not fall on the 512-sample hop.
  const starts = [12.3456, 47.1, 3.77, 80.0213];
  const eps = starts.map((s, i) => episode(300, 100 + i, intro, Math.round(s * SAMPLE_RATE)));
  const codes = eps.map((e) => fingerprint(e));

  it('finds the shared 40 s intro in every pair within ±0.75 s (the season median tightens it, see segments.test.ts)', () => {
    for (let a = 0; a < codes.length; a++) {
      for (let b = 0; b < codes.length; b++) {
        if (a === b) continue;
        const run = alignCodes(codes[a]!, codes[b]!);
        expect(run, `pair ${a}-${b}`).not.toBeNull();
        const startMs = run!.startA * FRAME_MS;
        const endMs = run!.endA * FRAME_MS;
        expect(Math.abs(startMs - starts[a]! * 1000), `start ${a}-${b}`).toBeLessThanOrEqual(750);
        expect(Math.abs(endMs - (starts[a]! + 40) * 1000), `end ${a}-${b}`).toBeLessThanOrEqual(750);
        // B's own timeline through the offset.
        const startB = (run!.startA + run!.offset) * FRAME_MS;
        expect(Math.abs(startB - starts[b]! * 1000)).toBeLessThanOrEqual(750);
      }
    }
  });

  it('finds nothing between unrelated episodes', () => {
    const x = fingerprint(episode(120, 900, new Int16Array(0), 0));
    const y = fingerprint(episode(120, 901, new Int16Array(0), 0));
    expect(voteOffsets(x, y).length).toBe(0);
    expect(alignCodes(x, y)).toBeNull();
  });
});

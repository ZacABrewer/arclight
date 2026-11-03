import { SAMPLE_RATE } from './fingerprint.js';

// Synthetic PCM for the detection tests (not shipped behaviour).

/** Deterministic noise (mulberry32). */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 40 s theme: a repeating 400-2500 Hz chirp plus a melody of tones over seeded noise. */
export function theme(seconds = 40, seed = 7): Int16Array {
  const n = seconds * SAMPLE_RATE;
  const out = new Int16Array(n);
  const r = rng(seed);
  let phase = 0;
  let tone = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const f = 400 + 2100 * ((t % 2.5) / 2.5);
    phase += (2 * Math.PI * f) / SAMPLE_RATE;
    const note = 500 + 250 * (Math.floor(t * 3) % 7);
    tone += (2 * Math.PI * note) / SAMPLE_RATE;
    out[i] = Math.round(6000 * Math.sin(phase) + 4000 * Math.sin(tone) + 3000 * (r() * 2 - 1));
  }
  return out;
}

/** `seconds` of noise (its own seed) with `insert` copied in at sample `at`. */
export function episode(seconds: number, seed: number, insert: Int16Array, at: number): Int16Array {
  const n = seconds * SAMPLE_RATE;
  const out = new Int16Array(n);
  const r = rng(seed);
  for (let i = 0; i < n; i++) out[i] = Math.round(5000 * (r() * 2 - 1));
  out.set(insert.subarray(0, Math.min(insert.length, n - at)), at);
  return out;
}


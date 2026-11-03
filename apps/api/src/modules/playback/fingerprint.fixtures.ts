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


const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/**
 * A `seconds` piece of music in C major: triads (each note with three harmonics) changing every
 * 1-2.5 s under a melody of eighth notes, both on the equal-tempered scale. `seed` picks the
 * chords, their lengths and the melody, so two seeds are two pieces in the same key.
 */
export function chordTheme(seconds = 40, seed = 11): Int16Array {
  const n = seconds * SAMPLE_RATE;
  const out = new Int16Array(n);
  const r = rng(seed);
  // The diatonic triads of C major (MIDI notes around the 4th octave).
  const triads = [
    [60, 64, 67],
    [62, 65, 69],
    [64, 67, 71],
    [53, 57, 60],
    [55, 59, 62],
    [57, 60, 64],
    [59, 62, 65],
  ];
  const changes: Array<{ at: number; chord: number[] }> = [];
  for (let t = 0; t < seconds; t += 1 + Math.floor(r() * 4) * 0.5) changes.push({ at: t, chord: triads[Math.floor(r() * triads.length)]! });
  const scale = [72, 74, 76, 77, 79, 81, 83, 84];
  const melody = Array.from({ length: Math.ceil(seconds * 4) }, () => scale[Math.floor(r() * scale.length)]!);
  let c = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    while (c + 1 < changes.length && changes[c + 1]!.at <= t) c++;
    let v = 0;
    for (const m of changes[c]!.chord) {
      const f = midiHz(m);
      for (let h = 1; h <= 3; h++) v += (0.18 / h) * Math.sin(2 * Math.PI * f * h * t);
    }
    const note = melody[Math.floor(t * 4)]!;
    const env = 1 - ((t * 4) % 1) * 0.6;
    v += 0.25 * env * Math.sin(2 * Math.PI * midiHz(note) * t);
    out[i] = Math.round(9000 * v);
  }
  return out;
}

/**
 * Speech-like sound: syllables of 120-320 ms with pauses, each a voiced buzz whose pitch glides
 * (90-240 Hz, harmonics up to 3.5 kHz shaped by two random formants) or a hiss (fricative). Loud:
 * it sits over the music the way dialogue does.
 */
export function speechLike(seconds: number, seed: number, level = 9000): Int16Array {
  const n = seconds * SAMPLE_RATE;
  const out = new Int16Array(n);
  const r = rng(seed);
  let i = 0;
  while (i < n) {
    const len = Math.round((0.12 + r() * 0.2) * SAMPLE_RATE);
    const pause = Math.round(r() < 0.2 ? (0.2 + r() * 0.4) * SAMPLE_RATE : r() * 0.05 * SAMPLE_RATE);
    const fricative = r() < 0.25;
    const f0a = 90 + r() * 150;
    const f0b = f0a * (0.8 + r() * 0.45);
    const f1 = 300 + r() * 600;
    const f2 = 900 + r() * 1600;
    let phase = 0;
    for (let k = 0; k < len && i + k < n; k++) {
      const u = k / len;
      const env = Math.sin(Math.PI * u);
      let v = 0;
      if (fricative) v = (r() * 2 - 1) * 0.6;
      else {
        const f0 = f0a + (f0b - f0a) * u;
        phase += (2 * Math.PI * f0) / SAMPLE_RATE;
        for (let h = 1; h * f0 < 3500; h++) {
          const fh = h * f0;
          const g = Math.exp(-(((fh - f1) / 250) ** 2)) + 0.6 * Math.exp(-(((fh - f2) / 400) ** 2)) + 0.05;
          v += g * Math.sin(h * phase);
        }
        v *= 0.35;
      }
      out[i + k] = Math.max(-32768, Math.min(32767, Math.round(level * env * v)));
    }
    i += len + pause;
  }
  return out;
}

/** a + b sample by sample (b scaled by `gain`), clipped. */
export function mix(a: Int16Array, b: Int16Array, gain = 1): Int16Array {
  const out = new Int16Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.max(-32768, Math.min(32767, a[i]! + Math.round((b[i] ?? 0) * gain)));
  return out;
}

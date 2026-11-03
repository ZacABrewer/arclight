// Audio fingerprints for intro, recap and credits detection. Arclight's own method, pure TypeScript:
//
//   PCM (mono, 8 kHz, s16le) -> frames of 1024 samples every 512 (64 ms), Hann window -> power
//   spectrum (radix-2 FFT below) -> 33 log-spaced band energies between 300 and 3000 Hz -> one
//   32-bit code per 64 ms, bit b = whether the energy step between bands b and b+1 grew or shrank
//   against a moment earlier (see SPAN / LAG).
//
// Two episodes that share an intro share a long stretch of similar codes at a constant frame
// offset. alignCodes finds candidate offsets by voting on exact (16-bit lane) matches, measures
// how similar the codes stay along each, and returns the longest similar run.
//
// The codes follow 300-3000 Hz, where speech is loudest, so dialogue over an intro's music breaks
// them. `analyse` also keeps a chroma print (features-spec §5.9): from the same spectrum, the
// energy of each of the 12 pitch classes (130-3900 Hz), kept only where a peak stays put for a
// few frames (speech glides, held notes do not), one 12 x 4-bit vector every 4 codes. alignPrints
// compares two prints at each candidate offset by max(code similarity, smoothed chroma
// correlation); a run found there grows outward while the chroma correlation over 8 s stays
// above EXTEND_CORR, so an intro whose start is under dialogue is not cut short.
//
// Both are CPU work of tens to hundreds of milliseconds per call, so they are written as
// generators that yield every few milliseconds: `fingerprintAsync` / `alignCodesAsync` hand the
// event loop back (setImmediate) at each yield so playback and the API are not stalled while a
// season is scanned; `fingerprint` / `alignCodes` run the same steps straight through. (The api
// ships as one bundled file, so a worker_thread would need a second entry point.)

/** A computation that yields whenever it is a good moment to give the event loop a turn. */
export type Steps<T> = Generator<void, T, void>;

/** Runs steps to the end without pausing. */
export function runSteps<T>(steps: Steps<T>): T {
  for (;;) {
    const n = steps.next();
    if (n.done) return n.value;
  }
}

/** Runs steps, letting pending I/O run (setImmediate) at every yield. */
export async function driveSteps<T>(steps: Steps<T>): Promise<T> {
  for (;;) {
    const n = steps.next();
    if (n.done) return n.value;
    await new Promise<void>((r) => setImmediate(r));
  }
}

/** Frames of FFT work between yields (~ a few ms). */
const FRAMES_PER_YIELD = 128;
/** Codes of A voted between yields. */
const VOTES_PER_YIELD = 512;

export const SAMPLE_RATE = 8000;
export const FRAME_SIZE = 1024;
export const HOP = 512;
/** Milliseconds per code (hop / sample rate). */
export const FRAME_MS = (HOP * 1000) / SAMPLE_RATE;
export const BANDS = 33;
const LOW_HZ = 300;
const HIGH_HZ = 3000;

// ---- FFT ---------------------------------------------------------------------------------------

/** In-place iterative radix-2 FFT of a complex signal; `re.length` must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n !== im.length || (n & (n - 1)) !== 0) throw new Error('fft: length must be a power of two');
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]!;
      re[i] = re[j]!;
      re[j] = t;
      t = im[i]!;
      im[i] = im[j]!;
      im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = (-2 * Math.PI) / size;
    const wr = Math.cos(step);
    const wi = Math.sin(step);
    for (let start = 0; start < n; start += size) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = start + k;
        const b = a + half;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * Power spectrum |X[k]|² for k = 0..n/2 of a real signal. Uses the half-length trick: the n real
 * samples are packed as n/2 complex ones, transformed, then split into the real signal's bins.
 */
export function realPowerSpectrum(x: Float64Array): Float64Array {
  const n = x.length;
  const h = n >> 1;
  const re = new Float64Array(h);
  const im = new Float64Array(h);
  for (let i = 0; i < h; i++) {
    re[i] = x[2 * i]!;
    im[i] = x[2 * i + 1]!;
  }
  fft(re, im);
  const out = new Float64Array(h + 1);
  for (let k = 0; k <= h; k++) {
    const a = k % h;
    const b = (h - k) % h;
    // Even and odd sample spectra from the packed transform.
    const er = (re[a]! + re[b]!) / 2;
    const ei = (im[a]! - im[b]!) / 2;
    const or = (im[a]! + im[b]!) / 2;
    const oi = -(re[a]! - re[b]!) / 2;
    const ang = (-2 * Math.PI * k) / n;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const xr = er + (or * c - oi * s);
    const xi = ei + (or * s + oi * c);
    out[k] = xr * xr + xi * xi;
  }
  return out;
}

// ---- features ----------------------------------------------------------------------------------

const HANN = (() => {
  const w = new Float64Array(FRAME_SIZE);
  for (let i = 0; i < FRAME_SIZE; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME_SIZE - 1));
  return w;
})();

/** For each FFT bin 0..FRAME_SIZE/2, its band (0..BANDS-1), or -1 outside 300-3000 Hz. */
export const BIN_BAND: Int8Array = (() => {
  const bins = new Int8Array(FRAME_SIZE / 2 + 1).fill(-1);
  const ratio = Math.pow(HIGH_HZ / LOW_HZ, 1 / BANDS);
  for (let k = 0; k < bins.length; k++) {
    const hz = (k * SAMPLE_RATE) / FRAME_SIZE;
    if (hz < LOW_HZ || hz >= HIGH_HZ) continue;
    bins[k] = Math.min(BANDS - 1, Math.floor(Math.log(hz / LOW_HZ) / Math.log(ratio)));
  }
  return bins;
})();

/** The 33 band energies of one frame starting at `at`. */
export function bandEnergies(pcm: Int16Array | Float64Array, at: number): Float64Array {
  const frame = new Float64Array(FRAME_SIZE);
  for (let i = 0; i < FRAME_SIZE; i++) frame[i] = (pcm[at + i] ?? 0) * HANN[i]!;
  return bandsOfPower(realPowerSpectrum(frame));
}

/** The 32-bit code of frame t from its band energies and the previous frame's. */
export function codeOf(cur: Float64Array, prev: Float64Array): number {
  let code = 0;
  for (let b = 0; b < BANDS - 1; b++) {
    const d = cur[b]! - cur[b + 1]! - (prev[b]! - prev[b + 1]!);
    if (d > 0) code |= 1 << b;
  }
  return code >>> 0;
}

/**
 * Codes are taken over short stacks of frames rather than single ones: the energies of SPAN
 * consecutive frames are summed and each code compares the stack with the one LAG frames back.
 * Two copies of the same audio never line up on the 512-sample grid exactly; with single frames a
 * half-hop shift leaves only ~60 % of bits equal on noisy material, with stacks ~80 %, so the 0.70
 * run threshold holds whatever the sub-frame phase.
 */
export const SPAN = 6;
export const LAG = 3;
/** Frames the step fit puts a run's end early by (measured on the synthetic fixtures). */
const END_BIAS = 2;

/** One code per 64 ms (code t covers frames t-LAG .. t+SPAN-1). The first LAG codes and silence are 0. */
export function fingerprint(pcm: Int16Array): Uint32Array {
  return runSteps(fingerprintSteps(pcm));
}

/** fingerprint() without blocking the event loop for more than a few milliseconds at a time. */
export function fingerprintAsync(pcm: Int16Array): Promise<Uint32Array> {
  return driveSteps(fingerprintSteps(pcm));
}

export function* fingerprintSteps(pcm: Int16Array): Steps<Uint32Array> {
  return (yield* analyseSteps(pcm, false)).codes;
}

/** Both fingerprints of a stretch of audio: the band codes and the chroma (see CHROMA_*). */
export interface Print {
  codes: Uint32Array;
  /** CHROMA_BYTES per vector, one vector per CHROMA_STEP codes; null on rows from before 0.24.0. */
  chroma: Uint8Array | null;
}

/** Codes and chroma of PCM in one pass over the spectra. */
export function analyse(pcm: Int16Array): Print {
  return runSteps(analyseSteps(pcm, true));
}

/** analyse() without blocking the event loop for more than a few milliseconds at a time. */
export function analyseAsync(pcm: Int16Array): Promise<Print> {
  return driveSteps(analyseSteps(pcm, true));
}

function* analyseSteps(pcm: Int16Array, withChroma: boolean): Steps<Print> {
  const frameCount = pcm.length < FRAME_SIZE ? 0 : Math.floor((pcm.length - FRAME_SIZE) / HOP) + 1;
  const n = Math.max(0, frameCount - SPAN + 1);
  const out = new Uint32Array(n);
  if (n === 0) return { codes: out, chroma: withChroma ? new Uint8Array(0) : null };
  const energies: Float64Array[] = [];
  const pitch: Float64Array[] = [];
  const frame = new Float64Array(FRAME_SIZE);
  let mask = new Uint8Array(FRAME_SIZE / 2 + 1);
  let prevMask = new Uint8Array(FRAME_SIZE / 2 + 1);
  for (let t = 0; t < frameCount; t++) {
    const at = t * HOP;
    for (let i = 0; i < FRAME_SIZE; i++) frame[i] = (pcm[at + i] ?? 0) * HANN[i]!;
    const power = realPowerSpectrum(frame);
    energies.push(bandsOfPower(power));
    if (withChroma) {
      pitch.push(chromaOfPower(power, prevMask, mask));
      [prevMask, mask] = [mask, prevMask];
    }
    if ((t + 1) % FRAMES_PER_YIELD === 0) yield;
  }
  const stacks: Float64Array[] = [];
  for (let t = 0; t < n; t++) {
    const s = new Float64Array(BANDS);
    for (let k = 0; k < SPAN; k++) {
      const e = energies[t + k]!;
      for (let b = 0; b < BANDS; b++) s[b]! += e[b]!;
    }
    stacks.push(s);
  }
  for (let t = LAG; t < n; t++) out[t] = codeOf(stacks[t]!, stacks[t - LAG]!);
  return { codes: out, chroma: withChroma ? packChroma(pitch, n) : null };
}

function bandsOfPower(power: Float64Array): Float64Array {
  const e = new Float64Array(BANDS);
  for (let k = 0; k < power.length; k++) {
    const b = BIN_BAND[k]!;
    if (b >= 0) e[b]! += power[k]!;
  }
  return e;
}

// ---- chroma ------------------------------------------------------------------------------------
//
// The band codes follow the whole 300-3000 Hz spectrum, which is exactly where speech is loudest:
// an intro with dialogue over the theme shares few codes with the same theme played clean. The
// second fingerprint follows the harmony instead. Per frame, the FFT magnitudes between
// CHROMA_LOW_HZ and CHROMA_HIGH_HZ are folded onto the 12 pitch classes of the equal-tempered
// scale (a pitch-class profile, "chroma"); CHROMA_SPAN frames (~1 s) are summed so held notes and
// chords add up while the gliding harmonics of speech smear over many classes. One vector is kept
// every CHROMA_STEP codes, scaled to its largest class and stored as 12 four-bit values.
//
// Two vectors are compared by their correlation (each centred on its own mean, then the cosine),
// so the flat part speech and noise add cancels out and chance agreement sits near 0, not near
// the ~0.75 cosine two arbitrary non-negative vectors have. Vectors without a clear tonal peak
// (silence, noise) are stored as all zero and never match.

/** Codes per chroma vector (256 ms). */
export const CHROMA_STEP = 4;
/** Frames summed into one chroma vector (~1.1 s). */
export const CHROMA_SPAN = 16;
/** Bytes per stored vector: 12 classes x 4 bits. */
export const CHROMA_BYTES = 6;
/**
 * The pitch-class range. Below ~130 Hz one FFT bin (7.8 Hz here) is wider than a semitone, so
 * the classes there would be guesses; 3900 Hz is just under the 4 kHz Nyquist limit.
 */
const CHROMA_LOW_HZ = 130;
const CHROMA_HIGH_HZ = 3900;
/** A vector whose largest class is below this multiple of the mean is "not tonal" (stored as zero). */
const CHROMA_PEAK_RATIO = 1.6;

/** For each FFT bin 0..FRAME_SIZE/2, its pitch class (C = 0 .. B = 11), or -1 outside the range. */
export const BIN_PITCH: Int8Array = (() => {
  const bins = new Int8Array(FRAME_SIZE / 2 + 1).fill(-1);
  for (let k = 1; k < bins.length; k++) {
    const hz = (k * SAMPLE_RATE) / FRAME_SIZE;
    if (hz < CHROMA_LOW_HZ || hz >= CHROMA_HIGH_HZ) continue;
    // Semitones from A4 (440 Hz); A is class 9.
    const semis = Math.round(12 * Math.log2(hz / 440));
    bins[k] = (((semis + 9) % 12) + 12) % 12;
  }
  return bins;
})();

/** Bins either side of a bin that form its neighbourhood, and how far above its mean a peak must rise. */
const PEAK_REACH = 12;
const PEAK_FACTOR = 4;
/** Frames in a row a peak must have lasted (within one bin) to count. */
const PEAK_PERSIST = 3;

/**
 * The spectral peaks of one frame (into `mask`) and their pitch-class magnitudes: a bin is a peak
 * when it is a local maximum at least PEAK_FACTOR times the mean power of the bins around it, and
 * it counts towards the chroma only when the previous frame had a peak at most one bin away
 * (`prevMask`). Held notes and chords are such lasting peaks; noise, fricatives and the gliding
 * upper harmonics of speech mostly are not, so they add little instead of burying the harmony.
 */
export function chromaOfPower(power: Float64Array, prevMask: Uint8Array | null = null, mask: Uint8Array | null = null): Float64Array {
  const c = new Float64Array(12);
  const n = power.length;
  const prefix = new Float64Array(n + 1);
  for (let k = 0; k < n; k++) prefix[k + 1] = prefix[k]! + power[k]!;
  mask?.fill(0);
  for (let k = 1; k < n - 1; k++) {
    const p = BIN_PITCH[k]!;
    if (p < 0) continue;
    const v = power[k]!;
    if (v <= power[k - 1]! || v < power[k + 1]!) continue;
    const lo = Math.max(0, k - PEAK_REACH);
    const hi = Math.min(n, k + PEAK_REACH + 1);
    const mean = (prefix[hi]! - prefix[lo]!) / (hi - lo);
    if (v < PEAK_FACTOR * mean) continue;
    const age = prevMask ? 1 + Math.max(prevMask[k - 1]!, prevMask[k]!, prevMask[k + 1]!) : PEAK_PERSIST;
    if (mask) mask[k] = Math.min(255, age);
    if (age < PEAK_PERSIST) continue;
    c[p]! += Math.sqrt(v);
  }
  return c;
}

/** The stored chroma of `codeCount` codes from per-frame pitch-class magnitudes. */
function packChroma(pitch: readonly Float64Array[], codeCount: number): Uint8Array {
  const count = Math.ceil(codeCount / CHROMA_STEP);
  const out = new Uint8Array(count * CHROMA_BYTES);
  const sum = new Float64Array(12);
  for (let v = 0; v < count; v++) {
    // Centred on the frames code v*STEP is made of (frames t .. t+SPAN-1).
    const mid = v * CHROMA_STEP + (SPAN >> 1);
    const from = Math.max(0, mid - (CHROMA_SPAN >> 1));
    const to = Math.min(pitch.length, from + CHROMA_SPAN);
    sum.fill(0);
    for (let f = from; f < to; f++) {
      const c = pitch[f]!;
      for (let p = 0; p < 12; p++) sum[p]! += c[p]!;
    }
    let max = 0;
    let total = 0;
    for (let p = 0; p < 12; p++) {
      total += sum[p]!;
      if (sum[p]! > max) max = sum[p]!;
    }
    if (max <= 0 || max < (CHROMA_PEAK_RATIO * total) / 12) continue;
    for (let p = 0; p < 12; p += 2) {
      const hi = Math.round((sum[p]! / max) * 15);
      const lo = Math.round((sum[p + 1]! / max) * 15);
      out[v * CHROMA_BYTES + (p >> 1)] = (hi << 4) | lo;
    }
  }
  return out;
}

/**
 * Stored chroma as unit vectors after mean-centring (12 floats per vector), so the correlation of
 * two vectors is their dot product. All-zero (not tonal) vectors stay all zero.
 */
export function chromaUnits(chroma: Uint8Array): Float32Array {
  const count = Math.floor(chroma.length / CHROMA_BYTES);
  const out = new Float32Array(count * 12);
  const v = new Float64Array(12);
  for (let i = 0; i < count; i++) {
    let mean = 0;
    for (let p = 0; p < 12; p += 2) {
      const byte = chroma[i * CHROMA_BYTES + (p >> 1)]!;
      v[p] = byte >> 4;
      v[p + 1] = byte & 15;
      mean += v[p]! + v[p + 1]!;
    }
    if (mean === 0) continue;
    mean /= 12;
    let norm = 0;
    for (let p = 0; p < 12; p++) {
      v[p]! -= mean;
      norm += v[p]! * v[p]!;
    }
    if (norm === 0) continue;
    const inv = 1 / Math.sqrt(norm);
    for (let p = 0; p < 12; p++) out[i * 12 + p] = v[p]! * inv;
  }
  return out;
}

/** Correlation of vector i of `a` with vector j of `b` (unit vectors from chromaUnits); 0 when either is empty. */
export function chromaCorr(a: Float32Array, i: number, b: Float32Array, j: number): number {
  let d = 0;
  const x = i * 12;
  const y = j * 12;
  for (let p = 0; p < 12; p++) d += a[x + p]! * b[y + p]!;
  return d;
}

/** Correlation a chroma vector pair needs to count as the same music. */
export const CHROMA_MATCH = 0.6;
/** Correlation one vector pair needs to vote for its offset in the chroma scan. */
const CHROMA_HIT = 0.8;

const isLive = (u: Float32Array, i: number) => u[i * 12] !== 0 || u[i * 12 + 1] !== 0 || u[i * 12 + 2] !== 0 || u[i * 12 + 3] !== 0;

/**
 * Offsets in codes (frameB - frameA) where many chroma vectors agree, best first: for every vector
 * shift, the number of vector pairs with correlation ≥ CHROMA_HIT. This is a brute-force scan
 * (vectors of A x vectors of B), cheap at 4 vectors a second, and finds the theme when dialogue
 * leaves too few exact code matches to vote with.
 */
export function* chromaOffsetsSteps(a: Float32Array, b: Float32Array, top: number, minHits: number): Steps<number[]> {
  const na = a.length / 12;
  const nb = b.length / 12;
  if (na === 0 || nb === 0) return [];
  const liveA: number[] = [];
  for (let i = 0; i < na; i++) if (isLive(a, i)) liveA.push(i);
  const liveB: number[] = [];
  for (let j = 0; j < nb; j++) if (isLive(b, j)) liveB.push(j);
  // hits[d + na - 1]: matches at vector shift d.
  const hits = new Int32Array(na + nb - 1);
  let work = 0;
  for (const i of liveA) {
    for (const j of liveB) if (chromaCorr(a, i, b, j) >= CHROMA_HIT) hits[j - i + na - 1]!++;
    work += liveB.length;
    if (work >= 200_000) {
      work = 0;
      yield;
    }
  }
  const order: number[] = [];
  for (let k = 0; k < hits.length; k++) if (hits[k]! >= minHits) order.push(k);
  order.sort((x, y) => hits[y]! - hits[x]! || x - y);
  const out: number[] = [];
  for (const k of order) {
    if (out.length >= top) break;
    const off = (k - (na - 1)) * CHROMA_STEP;
    if (out.some((o) => Math.abs(o - off) <= 2 * CHROMA_STEP)) continue;
    out.push(off);
  }
  return out;
}

/** Chroma as stored (the `video_fingerprints.chroma` column) and back. */
export function chromaToBlob(chroma: Uint8Array): Buffer {
  return Buffer.from(chroma.buffer, chroma.byteOffset, chroma.byteLength);
}

export function chromaFromBlob(buf: Buffer | Uint8Array): Uint8Array {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength).slice();
}

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** s16le bytes (ffmpeg's `-f s16le` output) as samples. */
export function pcmFromS16le(buf: Buffer): Int16Array {
  const n = buf.length >> 1;
  const out = new Int16Array(n);
  // One memory copy on little-endian hosts (all supported ones); per-sample reads otherwise.
  if (LITTLE_ENDIAN) new Uint8Array(out.buffer).set(buf.subarray(0, n * 2));
  else for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

/** Codes as a little-endian uint32 blob (the `video_fingerprints.hashes` column) and back. */
export function codesToBlob(codes: Uint32Array): Buffer {
  const buf = Buffer.alloc(codes.length * 4);
  for (let i = 0; i < codes.length; i++) buf.writeUInt32LE(codes[i]!, i * 4);
  return buf;
}

export function codesFromBlob(buf: Buffer | Uint8Array): Uint32Array {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const n = b.length >> 2;
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = b.readUInt32LE(i * 4);
  return out;
}

export function popcount32(v: number): number {
  let x = v >>> 0;
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (Math.imul(x, 0x01010101) >>> 24) & 0xff;
}

// ---- pair alignment ----------------------------------------------------------------------------

export interface AlignOptions {
  /** Offsets kept from the vote (default 3) and votes an offset needs (default 20). */
  topOffsets?: number;
  minVotes?: number;
  /** Smoothed similarity a run needs (default 0.70). */
  threshold?: number;
  /** Moving-average window (default 2 s) and the longest dip a run survives (default 1.5 s). */
  smoothMs?: number;
  maxGapMs?: number;
  /** Moving-average window of the chroma correlation (default 5 s): dialogue makes it noisier. */
  chromaSmoothMs?: number;
  /** A code seen more often than this in B is too common to vote with (silence, hum). */
  maxBucket?: number;
}

/** A shared stretch: frames [startA, endA) of A line up with [startA + offset, endA + offset) of B. */
export interface AlignedRun {
  startA: number;
  endA: number;
  offset: number;
  /** Mean raw similarity inside the run. */
  similarity: number;
}

const frames = (ms: number) => Math.max(1, Math.round(ms / FRAME_MS));

/**
 * The four 16-bit lanes of a code (bits 0-15, 8-23, 16-31 and 24-31+0-7), tagged with the lane.
 * Votes count exact lane matches: a whole 32-bit code rarely survives a sub-frame shift intact,
 * a 16-bit lane often does.
 */
function lanes(c: number): [number, number, number, number] {
  const r = ((c >>> 8) | (c << 24)) >>> 0;
  return [c & 0xffff, 0x10000 | ((c >>> 8) & 0xffff), 0x20000 | (c >>> 16), 0x30000 | (r >>> 16)];
}

/** Offsets (frameB - frameA) by exact-match votes, best first, with at least `minVotes`. */
export function voteOffsets(a: Uint32Array, b: Uint32Array, top = 3, minVotes = 20, maxBucket = 64): number[] {
  return runSteps(voteOffsetsSteps(a, b, top, minVotes, maxBucket));
}

function* voteOffsetsSteps(a: Uint32Array, b: Uint32Array, top: number, minVotes: number, maxBucket: number): Steps<number[]> {
  const index = new Map<number, number[]>();
  for (let j = 0; j < b.length; j++) {
    const c = b[j]!;
    if (c === 0) continue;
    for (const key of lanes(c)) {
      let list = index.get(key);
      if (!list) index.set(key, (list = []));
      list.push(j);
    }
  }
  const votes = new Map<number, number>();
  yield;
  for (let i = 0; i < a.length; i++) {
    if ((i + 1) % VOTES_PER_YIELD === 0) yield;
    const c = a[i]!;
    if (c === 0) continue;
    for (const key of lanes(c)) {
      const list = index.get(key);
      if (!list || list.length > maxBucket) continue;
      for (const j of list) votes.set(j - i, (votes.get(j - i) ?? 0) + 1);
    }
  }
  // Neighbouring offsets (a sub-frame shift splits votes between two) count for each other.
  const merged = [...votes.entries()].map(([off, n]) => [off, n + Math.max(votes.get(off - 1) ?? 0, votes.get(off + 1) ?? 0)] as const);
  merged.sort((x, y) => y[1] - x[1] || x[0] - y[0]);
  const out: number[] = [];
  for (const [off, n] of merged) {
    if (n < minVotes || out.length >= top) break;
    if (out.some((o) => Math.abs(o - off) <= 1)) continue;
    out.push(off);
  }
  return out;
}

/** Per-frame similarity of A against B shifted by `offset`; NaN where B has no frame. */
export function similarityAt(a: Uint32Array, b: Uint32Array, offset: number): Float64Array {
  const out = new Float64Array(a.length).fill(Number.NaN);
  for (let i = 0; i < a.length; i++) {
    const j = i + offset;
    if (j < 0 || j >= b.length) continue;
    out[i] = 1 - popcount32((a[i]! ^ b[j]!) >>> 0) / 32;
  }
  return out;
}

/** Centred moving average over `win` frames, ignoring NaN (frames outside the overlap). */
export function smooth(x: Float64Array, win: number): Float64Array {
  const out = new Float64Array(x.length).fill(Number.NaN);
  const half = Math.floor(win / 2);
  let sum = 0;
  let count = 0;
  const add = (i: number, sign: 1 | -1) => {
    const v = x[i];
    if (v === undefined || Number.isNaN(v)) return;
    sum += sign * v;
    count += sign;
  };
  for (let i = 0; i < Math.min(x.length, half); i++) add(i, 1);
  for (let i = 0; i < x.length; i++) {
    if (i + half < x.length) add(i + half, 1);
    if (i - half - 1 >= 0) add(i - half - 1, -1);
    if (!Number.isNaN(x[i]!) && count > 0) out[i] = sum / count;
  }
  return out;
}

/** Longest stretch where `x` ≥ threshold, bridging dips up to `maxGap` frames: [start, end). */
export function longestRun(x: Float64Array, threshold: number, maxGap: number): { start: number; end: number } | null {
  let best: { start: number; end: number } | null = null;
  let start = -1;
  let lastAbove = -1;
  const close = () => {
    if (start >= 0 && (!best || lastAbove + 1 - start > best.end - best.start)) best = { start, end: lastAbove + 1 };
  };
  for (let i = 0; i < x.length; i++) {
    const v = x[i]!;
    if (!Number.isNaN(v) && v >= threshold) {
      if (start < 0 || i - lastAbove - 1 > maxGap) {
        close();
        start = i;
      }
      lastAbove = i;
    }
  }
  close();
  return best;
}

/**
 * The longest run of shared audio between A and B over the best voted offsets, or null. Run
 * edges are refined on the raw similarity so the 2 s smoothing does not blur them.
 */
export function alignCodes(a: Uint32Array, b: Uint32Array, opts: AlignOptions = {}): AlignedRun | null {
  return runSteps(alignSteps(a, b, opts));
}

/** alignCodes() without blocking the event loop for more than a few milliseconds at a time. */
export function alignCodesAsync(a: Uint32Array, b: Uint32Array, opts: AlignOptions = {}): Promise<AlignedRun | null> {
  return driveSteps(alignSteps(a, b, opts));
}

export function* alignSteps(a: Uint32Array, b: Uint32Array, opts: AlignOptions = {}): Steps<AlignedRun | null> {
  return yield* alignPrintsSteps({ codes: a, chroma: null }, { codes: b, chroma: null }, opts);
}

/** The longest shared run between two prints (codes, plus chroma when both have it), or null. */
export function alignPrints(a: Print, b: Print, opts: AlignOptions = {}): AlignedRun | null {
  return runSteps(alignPrintsSteps(a, b, opts));
}

/** Unit chroma vectors of both prints, or null when either has no chroma. */
function unitsOf(a: Print, b: Print): { ua: Float32Array; ub: Float32Array } | null {
  if (!a.chroma || !b.chroma || a.chroma.length === 0 || b.chroma.length === 0) return null;
  return { ua: chromaUnits(a.chroma), ub: chromaUnits(b.chroma) };
}

/**
 * Candidate offsets: the code vote first, then the chroma scan. A chroma offset is only as fine as
 * one vector (4 codes), so its neighbours within ±2 codes are tried as well.
 */
function* candidateOffsetsSteps(a: Print, b: Print, units: { ua: Float32Array; ub: Float32Array } | null, top: number, minVotes: number, maxBucket: number, minChromaHits: number): Steps<number[]> {
  const out = yield* voteOffsetsSteps(a.codes, b.codes, top, minVotes, maxBucket);
  if (!units) return out;
  for (const off of yield* chromaOffsetsSteps(units.ua, units.ub, top, minChromaHits)) {
    if (out.some((o) => Math.abs(o - off) <= CHROMA_STEP)) continue;
    for (let d = -2; d <= 2; d++) out.push(off + d);
  }
  return out;
}

/** Chroma correlation that counts as chance (maps to 0.5 on the code scale). */
const CHROMA_CHANCE = 0.35;

/** A chroma correlation on the code-similarity scale: CHROMA_CHANCE → 0.5, CHROMA_MATCH → 0.70, 1 → ≥ 0.70. */
function chromaOnCodeScale(c: number): number {
  return Math.max(0.5, 0.5 + (0.2 * (c - CHROMA_CHANCE)) / (CHROMA_MATCH - CHROMA_CHANCE));
}

/**
 * Similarity of A against B shifted by `offset`, per code, on the code scale (0.5 = chance, 0.70 =
 * a match). `raw` is the code similarity raised to the chroma correlation of the same moment where
 * that is higher; `smoothed` is the larger of the smoothed code similarity and the smoothed chroma
 * correlation (each a centred moving average over `win` codes). The chroma is averaged before it
 * is judged: under dialogue single vectors scatter, but over two seconds the shared harmony stays
 * well above chance. NaN where B has no frame.
 */
export function combinedSimilarityAt(
  a: Print,
  b: Print,
  offset: number,
  units: { ua: Float32Array; ub: Float32Array } | null,
  win: number,
  chromaWin = win,
): { raw: Float64Array; smoothed: Float64Array; corr: Float64Array | null } {
  const raw = similarityAt(a.codes, b.codes, offset);
  const smoothed = smooth(raw, win);
  if (!units) return { raw, smoothed, corr: null };
  const na = units.ua.length / 12;
  const nb = units.ub.length / 12;
  const corr = new Float64Array(raw.length).fill(Number.NaN);
  for (let i = 0; i < raw.length; i++) {
    if (Number.isNaN(raw[i]!)) continue;
    const ci = Math.floor(i / CHROMA_STEP);
    const cj = Math.floor((i + offset) / CHROMA_STEP);
    // Not tonal on either side: no evidence either way, count as chance.
    corr[i] = ci < na && cj >= 0 && cj < nb ? chromaCorr(units.ua, ci, units.ub, cj) : CHROMA_CHANCE;
    const v = chromaOnCodeScale(corr[i]!);
    if (v > raw[i]!) raw[i] = v;
  }
  const sc = smooth(corr, chromaWin);
  for (let i = 0; i < smoothed.length; i++) {
    if (Number.isNaN(sc[i]!)) continue;
    const v = chromaOnCodeScale(sc[i]!);
    if (v > smoothed[i]!) smoothed[i] = v;
  }
  return { raw, smoothed, corr };
}

/** Chroma correlation (averaged over EXTEND_MS) a run is extended through. */
const EXTEND_CORR = 0.5;
const EXTEND_MS = 8000;

/**
 * A run found at an offset, grown outwards while the chroma there, averaged over EXTEND_MS, still
 * correlates by EXTEND_CORR: once a match is certain, weaker evidence along the same offset is
 * enough to follow it (dialogue over the first part of an intro hides more of it than of the rest).
 */
function extendRun(corr: Float64Array, run: { start: number; end: number }, maxGap: number): { start: number; end: number } {
  const avg = smooth(corr, frames(EXTEND_MS));
  const ok = (i: number) => !Number.isNaN(avg[i]!) && avg[i]! >= EXTEND_CORR;
  let start = run.start;
  for (let i = run.start - 1, miss = 0; i >= 0 && miss <= maxGap; i--) {
    if (ok(i)) {
      start = i;
      miss = 0;
    } else miss++;
  }
  let end = run.end;
  for (let i = run.end, miss = 0; i < avg.length && miss <= maxGap; i++) {
    if (ok(i)) {
      end = i + 1;
      miss = 0;
    } else miss++;
  }
  return { start, end };
}

/** Mean of raw[from, to) without NaN (0 when empty). */
function runSimilarity(raw: Float64Array, from: number, to: number): number {
  return meanOf(raw, from, to) ?? 0;
}

export function* alignPrintsSteps(a: Print, b: Print, opts: AlignOptions = {}): Steps<AlignedRun | null> {
  const threshold = opts.threshold ?? 0.7;
  const win = frames(opts.smoothMs ?? 2000);
  const gap = frames(opts.maxGapMs ?? 1500);
  const chromaWin = frames(opts.chromaSmoothMs ?? 5000);
  const units = unitsOf(a, b);
  let best: AlignedRun | null = null;
  const offsets = yield* candidateOffsetsSteps(a, b, units, opts.topOffsets ?? 3, opts.minVotes ?? 20, opts.maxBucket ?? 64, frames(5000) / CHROMA_STEP);
  for (const offset of offsets) {
    yield;
    const { raw, smoothed, corr } = combinedSimilarityAt(a, b, offset, units, win, chromaWin);
    const found = longestRun(smoothed, threshold, gap);
    if (!found) continue;
    const run = corr ? extendRun(corr, found, gap) : found;
    // With chroma, a run's edges can be off by up to its (longer) window.
    const edge = refineEdges(raw, run, units ? chromaWin : win);
    // A code stops matching a little before the shared audio ends (its frames reach past it).
    edge.end = Math.min(a.codes.length, edge.end + END_BIAS);
    const cand: AlignedRun = { startA: edge.start, endA: edge.end, offset, similarity: runSimilarity(raw, edge.start, edge.end) };
    const len = cand.endA - cand.startA;
    const bestLen = best ? best.endA - best.startA : -1;
    if (!best || len > bestLen || (len === bestLen && cand.similarity > best.similarity)) best = cand;
  }
  return best;
}

/** Every stretch where `x` ≥ threshold, bridging dips up to `maxGap` frames, at least `minLen` long: [start, end). */
export function runsAbove(x: Float64Array, threshold: number, maxGap: number, minLen: number): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let start = -1;
  let lastAbove = -1;
  const close = () => {
    if (start >= 0 && lastAbove + 1 - start >= minLen) out.push({ start, end: lastAbove + 1 });
  };
  for (let i = 0; i < x.length; i++) {
    const v = x[i]!;
    if (!Number.isNaN(v) && v >= threshold) {
      if (start < 0 || i - lastAbove - 1 > maxGap) {
        close();
        start = i;
      }
      lastAbove = i;
    }
  }
  close();
  return out;
}

export interface ClipOptions {
  /** Offsets tried from the code vote and from the chroma scan (default 16 each). */
  topOffsets?: number;
  /** Votes a code offset needs (default 12): a 3 s clip has ~47 codes, 4 lanes each. */
  minVotes?: number;
  /** Shortest clip (default 3 s). */
  minClipMs?: number;
}

/**
 * Short stretches of A found anywhere in B, each at its own offset: the clips a "previously on"
 * recap is cut from. Every candidate offset is measured with a 1 s smoothing window and every run
 * of at least `minClipMs` is kept. Returns frame ranges of A, sorted and merged.
 */
export function matchClips(a: Print, b: Print, opts: ClipOptions = {}): Array<{ start: number; end: number }> {
  return runSteps(matchClipsSteps(a, b, opts));
}

export function* matchClipsSteps(a: Print, b: Print, opts: ClipOptions = {}): Steps<Array<{ start: number; end: number }>> {
  const win = frames(1000);
  const gap = frames(500);
  const minLen = frames(opts.minClipMs ?? 3000);
  const units = unitsOf(a, b);
  const top = opts.topOffsets ?? 16;
  const offsets = yield* candidateOffsetsSteps(a, b, units, top, opts.minVotes ?? 12, 64, frames(3000) / CHROMA_STEP);
  const found: Array<{ start: number; end: number }> = [];
  for (const offset of offsets) {
    yield;
    const { raw, smoothed } = combinedSimilarityAt(a, b, offset, units, win);
    for (const run of runsAbove(smoothed, 0.7, gap, minLen)) {
      const edge = refineEdges(raw, run, win);
      edge.end = Math.min(a.codes.length, edge.end + END_BIAS);
      if (edge.end - edge.start >= minLen) found.push(edge);
    }
  }
  return mergeRanges(found);
}

/** Sorted, overlapping or touching ranges joined. */
export function mergeRanges(ranges: ReadonlyArray<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const sorted = [...ranges].sort((x, y) => x.start - y.start);
  const out: Array<{ start: number; end: number }> = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** Mean of raw[from, to), skipping NaN; null when empty. */
function meanOf(raw: Float64Array, from: number, to: number): number | null {
  let sum = 0;
  let n = 0;
  for (let i = Math.max(0, from); i < Math.min(raw.length, to); i++) {
    const v = raw[i]!;
    if (Number.isNaN(v)) continue;
    sum += v;
    n++;
  }
  return n > 0 ? sum / n : null;
}

/**
 * Places each edge of a smoothed run where the raw similarity steps between chance and the run's
 * level: the position (within one smoothing window of the smoothed edge) that maximises the
 * difference between the mean similarity on its inner and outer side. Frames outside the overlap
 * count as chance.
 */
function refineEdges(raw: Float64Array, run: { start: number; end: number }, win: number): { start: number; end: number } {
  const side = (from: number, to: number) => meanOf(raw, from, to) ?? 0.5;
  let start = run.start;
  let bestStart = -Infinity;
  for (let i = run.start - win; i <= run.start + win; i++) {
    if (i < 0 || i >= run.end) continue;
    const score = side(i, i + win) - side(i - win, i);
    if (score > bestStart) {
      bestStart = score;
      start = i;
    }
  }
  let end = run.end;
  let bestEnd = -Infinity;
  for (let i = run.end - win; i <= run.end + win; i++) {
    if (i <= start || i > raw.length) continue;
    const score = side(i - win, i) - side(i, i + win);
    if (score > bestEnd) {
      bestEnd = score;
      end = i;
    }
  }
  return { start, end };
}

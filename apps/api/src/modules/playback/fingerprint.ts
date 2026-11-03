// Audio fingerprints for intro and credits detection. Arclight's own method, pure TypeScript:
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
  const power = realPowerSpectrum(frame);
  const e = new Float64Array(BANDS);
  for (let k = 0; k < power.length; k++) {
    const b = BIN_BAND[k]!;
    if (b >= 0) e[b]! += power[k]!;
  }
  return e;
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
  const frameCount = pcm.length < FRAME_SIZE ? 0 : Math.floor((pcm.length - FRAME_SIZE) / HOP) + 1;
  const n = Math.max(0, frameCount - SPAN + 1);
  const out = new Uint32Array(n);
  if (n === 0) return out;
  const energies: Float64Array[] = [];
  for (let t = 0; t < frameCount; t++) {
    energies.push(bandEnergies(pcm, t * HOP));
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
  return out;
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
  const threshold = opts.threshold ?? 0.7;
  const win = frames(opts.smoothMs ?? 2000);
  const gap = frames(opts.maxGapMs ?? 1500);
  let best: AlignedRun | null = null;
  for (const offset of yield* voteOffsetsSteps(a, b, opts.topOffsets ?? 3, opts.minVotes ?? 20, opts.maxBucket ?? 64)) {
    yield;
    const raw = similarityAt(a, b, offset);
    const run = longestRun(smooth(raw, win), threshold, gap);
    if (!run) continue;
    const edge = refineEdges(raw, run, win);
    // A code stops matching a little before the shared audio ends (its frames reach past it).
    edge.end = Math.min(a.length, edge.end + END_BIAS);
    let sum = 0;
    let n = 0;
    for (let i = edge.start; i < edge.end; i++) {
      if (!Number.isNaN(raw[i]!)) {
        sum += raw[i]!;
        n++;
      }
    }
    const cand: AlignedRun = { startA: edge.start, endA: edge.end, offset, similarity: n > 0 ? sum / n : 0 };
    if (!best || cand.endA - cand.startA > best.endA - best.startA) best = cand;
  }
  return best;
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

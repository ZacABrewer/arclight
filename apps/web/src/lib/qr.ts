// QR Code encoder (ISO/IEC 18004), byte mode only, for the mobile app pairing code. Small and
// dependency-free so the web app makes no third-party calls and adds no package. The structure
// follows Project Nayuki's reference "QR Code generator" (MIT): data → codewords → Reed-Solomon
// blocks → interleave → place → choose the mask with the lowest penalty.

export type QrEcc = 'L' | 'M' | 'Q' | 'H';

/** A square module grid; `true` is a dark module. */
export interface QrMatrix {
  size: number;
  version: number;
  mask: number;
  modules: boolean[][];
}

const ECC_FORMAT_BITS: Record<QrEcc, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Index = version (0 unused).
const ECC_CODEWORDS_PER_BLOCK: Record<QrEcc, readonly number[]> = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};
const NUM_ECC_BLOCKS: Record<QrEcc, readonly number[]> = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

/** Modules available for data and ECC in a version (everything but function patterns). */
export function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** Data codewords (bytes) a version holds at an error correction level. */
export function dataCodewords(version: number, ecc: QrEcc): number {
  return Math.floor(rawDataModules(version) / 8) - ECC_CODEWORDS_PER_BLOCK[ecc][version]! * NUM_ECC_BLOCKS[ecc][version]!;
}

// ---- Reed-Solomon over GF(2^8), polynomial 0x11D ----------------------------------------

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < result.length) result[j] = result[j]! ^ result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** The `degree` error correction codewords for `data`. */
export function reedSolomon(data: readonly number[], degree: number): number[] {
  const divisor = rsDivisor(degree);
  const result = new Array<number>(degree).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => (result[i] = result[i]! ^ gfMultiply(coef, factor)));
  }
  return result;
}

// ---- encoding -----------------------------------------------------------------------------

function utf8(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

/** Smallest version (1-40) whose capacity fits `bytes` bytes in byte mode. */
export function versionFor(byteLength: number, ecc: QrEcc): number {
  for (let v = 1; v <= 40; v++) {
    const countBits = v <= 9 ? 8 : 16;
    if (4 + countBits + byteLength * 8 <= dataCodewords(v, ecc) * 8) return v;
  }
  throw new RangeError('text too long for a QR code');
}

function dataBits(bytes: number[], version: number, ecc: QrEcc): number[] {
  const bits: number[] = [];
  const push = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const capacity = dataCodewords(version, ecc) * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  return out;
}

/** Split into blocks, append each block's ECC and interleave. */
export function interleaved(data: number[], version: number, ecc: QrEcc): number[] {
  const numBlocks = NUM_ECC_BLOCKS[ecc][version]!;
  const blockEcc = ECC_CODEWORDS_PER_BLOCK[ecc][version]!;
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const numShort = numBlocks - (rawCodewords % numBlocks);
  const shortLen = Math.floor(rawCodewords / numBlocks);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dataLen = shortLen - blockEcc + (i < numShort ? 0 : 1);
    const dat = data.slice(k, k + dataLen);
    k += dataLen;
    const block = [...dat];
    if (i < numShort) block.push(0); // placeholder so all blocks line up
    blocks.push([...block, ...reedSolomon(dat, blockEcc)]);
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - blockEcc || j >= numShort) result.push(block[i]!);
    });
  }
  return result;
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result = [6];
  for (let pos = version * 4 + 10; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

/** The 15 format bits (ECC level + mask, BCH coded, masked with 0x5412). */
export function formatBits(ecc: QrEcc, mask: number): number {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

const MASKS: ReadonlyArray<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class Grid {
  readonly modules: boolean[][];
  readonly fn: boolean[][];
  constructor(readonly size: number) {
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.fn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }
  set(x: number, y: number, dark: boolean) {
    this.modules[y]![x] = dark;
    this.fn[y]![x] = true;
  }
}

function drawFunctionPatterns(g: Grid, version: number) {
  const { size } = g;
  for (let i = 0; i < size; i++) {
    g.set(6, i, i % 2 === 0);
    g.set(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) g.set(x, y, d !== 2 && d !== 4);
      }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const align = alignmentPositions(version);
  const n = align.length;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) g.set(align[i]! + dx, align[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  drawFormat(g, 'M', 0); // reserve; real bits drawn after masking
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      g.set(a, b, bit);
      g.set(b, a, bit);
    }
  }
}

function drawFormat(g: Grid, ecc: QrEcc, mask: number) {
  const bits = formatBits(ecc, mask);
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  const { size } = g;
  for (let i = 0; i <= 5; i++) g.set(8, i, bit(i));
  g.set(8, 7, bit(6));
  g.set(8, 8, bit(7));
  g.set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) g.set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) g.set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) g.set(8, size - 15 + i, bit(i));
  g.set(8, size - 8, true); // dark module
}

function drawCodewords(g: Grid, codewords: number[]) {
  const { size } = g;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!g.fn[y]![x] && i < codewords.length * 8) {
          g.modules[y]![x] = ((codewords[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }
}

function applyMask(g: Grid, mask: number) {
  const f = MASKS[mask]!;
  for (let y = 0; y < g.size; y++) for (let x = 0; x < g.size; x++) if (!g.fn[y]![x] && f(x, y)) g.modules[y]![x] = !g.modules[y]![x];
}

/** ISO penalty score (lower is better). */
export function penalty(modules: boolean[][]): number {
  const size = modules.length;
  let result = 0;
  const line = (get: (i: number, j: number) => boolean) => {
    for (let i = 0; i < size; i++) {
      let run = 1;
      for (let j = 1; j <= size; j++) {
        if (j < size && get(i, j) === get(i, j - 1)) run++;
        else {
          if (run >= 5) result += 3 + (run - 5);
          run = 1;
        }
      }
      // Finder-like 1:1:3:1:1 with 4 light modules on one side.
      for (let j = 0; j + 10 < size + 1; j++) {
        const seq = (k: number) => (j + k < size ? get(i, j + k) : false);
        const core = seq(0) && !seq(1) && seq(2) && seq(3) && seq(4) && !seq(5) && seq(6);
        if (!core) continue;
        const after = [7, 8, 9, 10].every((k) => j + k >= size || !get(i, j + k));
        const before = [1, 2, 3, 4].every((k) => j - k < 0 || !get(i, j - k));
        if (after || before) result += 40;
      }
    }
  };
  line((i, j) => modules[i]![j]!);
  line((i, j) => modules[j]![i]!);
  for (let y = 0; y < size - 1; y++)
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y]![x];
      if (c === modules[y]![x + 1] && c === modules[y + 1]![x] && c === modules[y + 1]![x + 1]) result += 3;
    }
  let dark = 0;
  for (const row of modules) for (const m of row) if (m) dark++;
  const total = size * size;
  result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return result;
}

/** Encode `text` (UTF-8, byte mode). `mask` forces a mask pattern (tests); default picks the best. */
export function encodeQr(text: string, ecc: QrEcc = 'M', mask?: number): QrMatrix {
  const bytes = utf8(text);
  const version = versionFor(bytes.length, ecc);
  const codewords = interleaved(dataBits(bytes, version, ecc), version, ecc);
  const size = version * 4 + 17;
  const build = (m: number) => {
    const g = new Grid(size);
    drawFunctionPatterns(g, version);
    drawCodewords(g, codewords);
    applyMask(g, m);
    drawFormat(g, ecc, m);
    return g;
  };
  let best = mask ?? 0;
  if (mask === undefined) {
    let bestScore = Infinity;
    for (let m = 0; m < 8; m++) {
      const score = penalty(build(m).modules);
      if (score < bestScore) {
        bestScore = score;
        best = m;
      }
    }
  }
  return { size, version, mask: best, modules: build(best).modules };
}

/** SVG path data (one unit per module, offset by `quiet` modules of margin). */
export function qrPath(matrix: QrMatrix, quiet = 4): string {
  const parts: string[] = [];
  matrix.modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) parts.push(`M${x + quiet} ${y + quiet}h1v1h-1z`);
    });
  });
  return parts.join('');
}

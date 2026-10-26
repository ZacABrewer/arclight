// Minimal XZ (LZMA2) decompressor. Node's zlib has no xz support and Animetosho serves every
// attachment as .xz, so this is a small single-purpose decoder written from the published
// format descriptions (xz file format 1.0.4, LZMA2 chunk format, LZMA range coding).
// Supports: single or multiple blocks, LZMA2 filter only (no BCJ/delta), any check type
// (checks are skipped, not verified). Whole buffer in, whole buffer out.

export class XzError extends Error {
  readonly code = 'bad-archive';
  constructor(message: string) {
    super(`xz: ${message}`);
    this.name = 'XzError';
  }
}

export const XZ_MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] as const;

export function isXz(bytes: Uint8Array): boolean {
  return XZ_MAGIC.every((b, i) => bytes[i] === b);
}

/** Growable output buffer that doubles as the LZMA dictionary. */
class Output {
  buf = new Uint8Array(1 << 16);
  pos = 0;
  /** Start of the current dictionary (after a dictionary reset). */
  dictStart = 0;
  ensure(extra: number): void {
    if (this.pos + extra <= this.buf.length) return;
    let n = this.buf.length * 2;
    while (n < this.pos + extra) n *= 2;
    const next = new Uint8Array(n);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
  }
  put(b: number): void {
    if (this.pos >= this.buf.length) this.ensure(1);
    this.buf[this.pos++] = b;
  }
  /** Byte `dist + 1` positions back. */
  back(dist: number): number {
    const i = this.pos - dist - 1;
    if (i < this.dictStart) throw new XzError('distance beyond dictionary');
    return this.buf[i]!;
  }
  result(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

class RangeDecoder {
  private range = 0xffffffff;
  private code = 0;
  pos: number;
  constructor(
    private readonly input: Uint8Array,
    start: number,
    private readonly end: number,
  ) {
    this.pos = start;
    if (this.byte() !== 0) throw new XzError('corrupt range coder init');
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | this.byte()) >>> 0;
  }
  private byte(): number {
    if (this.pos >= this.end) throw new XzError('truncated LZMA data');
    return this.input[this.pos++]!;
  }
  private normalize(): void {
    if (this.range < 0x1000000) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.byte()) >>> 0;
    }
  }
  bit(probs: Uint16Array, i: number): number {
    const p = probs[i]!;
    const bound = (this.range >>> 11) * p;
    let b: number;
    if (this.code < bound) {
      this.range = bound;
      probs[i] = p + ((2048 - p) >>> 5);
      b = 0;
    } else {
      this.range -= bound;
      this.code -= bound;
      probs[i] = p - (p >>> 5);
      b = 1;
    }
    this.normalize();
    return b;
  }
  direct(count: number): number {
    let res = 0;
    for (let i = 0; i < count; i++) {
      this.range >>>= 1;
      let b = 0;
      if (this.code >= this.range) {
        this.code -= this.range;
        b = 1;
      }
      res = ((res << 1) | b) >>> 0;
      this.normalize();
    }
    return res;
  }
  tree(probs: Uint16Array, offset: number, bits: number): number {
    let m = 1;
    for (let i = 0; i < bits; i++) m = (m << 1) | this.bit(probs, offset + m);
    return m - (1 << bits);
  }
  reverseTree(probs: Uint16Array, offset: number, bits: number): number {
    let m = 1;
    let sym = 0;
    for (let i = 0; i < bits; i++) {
      const b = this.bit(probs, offset + m);
      m = (m << 1) | b;
      sym |= b << i;
    }
    return sym;
  }
}

const PROB_INIT = 1024;
const STATES = 12;
const POS_STATES_MAX = 16;
const END_POS_MODEL = 14;
const FULL_DISTANCES = 128;

class LengthDecoder {
  choice = new Uint16Array(2);
  low = new Uint16Array(POS_STATES_MAX << 3);
  mid = new Uint16Array(POS_STATES_MAX << 3);
  high = new Uint16Array(256);
  reset(): void {
    for (const a of [this.choice, this.low, this.mid, this.high]) a.fill(PROB_INIT);
  }
  // Trees are 1-based inside each 8-entry slot; slot index 0 is unused.
  decode(rc: RangeDecoder, posState: number): number {
    if (rc.bit(this.choice, 0) === 0) return rc.tree(this.low, posState << 3, 3);
    if (rc.bit(this.choice, 1) === 0) return 8 + rc.tree(this.mid, posState << 3, 3);
    return 16 + rc.tree(this.high, 0, 8);
  }
}

class LzmaDecoder {
  lc = 0;
  lp = 0;
  pb = 0;
  private literal = new Uint16Array(0x300);
  private isMatch = new Uint16Array(STATES << 4);
  private isRep = new Uint16Array(STATES);
  private isRepG0 = new Uint16Array(STATES);
  private isRepG1 = new Uint16Array(STATES);
  private isRepG2 = new Uint16Array(STATES);
  private isRep0Long = new Uint16Array(STATES << 4);
  private posSlot = new Uint16Array(4 << 6);
  private posSpecial = new Uint16Array(1 + FULL_DISTANCES - END_POS_MODEL);
  private align = new Uint16Array(16);
  private len = new LengthDecoder();
  private repLen = new LengthDecoder();
  private state = 0;
  private reps = [0, 0, 0, 0];

  setProps(byte: number): void {
    if (byte > 224) throw new XzError('invalid LZMA properties');
    this.lc = byte % 9;
    const rest = Math.floor(byte / 9);
    this.lp = rest % 5;
    this.pb = Math.floor(rest / 5);
    if (this.lc + this.lp > 4) throw new XzError('lc + lp > 4 not allowed in LZMA2');
    this.literal = new Uint16Array(0x300 << (this.lc + this.lp));
  }

  resetState(): void {
    for (const a of [this.literal, this.isMatch, this.isRep, this.isRepG0, this.isRepG1, this.isRepG2, this.isRep0Long, this.posSlot, this.posSpecial, this.align]) {
      a.fill(PROB_INIT);
    }
    this.len.reset();
    this.repLen.reset();
    this.state = 0;
    this.reps = [0, 0, 0, 0];
  }

  private distance(rc: RangeDecoder, len: number): number {
    const lenState = len < 3 ? len : 3;
    const slot = rc.tree(this.posSlot, lenState << 6, 6);
    if (slot < 4) return slot;
    const direct = (slot >>> 1) - 1;
    let dist = ((2 | (slot & 1)) << direct) >>> 0;
    if (slot < END_POS_MODEL) {
      dist += rc.reverseTree(this.posSpecial, dist - slot, direct);
    } else {
      dist += rc.direct(direct - 4) * 16;
      dist += rc.reverseTree(this.align, 0, 4);
    }
    return dist >>> 0;
  }

  decodeChunk(input: Uint8Array, start: number, packed: number, unpacked: number, out: Output): void {
    const rc = new RangeDecoder(input, start, start + packed);
    const target = out.pos + unpacked;
    out.ensure(unpacked);
    const pbMask = (1 << this.pb) - 1;
    const lpMask = (1 << this.lp) - 1;
    while (out.pos < target) {
      const posState = out.pos & pbMask;
      if (rc.bit(this.isMatch, (this.state << 4) + posState) === 0) {
        const prev = out.pos > out.dictStart ? out.buf[out.pos - 1]! : 0;
        const litState = ((out.pos & lpMask) << this.lc) + (prev >>> (8 - this.lc));
        const base = 0x300 * litState;
        let sym = 1;
        if (this.state >= 7) {
          let matchByte = out.back(this.reps[0]!);
          while (sym < 0x100) {
            const matchBit = (matchByte >>> 7) & 1;
            matchByte = (matchByte << 1) & 0xff;
            const b = rc.bit(this.literal, base + ((1 + matchBit) << 8) + sym);
            sym = (sym << 1) | b;
            if (matchBit !== b) break;
          }
        }
        while (sym < 0x100) sym = (sym << 1) | rc.bit(this.literal, base + sym);
        out.put(sym & 0xff);
        this.state = this.state < 4 ? 0 : this.state < 10 ? this.state - 3 : this.state - 6;
        continue;
      }
      let length: number;
      if (rc.bit(this.isRep, this.state) === 0) {
        this.reps = [0, this.reps[0]!, this.reps[1]!, this.reps[2]!];
        length = this.len.decode(rc, posState);
        this.state = this.state < 7 ? 7 : 10;
        this.reps[0] = this.distance(rc, length);
        if (this.reps[0] === 0xffffffff) throw new XzError('unexpected end marker in LZMA2');
      } else {
        if (rc.bit(this.isRepG0, this.state) === 0) {
          if (rc.bit(this.isRep0Long, (this.state << 4) + posState) === 0) {
            this.state = this.state < 7 ? 9 : 11;
            out.put(out.back(this.reps[0]!));
            continue;
          }
        } else {
          let dist: number;
          if (rc.bit(this.isRepG1, this.state) === 0) {
            dist = this.reps[1]!;
          } else {
            if (rc.bit(this.isRepG2, this.state) === 0) {
              dist = this.reps[2]!;
            } else {
              dist = this.reps[3]!;
              this.reps[3] = this.reps[2]!;
            }
            this.reps[2] = this.reps[1]!;
          }
          this.reps[1] = this.reps[0]!;
          this.reps[0] = dist;
        }
        length = this.repLen.decode(rc, posState);
        this.state = this.state < 7 ? 8 : 11;
      }
      let n = length + 2;
      if (out.pos + n > target) throw new XzError('match runs past chunk end');
      const d = this.reps[0]!;
      while (n-- > 0) out.put(out.back(d));
    }
  }
}

function readVarint(bytes: Uint8Array, pos: number): [number, number] {
  let value = 0;
  let shift = 0;
  for (let i = 0; i < 9; i++) {
    const b = bytes[pos++];
    if (b === undefined) throw new XzError('truncated varint');
    value += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return [value, pos];
    shift += 7;
  }
  throw new XzError('varint too long');
}

function checkSize(type: number): number {
  if (type === 0) return 0;
  return 4 * 2 ** Math.floor((type - 1) / 3);
}

/** Decode an LZMA2 raw stream starting at `pos`; returns the position after the end marker. */
function decodeLzma2(input: Uint8Array, pos: number, out: Output): number {
  const lzma = new LzmaDecoder();
  let needProps = true;
  for (;;) {
    const control = input[pos++];
    if (control === undefined) throw new XzError('truncated LZMA2 stream');
    if (control === 0x00) return pos;
    if (control === 0x01 || control === 0x02) {
      if (control === 0x01) out.dictStart = out.pos;
      const size = ((input[pos]! << 8) | input[pos + 1]!) + 1;
      pos += 2;
      if (pos + size > input.length) throw new XzError('truncated uncompressed chunk');
      out.ensure(size);
      out.buf.set(input.subarray(pos, pos + size), out.pos);
      out.pos += size;
      pos += size;
      continue;
    }
    if (control < 0x80) throw new XzError(`invalid LZMA2 control byte 0x${control.toString(16)}`);
    const unpacked = ((control & 0x1f) << 16) + (input[pos]! << 8) + input[pos + 1]! + 1;
    const packed = (input[pos + 2]! << 8) + input[pos + 3]! + 1;
    pos += 4;
    const reset = (control >>> 5) & 3;
    if (reset === 3) out.dictStart = out.pos;
    if (reset >= 2) {
      lzma.setProps(input[pos++]!);
      needProps = false;
    } else if (needProps) {
      throw new XzError('LZMA chunk without properties');
    }
    if (reset >= 1) lzma.resetState();
    lzma.decodeChunk(input, pos, packed, unpacked, out);
    pos += packed;
  }
}

/** Decompress a complete .xz buffer. */
export function xzDecompress(input: Uint8Array): Uint8Array {
  if (!isXz(input)) throw new XzError('not an xz stream');
  if (input.length < 12 + 12) throw new XzError('truncated stream');
  const checkType = input[7]! & 0x0f;
  const check = checkSize(checkType);
  const out = new Output();
  let pos = 12;
  for (;;) {
    const sizeByte = input[pos];
    if (sizeByte === undefined) throw new XzError('truncated before index');
    if (sizeByte === 0x00) break; // index indicator
    const blockStart = pos;
    const headerSize = (sizeByte + 1) * 4;
    const flags = input[pos + 1]!;
    let p = pos + 2;
    if (flags & 0x40) [, p] = readVarint(input, p);
    if (flags & 0x80) [, p] = readVarint(input, p);
    const filters = (flags & 0x03) + 1;
    for (let i = 0; i < filters; i++) {
      let id: number;
      let propSize: number;
      [id, p] = readVarint(input, p);
      [propSize, p] = readVarint(input, p);
      if (id !== 0x21 || i !== filters - 1) throw new XzError(`unsupported filter 0x${id.toString(16)}`);
      p += propSize;
    }
    pos = blockStart + headerSize;
    pos = decodeLzma2(input, pos, out);
    // Block padding to a multiple of four bytes, then the check field.
    while ((pos - 12) % 4 !== 0) pos++;
    pos += check;
  }
  return out.result();
}

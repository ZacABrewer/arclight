/** Fixed-length bit set, MSB-first per byte as used by the BitTorrent wire protocol. */
export class Bitfield {
  readonly length: number;
  readonly buffer: Buffer;
  private setCount = 0;

  constructor(length: number, source?: Uint8Array) {
    this.length = length;
    this.buffer = Buffer.alloc(Math.ceil(length / 8));
    if (source) {
      Buffer.from(source.buffer, source.byteOffset, Math.min(source.byteLength, this.buffer.length)).copy(
        this.buffer,
      );
      const spare = this.buffer.length * 8 - length;
      if (spare > 0 && this.buffer.length > 0) {
        const last = this.buffer.length - 1;
        this.buffer[last] = (this.buffer[last] ?? 0) & (0xff << spare) & 0xff;
      }
      this.recount();
    }
  }

  static full(length: number): Bitfield {
    const b = new Bitfield(length);
    for (let i = 0; i < length; i++) b.set(i);
    return b;
  }

  /** True when `source` has non-zero spare bits (a protocol violation for bitfield messages). */
  static hasSpareBits(length: number, source: Uint8Array): boolean {
    const spare = source.length * 8 - length;
    if (spare <= 0) return false;
    const last = source[source.length - 1] ?? 0;
    return (last & ((1 << spare) - 1)) !== 0;
  }

  private recount(): void {
    let c = 0;
    for (const byte of this.buffer) {
      let v = byte;
      while (v) {
        v &= v - 1;
        c++;
      }
    }
    this.setCount = c;
  }

  get(i: number): boolean {
    if (i < 0 || i >= this.length) return false;
    return ((this.buffer[i >> 3] ?? 0) & (0x80 >> (i & 7))) !== 0;
  }

  set(i: number, value = true): void {
    if (i < 0 || i >= this.length) throw new RangeError(`bit ${i} out of range 0..${this.length - 1}`);
    const idx = i >> 3;
    const mask = 0x80 >> (i & 7);
    const cur = this.buffer[idx] ?? 0;
    const had = (cur & mask) !== 0;
    if (value && !had) {
      this.buffer[idx] = cur | mask;
      this.setCount++;
    } else if (!value && had) {
      this.buffer[idx] = cur & ~mask;
      this.setCount--;
    }
  }

  count(): number {
    return this.setCount;
  }

  hasAll(): boolean {
    return this.setCount === this.length;
  }

  hasNone(): boolean {
    return this.setCount === 0;
  }

  clone(): Bitfield {
    return new Bitfield(this.length, this.buffer);
  }

  toBuffer(): Buffer {
    return Buffer.from(this.buffer);
  }

  *indices(): IterableIterator<number> {
    for (let i = 0; i < this.length; i++) if (this.get(i)) yield i;
  }
}

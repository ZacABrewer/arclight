// Fragmented MP4 as ffmpeg writes it to a pipe (`-movflags frag_keyframe+empty_moov+default_base_moof`):
// ftyp + moov (the init segment), then moof + mdat pairs, one per video keyframe. The HLS encoder
// reads that stream, keeps the init once, groups fragments into the planned segments and moves
// each track's decode times (tfdt) to media time. ffmpeg writes source timestamps (-copyts with
// frag_discont); media time is source time minus the plan's base. A decode time that would be
// negative (B-frame delay or audio priming at the very start of a film) becomes 0: video keeps its
// presentation times by moving the difference into signed composition offsets (trun version 1).

export interface Fmp4Track {
  id: number;
  timescale: number;
  kind: 'video' | 'audio' | 'other';
}

/** One moof + mdat. `tfdt` holds, per track, the byte offset of its tfdt value and the decode time. */
export interface Fmp4Fragment {
  bytes: Buffer;
  trafs: Array<{ trackId: number; tfdtOffset: number; tfdtVersion: number; decodeTime: bigint; firstCts: number; trun: BoxRef | null }>;
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf', 'edts', 'dinf']);

export interface BoxRef {
  type: string;
  start: number;
  headerSize: number;
  end: number;
}

/** The boxes directly inside `buf[start, end)`. */
export function childBoxes(buf: Buffer, start = 0, end = buf.length): BoxRef[] {
  const out: BoxRef[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = Number(buf.readBigUInt64BE(p + 8));
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) break;
    out.push({ type, start: p, headerSize: header, end: p + size });
    p += size;
  }
  return out;
}

/** The first box of `type` along a path (`['moov', 'trak']`), searching nested containers. */
export function findPath(buf: Buffer, path: readonly string[], start = 0, end = buf.length): BoxRef | null {
  const [head, ...rest] = path;
  for (const b of childBoxes(buf, start, end)) {
    if (b.type !== head) continue;
    if (rest.length === 0) return b;
    const found = findPath(buf, rest, b.start + b.headerSize, b.end);
    if (found) return found;
  }
  return null;
}

/** All boxes of `type` directly inside a container. */
export function childrenOf(buf: Buffer, box: BoxRef, type: string): BoxRef[] {
  return childBoxes(buf, box.start + box.headerSize, box.end).filter((b) => b.type === type);
}

/** Tracks of an init segment (moov → trak → tkhd id, mdhd timescale, hdlr type). */
export function initTracks(init: Buffer): Fmp4Track[] {
  const moov = findPath(init, ['moov']);
  if (!moov) return [];
  const tracks: Fmp4Track[] = [];
  for (const trak of childrenOf(init, moov, 'trak')) {
    const tkhd = childrenOf(init, trak, 'tkhd')[0];
    const mdia = childrenOf(init, trak, 'mdia')[0];
    if (!tkhd || !mdia) continue;
    const v = init[tkhd.start + tkhd.headerSize]!;
    const id = init.readUInt32BE(tkhd.start + tkhd.headerSize + (v === 1 ? 20 : 12));
    const mdhd = childrenOf(init, mdia, 'mdhd')[0];
    const hdlr = childrenOf(init, mdia, 'hdlr')[0];
    if (!mdhd || !hdlr) continue;
    const mv = init[mdhd.start + mdhd.headerSize]!;
    const timescale = init.readUInt32BE(mdhd.start + mdhd.headerSize + (mv === 1 ? 20 : 12));
    const handler = init.toString('latin1', hdlr.start + hdlr.headerSize + 8, hdlr.start + hdlr.headerSize + 12);
    tracks.push({ id, timescale, kind: handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : 'other' });
  }
  return tracks;
}

/** The sample-description box (stsd) of each track: two inits with the same stsd decode the same segments. */
export function initSignature(init: Buffer): string {
  const moov = findPath(init, ['moov']);
  if (!moov) return '';
  const parts: string[] = [];
  for (const trak of childrenOf(init, moov, 'trak')) {
    const stsd = findPath(init, ['mdia', 'minf', 'stbl', 'stsd'], trak.start + trak.headerSize, trak.end);
    if (stsd) parts.push(init.subarray(stsd.start, stsd.end).toString('hex'));
  }
  return parts.join('|');
}

function parseFragment(bytes: Buffer, moof: BoxRef): Fmp4Fragment {
  const trafs: Fmp4Fragment['trafs'] = [];
  for (const traf of childrenOf(bytes, moof, 'traf')) {
    const tfhd = childrenOf(bytes, traf, 'tfhd')[0];
    const tfdt = childrenOf(bytes, traf, 'tfdt')[0];
    if (!tfhd || !tfdt) continue;
    const trackId = bytes.readUInt32BE(tfhd.start + tfhd.headerSize + 4);
    const version = bytes[tfdt.start + tfdt.headerSize]!;
    const valueAt = tfdt.start + tfdt.headerSize + 4;
    // Signed: ffmpeg writes a negative start (two's complement) as it is.
    const decodeTime = version === 1 ? bytes.readBigInt64BE(valueAt) : BigInt(bytes.readUInt32BE(valueAt));
    trafs.push({ trackId, tfdtOffset: valueAt, tfdtVersion: version, decodeTime, firstCts: firstCompositionOffset(bytes, traf), trun: childrenOf(bytes, traf, 'trun')[0] ?? null });
  }
  return { bytes, trafs };
}

/** The composition offset of a traf's first sample (0 when the trun carries none). */
function firstCompositionOffset(buf: Buffer, traf: BoxRef): number {
  const trun = childrenOf(buf, traf, 'trun')[0];
  if (!trun) return 0;
  const at = trun.start + trun.headerSize;
  const version = buf[at]!;
  const flags = buf.readUIntBE(at + 1, 3);
  const count = buf.readUInt32BE(at + 4);
  if (count === 0 || !(flags & 0x800)) return 0;
  let p = at + 8;
  if (flags & 0x1) p += 4; // data offset
  if (flags & 0x4) p += 4; // first sample flags
  if (flags & 0x100) p += 4; // duration
  if (flags & 0x200) p += 4; // size
  if (flags & 0x400) p += 4; // flags
  return version === 0 ? buf.readUInt32BE(p) : buf.readInt32BE(p);
}

/**
 * Subtracts `ticks` from every sample's composition offset of a trun (in place; version 1, signed).
 * False when the trun carries no per-sample offsets.
 */
function lowerCompositions(buf: Buffer, trun: BoxRef, ticks: number): boolean {
  const at = trun.start + trun.headerSize;
  const version = buf[at]!;
  const flags = buf.readUIntBE(at + 1, 3);
  if (!(flags & 0x800)) return false;
  const count = buf.readUInt32BE(at + 4);
  let p = at + 8;
  if (flags & 0x1) p += 4;
  if (flags & 0x4) p += 4;
  const stride = (flags & 0x100 ? 4 : 0) + (flags & 0x200 ? 4 : 0) + (flags & 0x400 ? 4 : 0) + 4;
  const ctsAt = (flags & 0x100 ? 4 : 0) + (flags & 0x200 ? 4 : 0) + (flags & 0x400 ? 4 : 0);
  if (p + count * stride > trun.end) return false;
  for (let i = 0; i < count; i++) {
    const o = p + i * stride + ctsAt;
    const cts = version === 0 ? buf.readUInt32BE(o) : buf.readInt32BE(o);
    buf.writeInt32BE(cts - ticks, o);
  }
  buf[at] = 1;
  return true;
}

/** Adds `delta` (track timescale units) to each traf's decode time in place. */
export function shiftFragment(frag: Fmp4Fragment, deltas: ReadonlyMap<number, bigint>): void {
  for (const t of frag.trafs) {
    const delta = deltas.get(t.trackId) ?? 0n;
    let v = t.decodeTime + delta;
    if (v < 0n) {
      // Start of the film: decode from 0; video keeps its presentation times.
      if (t.trun && -v < 0x7fffffffn && lowerCompositions(frag.bytes, t.trun, Number(-v))) t.firstCts -= Number(-v);
      v = 0n;
    }
    if (t.tfdtVersion === 1) frag.bytes.writeBigUInt64BE(v, t.tfdtOffset);
    else {
      // ffmpeg writes version 1; a 32-bit tfdt only overflows after about a day of media.
      if (v > 0xffffffffn) throw new Error('tfdt overflow');
      frag.bytes.writeUInt32BE(Number(v), t.tfdtOffset);
    }
    t.decodeTime = v;
  }
}

/**
 * Removes a track's leading samples that start before `cut` (track timescale, the fragment's own
 * clock) and moves its decode time to the first kept sample. Returns the rewritten fragment and
 * whether a kept sample of the track was reached (false: every sample of it was before `cut`, or
 * the fragment has none). Keeps the fragment unchanged when its layout is not one it can rewrite.
 */
export function dropLeadingSamples(frag: Fmp4Fragment, trackId: number, cut: bigint): { frag: Fmp4Fragment; reached: boolean } {
  const bytes = frag.bytes;
  const moof = childBoxes(bytes)[0];
  if (!moof || moof.type !== 'moof' || moof.headerSize !== 8) return { frag, reached: true };
  const mdat = childBoxes(bytes, moof.end).find((b) => b.type === 'mdat');
  const t = frag.trafs.find((x) => x.trackId === trackId);
  if (!mdat || !t || !t.trun) return { frag, reached: !t ? false : true };
  const traf = childrenOf(bytes, moof, 'traf').find((b) => b.start < t.trun!.start && t.trun!.end <= b.end)!;
  const tfhd = childrenOf(bytes, traf, 'tfhd')[0]!;
  const hAt = tfhd.start + tfhd.headerSize;
  const hFlags = bytes.readUIntBE(hAt + 1, 3);
  if (hFlags & 0x1) return { frag, reached: true }; // explicit base data offset
  let q = hAt + 8;
  if (hFlags & 0x2) q += 4;
  const defDuration = hFlags & 0x8 ? bytes.readUInt32BE(q) : null;
  if (hFlags & 0x8) q += 4;
  const defSize = hFlags & 0x10 ? bytes.readUInt32BE(q) : null;

  const trun = t.trun;
  const at = trun.start + trun.headerSize;
  const flags = bytes.readUIntBE(at + 1, 3);
  if (!(flags & 0x1) || (!(flags & 0x100) && defDuration === null) || (!(flags & 0x200) && defSize === null)) return { frag, reached: true };
  const count = bytes.readUInt32BE(at + 4);
  const dataOffsetAt = at + 8;
  const dataOffset = bytes.readInt32BE(dataOffsetAt);
  let p = at + 12;
  if (flags & 0x4) p += 4;
  const stride = (flags & 0x100 ? 4 : 0) + (flags & 0x200 ? 4 : 0) + (flags & 0x400 ? 4 : 0) + (flags & 0x800 ? 4 : 0);
  if (p + count * stride > trun.end) return { frag, reached: true };
  const durationOf = (i: number) => (flags & 0x100 ? bytes.readUInt32BE(p + i * stride) : defDuration!);
  const sizeOf = (i: number) => (flags & 0x200 ? bytes.readUInt32BE(p + i * stride + (flags & 0x100 ? 4 : 0)) : defSize!);

  let n = 0;
  let start = t.decodeTime;
  let dataBytes = 0;
  while (n < count && start < cut) {
    start += BigInt(durationOf(n));
    dataBytes += sizeOf(n);
    n++;
  }
  const reached = n < count;
  if (n === 0) return { frag, reached };
  if (!reached) {
    // Keep one sample so the traf stays well-formed; it starts before the cut but is the last one.
    n--;
    start -= BigInt(durationOf(n));
    dataBytes -= sizeOf(n);
    if (n === 0) return { frag, reached };
  }

  const entryBytes = n * stride;
  const entriesAt = p;
  const dataAt = dataOffset; // relative to the moof start (default-base-is-moof), which is 0 here
  // Every data offset of the moof moves by the removed trun entries; data after the dropped bytes
  // moves by those too.
  const out = Buffer.concat([
    bytes.subarray(0, entriesAt),
    bytes.subarray(entriesAt + entryBytes, dataAt),
    bytes.subarray(dataAt + dataBytes),
  ]);
  const shrinkMoof = entryBytes;
  out.writeUInt32BE(moof.end - moof.start - shrinkMoof, 0);
  out.writeUInt32BE(traf.end - traf.start - shrinkMoof, traf.start);
  out.writeUInt32BE(trun.end - trun.start - shrinkMoof, trun.start);
  out.writeUInt32BE(count - n, at + 4);
  const mdatStart = mdat.start - shrinkMoof;
  out.writeUInt32BE(mdat.end - mdat.start - dataBytes, mdatStart);
  for (const other of childrenOf(bytes, moof, 'traf')) {
    for (const r of childrenOf(bytes, other, 'trun')) {
      const rAt = r.start + r.headerSize;
      if (!(bytes.readUIntBE(rAt + 1, 3) & 0x1)) continue;
      const off = bytes.readInt32BE(rAt + 8);
      const shift = shrinkMoof + (off > dataAt ? dataBytes : 0);
      // Offsets in the output: positions before the removed entries are unchanged.
      const outAt = rAt + 8 - (rAt > entriesAt ? shrinkMoof : 0);
      out.writeInt32BE(off - shift, outAt);
    }
  }
  const parsed = parseFragment(out, { type: 'moof', start: 0, headerSize: 8, end: moof.end - shrinkMoof });
  const nt = parsed.trafs.find((x) => x.trackId === trackId)!;
  if (nt.tfdtVersion === 1) out.writeBigInt64BE(start, nt.tfdtOffset);
  else {
    if (start < 0n || start > 0xffffffffn) return { frag, reached };
    out.writeUInt32BE(Number(start), nt.tfdtOffset);
  }
  nt.decodeTime = start;
  return { frag: parsed, reached };
}

/**
 * Splits a byte stream into the init segment (everything before the first moof) and fragments
 * (each moof with the mdat that follows). Feed chunks with push(); it calls the callbacks as soon
 * as a whole box is in.
 */
export class Fmp4Splitter {
  private buf: Buffer = Buffer.alloc(0);
  private initParts: Buffer[] = [];
  private initDone = false;
  private pendingMoof: { bytes: Buffer } | null = null;

  constructor(
    private readonly onInit: (init: Buffer) => void,
    private readonly onFragment: (frag: Fmp4Fragment) => void,
  ) {}

  push(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 8) return;
      let size = this.buf.readUInt32BE(0);
      let header = 8;
      if (size === 1) {
        if (this.buf.length < 16) return;
        size = Number(this.buf.readBigUInt64BE(8));
        header = 16;
      }
      if (size < header) throw new Error('bad MP4 box size');
      if (this.buf.length < size) return;
      const type = this.buf.toString('latin1', 4, 8);
      const box = Buffer.from(this.buf.subarray(0, size));
      this.buf = this.buf.subarray(size);
      this.handle(type, box);
    }
  }

  private handle(type: string, box: Buffer): void {
    if (type === 'moof') {
      if (!this.initDone) {
        this.initDone = true;
        this.onInit(Buffer.concat(this.initParts));
        this.initParts = [];
      }
      this.pendingMoof = { bytes: box };
      return;
    }
    if (type === 'mdat' && this.pendingMoof) {
      const bytes = Buffer.concat([this.pendingMoof.bytes, box]);
      const moofSize = this.pendingMoof.bytes.length;
      this.pendingMoof = null;
      this.onFragment(parseFragment(bytes, { type: 'moof', start: 0, headerSize: 8, end: moofSize }));
      return;
    }
    if (!this.initDone) {
      // ftyp, moov (and anything else ffmpeg puts before the first fragment).
      this.initParts.push(box);
    }
  }
}

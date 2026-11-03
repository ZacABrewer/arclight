// Fragmented MP4 as ffmpeg writes it to a pipe (`-movflags frag_keyframe+empty_moov+default_base_moof`):
// ftyp + moov (the init segment), then moof + mdat pairs, one per video keyframe. The HLS encoder
// reads that stream, keeps the init once, groups fragments into the planned segments and moves
// each track's decode times (tfdt) to media time: ffmpeg's MP4 muxer always starts a track at 0, so
// an encoder restarted at 20 minutes would otherwise claim its first segment is at 0.

export interface Fmp4Track {
  id: number;
  timescale: number;
  kind: 'video' | 'audio' | 'other';
}

/** One moof + mdat. `tfdt` holds, per track, the byte offset of its tfdt value and the decode time. */
export interface Fmp4Fragment {
  bytes: Buffer;
  trafs: Array<{ trackId: number; tfdtOffset: number; tfdtVersion: number; decodeTime: bigint; firstCts: number }>;
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
    const decodeTime = version === 1 ? bytes.readBigUInt64BE(valueAt) : BigInt(bytes.readUInt32BE(valueAt));
    trafs.push({ trackId, tfdtOffset: valueAt, tfdtVersion: version, decodeTime, firstCts: firstCompositionOffset(bytes, traf) });
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

/** Adds `delta` (track timescale units) to each traf's decode time in place. */
export function shiftFragment(frag: Fmp4Fragment, deltas: ReadonlyMap<number, bigint>): void {
  for (const t of frag.trafs) {
    const delta = deltas.get(t.trackId) ?? 0n;
    let v = t.decodeTime + delta;
    if (v < 0n) v = 0n;
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

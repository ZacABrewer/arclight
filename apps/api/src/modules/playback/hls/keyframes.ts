import { execFile } from 'node:child_process';
import { mkdir, open, readFile, rename, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { fileStamp, type Limiter } from '../video-stream.js';
import { childBoxes, childrenOf, findPath, type BoxRef } from './fmp4.js';

// Keyframe index of a video file: the presentation times of its video keyframes (where a copied
// segment may start) and, when known, the byte position of each one (exact per-segment bitrates
// for the `src` rung). Read from the container's own index when it has one (MKV Cues, MP4 stss),
// which touches a few KB; else from an ffprobe packet scan, which reads the whole file and so
// runs in the background. Kept on disk per file and file stamp.

export interface KeyframeIndex {
  v: 1;
  source: 'cues' | 'mp4' | 'ffprobe';
  /** Seconds, ascending. */
  keyframes: number[];
  /** File byte offset of each keyframe (same length), or null when unknown. */
  positions: number[] | null;
  fileSize: number;
  /** RFC 6381 codec string of the video track (avc1.640028, hvc1.2.4.L150.B0), when known. */
  codec: string | null;
  /** The container start time (ffprobe format=start_time): ffmpeg's -ss counts from it. 0 when unknown. */
  startTime?: number;
}

// ---- codec strings --------------------------------------------------------------------------------

/** `avc1.PPCCLL` from an AVCDecoderConfigurationRecord. */
export function avcCodecString(avcC: Buffer): string | null {
  if (avcC.length < 4 || avcC[0] !== 1) return null;
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `avc1.${hex(avcC[1]!)}${hex(avcC[2]!)}${hex(avcC[3]!)}`;
}

/** `hvc1.P.C.TL.B` from an HEVCDecoderConfigurationRecord (ISO/IEC 14496-15 annex E). */
export function hevcCodecString(hvcC: Buffer): string | null {
  if (hvcC.length < 13 || hvcC[0] !== 1) return null;
  const b1 = hvcC[1]!;
  const space = ['', 'A', 'B', 'C'][b1 >> 6]!;
  const tier = (b1 >> 5) & 1 ? 'H' : 'L';
  const profile = b1 & 0x1f;
  // The 32 compatibility flags in reverse bit order, as hex without leading zeros.
  const flags = hvcC.readUInt32BE(2);
  let rev = 0;
  for (let i = 0; i < 32; i++) if (flags & (1 << i)) rev |= 1 << (31 - i);
  const compat = (rev >>> 0).toString(16);
  const constraints = [...hvcC.subarray(6, 12)];
  while (constraints.length > 0 && constraints[constraints.length - 1] === 0) constraints.pop();
  const level = hvcC[12]!;
  const tail = constraints.map((c) => `.${c.toString(16).toUpperCase()}`).join('');
  return `hvc1.${space}${profile}.${compat}.${tier}${level}${tail}`;
}

const AVC_PROFILES: Record<string, [number, number]> = {
  baseline: [0x42, 0x00],
  'constrained baseline': [0x42, 0x40],
  main: [0x4d, 0x40],
  extended: [0x58, 0x00],
  high: [0x64, 0x00],
  'high 10': [0x6e, 0x00],
  'high 4:2:2': [0x7a, 0x00],
  'high 4:4:4 predictive': [0xf4, 0x00],
};

/** A codec string from ffprobe's profile name and level (when there is no codec record). */
export function codecStringFromProbe(codec: string, profile: string | null, level: number | null): string | null {
  if (level === null || level <= 0) return null;
  const p = (profile ?? '').toLowerCase();
  if (codec === 'h264') {
    const pc = AVC_PROFILES[p] ?? AVC_PROFILES['high']!;
    const hex = (n: number) => n.toString(16).padStart(2, '0');
    return `avc1.${hex(pc[0])}${hex(pc[1])}${hex(level)}`;
  }
  if (codec === 'hevc') return p.includes('10') ? `hvc1.2.4.L${level}.B0` : `hvc1.1.6.L${level}.B0`;
  return null;
}

// ---- reading helpers ----------------------------------------------------------------------------------

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

// ---- Matroska ---------------------------------------------------------------------------------------

const EBML = {
  header: 0x1a45dfa3,
  segment: 0x18538067,
  seekHead: 0x114d9b74,
  seek: 0x4dbb,
  seekId: 0x53ab,
  seekPosition: 0x53ac,
  info: 0x1549a966,
  timecodeScale: 0x2ad7b1,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackType: 0x83,
  codecId: 0x86,
  codecPrivate: 0x63a2,
  cues: 0x1c53bb6b,
  cuePoint: 0xbb,
  cueTime: 0xb3,
  cueTrackPositions: 0xb7,
  cueTrack: 0xf7,
  cueClusterPosition: 0xf1,
  cueRelativePosition: 0xf0,
  cluster: 0x1f43b675,
} as const;

interface EbmlEl {
  id: number;
  /** Offset of the element's data. */
  data: number;
  /** Data size; -1: unknown. */
  size: number;
  /** Offset after the element (data + size), or -1. */
  end: number;
}

function readVint(buf: Buffer, p: number, keepMarker: boolean): { value: number; len: number } | null {
  if (p >= buf.length) return null;
  const first = buf[p]!;
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && !(first & mask)) {
    len++;
    mask >>= 1;
  }
  if (len > 8 || p + len > buf.length) return null;
  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) {
    const b = buf[p + i]!;
    if (b !== 0xff) allOnes = false;
    value = value * 256 + b;
  }
  if (!keepMarker && allOnes) return { value: -1, len };
  return { value, len };
}

/** Element header at `p` in `buf`, with offsets shifted by `base` (the buffer's file offset). */
function ebmlAt(buf: Buffer, p: number, base: number): EbmlEl | null {
  const id = readVint(buf, p, true);
  if (!id) return null;
  const size = readVint(buf, p + id.len, false);
  if (!size) return null;
  const data = base + p + id.len + size.len;
  return { id: id.value, data, size: size.value, end: size.value < 0 ? -1 : data + size.value };
}

function ebmlChildren(buf: Buffer, start: number, end: number, base: number): EbmlEl[] {
  const out: EbmlEl[] = [];
  let p = start;
  while (p < end) {
    const el = ebmlAt(buf, p, base);
    if (!el || el.end < 0 || el.end - base > end) break;
    out.push(el);
    p = el.end - base;
  }
  return out;
}

const uintOf = (buf: Buffer, el: EbmlEl, base: number): number => {
  let v = 0;
  for (let i = 0; i < el.size; i++) v = v * 256 + buf[el.data - base + i]!;
  return v;
};

/** Keyframes from a Matroska file's Cues (the index muxers write for seeking). */
export async function readMkvIndex(path: string): Promise<KeyframeIndex | null> {
  const fh = await open(path, 'r');
  try {
    const fileSize = (await fh.stat()).size;
    const head = await readAt(fh, 0, Math.min(fileSize, 256 * 1024));
    const ebml = ebmlAt(head, 0, 0);
    if (!ebml || ebml.id !== EBML.header || ebml.end < 0) return null;
    const seg = ebmlAt(head, ebml.end, 0);
    if (!seg || seg.id !== EBML.segment) return null;
    const segData = seg.data;
    let timecodeScale = 1_000_000;
    let videoTrack: number | null = null;
    let codec: string | null = null;
    let cuesPos: number | null = null;

    // Top-level elements before the first cluster: SeekHead, Info, Tracks (and Cues, rarely).
    let p = segData;
    const parseTop = (buf: Buffer, base: number, el: EbmlEl) => {
      const children = ebmlChildren(buf, el.data - base, el.end - base, base);
      if (el.id === EBML.seekHead) {
        for (const seek of children.filter((c) => c.id === EBML.seek)) {
          const parts = ebmlChildren(buf, seek.data - base, seek.end - base, base);
          const idEl = parts.find((c) => c.id === EBML.seekId);
          const posEl = parts.find((c) => c.id === EBML.seekPosition);
          if (idEl && posEl && uintOf(buf, idEl, base) === EBML.cues) cuesPos = segData + uintOf(buf, posEl, base);
        }
      } else if (el.id === EBML.info) {
        const tcs = children.find((c) => c.id === EBML.timecodeScale);
        if (tcs) timecodeScale = uintOf(buf, tcs, base);
      } else if (el.id === EBML.tracks) {
        for (const entry of children.filter((c) => c.id === EBML.trackEntry)) {
          const f = ebmlChildren(buf, entry.data - base, entry.end - base, base);
          const type = f.find((c) => c.id === EBML.trackType);
          const num = f.find((c) => c.id === EBML.trackNumber);
          if (!type || !num || uintOf(buf, type, base) !== 1 || videoTrack !== null) continue;
          videoTrack = uintOf(buf, num, base);
          const id = f.find((c) => c.id === EBML.codecId);
          const priv = f.find((c) => c.id === EBML.codecPrivate);
          const codecId = id ? buf.toString('latin1', id.data - base, id.end - base).replace(/\0+$/, '') : '';
          const record = priv ? buf.subarray(priv.data - base, priv.end - base) : null;
          if (record && codecId === 'V_MPEG4/ISO/AVC') codec = avcCodecString(record);
          else if (record && codecId === 'V_MPEGH/ISO/HEVC') codec = hevcCodecString(record);
        }
      }
    };
    let cuesEl: { buf: Buffer; base: number; el: EbmlEl } | null = null;
    for (let guard = 0; guard < 64 && p < fileSize; guard++) {
      let buf = head;
      let base = 0;
      if (p + 16 > head.length) {
        buf = await readAt(fh, p, 16);
        base = p;
      }
      const el = ebmlAt(buf, p - base, base);
      if (!el || el.end < 0 || el.id === EBML.cluster) break;
      if (el.id === EBML.seekHead || el.id === EBML.info || el.id === EBML.tracks || el.id === EBML.cues) {
        let body = buf;
        let bodyBase = base;
        if (el.end - base > buf.length) {
          if (el.size > 64 * 1024 * 1024) return null;
          body = await readAt(fh, p, el.end - p);
          bodyBase = p;
        }
        if (el.id === EBML.cues) cuesEl = { buf: body, base: bodyBase, el };
        else parseTop(body, bodyBase, el);
      }
      p = el.end;
    }
    if (videoTrack === null) return null;
    if (!cuesEl && cuesPos !== null) {
      const hdr = await readAt(fh, cuesPos, 16);
      const el = ebmlAt(hdr, 0, cuesPos);
      if (!el || el.id !== EBML.cues || el.end < 0 || el.size > 64 * 1024 * 1024) return null;
      const body = await readAt(fh, cuesPos, el.end - cuesPos);
      cuesEl = { buf: body, base: cuesPos, el };
    }
    if (!cuesEl) return null;
    const { buf, base, el } = cuesEl;
    const points: Array<{ t: number; pos: number }> = [];
    for (const cp of ebmlChildren(buf, el.data - base, el.end - base, base)) {
      if (cp.id !== EBML.cuePoint) continue;
      const f = ebmlChildren(buf, cp.data - base, cp.end - base, base);
      const time = f.find((c) => c.id === EBML.cueTime);
      if (!time) continue;
      for (const tp of f.filter((c) => c.id === EBML.cueTrackPositions)) {
        const g = ebmlChildren(buf, tp.data - base, tp.end - base, base);
        const track = g.find((c) => c.id === EBML.cueTrack);
        if (!track || uintOf(buf, track, base) !== videoTrack) continue;
        const cluster = g.find((c) => c.id === EBML.cueClusterPosition);
        const rel = g.find((c) => c.id === EBML.cueRelativePosition);
        const pos = cluster ? segData + uintOf(buf, cluster, base) + (rel ? uintOf(buf, rel, base) : 0) : -1;
        points.push({ t: (uintOf(buf, time, base) * timecodeScale) / 1e9, pos });
      }
    }
    if (points.length === 0) return null;
    points.sort((a, b) => a.t - b.t);
    const hasPos = points.every((x) => x.pos >= 0);
    return { v: 1, source: 'cues', keyframes: points.map((x) => round6(x.t)), positions: hasPos ? points.map((x) => x.pos) : null, fileSize, codec };
  } finally {
    await fh.close();
  }
}

// ---- MP4 / MOV ------------------------------------------------------------------------------------

/** Keyframes from an MP4's sample tables (stss + stts + ctts + elst). Null for fragmented files. */
export async function readMp4Index(path: string): Promise<KeyframeIndex | null> {
  const fh = await open(path, 'r');
  try {
    const fileSize = (await fh.stat()).size;
    let p = 0;
    let moov: Buffer | null = null;
    for (let guard = 0; guard < 1000 && p + 8 <= fileSize; guard++) {
      const h = await readAt(fh, p, 16);
      if (h.length < 8) break;
      let size = h.readUInt32BE(0);
      const type = h.toString('latin1', 4, 8);
      if (size === 1) size = Number(h.readBigUInt64BE(8));
      else if (size === 0) size = fileSize - p;
      if (size < 8) break;
      if (type === 'moov') {
        if (size > 128 * 1024 * 1024) return null;
        moov = await readAt(fh, p, size);
        break;
      }
      p += size;
    }
    if (!moov) return null;
    return mp4IndexFromMoov(moov, fileSize);
  } finally {
    await fh.close();
  }
}

/** The index from a whole moov box (exported for tests). */
export function mp4IndexFromMoov(moov: Buffer, fileSize: number): KeyframeIndex | null {
  const root = childBoxes(moov)[0];
  if (!root || root.type !== 'moov') return null;
  const mvhd = childrenOf(moov, root, 'mvhd')[0];
  const movieScale = mvhd ? moov.readUInt32BE(mvhd.start + mvhd.headerSize + (moov[mvhd.start + mvhd.headerSize] === 1 ? 20 : 12)) : 1000;
  for (const trak of childrenOf(moov, root, 'trak')) {
    const inner = (path: string[]) => findPath(moov, path, trak.start + trak.headerSize, trak.end);
    const hdlr = inner(['mdia', 'hdlr']);
    if (!hdlr || moov.toString('latin1', hdlr.start + hdlr.headerSize + 8, hdlr.start + hdlr.headerSize + 12) !== 'vide') continue;
    const mdhd = inner(['mdia', 'mdhd'])!;
    const ts = moov.readUInt32BE(mdhd.start + mdhd.headerSize + (moov[mdhd.start + mdhd.headerSize] === 1 ? 20 : 12));
    const stbl = inner(['mdia', 'minf', 'stbl']);
    if (!stbl || ts <= 0) return null;
    const box = (type: string): BoxRef | undefined => childrenOf(moov, stbl, type)[0];
    const body = (b: BoxRef) => b.start + b.headerSize;
    const stts = box('stts');
    const stsz = box('stsz');
    if (!stts || !stsz) return null;
    const sampleCount = moov.readUInt32BE(body(stsz) + 8);
    if (sampleCount === 0) return null; // fragmented: the samples live in moofs

    // Decode times.
    const dts = new Float64Array(sampleCount);
    {
      let i = 0;
      let t = 0;
      const n = moov.readUInt32BE(body(stts) + 4);
      for (let e = 0; e < n && i < sampleCount; e++) {
        const count = moov.readUInt32BE(body(stts) + 8 + e * 8);
        const delta = moov.readUInt32BE(body(stts) + 12 + e * 8);
        for (let k = 0; k < count && i < sampleCount; k++, i++) {
          dts[i] = t;
          t += delta;
        }
      }
    }
    // Composition offsets.
    const ctts = box('ctts');
    const cts = (sample: number): number => {
      if (!ctts) return 0;
      const version = moov[body(ctts)]!;
      const n = moov.readUInt32BE(body(ctts) + 4);
      let i = 0;
      for (let e = 0; e < n; e++) {
        const count = moov.readUInt32BE(body(ctts) + 8 + e * 8);
        if (sample < i + count) return version === 1 ? moov.readInt32BE(body(ctts) + 12 + e * 8) : moov.readUInt32BE(body(ctts) + 12 + e * 8);
        i += count;
      }
      return 0;
    };
    // Edit list: an empty edit delays the track; media_time is where presentation starts.
    let shiftSec = 0;
    const elst = inner(['edts', 'elst']);
    if (elst) {
      const version = moov[body(elst)]!;
      const n = moov.readUInt32BE(body(elst) + 4);
      const entry = version === 1 ? 20 : 12;
      let delay = 0;
      for (let e = 0; e < n; e++) {
        const at = body(elst) + 8 + e * entry;
        const dur = version === 1 ? Number(moov.readBigUInt64BE(at)) : moov.readUInt32BE(at);
        const mediaTime = version === 1 ? Number(moov.readBigInt64BE(at + 8)) : moov.readInt32BE(at + 4);
        if (mediaTime === -1) {
          delay += dur / movieScale;
          continue;
        }
        shiftSec = delay - mediaTime / ts;
        break;
      }
    }
    // Sync samples (no stss: every sample is one).
    const stss = box('stss');
    let sync: number[];
    if (stss) {
      const n = moov.readUInt32BE(body(stss) + 4);
      sync = [];
      for (let e = 0; e < n; e++) sync.push(moov.readUInt32BE(body(stss) + 8 + e * 4) - 1);
    } else {
      sync = Array.from({ length: sampleCount }, (_, i) => i);
    }
    // Byte offsets of the sync samples (stsc + stco/co64 + stsz).
    const positions = sampleOffsets(moov, box('stsc'), box('stco') ?? box('co64'), stsz, sampleCount, new Set(sync));
    const keyframes = sync.filter((s) => s < sampleCount).map((s) => round6((dts[s]! + cts(s)) / ts + shiftSec));
    const pos = positions ? sync.filter((s) => s < sampleCount).map((s) => positions.get(s) ?? -1) : null;
    const order = keyframes.map((t, i) => ({ t, p: pos ? pos[i]! : -1 })).sort((a, b) => a.t - b.t);
    const stsd = box('stsd');
    return {
      v: 1,
      source: 'mp4',
      keyframes: order.map((x) => x.t),
      positions: pos && order.every((x) => x.p >= 0) ? order.map((x) => x.p) : null,
      fileSize,
      codec: stsd ? codecFromStsd(moov, stsd) : null,
    };
  }
  return null;
}

function sampleOffsets(moov: Buffer, stsc: BoxRef | undefined, stco: BoxRef | undefined, stsz: BoxRef, sampleCount: number, wanted: Set<number>): Map<number, number> | null {
  if (!stsc || !stco) return null;
  const body = (b: BoxRef) => b.start + b.headerSize;
  const co64 = stco.type === 'co64';
  const chunks = moov.readUInt32BE(body(stco) + 4);
  const chunkOffset = (c: number) => (co64 ? Number(moov.readBigUInt64BE(body(stco) + 8 + c * 8)) : moov.readUInt32BE(body(stco) + 8 + c * 4));
  const fixed = moov.readUInt32BE(body(stsz) + 4);
  const sizeOf = (s: number) => (fixed !== 0 ? fixed : moov.readUInt32BE(body(stsz) + 12 + s * 4));
  const entries = moov.readUInt32BE(body(stsc) + 4);
  const out = new Map<number, number>();
  let sample = 0;
  for (let e = 0; e < entries && sample < sampleCount; e++) {
    const first = moov.readUInt32BE(body(stsc) + 8 + e * 12) - 1;
    const perChunk = moov.readUInt32BE(body(stsc) + 12 + e * 12);
    const nextFirst = e + 1 < entries ? moov.readUInt32BE(body(stsc) + 8 + (e + 1) * 12) - 1 : chunks;
    for (let c = first; c < nextFirst && sample < sampleCount; c++) {
      let off = chunkOffset(c);
      for (let k = 0; k < perChunk && sample < sampleCount; k++, sample++) {
        if (wanted.has(sample)) out.set(sample, off);
        off += sizeOf(sample);
      }
    }
  }
  return out;
}

function codecFromStsd(moov: Buffer, stsd: BoxRef): string | null {
  // stsd: version/flags (4), entry count (4), then sample entries; a visual sample entry has 78 bytes before its boxes.
  const entries = childBoxes(moov, stsd.start + stsd.headerSize + 8, stsd.end);
  const entry = entries[0];
  if (!entry) return null;
  for (const b of childBoxes(moov, entry.start + entry.headerSize + 78, entry.end)) {
    const rec = moov.subarray(b.start + b.headerSize, b.end);
    if (b.type === 'avcC') return avcCodecString(rec);
    if (b.type === 'hvcC') return hevcCodecString(rec);
  }
  return null;
}

// ---- ffprobe ------------------------------------------------------------------------------------------

export type ProbeExec = (bin: string, args: readonly string[]) => Promise<string>;

const nodeProbeExec: ProbeExec = (bin, args) =>
  new Promise((resolve, reject) => {
    execFile(bin, [...args], { maxBuffer: 512 * 1024 * 1024, windowsHide: true, timeout: 30 * 60_000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });

/** Parses `ffprobe -show_entries packet=pts_time,pos,flags -of compact=p=0` output (video packets). */
export function parseProbePackets(out: string): Array<{ t: number; pos: number }> {
  const points: Array<{ t: number; pos: number }> = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes('flags=K')) continue;
    const t = Number(/pts_time=([-0-9.]+)/.exec(line)?.[1]);
    const pos = Number(/pos=(\d+)/.exec(line)?.[1] ?? -1);
    if (Number.isFinite(t)) points.push({ t, pos: Number.isFinite(pos) ? pos : -1 });
  }
  return points.sort((a, b) => a.t - b.t);
}

/** The index from a packet scan (reads the whole file). */
export async function probeIndex(bin: string, path: string, exec: ProbeExec = nodeProbeExec): Promise<KeyframeIndex | null> {
  const fileSize = (await stat(path)).size;
  const stream = await exec(bin, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,profile,level', '-of', 'compact=p=0', path]);
  const codecName = /codec_name=([a-z0-9]+)/.exec(stream)?.[1] ?? '';
  const profile = /profile=([^|\r\n]+)/.exec(stream)?.[1] ?? null;
  const level = Number(/level=(-?\d+)/.exec(stream)?.[1] ?? NaN);
  const out = await exec(bin, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,pos,flags', '-of', 'compact=p=0', path]);
  const points = parseProbePackets(out);
  if (points.length === 0) return null;
  return {
    v: 1,
    source: 'ffprobe',
    keyframes: points.map((p) => round6(p.t)),
    positions: points.every((p) => p.pos >= 0) ? points.map((p) => p.pos) : null,
    fileSize,
    codec: codecStringFromProbe(codecName, profile, Number.isFinite(level) ? level : null),
  };
}

/** `start_time=1.400000` → 1.4 (0 when absent). */
export function parseStartTime(out: string): number {
  const v = Number(/start_time=(-?[0-9.]+)/.exec(out)?.[1]);
  return Number.isFinite(v) ? round6(v) : 0;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

// ---- the indexer --------------------------------------------------------------------------------------

export interface KeyframeIndexerOptions {
  /** configDir/cache/player/keyframes */
  dir: string;
  locateProbe: () => Promise<string | null>;
  /** Packet scans run here (BackgroundMediaLimiter). */
  limiter: Limiter;
  exec?: ProbeExec;
  log?: { warn: (obj: object, msg: string) => void };
}

/**
 * Keyframe indexes on disk (`f<id>-<stamp>.json`). get() answers from disk or the container index
 * at once; a file without one gets a background packet scan and null until it is done.
 */
export class KeyframeIndexer {
  private readonly scans = new Map<string, Promise<KeyframeIndex | null>>();

  constructor(private readonly opts: KeyframeIndexerOptions) {}

  private fileOf(fileId: number, stamp: string): string {
    return join(this.opts.dir, `f${fileId}-${stamp}.json`);
  }

  /** The index, or null while a packet scan is pending (`wait`: wait for the scan). */
  async get(fileId: number, path: string, opts: { wait?: boolean } = {}): Promise<KeyframeIndex | null> {
    const stamp = await fileStamp(path);
    if (!stamp) return null;
    const target = this.fileOf(fileId, stamp);
    try {
      const cached = JSON.parse(await readFile(target, 'utf8')) as KeyframeIndex;
      if (cached.v === 1 && Array.isArray(cached.keyframes)) return cached;
    } catch {
      // not cached yet
    }
    let index: KeyframeIndex | null = null;
    try {
      const lower = path.toLowerCase();
      if (/\.(mkv|mk3d|webm)$/.test(lower)) index = await readMkvIndex(path);
      else if (/\.(mp4|m4v|mov)$/.test(lower)) index = await readMp4Index(path);
    } catch {
      index = null;
    }
    // A container index with a single keyframe is not one (some muxers index only the start).
    if (index && index.keyframes.length >= 2) {
      index.startTime = await this.startTimeOf(path);
      await this.save(target, index);
      return index;
    }
    const running = this.scans.get(target) ?? this.scan(fileId, path, target);
    return opts.wait ? running : null;
  }

  private scan(fileId: number, path: string, target: string): Promise<KeyframeIndex | null> {
    const job = this.opts.limiter
      .run(async () => {
        const bin = await this.opts.locateProbe();
        if (!bin) return null;
        const index = await probeIndex(bin, path, this.opts.exec);
        if (index) {
          index.startTime = await this.startTimeOf(path);
          await this.save(target, index);
        }
        return index;
      })
      .catch((err: unknown) => {
        this.opts.log?.warn({ err, fileId }, 'could not build the keyframe index');
        return null;
      })
      .finally(() => this.scans.delete(target));
    this.scans.set(target, job);
    return job;
  }

  /** The container start time (reads the header only). */
  private async startTimeOf(path: string): Promise<number> {
    try {
      const bin = await this.opts.locateProbe();
      if (!bin) return 0;
      const out = await (this.opts.exec ?? nodeProbeExec)(bin, ['-v', 'error', '-show_entries', 'format=start_time', '-of', 'compact=p=0', path]);
      return parseStartTime(out);
    } catch {
      return 0;
    }
  }

  private async save(target: string, index: KeyframeIndex): Promise<void> {
    await mkdir(this.opts.dir, { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(index));
    try {
      await rename(tmp, target);
    } catch {
      await rm(tmp, { force: true });
    }
  }
}

/** The keyframe at or before `sec` (seconds), else null. */
export function keyframeAtOrBefore(index: Pick<KeyframeIndex, 'keyframes'>, sec: number): number | null {
  const k = index.keyframes;
  let lo = 0;
  let hi = k.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (k[mid]! <= sec + 1e-6) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best >= 0 ? k[best]! : null;
}

/** Where to seek ffmpeg so a copy starts on keyframe `kf`: a little after it (demuxers seek by decode time). */
export function copySeekTarget(index: Pick<KeyframeIndex, 'keyframes'>, kf: number): number {
  const next = index.keyframes.find((t) => t > kf + 1e-6);
  const gap = next === undefined ? 1 : next - kf;
  return kf + Math.min(0.25, gap / 2);
}

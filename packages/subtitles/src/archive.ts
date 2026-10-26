import { gunzipSync, inflateRawSync } from 'node:zlib';
import { detectFormatFromBytes } from './formats.js';
import type { SubtitleFile } from './types.js';
import { isXz, xzDecompress } from './xz.js';

// Archive handling (spec providers 1.11): sniff by content, read zip (store/deflate),
// gunzip, un-xz, refuse rar/7z, and pick the right subtitle entry out of a pack.

export type ArchiveKind = 'zip' | 'rar' | '7z' | 'gzip' | 'xz' | 'none';

export class ArchiveError extends Error {
  readonly code: 'unsupported-archive' | 'bad-archive' | 'no-subtitle';
  constructor(code: ArchiveError['code'], message: string) {
    super(message);
    this.name = 'ArchiveError';
    this.code = code;
  }
}

const startsWith = (b: Uint8Array, sig: readonly number[]) => sig.every((x, i) => b[i] === x);

export function sniffArchive(bytes: Uint8Array): ArchiveKind {
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) return 'zip';
  if (startsWith(bytes, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return 'rar';
  if (startsWith(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7z';
  if (startsWith(bytes, [0x1f, 0x8b])) return 'gzip';
  if (isXz(bytes)) return 'xz';
  return 'none';
}

export interface ZipEntry {
  name: string;
  size: number;
  compressedSize: number;
  method: number;
  encrypted: boolean;
  /** Decompress the entry. */
  read(): Uint8Array;
}

/** Read a zip's central directory. Supports store (0) and deflate (8); no zip64. */
export function readZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const minPos = Math.max(0, bytes.length - 22 - 65535);
  for (let i = bytes.length - 22; i >= minPos; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ArchiveError('bad-archive', 'zip: end of central directory not found');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  const utf8 = new TextDecoder('utf-8');
  const cp437ish = new TextDecoder('latin1');
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) {
      throw new ArchiveError('bad-archive', 'zip: corrupt central directory');
    }
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const rawName = bytes.subarray(p + 46, p + 46 + nameLen);
    const name = (flags & 0x800 ? utf8 : cp437ish).decode(rawName);
    p += 46 + nameLen + extraLen + commentLen;
    const encrypted = (flags & 1) === 1;
    entries.push({
      name,
      size,
      compressedSize,
      method,
      encrypted,
      read: () => {
        if (encrypted) throw new ArchiveError('unsupported-archive', `zip: ${name} is encrypted`);
        if (view.getUint32(localOffset, true) !== 0x04034b50) throw new ArchiveError('bad-archive', 'zip: bad local header');
        const ln = view.getUint16(localOffset + 26, true);
        const le = view.getUint16(localOffset + 28, true);
        const start = localOffset + 30 + ln + le;
        const data = bytes.subarray(start, start + compressedSize);
        if (method === 0) return data.slice();
        if (method === 8) return new Uint8Array(inflateRawSync(data));
        throw new ArchiveError('unsupported-archive', `zip: compression method ${method} not supported`);
      },
    });
  }
  return entries;
}

export function gunzip(bytes: Uint8Array): Uint8Array {
  try {
    return new Uint8Array(gunzipSync(bytes));
  } catch (err) {
    throw new ArchiveError('bad-archive', `gzip: ${(err as Error).message}`);
  }
}

const SUBTITLE_EXT = /\.(srt|ass|ssa|sub|vtt)$/i;

/** OS junk and non-subtitle files never picked from an archive. */
export function isJunkEntry(name: string): boolean {
  if (/(^|\/)__MACOSX\//.test(name)) return true;
  const base = name.split(/[\\/]/).pop() ?? name;
  return base.startsWith('.') || base === '' || /\/$/.test(name);
}

/** Season/episode numbers in an entry name: S01E02, 1x02, E02, "- 02". */
export function parseEntryEpisode(name: string): { season?: number; episode?: number } {
  const base = name.split(/[\\/]/).pop() ?? name;
  let m = /s(\d{1,2})[ ._-]*e(\d{1,4})/i.exec(base);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  m = /(?:^|[^\d])(\d{1,2})x(\d{2,3})(?:[^\d]|$)/i.exec(base);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  m = /(?:^|[ ._\-[])(?:e|ep|episode)[ ._]?(\d{1,4})(?:v\d)?(?=[ ._\-\]]|$)/i.exec(base);
  if (m) return { episode: Number(m[1]) };
  m = /(?:^|[ ._])-[ ._]?(\d{2,4})(?:v\d)?(?=[ ._[(]|\.\w+$)/.exec(base);
  if (m) return { episode: Number(m[1]) };
  return {};
}

export interface PickHints {
  season?: number | undefined;
  episode?: number | undefined;
  absoluteEpisode?: number | undefined;
  forced?: boolean | undefined;
  /** Video release name, used to break ties by token overlap. */
  releaseName?: string | undefined;
  episodeTitle?: string | undefined;
}

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1));
}

/**
 * Choose one entry from candidate subtitle names (spec 1.11.2): forced preference, then
 * episode tiers (matching > unsure > fallback), then token overlap with the release name.
 */
export function pickEntry<T extends { name: string }>(entries: readonly T[], hints: PickHints = {}): T | undefined {
  let list = entries.filter((e) => SUBTITLE_EXT.test(e.name) && !isJunkEntry(e.name));
  if (list.length <= 1) return list[0];
  const forcedNames = list.filter((e) => /forced/i.test(e.name));
  if (hints.forced && forcedNames.length > 0) list = forcedNames;
  else if (!hints.forced && forcedNames.length < list.length) list = list.filter((e) => !/forced/i.test(e.name));
  if (list.length === 1) return list[0];

  const targets = [hints.episode, hints.absoluteEpisode].filter((n): n is number => n !== undefined);
  let pool = list;
  if (targets.length > 0) {
    const matching: T[] = [];
    const unsure: T[] = [];
    const fallback: T[] = [];
    for (const e of list) {
      const p = parseEntryEpisode(e.name);
      if (p.episode === undefined) unsure.push(e);
      else if (targets.includes(p.episode) && (p.season === undefined || hints.season === undefined || p.season === hints.season)) matching.push(e);
      else fallback.push(e);
    }
    pool = matching.length ? matching : unsure.length ? unsure : fallback;
  }
  if (pool.length === 1) return pool[0];
  const ref = tokens(`${hints.releaseName ?? ''} ${hints.episodeTitle ?? ''}`);
  if (ref.size === 0) return pool[0];
  let best = pool[0];
  let bestScore = -1;
  for (const e of pool) {
    let s = 0;
    for (const t of tokens(e.name)) if (ref.has(t)) s++;
    if (s > bestScore) {
      best = e;
      bestScore = s;
    }
  }
  return best;
}

/**
 * Turn a downloaded payload into a single subtitle file: unwrap gzip/xz, open zip and pick an
 * entry; rar and 7z are refused. Non-archive payloads pass through.
 */
export function extractSubtitle(file: SubtitleFile, hints: PickHints = {}, depth = 0): SubtitleFile {
  const kind = sniffArchive(file.bytes);
  switch (kind) {
    case 'none':
      return file;
    case 'rar':
      throw new ArchiveError('unsupported-archive', 'rar archives are not supported');
    case '7z':
      throw new ArchiveError('unsupported-archive', '7z archives are not supported');
    case 'gzip':
    case 'xz': {
      if (depth > 2) throw new ArchiveError('bad-archive', 'archive nesting too deep');
      const bytes = kind === 'gzip' ? gunzip(file.bytes) : unxz(file.bytes);
      const name = file.fileName?.replace(/\.(gz|xz)$/i, '');
      return extractSubtitle({ bytes, format: detectFormatFromBytes(bytes, name), encoding: 'unknown', ...(name ? { fileName: name } : {}) }, hints, depth + 1);
    }
    case 'zip': {
      const entries = readZip(file.bytes);
      const chosen = pickEntry(entries, hints);
      if (!chosen) throw new ArchiveError('no-subtitle', 'archive contains no subtitle file');
      const bytes = chosen.read();
      const base = chosen.name.split(/[\\/]/).pop() ?? chosen.name;
      return { bytes, format: detectFormatFromBytes(bytes, base), encoding: 'unknown', fileName: base };
    }
  }
}

function unxz(bytes: Uint8Array): Uint8Array {
  try {
    return xzDecompress(bytes);
  } catch (err) {
    throw new ArchiveError('bad-archive', (err as Error).message);
  }
}

/** Write a store-only zip (used by tests and for bundling extra formats). */
export function writeZip(files: ReadonlyArray<{ name: string; data: Uint8Array }>): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new Uint8Array(30 + name.length + f.data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x800, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, f.data.length, true);
    lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(f.data, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x800, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

let CRC_TABLE: Uint32Array | undefined;
export function crc32(data: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of data) crc = CRC_TABLE[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

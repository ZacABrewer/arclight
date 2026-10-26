import { createHash } from 'node:crypto';
import {
  type BDict,
  type BValue,
  decode,
  getBytes,
  getDict,
  getInt,
  getList,
  isDict,
  rawDictValues,
  toBuffer,
} from './bencode.js';
import { TorrentEngineError } from './errors.js';

/** One file of a torrent, with its byte offset inside the concatenated torrent payload. */
export interface TorrentFileEntry {
  index: number;
  /** Path relative to the torrent root, `/`-separated, already sanitised. */
  path: string;
  pathSegments: string[];
  length: number;
  /** Offset of the first byte of this file inside the torrent payload. */
  offset: number;
  /** BEP 47 padding file: never written to disk, its content is all zero bytes. */
  padding: boolean;
}

export type MetainfoVersion = 'v1' | 'v2' | 'hybrid';

/** Parsed torrent metadata. Only `v1` and `hybrid` torrents can be downloaded. */
export interface Metainfo {
  /** SHA-1 of the bencoded info dict (v1/hybrid) or the truncated v2 hash (v2-only). */
  infoHash: Buffer;
  /** Lowercase hex of `infoHash`. */
  infoHashHex: string;
  /** SHA-256 of the info dict when the torrent has v2 metadata. */
  infoHashV2?: Buffer;
  version: MetainfoVersion;
  name: string;
  pieceLength: number;
  /** 20-byte SHA-1 hash per piece (empty for v2-only torrents). */
  pieceHashes: Buffer[];
  pieceCount: number;
  totalLength: number;
  files: TorrentFileEntry[];
  /** True when the torrent has a `files` list (a directory), false for single-file torrents. */
  isMultiFile: boolean;
  private: boolean;
  announce?: string;
  /** BEP 12 tiers; contains `[announce]` when no announce-list was present. */
  announceList: string[][];
  /** BEP 19 web seeds (parsed, not used for downloading yet). */
  urlList: string[];
  comment?: string;
  createdBy?: string;
  /** Seconds since epoch. */
  creationDate?: number;
  /** Raw bencoded info dict, exactly as hashed. */
  info: Buffer;
}

function fail(message: string): never {
  throw new TorrentEngineError('metainfo', message);
}

const WINDOWS_ILLEGAL = /[<>:"|?*\u0000-\u001f]/g;

/** Makes a single path component safe for any filesystem; throws on traversal attempts. */
export function sanitizeSegment(raw: string): string {
  if (raw === '' || raw === '.' || raw === '..') fail(`invalid path component "${raw}"`);
  if (raw.includes('/') || raw.includes('\\')) fail(`path component contains a separator: "${raw}"`);
  let s = raw.replace(WINDOWS_ILLEGAL, '_');
  // Windows silently strips trailing dots and spaces; make them explicit.
  s = s.replace(/[. ]+$/, (m) => '_'.repeat(m.length));
  return s;
}

function utf8Or(d: BDict, key: string): Buffer | undefined {
  return getBytes(d, `${key}.utf-8`) ?? getBytes(d, key);
}

function str(v: BValue | undefined): string | undefined {
  return Buffer.isBuffer(v) ? v.toString('utf8') : undefined;
}

function parseV1Files(info: BDict, name: string): { files: TorrentFileEntry[]; multi: boolean } {
  const list = getList(info, 'files');
  const files: TorrentFileEntry[] = [];
  if (list === undefined) {
    const length = getInt(info, 'length');
    if (length === undefined || length < 0) fail('single-file torrent without a valid length');
    files.push({ index: 0, path: name, pathSegments: [name], length, offset: 0, padding: false });
    return { files, multi: false };
  }
  if (list.length === 0) fail('empty files list');
  let offset = 0;
  for (const [i, entry] of list.entries()) {
    if (!isDict(entry)) fail(`files[${i}] is not a dictionary`);
    const length = getInt(entry, 'length');
    if (length === undefined || length < 0) fail(`files[${i}] has no valid length`);
    const pathList = getList(entry, 'path.utf-8') ?? getList(entry, 'path');
    if (pathList === undefined || pathList.length === 0) fail(`files[${i}] has no path`);
    const segments = pathList.map((p) => {
      const s = str(p);
      if (s === undefined) fail(`files[${i}] has a non-string path component`);
      return sanitizeSegment(s);
    });
    const attr = str(entry.attr) ?? '';
    const segmentsWithRoot = [name, ...segments];
    files.push({
      index: i,
      path: segmentsWithRoot.join('/'),
      pathSegments: segmentsWithRoot,
      length,
      offset,
      padding: attr.includes('p'),
    });
    offset += length;
  }
  return { files, multi: true };
}

function parseV2Tree(tree: BDict, name: string): TorrentFileEntry[] {
  const files: TorrentFileEntry[] = [];
  let offset = 0;
  const walk = (node: BDict, prefix: string[]): void => {
    for (const key of Object.keys(node).sort()) {
      const child = node[key];
      if (!isDict(child)) fail('malformed v2 file tree');
      if (key === '') {
        const length = getInt(child, 'length') ?? fail('v2 file without length');
        files.push({
          index: files.length,
          path: [name, ...prefix].join('/'),
          pathSegments: [name, ...prefix],
          length,
          offset,
          padding: false,
        });
        offset += length;
      } else {
        walk(child, [...prefix, sanitizeSegment(Buffer.from(key, 'latin1').toString('utf8'))]);
      }
    }
  };
  walk(tree, []);
  if (files.length === 0) fail('empty v2 file tree');
  return files;
}

export interface InfoDictResult {
  infoHash: Buffer;
  infoHashV2?: Buffer;
  version: MetainfoVersion;
  name: string;
  pieceLength: number;
  pieceHashes: Buffer[];
  totalLength: number;
  files: TorrentFileEntry[];
  isMultiFile: boolean;
  private: boolean;
}

/** Parses a raw bencoded info dict (as received through BEP 9 metadata exchange). */
export function parseInfoDict(infoBytes: Uint8Array): InfoDictResult {
  const raw = toBuffer(infoBytes);
  const decoded = decode(raw);
  if (!isDict(decoded)) fail('info is not a dictionary');
  const info = decoded;
  const nameBuf = utf8Or(info, 'name');
  if (!nameBuf || nameBuf.length === 0) fail('info has no name');
  const name = sanitizeSegment(nameBuf.toString('utf8'));
  const pieceLength = getInt(info, 'piece length');
  if (pieceLength === undefined || pieceLength <= 0) fail('info has no valid piece length');
  const metaVersion = getInt(info, 'meta version');
  const tree = getDict(info, 'file tree');
  const hasV2 = metaVersion === 2 && tree !== undefined;
  const pieces = getBytes(info, 'pieces');
  const hasV1 = pieces !== undefined;
  if (!hasV1 && !hasV2) fail('info has neither v1 pieces nor a v2 file tree');

  const sha1 = createHash('sha1').update(raw).digest();
  const sha256 = hasV2 ? createHash('sha256').update(raw).digest() : undefined;

  let files: TorrentFileEntry[];
  let multi: boolean;
  const pieceHashes: Buffer[] = [];
  if (hasV1) {
    ({ files, multi } = parseV1Files(info, name));
    if (pieces.length % 20 !== 0) fail('pieces length is not a multiple of 20');
    for (let i = 0; i < pieces.length; i += 20) pieceHashes.push(Buffer.from(pieces.subarray(i, i + 20)));
  } else {
    files = parseV2Tree(tree as BDict, name);
    multi = files.length > 1 || (files[0]?.pathSegments.length ?? 1) > 1;
  }
  const totalLength = files.reduce((n, f) => n + f.length, 0);
  if (hasV1) {
    const expected = Math.ceil(totalLength / pieceLength);
    if (expected !== pieceHashes.length)
      fail(`piece count mismatch: ${pieceHashes.length} hashes for ${expected} pieces`);
  }
  const version: MetainfoVersion = hasV1 && hasV2 ? 'hybrid' : hasV2 ? 'v2' : 'v1';
  const result: InfoDictResult = {
    infoHash: hasV1 ? sha1 : (sha256 as Buffer).subarray(0, 20),
    version,
    name,
    pieceLength,
    pieceHashes,
    totalLength,
    files,
    isMultiFile: multi,
    private: getInt(info, 'private') === 1,
  };
  if (sha256) result.infoHashV2 = sha256;
  return result;
}

/** Parses a .torrent file. */
export function parseTorrent(data: Uint8Array): Metainfo {
  const buf = toBuffer(data);
  const root = decode(buf);
  if (!isDict(root)) fail('torrent is not a dictionary');
  const rawInfo = rawDictValues(buf).get('info');
  if (!rawInfo || !isDict(root.info)) fail('torrent has no info dictionary');
  const info = parseInfoDict(rawInfo);

  const announce = str(root.announce);
  const announceList: string[][] = [];
  for (const tier of getList(root, 'announce-list') ?? []) {
    if (!Array.isArray(tier)) continue;
    const urls = tier.map(str).filter((u): u is string => u !== undefined && u.length > 0);
    if (urls.length > 0) announceList.push(urls);
  }
  if (announceList.length === 0 && announce) announceList.push([announce]);

  const urlList: string[] = [];
  const ul = root['url-list'];
  if (Buffer.isBuffer(ul)) {
    if (ul.length > 0) urlList.push(ul.toString('utf8'));
  } else if (Array.isArray(ul)) {
    for (const u of ul) {
      const s = str(u);
      if (s) urlList.push(s);
    }
  }

  const meta: Metainfo = {
    ...info,
    infoHashHex: info.infoHash.toString('hex'),
    pieceCount: info.pieceHashes.length,
    announceList,
    urlList,
    info: Buffer.from(rawInfo),
  };
  if (announce) meta.announce = announce;
  const comment = str(root['comment.utf-8'] ?? root.comment);
  if (comment) meta.comment = comment;
  const createdBy = str(root['created by']);
  if (createdBy) meta.createdBy = createdBy;
  const date = getInt(root, 'creation date');
  if (date !== undefined) meta.creationDate = date;
  return meta;
}

/** Builds a `Metainfo` from a raw info dict plus tracker hints (for magnet downloads). */
export function metainfoFromInfo(infoBytes: Uint8Array, trackers: string[] = []): Metainfo {
  const info = parseInfoDict(infoBytes);
  return {
    ...info,
    infoHashHex: info.infoHash.toString('hex'),
    pieceCount: info.pieceHashes.length,
    announceList: trackers.map((t) => [t]),
    urlList: [],
    info: Buffer.from(toBuffer(infoBytes)),
  };
}

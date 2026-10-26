import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { encode, type BEncodable } from './bencode.js';
import { TorrentEngineError } from './errors.js';
import { type Metainfo, parseTorrent } from './metainfo.js';

export interface CreateTorrentFile {
  /** Path segments below the torrent root. */
  path: string[];
  data: Uint8Array;
}

export interface CreateTorrentOptions {
  name: string;
  /** One entry makes a single-file torrent unless `forceMultiFile` is set. */
  files: CreateTorrentFile[];
  pieceLength?: number;
  forceMultiFile?: boolean;
  /** One URL, or BEP 12 tiers. */
  announce?: string | string[][];
  private?: boolean;
  comment?: string;
  createdBy?: string;
  /** Seconds since epoch; omitted when undefined. */
  creationDate?: number;
  urlList?: string[];
}

/** Picks a power-of-two piece length aiming at ~1000-2000 pieces, between 16 KiB and 16 MiB. */
export function choosePieceLength(totalLength: number): number {
  let len = 16 * 1024;
  while (len < 16 * 1024 * 1024 && totalLength / len > 2000) len *= 2;
  return len;
}

/** Builds a v1 .torrent from in-memory file data. Returns the bytes and the parsed metainfo. */
export function createTorrent(opts: CreateTorrentOptions): { torrent: Buffer; metainfo: Metainfo } {
  if (opts.files.length === 0) throw new TorrentEngineError('metainfo', 'cannot create a torrent with no files');
  const total = opts.files.reduce((n, f) => n + f.data.length, 0);
  const pieceLength = opts.pieceLength ?? choosePieceLength(total);
  const payload = Buffer.concat(opts.files.map((f) => Buffer.from(f.data)));
  const hashes: Buffer[] = [];
  for (let off = 0; off < payload.length; off += pieceLength) {
    hashes.push(createHash('sha1').update(payload.subarray(off, off + pieceLength)).digest());
  }
  const multi = opts.forceMultiFile === true || opts.files.length > 1;
  const info: Record<string, BEncodable> = {
    name: opts.name,
    'piece length': pieceLength,
    pieces: Buffer.concat(hashes),
  };
  if (multi) info.files = opts.files.map((f) => ({ length: f.data.length, path: f.path }));
  else info.length = total;
  if (opts.private) info.private = 1;

  const root: Record<string, BEncodable> = { info };
  if (typeof opts.announce === 'string') root.announce = opts.announce;
  else if (opts.announce && opts.announce.length > 0) {
    root.announce = opts.announce[0]?.[0] ?? '';
    root['announce-list'] = opts.announce;
  }
  if (opts.comment) root.comment = opts.comment;
  if (opts.createdBy) root['created by'] = opts.createdBy;
  if (opts.creationDate !== undefined) root['creation date'] = opts.creationDate;
  if (opts.urlList && opts.urlList.length > 0) root['url-list'] = opts.urlList;
  const torrent = encode(root);
  return { torrent, metainfo: parseTorrent(torrent) };
}

async function walk(dir: string, prefix: string[], out: CreateTorrentFile[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, [...prefix, e.name], out);
    else if (e.isFile()) out.push({ path: [...prefix, e.name], data: await readFile(full) });
  }
}

/** Builds a torrent from a file or directory on disk (reads everything into memory). */
export async function createTorrentFromPath(
  path: string,
  opts: Omit<CreateTorrentOptions, 'files' | 'name'> & { name?: string } = {},
): Promise<{ torrent: Buffer; metainfo: Metainfo }> {
  const s = await stat(path);
  const files: CreateTorrentFile[] = [];
  if (s.isDirectory()) await walk(path, [], files);
  else files.push({ path: [basename(path)], data: await readFile(path) });
  return createTorrent({ ...opts, name: opts.name ?? basename(path), files, forceMultiFile: s.isDirectory() });
}

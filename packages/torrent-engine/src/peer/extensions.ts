import { createHash } from 'node:crypto';
import {
  type BDict,
  type BEncodable,
  decode,
  decodePrefix,
  encode,
  getBytes,
  getDict,
  getInt,
  getString,
  isDict,
} from '../bencode.js';
import { isIPv6 } from 'node:net';
import {
  addressKey,
  bytesToIpv6,
  decodeCompactPeers,
  decodeCompactPeers6,
  encodeCompactPeer,
  encodeCompactPeers,
  encodeCompactPeers6,
  ipv6ToBytes,
  type PeerAddress,
} from '../compact.js';
import { TorrentEngineError } from '../errors.js';

/** Our local extension message ids (what peers must use when sending to us). */
export const LOCAL_EXT = { ut_metadata: 1, ut_pex: 2 } as const;
export type ExtensionName = keyof typeof LOCAL_EXT;

export const METADATA_PIECE_SIZE = 16 * 1024;
export const MAX_METADATA_SIZE = 16 * 1024 * 1024;

export interface ExtendedHandshake {
  /** Remote extension ids by name (0 = disabled). */
  m: Partial<Record<string, number>>;
  metadataSize?: number;
  /** Remote listen port. */
  port?: number;
  client?: string;
  /** Max outstanding requests the peer accepts. */
  reqq?: number;
  /** Our address as the peer sees it. */
  yourIp?: string;
}

export function encodeExtendedHandshake(opts: {
  extensions: Partial<Record<ExtensionName, number>>;
  metadataSize?: number;
  port?: number;
  client?: string;
  reqq?: number;
  yourIp?: string;
}): Buffer {
  const d: Record<string, BEncodable> = { m: opts.extensions };
  if (opts.metadataSize !== undefined) d.metadata_size = opts.metadataSize;
  if (opts.port) d.p = opts.port;
  if (opts.client) d.v = opts.client;
  if (opts.reqq) d.reqq = opts.reqq;
  if (opts.yourIp && /^\d+\.\d+\.\d+\.\d+$/.test(opts.yourIp)) d.yourip = encodeCompactPeer({ host: opts.yourIp, port: 0 }).subarray(0, 4);
  else if (opts.yourIp && isIPv6(opts.yourIp)) d.yourip = ipv6ToBytes(opts.yourIp);
  return encode(d);
}

export function decodeExtendedHandshake(payload: Buffer): ExtendedHandshake {
  const v = decode(payload);
  if (!isDict(v)) throw new TorrentEngineError('peer', 'extended handshake is not a dictionary');
  const m: Partial<Record<string, number>> = {};
  const md = getDict(v, 'm');
  if (md) for (const [k, id] of Object.entries(md)) if (typeof id === 'number' && id >= 0 && id < 256) m[k] = id;
  const hs: ExtendedHandshake = { m };
  const size = getInt(v, 'metadata_size');
  if (size !== undefined && size > 0) hs.metadataSize = size;
  const p = getInt(v, 'p');
  if (p !== undefined && p > 0 && p < 65536) hs.port = p;
  const client = getString(v, 'v');
  if (client) hs.client = client;
  const reqq = getInt(v, 'reqq');
  if (reqq !== undefined && reqq > 0) hs.reqq = reqq;
  const ip = getBytes(v, 'yourip');
  if (ip?.length === 4) hs.yourIp = `${ip[0]}.${ip[1]}.${ip[2]}.${ip[3]}`;
  else if (ip?.length === 16) hs.yourIp = bytesToIpv6(ip);
  return hs;
}

// ---- BEP 9 ut_metadata -------------------------------------------------------------------

export type MetadataMessage =
  | { msgType: 0; piece: number }
  | { msgType: 1; piece: number; totalSize: number; data: Buffer }
  | { msgType: 2; piece: number };

export function encodeMetadataMessage(m: MetadataMessage): Buffer {
  if (m.msgType === 1)
    return Buffer.concat([encode({ msg_type: 1, piece: m.piece, total_size: m.totalSize }), m.data]);
  return encode({ msg_type: m.msgType, piece: m.piece });
}

export function decodeMetadataMessage(payload: Buffer): MetadataMessage {
  const { value, end } = decodePrefix(payload);
  if (!isDict(value)) throw new TorrentEngineError('peer', 'ut_metadata message is not a dictionary');
  const type = getInt(value, 'msg_type');
  const piece = getInt(value, 'piece');
  if (piece === undefined || piece < 0) throw new TorrentEngineError('peer', 'ut_metadata message without piece');
  if (type === 0) return { msgType: 0, piece };
  if (type === 2) return { msgType: 2, piece };
  if (type === 1) return { msgType: 1, piece, totalSize: getInt(value, 'total_size') ?? 0, data: payload.subarray(end) };
  throw new TorrentEngineError('peer', `unknown ut_metadata msg_type ${String(type)}`);
}

export function metadataPieceCount(size: number): number {
  return Math.ceil(size / METADATA_PIECE_SIZE);
}

/** Slice of the info dict served for metadata piece `piece`. */
export function metadataPiece(info: Buffer, piece: number): Buffer | null {
  const start = piece * METADATA_PIECE_SIZE;
  if (start >= info.length || piece < 0) return null;
  return info.subarray(start, start + METADATA_PIECE_SIZE);
}

/**
 * Assembles the info dict from ut_metadata pieces and verifies it against the info-hash.
 * Tracks which pieces are outstanding so several peers can contribute.
 */
export class MetadataAssembler {
  private size = 0;
  private pieces: (Buffer | null)[] = [];
  private requested = new Map<number, { peer: string; at: number }>();

  constructor(
    readonly infoHash: Buffer,
    private readonly now: () => number = Date.now,
  ) {}

  get totalSize(): number {
    return this.size;
  }

  /** Accepts a metadata size announced by a peer. Returns false when it is invalid or conflicting. */
  setSize(size: number): boolean {
    if (size <= 0 || size > MAX_METADATA_SIZE) return false;
    if (this.size === 0) {
      this.size = size;
      this.pieces = new Array<Buffer | null>(metadataPieceCount(size)).fill(null);
      return true;
    }
    return this.size === size;
  }

  /** Next piece to request from `peer` (pieces time out after `timeoutMs`), or null. */
  nextRequest(peer: string, timeoutMs = 10_000): number | null {
    const now = this.now();
    for (let i = 0; i < this.pieces.length; i++) {
      if (this.pieces[i]) continue;
      const r = this.requested.get(i);
      if (r && now - r.at < timeoutMs) continue;
      this.requested.set(i, { peer, at: now });
      return i;
    }
    return null;
  }

  /** Frees pieces requested from a peer that rejected us or disconnected. */
  release(peer: string, piece?: number): void {
    for (const [i, r] of this.requested) if (r.peer === peer && (piece === undefined || piece === i)) this.requested.delete(i);
  }

  /**
   * Stores a piece. Returns the full verified info dict once complete, `null` while pieces
   * are missing. Throws (and resets) when the assembled data does not match the info-hash.
   */
  add(piece: number, data: Buffer): Buffer | null {
    if (this.size === 0 || piece < 0 || piece >= this.pieces.length) return null;
    const expected = piece === this.pieces.length - 1 ? this.size - piece * METADATA_PIECE_SIZE : METADATA_PIECE_SIZE;
    if (data.length !== expected) return null;
    this.pieces[piece] = Buffer.from(data);
    this.requested.delete(piece);
    if (this.pieces.some((p) => p === null)) return null;
    const full = Buffer.concat(this.pieces as Buffer[]);
    const hash = createHash('sha1').update(full).digest();
    if (!hash.equals(this.infoHash)) {
      this.pieces.fill(null);
      throw new TorrentEngineError('peer', 'received metadata does not match the info-hash');
    }
    return full;
  }
}

// ---- BEP 11 ut_pex -----------------------------------------------------------------------

/** BEP 11 `added.f` flags. */
export const PEX_FLAG = { prefersEncryption: 0x01, seed: 0x02, utp: 0x04, holepunch: 0x08, reachable: 0x10 } as const;

/** A PEX peer; `flags` is only present when non-zero. */
export interface PexPeer extends PeerAddress {
  flags?: number;
}

export interface PexMessage {
  added: PexPeer[];
  dropped: PeerAddress[];
}

export const PEX_MAX_ADDED = 50;

export function encodePex(m: PexMessage): Buffer {
  const v4 = m.added.filter((p) => !isIPv6(p.host));
  const v6 = m.added.filter((p) => isIPv6(p.host));
  const d: Record<string, BEncodable> = {
    added: encodeCompactPeers(v4),
    'added.f': Buffer.from(v4.map((p) => p.flags ?? 0)),
    dropped: encodeCompactPeers(m.dropped),
  };
  if (v6.length > 0) {
    d.added6 = encodeCompactPeers6(v6);
    d['added6.f'] = Buffer.from(v6.map((p) => p.flags ?? 0));
  }
  const dropped6 = encodeCompactPeers6(m.dropped);
  if (dropped6.length > 0) d.dropped6 = dropped6;
  return encode(d);
}

function withFlags(peers: PeerAddress[], flags: Buffer | undefined): PexPeer[] {
  return peers.map((p, i) => {
    const f = flags?.[i] ?? 0;
    return f ? { ...p, flags: f } : p;
  });
}

export function decodePex(payload: Buffer): PexMessage {
  const v = decode(payload);
  if (!isDict(v)) throw new TorrentEngineError('peer', 'ut_pex message is not a dictionary');
  const d: BDict = v;
  return {
    added: [
      ...withFlags(decodeCompactPeers(getBytes(d, 'added') ?? Buffer.alloc(0)), getBytes(d, 'added.f')),
      ...withFlags(decodeCompactPeers6(getBytes(d, 'added6') ?? Buffer.alloc(0)), getBytes(d, 'added6.f')),
    ],
    dropped: [
      ...decodeCompactPeers(getBytes(d, 'dropped') ?? Buffer.alloc(0)),
      ...decodeCompactPeers6(getBytes(d, 'dropped6') ?? Buffer.alloc(0)),
    ],
  };
}

/** Per-connection PEX state: computes the diff to send against what the peer was told. */
export class PexTracker {
  private sent = new Map<string, PexPeer>();

  /** Returns the next message for `current` peers (excluding the receiver), or null if nothing changed. */
  diff(current: readonly PexPeer[]): PexMessage | null {
    const now = new Map(current.map((p) => [addressKey(p), p]));
    const added: PexPeer[] = [];
    const dropped: PeerAddress[] = [];
    for (const [k, p] of now) {
      if (added.length >= PEX_MAX_ADDED) break;
      if (!this.sent.has(k)) added.push(p);
    }
    for (const [k, p] of this.sent) if (!now.has(k) && dropped.length < PEX_MAX_ADDED) dropped.push(p);
    if (added.length === 0 && dropped.length === 0) return null;
    for (const p of added) this.sent.set(addressKey(p), p);
    for (const p of dropped) this.sent.delete(addressKey(p));
    return { added, dropped };
  }
}

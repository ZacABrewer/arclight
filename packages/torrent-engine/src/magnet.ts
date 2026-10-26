import type { PeerAddress } from './compact.js';
import { TorrentEngineError } from './errors.js';

/** A parsed magnet link. */
export interface MagnetLink {
  /** 20-byte v1 info-hash (or truncated v2 hash for btmh-only magnets). */
  infoHash: Buffer;
  infoHashHex: string;
  /** 32-byte SHA-256 v2 info-hash from a `urn:btmh:1220...` topic. */
  infoHashV2?: Buffer;
  name?: string;
  trackers: string[];
  /** `x.pe` peer hints. */
  peers: PeerAddress[];
  /** `ws` web seeds (parsed only). */
  webSeeds: string[];
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input: string): Buffer {
  const s = input.toUpperCase().replace(/=+$/, '');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of s) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new TorrentEngineError('magnet', `invalid base32 character "${ch}"`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function base32Encode(data: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function parsePeer(raw: string): PeerAddress | null {
  const idx = raw.lastIndexOf(':');
  if (idx <= 0) return null;
  let host = raw.slice(0, idx);
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const port = Number(raw.slice(idx + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

function baseKey(key: string): string {
  // `tr.1`, `xt.2` ... are numbered variants of the same parameter.
  return key.replace(/\.\d+$/, '');
}

/** Parses a `magnet:?xt=urn:btih:...` URI. Throws `TorrentEngineError('magnet')`. */
export function parseMagnet(uri: string): MagnetLink {
  if (!uri.toLowerCase().startsWith('magnet:?')) throw new TorrentEngineError('magnet', 'not a magnet URI');
  const params = new URLSearchParams(uri.slice('magnet:?'.length));
  let v1: Buffer | undefined;
  let v2: Buffer | undefined;
  let name: string | undefined;
  const trackers: string[] = [];
  const peers: PeerAddress[] = [];
  const webSeeds: string[] = [];
  for (const [rawKey, value] of params) {
    const key = baseKey(rawKey);
    if (key === 'xt') {
      const lower = value.toLowerCase();
      if (lower.startsWith('urn:btih:')) {
        const h = value.slice(9);
        if (/^[0-9a-fA-F]{40}$/.test(h)) v1 = Buffer.from(h, 'hex');
        else if (/^[A-Za-z2-7]{32}$/.test(h)) v1 = base32Decode(h);
        else throw new TorrentEngineError('magnet', `invalid btih info-hash "${h}"`);
      } else if (lower.startsWith('urn:btmh:')) {
        const h = value.slice(9);
        // multihash: 0x12 (sha2-256) 0x20 (32 bytes) + digest
        if (!/^1220[0-9a-fA-F]{64}$/.test(h)) throw new TorrentEngineError('magnet', `invalid btmh hash "${h}"`);
        v2 = Buffer.from(h.slice(4), 'hex');
      }
    } else if (key === 'dn') {
      name = value;
    } else if (key === 'tr') {
      if (value && !trackers.includes(value)) trackers.push(value);
    } else if (key === 'x.pe') {
      const p = parsePeer(value);
      if (p) peers.push(p);
    } else if (key === 'ws') {
      webSeeds.push(value);
    }
  }
  const infoHash = v1 ?? v2?.subarray(0, 20);
  if (!infoHash) throw new TorrentEngineError('magnet', 'magnet has no BitTorrent info-hash');
  const link: MagnetLink = { infoHash, infoHashHex: infoHash.toString('hex'), trackers, peers, webSeeds };
  if (v2) link.infoHashV2 = v2;
  if (name !== undefined) link.name = name;
  return link;
}

/** Builds a magnet URI for an info-hash. */
export function toMagnetUri(input: { infoHash: Buffer; name?: string; trackers?: string[]; peers?: PeerAddress[] }): string {
  const parts = [`xt=urn:btih:${input.infoHash.toString('hex')}`];
  if (input.name) parts.push(`dn=${encodeURIComponent(input.name)}`);
  for (const t of input.trackers ?? []) parts.push(`tr=${encodeURIComponent(t)}`);
  for (const p of input.peers ?? []) parts.push(`x.pe=${encodeURIComponent(`${p.host}:${p.port}`)}`);
  return `magnet:?${parts.join('&')}`;
}

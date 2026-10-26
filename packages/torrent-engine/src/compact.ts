import { isIPv4, isIPv6 } from 'node:net';

/** A peer or node endpoint (IPv4 dotted quad or IPv6 without brackets). */
export interface PeerAddress {
  host: string;
  port: number;
}

/** Address family of a host literal: 4, 6, or 0 for host names. */
export function hostFamily(host: string): 0 | 4 | 6 {
  return isIPv4(host) ? 4 : isIPv6(host) ? 6 : 0;
}

/**
 * Canonical form of an IP literal: IPv4-mapped IPv6 becomes plain IPv4, brackets are
 * removed and IPv6 is compressed (RFC 5952) so the same peer always has the same key.
 */
export function normalizeHost(host: string): string {
  let h = host.trim();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(h);
  if (mapped) return mapped[1] as string;
  if (isIPv6(h)) {
    try {
      return new URL(`http://[${h}]/`).hostname.slice(1, -1);
    } catch {
      return h.toLowerCase();
    }
  }
  return h;
}

export function addressKey(a: PeerAddress): string {
  return isIPv6(a.host) ? `[${a.host}]:${a.port}` : `${a.host}:${a.port}`;
}

/** 16 raw bytes of an IPv6 literal. */
export function ipv6ToBytes(host: string): Buffer {
  let h = host;
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const [p0 = 0, p1 = 0, p2 = 0, p3 = 0] = v4.slice(1).map(Number);
    h = `${h.slice(0, v4.index)}${((p0 << 8) | p1).toString(16)}:${((p2 << 8) | p3).toString(16)}`;
  }
  let groups: string[];
  const dbl = h.indexOf('::');
  if (dbl >= 0) {
    const head = h.slice(0, dbl).split(':').filter(Boolean);
    const tail = h.slice(dbl + 2).split(':').filter(Boolean);
    groups = [...head, ...new Array<string>(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  } else groups = h.split(':');
  const out = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) out.writeUInt16BE(parseInt(groups[i] ?? '0', 16) & 0xffff, i * 2);
  return out;
}

export function bytesToIpv6(b: Buffer): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(b.readUInt16BE(i).toString(16));
  return normalizeHost(groups.join(':'));
}

/** Decodes BEP 23 compact peers (6 bytes each). Ignores trailing partial entries. */
export function decodeCompactPeers(buf: Buffer): PeerAddress[] {
  const out: PeerAddress[] = [];
  for (let i = 0; i + 6 <= buf.length; i += 6) {
    const host = `${buf[i]}.${buf[i + 1]}.${buf[i + 2]}.${buf[i + 3]}`;
    const port = buf.readUInt16BE(i + 4);
    if (port > 0) out.push({ host, port });
  }
  return out;
}

/** Decodes BEP 7 compact IPv6 peers (18 bytes each). */
export function decodeCompactPeers6(buf: Buffer): PeerAddress[] {
  const out: PeerAddress[] = [];
  for (let i = 0; i + 18 <= buf.length; i += 18) {
    const port = buf.readUInt16BE(i + 16);
    if (port > 0) out.push({ host: bytesToIpv6(buf.subarray(i, i + 16)), port });
  }
  return out;
}

/** Compact form of one peer: 6 bytes for IPv4, 18 for IPv6. */
export function encodeCompactPeer(a: PeerAddress): Buffer {
  if (isIPv6(a.host)) {
    const b = Buffer.alloc(18);
    ipv6ToBytes(a.host).copy(b, 0);
    b.writeUInt16BE(a.port, 16);
    return b;
  }
  const b = Buffer.alloc(6);
  const parts = a.host.split('.').map(Number);
  for (let i = 0; i < 4; i++) b[i] = parts[i] ?? 0;
  b.writeUInt16BE(a.port, 4);
  return b;
}

/** Compact IPv4 peers; IPv6 entries are skipped (see `encodeCompactPeers6`). */
export function encodeCompactPeers(list: readonly PeerAddress[]): Buffer {
  return Buffer.concat(list.filter((a) => isIPv4(a.host)).map(encodeCompactPeer));
}

/** Compact IPv6 peers; IPv4 entries are skipped. */
export function encodeCompactPeers6(list: readonly PeerAddress[]): Buffer {
  return Buffer.concat(list.filter((a) => isIPv6(a.host)).map(encodeCompactPeer));
}

/** BEP 5 compact node info: 20-byte id followed by a compact peer. */
export interface CompactNode {
  id: Buffer;
  host: string;
  port: number;
}

export function decodeCompactNodes(buf: Buffer): CompactNode[] {
  const out: CompactNode[] = [];
  for (let i = 0; i + 26 <= buf.length; i += 26) {
    const id = Buffer.from(buf.subarray(i, i + 20));
    const [peer] = decodeCompactPeers(buf.subarray(i + 20, i + 26));
    if (peer) out.push({ id, ...peer });
  }
  return out;
}

/** BEP 32 `nodes6`: 20-byte id followed by an 18-byte IPv6 compact peer. */
export function decodeCompactNodes6(buf: Buffer): CompactNode[] {
  const out: CompactNode[] = [];
  for (let i = 0; i + 38 <= buf.length; i += 38) {
    const id = Buffer.from(buf.subarray(i, i + 20));
    const [peer] = decodeCompactPeers6(buf.subarray(i + 20, i + 38));
    if (peer) out.push({ id, ...peer });
  }
  return out;
}

export function encodeCompactNodes(nodes: readonly CompactNode[]): Buffer {
  return Buffer.concat(
    nodes.filter((n) => isIPv4(n.host)).map((n) => Buffer.concat([n.id, encodeCompactPeer(n)])),
  );
}

export function encodeCompactNodes6(nodes: readonly CompactNode[]): Buffer {
  return Buffer.concat(
    nodes.filter((n) => isIPv6(n.host)).map((n) => Buffer.concat([n.id, encodeCompactPeer(n)])),
  );
}

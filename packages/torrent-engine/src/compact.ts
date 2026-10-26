import { isIPv4 } from 'node:net';

/** An IPv4 peer or node endpoint. */
export interface PeerAddress {
  host: string;
  port: number;
}

export function addressKey(a: PeerAddress): string {
  return `${a.host}:${a.port}`;
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

export function encodeCompactPeer(a: PeerAddress): Buffer {
  const b = Buffer.alloc(6);
  const parts = a.host.split('.').map(Number);
  for (let i = 0; i < 4; i++) b[i] = parts[i] ?? 0;
  b.writeUInt16BE(a.port, 4);
  return b;
}

export function encodeCompactPeers(list: readonly PeerAddress[]): Buffer {
  return Buffer.concat(list.filter((a) => isIPv4(a.host)).map(encodeCompactPeer));
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

export function encodeCompactNodes(nodes: readonly CompactNode[]): Buffer {
  return Buffer.concat(
    nodes.filter((n) => isIPv4(n.host)).map((n) => Buffer.concat([n.id, encodeCompactPeer(n)])),
  );
}

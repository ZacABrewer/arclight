/** BEP 29 uTP packet format. */

export const ST_DATA = 0;
export const ST_FIN = 1;
export const ST_STATE = 2;
export const ST_RESET = 3;
export const ST_SYN = 4;
export const UTP_VERSION = 1;
export const HEADER_SIZE = 20;
/** Extension type of the selective ACK bitmask. */
export const EXT_SACK = 1;

export interface UtpPacket {
  type: number;
  connectionId: number;
  /** Sender's microsecond clock (low 32 bits). */
  timestamp: number;
  /** Sender's measured one-way delay of our last packet, in microseconds. */
  timestampDiff: number;
  /** Bytes the sender can still receive. */
  wndSize: number;
  seq: number;
  ack: number;
  /** Selective ACK bitmask: bit k of byte j acknowledges ack + 2 + 8j + k. */
  sack?: Buffer;
  payload: Buffer;
}

export function encodePacket(p: UtpPacket): Buffer {
  const extLen = p.sack ? 2 + p.sack.length : 0;
  const b = Buffer.allocUnsafe(HEADER_SIZE + extLen + p.payload.length);
  b[0] = ((p.type & 0x0f) << 4) | UTP_VERSION;
  b[1] = p.sack ? EXT_SACK : 0;
  b.writeUInt16BE(p.connectionId & 0xffff, 2);
  b.writeUInt32BE(p.timestamp >>> 0, 4);
  b.writeUInt32BE(p.timestampDiff >>> 0, 8);
  b.writeUInt32BE(Math.max(0, Math.min(0xffffffff, Math.floor(p.wndSize))), 12);
  b.writeUInt16BE(p.seq & 0xffff, 16);
  b.writeUInt16BE(p.ack & 0xffff, 18);
  let off = HEADER_SIZE;
  if (p.sack) {
    b[off] = 0; // no further extension
    b[off + 1] = p.sack.length;
    p.sack.copy(b, off + 2);
    off += extLen;
  }
  p.payload.copy(b, off);
  return b;
}

/** Cheap check used to demultiplex uTP from DHT (bencode starts with `d`) on a shared socket. */
export function looksLikeUtp(b: Buffer): boolean {
  if (b.length < HEADER_SIZE) return false;
  const first = b[0] as number;
  return (first & 0x0f) === UTP_VERSION && first >> 4 <= ST_SYN;
}

/** Decodes a packet; null when malformed. Unknown extensions are skipped. */
export function decodePacket(b: Buffer): UtpPacket | null {
  if (!looksLikeUtp(b)) return null;
  const p: UtpPacket = {
    type: (b[0] as number) >> 4,
    connectionId: b.readUInt16BE(2),
    timestamp: b.readUInt32BE(4),
    timestampDiff: b.readUInt32BE(8),
    wndSize: b.readUInt32BE(12),
    seq: b.readUInt16BE(16),
    ack: b.readUInt16BE(18),
    payload: Buffer.alloc(0),
  };
  let ext = b[1] as number;
  let off = HEADER_SIZE;
  while (ext !== 0) {
    if (off + 2 > b.length) return null;
    const next = b[off] as number;
    const len = b[off + 1] as number;
    if (off + 2 + len > b.length) return null;
    if (ext === EXT_SACK) p.sack = Buffer.from(b.subarray(off + 2, off + 2 + len));
    ext = next;
    off += 2 + len;
  }
  p.payload = b.subarray(off);
  return p;
}

/** 16-bit sequence arithmetic: true when `a` comes after `b`. */
export function seqAfter(a: number, b: number): boolean {
  const d = (a - b) & 0xffff;
  return d !== 0 && d < 0x8000;
}

export function seqDiff(a: number, b: number): number {
  return (a - b) & 0xffff;
}

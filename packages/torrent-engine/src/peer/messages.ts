import { copyExact } from '../buffers.js';
import { TorrentEngineError } from '../errors.js';

export const PROTOCOL = Buffer.from('BitTorrent protocol', 'latin1');
export const HANDSHAKE_LENGTH = 68;
export const BLOCK_SIZE = 16 * 1024;

export const MSG = {
  choke: 0,
  unchoke: 1,
  interested: 2,
  notInterested: 3,
  have: 4,
  bitfield: 5,
  request: 6,
  piece: 7,
  cancel: 8,
  port: 9,
  suggest: 0x0d,
  haveAll: 0x0e,
  haveNone: 0x0f,
  reject: 0x10,
  allowedFast: 0x11,
  extended: 20,
} as const;

export interface Handshake {
  reserved: Buffer;
  infoHash: Buffer;
  peerId: Buffer;
}

export interface ReservedFlags {
  extensions: boolean;
  fast: boolean;
  dht: boolean;
}

export function buildReserved(flags: ReservedFlags): Buffer {
  const r = Buffer.alloc(8);
  if (flags.extensions) r[5] = (r[5] ?? 0) | 0x10;
  if (flags.fast) r[7] = (r[7] ?? 0) | 0x04;
  if (flags.dht) r[7] = (r[7] ?? 0) | 0x01;
  return r;
}

export function parseReserved(r: Buffer): ReservedFlags {
  return {
    extensions: ((r[5] ?? 0) & 0x10) !== 0,
    fast: ((r[7] ?? 0) & 0x04) !== 0,
    dht: ((r[7] ?? 0) & 0x01) !== 0,
  };
}

export function encodeHandshake(h: Handshake): Buffer {
  return Buffer.concat([Buffer.from([PROTOCOL.length]), PROTOCOL, h.reserved, h.infoHash, h.peerId]);
}

/** Parses the 68-byte handshake at the start of `buf`; null when more data is needed. */
export function parseHandshake(buf: Buffer): Handshake | null {
  if (buf.length < 1) return null;
  if (buf[0] !== PROTOCOL.length) throw new TorrentEngineError('peer', 'invalid handshake protocol length');
  if (buf.length < HANDSHAKE_LENGTH) {
    if (!PROTOCOL.subarray(0, Math.max(0, buf.length - 1)).equals(buf.subarray(1, Math.min(buf.length, 20))))
      throw new TorrentEngineError('peer', 'invalid handshake protocol string');
    return null;
  }
  if (!buf.subarray(1, 20).equals(PROTOCOL)) throw new TorrentEngineError('peer', 'invalid handshake protocol string');
  return {
    reserved: Buffer.from(buf.subarray(20, 28)),
    infoHash: Buffer.from(buf.subarray(28, 48)),
    peerId: Buffer.from(buf.subarray(48, 68)),
  };
}

function frame(id: number, payload?: Buffer): Buffer {
  const len = 1 + (payload?.length ?? 0);
  const head = Buffer.alloc(5);
  head.writeUInt32BE(len, 0);
  head[4] = id;
  return payload ? Buffer.concat([head, payload]) : head;
}

function ints(...values: number[]): Buffer {
  const b = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => b.writeUInt32BE(v, i * 4));
  return b;
}

export const encode = {
  keepAlive: (): Buffer => Buffer.alloc(4),
  choke: (): Buffer => frame(MSG.choke),
  unchoke: (): Buffer => frame(MSG.unchoke),
  interested: (): Buffer => frame(MSG.interested),
  notInterested: (): Buffer => frame(MSG.notInterested),
  have: (i: number): Buffer => frame(MSG.have, ints(i)),
  bitfield: (bits: Buffer): Buffer => frame(MSG.bitfield, bits),
  request: (i: number, begin: number, length: number): Buffer => frame(MSG.request, ints(i, begin, length)),
  cancel: (i: number, begin: number, length: number): Buffer => frame(MSG.cancel, ints(i, begin, length)),
  reject: (i: number, begin: number, length: number): Buffer => frame(MSG.reject, ints(i, begin, length)),
  piece: (i: number, begin: number, data: Buffer): Buffer => {
    const head = Buffer.alloc(13);
    head.writeUInt32BE(9 + data.length, 0);
    head[4] = MSG.piece;
    head.writeUInt32BE(i, 5);
    head.writeUInt32BE(begin, 9);
    return Buffer.concat([head, data]);
  },
  port: (port: number): Buffer => {
    const p = Buffer.alloc(2);
    p.writeUInt16BE(port);
    return frame(MSG.port, p);
  },
  suggest: (i: number): Buffer => frame(MSG.suggest, ints(i)),
  haveAll: (): Buffer => frame(MSG.haveAll),
  haveNone: (): Buffer => frame(MSG.haveNone),
  allowedFast: (i: number): Buffer => frame(MSG.allowedFast, ints(i)),
  extended: (extId: number, payload: Buffer): Buffer => frame(MSG.extended, Buffer.concat([Buffer.from([extId]), payload])),
};

export type WireMessage =
  | { type: 'keepAlive' }
  | { type: 'choke' | 'unchoke' | 'interested' | 'notInterested' | 'haveAll' | 'haveNone' }
  | { type: 'have' | 'suggest' | 'allowedFast'; index: number }
  | { type: 'bitfield'; bits: Buffer }
  | { type: 'request' | 'cancel' | 'reject'; index: number; begin: number; length: number }
  | { type: 'piece'; index: number; begin: number; data: Buffer }
  | { type: 'port'; port: number }
  | { type: 'extended'; extId: number; payload: Buffer }
  | { type: 'unknown'; id: number; payload: Buffer };

function need(payload: Buffer, n: number, name: string): void {
  if (payload.length !== n) throw new TorrentEngineError('peer', `${name} message has length ${payload.length}, expected ${n}`);
}

export function decodeMessage(id: number, payload: Buffer): WireMessage {
  switch (id) {
    case MSG.choke:
      return { type: 'choke' };
    case MSG.unchoke:
      return { type: 'unchoke' };
    case MSG.interested:
      return { type: 'interested' };
    case MSG.notInterested:
      return { type: 'notInterested' };
    case MSG.haveAll:
      return { type: 'haveAll' };
    case MSG.haveNone:
      return { type: 'haveNone' };
    case MSG.have:
    case MSG.suggest:
    case MSG.allowedFast:
      need(payload, 4, 'have');
      return { type: id === MSG.have ? 'have' : id === MSG.suggest ? 'suggest' : 'allowedFast', index: payload.readUInt32BE(0) };
    case MSG.bitfield:
      return { type: 'bitfield', bits: payload };
    case MSG.request:
    case MSG.cancel:
    case MSG.reject:
      need(payload, 12, 'request');
      return {
        type: id === MSG.request ? 'request' : id === MSG.cancel ? 'cancel' : 'reject',
        index: payload.readUInt32BE(0),
        begin: payload.readUInt32BE(4),
        length: payload.readUInt32BE(8),
      };
    case MSG.piece:
      if (payload.length < 8) throw new TorrentEngineError('peer', 'piece message too short');
      return { type: 'piece', index: payload.readUInt32BE(0), begin: payload.readUInt32BE(4), data: payload.subarray(8) };
    case MSG.port:
      need(payload, 2, 'port');
      return { type: 'port', port: payload.readUInt16BE(0) };
    case MSG.extended:
      if (payload.length < 1) throw new TorrentEngineError('peer', 'extended message too short');
      return { type: 'extended', extId: payload[0] as number, payload: payload.subarray(1) };
    default:
      return { type: 'unknown', id, payload };
  }
}

const EMPTY = Buffer.alloc(0);
const IDLE_KEEP = 64 * 1024;

/**
 * Incremental length-prefixed message parser. Received bytes are copied into one reusable
 * buffer per connection (no Buffer.concat per socket chunk), and each message gets its own
 * exactly-sized copy, so a block never pins the receive buffer and the only garbage is what the
 * caller drops. At download speed this keeps allocation close to the data rate.
 */
export class MessageReader {
  private buf: Buffer = EMPTY;
  private len = 0;

  constructor(private readonly maxLength = BLOCK_SIZE * 8 + 13) {}

  push(chunk: Buffer): WireMessage[] {
    this.append(chunk);
    const out: WireMessage[] = [];
    let off = 0;
    while (this.len - off >= 4) {
      const len = this.buf.readUInt32BE(off);
      if (len > this.maxLength) throw new TorrentEngineError('peer', `message length ${len} exceeds limit`);
      if (this.len - off < 4 + len) break;
      if (len === 0) out.push({ type: 'keepAlive' });
      else {
        const id = this.buf[off + 4] as number;
        if (id === MSG.piece && len >= 9) {
          // the block alone, in its own allocation: storage caches it as is
          const data = Buffer.allocUnsafeSlow(len - 9);
          this.buf.copy(data, 0, off + 13, off + 4 + len);
          out.push({ type: 'piece', index: this.buf.readUInt32BE(off + 5), begin: this.buf.readUInt32BE(off + 9), data });
        } else {
          // small control messages are short-lived (pool copy); larger ones (bitfields, metadata) are kept
          const body = this.buf.subarray(off + 5, off + 4 + len);
          out.push(decodeMessage(id, len > 1024 ? copyExact(body) : Buffer.from(body)));
        }
      }
      off += 4 + len;
    }
    if (off > 0) {
      this.buf.copyWithin(0, off, this.len);
      this.len -= off;
    }
    // drop a grown buffer once drained so idle peers hold nothing
    if (this.len === 0 && this.buf.length > IDLE_KEEP) this.buf = EMPTY;
    return out;
  }

  private append(chunk: Buffer): void {
    const need = this.len + chunk.length;
    if (need > this.buf.length) {
      const next = Buffer.allocUnsafeSlow(Math.max(need, Math.min(this.buf.length * 2, this.maxLength + 4 + 65536), 4096));
      this.buf.copy(next, 0, 0, this.len);
      this.buf = next;
    }
    chunk.copy(this.buf, this.len);
    this.len = need;
  }

  get buffered(): number {
    return this.len;
  }
}

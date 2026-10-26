import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

// A deliberately small RFC 6455 server endpoint: the agent only pushes text frames and has to
// answer pings and close frames, so a dependency is not worth its weight in the agent image.

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_TEXT = 0x1;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;
/** Clients only send control frames; anything larger is refused. */
const MAX_CLIENT_FRAME = 64 * 1024;

export interface ServerSocket {
  send(text: string): void;
  close(code?: number): void;
  readonly closed: boolean;
  onClose(cb: () => void): void;
}

function frame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let head: Buffer;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

/** Completes the upgrade handshake; returns null (and answers 400) for non-WebSocket requests. */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer, pingIntervalMs = 30_000): ServerSocket | null {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || req.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`,
  );

  let closed = false;
  const closeCbs: Array<() => void> = [];
  let buffered: Buffer = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(pinger);
    for (const cb of closeCbs.splice(0)) cb();
  };
  const write = (data: Buffer) => {
    if (!closed && socket.writable) socket.write(data);
  };
  const close = (code = 1000) => {
    if (closed) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    write(frame(OP_CLOSE, payload));
    finish();
    socket.end();
  };

  const pinger = setInterval(() => write(frame(OP_PING, Buffer.alloc(0))), pingIntervalMs);
  pinger.unref();

  const parse = () => {
    for (;;) {
      if (buffered.length < 2) return;
      const b0 = buffered[0]!;
      const b1 = buffered[1]!;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffered.length < 4) return;
        len = buffered.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffered.length < 10) return;
        const big = buffered.readBigUInt64BE(2);
        if (big > BigInt(MAX_CLIENT_FRAME)) return close(1009);
        len = Number(big);
        offset = 10;
      }
      if (len > MAX_CLIENT_FRAME) return close(1009);
      // Clients must mask every frame (RFC 6455 5.1).
      if (!masked) return close(1002);
      if (buffered.length < offset + 4 + len) return;
      const mask = buffered.subarray(offset, offset + 4);
      const payload = Buffer.from(buffered.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
      buffered = buffered.subarray(offset + 4 + len);
      if (opcode === OP_PING) write(frame(OP_PONG, payload));
      else if (opcode === OP_CLOSE) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
        return close(code === 1005 || code === 1006 ? 1000 : code);
      }
      // Text/binary/pong frames from the client carry nothing the agent needs.
    }
  };

  socket.on('data', (chunk: Buffer) => {
    buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
    parse();
  });
  socket.on('close', finish);
  socket.on('end', finish);
  socket.on('error', finish);
  if (buffered.length > 0) parse();

  return {
    send(text: string) {
      write(frame(OP_TEXT, Buffer.from(text, 'utf8')));
    },
    close,
    get closed() {
      return closed;
    },
    onClose(cb: () => void) {
      if (closed) cb();
      else closeCbs.push(cb);
    },
  };
}

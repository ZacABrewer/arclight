/**
 * A deliberately small MQTT 3.1.1 publisher: CONNECT, wait for CONNACK, one PUBLISH (QoS 0, or
 * QoS 1 and wait for PUBACK), DISCONNECT. Written from the OASIS MQTT 3.1.1 specification. The
 * conversation runs over the `SocketLike` interface so tests can swap the transport.
 */

import { randomBytes } from 'node:crypto';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { SocketConnect, SocketLike } from './agents/base.js';
import { NotificationError } from './types.js';

/** Control packet types (high nibble of the first fixed-header byte). */
export const PacketType = {
  CONNECT: 1,
  CONNACK: 2,
  PUBLISH: 3,
  PUBACK: 4,
  DISCONNECT: 14,
} as const;

/** Largest value the four-byte remaining-length varint can carry. */
export const MAX_REMAINING_LENGTH = 268_435_455;

export interface MqttPacket {
  type: number;
  /** Low nibble of the first byte (PUBLISH: dup/qos/retain). */
  flags: number;
  body: Buffer;
}

export interface MqttConnectOptions {
  clientId: string;
  username?: string | undefined;
  password?: string | undefined;
  keepAliveSeconds?: number;
}

export interface MqttPublishPacketOptions {
  topic: string;
  payload: Uint8Array;
  qos: 0 | 1;
  retain: boolean;
  /** Required (1..65535) when qos is 1. */
  packetId?: number;
}

export interface MqttPublishOptions {
  host: string;
  port: number;
  tls: boolean;
  rejectUnauthorized: boolean;
  timeoutMs: number;
  clientId: string;
  username?: string | undefined;
  password?: string | undefined;
  topic: string;
  payload: Uint8Array;
  qos: 0 | 1;
  retain: boolean;
}

/** Remaining-length varint: 7 bits per byte, least significant group first, high bit = "more". */
export function encodeRemainingLength(length: number): Buffer {
  if (!Number.isInteger(length) || length < 0 || length > MAX_REMAINING_LENGTH) {
    throw new RangeError(`MQTT remaining length out of range: ${length}`);
  }
  const bytes: number[] = [];
  let value = length;
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    bytes.push(byte);
  } while (value > 0);
  return Buffer.from(bytes);
}

/** UTF-8 string with its two-byte big-endian length prefix. */
export function encodeString(value: string | Uint8Array): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
  if (bytes.length > 0xffff) throw new RangeError('MQTT string longer than 65535 bytes');
  const out = Buffer.alloc(2 + bytes.length);
  out.writeUInt16BE(bytes.length, 0);
  bytes.copy(out, 2);
  return out;
}

function frame(firstByte: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([firstByte]), encodeRemainingLength(body.length), body]);
}

/** CONNECT with a clean session and no will. A password is only sent alongside a username (3.1.1 3.1.2.9). */
export function encodeConnect(options: MqttConnectOptions): Buffer {
  const hasUser = options.username !== undefined && options.username !== '';
  const hasPassword = hasUser && options.password !== undefined;
  let flags = 0x02; // clean session
  if (hasUser) flags |= 0x80;
  if (hasPassword) flags |= 0x40;
  const keepAlive = Buffer.alloc(2);
  keepAlive.writeUInt16BE(options.keepAliveSeconds ?? 30, 0);
  const parts = [encodeString('MQTT'), Buffer.from([0x04, flags]), keepAlive, encodeString(options.clientId)];
  if (hasUser) parts.push(encodeString(options.username ?? ''));
  if (hasPassword) parts.push(encodeString(options.password ?? ''));
  return frame(PacketType.CONNECT << 4, Buffer.concat(parts));
}

export function encodePublish(options: MqttPublishPacketOptions): Buffer {
  const parts = [encodeString(options.topic)];
  if (options.qos > 0) {
    const id = options.packetId ?? 0;
    if (!Number.isInteger(id) || id < 1 || id > 0xffff) throw new RangeError('QoS 1 PUBLISH needs a packet id 1..65535');
    const idBytes = Buffer.alloc(2);
    idBytes.writeUInt16BE(id, 0);
    parts.push(idBytes);
  }
  parts.push(Buffer.from(options.payload));
  const first = (PacketType.PUBLISH << 4) | (options.qos << 1) | (options.retain ? 1 : 0);
  return frame(first, Buffer.concat(parts));
}

export function encodeDisconnect(): Buffer {
  return Buffer.from([PacketType.DISCONNECT << 4, 0x00]);
}

/** Splits a byte stream into packets; tolerates packets (and their headers) split across chunks. */
export class MqttPacketParser {
  private buffer: Buffer = Buffer.alloc(0);

  /** Feed raw bytes; returns every packet completed by this chunk. Throws on a malformed length. */
  push(chunk: Uint8Array): MqttPacket[] {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    const packets: MqttPacket[] = [];
    for (;;) {
      if (this.buffer.length < 2) break;
      let length = 0;
      let multiplier = 1;
      let offset = 1;
      let complete = false;
      while (offset < this.buffer.length) {
        const byte = this.buffer[offset] ?? 0;
        offset += 1;
        length += (byte & 0x7f) * multiplier;
        if ((byte & 0x80) === 0) {
          complete = true;
          break;
        }
        if (offset > 4) throw new Error('Malformed MQTT remaining length');
        multiplier *= 128;
      }
      if (!complete) break;
      if (this.buffer.length < offset + length) break;
      const first = this.buffer[0] ?? 0;
      packets.push({ type: first >> 4, flags: first & 0x0f, body: this.buffer.subarray(offset, offset + length) });
      this.buffer = this.buffer.subarray(offset + length);
    }
    return packets;
  }
}

/** "arclight-" plus 8 random hex chars: short enough for brokers that cap ids at 23 bytes. */
export function randomClientId(): string {
  return `arclight-${randomBytes(4).toString('hex')}`;
}

const CONNACK_REASONS: Record<number, string> = {
  1: 'unacceptable protocol version',
  2: 'client identifier rejected',
  3: 'server unavailable',
  4: 'bad username or password',
  5: 'not authorised',
};

/** Production socket factory over node:net / node:tls. Rejects with `code: 'ETIMEDOUT'` when the handshake is too slow. */
export const connectSocket: SocketConnect = ({ host, port, tls, rejectUnauthorized, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const socket = tls ? tlsConnect({ host, port, servername: host, rejectUnauthorized }) : netConnect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error(`connection timed out after ${timeoutMs} ms`), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    const onError = (error: Error): void => {
      clearTimeout(timer);
      reject(error);
    };
    socket.once('error', onError);
    socket.once(tls ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      socket.off('error', onError);
      const wrapped: SocketLike = {
        write(data: Uint8Array): void {
          socket.write(data);
        },
        on(event: 'data' | 'error' | 'close', listener: (...args: never[]) => void): void {
          socket.on(event, listener as (...args: unknown[]) => void);
        },
        end(): void {
          socket.end();
        },
        destroy(): void {
          socket.destroy();
        },
      };
      resolve(wrapped);
    });
  });

/** Reads packets off a socket one at a time; any transport failure rejects every waiter. */
class PacketReader {
  private readonly parser = new MqttPacketParser();
  private readonly ready: MqttPacket[] = [];
  private readonly waiting: Array<{ resolve: (p: MqttPacket) => void; reject: (e: Error) => void }> = [];
  private failure: Error | undefined;

  constructor(socket: SocketLike, target: string) {
    socket.on('data', (chunk) => {
      let packets: MqttPacket[];
      try {
        packets = this.parser.push(chunk);
      } catch (error) {
        this.fail(new NotificationError('mqtt', 'remoteError', `${target} sent a malformed packet`, { cause: error }));
        return;
      }
      for (const packet of packets) {
        const waiter = this.waiting.shift();
        if (waiter) waiter.resolve(packet);
        else this.ready.push(packet);
      }
    });
    socket.on('error', (error) =>
      this.fail(new NotificationError('mqtt', 'network', `Connection to ${target} failed: ${error.message}`, { cause: error })),
    );
    socket.on('close', () => this.fail(new NotificationError('mqtt', 'network', `${target} closed the connection`)));
  }

  next(): Promise<MqttPacket> {
    const queued = this.ready.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }

  fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of this.waiting.splice(0)) waiter.reject(error);
  }
}

const PACKET_ID = 1;

/** Connect, publish one message and disconnect. Throws `NotificationError` (never echoes the password). */
export async function publishMqtt(connect: SocketConnect, options: MqttPublishOptions): Promise<void> {
  const target = `MQTT broker ${options.host}:${options.port}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new NotificationError('mqtt', 'timeout', `${target} did not answer within ${options.timeoutMs} ms`));
    }, options.timeoutMs);
  });
  deadline.catch(() => undefined);

  let socket: SocketLike | undefined;
  let ok = false;
  try {
    const opening = connect({
      host: options.host,
      port: options.port,
      tls: options.tls,
      rejectUnauthorized: options.rejectUnauthorized,
      timeoutMs: options.timeoutMs,
    });
    // A socket that arrives after the deadline is closed rather than leaked.
    opening.then((s) => timedOut && s.destroy(), () => undefined);
    try {
      socket = await Promise.race([opening, deadline]);
    } catch (error) {
      if (error instanceof NotificationError) throw error;
      const code = (error as { code?: unknown }).code;
      if (code === 'ETIMEDOUT') throw new NotificationError('mqtt', 'timeout', `${target} did not accept the connection in time`, { cause: error });
      throw new NotificationError('mqtt', 'network', `Could not connect to ${target}: ${(error as Error).message}`, { cause: error });
    }

    const reader = new PacketReader(socket, target);
    const next = (): Promise<MqttPacket> => Promise.race([reader.next(), deadline]);

    socket.write(encodeConnect({ clientId: options.clientId, username: options.username, password: options.password, keepAliveSeconds: 30 }));
    const connack = await next();
    if (connack.type !== PacketType.CONNACK || connack.body.length < 2) {
      throw new NotificationError('mqtt', 'remoteError', `${target} answered CONNECT with packet type ${connack.type}`);
    }
    const returnCode = connack.body[1] ?? 0;
    if (returnCode !== 0) {
      const code = returnCode === 4 || returnCode === 5 ? 'unauthorized' : 'remoteError';
      const reason = CONNACK_REASONS[returnCode] ?? `return code ${returnCode}`;
      throw new NotificationError('mqtt', code, `${target} refused the connection: ${reason}`, { status: returnCode });
    }

    socket.write(
      encodePublish({ topic: options.topic, payload: options.payload, qos: options.qos, retain: options.retain, packetId: PACKET_ID }),
    );
    if (options.qos === 1) {
      for (;;) {
        const packet = await next();
        if (packet.type === PacketType.PUBACK && packet.body.length >= 2 && packet.body.readUInt16BE(0) === PACKET_ID) break;
      }
    }

    socket.write(encodeDisconnect());
    socket.end();
    ok = true;
  } finally {
    clearTimeout(timer);
    if (!ok) socket?.destroy();
  }
}

import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { GRAB, RENAME } from '../../fixtures/events.js';
import {
  MqttPacketParser,
  encodeConnect,
  encodeDisconnect,
  encodePublish,
  encodeRemainingLength,
  encodeString,
  type MqttPacket,
} from '../mqtt-client.js';
import { NotificationError } from '../types.js';
import { MqttAgent, MqttSettings, sanitiseTopic } from './mqtt.js';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

describe('MQTT packet encoding', () => {
  it('encodes remaining lengths as a 1-4 byte varint', () => {
    expect(hex(encodeRemainingLength(0))).toBe('00');
    expect(hex(encodeRemainingLength(127))).toBe('7f');
    expect(hex(encodeRemainingLength(128))).toBe('8001');
    expect(hex(encodeRemainingLength(16_383))).toBe('ff7f');
    expect(hex(encodeRemainingLength(16_384))).toBe('808001');
    expect(hex(encodeRemainingLength(268_435_455))).toBe('ffffff7f');
    expect(() => encodeRemainingLength(268_435_456)).toThrow(RangeError);
  });

  it('encodes strings as length-prefixed UTF-8', () => {
    expect(hex(encodeString('é/x'))).toBe('0004c3a92f78');
  });

  it('builds a byte-exact CONNECT without and with credentials', () => {
    expect(hex(encodeConnect({ clientId: 'c1', keepAliveSeconds: 30 }))).toBe('100e00044d5154540402001e00026331');
    expect(hex(encodeConnect({ clientId: 'c1', username: 'u', password: 'p', keepAliveSeconds: 30 }))).toBe(
      '101400044d51545404c2001e00026331000175000170',
    );
    // A password without a username is not allowed by 3.1.1 and is dropped.
    expect(hex(encodeConnect({ clientId: 'c1', password: 'p' }))).toBe('100e00044d5154540402001e00026331');
  });

  it('builds byte-exact PUBLISH frames for QoS 0 and QoS 1 + retain', () => {
    const payload = Buffer.from('hi');
    expect(hex(encodePublish({ topic: 'a/b', payload, qos: 0, retain: false }))).toBe('30070003612f626869');
    expect(hex(encodePublish({ topic: 'a/b', payload, qos: 1, retain: true, packetId: 1 }))).toBe('33090003612f6200016869');
    expect(() => encodePublish({ topic: 'a', payload, qos: 1, retain: false })).toThrow(RangeError);
    expect(hex(encodeDisconnect())).toBe('e000');
  });

  it('uses a multi-byte remaining length for large payloads', () => {
    const frame = encodePublish({ topic: 't', payload: Buffer.alloc(200), qos: 0, retain: false });
    expect(hex(frame.subarray(0, 3))).toBe('30cb01'); // 3 + 200 = 203 = 0x4b | 0x80, 0x01
    expect(frame.length).toBe(3 + 203);
  });

  it('parses packets split across chunks, including inside the length varint', () => {
    const big = encodePublish({ topic: 't', payload: Buffer.alloc(200, 1), qos: 0, retain: false });
    const stream = Buffer.concat([Buffer.from([0x20, 0x02, 0x00, 0x00]), big, Buffer.from([0x40, 0x02, 0x00, 0x01])]);
    const parser = new MqttPacketParser();
    const packets: MqttPacket[] = [];
    // Byte by byte is the worst case.
    for (const byte of stream) packets.push(...parser.push(Uint8Array.of(byte)));
    expect(packets.map((p) => p.type)).toEqual([2, 3, 4]);
    expect(packets[1]!.body.length).toBe(203);
    expect(packets[2]!.body.readUInt16BE(0)).toBe(1);
    // And all at once.
    expect(new MqttPacketParser().push(stream)).toHaveLength(3);
  });

  it('rejects a remaining length longer than four bytes', () => {
    expect(() => new MqttPacketParser().push(Uint8Array.from([0x30, 0xff, 0xff, 0xff, 0xff, 0x01]))).toThrow(/Malformed/);
  });
});

describe('sanitiseTopic', () => {
  it('removes wildcards, empty levels and the $ prefix', () => {
    expect(sanitiseTopic('arclight/+/#')).toBe('arclight/_/_');
    expect(sanitiseTopic('/a//b/ ')).toBe('a/b');
    expect(sanitiseTopic('$SYS/x')).toBe('SYS/x');
    expect(sanitiseTopic('//')).toBe('arclight');
  });
});

interface Received {
  clientId: string;
  username?: string;
  password?: string;
  topic: string;
  qos: number;
  retain: boolean;
  payload: unknown;
  disconnected: boolean;
}

function readString(buf: Buffer, offset: number): [string, number] {
  const len = buf.readUInt16BE(offset);
  return [buf.subarray(offset + 2, offset + 2 + len).toString('utf8'), offset + 2 + len];
}

/** A tiny real broker: answers CONNECT with `connackCode`, records PUBLISHes and acks QoS 1. */
async function startBroker(opts: { connackCode?: number; silent?: boolean } = {}): Promise<{ server: Server; port: number; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((socket: Socket) => {
    sockets.push(socket);
    socket.on('error', () => undefined);
    if (opts.silent) {
      socket.resume(); // read and discard, so a hang-up is noticed
      return;
    }
    const parser = new MqttPacketParser();
    let current: Received | undefined;
    socket.on('data', (chunk) => {
      for (const packet of parser.push(chunk)) {
        if (packet.type === 1) {
          const body = packet.body;
          let offset = readString(body, 0)[1];
          const flags = body[offset + 1]!;
          offset += 4;
          const [clientId, afterId] = readString(body, offset);
          offset = afterId;
          current = { clientId, topic: '', qos: 0, retain: false, payload: undefined, disconnected: false };
          if (flags & 0x80) [current.username, offset] = readString(body, offset);
          if (flags & 0x40) [current.password, offset] = readString(body, offset);
          socket.write(Buffer.from([0x20, 0x02, 0x00, opts.connackCode ?? 0]));
        } else if (packet.type === 3 && current) {
          const qos = (packet.flags >> 1) & 0x03;
          const [topic, afterTopic] = readString(packet.body, 0);
          let offset = afterTopic;
          let id = 0;
          if (qos > 0) {
            id = packet.body.readUInt16BE(offset);
            offset += 2;
          }
          Object.assign(current, { topic, qos, retain: (packet.flags & 1) === 1, payload: JSON.parse(packet.body.subarray(offset).toString('utf8')) });
          received.push(current);
          if (qos === 1) {
            // Split the PUBACK across two writes to exercise the client parser.
            socket.write(Buffer.from([0x40]));
            setTimeout(() => socket.write(Buffer.from([0x02, id >> 8, id & 0xff])), 5);
          }
        } else if (packet.type === 14 && current) {
          current.disconnected = true;
          socket.end();
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, port, received };
}

const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

const waitFor = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !check(); i += 1) await new Promise((r) => setTimeout(r, 10));
};

describe('MqttAgent', () => {
  it('validates settings and applies defaults', () => {
    const s = MqttSettings.parse({ host: 'broker.example.com' });
    expect(s).toMatchObject({ port: 1883, useTls: false, allowInvalidCertificates: false, topic: 'arclight/{{eventType}}', qos: 1, retain: false, timeoutMs: 10_000 });
    expect(s.clientId).toMatch(/^arclight-[0-9a-f]{8}$/);
    expect(MqttSettings.safeParse({ host: '' }).success).toBe(false);
    expect(MqttSettings.safeParse({ host: 'h', qos: 2 }).success).toBe(false);
    expect(MqttSettings.safeParse({ host: 'h', timeoutMs: 10 }).success).toBe(false);
    expect(MqttSettings.safeParse({ host: 'h', topic: 'a/{{#x}}' }).success).toBe(false);
  });

  it('builds a JSON payload with the raw event and renders the topic template', () => {
    const agent = new MqttAgent(MqttSettings.parse({ host: 'h', topic: 'media/{{mediaType}}/{{eventType}}' }));
    expect(agent.buildTopic(GRAB)).toBe('media/series/grab');
    const payload = agent.buildPayload(GRAB);
    expect(payload).toMatchObject({ eventType: 'grab', severity: expect.any(String), event: GRAB });
    expect(payload.title).toContain('Signal Lost');
    expect(payload.posterUrl).toBe('https://img.example/poster.jpg');
    // Missing values in the topic leave no empty levels.
    expect(new MqttAgent(MqttSettings.parse({ host: 'h', topic: 'x/{{mediaTitle}}/y' })).buildTopic(RENAME)).toMatch(/^x\/.+\/y$|^x\/y$/);
  });

  it('applies user templates to the payload', () => {
    const agent = new MqttAgent(MqttSettings.parse({ host: 'h' }), {
      templates: { grab: { title: 'T {{mediaTitle}}', body: 'B {{quality}}' } },
    });
    const payload = agent.buildPayload(GRAB);
    expect(payload.title).toBe('T Signal Lost');
    expect(payload.body).toBe('B WEBDL-1080p');
  });

  it('publishes end to end to a real broker with credentials, QoS 1 and retain', async () => {
    const broker = await startBroker();
    servers.push(broker.server);
    const agent = new MqttAgent(
      MqttSettings.parse({ host: '127.0.0.1', port: broker.port, username: 'user', password: 'pw', clientId: 'arclight-test', retain: true }),
    );
    await agent.send(GRAB);
    await waitFor(() => broker.received[0]?.disconnected === true);
    expect(broker.received).toHaveLength(1);
    expect(broker.received[0]).toMatchObject({
      clientId: 'arclight-test',
      username: 'user',
      password: 'pw',
      topic: 'arclight/grab',
      qos: 1,
      retain: true,
      disconnected: true,
    });
    expect(broker.received[0]!.payload).toMatchObject({ eventType: 'grab', event: { type: 'grab', downloadId: 'abc123def456' } });
  });

  it('publishes at QoS 0 without waiting for an ack (test event)', async () => {
    const broker = await startBroker();
    servers.push(broker.server);
    await new MqttAgent(MqttSettings.parse({ host: '127.0.0.1', port: broker.port, qos: 0 })).test();
    await waitFor(() => broker.received[0]?.disconnected === true);
    expect(broker.received[0]).toMatchObject({ topic: 'arclight/test', qos: 0, retain: false });
    expect(broker.received[0]!.username).toBeUndefined();
  });

  it('maps a bad-credentials CONNACK to unauthorized without echoing the password', async () => {
    const broker = await startBroker({ connackCode: 4 });
    servers.push(broker.server);
    const agent = new MqttAgent(MqttSettings.parse({ host: '127.0.0.1', port: broker.port, username: 'u', password: 's3cret-pw' }));
    const error = await agent.send(GRAB).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotificationError);
    expect((error as NotificationError).code).toBe('unauthorized');
    expect((error as NotificationError).message).not.toContain('s3cret-pw');
  });

  it('maps other CONNACK refusals to remoteError', async () => {
    const broker = await startBroker({ connackCode: 3 });
    servers.push(broker.server);
    const error = await new MqttAgent(MqttSettings.parse({ host: '127.0.0.1', port: broker.port })).send(GRAB).catch((e: unknown) => e);
    expect((error as NotificationError).code).toBe('remoteError');
  });

  it('times out against a broker that never answers', async () => {
    const broker = await startBroker({ silent: true });
    servers.push(broker.server);
    const agent = new MqttAgent(MqttSettings.parse({ host: '127.0.0.1', port: broker.port, timeoutMs: 1000 }));
    const error = await agent.send(GRAB).catch((e: unknown) => e);
    expect((error as NotificationError).code).toBe('timeout');
    // The client hangs up instead of leaking the connection.
    await waitFor(() => sockets.length > 0 && sockets.every((s) => s.readableEnded || s.destroyed));
    expect(sockets.every((s) => s.readableEnded || s.destroyed)).toBe(true);
  });

  it('reports a refused connection as a network error', async () => {
    const broker = await startBroker();
    const port = broker.port;
    await new Promise<void>((resolve) => broker.server.close(() => resolve()));
    const error = await new MqttAgent(MqttSettings.parse({ host: '127.0.0.1', port, timeoutMs: 2000 })).send(GRAB).catch((e: unknown) => e);
    expect((error as NotificationError).code).toBe('network');
  });

  it('uses an injected socket factory with TLS options', async () => {
    const seen: unknown[] = [];
    const agent = new MqttAgent(MqttSettings.parse({ host: 'broker.example.com', port: 8883, useTls: true, allowInvalidCertificates: true }), {
      socket: async (options) => {
        seen.push(options);
        throw new Error('ECONNREFUSED');
      },
    });
    const error = await agent.send(GRAB).catch((e: unknown) => e);
    expect((error as NotificationError).code).toBe('network');
    expect(seen[0]).toEqual({ host: 'broker.example.com', port: 8883, tls: true, rejectUnauthorized: false, timeoutMs: 10_000 });
  });
});

import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { encode as bencode } from '../bencode.js';
import { RateMeter, TokenBucket } from '../rate.js';
import { Choker, type ChokerPeer } from './choker.js';
import { connectTcp, PeerConnection, type PeerConnectionOptions } from './connection.js';
import {
  decodeExtendedHandshake,
  decodeMetadataMessage,
  decodePex,
  encodeExtendedHandshake,
  encodeMetadataMessage,
  encodePex,
  LOCAL_EXT,
  METADATA_PIECE_SIZE,
  MetadataAssembler,
  metadataPiece,
  PexTracker,
} from './extensions.js';
import { PeerListener } from './listener.js';
import { buildReserved, encode, encodeHandshake, MessageReader, parseHandshake, parseReserved } from './messages.js';

const infoHash = randomBytes(20);
const flags = { extensions: true, fast: true, dht: true };
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await tick(5);
  }
}

const closers: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

/** Connects two PeerConnections over localhost through a PeerListener. */
async function pair(
  aOpts: Partial<PeerConnectionOptions> = {},
  bOpts: Partial<PeerConnectionOptions> = {},
): Promise<{ a: PeerConnection; b: PeerConnection; listener: PeerListener }> {
  const listener = new PeerListener();
  await listener.listen(0, '127.0.0.1');
  closers.push(() => listener.close());
  const bPromise = new Promise<PeerConnection>((resolve) => {
    listener.once('connection', (socket, hs, address) => {
      const b = new PeerConnection({ socket, incoming: true, infoHash: hs.infoHash, peerId: randomBytes(20), address, reserved: flags, ...bOpts });
      closers.push(() => b.destroy());
      resolve(b);
    });
  });
  const sock = await connectTcp({ host: '127.0.0.1', port: listener.port });
  const a = new PeerConnection({ socket: sock, incoming: false, infoHash, peerId: randomBytes(20), address: { host: '127.0.0.1', port: listener.port }, reserved: flags, ...aOpts });
  closers.push(() => a.destroy());
  const b = await bPromise;
  await until(() => a.handshaken && b.handshaken);
  return { a, b, listener };
}

describe('wire messages', () => {
  it('encodes and parses handshakes with reserved bits', () => {
    const peerId = randomBytes(20);
    const raw = encodeHandshake({ reserved: buildReserved(flags), infoHash, peerId });
    expect(raw.length).toBe(68);
    const hs = parseHandshake(raw);
    expect(hs?.peerId.equals(peerId)).toBe(true);
    expect(parseReserved(hs!.reserved)).toEqual(flags);
    expect(parseHandshake(raw.subarray(0, 30))).toBeNull();
    expect(() => parseHandshake(Buffer.from([19, 66, 66]))).toThrow('protocol string');
    expect(() => parseHandshake(Buffer.from([5]))).toThrow('protocol length');
  });

  it('frames and decodes every message type across chunk boundaries', () => {
    const stream = Buffer.concat([
      encode.keepAlive(), encode.choke(), encode.unchoke(), encode.interested(), encode.notInterested(),
      encode.have(7), encode.bitfield(Buffer.from([0xf0])), encode.request(1, 16384, 16384),
      encode.piece(1, 0, Buffer.from('abc')), encode.cancel(1, 2, 3), encode.port(6881),
      encode.haveAll(), encode.haveNone(), encode.reject(4, 5, 6), encode.suggest(3), encode.allowedFast(9),
      encode.extended(1, Buffer.from('x')),
    ]);
    const r = new MessageReader();
    const out = [];
    for (let i = 0; i < stream.length; i += 7) out.push(...r.push(stream.subarray(i, i + 7)));
    expect(out.map((m) => m.type)).toEqual([
      'keepAlive', 'choke', 'unchoke', 'interested', 'notInterested', 'have', 'bitfield', 'request', 'piece',
      'cancel', 'port', 'haveAll', 'haveNone', 'reject', 'suggest', 'allowedFast', 'extended',
    ]);
    expect(out[8]).toMatchObject({ index: 1, begin: 0 });
    expect(out[10]).toEqual({ type: 'port', port: 6881 });
    expect(r.buffered).toBe(0);
  });

  it('rejects oversized and malformed messages', () => {
    const big = Buffer.alloc(4);
    big.writeUInt32BE(10_000_000);
    expect(() => new MessageReader(1000).push(big)).toThrow('exceeds limit');
    const badHave = Buffer.from([0, 0, 0, 3, 4, 0, 0]);
    expect(() => new MessageReader().push(badHave)).toThrow('expected 4');
  });
});

describe('extension payloads', () => {
  it('round-trips the extended handshake', () => {
    const hs = decodeExtendedHandshake(encodeExtendedHandshake({ extensions: LOCAL_EXT, metadataSize: 1234, port: 6881, client: 'MT 0.1', reqq: 250, yourIp: '10.0.0.2' }));
    expect(hs).toEqual({ m: { ut_metadata: 1, ut_pex: 2 }, metadataSize: 1234, port: 6881, client: 'MT 0.1', reqq: 250, yourIp: '10.0.0.2' });
  });

  it('round-trips ut_metadata messages including trailing data', () => {
    const data = randomBytes(100);
    const m = decodeMetadataMessage(encodeMetadataMessage({ msgType: 1, piece: 2, totalSize: 40000, data }));
    expect(m).toMatchObject({ msgType: 1, piece: 2, totalSize: 40000 });
    expect((m as { data: Buffer }).data.equals(data)).toBe(true);
    expect(decodeMetadataMessage(encodeMetadataMessage({ msgType: 0, piece: 5 }))).toEqual({ msgType: 0, piece: 5 });
    expect(() => decodeMetadataMessage(bencode({ msg_type: 9, piece: 0 }))).toThrow('unknown');
  });

  it('assembles and verifies metadata from pieces', () => {
    const info = randomBytes(METADATA_PIECE_SIZE * 2 + 100);
    const hash = createHash('sha1').update(info).digest();
    const asm = new MetadataAssembler(hash);
    expect(asm.setSize(info.length)).toBe(true);
    expect(asm.setSize(5)).toBe(false);
    expect(asm.nextRequest('a')).toBe(0);
    expect(asm.nextRequest('b')).toBe(1);
    expect(asm.nextRequest('a')).toBe(2);
    expect(asm.nextRequest('a')).toBeNull();
    asm.release('b');
    expect(asm.nextRequest('c')).toBe(1);
    expect(asm.add(0, metadataPiece(info, 0)!)).toBeNull();
    expect(asm.add(1, Buffer.alloc(3))).toBeNull(); // wrong size ignored
    expect(asm.add(1, metadataPiece(info, 1)!)).toBeNull();
    expect(asm.add(2, metadataPiece(info, 2)!)?.equals(info)).toBe(true);
  });

  it('rejects metadata that does not hash to the info-hash', () => {
    const asm = new MetadataAssembler(randomBytes(20));
    asm.setSize(10);
    expect(() => asm.add(0, Buffer.alloc(10))).toThrow('does not match');
    expect(new MetadataAssembler(randomBytes(20)).setSize(100 * 1024 * 1024)).toBe(false);
  });

  it('computes PEX diffs and round-trips the payload', () => {
    const t = new PexTracker();
    const p1 = { host: '1.1.1.1', port: 1 };
    const p2 = { host: '2.2.2.2', port: 2 };
    expect(t.diff([p1, p2])).toEqual({ added: [p1, p2], dropped: [] });
    expect(t.diff([p1, p2])).toBeNull();
    expect(t.diff([p2])).toEqual({ added: [], dropped: [p1] });
    expect(decodePex(encodePex({ added: [p1], dropped: [p2] }))).toEqual({ added: [p1], dropped: [p2] });
    const many = Array.from({ length: 80 }, (_, i) => ({ host: '3.3.3.3', port: 1000 + i }));
    expect(new PexTracker().diff(many)?.added.length).toBe(50);
  });
});

describe('rate limiting', () => {
  it('token bucket enforces the average rate with debt', () => {
    let now = 0;
    const b = new TokenBucket(100_000, 1, () => now);
    expect(b.consume(100_000)).toBe(0); // burst
    expect(b.consume(50_000)).toBe(500);
    now += 500;
    expect(b.consume(0)).toBe(0);
    expect(new TokenBucket(0).consume(1e9)).toBe(0);
    b.setRate(0);
    expect(b.consume(1e9)).toBe(0);
  });

  it('rate meter converges to the steady rate and decays', () => {
    let now = 0;
    const m = new RateMeter(1000, () => now);
    for (let i = 0; i < 100; i++) {
      now += 100;
      m.add(1000);
    }
    expect(m.rate()).toBeGreaterThan(9000);
    expect(m.rate()).toBeLessThan(11000);
    now += 10_000;
    expect(m.rate()).toBe(0);
    expect(m.total).toBe(100_000);
  });
});

describe('Choker', () => {
  const peer = (id: string, over: Partial<ChokerPeer> = {}): ChokerPeer => ({
    id, peerInterested: true, downloadRate: 0, uploadRate: 0, snubbed: false, isSeed: false, connectedAt: 0, ...over,
  });

  it('unchokes the fastest uploaders plus one optimistic peer when leeching', () => {
    const c = new Choker({ uploadSlots: 3, random: () => 0, now: () => 1e9 });
    const peers = [peer('slow', { downloadRate: 1 }), peer('fast', { downloadRate: 100 }), peer('mid', { downloadRate: 50 }), peer('none')];
    const u = c.run(peers, false);
    expect(u.has('fast')).toBe(true);
    expect(u.has('mid')).toBe(true);
    expect(u.size).toBe(3);
    expect(c.optimisticPeer).not.toBeNull();
    expect(['slow', 'none']).toContain(c.optimisticPeer);
  });

  it('sorts by upload rate when seeding and ignores seeds and uninterested peers', () => {
    const c = new Choker({ uploadSlots: 2, random: () => 0 });
    const u = c.run([peer('a', { uploadRate: 5 }), peer('b', { uploadRate: 50 }), peer('seed', { isSeed: true, uploadRate: 1e6 }), peer('x', { peerInterested: false })], true);
    expect(u.has('b')).toBe(true);
    expect(u.has('seed')).toBe(false);
    expect(u.has('x')).toBe(false);
  });

  it('only gives snubbed peers the optimistic slot and rotates it', () => {
    let r = 0;
    const c = new Choker({ uploadSlots: 2, optimisticRounds: 2, random: () => r });
    const peers = [peer('good', { downloadRate: 10 }), peer('s1', { snubbed: true }), peer('s2', { snubbed: true })];
    c.run(peers, false);
    const first = c.optimisticPeer;
    expect(['s1', 's2']).toContain(first);
    r = 1;
    c.run(peers, false); // round 2: rotation due
    expect(c.optimisticPeer).toBe('s2');
  });

  it('fills unused slots so upload capacity is not wasted', () => {
    const c = new Choker({ uploadSlots: 4 });
    expect(c.run([peer('a'), peer('b')], false).size).toBe(2);
  });
});

describe('PeerConnection', () => {
  it('handshakes over TCP and exchanges state messages', async () => {
    const { a, b } = await pair();
    expect(a.supportsFast && a.supportsExtensions).toBe(true);
    expect(a.remoteFlags.dht).toBe(true);
    const seen: string[] = [];
    b.on('interested', () => seen.push('interested'));
    b.on('have', (i) => seen.push(`have ${i}`));
    b.on('bitfield', (bits) => seen.push(`bitfield ${bits.toString('hex')}`));
    b.on('port', (p) => seen.push(`port ${p}`));
    a.on('unchoke', () => seen.push('unchoke'));
    a.interested();
    a.have(3);
    a.bitfield(Buffer.from([0xa0]));
    a.port(6881);
    b.unchoke();
    await until(() => seen.length === 5);
    expect(seen).toEqual(['interested', 'have 3', 'bitfield a0', 'port 6881', 'unchoke']);
    expect(b.peerInterested).toBe(true);
    expect(a.peerChoking).toBe(false);
  });

  it('serves requested blocks and tracks outstanding requests', async () => {
    const { a, b } = await pair();
    const block = randomBytes(16384);
    b.on('request', (i, begin, len) => void b.sendPiece(i, begin, block.subarray(0, len)));
    a.interested();
    b.unchoke();
    await until(() => !a.peerChoking);
    const got: Buffer[] = [];
    a.on('piece', (_i, _b, data) => got.push(data));
    expect(a.request(0, 0, 16384)).toBe(true);
    expect(a.request(0, 0, 16384)).toBe(false);
    await until(() => got.length === 1);
    expect(got[0]?.equals(block)).toBe(true);
    expect(a.requests.size).toBe(0);
    expect(a.downloadMeter.total).toBe(16384);
    expect(b.uploadMeter.total).toBe(16384);
  });

  it('rejects requests while choking (fast extension) and drops requests on choke', async () => {
    const { a, b } = await pair();
    const rejected: number[] = [];
    a.on('reject', (i) => rejected.push(i));
    const dropped: number[] = [];
    a.on('requestsDropped', (list) => dropped.push(...list.map((r) => r.index)));
    a.request(5, 0, 16384); // b is choking us
    await until(() => rejected.length === 1);
    expect(dropped).toEqual([5]);
    b.unchoke();
    await until(() => !a.peerChoking);
    b.on('request', () => {}); // do not answer
    a.request(6, 0, 16384);
    await tick(20);
    b.choke();
    await until(() => dropped.includes(6));
    expect(a.requests.size).toBe(0);
  });

  it('cancels requests and does not deliver cancelled blocks', async () => {
    const { a, b } = await pair();
    b.unchoke();
    await until(() => !a.peerChoking);
    const cancels: number[] = [];
    b.on('cancel', (i) => cancels.push(i));
    let pieces = 0;
    a.on('piece', () => pieces++);
    b.on('request', (i, begin, len) => {
      setTimeout(() => void b.sendPiece(i, begin, Buffer.alloc(len)), 30);
    });
    a.request(1, 0, 100);
    await until(() => b.hasPeerRequest(1, 0, 100));
    a.cancel(1, 0, 100);
    await until(() => cancels.length === 1);
    expect(b.hasPeerRequest(1, 0, 100)).toBe(false);
    await tick(60);
    expect(pieces).toBe(0);
  });

  it('exchanges extended handshakes, metadata and pex', async () => {
    const { a, b } = await pair();
    const hs = new Promise((r) => b.once('extendedHandshake', r));
    a.sendExtendedHandshake({ extensions: LOCAL_EXT, metadataSize: 1000, port: 7777, client: 'MT test' });
    expect(await hs).toMatchObject({ metadataSize: 1000, port: 7777, client: 'MT test', yourIp: '127.0.0.1' });
    b.sendExtendedHandshake({ extensions: LOCAL_EXT });
    await until(() => a.remoteExtensions !== null);
    expect(b.listenAddress).toEqual({ host: '127.0.0.1', port: 7777 });
    const meta = new Promise((r) => b.once('metadata', r));
    expect(a.sendMetadata({ msgType: 0, piece: 0 })).toBe(true);
    expect(await meta).toEqual({ msgType: 0, piece: 0 });
    const pex = new Promise((r) => a.once('pex', r));
    b.sendPex({ added: [{ host: '9.9.9.9', port: 99 }], dropped: [] });
    expect(await pex).toEqual({ added: [{ host: '9.9.9.9', port: 99 }], dropped: [] });
  });

  it('closes on handshakes for a different torrent', async () => {
    const listener = new PeerListener();
    await listener.listen(0, '127.0.0.1');
    closers.push(() => listener.close());
    listener.on('connection', (socket, hs, address) => {
      // pretend we only serve a different torrent
      const b = new PeerConnection({ socket, incoming: true, infoHash: randomBytes(20), peerId: randomBytes(20), address, reserved: flags });
      closers.push(() => b.destroy());
      void hs;
    });
    const sock = await connectTcp({ host: '127.0.0.1', port: listener.port });
    const a = new PeerConnection({ socket: sock, incoming: false, infoHash, peerId: randomBytes(20), address: { host: '127.0.0.1', port: listener.port }, reserved: flags, handshakeTimeoutMs: 300 });
    await new Promise<Error | undefined>((r) => a.once('close', r));
    expect(a.isClosed).toBe(true);
    expect(a.handshaken).toBe(false);
  });

  it('detects snubbing and expires stale requests', async () => {
    let now = Date.now();
    const { a, b } = await pair({ now: () => now, snubTimeoutMs: 1000 });
    b.unchoke();
    await until(() => !a.peerChoking);
    b.on('request', () => {});
    a.request(0, 0, 100);
    expect(a.isSnubbed()).toBe(false);
    now += 1500;
    expect(a.isSnubbed()).toBe(true);
    const dropped: number[] = [];
    a.on('requestsDropped', (l) => dropped.push(...l.map((r) => r.index)));
    expect(a.expireRequests(now - 500)).toBe(1);
    expect(dropped).toEqual([0]);
    expect(a.isSnubbed()).toBe(false);
  });

  it('adapts the request queue depth to throughput', async () => {
    const { a } = await pair();
    expect(a.desiredQueueDepth).toBe(4);
    a.downloadMeter.add(10 * 1024 * 1024);
    expect(a.desiredQueueDepth).toBeGreaterThan(50);
    expect(a.desiredQueueDepth).toBeLessThanOrEqual(250);
  });

  it('sends keep-alives and times out idle peers', async () => {
    const { a, b } = await pair({ keepAliveMs: 50, idleTimeoutMs: 100000 }, { idleTimeoutMs: 100000 });
    // a sends keep-alives at least every ~50ms; b never times out
    await tick(120);
    expect(a.isClosed || b.isClosed).toBe(false);
    const { a: c } = await pair({ keepAliveMs: 1_000_000, idleTimeoutMs: 1 });
    // ticks run at most every 30s; force one
    (c as unknown as { tick(): void }).tick();
    expect(c.isClosed).toBe(true);
  });

  it('applies per-connection upload limits', async () => {
    const { a, b } = await pair({}, { uploadLimit: 64 * 1024 });
    b.on('request', (i, begin, len) => void b.sendPiece(i, begin, Buffer.alloc(len)));
    b.unchoke();
    await until(() => !a.peerChoking);
    let got = 0;
    a.on('piece', (_i, _b, d) => (got += d.length));
    const start = Date.now();
    for (let i = 0; i < 8; i++) a.request(i, 0, 16384); // 128 KiB at 64 KiB/s, 64 KiB burst
    await until(() => got === 8 * 16384, 5000);
    expect(Date.now() - start).toBeGreaterThanOrEqual(700);
  });

  it('binds outgoing connections to a local address', async () => {
    const server = net.createServer((s) => s.destroy());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    closers.push(() => new Promise<void>((r) => server.close(() => r())));
    const port = (server.address() as net.AddressInfo).port;
    const sock = await connectTcp({ host: '127.0.0.1', port }, { localAddress: '127.0.0.1' });
    expect(sock.localAddress).toBe('127.0.0.1');
    sock.destroy();
    await expect(connectTcp({ host: '127.0.0.1', port: 1 }, { timeoutMs: 2000 })).rejects.toThrow();
  });
});

describe('PeerListener', () => {
  it('drops blocked IPs and garbage handshakes', async () => {
    const listener = new PeerListener({ isBlocked: (ip) => ip === '127.0.0.1' });
    await listener.listen(0, '127.0.0.1');
    closers.push(() => listener.close());
    let connections = 0;
    listener.on('connection', () => connections++);
    const sock = await connectTcp({ host: '127.0.0.1', port: listener.port });
    await new Promise((r) => sock.once('close', r));
    expect(connections).toBe(0);

    const open = new PeerListener();
    await open.listen(0, '127.0.0.1');
    closers.push(() => open.close());
    const s2 = await connectTcp({ host: '127.0.0.1', port: open.port });
    s2.write(Buffer.from('GET / HTTP/1.1\r\n\r\n'));
    await new Promise((r) => s2.once('close', r));
    expect(open.listening).toBe(true);
  });

  it('can be closed and re-listened on another address', async () => {
    const l = new PeerListener();
    await l.listen(0, '127.0.0.1');
    const p = l.port;
    expect(p).toBeGreaterThan(0);
    expect(l.address).toBe('127.0.0.1');
    await l.close();
    expect(l.listening).toBe(false);
    await l.listen(0, '127.0.0.1');
    expect(l.listening).toBe(true);
    await l.close();
  });
});

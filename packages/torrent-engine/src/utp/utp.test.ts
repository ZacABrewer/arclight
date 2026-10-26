import { createHash, randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { completed, payloadMatches, TestEnv, waitFor } from '../test-utils.js';
import { startHttpTracker } from '../tracker/test-trackers.js';
import { UtpManager, type UtpManagerOptions } from './manager.js';
import { decodePacket, encodePacket, looksLikeUtp, seqAfter, ST_DATA, ST_STATE, ST_SYN } from './packet.js';
import type { UtpSocket } from './socket.js';

const env = new TestEnv();
afterEach(() => env.cleanup());

async function endpoint(opts: UtpManagerOptions = {}): Promise<{ mgr: UtpManager; port: number }> {
  const sock = dgram.createSocket('udp4');
  await new Promise<void>((r) => sock.bind(0, '127.0.0.1', () => r()));
  const mgr = new UtpManager(opts);
  mgr.attach(sock);
  env.defer(() => {
    mgr.close();
    sock.close();
  });
  return { mgr, port: sock.address().port };
}

function collect(s: UtpSocket, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let len = 0;
    s.on('data', (d: Buffer) => {
      parts.push(d);
      len += d.length;
      if (len >= n) resolve(Buffer.concat(parts));
    });
    s.once('error', reject);
  });
}

const sha = (b: Buffer) => createHash('sha1').update(b).digest('hex');

describe('uTP packets', () => {
  it('round-trips headers with a selective ACK extension', () => {
    const sack = Buffer.from([0b0000_0101, 0, 0, 0x80]);
    const raw = encodePacket({ type: ST_STATE, connectionId: 4242, timestamp: 123456, timestampDiff: 99, wndSize: 1 << 20, seq: 65535, ack: 7, sack, payload: Buffer.alloc(0) });
    expect(raw.length).toBe(20 + 2 + 4);
    expect(raw[0]).toBe(0x21);
    expect(looksLikeUtp(raw)).toBe(true);
    const p = decodePacket(raw);
    expect(p).toMatchObject({ type: ST_STATE, connectionId: 4242, timestamp: 123456, timestampDiff: 99, wndSize: 1 << 20, seq: 65535, ack: 7 });
    expect(p?.sack?.equals(sack)).toBe(true);
    const data = decodePacket(encodePacket({ type: ST_DATA, connectionId: 1, timestamp: 0, timestampDiff: 0, wndSize: 0, seq: 1, ack: 0, payload: Buffer.from('hi') }));
    expect(data?.payload.toString()).toBe('hi');
    // bencoded DHT traffic on the shared socket is not uTP
    expect(looksLikeUtp(Buffer.from('d1:ad2:id20:aaaaaaaaaaaaaaaaaaaae1:q4:ping1:t2:aa1:y1:qe'))).toBe(false);
    expect(decodePacket(Buffer.from([0x41, 1, 0, 0]))).toBeNull();
  });

  it('compares 16-bit sequence numbers across wrap-around', () => {
    expect(seqAfter(1, 0)).toBe(true);
    expect(seqAfter(0, 65535)).toBe(true);
    expect(seqAfter(65535, 0)).toBe(false);
    expect(seqAfter(5, 5)).toBe(false);
  });
});

describe('uTP connections', () => {
  it('connects, transfers in both directions and closes with FIN', async () => {
    const a = await endpoint();
    const b = await endpoint();
    const accepted = new Promise<UtpSocket>((r) => b.mgr.once('connection', (s) => r(s)));
    const client = await a.mgr.connect({ host: '127.0.0.1', port: b.port });
    const server = await accepted;
    expect(client.state).toBe('connected');
    const up = randomBytes(200_000);
    const down = randomBytes(50_000);
    const gotUp = collect(server, up.length);
    const gotDown = collect(client, down.length);
    client.write(up);
    server.write(down);
    expect(sha(await gotUp)).toBe(sha(up));
    expect(sha(await gotDown)).toBe(sha(down));
    expect(client.rttMs).toBeGreaterThanOrEqual(0);
    // the congestion window grew from its initial two packets
    expect(client.maxWindow).toBeGreaterThan(2 * 1400);
    const ended = new Promise<void>((r) => server.once('end', () => r()));
    server.resume();
    client.end();
    await ended;
    await waitFor(() => client.destroyed && server.destroyed, 3000);
    expect(a.mgr.connectionCount + b.mgr.connectionCount).toBe(0);
  });

  it('recovers from packet loss with selective ACKs and retransmits', async () => {
    let dropped = 0;
    const lossy = (dir: 'in' | 'out', pkt: Buffer): boolean => {
      // never drop SYNs so the test measures data recovery, drop ~10% of the rest
      if (pkt[0] === ((ST_SYN << 4) | 1)) return false;
      if (Math.random() < 0.08) {
        dropped++;
        return true;
      }
      void dir;
      return false;
    };
    const a = await endpoint({ minRtoMs: 100, initialRtoMs: 200, dropPacket: lossy });
    const b = await endpoint({ minRtoMs: 100, initialRtoMs: 200, dropPacket: lossy });
    const accepted = new Promise<UtpSocket>((r) => b.mgr.once('connection', (s) => r(s)));
    const client = await a.mgr.connect({ host: '127.0.0.1', port: b.port });
    const server = await accepted;
    const data = randomBytes(200_000);
    const got = collect(server, data.length);
    client.write(data);
    const back = randomBytes(30_000);
    const gotBack = collect(client, back.length);
    server.write(back);
    expect(sha(await got)).toBe(sha(data));
    expect(sha(await gotBack)).toBe(sha(back));
    expect(dropped).toBeGreaterThan(10);
    expect(client.counters.resent + server.counters.resent).toBeGreaterThan(0);
  }, 30_000);

  it('rejects connections when not accepting and times out against silence', async () => {
    const closed = await endpoint({ accept: () => false });
    const a = await endpoint({ minRtoMs: 50 });
    await expect(a.mgr.connect({ host: '127.0.0.1', port: closed.port }, 3000)).rejects.toThrow(/failed/);
    const silent = dgram.createSocket('udp4');
    await new Promise<void>((r) => silent.bind(0, '127.0.0.1', () => r()));
    env.defer(() => silent.close());
    await expect(a.mgr.connect({ host: '127.0.0.1', port: silent.address().port }, 300)).rejects.toThrow(/timed out/);
  });
});

describe('Session over uTP', () => {
  it('downloads over uTP only (TCP disabled), encrypted on top', async () => {
    const tr = await startHttpTracker({ interval: 1 });
    env.defer(() => tr.close());
    const utpOnly = { tcp: false, utp: true };
    const { p, torrent, seeder } = await env.seed(utpOnly, {}, { announce: tr.url });
    expect(seeder.listenPort).toBeGreaterThan(0);
    const dir = await env.tmp();
    const leecher = await env.session({ savePath: dir, ...utpOnly });
    const lt = await leecher.addTorrent({ torrent });
    const peers = await waitFor(() => (lt.getPeers().length > 0 ? lt.getPeers() : null));
    expect(peers.every((x) => x.transport === 'utp')).toBe(true);
    expect(peers.every((x) => x.encrypted)).toBe(true);
    await completed(lt);
    expect(await payloadMatches(dir, 'pack', p)).toBe(true);
    expect(leecher.getSessionStats().utpConnections).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it('shares the UDP port with the DHT', async () => {
    const s = await env.session({ dht: true, utp: true, savePath: await env.tmp() });
    expect(s.dht?.port).toBe(s.listenPort);
    expect(s.utpManager.attached).toBe(true);
    // a uTP SYN to the DHT port is answered by the uTP side
    const other = await endpoint();
    const sock = await other.mgr.connect({ host: '127.0.0.1', port: s.listenPort }, 2000);
    expect(sock.state).toBe('connected');
    sock.destroy();
  });
});

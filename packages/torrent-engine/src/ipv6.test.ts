import net from 'node:net';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { encode as bencode } from './bencode.js';
import {
  addressKey,
  decodeCompactNodes6,
  decodeCompactPeers6,
  encodeCompactNodes6,
  encodeCompactPeers,
  encodeCompactPeers6,
  ipv6ToBytes,
  normalizeHost,
} from './compact.js';
import { DHT } from './dht/dht.js';
import { decodePex, encodePex, PEX_FLAG } from './peer/extensions.js';
import { completed, payloadMatches, TestEnv, waitFor } from './test-utils.js';
import { HttpTracker } from './tracker/http-tracker.js';
import { startHttpTracker } from './tracker/test-trackers.js';

const env = new TestEnv();
afterEach(() => env.cleanup());

let hasLoopback6 = false;
beforeAll(async () => {
  hasLoopback6 = await new Promise<boolean>((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(0, '::1', () => s.close(() => resolve(true)));
  });
});

describe('IPv6 compact formats', () => {
  it('normalises hosts and keys', () => {
    expect(normalizeHost('::ffff:10.0.0.1')).toBe('10.0.0.1');
    expect(normalizeHost('[2001:DB8:0:0:0:0:0:1]')).toBe('2001:db8::1');
    expect(addressKey({ host: '::1', port: 6881 })).toBe('[::1]:6881');
    expect(addressKey({ host: '1.2.3.4', port: 6881 })).toBe('1.2.3.4:6881');
    expect(ipv6ToBytes('::ffff:1.2.3.4').toString('hex')).toBe('00000000000000000000ffff01020304');
    expect(ipv6ToBytes('2001:db8::8:1').toString('hex')).toBe('20010db8000000000000000000080001');
  });

  it('round-trips peers6 and nodes6', () => {
    const peers = [
      { host: '2001:db8::1', port: 6881 },
      { host: 'fe80::1:2:3:4', port: 51413 },
    ];
    const buf = encodeCompactPeers6([...peers, { host: '1.2.3.4', port: 1 }]);
    expect(buf.length).toBe(36);
    expect(decodeCompactPeers6(buf)).toEqual(peers);
    expect(encodeCompactPeers(peers).length).toBe(0);
    const nodes = peers.map((p, i) => ({ id: Buffer.alloc(20, i + 1), ...p }));
    const n6 = encodeCompactNodes6(nodes);
    expect(n6.length).toBe(76);
    expect(decodeCompactNodes6(n6).map((n) => ({ host: n.host, port: n.port }))).toEqual(peers);
  });

  it('carries IPv6 peers and flags in PEX (added6 / added6.f)', () => {
    const msg = {
      added: [
        { host: '9.9.9.9', port: 99, flags: PEX_FLAG.utp | PEX_FLAG.prefersEncryption },
        { host: '2001:db8::2', port: 100, flags: PEX_FLAG.seed },
        { host: '2001:db8::3', port: 101 },
      ],
      dropped: [{ host: '2001:db8::4', port: 102 }],
    };
    expect(decodePex(encodePex(msg))).toEqual(msg);
  });

  it('parses peers6 from HTTP tracker responses', async () => {
    const body = bencode({
      interval: 60,
      peers: encodeCompactPeers([{ host: '1.2.3.4', port: 5 }]),
      peers6: encodeCompactPeers6([{ host: '2001:db8::7', port: 6 }]),
    });
    const t = new HttpTracker('http://tracker.test/announce', { requester: async () => ({ status: 200, body }) });
    const res = await t.announce({ infoHash: Buffer.alloc(20), peerId: Buffer.alloc(20), port: 1, uploaded: 0, downloaded: 0, left: 0, key: 1 });
    expect(res.peers).toEqual([
      { host: '1.2.3.4', port: 5 },
      { host: '2001:db8::7', port: 6 },
    ]);
  });
});

describe('IPv6 networking (::1)', () => {
  it('runs a BEP 32 DHT over IPv6 with nodes6 and 18-byte values', async (ctx) => {
    if (!hasLoopback6) ctx.skip();
    const nodes: DHT[] = [];
    for (let i = 0; i < 4; i++) {
      const d = new DHT({ family: 6, queryTimeoutMs: 300, bootstrap: nodes[0] ? [`[::1]:${nodes[0].port}`] : [] });
      await d.listen(0, '::1');
      env.defer(() => d.close());
      nodes.push(d);
    }
    for (const d of nodes.slice(1)) await d.bootstrap();
    await waitFor(() => nodes.every((d) => d.nodeCount > 0), 3000);
    const infoHash = Buffer.alloc(20, 7);
    await nodes[1]!.announce(infoHash, 4242);
    const res = await nodes[3]!.getPeers(infoHash);
    expect(res.peers).toContainEqual({ host: '::1', port: 4242 });
  });

  it('downloads between sessions bound to ::1 via peers6 from a tracker', async (ctx) => {
    if (!hasLoopback6) ctx.skip();
    const tr = await startHttpTracker({ interval: 1, host: '::1' });
    env.defer(() => tr.close());
    const v6 = { listenAddress: '::1' };
    const { p, torrent, seeder } = await env.seed(v6, {}, { announce: tr.url });
    expect(seeder.getSessionStats().listenAddress).toBe('::1');
    const dir = await env.tmp();
    const leecher = await env.session({ savePath: dir, ...v6 });
    const lt = await leecher.addTorrent({ torrent });
    const peers = await waitFor(() => (lt.getPeers().length > 0 ? lt.getPeers() : null));
    expect(peers[0]?.address.startsWith('[::1]:')).toBe(true);
    await completed(lt);
    expect(await payloadMatches(dir, 'pack', p)).toBe(true);
  }, 30_000);

  it('downloads over uTP on IPv6', async (ctx) => {
    if (!hasLoopback6) ctx.skip();
    const settings = { listenAddress: '::1', tcp: false };
    const { p, meta, seeder } = await env.seed(settings);
    const dir = await env.tmp();
    const leecher = await env.session({ savePath: dir, ...settings });
    const lt = await leecher.addTorrent({ magnet: `magnet:?xt=urn:btih:${meta.infoHashHex}&x.pe=[::1]:${seeder.listenPort}` });
    await completed(lt);
    expect(await payloadMatches(dir, 'pack', p)).toBe(true);
  }, 30_000);
});

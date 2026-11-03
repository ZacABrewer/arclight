/**
 * Regression tests for the 0.24 data-handling audit: peer address policy, bans for bad data,
 * magnet names and incoming connection limits. Everything runs on loopback.
 */
import dgram from 'node:dgram';
import { writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PeerListener } from './peer/listener.js';
import type { SessionSettings } from './settings.js';
import { sleep, TestEnv, waitFor } from './test-utils.js';
import type { TrackerClient } from './tracker/types.js';
import { UtpManager } from './utp/manager.js';

const env = new TestEnv();
afterEach(() => env.cleanup());

const HASH = '0123456789abcdef0123456789abcdef01234567';

/** A loopback TCP server that only counts connection attempts. */
async function counter(): Promise<{ port: number; count: () => number }> {
  let n = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((s) => {
    n++;
    sockets.add(s);
    s.on('error', () => {});
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  env.defer(
    () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  );
  return { port: (server.address() as net.AddressInfo).port, count: () => n };
}

/** A tracker client that never touches the network and hands out `peers`. */
function fakeTracker(url: string, peers: { host: string; port: number }[]): TrackerClient {
  return {
    url,
    announce: () => Promise.resolve({ intervalSec: 60, peers }),
    scrape: () => Promise.resolve({ complete: 0, incomplete: 0, downloaded: 0 }),
    close: () => {},
  };
}

const STRICT: Partial<SessionSettings> = { allowLocalPeers: false, allowLocalTrackers: false };

describe('peer address policy (DATA-22)', () => {
  it('ignores loopback / LAN peers from trackers, PEX, DHT and magnet x.pe by default', async () => {
    const target = await counter();
    const peer = { host: '127.0.0.1', port: target.port };
    const s = await env.session(STRICT, {
      trackerClientFactory: (url) => fakeTracker(url, [peer]),
    });
    const magnet = `magnet:?xt=urn:btih:${HASH}&tr=${encodeURIComponent('http://tracker.example.com/announce')}&x.pe=127.0.0.1:${target.port}`;
    const t = await s.addTorrent({ magnet });
    t.addPeers([peer], 'pex');
    t.addPeers([peer], 'dht');
    await sleep(500);
    expect(target.count()).toBe(0);
    // Peers the admin adds by hand are trusted.
    t.addPeers([peer]);
    await waitFor(() => target.count() > 0);
  });

  it('connects to them with allowLocalPeers on', async () => {
    const target = await counter();
    const s = await env.session({ allowLocalPeers: true, allowLocalTrackers: false });
    const t = await s.addTorrent({ magnet: `magnet:?xt=urn:btih:${HASH}` });
    t.addPeers([{ host: '127.0.0.1', port: target.port }], 'pex');
    await waitFor(() => target.count() > 0);
  });

  it('keeps LAN peers from a LAN tracker when allowLocalTrackers is on', async () => {
    const target = await counter();
    const peer = { host: '127.0.0.1', port: target.port };
    const s = await env.session(
      { allowLocalPeers: false, allowLocalTrackers: true },
      { trackerClientFactory: (url) => fakeTracker(url, [peer]) },
    );
    // Fake client: nothing is sent to this address.
    const magnet = `magnet:?xt=urn:btih:${HASH}&tr=${encodeURIComponent('http://192.168.1.2:6969/announce')}`;
    await s.addTorrent({ magnet });
    await waitFor(() => target.count() > 0);
  });
});

describe('magnet names (DATA-25)', () => {
  it('keeps the content path inside the save path', async () => {
    const savePath = await env.tmp();
    const s = await env.session({ savePath });
    for (const [i, dn] of ['../../evil', '..', 'a/b', 'nul.txt', 'ok name'].entries()) {
      const hash = Buffer.from(HASH, 'hex');
      hash[0] = i;
      const t = await s.addTorrent({ magnet: `magnet:?xt=urn:btih:${hash.toString('hex')}&dn=${encodeURIComponent(dn)}`, paused: true });
      const content = resolve(t.getStats().contentPath);
      expect(content.startsWith(resolve(savePath) + sep)).toBe(true);
      expect(t.name).not.toContain('/');
      expect(t.name).not.toContain('\\');
      expect(t.name).not.toBe('..');
    }
  });
});

describe('bad data bans (DATA-24)', () => {
  it('bans a peer after three pieces fail the hash check', async () => {
    const { p, seedDir, torrent, seeder } = await env.seed();
    // Same sizes, wrong bytes: the seeder keeps serving what is on disk now.
    for (const f of p.files) await writeFile(join(seedDir, 'pack', ...f.path), Buffer.alloc(f.data.length, 0x5a));
    const leecher = await env.session({ savePath: await env.tmp() });
    const warnings: string[] = [];
    leecher.on('warning', (m) => warnings.push(m));
    const lt = await leecher.addTorrent({ torrent, peers: [{ host: '127.0.0.1', port: seeder.listenPort }] });
    lt.on('warning', (m) => warnings.push(m));
    await waitFor(() => lt.isBannedIp('127.0.0.1'), 20_000);
    expect(lt.hashFailureCount).toBeGreaterThanOrEqual(3);
    expect(warnings.some((w) => w.includes('banned peer 127.0.0.1'))).toBe(true);
    await waitFor(() => lt.getPeers().length === 0);
    await sleep(400);
    expect(lt.getPeers()).toHaveLength(0);
  }, 30_000);

  it('lifts a ban after an hour and doubles it on the next one', async () => {
    const H = 60 * 60 * 1000;
    let offset = 0;
    const clock = (): number => Date.now() + offset;
    const { p, seedDir, torrent, seeder } = await env.seed();
    for (const f of p.files) await writeFile(join(seedDir, 'pack', ...f.path), Buffer.alloc(f.data.length, 0x5a));
    const leecher = await env.session({ savePath: await env.tmp() }, { now: clock });
    const peer = { host: '127.0.0.1', port: seeder.listenPort };
    const lt = await leecher.addTorrent({ torrent, peers: [peer] });
    const warnings: string[] = [];
    lt.on('warning', (m) => warnings.push(m));
    await waitFor(() => lt.isBannedIp('127.0.0.1'), 20_000);
    const first = (lt.bannedUntil('127.0.0.1') ?? 0) - clock();
    expect(first).toBeGreaterThan(H - 60_000);
    expect(first).toBeLessThanOrEqual(H);
    expect(warnings.some((w) => w.includes('banned peer 127.0.0.1 for 1 h'))).toBe(true);
    // Refused while banned, even when added again.
    lt.addPeers([peer]);
    await sleep(300);
    expect(lt.getPeers()).toHaveLength(0);
    offset += H + 1000;
    expect(lt.isBannedIp('127.0.0.1')).toBe(false);
    lt.addPeers([peer]);
    await waitFor(() => lt.isBannedIp('127.0.0.1'), 20_000);
    const second = (lt.bannedUntil('127.0.0.1') ?? 0) - clock();
    expect(second).toBeGreaterThan(2 * H - 60_000);
    expect(second).toBeLessThanOrEqual(2 * H);
  }, 45_000);
});

describe('IP blocklist', () => {
  it('never connects to blocked peers from trackers, PEX, DHT, magnets or by hand', async () => {
    const target = await counter();
    const peer = { host: '127.0.0.1', port: target.port };
    const blocked = new Set(['127.0.0.1']);
    const s = await env.session(
      { allowLocalPeers: true },
      { isBlocked: (ip) => blocked.has(ip), trackerClientFactory: (url) => fakeTracker(url, [peer]) },
    );
    const magnet = `magnet:?xt=urn:btih:${HASH}&tr=${encodeURIComponent('http://tracker.example.com/announce')}&x.pe=127.0.0.1:${target.port}`;
    const t = await s.addTorrent({ magnet });
    t.addPeers([peer], 'pex');
    t.addPeers([peer], 'dht');
    t.addPeers([peer]);
    await sleep(500);
    expect(target.count()).toBe(0);
    blocked.clear();
    t.addPeers([peer]);
    await waitFor(() => target.count() > 0);
  });

  it('refuses incoming TCP connections from blocked IPs', async () => {
    const blocked = new Set(['127.0.0.1']);
    const s = await env.session({ utp: false }, { isBlocked: (ip) => blocked.has(ip) });
    const sock = net.connect(s.listenPort, '127.0.0.1');
    sock.on('error', () => {});
    env.defer(() => sock.destroy());
    await new Promise<void>((r) => sock.once('close', () => r()));
    blocked.clear();
    const ok = net.connect(s.listenPort, '127.0.0.1');
    ok.on('error', () => {});
    env.defer(() => ok.destroy());
    let gone = false;
    ok.once('close', () => (gone = true));
    await sleep(200);
    expect(gone).toBe(false);
  });

  it('refuses incoming uTP connections from blocked IPs at the SYN', async () => {
    const blocked = new Set(['127.0.0.1']);
    const s = await env.session({ utp: true }, { isBlocked: (ip) => blocked.has(ip) });
    const udp = dgram.createSocket('udp4');
    await new Promise<void>((r) => udp.bind(0, '127.0.0.1', () => r()));
    const mgr = new UtpManager({ minRtoMs: 50 });
    mgr.attach(udp);
    env.defer(() => {
      mgr.close();
      udp.close();
    });
    // refused with a reset (or, on a loaded machine, never answered): never connected
    await expect(mgr.connect({ host: '127.0.0.1', port: s.listenPort }, 5000)).rejects.toThrow(/failed|timed out/);
    expect(s.utpManager.incomingCount).toBe(0);
    blocked.clear();
    const sock = await mgr.connect({ host: '127.0.0.1', port: s.listenPort }, 5000);
    expect(sock.state).toBe('connected');
    sock.destroy();
  }, 20_000);
});

describe('incoming connection limits (DATA-26)', () => {
  it('caps handshakes in progress in total and per IP', async () => {
    const listener = new PeerListener({ maxPending: 6, maxPendingPerIp: 4, handshakeTimeoutMs: 5000 });
    await listener.listen(0, '127.0.0.1');
    env.defer(() => listener.close());
    const open: net.Socket[] = [];
    env.defer(() => {
      for (const s of open) s.destroy();
    });
    let closed = 0;
    for (let i = 0; i < 20; i++) {
      const s = net.connect(listener.port, '127.0.0.1');
      s.on('error', () => {});
      s.on('close', () => closed++);
      open.push(s);
    }
    // All from 127.0.0.1: only 4 are held, the rest are dropped at once.
    await waitFor(() => closed >= 16);
    await sleep(100);
    expect(closed).toBe(16);
  });

  it('refuses connections when the session cannot take more', async () => {
    let allow = false;
    const listener = new PeerListener({ canAccept: () => allow });
    await listener.listen(0, '127.0.0.1');
    env.defer(() => listener.close());
    const s = net.connect(listener.port, '127.0.0.1');
    s.on('error', () => {});
    env.defer(() => s.destroy());
    await new Promise<void>((r) => s.once('close', () => r()));
    allow = true;
    const ok = net.connect(listener.port, '127.0.0.1');
    ok.on('error', () => {});
    env.defer(() => ok.destroy());
    let gone = false;
    ok.once('close', () => (gone = true));
    await sleep(200);
    expect(gone).toBe(false);
  });
});

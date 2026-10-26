import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { encode } from '../bencode.js';
import { encodeCompactPeers } from '../compact.js';
import { HttpTracker, percentEncodeBytes, type HttpRequester } from './http-tracker.js';
import { startHttpTracker, startUdpTracker, parseRawQuery, type TestHttpTracker, type TestUdpTracker } from './test-trackers.js';
import { TrackerManager, createTrackerClient } from './tracker-manager.js';
import type { AnnounceParams, AnnounceResponse, ScrapeResponse, TrackerClient } from './types.js';
import { UdpTracker } from './udp-tracker.js';

const infoHash = Buffer.from('0123456789abcdef0123456789abcdef01234567', 'hex');
function params(over: Partial<AnnounceParams> = {}): AnnounceParams {
  return { infoHash, peerId: randomBytes(20), port: 6881, uploaded: 0, downloaded: 0, left: 100, key: 0x1234abcd, ...over };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
async function http(opts?: Parameters<typeof startHttpTracker>[0]): Promise<TestHttpTracker> {
  const t = await startHttpTracker(opts);
  cleanups.push(() => t.close());
  return t;
}
async function udp(opts?: Parameters<typeof startUdpTracker>[0]): Promise<TestUdpTracker> {
  const t = await startUdpTracker(opts);
  cleanups.push(() => t.close());
  return t;
}

describe('HttpTracker', () => {
  it('percent-encodes binary safely', () => {
    expect(percentEncodeBytes(Buffer.from([0x41, 0x00, 0xff, 0x2e, 0x20]))).toBe('A%00%FF.%20');
    const q = parseRawQuery(`x=${percentEncodeBytes(infoHash)}`);
    expect(q.get('x')?.[0]?.equals(infoHash)).toBe(true);
  });

  it('builds announce urls with all fields', () => {
    const t = new HttpTracker('http://t/announce?passkey=abc');
    const url = t.buildAnnounceUrl(params({ event: 'started', numwant: 10 }));
    expect(url).toContain('?passkey=abc&info_hash=');
    expect(url).toContain('event=started');
    expect(url).toContain('numwant=10');
    expect(url).toContain('compact=1');
    expect(url).toContain('key=1234abcd');
  });

  it('announces against the in-process tracker and gets compact peers', async () => {
    const tr = await http({ interval: 900, trackerId: 'tid-1' });
    const a = new HttpTracker(tr.url);
    const first = await a.announce(params({ port: 1111, event: 'started' }));
    expect(first.peers).toEqual([]);
    expect(first.intervalSec).toBe(900);
    expect(first.trackerId).toBe('tid-1');
    const b = new HttpTracker(tr.url);
    const second = await b.announce(params({ port: 2222, left: 0, event: 'started' }));
    expect(second.peers).toEqual([{ host: '127.0.0.1', port: 1111 }]);
    expect(second.complete).toBe(1);
    expect(second.incomplete).toBe(1);
    // trackerid is echoed on the next announce
    await a.announce(params({ port: 1111 }));
    expect(tr.announces.at(-1)?.trackerId).toBe('tid-1');
    expect(tr.announces[0]?.event).toBe('started');
  });

  it('surfaces failure reasons', async () => {
    const tr = await http();
    tr.failureReason = 'unregistered torrent';
    await expect(new HttpTracker(tr.url).announce(params())).rejects.toThrow('tracker failure: unregistered torrent');
  });

  it('parses dictionary peer lists, warnings and min interval via an injected requester', async () => {
    const requester: HttpRequester = async () => ({
      status: 200,
      body: encode({
        interval: 100,
        'min interval': 50,
        'warning message': 'be nice',
        peers: [{ ip: '10.0.0.1', port: 5000, 'peer id': 'x'.repeat(20) }, { ip: 'bad' }],
      }),
    });
    const res = await new HttpTracker('http://x/announce', { requester }).announce(params());
    expect(res).toMatchObject({ intervalSec: 100, minIntervalSec: 50, warning: 'be nice', peers: [{ host: '10.0.0.1', port: 5000 }] });
  });

  it('rejects non-bencoded and non-200 responses', async () => {
    const garbage: HttpRequester = async () => ({ status: 200, body: Buffer.from('<html>') });
    await expect(new HttpTracker('http://x/announce', { requester: garbage }).announce(params())).rejects.toThrow('invalid body');
    const e500: HttpRequester = async () => ({ status: 500, body: encode({ interval: 1 }) });
    await expect(new HttpTracker('http://x/announce', { requester: e500 }).announce(params())).rejects.toThrow('HTTP 500');
    const down: HttpRequester = async () => {
      throw new Error('ECONNREFUSED');
    };
    await expect(new HttpTracker('http://x/announce', { requester: down }).announce(params())).rejects.toThrow('unreachable');
  });

  it('scrapes', async () => {
    const tr = await http();
    await new HttpTracker(tr.url).announce(params({ left: 0, event: 'completed' }));
    const s = await new HttpTracker(tr.url).scrape(infoHash);
    expect(s).toEqual({ complete: 1, incomplete: 0, downloaded: 1 });
    expect(new HttpTracker('http://x/a').scrapeUrl()).toBeNull();
    expect(new HttpTracker('http://x/announce.php?k=1').scrapeUrl()).toBe('http://x/scrape.php?k=1');
  });

  it('binds outgoing requests to a local address', async () => {
    const tr = await http();
    const res = await new HttpTracker(tr.url, { localAddress: '127.0.0.1' }).announce(params());
    expect(res.peers).toEqual([]);
  });
});

describe('UdpTracker', () => {
  it('connects, announces and scrapes', async () => {
    const tr = await udp({ interval: 120 });
    const a = new UdpTracker(tr.url, { baseTimeoutMs: 200 });
    const r1 = await a.announce(params({ port: 3333, event: 'started' }));
    expect(r1.intervalSec).toBe(120);
    expect(r1.peers).toEqual([]);
    const r2 = await new UdpTracker(tr.url, { baseTimeoutMs: 200 }).announce(params({ port: 4444, left: 0, event: 'started' }));
    expect(r2.peers).toEqual([{ host: '127.0.0.1', port: 3333 }]);
    expect(r2.complete).toBe(1);
    expect(r2.incomplete).toBe(1);
    expect(tr.announces.map((x) => x.event)).toEqual(['started', 'started']);
    expect(tr.announces[0]?.key).toBe('1234abcd');
    const s = await a.scrape(infoHash);
    expect(s).toEqual({ complete: 1, incomplete: 1, downloaded: 0 });
  });

  it('retransmits after dropped packets', async () => {
    const tr = await udp();
    tr.dropNext = 2;
    const res = await new UdpTracker(tr.url, { baseTimeoutMs: 50, maxRetries: 4 }).announce(params());
    expect(res.peers).toEqual([]);
  });

  it('times out after max retries', async () => {
    const tr = await udp();
    tr.dropNext = 100;
    await expect(new UdpTracker(tr.url, { baseTimeoutMs: 20, maxRetries: 2 }).announce(params())).rejects.toThrow('did not respond');
  });

  it('reports tracker errors', async () => {
    const tr = await udp();
    tr.failureReason = 'nope';
    await expect(new UdpTracker(tr.url, { baseTimeoutMs: 100 }).announce(params())).rejects.toThrow('tracker failure: nope');
  });

  it('rejects non-udp urls', () => {
    expect(() => new UdpTracker('http://x')).toThrow();
    expect(createTrackerClient('wss://x')).toBeNull();
    expect(createTrackerClient('udp://x:1')).toBeInstanceOf(UdpTracker);
  });
});

class FakeTracker implements TrackerClient {
  calls: (string | undefined)[] = [];
  fail = false;
  constructor(readonly url: string, private readonly res: Partial<AnnounceResponse> = {}) {}
  async announce(p: AnnounceParams): Promise<AnnounceResponse> {
    this.calls.push(p.event);
    if (this.fail) throw new Error(`${this.url} down`);
    return { intervalSec: 1800, peers: [], ...this.res };
  }
  async scrape(): Promise<ScrapeResponse> {
    return { complete: 0, incomplete: 0, downloaded: 0 };
  }
  close(): void {}
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function manager(tiers: string[][], fakes: Map<string, FakeTracker>, over: Partial<ConstructorParameters<typeof TrackerManager>[0]> = {}): TrackerManager {
  return new TrackerManager({
    infoHash,
    peerId: randomBytes(20),
    tiers,
    getPort: () => 6881,
    getStats: () => ({ uploaded: 0, downloaded: 0, left: 10 }),
    clientFactory: (u) => fakes.get(u) ?? null,
    shuffle: false,
    retryBaseSec: 0.02,
    minIntervalSec: 0,
    ...over,
  });
}

describe('TrackerManager', () => {
  it('fails over within a tier and moves the working tracker to the front (BEP 12)', async () => {
    const a = new FakeTracker('a');
    const b = new FakeTracker('b', { peers: [{ host: '1.1.1.1', port: 1 }] });
    a.fail = true;
    const m = manager([['a', 'b']], new Map([['a', a], ['b', b]]));
    const peers: unknown[] = [];
    m.on('peers', (p) => peers.push(...p));
    m.on('error', () => {});
    m.start();
    await tick();
    expect(a.calls).toEqual(['started']);
    expect(b.calls).toEqual(['started']);
    expect(peers).toEqual([{ host: '1.1.1.1', port: 1 }]);
    const status = m.getTrackers();
    expect(status.map((s) => [s.url, s.state])).toEqual([['b', 'working'], ['a', 'error']]);
    m.close();
  });

  it('announces to all tiers by default, or stops at the first working tier', async () => {
    const mk = () => new Map([['a', new FakeTracker('a')], ['b', new FakeTracker('b')]]);
    const all = mk();
    const m1 = manager([['a'], ['b']], all);
    m1.start();
    await tick();
    expect(all.get('b')?.calls).toEqual(['started']);
    m1.close();
    const strict = mk();
    const m2 = manager([['a'], ['b']], strict, { announceToAllTiers: false });
    m2.start();
    await tick();
    expect(strict.get('a')?.calls).toEqual(['started']);
    expect(strict.get('b')?.calls).toEqual([]);
    m2.close();
  });

  it('falls through to the next tier when a whole tier fails (strict mode)', async () => {
    const a = new FakeTracker('a');
    a.fail = true;
    const b = new FakeTracker('b');
    const m = manager([['a'], ['b']], new Map([['a', a], ['b', b]]), { announceToAllTiers: false });
    m.on('error', () => {});
    m.start();
    await tick();
    expect(b.calls).toEqual(['started']);
    m.close();
  });

  it('retries with backoff after failures', async () => {
    const a = new FakeTracker('a');
    a.fail = true;
    const m = manager([['a']], new Map([['a', a]]));
    m.on('error', () => {});
    m.start();
    await tick(100);
    expect(a.calls.length).toBeGreaterThanOrEqual(3);
    a.fail = false;
    await tick(400);
    expect(m.getTrackers()[0]?.state).toBe('working');
    m.close();
  });

  it('re-announces on the tracker interval and sends completed and stopped', async () => {
    const a = new FakeTracker('a', { intervalSec: 0.05 });
    const m = manager([['a']], new Map([['a', a]]));
    m.start();
    await tick(130);
    expect(a.calls[0]).toBe('started');
    expect(a.calls.slice(1).every((c) => c === undefined)).toBe(true);
    expect(a.calls.length).toBeGreaterThanOrEqual(2);
    m.completed();
    await tick();
    expect(a.calls).toContain('completed');
    await m.stop();
    expect(a.calls.at(-1)).toBe('stopped');
  });

  it('force-announces inside the min interval, but not while stopped', async () => {
    const a = new FakeTracker('a', { intervalSec: 3600, minIntervalSec: 3600 });
    const m = manager([['a']], new Map([['a', a]]));
    expect(m.forceAnnounce()).toBe(0);
    m.start();
    await tick();
    m.announceNow();
    await tick();
    expect(a.calls).toEqual(['started']);
    expect(m.forceAnnounce()).toBe(1);
    await tick();
    expect(a.calls).toEqual(['started', undefined]);
    m.close();
  });

  it('does not send stopped to trackers that never saw started', async () => {
    const a = new FakeTracker('a');
    a.fail = true;
    const m = manager([['a']], new Map([['a', a]]));
    m.on('error', () => {});
    m.start();
    await tick();
    await m.stop();
    expect(a.calls).toEqual(['started']);
  });

  it('marks unsupported protocols disabled', () => {
    const m = manager([['wss://x']], new Map());
    expect(m.getTrackers()[0]?.state).toBe('disabled');
  });

  it('works end-to-end with real HTTP and UDP trackers', async () => {
    const h = await http({ interval: 60 });
    const u = await udp({ interval: 60 });
    // pre-populate both swarms with another peer
    await new HttpTracker(h.url).announce(params({ port: 9001 }));
    await new UdpTracker(u.url, { baseTimeoutMs: 200 }).announce(params({ port: 9002 }));
    const m = new TrackerManager({
      infoHash,
      peerId: randomBytes(20),
      tiers: [[h.url], [u.url]],
      getPort: () => 7000,
      getStats: () => ({ uploaded: 0, downloaded: 0, left: 1 }),
      clientFactory: (url) => createTrackerClient(url, { udpBaseTimeoutMs: 200 }),
    });
    const got = new Set<number>();
    m.on('peers', (ps) => ps.forEach((p) => got.add(p.port)));
    m.start();
    for (let i = 0; i < 50 && got.size < 2; i++) await tick();
    expect([...got].sort()).toEqual([9001, 9002]);
    await m.stop();
    expect(h.announces.at(-1)?.event).toBe('stopped');
    expect(u.announces.at(-1)?.event).toBe('stopped');
    expect(encodeCompactPeers([]).length).toBe(0);
  });
});

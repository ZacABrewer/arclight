import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { decode, encode, type BDict } from '../bencode.js';
import { DHT } from './dht.js';
import { KrpcSocket } from './krpc.js';
import { bigIntToId, distance, idToBigInt, randomIdInRange, RoutingTable } from './routing-table.js';

const open: DHT[] = [];
afterEach(() => {
  for (const d of open.splice(0)) d.close();
});

async function makeNode(bootstrap: string[] = [], opts: ConstructorParameters<typeof DHT>[0] = {}): Promise<DHT> {
  const d = new DHT({ bootstrap, queryTimeoutMs: 300, ...opts });
  await d.listen(0, '127.0.0.1');
  open.push(d);
  return d;
}

async function network(n: number): Promise<DHT[]> {
  const first = await makeNode();
  const nodes = [first];
  for (let i = 1; i < n; i++) {
    const d = await makeNode([`127.0.0.1:${first.port}`]);
    await d.bootstrap();
    nodes.push(d);
  }
  // A second pass lets early nodes learn about later ones.
  for (const d of nodes) {
    (d as unknown as { opts: { bootstrap: string[] } }).opts.bootstrap = [`127.0.0.1:${first.port}`];
    await d.bootstrap();
  }
  return nodes;
}

describe('routing table', () => {
  it('computes XOR distance and id conversions', () => {
    const a = Buffer.alloc(20, 0);
    const b = Buffer.alloc(20, 0);
    b[19] = 5;
    expect(distance(a, b)).toBe(5n);
    expect(bigIntToId(idToBigInt(b)).equals(b)).toBe(true);
    const r = randomIdInRange(10n, 20n);
    expect(idToBigInt(r) >= 10n && idToBigInt(r) < 20n).toBe(true);
  });

  it('adds up to k nodes, splits the bucket holding our id, and reports full buckets', () => {
    const self = Buffer.alloc(20, 0);
    const t = new RoutingTable(self, 2);
    const id = (first: number, last = 1) => {
      const b = Buffer.alloc(20, 0);
      b[0] = first;
      b[19] = last;
      return b;
    };
    expect(t.insert({ id: id(0x80), host: '1.1.1.1', port: 1 }).status).toBe('added');
    expect(t.insert({ id: id(0x90), host: '1.1.1.2', port: 1 }).status).toBe('added');
    // third far node: bucket [0x80..] does not contain self after split, so it fills up
    expect(t.insert({ id: id(0x01), host: '1.1.1.3', port: 1 }).status).toBe('added');
    expect(t.bucketCount).toBeGreaterThan(1);
    const full = t.insert({ id: id(0xa0), host: '1.1.1.4', port: 1 });
    expect(full.status).toBe('full');
    expect(t.insert({ id: id(0x80), host: '9.9.9.9', port: 2 }).status).toBe('updated');
    expect(t.get(id(0x80))?.host).toBe('9.9.9.9');
  });

  it('replaces bad nodes and returns closest nodes', () => {
    const self = Buffer.alloc(20, 0);
    const t = new RoutingTable(self, 1);
    const far = Buffer.alloc(20, 0xff);
    const far2 = Buffer.alloc(20, 0xfe);
    t.insert({ id: far, host: '1.1.1.1', port: 1 });
    expect(t.insert({ id: far2, host: '1.1.1.2', port: 1 }).status).toBe('full');
    t.markFailed(far);
    t.markFailed(far);
    expect(t.insert({ id: far2, host: '1.1.1.2', port: 1 }).status).toBe('added');
    expect(t.closest(Buffer.alloc(20, 0xfe), 1)[0]?.id.equals(far2)).toBe(true);
    expect(t.size).toBe(1);
  });

  it('never stores our own id', () => {
    const self = randomBytes(20);
    const t = new RoutingTable(self);
    t.insert({ id: self, host: '1.1.1.1', port: 1 });
    expect(t.size).toBe(0);
  });
});

describe('KRPC', () => {
  it('answers queries, matches transactions and rejects mismatched senders', async () => {
    const a = new KrpcSocket({ timeoutMs: 200 });
    const b = new KrpcSocket({ timeoutMs: 200 });
    await a.bind(0, '127.0.0.1');
    await b.bind(0, '127.0.0.1');
    b.on('query', (q) => {
      if (q.method === 'echo') b.respond(q, { x: q.args.x as Buffer });
      else b.respondError(q, 204, 'nope');
    });
    const r = await a.query({ host: '127.0.0.1', port: b.port }, 'echo', { x: 'hi' });
    expect((r.x as Buffer).toString()).toBe('hi');
    await expect(a.query({ host: '127.0.0.1', port: b.port }, 'other', {})).rejects.toThrow('dht error 204: nope');
    await expect(a.query({ host: '127.0.0.1', port: 1 }, 'echo', {})).rejects.toThrow('timed out');
    a.close();
    b.close();
  });

  it('paces queries under the upload limit and never exceeds it', async () => {
    const a = new KrpcSocket({ timeoutMs: 2000, uploadRateLimit: 2000 });
    const b = new KrpcSocket({ timeoutMs: 2000 });
    await a.bind(0, '127.0.0.1');
    await b.bind(0, '127.0.0.1');
    let received = 0;
    b.on('query', (q) => {
      received++;
      b.respond(q, { ok: 1 });
    });
    const started = Date.now();
    // ~60-byte queries: 2000 B/s allows ~33 at once, the rest wait for budget
    const all = Array.from({ length: 60 }, () => a.query({ host: '127.0.0.1', port: b.port }, 'ping', { id: Buffer.alloc(20) }));
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toBeLessThan(60);
    expect(a.queuedQueries).toBeGreaterThan(0);
    await Promise.all(all);
    expect(received).toBe(60);
    expect(Date.now() - started).toBeGreaterThan(500);
    a.close();
    b.close();
  });

  it('ignores garbage datagrams', async () => {
    const a = new KrpcSocket();
    await a.bind(0, '127.0.0.1');
    const s = dgram.createSocket('udp4');
    await new Promise<void>((r) => s.send(Buffer.from('not bencode'), a.port, '127.0.0.1', () => r()));
    s.close();
    a.close();
  });
});

describe('DHT', () => {
  it('responds to ping and find_node over the wire', async () => {
    const node = await makeNode();
    const s = dgram.createSocket('udp4');
    await new Promise<void>((r) => s.bind(0, '127.0.0.1', () => r()));
    const ask = (msg: object) =>
      new Promise<BDict>((resolve) => {
        s.once('message', (m) => resolve(decode(m) as BDict));
        s.send(encode(msg as never), node.port, '127.0.0.1');
      });
    const myId = randomBytes(20);
    const pong = await ask({ t: 'aa', y: 'q', q: 'ping', a: { id: myId } });
    expect(((pong.r as BDict).id as Buffer).equals(node.nodeId)).toBe(true);
    const fn = await ask({ t: 'ab', y: 'q', q: 'find_node', a: { id: randomBytes(20), target: randomBytes(20) } });
    // knows about us now (we pinged)
    expect(((fn.r as BDict).nodes as Buffer).length % 26).toBe(0);
    const bad = await ask({ t: 'ac', y: 'q', q: 'announce_peer', a: { id: myId, info_hash: randomBytes(20), port: 1, token: 'x' } });
    expect(bad.y?.toString()).toBe('e');
    const unknown = await ask({ t: 'ad', y: 'q', q: 'frobnicate', a: { id: myId } });
    expect(((unknown.e as unknown[])[0])).toBe(204);
    s.close();
  });

  it('bootstraps a small network and fills routing tables', async () => {
    const nodes = await network(6);
    for (const n of nodes) expect(n.nodeCount).toBeGreaterThanOrEqual(3);
  });

  it('announces and finds peers across nodes', async () => {
    const nodes = await network(8);
    const ih = randomBytes(20);
    const announcer = nodes[3] as DHT;
    const res = await announcer.announce(ih, 51413);
    expect(res.closest.some((c) => c.token)).toBe(true);
    const seeker = nodes[7] as DHT;
    const events: number[] = [];
    seeker.on('peer', (p) => events.push(p.port));
    const found = await seeker.getPeers(ih);
    expect(found.peers).toContainEqual({ host: '127.0.0.1', port: 51413 });
    expect(events).toContain(51413);
  });

  it('supports implied_port announces', async () => {
    const nodes = await network(4);
    const ih = randomBytes(20);
    await (nodes[1] as DHT).announce(ih, 1, true);
    const found = await (nodes[2] as DHT).getPeers(ih);
    expect(found.peers).toContainEqual({ host: '127.0.0.1', port: (nodes[1] as DHT).port });
  });

  it('accepts tokens from the previous secret after rotation', async () => {
    const nodes = await network(3);
    const ih = randomBytes(20);
    const [a, b] = nodes as [DHT, DHT];
    const lookup = await a.getPeers(ih);
    const target = lookup.closest.find((c) => c.addr.port === b.port);
    expect(target?.token).toBeDefined();
    (b as unknown as { rotateSecret(): void }).rotateSecret();
    const sock = new KrpcSocket({ timeoutMs: 300 });
    await sock.bind(0, '127.0.0.1');
    const r = await sock.query(target!.addr, 'announce_peer', { id: randomBytes(20), info_hash: ih, port: 7, token: target!.token! });
    expect(r.id).toBeDefined();
    sock.close();
  });

  it('survives lookups with unreachable bootstrap nodes and rebinds', async () => {
    const d = await makeNode(['127.0.0.1:1'], { queryTimeoutMs: 100 });
    await d.bootstrap();
    expect(d.nodeCount).toBe(0);
    await d.rebind(0, '127.0.0.1');
    expect(d.listening).toBe(true);
    expect(d.port).toBeGreaterThan(0);
  });

  it('exports known nodes for persistence and learns from addNode', async () => {
    const a = await makeNode();
    const b = await makeNode();
    b.addNode({ host: '127.0.0.1', port: a.port });
    for (let i = 0; i < 20 && b.nodeCount === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(b.getNodes()).toContainEqual({ host: '127.0.0.1', port: a.port });
  });
});

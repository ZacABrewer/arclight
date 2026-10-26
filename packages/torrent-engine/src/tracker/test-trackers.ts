/**
 * Minimal in-process HTTP and UDP trackers used by the test suites (and handy for local
 * experiments). They keep an in-memory swarm per info-hash and answer with compact peers.
 */
import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { encode } from '../bencode.js';
import { encodeCompactPeers, encodeCompactPeers6, normalizeHost, type PeerAddress } from '../compact.js';
import { ACTION_ANNOUNCE, ACTION_CONNECT, ACTION_ERROR, ACTION_SCRAPE, PROTOCOL_ID } from './udp-tracker.js';

export interface SwarmPeer extends PeerAddress {
  peerId: string;
  left: number;
}

export interface AnnounceRecord {
  infoHash: string;
  peerId: string;
  event: string;
  port: number;
  left: number;
  numwant: number;
  key: string;
  trackerId?: string;
}

class Swarms {
  readonly swarms = new Map<string, Map<string, SwarmPeer>>();
  readonly completed = new Map<string, number>();

  announce(infoHash: string, peer: SwarmPeer, event: string): SwarmPeer[] {
    let swarm = this.swarms.get(infoHash);
    if (!swarm) {
      swarm = new Map();
      this.swarms.set(infoHash, swarm);
    }
    if (event === 'stopped') swarm.delete(peer.peerId);
    else swarm.set(peer.peerId, peer);
    if (event === 'completed') this.completed.set(infoHash, (this.completed.get(infoHash) ?? 0) + 1);
    return [...swarm.values()].filter((p) => p.peerId !== peer.peerId);
  }

  counts(infoHash: string): { complete: number; incomplete: number; downloaded: number } {
    const peers = [...(this.swarms.get(infoHash)?.values() ?? [])];
    return {
      complete: peers.filter((p) => p.left === 0).length,
      incomplete: peers.filter((p) => p.left > 0).length,
      downloaded: this.completed.get(infoHash) ?? 0,
    };
  }
}

/** Parses a query string keeping raw bytes (URLSearchParams would UTF-8-decode binary). */
export function parseRawQuery(query: string): Map<string, Buffer[]> {
  const out = new Map<string, Buffer[]>();
  for (const part of query.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = eq < 0 ? part : part.slice(0, eq);
    const v = eq < 0 ? '' : part.slice(eq + 1);
    const bytes: number[] = [];
    for (let i = 0; i < v.length; i++) {
      const c = v[i] as string;
      if (c === '%' && i + 2 < v.length + 0 && /^[0-9a-fA-F]{2}$/.test(v.slice(i + 1, i + 3))) {
        bytes.push(parseInt(v.slice(i + 1, i + 3), 16));
        i += 2;
      } else if (c === '+') bytes.push(0x20);
      else bytes.push(c.charCodeAt(0));
    }
    const list = out.get(k) ?? [];
    list.push(Buffer.from(bytes));
    out.set(k, list);
  }
  return out;
}

export interface TestHttpTracker {
  url: string;
  port: number;
  announces: AnnounceRecord[];
  swarms: Swarms;
  /** When set, every announce answers with this failure reason. */
  failureReason: string | null;
  interval: number;
  close(): Promise<void>;
}

/** Starts an HTTP tracker on 127.0.0.1 (random port unless given). */
export async function startHttpTracker(opts: { port?: number; interval?: number; trackerId?: string; host?: string } = {}): Promise<TestHttpTracker> {
  const swarms = new Swarms();
  const announces: AnnounceRecord[] = [];
  const state = { failureReason: null as string | null, interval: opts.interval ?? 60 };
  const server = http.createServer((req, res) => {
    const [path = '', query = ''] = (req.url ?? '').split('?');
    const q = parseRawQuery(query);
    const one = (k: string): Buffer | undefined => q.get(k)?.[0];
    const send = (body: Buffer): void => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(body);
    };
    if (path.endsWith('/scrape')) {
      const files: Record<string, ReturnType<Swarms['counts']>> = {};
      for (const ih of q.get('info_hash') ?? []) files[ih.toString('latin1')] = swarms.counts(ih.toString('hex'));
      send(encode({ files }));
      return;
    }
    if (state.failureReason !== null) {
      send(encode({ 'failure reason': state.failureReason }));
      return;
    }
    const infoHash = one('info_hash');
    const peerId = one('peer_id');
    const port = Number(one('port')?.toString() ?? '0');
    if (!infoHash || infoHash.length !== 20 || !peerId || !port) {
      send(encode({ 'failure reason': 'missing parameters' }));
      return;
    }
    const event = one('event')?.toString() ?? '';
    const left = Number(one('left')?.toString() ?? '0');
    const host = normalizeHost(req.socket.remoteAddress ?? '127.0.0.1');
    const record: AnnounceRecord = {
      infoHash: infoHash.toString('hex'),
      peerId: peerId.toString('hex'),
      event,
      port,
      left,
      numwant: Number(one('numwant')?.toString() ?? '50'),
      key: one('key')?.toString() ?? '',
    };
    const tid = one('trackerid');
    if (tid) record.trackerId = tid.toString();
    announces.push(record);
    const others = swarms.announce(record.infoHash, { host, port, peerId: record.peerId, left }, event);
    const counts = swarms.counts(record.infoHash);
    const body: Record<string, number | string | Buffer> = {
      interval: state.interval,
      'min interval': Math.min(state.interval, 1),
      complete: counts.complete,
      incomplete: counts.incomplete,
      peers: encodeCompactPeers(others.slice(0, record.numwant)),
    };
    const v6 = encodeCompactPeers6(others.slice(0, record.numwant));
    if (v6.length > 0) body.peers6 = v6;
    if (opts.trackerId) body['tracker id'] = opts.trackerId;
    send(encode(body));
  });
  const bindHost = opts.host ?? '127.0.0.1';
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, bindHost, resolve));
  const port = (server.address() as AddressInfo).port;
  const tracker: TestHttpTracker = {
    url: `http://${bindHost.includes(':') ? `[${bindHost}]` : bindHost}:${port}/announce`,
    port,
    announces,
    swarms,
    get failureReason() {
      return state.failureReason;
    },
    set failureReason(v) {
      state.failureReason = v;
    },
    get interval() {
      return state.interval;
    },
    set interval(v) {
      state.interval = v;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  return tracker;
}

export interface TestUdpTracker {
  url: string;
  port: number;
  announces: AnnounceRecord[];
  /** Number of incoming packets to drop (to exercise retransmission). */
  dropNext: number;
  failureReason: string | null;
  close(): Promise<void>;
}

const UDP_EVENTS = ['', 'completed', 'started', 'stopped'];

/** Starts a BEP 15 UDP tracker on 127.0.0.1. */
export async function startUdpTracker(opts: { interval?: number } = {}): Promise<TestUdpTracker> {
  const swarms = new Swarms();
  const announces: AnnounceRecord[] = [];
  const connections = new Set<string>();
  const sock = dgram.createSocket('udp4');
  const state = { dropNext: 0, failureReason: null as string | null };
  sock.on('message', (msg, rinfo) => {
    if (state.dropNext > 0) {
      state.dropNext--;
      return;
    }
    if (msg.length < 16) return;
    const action = msg.readUInt32BE(8);
    const tx = msg.subarray(12, 16);
    const reply = (b: Buffer): void => {
      sock.send(b, rinfo.port, rinfo.address);
    };
    if (action === ACTION_CONNECT) {
      if (msg.readBigUInt64BE(0) !== PROTOCOL_ID) return;
      const cid = randomBytes(8);
      connections.add(cid.toString('hex'));
      const b = Buffer.alloc(16);
      b.writeUInt32BE(ACTION_CONNECT, 0);
      tx.copy(b, 4);
      cid.copy(b, 8);
      reply(b);
      return;
    }
    const cid = msg.subarray(0, 8).toString('hex');
    if (!connections.has(cid)) return;
    if (state.failureReason !== null) {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(ACTION_ERROR, 0);
      tx.copy(head, 4);
      reply(Buffer.concat([head, Buffer.from(state.failureReason)]));
      return;
    }
    if (action === ACTION_ANNOUNCE && msg.length >= 98) {
      const record: AnnounceRecord = {
        infoHash: msg.subarray(16, 36).toString('hex'),
        peerId: msg.subarray(36, 56).toString('hex'),
        left: Number(msg.readBigUInt64BE(64)),
        event: UDP_EVENTS[msg.readUInt32BE(80)] ?? '',
        key: msg.readUInt32BE(88).toString(16),
        numwant: msg.readInt32BE(92),
        port: msg.readUInt16BE(96),
      };
      announces.push(record);
      const others = swarms.announce(
        record.infoHash,
        { host: rinfo.address, port: record.port, peerId: record.peerId, left: record.left },
        record.event,
      );
      const counts = swarms.counts(record.infoHash);
      const head = Buffer.alloc(20);
      head.writeUInt32BE(ACTION_ANNOUNCE, 0);
      tx.copy(head, 4);
      head.writeUInt32BE(opts.interval ?? 60, 8);
      head.writeUInt32BE(counts.incomplete, 12);
      head.writeUInt32BE(counts.complete, 16);
      const n = record.numwant < 0 ? 50 : record.numwant;
      reply(Buffer.concat([head, encodeCompactPeers(others.slice(0, n))]));
    } else if (action === ACTION_SCRAPE) {
      const parts = [Buffer.alloc(8)];
      parts[0]?.writeUInt32BE(ACTION_SCRAPE, 0);
      tx.copy(parts[0] as Buffer, 4);
      for (let off = 16; off + 20 <= msg.length; off += 20) {
        const c = swarms.counts(msg.subarray(off, off + 20).toString('hex'));
        const b = Buffer.alloc(12);
        b.writeUInt32BE(c.complete, 0);
        b.writeUInt32BE(c.downloaded, 4);
        b.writeUInt32BE(c.incomplete, 8);
        parts.push(b);
      }
      reply(Buffer.concat(parts));
    }
  });
  await new Promise<void>((resolve) => sock.bind(0, '127.0.0.1', resolve));
  const port = sock.address().port;
  return {
    url: `udp://127.0.0.1:${port}`,
    port,
    announces,
    get dropNext() {
      return state.dropNext;
    },
    set dropNext(v) {
      state.dropNext = v;
    },
    get failureReason() {
      return state.failureReason;
    },
    set failureReason(v) {
      state.failureReason = v;
    },
    close: () => new Promise<void>((resolve) => sock.close(() => resolve())),
  };
}

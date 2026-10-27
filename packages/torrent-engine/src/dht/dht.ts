import { createHash, randomBytes } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import type dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { isIPv4, isIPv6 } from 'node:net';
import { type BDict, type BEncodable, getBytes, getInt, getList } from '../bencode.js';
import {
  addressKey,
  decodeCompactNodes,
  decodeCompactNodes6,
  decodeCompactPeers,
  decodeCompactPeers6,
  encodeCompactNodes,
  encodeCompactNodes6,
  encodeCompactPeer,
  type CompactNode,
  type PeerAddress,
} from '../compact.js';
import { errorMessage } from '../errors.js';
import { KrpcSocket, type KrpcQuery } from './krpc.js';
import { distance, randomNodeId, RoutingTable } from './routing-table.js';

export const DEFAULT_BOOTSTRAP_NODES = [
  'router.bittorrent.com:6881',
  'dht.transmissionbt.com:6881',
  'router.utorrent.com:6881',
];

export interface DhtOptions {
  nodeId?: Buffer;
  /** `host:port` bootstrap endpoints (defaults to the public routers). */
  bootstrap?: string[];
  /** Previously known nodes (e.g. from `getNodes()` persisted at shutdown). */
  nodes?: PeerAddress[];
  k?: number;
  alpha?: number;
  queryTimeoutMs?: number;
  /** Bucket refresh period (BEP 5: 15 minutes). */
  refreshIntervalMs?: number;
  /** How long announced peers are kept (default 30 minutes). */
  peerTtlMs?: number;
  /** Token secret rotation period (default 5 minutes). */
  tokenRotationMs?: number;
  socketFactory?: () => dgram.Socket;
  /** Outgoing DHT bytes per second (0 = unlimited); see KrpcOptions.uploadRateLimit. */
  uploadRateLimit?: number;
  /** 4 (BEP 5) or 6 (BEP 32: `nodes6`, 18-byte peers). One routing table per family. */
  family?: 4 | 6;
  now?: () => number;
}

export interface DhtEvents {
  /** A peer found for an info-hash during a lookup. */
  peer: [peer: PeerAddress, infoHash: Buffer];
  /** A peer announced itself to us. */
  announce: [peer: PeerAddress, infoHash: Buffer];
  ready: [];
  warning: [message: string];
}

interface Candidate {
  key: string;
  id: Buffer | null;
  addr: PeerAddress;
  dist: bigint;
  queried: boolean;
  responded: boolean;
  failed: boolean;
  token?: Buffer;
}

export interface LookupResult {
  peers: PeerAddress[];
  /** Closest responding nodes, with the token they handed out (get_peers only). */
  closest: { id: Buffer; addr: PeerAddress; token?: Buffer }[];
}

const MAX_DIST = 1n << 161n;
/** Info-hashes whose announced peers are kept (each up to 1000 peers). */
const MAX_STORED_INFOHASHES = 5000;

/** Kademlia DHT node (BEP 5 over IPv4, BEP 32 over IPv6). */
export class DHT extends EventEmitter<DhtEvents> {
  readonly nodeId: Buffer;
  readonly table: RoutingTable;
  readonly family: 4 | 6;
  private readonly rpc: KrpcSocket;
  private readonly k: number;
  private readonly alpha: number;
  private readonly now: () => number;
  private readonly peerStore = new Map<string, Map<string, { addr: PeerAddress; expires: number }>>();
  private secrets: [Buffer, Buffer] = [randomBytes(16), randomBytes(16)];
  private timers: NodeJS.Timeout[] = [];
  private destroyed = false;
  private bindArgs: { port: number; address: string | undefined } = { port: 0, address: undefined };

  constructor(private readonly opts: DhtOptions = {}) {
    super();
    this.nodeId = opts.nodeId ?? randomNodeId();
    this.family = opts.family ?? 4;
    this.k = opts.k ?? 8;
    this.alpha = opts.alpha ?? 3;
    this.now = opts.now ?? Date.now;
    this.table = new RoutingTable(this.nodeId, this.k, this.now);
    const rpcOpts: ConstructorParameters<typeof KrpcSocket>[0] = {
      timeoutMs: opts.queryTimeoutMs ?? 2000,
      version: Buffer.from('MT01', 'latin1'),
    };
    if (opts.socketFactory) rpcOpts.socketFactory = opts.socketFactory;
    if (opts.uploadRateLimit !== undefined) rpcOpts.uploadRateLimit = opts.uploadRateLimit;
    rpcOpts.family = this.family;
    this.rpc = new KrpcSocket(rpcOpts);
    this.rpc.on('query', (q) => this.onQuery(q));
    this.rpc.on('response', (r, from) => this.learn(r, from));
    this.rpc.on('warning', (m) => this.emit('warning', m));
  }

  get port(): number {
    return this.rpc.port;
  }

  get nodeCount(): number {
    return this.table.size;
  }

  get listening(): boolean {
    return this.rpc.bound;
  }

  /** The UDP socket, shared with uTP by the session. */
  get udpSocket(): dgram.Socket | null {
    return this.rpc.socket;
  }

  private ownFamily(host: string): boolean {
    return this.family === 6 ? isIPv6(host) : isIPv4(host);
  }

  private nodesKey(): 'nodes' | 'nodes6' {
    return this.family === 6 ? 'nodes6' : 'nodes';
  }

  /** Binds the UDP socket and starts maintenance timers. */
  async listen(port = 0, address?: string): Promise<void> {
    this.bindArgs = { port, address };
    await this.rpc.bind(port, address);
    if (this.timers.length === 0) {
      const t1 = setInterval(() => this.rotateSecret(), this.opts.tokenRotationMs ?? 5 * 60_000);
      const refreshMs = this.opts.refreshIntervalMs ?? 15 * 60_000;
      const t2 = setInterval(() => void this.refresh(refreshMs), Math.max(1000, Math.floor(refreshMs / 3)));
      const t3 = setInterval(() => this.expirePeers(), 60_000);
      for (const t of [t1, t2, t3]) t.unref();
      this.timers.push(t1, t2, t3);
    }
  }

  /** Closes and re-binds the socket (e.g. after the VPN interface changed); keeps the table. */
  async rebind(port: number, address?: string): Promise<void> {
    this.rpc.close();
    await this.rpc.bind(port, address);
    this.bindArgs = { port, address };
  }

  get boundAddress(): { port: number; address: string | undefined } {
    return this.bindArgs;
  }

  close(): void {
    this.destroyed = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.rpc.close();
  }

  /** Returns the known good nodes, for persisting between runs. */
  getNodes(): PeerAddress[] {
    return this.table.all().filter((n) => n.failures === 0).map((n) => ({ host: n.host, port: n.port }));
  }

  /** Adds a node learned out of band (e.g. a peer's PORT message) by pinging it. */
  addNode(addr: PeerAddress): void {
    void this.ping(addr).catch(() => {});
  }

  /** Joins the network: find_node(self) via the bootstrap endpoints and saved nodes. */
  async bootstrap(): Promise<void> {
    const seeds: PeerAddress[] = [...(this.opts.nodes ?? [])];
    for (const entry of this.opts.bootstrap ?? DEFAULT_BOOTSTRAP_NODES) {
      const idx = entry.lastIndexOf(':');
      if (idx <= 0) continue;
      const host = entry.slice(0, idx);
      const port = Number(entry.slice(idx + 1));
      if (!port) continue;
      try {
        const literal = host.replace(/^\[|\]$/g, '');
        const ip = isIPv4(literal) || isIPv6(literal) ? literal : (await dnsLookup(host, { family: this.family })).address;
        if (!this.ownFamily(ip)) continue;
        seeds.push({ host: ip, port });
      } catch (err) {
        this.emit('warning', `cannot resolve bootstrap node ${host}: ${errorMessage(err)}`);
      }
    }
    await this.iterate(this.nodeId, 'find_node', seeds);
    this.emit('ready');
  }

  async ping(addr: PeerAddress): Promise<Buffer> {
    const r = await this.rpc.query(addr, 'ping', { id: this.nodeId });
    const id = getBytes(r, 'id');
    if (!id || id.length !== 20) throw new Error('ping response without id');
    return id;
  }

  /** Iterative get_peers lookup. Peers are also emitted as `peer` events as they arrive. */
  async getPeers(infoHash: Buffer): Promise<LookupResult> {
    return this.iterate(infoHash, 'get_peers', []);
  }

  /** Looks up the closest nodes to `infoHash` and announces our `port` to them. */
  async announce(infoHash: Buffer, port: number, impliedPort = false): Promise<LookupResult> {
    const res = await this.getPeers(infoHash);
    await Promise.allSettled(
      res.closest
        .filter((c) => c.token)
        .map((c) =>
          this.rpc.query(c.addr, 'announce_peer', {
            id: this.nodeId,
            info_hash: infoHash,
            port,
            token: c.token as Buffer,
            implied_port: impliedPort ? 1 : 0,
          }),
        ),
    );
    return res;
  }

  async findNode(target: Buffer): Promise<LookupResult> {
    return this.iterate(target, 'find_node', []);
  }

  // ---- server side ----------------------------------------------------------------------

  private token(host: string, secret: Buffer): Buffer {
    return createHash('sha1').update(secret).update(host).digest().subarray(0, 8);
  }

  private rotateSecret(): void {
    this.secrets = [randomBytes(16), this.secrets[0]];
  }

  private validToken(host: string, token: Buffer | undefined): boolean {
    if (!token) return false;
    return this.secrets.some((s) => this.token(host, s).equals(token));
  }

  private compactClosest(target: Buffer): Buffer {
    const nodes = this.table.closest(target, this.k);
    return this.family === 6 ? encodeCompactNodes6(nodes) : encodeCompactNodes(nodes);
  }

  private onQuery(q: KrpcQuery): void {
    const id = getBytes(q.args, 'id');
    if (!id || id.length !== 20) {
      this.rpc.respondError(q, 203, 'missing id');
      return;
    }
    this.considerNode({ id, ...q.from });
    switch (q.method) {
      case 'ping':
        this.rpc.respond(q, { id: this.nodeId });
        return;
      case 'find_node': {
        const target = getBytes(q.args, 'target');
        if (!target || target.length !== 20) return this.rpc.respondError(q, 203, 'bad target');
        this.rpc.respond(q, { id: this.nodeId, [this.nodesKey()]: this.compactClosest(target) });
        return;
      }
      case 'get_peers': {
        const ih = getBytes(q.args, 'info_hash');
        if (!ih || ih.length !== 20) return this.rpc.respondError(q, 203, 'bad info_hash');
        const r: Record<string, BEncodable> = { id: this.nodeId, token: this.token(q.from.host, this.secrets[0]) };
        const stored = this.storedPeers(ih);
        if (stored.length > 0) r.values = stored.map(encodeCompactPeer);
        else r[this.nodesKey()] = this.compactClosest(ih);
        this.rpc.respond(q, r);
        return;
      }
      case 'announce_peer': {
        const ih = getBytes(q.args, 'info_hash');
        if (!ih || ih.length !== 20) return this.rpc.respondError(q, 203, 'bad info_hash');
        if (!this.validToken(q.from.host, getBytes(q.args, 'token'))) return this.rpc.respondError(q, 203, 'bad token');
        const implied = getInt(q.args, 'implied_port') === 1;
        const port = implied ? q.from.port : (getInt(q.args, 'port') ?? 0);
        if (port <= 0 || port > 65535) return this.rpc.respondError(q, 203, 'bad port');
        this.storePeer(ih, { host: q.from.host, port });
        this.rpc.respond(q, { id: this.nodeId });
        return;
      }
      default:
        this.rpc.respondError(q, 204, 'method unknown');
    }
  }

  private storePeer(infoHash: Buffer, addr: PeerAddress): void {
    const key = infoHash.toString('hex');
    let m = this.peerStore.get(key);
    if (!m) {
      // Bounded overall too: other nodes announce to us for any info-hash near our id.
      if (this.peerStore.size >= MAX_STORED_INFOHASHES) {
        const oldest = this.peerStore.keys().next().value;
        if (oldest !== undefined) this.peerStore.delete(oldest);
      }
      m = new Map();
      this.peerStore.set(key, m);
    }
    m.set(addressKey(addr), { addr, expires: this.now() + (this.opts.peerTtlMs ?? 30 * 60_000) });
    if (m.size > 1000) {
      const first = m.keys().next().value;
      if (first !== undefined) m.delete(first);
    }
    this.emit('announce', addr, infoHash);
  }

  private storedPeers(infoHash: Buffer): PeerAddress[] {
    const m = this.peerStore.get(infoHash.toString('hex'));
    if (!m) return [];
    const now = this.now();
    const live = [...m.values()].filter((p) => p.expires > now).map((p) => p.addr);
    // up to 50 random entries
    for (let i = live.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [live[i], live[j]] = [live[j] as PeerAddress, live[i] as PeerAddress];
    }
    return live.slice(0, 50);
  }

  private expirePeers(): void {
    const now = this.now();
    for (const [k, m] of this.peerStore) {
      for (const [a, p] of m) if (p.expires <= now) m.delete(a);
      if (m.size === 0) this.peerStore.delete(k);
    }
  }

  // ---- routing table maintenance ----------------------------------------------------------

  private learn(r: BDict, from: PeerAddress): void {
    const id = getBytes(r, 'id');
    if (id && id.length === 20) this.considerNode({ id, ...from });
  }

  private considerNode(node: CompactNode): void {
    if (this.destroyed || node.id.equals(this.nodeId) || !this.ownFamily(node.host)) return;
    const res = this.table.insert(node);
    if (res.status === 'full') {
      const oldest = res.oldest;
      // Questionable after 15 minutes of silence: ping, replace on failure.
      if (this.now() - oldest.lastSeen < 15 * 60_000) return;
      this.ping({ host: oldest.host, port: oldest.port }).then(
        () => this.table.insert(oldest),
        () => {
          this.table.remove(oldest.id);
          this.table.insert(node);
        },
      );
    }
  }

  private async refresh(maxAgeMs: number): Promise<void> {
    if (this.destroyed || !this.rpc.bound) return;
    for (const target of this.table.staleBucketTargets(maxAgeMs)) {
      this.table.touchBucket(target);
      await this.iterate(target, 'find_node', []).catch(() => {});
    }
  }

  // ---- iterative lookup -------------------------------------------------------------------

  private iterate(target: Buffer, method: 'find_node' | 'get_peers', seeds: PeerAddress[]): Promise<LookupResult> {
    const candidates = new Map<string, Candidate>();
    const peers = new Map<string, PeerAddress>();
    const add = (id: Buffer | null, addr: PeerAddress): void => {
      if (!this.ownFamily(addr.host) || addr.port <= 0) return;
      if (id && id.equals(this.nodeId)) return;
      const key = addressKey(addr);
      const existing = candidates.get(key);
      if (existing) {
        if (!existing.id && id) {
          existing.id = id;
          existing.dist = distance(id, target);
        }
        return;
      }
      candidates.set(key, {
        key,
        id,
        addr,
        dist: id ? distance(id, target) : MAX_DIST,
        queried: false,
        responded: false,
        failed: false,
      });
    };
    for (const n of this.table.closest(target, this.k * 2)) add(n.id, { host: n.host, port: n.port });
    for (const s of seeds) add(null, s);

    return new Promise((resolve) => {
      let inflight = 0;
      let finished = false;
      const sorted = (): Candidate[] =>
        [...candidates.values()].filter((c) => !c.failed).sort((a, b) => (a.dist < b.dist ? -1 : a.dist > b.dist ? 1 : 0));
      const finish = (): void => {
        if (finished) return;
        finished = true;
        const closest = sorted()
          .filter((c) => c.responded && c.id)
          .slice(0, this.k)
          .map((c) => {
            const out: LookupResult['closest'][number] = { id: c.id as Buffer, addr: c.addr };
            if (c.token) out.token = c.token;
            return out;
          });
        resolve({ peers: [...peers.values()], closest });
      };
      const step = (): void => {
        if (finished) return;
        if (this.destroyed) return finish();
        // Only the k closest live candidates matter; stop once they have all answered or failed.
        const top = sorted().slice(0, this.k);
        for (const c of top) {
          if (inflight >= this.alpha) break;
          if (c.queried) continue;
          c.queried = true;
          inflight++;
          const args: Record<string, BEncodable> =
            method === 'get_peers' ? { id: this.nodeId, info_hash: target } : { id: this.nodeId, target };
          this.rpc
            .query(c.addr, method, args)
            .then((r) => {
              c.responded = true;
              const rid = getBytes(r, 'id');
              if (rid && rid.length === 20) {
                c.id = rid;
                c.dist = distance(rid, target);
              }
              const tok = getBytes(r, 'token');
              if (tok) c.token = tok;
              const nodes = getBytes(r, 'nodes');
              if (nodes) for (const n of decodeCompactNodes(nodes)) add(n.id, { host: n.host, port: n.port });
              const nodes6 = getBytes(r, 'nodes6');
              if (nodes6) for (const n of decodeCompactNodes6(nodes6)) add(n.id, { host: n.host, port: n.port });
              for (const v of [...(getList(r, 'values') ?? []), ...(getList(r, 'values6') ?? [])]) {
                if (!Buffer.isBuffer(v)) continue;
                for (const p of v.length === 18 ? decodeCompactPeers6(v) : decodeCompactPeers(v)) {
                  const key = addressKey(p);
                  if (!peers.has(key)) {
                    peers.set(key, p);
                    this.emit('peer', p, target);
                  }
                }
              }
            })
            .catch(() => {
              c.failed = true;
              if (c.id) this.table.markFailed(c.id);
            })
            .finally(() => {
              inflight--;
              step();
            });
        }
        if (inflight === 0) finish();
      };
      step();
    });
  }
}

import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { type BDict, type BEncodable, decode, encode, getBytes, getList, getString, isDict } from '../bencode.js';
import { normalizeHost, type PeerAddress } from '../compact.js';
import { TorrentEngineError } from '../errors.js';

export interface KrpcQuery {
  t: Buffer;
  method: string;
  args: BDict;
  from: PeerAddress;
}

export interface KrpcEvents {
  query: [query: KrpcQuery];
  /** Any valid response from a remote node (used to learn about live nodes). */
  response: [r: BDict, from: PeerAddress];
  warning: [message: string];
}

interface Pending {
  host: string;
  port: number;
  resolve: (r: BDict) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface KrpcOptions {
  socketFactory?: () => dgram.Socket;
  timeoutMs?: number;
  /** Two-byte client version sent as `v`. */
  version?: Buffer;
  /** Address family of the default socket (6 binds an IPv6-only socket). */
  family?: 4 | 6;
}

/** KRPC (BEP 5) transport: bencoded queries/responses over a UDP socket. */
export class KrpcSocket extends EventEmitter<KrpcEvents> {
  private sock: dgram.Socket | null = null;
  private readonly pending = new Map<string, Pending>();
  private nextTx = Math.floor(Math.random() * 0xffff);
  private readonly timeoutMs: number;

  constructor(private readonly opts: KrpcOptions = {}) {
    super();
    this.timeoutMs = opts.timeoutMs ?? 2000;
  }

  get port(): number {
    return this.sock?.address().port ?? 0;
  }

  get address(): string {
    return this.sock?.address().address ?? '';
  }

  get bound(): boolean {
    return this.sock !== null;
  }

  /** The bound UDP socket (shared with uTP), or null. */
  get socket(): dgram.Socket | null {
    return this.sock;
  }

  async bind(port: number, address?: string): Promise<void> {
    if (this.sock) throw new TorrentEngineError('dht', 'socket already bound');
    const sock = this.opts.socketFactory ? this.opts.socketFactory() : this.opts.family === 6
        ? dgram.createSocket({ type: 'udp6', ipv6Only: true, reuseAddr: false })
        : dgram.createSocket({ type: 'udp4', reuseAddr: false });
    try {
      await new Promise<void>((resolve, reject) => {
        sock.once('error', reject);
        sock.bind({ port, ...(address ? { address } : {}) }, () => {
          sock.off('error', reject);
          resolve();
        });
      });
    } catch (err) {
      sock.close();
      throw err;
    }
    sock.on('message', (msg, rinfo) => {
      // uTP shares this socket; KRPC messages are bencoded dictionaries
      if (msg[0] !== 0x64) return;
      this.onMessage(msg, { host: normalizeHost(rinfo.address), port: rinfo.port });
    });
    sock.on('error', (err) => this.emit('warning', `dht socket error: ${err.message}`));
    this.sock = sock;
  }

  close(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new TorrentEngineError('aborted', 'dht socket closed'));
    }
    this.pending.clear();
    this.sock?.close();
    this.sock = null;
  }

  private send(msg: Record<string, BEncodable>, to: PeerAddress): void {
    if (!this.sock) return;
    if (this.opts.version) msg.v = this.opts.version;
    try {
      this.sock.send(encode(msg), to.port, to.host);
    } catch (err) {
      this.emit('warning', `dht send failed: ${(err as Error).message}`);
    }
  }

  query(to: PeerAddress, method: string, args: Record<string, BEncodable>): Promise<BDict> {
    if (!this.sock) return Promise.reject(new TorrentEngineError('dht', 'dht socket not bound'));
    this.nextTx = (this.nextTx + 1) & 0xffff;
    const t = Buffer.alloc(2);
    t.writeUInt16BE(this.nextTx);
    const key = t.toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new TorrentEngineError('timeout', `dht ${method} to ${to.host}:${to.port} timed out`));
      }, this.timeoutMs);
      this.pending.get(key)?.reject(new TorrentEngineError('dht', 'transaction id reused'));
      this.pending.set(key, { host: to.host, port: to.port, resolve, reject, timer });
      this.send({ t, y: 'q', q: method, a: args }, to);
    });
  }

  respond(q: KrpcQuery, r: Record<string, BEncodable>): void {
    this.send({ t: q.t, y: 'r', r }, q.from);
  }

  respondError(q: KrpcQuery, code: number, message: string): void {
    this.send({ t: q.t, y: 'e', e: [code, message] }, q.from);
  }

  private onMessage(buf: Buffer, from: PeerAddress): void {
    let msg: BDict;
    try {
      const v = decode(buf);
      if (!isDict(v)) return;
      msg = v;
    } catch {
      return;
    }
    const t = getBytes(msg, 't');
    const y = getString(msg, 'y');
    if (!t) return;
    if (y === 'q') {
      const method = getString(msg, 'q');
      const args = msg.a;
      if (!method || !isDict(args)) return;
      this.emit('query', { t, method, args, from });
      return;
    }
    const key = t.toString('hex');
    const p = this.pending.get(key);
    if (!p || p.host !== from.host || p.port !== from.port) return;
    this.pending.delete(key);
    clearTimeout(p.timer);
    if (y === 'r' && isDict(msg.r)) {
      this.emit('response', msg.r, from);
      p.resolve(msg.r);
    } else if (y === 'e') {
      const e = getList(msg, 'e') ?? [];
      const text = Buffer.isBuffer(e[1]) ? e[1].toString() : 'unknown error';
      p.reject(new TorrentEngineError('dht', `dht error ${String(e[0])}: ${text}`));
    } else p.reject(new TorrentEngineError('dht', 'malformed dht response'));
  }
}

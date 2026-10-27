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
  /**
   * Outgoing bytes per second (0 = unlimited). Over the budget, queries wait in a short queue
   * (they time out from when they are sent) and replies to other nodes are dropped, as
   * libtorrent does with its DHT upload limit: an unpaced DHT is a steady stream of tiny UDP
   * packets to thousands of addresses, which a VPN tunnel handles badly.
   */
  uploadRateLimit?: number;
}

/** Queries waiting for upload budget beyond this many are refused right away. */
const MAX_SEND_QUEUE = 256;

/** KRPC (BEP 5) transport: bencoded queries/responses over a UDP socket. */
export class KrpcSocket extends EventEmitter<KrpcEvents> {
  private sock: dgram.Socket | null = null;
  private readonly pending = new Map<string, Pending>();
  private nextTx = Math.floor(Math.random() * 0xffff);
  private readonly timeoutMs: number;
  private tokens: number;
  private refilledAt = Date.now();
  private readonly sendQueue: Array<{ size: number; go: () => void }> = [];
  private drainTimer: NodeJS.Timeout | undefined;
  /** Replies dropped for lack of upload budget (diagnostics). */
  droppedReplies = 0;

  constructor(private readonly opts: KrpcOptions = {}) {
    super();
    this.timeoutMs = opts.timeoutMs ?? 2000;
    this.tokens = opts.uploadRateLimit ?? 0;
  }

  /** Takes `size` bytes of upload budget; false when over the limit right now. */
  private take(size: number): boolean {
    const rate = this.opts.uploadRateLimit ?? 0;
    if (rate <= 0) return true;
    const now = Date.now();
    this.tokens = Math.min(rate, this.tokens + ((now - this.refilledAt) / 1000) * rate);
    this.refilledAt = now;
    if (this.tokens < size) return false;
    this.tokens -= size;
    return true;
  }

  private scheduleDrain(): void {
    if (this.drainTimer || this.sendQueue.length === 0) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      while (this.sendQueue.length > 0 && this.take((this.sendQueue[0] as { size: number }).size)) this.sendQueue.shift()?.go();
      this.scheduleDrain();
    }, 50);
    this.drainTimer.unref?.();
  }

  get queuedQueries(): number {
    return this.sendQueue.length;
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
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = undefined;
    // queued queries reject (no socket) instead of hanging
    for (const q of this.sendQueue.splice(0)) q.go();
  }

  private encodeMsg(msg: Record<string, BEncodable>): Buffer {
    if (this.opts.version) msg.v = this.opts.version;
    return encode(msg);
  }

  private sendRaw(buf: Buffer, to: PeerAddress): void {
    if (!this.sock) return;
    try {
      this.sock.send(buf, to.port, to.host);
    } catch (err) {
      this.emit('warning', `dht send failed: ${(err as Error).message}`);
    }
  }

  /** Replies: sent within the budget, dropped over it (the asking node simply retries). */
  private send(msg: Record<string, BEncodable>, to: PeerAddress): void {
    const buf = this.encodeMsg(msg);
    if (!this.take(buf.length)) {
      this.droppedReplies++;
      return;
    }
    this.sendRaw(buf, to);
  }

  query(to: PeerAddress, method: string, args: Record<string, BEncodable>): Promise<BDict> {
    if (!this.sock) return Promise.reject(new TorrentEngineError('dht', 'dht socket not bound'));
    this.nextTx = (this.nextTx + 1) & 0xffff;
    const t = Buffer.alloc(2);
    t.writeUInt16BE(this.nextTx);
    const key = t.toString('hex');
    const buf = this.encodeMsg({ t, y: 'q', q: method, a: args });
    return new Promise((resolve, reject) => {
      const go = (): void => {
        if (!this.sock) {
          reject(new TorrentEngineError('aborted', 'dht socket closed'));
          return;
        }
        const timer = setTimeout(() => {
          this.pending.delete(key);
          reject(new TorrentEngineError('timeout', `dht ${method} to ${to.host}:${to.port} timed out`));
        }, this.timeoutMs);
        this.pending.get(key)?.reject(new TorrentEngineError('dht', 'transaction id reused'));
        this.pending.set(key, { host: to.host, port: to.port, resolve, reject, timer });
        this.sendRaw(buf, to);
      };
      if (this.sendQueue.length === 0 && this.take(buf.length)) {
        go();
        return;
      }
      if (this.sendQueue.length >= MAX_SEND_QUEUE) {
        reject(new TorrentEngineError('timeout', `dht ${method} to ${to.host}:${to.port} dropped (upload limit)`));
        return;
      }
      this.sendQueue.push({ size: buf.length, go });
      this.scheduleDrain();
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

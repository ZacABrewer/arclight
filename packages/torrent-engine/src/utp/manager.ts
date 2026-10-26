import { randomInt } from 'node:crypto';
import type dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { isIPv6 } from 'node:net';
import { addressKey, normalizeHost, type PeerAddress } from '../compact.js';
import { TorrentEngineError } from '../errors.js';
import { decodePacket, encodePacket, looksLikeUtp, ST_RESET, ST_SYN, type UtpPacket } from './packet.js';
import { UtpSocket, type UtpSocketInit, type UtpSocketOptions } from './socket.js';

export interface UtpManagerOptions extends UtpSocketOptions {
  /** Accept incoming connections (checked per SYN). Default true. */
  accept?: () => boolean;
  /** Timer granularity for retransmissions. */
  tickMs?: number;
  /** Test hook: return true to drop a datagram (`in` before decoding, `out` before sending). */
  dropPacket?: (direction: 'in' | 'out', packet: Buffer) => boolean;
}

export interface UtpManagerEvents {
  connection: [socket: UtpSocket, address: PeerAddress];
  warning: [message: string];
}

/**
 * Multiplexes uTP connections over one or more UDP sockets (one per address family). The
 * sockets may be shared with the DHT: uTP datagrams are told apart by their first byte
 * (version 1 in the low nibble) while KRPC messages start with `d`.
 */
export class UtpManager extends EventEmitter<UtpManagerEvents> {
  private readonly sockets = new Map<dgram.Socket, (msg: Buffer, rinfo: dgram.RemoteInfo) => void>();
  private readonly conns = new Map<string, UtpSocket>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly opts: UtpManagerOptions = {}) {
    super();
  }

  get attached(): boolean {
    return this.sockets.size > 0;
  }

  get connectionCount(): number {
    return this.conns.size;
  }

  /** Starts handling uTP datagrams arriving on `sock`. */
  attach(sock: dgram.Socket): void {
    if (this.sockets.has(sock)) return;
    const handler = (msg: Buffer, rinfo: dgram.RemoteInfo): void => this.onMessage(msg, rinfo);
    sock.on('message', handler);
    sock.once('close', () => this.detach(sock));
    this.sockets.set(sock, handler);
  }

  detach(sock: dgram.Socket): void {
    const h = this.sockets.get(sock);
    if (!h) return;
    sock.off('message', h);
    this.sockets.delete(sock);
  }

  /** Detaches every socket and destroys every connection. */
  close(): void {
    for (const s of [...this.sockets.keys()]) this.detach(s);
    for (const c of [...this.conns.values()]) c.destroy();
    this.conns.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private socketFor(host: string): dgram.Socket | null {
    const want = isIPv6(host) ? 'IPv6' : 'IPv4';
    for (const s of this.sockets.keys()) {
      try {
        if (s.address().family === want) return s;
      } catch {
        // not bound (closing)
      }
    }
    return null;
  }

  private send(to: PeerAddress, p: UtpPacket): void {
    const buf = encodePacket(p);
    if (this.opts.dropPacket?.('out', buf)) return;
    const sock = this.socketFor(to.host);
    if (!sock) return;
    try {
      sock.send(buf, to.port, to.host);
    } catch (err) {
      this.emit('warning', `utp send failed: ${(err as Error).message}`);
    }
  }

  private key(addr: PeerAddress, recvId: number): string {
    return `${addressKey(addr)}#${recvId}`;
  }

  private ensureTimer(): void {
    if (this.timer || this.conns.size === 0) return;
    this.timer = setInterval(() => {
      for (const c of [...this.conns.values()]) c.tick();
      if (this.conns.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    }, this.opts.tickMs ?? 50);
    this.timer.unref();
  }

  private register(addr: PeerAddress, sock: UtpSocket): void {
    this.conns.set(this.key(addr, sock.recvId), sock);
    this.ensureTimer();
  }

  private remove(addr: PeerAddress, sock: UtpSocket): void {
    const k = this.key(addr, sock.recvId);
    if (this.conns.get(k) === sock) this.conns.delete(k);
  }

  private socketInit(addr: PeerAddress): Omit<UtpSocketInit, 'recvId' | 'sendId'> {
    const opts: UtpSocketOptions = {};
    if (this.opts.minRtoMs !== undefined) opts.minRtoMs = this.opts.minRtoMs;
    if (this.opts.initialRtoMs !== undefined) opts.initialRtoMs = this.opts.initialRtoMs;
    if (this.opts.targetDelayUs !== undefined) opts.targetDelayUs = this.opts.targetDelayUs;
    if (this.opts.now) opts.now = this.opts.now;
    return { remote: addr, send: (p) => this.send(addr, p), onClose: (s) => this.remove(addr, s), opts };
  }

  /** Opens an outgoing uTP connection. */
  connect(to: PeerAddress, timeoutMs = 10_000): Promise<UtpSocket> {
    const addr = { host: normalizeHost(to.host), port: to.port };
    if (!this.socketFor(addr.host)) return Promise.reject(new TorrentEngineError('peer', `no utp socket for ${addr.host}`));
    let recvId = randomInt(0, 0x10000);
    for (let i = 0; i < 16 && (this.conns.has(this.key(addr, recvId)) || this.conns.has(this.key(addr, (recvId + 1) & 0xffff))); i++)
      recvId = randomInt(0, 0x10000);
    const sock = UtpSocket.connect({ ...this.socketInit(addr), recvId });
    this.register(addr, sock);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        sock.destroy();
        reject(new TorrentEngineError('timeout', `utp connect to ${addressKey(addr)} timed out`));
      }, timeoutMs);
      timer.unref();
      const onConnect = (): void => {
        cleanup();
        resolve(sock);
      };
      const onClose = (): void => {
        cleanup();
        reject(new TorrentEngineError('peer', `utp connect to ${addressKey(addr)} failed`));
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        sock.off('connect', onConnect);
        sock.off('close', onClose);
      };
      sock.on('error', () => {});
      sock.once('connect', onConnect);
      sock.once('close', onClose);
    });
  }

  private onMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    if (!looksLikeUtp(msg)) return;
    if (this.opts.dropPacket?.('in', msg)) return;
    const p = decodePacket(msg);
    if (!p) return;
    const addr: PeerAddress = { host: normalizeHost(rinfo.address), port: rinfo.port };
    if (p.type === ST_SYN) {
      const existing = this.conns.get(this.key(addr, (p.connectionId + 1) & 0xffff));
      if (existing) {
        existing.onPacket(p);
        return;
      }
      if (this.opts.accept && !this.opts.accept()) {
        this.reset(addr, p);
        return;
      }
      const sock = UtpSocket.accept(this.socketInit(addr), p);
      sock.on('error', () => {});
      this.register(addr, sock);
      this.emit('connection', sock, addr);
      return;
    }
    let conn = this.conns.get(this.key(addr, p.connectionId));
    if (!conn && p.type === ST_RESET) {
      // a RESET may carry either of the two connection ids
      for (const c of this.conns.values())
        if (c.remoteAddress === addr.host && c.remotePort === addr.port && c.sendId === p.connectionId) conn = c;
    }
    if (conn) conn.onPacket(p);
    else if (p.type !== ST_RESET) this.reset(addr, p);
  }

  private reset(addr: PeerAddress, p: UtpPacket): void {
    this.send(addr, {
      type: ST_RESET,
      connectionId: p.connectionId,
      timestamp: Math.floor(performance.now() * 1000) >>> 0,
      timestampDiff: 0,
      wndSize: 0,
      seq: randomInt(0, 0x10000),
      ack: p.seq,
      payload: Buffer.alloc(0),
    });
  }
}

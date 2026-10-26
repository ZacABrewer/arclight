import { EventEmitter } from 'node:events';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { normalizeHost, type PeerAddress } from '../compact.js';
import { errorMessage } from '../errors.js';
import type { PeerTransport } from './connection.js';
import { type Handshake, parseHandshake, PROTOCOL } from './messages.js';
import { type EncryptionMode, mseRespond } from './mse.js';

export interface IncomingInfo {
  transport: PeerTransport;
  /** RC4 was negotiated through MSE. */
  encrypted: boolean;
}

export interface PeerListenerEvents {
  /**
   * A peer completed the first half of the handshake. The stream is paused with the
   * handshake bytes pushed back, ready for a `PeerConnection` with `incoming: true`.
   */
  connection: [socket: Duplex, handshake: Handshake, address: PeerAddress, info: IncomingInfo];
  warning: [message: string];
}

export interface PeerListenerOptions {
  handshakeTimeoutMs?: number;
  /** Rejects connections from blocked IPs before reading anything. */
  isBlocked?: (ip: string) => boolean;
  /** Current encryption policy (read per connection). Default `disabled`. */
  encryption?: () => EncryptionMode;
  /** Maps HASH('req2', infoHash) to a known info-hash for MSE receivers. */
  findInfoHash?: (req2: Buffer) => Buffer | null;
}

const PLAIN_PREFIX = Buffer.concat([Buffer.from([PROTOCOL.length]), PROTOCOL]);

/**
 * TCP listener for incoming peers, bound to a configurable address and port. It also
 * accepts streams from other transports (uTP) through `accept`. The first bytes decide
 * between a plaintext BitTorrent handshake and an MSE key exchange.
 */
export class PeerListener extends EventEmitter<PeerListenerEvents> {
  private server: net.Server | null = null;
  private readonly pending = new Set<Duplex>();

  constructor(private readonly opts: PeerListenerOptions = {}) {
    super();
  }

  get port(): number {
    const a = this.server?.address();
    return a && typeof a === 'object' ? a.port : 0;
  }

  get address(): string | null {
    const a = this.server?.address();
    return a && typeof a === 'object' ? a.address : null;
  }

  get listening(): boolean {
    return this.server !== null;
  }

  /**
   * Binds the TCP server. Without a host it listens on `::` (dual-stack) when IPv6 is
   * available and allowed, otherwise on `0.0.0.0`.
   */
  async listen(port: number, host?: string, opts: { ipv6?: boolean } = {}): Promise<void> {
    if (this.server) await this.close();
    const hosts = host ? [host] : opts.ipv6 === false ? ['0.0.0.0'] : ['::', '0.0.0.0'];
    let lastErr: unknown;
    for (const h of hosts) {
      const server = net.createServer((sock) => this.onSocket(sock));
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen({ port, host: h, exclusive: true, ...(h === '::' ? { ipv6Only: false } : {}) }, () => {
            server.off('error', reject);
            resolve();
          });
        });
      } catch (err) {
        lastErr = err;
        server.close();
        continue;
      }
      server.on('error', (err) => this.emit('warning', `listener error: ${err.message}`));
      this.server = server;
      return;
    }
    throw lastErr;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const s of this.pending) s.destroy();
    this.pending.clear();
    // Stop accepting; established peer connections are owned by their torrents and are
    // not waited for (server.close's callback would only fire after they all end).
    if (server) {
      server.close();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  private onSocket(sock: net.Socket): void {
    const address: PeerAddress = { host: normalizeHost(sock.remoteAddress ?? ''), port: sock.remotePort ?? 0 };
    sock.on('error', () => {});
    this.accept(sock, address, 'tcp');
  }

  /** Takes an incoming stream (TCP socket or uTP connection) through protocol detection. */
  accept(sock: Duplex, address: PeerAddress, transport: PeerTransport): void {
    if (this.opts.isBlocked?.(address.host)) {
      sock.destroy();
      return;
    }
    this.pending.add(sock);
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => sock.destroy(), this.opts.handshakeTimeoutMs ?? 10_000);
    timer.unref();
    const done = (): void => {
      clearTimeout(timer);
      sock.off('data', onData);
    };
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const n = Math.min(buf.length, PLAIN_PREFIX.length);
      const plain = buf.subarray(0, n).equals(PLAIN_PREFIX.subarray(0, n));
      if (plain && n < PLAIN_PREFIX.length) return;
      const mode = this.opts.encryption?.() ?? 'disabled';
      done();
      sock.pause();
      if (plain) {
        if (mode === 'required') {
          this.drop(sock);
          return;
        }
        this.readHandshake(sock, buf, address, { transport, encrypted: false }, null);
        return;
      }
      if (mode === 'disabled' || !this.opts.findInfoHash) {
        this.drop(sock);
        return;
      }
      mseRespond(sock, buf, {
        findInfoHash: this.opts.findInfoHash,
        allowPlaintext: mode === 'preferred',
        timeoutMs: this.opts.handshakeTimeoutMs ?? 10_000,
      }).then(
        (res) => {
          if (sock.destroyed) return;
          this.pending.delete(sock);
          this.pending.add(res.stream);
          this.readHandshake(res.stream, Buffer.alloc(0), address, { transport, encrypted: res.method === 'rc4' }, res.infoHash);
        },
        (err: unknown) => {
          this.emit('warning', `incoming encrypted connection from ${address.host} failed: ${errorMessage(err)}`);
          this.drop(sock);
        },
      );
    };
    sock.on('data', onData);
    sock.once('close', () => {
      clearTimeout(timer);
      this.pending.delete(sock);
    });
  }

  private drop(sock: Duplex): void {
    this.pending.delete(sock);
    sock.destroy();
  }

  /** Reads the plaintext BitTorrent handshake, then hands the paused stream over. */
  private readHandshake(stream: Duplex, initial: Buffer, address: PeerAddress, info: IncomingInfo, expected: Buffer | null): void {
    let buf = initial;
    let finished = false;
    this.pending.add(stream);
    const timer = setTimeout(() => stream.destroy(), this.opts.handshakeTimeoutMs ?? 10_000);
    timer.unref();
    const done = (): void => {
      finished = true;
      clearTimeout(timer);
      this.pending.delete(stream);
      stream.off('data', onData);
    };
    const check = (): void => {
      let hs: Handshake | null;
      try {
        hs = parseHandshake(buf);
      } catch {
        done();
        stream.destroy();
        return;
      }
      if (!hs) return;
      done();
      if (expected && !expected.equals(hs.infoHash)) {
        stream.destroy();
        return;
      }
      stream.pause();
      stream.unshift(buf);
      this.emit('connection', stream, hs, address, info);
    };
    const onData = (chunk: Buffer): void => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      check();
    };
    stream.once('close', () => {
      clearTimeout(timer);
      this.pending.delete(stream);
    });
    if (buf.length > 0) check();
    if (finished || stream.destroyed) return;
    stream.on('data', onData);
    stream.resume();
  }
}

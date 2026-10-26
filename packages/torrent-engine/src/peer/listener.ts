import { EventEmitter } from 'node:events';
import net from 'node:net';
import type { PeerAddress } from '../compact.js';
import { HANDSHAKE_LENGTH, type Handshake, parseHandshake } from './messages.js';

export interface PeerListenerEvents {
  /**
   * A peer completed the first half of the handshake. The socket is paused with the
   * handshake bytes pushed back, ready for a `PeerConnection` with `incoming: true`.
   */
  connection: [socket: net.Socket, handshake: Handshake, address: PeerAddress];
  warning: [message: string];
}

export interface PeerListenerOptions {
  handshakeTimeoutMs?: number;
  /** Rejects connections from blocked IPs before reading anything. */
  isBlocked?: (ip: string) => boolean;
}

/** TCP listener for incoming peers, bound to a configurable address and port. */
export class PeerListener extends EventEmitter<PeerListenerEvents> {
  private server: net.Server | null = null;
  private readonly pending = new Set<net.Socket>();

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

  async listen(port: number, host?: string): Promise<void> {
    if (this.server) await this.close();
    const server = net.createServer((sock) => this.onSocket(sock));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ port, ...(host ? { host } : { host: '0.0.0.0' }), exclusive: true }, () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.on('error', (err) => this.emit('warning', `listener error: ${err.message}`));
    this.server = server;
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
    const host = (sock.remoteAddress ?? '').replace(/^::ffff:/, '');
    const address: PeerAddress = { host, port: sock.remotePort ?? 0 };
    if (this.opts.isBlocked?.(host)) {
      sock.destroy();
      return;
    }
    this.pending.add(sock);
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => sock.destroy(), this.opts.handshakeTimeoutMs ?? 10_000);
    timer.unref();
    const done = (): void => {
      clearTimeout(timer);
      this.pending.delete(sock);
      sock.off('data', onData);
    };
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      let hs: Handshake | null;
      try {
        hs = parseHandshake(buf);
      } catch {
        done();
        sock.destroy();
        return;
      }
      if (!hs) return;
      done();
      sock.pause();
      sock.unshift(buf);
      if (buf.length < HANDSHAKE_LENGTH) return;
      this.emit('connection', sock, hs, address);
    };
    sock.on('data', onData);
    sock.on('error', () => {});
    sock.once('close', () => {
      clearTimeout(timer);
      this.pending.delete(sock);
    });
  }
}

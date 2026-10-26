import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { decodeCompactPeers } from '../compact.js';
import { TorrentEngineError } from '../errors.js';
import type { AnnounceParams, AnnounceResponse, ScrapeResponse, TrackerClient } from './types.js';

/** Creates a UDP socket. Injected in tests; the default is a plain `udp4` socket. */
export type UdpSocketFactory = () => dgram.Socket;

export const PROTOCOL_ID = 0x41727101980n;
export const ACTION_CONNECT = 0;
export const ACTION_ANNOUNCE = 1;
export const ACTION_SCRAPE = 2;
export const ACTION_ERROR = 3;
const EVENT_CODES = { completed: 1, started: 2, stopped: 3 } as const;

export interface UdpTrackerOptions {
  socketFactory?: UdpSocketFactory;
  localAddress?: string;
  /** First retransmission timeout; BEP 15 uses 15 s doubling each retry. */
  baseTimeoutMs?: number;
  /** Retransmissions after the first attempt (BEP 15 allows 8; default 3). */
  maxRetries?: number;
  now?: () => number;
}

/** BEP 15 UDP tracker client (IPv4). */
export class UdpTracker implements TrackerClient {
  private connectionId: Buffer | null = null;
  private connectionAt = 0;
  private readonly host: string;
  private readonly port: number;
  private readonly now: () => number;

  constructor(
    readonly url: string,
    private readonly opts: UdpTrackerOptions = {},
  ) {
    const u = new URL(url);
    if (u.protocol !== 'udp:') throw new TorrentEngineError('tracker', `not a udp tracker: ${url}`);
    this.host = u.hostname.replace(/^\[|\]$/g, '');
    this.port = Number(u.port || 80);
    this.now = opts.now ?? Date.now;
  }

  private openSocket(): Promise<dgram.Socket> {
    const sock = this.opts.socketFactory ? this.opts.socketFactory() : dgram.createSocket('udp4');
    return new Promise((resolve, reject) => {
      sock.once('error', reject);
      sock.bind({ port: 0, ...(this.opts.localAddress ? { address: this.opts.localAddress } : {}) }, () => {
        sock.off('error', reject);
        resolve(sock);
      });
    });
  }

  /** Sends `packet` and waits for a reply with the same transaction id, retrying with backoff. */
  private exchange(sock: dgram.Socket, build: (tx: Buffer) => Buffer, signal?: AbortSignal): Promise<Buffer> {
    const base = this.opts.baseTimeoutMs ?? 15_000;
    const retries = this.opts.maxRetries ?? 3;
    const tx = randomBytes(4);
    return new Promise((resolve, reject) => {
      let attempt = 0;
      let timer: NodeJS.Timeout | undefined;
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        sock.off('message', onMessage);
        sock.off('error', onError);
        signal?.removeEventListener('abort', onAbort);
      };
      const onMessage = (msg: Buffer): void => {
        if (msg.length < 8 || !msg.subarray(4, 8).equals(tx)) return;
        cleanup();
        if (msg.readUInt32BE(0) === ACTION_ERROR) {
          reject(new TorrentEngineError('tracker', `tracker failure: ${msg.subarray(8).toString('utf8')}`));
        } else resolve(msg);
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(new TorrentEngineError('tracker', `udp tracker error: ${err.message}`, { cause: err }));
      };
      const onAbort = (): void => {
        cleanup();
        reject(new TorrentEngineError('aborted', 'udp tracker request aborted'));
      };
      const send = (): void => {
        sock.send(build(tx), this.port, this.host, (err) => {
          if (err) onError(err);
        });
        timer = setTimeout(() => {
          attempt++;
          if (attempt > retries) {
            cleanup();
            reject(new TorrentEngineError('timeout', `udp tracker ${this.url} did not respond`));
          } else send();
        }, base * 2 ** attempt);
      };
      sock.on('message', onMessage);
      sock.on('error', onError);
      signal?.addEventListener('abort', onAbort, { once: true });
      send();
    });
  }

  private async connect(sock: dgram.Socket, signal?: AbortSignal): Promise<Buffer> {
    if (this.connectionId && this.now() - this.connectionAt < 60_000) return this.connectionId;
    const res = await this.exchange(
      sock,
      (tx) => {
        const b = Buffer.alloc(16);
        b.writeBigUInt64BE(PROTOCOL_ID, 0);
        b.writeUInt32BE(ACTION_CONNECT, 8);
        tx.copy(b, 12);
        return b;
      },
      signal,
    );
    if (res.length < 16 || res.readUInt32BE(0) !== ACTION_CONNECT)
      throw new TorrentEngineError('tracker', 'invalid udp connect response');
    this.connectionId = Buffer.from(res.subarray(8, 16));
    this.connectionAt = this.now();
    return this.connectionId;
  }

  private async withSocket<T>(fn: (sock: dgram.Socket) => Promise<T>): Promise<T> {
    const sock = await this.openSocket();
    try {
      return await fn(sock);
    } finally {
      sock.close();
    }
  }

  announce(p: AnnounceParams, signal?: AbortSignal): Promise<AnnounceResponse> {
    return this.withSocket(async (sock) => {
      const cid = await this.connect(sock, signal);
      const res = await this.exchange(
        sock,
        (tx) => {
          const b = Buffer.alloc(98);
          cid.copy(b, 0);
          b.writeUInt32BE(ACTION_ANNOUNCE, 8);
          tx.copy(b, 12);
          p.infoHash.copy(b, 16);
          p.peerId.copy(b, 36);
          b.writeBigUInt64BE(BigInt(p.downloaded), 56);
          b.writeBigUInt64BE(BigInt(p.left), 64);
          b.writeBigUInt64BE(BigInt(p.uploaded), 72);
          b.writeUInt32BE(p.event ? EVENT_CODES[p.event] : 0, 80);
          b.writeUInt32BE(0, 84); // ip: default
          b.writeUInt32BE(p.key >>> 0, 88);
          b.writeInt32BE(p.numwant ?? 50, 92);
          b.writeUInt16BE(p.port, 96);
          return b;
        },
        signal,
      );
      if (res.length < 20 || res.readUInt32BE(0) !== ACTION_ANNOUNCE)
        throw new TorrentEngineError('tracker', 'invalid udp announce response');
      return {
        intervalSec: res.readUInt32BE(8),
        incomplete: res.readUInt32BE(12),
        complete: res.readUInt32BE(16),
        peers: decodeCompactPeers(res.subarray(20)),
      };
    });
  }

  scrape(infoHash: Buffer, signal?: AbortSignal): Promise<ScrapeResponse> {
    return this.withSocket(async (sock) => {
      const cid = await this.connect(sock, signal);
      const res = await this.exchange(
        sock,
        (tx) => {
          const b = Buffer.alloc(36);
          cid.copy(b, 0);
          b.writeUInt32BE(ACTION_SCRAPE, 8);
          tx.copy(b, 12);
          infoHash.copy(b, 16);
          return b;
        },
        signal,
      );
      if (res.length < 20 || res.readUInt32BE(0) !== ACTION_SCRAPE)
        throw new TorrentEngineError('tracker', 'invalid udp scrape response');
      return { complete: res.readUInt32BE(8), downloaded: res.readUInt32BE(12), incomplete: res.readUInt32BE(16) };
    });
  }

  close(): void {
    this.connectionId = null;
  }
}

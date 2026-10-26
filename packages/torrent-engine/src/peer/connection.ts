import { EventEmitter } from 'node:events';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { PeerAddress } from '../compact.js';
import { errorMessage, TorrentEngineError } from '../errors.js';
import { consumeAll, RateMeter, TokenBucket } from '../rate.js';
import {
  decodeExtendedHandshake,
  decodeMetadataMessage,
  decodePex,
  encodeExtendedHandshake,
  encodeMetadataMessage,
  encodePex,
  type ExtendedHandshake,
  type ExtensionName,
  LOCAL_EXT,
  type MetadataMessage,
  type PexMessage,
} from './extensions.js';
import {
  BLOCK_SIZE,
  buildReserved,
  encode,
  encodeHandshake,
  HANDSHAKE_LENGTH,
  type Handshake,
  MessageReader,
  parseHandshake,
  parseReserved,
  type ReservedFlags,
  type WireMessage,
} from './messages.js';

export interface BlockRequest {
  index: number;
  begin: number;
  length: number;
}

export interface OutstandingRequest extends BlockRequest {
  sentAt: number;
}

export function requestKey(index: number, begin: number, length: number): string {
  return `${index}:${begin}:${length}`;
}

export interface PeerConnectionEvents {
  handshake: [handshake: Handshake];
  extendedHandshake: [hs: ExtendedHandshake];
  choke: [];
  unchoke: [];
  interested: [];
  notInterested: [];
  have: [index: number];
  bitfield: [bits: Buffer];
  haveAll: [];
  haveNone: [];
  request: [index: number, begin: number, length: number];
  cancel: [index: number, begin: number, length: number];
  piece: [index: number, begin: number, data: Buffer];
  reject: [index: number, begin: number, length: number];
  suggest: [index: number];
  allowedFast: [index: number];
  port: [port: number];
  metadata: [msg: MetadataMessage];
  pex: [msg: PexMessage];
  /** Outstanding requests that will not be answered (choke, reject, timeout, close). */
  requestsDropped: [requests: BlockRequest[]];
  close: [error: Error | undefined];
}

/** How a peer connection is carried. */
export type PeerTransport = 'tcp' | 'utp';

export interface PeerConnectionOptions {
  /** A TCP socket, a uTP socket or an MSE-wrapped stream around either. */
  socket: Duplex;
  /** The stream is RC4-encrypted (MSE). */
  encrypted?: boolean;
  transport?: PeerTransport;
  /** True for connections accepted by the listener: we answer the remote handshake. */
  incoming: boolean;
  infoHash: Buffer;
  peerId: Buffer;
  address: PeerAddress;
  reserved: ReservedFlags;
  /** Shared buckets (global limits); a per-connection bucket is added automatically. */
  uploadBuckets?: TokenBucket[];
  downloadBuckets?: TokenBucket[];
  uploadLimit?: number;
  downloadLimit?: number;
  keepAliveMs?: number;
  idleTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  snubTimeoutMs?: number;
  maxQueueDepth?: number;
  /** Seconds of transfer at the current rate the request pipeline should cover. */
  requestQueueSeconds?: number;
  maxMessageLength?: number;
  /** Max simultaneous requests accepted from the peer. */
  maxPeerRequests?: number;
  now?: () => number;
}

/** One BitTorrent peer wire connection over TCP. */
export class PeerConnection extends EventEmitter<PeerConnectionEvents> {
  readonly socket: Duplex;
  readonly encrypted: boolean;
  readonly transport: PeerTransport;
  readonly address: PeerAddress;
  readonly incoming: boolean;
  readonly infoHash: Buffer;
  readonly connectedAt: number;

  amChoking = true;
  amInterested = false;
  peerChoking = true;
  peerInterested = false;

  remotePeerId: Buffer | null = null;
  remoteFlags: ReservedFlags = { extensions: false, fast: false, dht: false };
  remoteExtensions: ExtendedHandshake | null = null;
  handshaken = false;

  readonly downloadMeter: RateMeter;
  readonly uploadMeter: RateMeter;
  readonly requests = new Map<string, OutstandingRequest>();
  private readonly peerRequests = new Set<string>();
  private readonly uploadBuckets: TokenBucket[];
  private readonly downloadBuckets: TokenBucket[];
  readonly perConnUpload: TokenBucket;
  readonly perConnDownload: TokenBucket;

  private readonly reader: MessageReader;
  private handshakeBuf: Buffer = Buffer.alloc(0);
  private readonly now: () => number;
  private lastReceived: number;
  private lastSent: number;
  private lastPieceAt: number;
  private pendingSince = 0;
  private timer: NodeJS.Timeout | undefined;
  private handshakeTimer: NodeJS.Timeout | undefined;
  private closed = false;
  private readonly ourFlags: ReservedFlags;
  /** Arbitrary per-connection state owned by the torrent. */
  data: Record<string, unknown> = {};

  constructor(private readonly opts: PeerConnectionOptions) {
    super();
    this.socket = opts.socket;
    this.encrypted = opts.encrypted ?? false;
    this.transport = opts.transport ?? 'tcp';
    this.address = opts.address;
    this.incoming = opts.incoming;
    this.infoHash = opts.infoHash;
    this.ourFlags = opts.reserved;
    this.now = opts.now ?? Date.now;
    this.connectedAt = this.now();
    this.lastReceived = this.connectedAt;
    this.lastSent = this.connectedAt;
    this.lastPieceAt = this.connectedAt;
    this.downloadMeter = new RateMeter(5000, this.now);
    this.uploadMeter = new RateMeter(5000, this.now);
    this.perConnUpload = new TokenBucket(opts.uploadLimit ?? 0);
    this.perConnDownload = new TokenBucket(opts.downloadLimit ?? 0);
    this.uploadBuckets = [this.perConnUpload, ...(opts.uploadBuckets ?? [])];
    this.downloadBuckets = [this.perConnDownload, ...(opts.downloadBuckets ?? [])];
    this.reader = new MessageReader(opts.maxMessageLength ?? 1024 * 1024 + 13);

    (this.socket as { setNoDelay?: (v: boolean) => unknown }).setNoDelay?.(true);
    this.socket.on('data', (c: Buffer) => this.onData(c));
    this.socket.on('error', (err) => this.destroy(err));
    this.socket.on('close', () => this.destroy());
    this.handshakeTimer = setTimeout(
      () => this.destroy(new TorrentEngineError('timeout', 'peer handshake timed out')),
      opts.handshakeTimeoutMs ?? 20_000,
    );
    this.handshakeTimer.unref();
    if (this.socket.destroyed) {
      queueMicrotask(() => this.destroy(new TorrentEngineError('peer', 'socket closed before handshake')));
      return;
    }
    // the listener pauses incoming sockets after peeking at the handshake
    this.socket.resume();
    if (!this.incoming) this.sendHandshake();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get supportsFast(): boolean {
    return this.ourFlags.fast && this.remoteFlags.fast;
  }

  get supportsExtensions(): boolean {
    return this.ourFlags.extensions && this.remoteFlags.extensions;
  }

  /** The address this peer accepts connections on (remote IP + advertised port when known). */
  get listenAddress(): PeerAddress {
    if (!this.incoming) return this.address;
    return { host: this.address.host, port: this.remoteExtensions?.port ?? this.address.port };
  }

  remoteExtensionId(name: ExtensionName): number {
    return this.remoteExtensions?.m[name] ?? 0;
  }

  private sendHandshake(): void {
    this.write(encodeHandshake({ reserved: buildReserved(this.ourFlags), infoHash: this.infoHash, peerId: this.opts.peerId }));
  }

  private write(b: Buffer): boolean {
    if (this.closed) return false;
    this.lastSent = this.now();
    return this.socket.write(b);
  }

  // ---- receive path -----------------------------------------------------------------------

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    this.lastReceived = this.now();
    const wait = consumeAll(this.downloadBuckets, chunk.length);
    if (wait > 0) {
      this.socket.pause();
      setTimeout(() => {
        if (!this.closed) this.socket.resume();
      }, wait).unref();
    }
    try {
      if (!this.handshaken) {
        this.handshakeBuf = Buffer.concat([this.handshakeBuf, chunk]);
        const hs = parseHandshake(this.handshakeBuf);
        if (!hs) return;
        const rest = this.handshakeBuf.subarray(HANDSHAKE_LENGTH);
        this.handshakeBuf = Buffer.alloc(0);
        this.onHandshake(hs);
        if (this.closed || rest.length === 0) return;
        chunk = rest;
      }
      for (const msg of this.reader.push(chunk)) {
        if (this.closed) return;
        this.onMessage(msg);
      }
    } catch (err) {
      this.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private onHandshake(hs: Handshake): void {
    if (!hs.infoHash.equals(this.infoHash)) throw new TorrentEngineError('peer', 'peer handshake for a different torrent');
    this.handshaken = true;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.remotePeerId = hs.peerId;
    this.remoteFlags = parseReserved(hs.reserved);
    if (this.incoming) this.sendHandshake();
    this.timer = setInterval(() => this.tick(), Math.min(this.opts.keepAliveMs ?? 120_000, 30_000));
    this.timer.unref();
    this.emit('handshake', hs);
  }

  private onMessage(msg: WireMessage): void {
    switch (msg.type) {
      case 'keepAlive':
        return;
      case 'choke': {
        this.peerChoking = true;
        this.dropRequests([...this.requests.keys()]);
        this.emit('choke');
        return;
      }
      case 'unchoke':
        this.peerChoking = false;
        this.emit('unchoke');
        return;
      case 'interested':
        this.peerInterested = true;
        this.emit('interested');
        return;
      case 'notInterested':
        this.peerInterested = false;
        this.emit('notInterested');
        return;
      case 'have':
        this.emit('have', msg.index);
        return;
      case 'bitfield':
        this.emit('bitfield', msg.bits);
        return;
      case 'haveAll':
      case 'haveNone':
        if (!this.supportsFast) throw new TorrentEngineError('peer', `${msg.type} without fast extension`);
        this.emit(msg.type);
        return;
      case 'request': {
        if (msg.length > BLOCK_SIZE * 2 || msg.length === 0) throw new TorrentEngineError('peer', `bad request length ${msg.length}`);
        const key = requestKey(msg.index, msg.begin, msg.length);
        if (this.amChoking || this.peerRequests.size >= (this.opts.maxPeerRequests ?? 500)) {
          if (this.supportsFast) this.write(encode.reject(msg.index, msg.begin, msg.length));
          return;
        }
        this.peerRequests.add(key);
        this.emit('request', msg.index, msg.begin, msg.length);
        return;
      }
      case 'cancel':
        if (this.peerRequests.delete(requestKey(msg.index, msg.begin, msg.length)) && this.supportsFast)
          this.write(encode.reject(msg.index, msg.begin, msg.length));
        this.emit('cancel', msg.index, msg.begin, msg.length);
        return;
      case 'piece': {
        const key = requestKey(msg.index, msg.begin, msg.data.length);
        this.downloadMeter.add(msg.data.length);
        if (!this.requests.delete(key)) return; // cancelled, timed out or unsolicited
        this.lastPieceAt = this.now();
        this.pendingSince = this.requests.size > 0 ? this.lastPieceAt : 0;
        this.emit('piece', msg.index, msg.begin, msg.data);
        return;
      }
      case 'reject': {
        if (!this.supportsFast) throw new TorrentEngineError('peer', 'reject without fast extension');
        const key = requestKey(msg.index, msg.begin, msg.length);
        if (this.requests.has(key)) this.dropRequests([key]);
        this.emit('reject', msg.index, msg.begin, msg.length);
        return;
      }
      case 'suggest':
        this.emit('suggest', msg.index);
        return;
      case 'allowedFast':
        this.emit('allowedFast', msg.index);
        return;
      case 'port':
        this.emit('port', msg.port);
        return;
      case 'extended':
        this.onExtended(msg.extId, msg.payload);
        return;
      case 'unknown':
        return;
    }
  }

  private onExtended(extId: number, payload: Buffer): void {
    if (!this.supportsExtensions) throw new TorrentEngineError('peer', 'extended message without extension support');
    if (extId === 0) {
      this.remoteExtensions = decodeExtendedHandshake(payload);
      this.emit('extendedHandshake', this.remoteExtensions);
      return;
    }
    try {
      if (extId === LOCAL_EXT.ut_metadata) this.emit('metadata', decodeMetadataMessage(payload));
      else if (extId === LOCAL_EXT.ut_pex) this.emit('pex', decodePex(payload));
    } catch {
      // Malformed extension payloads are ignored rather than fatal.
    }
  }

  private dropRequests(keys: string[]): void {
    const dropped: BlockRequest[] = [];
    for (const k of keys) {
      const r = this.requests.get(k);
      if (!r) continue;
      this.requests.delete(k);
      dropped.push({ index: r.index, begin: r.begin, length: r.length });
    }
    if (this.requests.size === 0) this.pendingSince = 0;
    if (dropped.length > 0) this.emit('requestsDropped', dropped);
  }

  /** Drops (and reports) requests sent before `olderThan`. Returns how many expired. */
  expireRequests(olderThan: number): number {
    const keys = [...this.requests.entries()].filter(([, r]) => r.sentAt < olderThan).map(([k]) => k);
    this.dropRequests(keys);
    return keys.length;
  }

  private tick(): void {
    const now = this.now();
    if (now - this.lastReceived > (this.opts.idleTimeoutMs ?? 180_000)) {
      this.destroy(new TorrentEngineError('timeout', 'peer idle timeout'));
      return;
    }
    if (now - this.lastSent >= (this.opts.keepAliveMs ?? 120_000) - 1000) this.write(encode.keepAlive());
  }

  // ---- send path --------------------------------------------------------------------------

  choke(): void {
    if (this.amChoking) return;
    this.amChoking = true;
    this.write(encode.choke());
    if (this.supportsFast) for (const k of this.peerRequests) {
      const [i, b, l] = k.split(':').map(Number) as [number, number, number];
      this.write(encode.reject(i, b, l));
    }
    this.peerRequests.clear();
  }

  unchoke(): void {
    if (!this.amChoking) return;
    this.amChoking = false;
    this.write(encode.unchoke());
  }

  interested(): void {
    if (this.amInterested) return;
    this.amInterested = true;
    this.write(encode.interested());
  }

  notInterested(): void {
    if (!this.amInterested) return;
    this.amInterested = false;
    this.write(encode.notInterested());
  }

  have(index: number): void {
    this.write(encode.have(index));
  }

  bitfield(bits: Buffer): void {
    this.write(encode.bitfield(bits));
  }

  haveAll(): void {
    this.write(encode.haveAll());
  }

  haveNone(): void {
    this.write(encode.haveNone());
  }

  port(port: number): void {
    this.write(encode.port(port));
  }

  suggest(index: number): void {
    if (this.supportsFast) this.write(encode.suggest(index));
  }

  allowedFast(index: number): void {
    if (this.supportsFast) this.write(encode.allowedFast(index));
  }

  request(index: number, begin: number, length: number): boolean {
    const key = requestKey(index, begin, length);
    if (this.requests.has(key)) return false;
    const now = this.now();
    if (this.requests.size === 0) this.pendingSince = now;
    this.requests.set(key, { index, begin, length, sentAt: now });
    this.write(encode.request(index, begin, length));
    return true;
  }

  cancel(index: number, begin: number, length: number): void {
    if (this.requests.delete(requestKey(index, begin, length))) this.write(encode.cancel(index, begin, length));
    if (this.requests.size === 0) this.pendingSince = 0;
  }

  /** True while the peer's request is still wanted (not cancelled, not choked away). */
  hasPeerRequest(index: number, begin: number, length: number): boolean {
    return this.peerRequests.has(requestKey(index, begin, length));
  }

  /** Sends a block the peer requested, honouring upload rate limits. Returns false if dropped. */
  async sendPiece(index: number, begin: number, data: Buffer): Promise<boolean> {
    const key = requestKey(index, begin, data.length);
    if (!this.peerRequests.has(key)) return false;
    const wait = consumeAll(this.uploadBuckets, data.length);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (this.closed || this.amChoking || !this.peerRequests.delete(key)) return false;
    const ok = this.write(encode.piece(index, begin, data));
    this.uploadMeter.add(data.length);
    if (!ok && !this.closed) await this.waitDrain();
    return true;
  }

  private drainWait: Promise<void> | null = null;

  /** One shared wait for 'drain' (or close), however many senders are blocked. */
  private waitDrain(): Promise<void> {
    if (!this.drainWait) {
      this.drainWait = new Promise<void>((r) => {
        const done = (): void => {
          this.socket.off('drain', done);
          this.socket.off('close', done);
          this.drainWait = null;
          r();
        };
        this.socket.on('drain', done);
        this.socket.on('close', done);
      });
    }
    return this.drainWait;
  }

  rejectRequest(index: number, begin: number, length: number): void {
    if (this.peerRequests.delete(requestKey(index, begin, length)) && this.supportsFast)
      this.write(encode.reject(index, begin, length));
  }

  sendExtendedHandshake(opts: Omit<Parameters<typeof encodeExtendedHandshake>[0], 'yourIp'>): void {
    if (!this.supportsExtensions) return;
    this.write(encode.extended(0, encodeExtendedHandshake({ ...opts, yourIp: this.address.host })));
  }

  sendMetadata(msg: MetadataMessage): boolean {
    const id = this.remoteExtensionId('ut_metadata');
    if (!id) return false;
    return this.write(encode.extended(id, encodeMetadataMessage(msg)));
  }

  sendPex(msg: PexMessage): boolean {
    const id = this.remoteExtensionId('ut_pex');
    if (!id) return false;
    return this.write(encode.extended(id, encodePex(msg)));
  }

  // ---- adaptive pipelining and snubbing ------------------------------------------------------

  /** Requests to keep outstanding: enough to cover `requestQueueSeconds` at the current rate. */
  get desiredQueueDepth(): number {
    const secs = this.opts.requestQueueSeconds ?? 3;
    const byRate = Math.ceil((this.downloadMeter.rate() * secs) / BLOCK_SIZE) + 2;
    const cap = Math.min(this.opts.maxQueueDepth ?? 250, this.remoteExtensions?.reqq ?? 250);
    return Math.max(4, Math.min(byRate, cap));
  }

  /** Unchoked with requests outstanding but no block received for `snubTimeoutMs`. */
  isSnubbed(): boolean {
    if (this.peerChoking || this.requests.size === 0 || this.pendingSince === 0) return false;
    const since = Math.max(this.lastPieceAt, this.pendingSince);
    return this.now() - since > (this.opts.snubTimeoutMs ?? 60_000);
  }

  setLimits(upload: number, download: number): void {
    this.perConnUpload.setRate(upload);
    this.perConnDownload.setRate(download);
  }

  destroy(err?: Error): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    const dropped = [...this.requests.values()].map((r) => ({ index: r.index, begin: r.begin, length: r.length }));
    this.requests.clear();
    this.peerRequests.clear();
    this.socket.destroy();
    if (dropped.length > 0) this.emit('requestsDropped', dropped);
    this.emit('close', err);
    this.removeAllListeners();
  }
}

export interface ConnectOptions {
  localAddress?: string;
  timeoutMs?: number;
}

/** Opens an outgoing TCP connection, bound to `localAddress` when given (VPN binding). */
export function connectTcp(addr: PeerAddress, opts: ConnectOptions = {}): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sockOpts: net.NetConnectOpts = { host: addr.host, port: addr.port };
    if (opts.localAddress) sockOpts.localAddress = opts.localAddress;
    const sock = net.connect(sockOpts);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new TorrentEngineError('timeout', `connect to ${addr.host}:${addr.port} timed out`));
    }, opts.timeoutMs ?? 10_000);
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.removeAllListeners('error');
      // keep a handler until the PeerConnection attaches its own
      sock.on('error', () => {});
      resolve(sock);
    });
    sock.once('error', (err) => {
      clearTimeout(timer);
      reject(new TorrentEngineError('peer', `connect to ${addr.host}:${addr.port} failed: ${errorMessage(err)}`, { cause: err }));
    });
  });
}

import { randomInt } from 'node:crypto';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { encode } from './bencode.js';
import { hostFamily, type PeerAddress } from './compact.js';
import { DHT, type DhtOptions } from './dht/dht.js';
import { errorMessage, TorrentEngineError } from './errors.js';
import { type MagnetLink, parseMagnet } from './magnet.js';
import { type Metainfo, parseTorrent } from './metainfo.js';
import { PeerListener } from './peer/listener.js';
import { mseReq2 } from './peer/mse.js';
import { TokenBucket } from './rate.js';
import { DEFAULT_SETTINGS, type SessionSettings } from './settings.js';
import {
  deleteResumeData,
  listResumeData,
  loadResumeData,
  type ResumeData,
  saveResumeData,
  torrentPath,
} from './storage/resume.js';
import { requestBudgetBlocks, Torrent, type TorrentContext, type TorrentInit, type TorrentState, type TorrentStats } from './torrent.js';
import { createTrackerClient, type TrackerClientFactoryOptions } from './tracker/tracker-manager.js';
import type { TrackerClient } from './tracker/types.js';
import { UtpManager, type UtpManagerOptions } from './utp/manager.js';

export interface AddTorrentOptions {
  /** .torrent file bytes. Exactly one of `torrent` / `magnet` is required. */
  torrent?: Uint8Array;
  magnet?: string;
  /** Defaults to the category's save path, then the session save path. */
  savePath?: string;
  category?: string;
  tags?: string[];
  paused?: boolean;
  sequential?: boolean;
  filePriorities?: number[];
  /** undefined = session default, null = unlimited. */
  seedRatioLimit?: number | null;
  seedTimeLimitMs?: number | null;
  /** Extra peers to try (e.g. for private swarms or tests). */
  peers?: PeerAddress[];
  /** BEP 16 super-seeding while this torrent seeds. */
  superSeeding?: boolean;
  /** Per-torrent upload limit in bytes/s (0 = unlimited; the global limit still applies). */
  uploadLimit?: number;
  /** Per-torrent download limit in bytes/s (0 = unlimited). */
  downloadLimit?: number;
  /** Per-peer limits for this torrent's connections in bytes/s (0 = unlimited). */
  peerUploadLimit?: number;
  peerDownloadLimit?: number;
  /** Start regardless of the active-download/seed limits. */
  forceStart?: boolean;
}

/** Where `Session.moveInQueue` moves a torrent. */
export type QueueMove = 'top' | 'up' | 'down' | 'bottom';

export interface SessionOptions {
  settings?: Partial<SessionSettings>;
  /** Peer blocklist hook: return true to refuse an IP (incoming and outgoing). */
  isBlocked?: (ip: string) => boolean;
  /** Override tracker clients (tests inject fakes here). */
  trackerClientFactory?: (url: string, opts: TrackerClientFactoryOptions) => TrackerClient | null;
  /** Extra DHT options (timeouts, saved nodes, socket factory). */
  dht?: Partial<DhtOptions>;
  /** Extra uTP options (tests inject packet loss and short timeouts here). */
  utp?: UtpManagerOptions;
  now?: () => number;
}

export interface SessionEvents {
  torrentAdded: [torrent: Torrent];
  torrentRemoved: [infoHash: string];
  stateChange: [torrent: Torrent, prev: TorrentState, next: TorrentState];
  completed: [torrent: Torrent];
  error: [torrent: Torrent, error: Error];
  metadata: [torrent: Torrent];
  seedLimitReached: [torrent: Torrent];
  warning: [message: string];
}

export interface SessionStats {
  torrents: number;
  connections: number;
  downloadRate: number;
  uploadRate: number;
  dhtNodes: number;
  /** IPv6 DHT routing table size (0 when IPv6 is off). */
  dht6Nodes: number;
  /** Open uTP connections (including ones still handshaking). */
  utpConnections: number;
  listenPort: number;
  listenAddress: string | null;
}

/** Restored torrents whose data is checked at the same time (see `restore`). */
const RESTORE_CHECKS = 2;
/** Smallest cache share and write backlog per downloading torrent. */
const CACHE_SHARE_MIN = 4 * 1024 * 1024;
const PEER_ID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function generatePeerId(prefix: string): Buffer {
  const p = Buffer.from(prefix, 'latin1').subarray(0, 20);
  let rest = '';
  for (let i = p.length; i < 20; i++) rest += PEER_ID_CHARS[randomInt(0, PEER_ID_CHARS.length)];
  return Buffer.concat([p, Buffer.from(rest, 'latin1')]);
}

/** True when this host has at least one IPv6 address (loopback included). */
export function ipv6Available(): boolean {
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv6') return true;
  return false;
}

/** Rebuilds a .torrent file around a raw info dict (for magnets after metadata exchange). */
export function torrentFileFromInfo(info: Buffer, trackers: string[]): Buffer {
  const parts: Buffer[] = [Buffer.from("d")];
  if (trackers.length > 0) {
    parts.push(Buffer.from('8:announce'), encode(trackers[0] as string));
    parts.push(Buffer.from('13:announce-list'), encode(trackers.map((t) => [t])));
  }
  parts.push(Buffer.from('4:info'), info, Buffer.from('e'));
  return Buffer.concat(parts);
}

/**
 * A BitTorrent client session: one peer listener, one DHT node, shared rate limits and
 * connection budget, queueing and persistence for many torrents.
 */
export class Session extends EventEmitter<SessionEvents> {
  readonly peerId: Buffer;
  private settingsValue: SessionSettings;
  private readonly torrentsById = new Map<string, Torrent>();
  private readonly torrentFiles = new Map<string, Buffer>();
  private readonly listener: PeerListener;
  private dhtNode: DHT | null = null;
  private dht6Node: DHT | null = null;
  private readonly utp: UtpManager;
  private ownUdp: dgram.Socket[] = [];
  private readonly uploadBucket: TokenBucket;
  private readonly downloadBucket: TokenBucket;
  private readonly now: () => number;
  private nextQueuePosition = 0;
  private queueScheduled = false;
  private resumeTimer: NodeJS.Timeout | undefined;
  private started = false;
  /** Restored torrents still being checked in the background (see `whenRestored`). */
  private restoring: Promise<void> = Promise.resolve();
  private stopping = false;
  private boundPort = 0;

  constructor(private readonly opts: SessionOptions = {}) {
    super();
    this.settingsValue = { ...DEFAULT_SETTINGS, ...opts.settings };
    this.now = opts.now ?? Date.now;
    this.peerId = generatePeerId(this.settingsValue.peerIdPrefix);
    this.uploadBucket = new TokenBucket(this.settingsValue.uploadLimit);
    this.downloadBucket = new TokenBucket(this.settingsValue.downloadLimit);
    const lOpts: ConstructorParameters<typeof PeerListener>[0] = {
      encryption: () => this.settingsValue.encryption,
      findInfoHash: (req2) => this.findInfoHashByReq2(req2),
    };
    if (opts.isBlocked) lOpts.isBlocked = opts.isBlocked;
    this.listener = new PeerListener(lOpts);
    this.listener.on('connection', (sock, hs, address, info) => {
      const t = this.torrentsById.get(hs.infoHash.toString('hex'));
      if (!t || this.stopping || !this.canConnect() || !t.acceptIncoming(sock, address, info)) sock.destroy();
    });
    this.listener.on('warning', (m) => this.emit('warning', m));
    const userAccept = opts.utp?.accept;
    this.utp = new UtpManager({ ...opts.utp, accept: () => this.settingsValue.utp && !this.stopping && (userAccept?.() ?? true) });
    this.utp.on('connection', (sock, address) => this.listener.accept(sock, address, 'utp'));
    this.utp.on('warning', (m) => this.emit('warning', m));
  }

  get settings(): Readonly<SessionSettings> {
    return this.settingsValue;
  }

  /** The actual TCP/UDP port (resolves `listenPort: 0`). */
  get listenPort(): number {
    return this.listener.port || this.boundPort;
  }

  get dht(): DHT | null {
    return this.dhtNode;
  }

  /** The IPv6 DHT node (BEP 32), when running. */
  get dht6(): DHT | null {
    return this.dht6Node;
  }

  /** The uTP connection manager (sockets are attached while the session runs with `utp`). */
  get utpManager(): UtpManager {
    return this.utp;
  }

  /** Binds the listener and DHT, then restores torrents from the resume directory. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.openSockets(this.settingsValue.listenPort, this.settingsValue.listenAddress);
    // Restored torrents are registered right away; checking their data (a full hash when the
    // fast-resume state no longer matches, hours for a large library) runs in the background so
    // the session is up, and the other torrents run, in the meantime.
    if (this.settingsValue.resumeDataDir) this.restoring = (await this.restore()).checked;
    this.scheduleResumeSaves();
    this.scheduleQueue();
  }

  /** Resolves once every torrent restored by `start` has finished checking its data. */
  whenRestored(): Promise<void> {
    return this.restoring;
  }

  private findInfoHashByReq2(req2: Buffer): Buffer | null {
    for (const t of this.torrentsById.values()) if (mseReq2(t.infoHash).equals(req2)) return t.infoHash;
    return null;
  }

  /**
   * Binds the TCP listener and the UDP sockets: one per address family, owned by the DHT
   * when it runs (uTP shares it) or by the session for uTP alone.
   */
  private async openSockets(port: number, address: string | null): Promise<void> {
    const s = this.settingsValue;
    const fam = address ? hostFamily(address) : 0;
    const want4 = fam !== 6;
    const want6 = s.ipv6 && (fam === 6 || (fam === 0 && ipv6Available()));
    this.utp.close();
    for (const u of this.ownUdp.splice(0)) u.close();
    if (s.tcp) {
      await this.listener.listen(port, address ?? undefined, { ipv6: want6 });
      this.boundPort = this.listener.port;
    } else {
      await this.listener.close();
      this.boundPort = port;
    }
    const udp: dgram.Socket[] = [];
    if (want4) {
      const u = await this.openUdp(4, this.boundPort, fam === 4 ? (address as string) : undefined);
      if (u) {
        udp.push(u);
        if (this.boundPort === 0) this.boundPort = u.address().port;
      }
    } else this.closeDht(4);
    if (want6) {
      const u = await this.openUdp(6, this.boundPort, fam === 6 ? (address as string) : undefined);
      if (u) {
        udp.push(u);
        if (this.boundPort === 0) this.boundPort = u.address().port;
      }
    } else this.closeDht(6);
    if (s.utp) for (const u of udp) this.utp.attach(u);
  }

  private closeDht(family: 4 | 6): void {
    if (family === 4) {
      this.dhtNode?.close();
      this.dhtNode = null;
    } else {
      this.dht6Node?.close();
      this.dht6Node = null;
    }
  }

  private async openUdp(family: 4 | 6, port: number, address: string | undefined): Promise<dgram.Socket | null> {
    const s = this.settingsValue;
    if (s.dht) {
      const sock = await this.startDht(family, port, address);
      if (sock) return sock;
    } else this.closeDht(family);
    if (!s.utp) return null;
    for (const p of port === 0 ? [0] : [port, 0]) {
      const sock = dgram.createSocket(family === 6 ? { type: 'udp6', ipv6Only: true } : { type: 'udp4' });
      try {
        await new Promise<void>((resolve, reject) => {
          sock.once('error', reject);
          sock.bind({ port: p, ...(address ? { address } : {}) }, () => {
            sock.off('error', reject);
            resolve();
          });
        });
      } catch (err) {
        sock.close();
        this.emit('warning', `cannot bind udp${family} port ${p}: ${errorMessage(err)}`);
        continue;
      }
      sock.on('error', (err) => this.emit('warning', `udp socket error: ${err.message}`));
      this.ownUdp.push(sock);
      return sock;
    }
    return null;
  }

  private async startDht(family: 4 | 6, port: number, address: string | undefined): Promise<dgram.Socket | null> {
    let node = family === 4 ? this.dhtNode : this.dht6Node;
    const fresh = node === null;
    if (!node) {
      const dOpts: DhtOptions = {
        bootstrap: this.settingsValue.dhtBootstrapNodes,
        uploadRateLimit: this.settingsValue.dhtUploadRateLimit,
        ...this.opts.dht,
        family,
      };
      if (family === 6) delete dOpts.socketFactory;
      node = new DHT(dOpts);
      node.on('warning', (m) => this.emit('warning', m));
      if (family === 4) this.dhtNode = node;
      else this.dht6Node = node;
    }
    const n = node;
    const bind = (p: number): Promise<void> => (fresh ? n.listen(p, address) : n.rebind(p, address));
    try {
      await bind(port).catch(() => bind(0));
    } catch (err) {
      this.emit('warning', `dht${family === 6 ? ' (IPv6)' : ''} bind failed: ${errorMessage(err)}`);
      this.closeDht(family);
      return null;
    }
    if (fresh) void n.bootstrap().catch((e: unknown) => this.emit('warning', `dht bootstrap failed: ${errorMessage(e)}`));
    return n.udpSocket;
  }

  private scheduleResumeSaves(): void {
    if (!this.settingsValue.resumeDataDir || this.resumeTimer) return;
    this.resumeTimer = setInterval(() => void this.saveAllResumeData(), this.settingsValue.resumeSaveIntervalMs);
    this.resumeTimer.unref();
  }

  // ---- torrent context ------------------------------------------------------------------------

  private connectionCount(): number {
    let n = 0;
    for (const t of this.torrentsById.values()) n += t.peerCount;
    return n;
  }

  /** Blocks that may still be requested under the global download limit (Infinity without one). */
  private requestBudget(): number {
    const limit = this.settingsValue.downloadLimit;
    if (limit <= 0) return Infinity;
    let n = 0;
    for (const t of this.torrentsById.values()) n += t.outstandingRequests;
    return Math.max(0, requestBudgetBlocks(limit) - n);
  }

  private connectTokens = 0;
  private connectRefilledAt = 0;

  /**
   * Allows one more outgoing peer attempt: under the half-open limit and within the per-second
   * connection rate (a token bucket holding one second of attempts). Spends a token when true.
   */
  private canOpen(): boolean {
    let n = 0;
    for (const t of this.torrentsById.values()) n += t.connectingCount;
    if (n >= this.settingsValue.maxHalfOpenConnections) return false;
    const rate = this.settingsValue.connectionsPerSecond;
    if (rate <= 0) return true;
    const now = this.now();
    this.connectTokens = Math.min(rate, this.connectTokens + ((now - this.connectRefilledAt) / 1000) * rate);
    this.connectRefilledAt = now;
    if (this.connectTokens < 1) return false;
    this.connectTokens -= 1;
    return true;
  }

  private canConnect(): boolean {
    return this.connectionCount() < this.settingsValue.maxConnections;
  }

  private context(): TorrentContext {
    return {
      peerId: this.peerId,
      settings: () => this.settingsValue,
      listenPort: () => this.listenPort,
      localAddress: () => this.settingsValue.listenAddress ?? undefined,
      uploadBuckets: [this.uploadBucket],
      downloadBuckets: [this.downloadBucket],
      dht: () => this.dhtNode ?? this.dht6Node,
      dhts: () => [this.dhtNode, this.dht6Node].filter((d): d is DHT => d !== null),
      utp: () => (this.settingsValue.utp && this.utp.attached ? this.utp : null),
      canConnect: () => this.canConnect(),
      canOpen: () => this.canOpen(),
      requestBudget: () => this.requestBudget(),
      isBlocked: (ip) => this.opts.isBlocked?.(ip) ?? false,
      trackerFactory: (url) => {
        const fOpts: TrackerClientFactoryOptions = { userAgent: this.settingsValue.userAgent };
        if (this.settingsValue.listenAddress) fOpts.localAddress = this.settingsValue.listenAddress;
        return (this.opts.trackerClientFactory ?? createTrackerClient)(url, fOpts);
      },
      now: this.now,
    };
  }

  // ---- adding and removing ---------------------------------------------------------------------

  private torrentInit(input: AddTorrentOptions, resume?: ResumeData): TorrentInit {
    if (!input.torrent === !input.magnet) throw new TorrentEngineError('session', 'pass exactly one of torrent or magnet');
    let meta: Metainfo | null = null;
    let magnet: MagnetLink | null = null;
    if (input.torrent) meta = parseTorrent(input.torrent);
    else magnet = parseMagnet(input.magnet as string);
    const infoHash = meta?.infoHash ?? (magnet as MagnetLink).infoHash;
    const id = infoHash.toString('hex');
    if (this.torrentsById.has(id)) throw new TorrentEngineError('session', `torrent ${id} already added`);
    const category = input.category ?? '';
    const savePath = input.savePath ?? this.settingsValue.categories[category]?.savePath ?? this.settingsValue.savePath;
    const init: TorrentInit = {
      infoHash,
      metainfo: meta,
      magnet,
      savePath,
      category,
      tags: input.tags ?? [],
      paused: input.paused ?? false,
      sequential: input.sequential ?? false,
    };
    if (input.filePriorities) init.filePriorities = input.filePriorities;
    if (input.seedRatioLimit !== undefined) init.seedRatioLimit = input.seedRatioLimit;
    if (input.seedTimeLimitMs !== undefined) init.seedTimeLimitMs = input.seedTimeLimitMs;
    if (resume) init.resume = resume;
    const superSeeding = input.superSeeding ?? resume?.superSeeding;
    if (superSeeding !== undefined) init.superSeeding = superSeeding;
    init.limits = {
      uploadLimit: input.uploadLimit ?? resume?.uploadLimit ?? 0,
      downloadLimit: input.downloadLimit ?? resume?.downloadLimit ?? 0,
      peerUploadLimit: input.peerUploadLimit ?? resume?.peerUploadLimit ?? 0,
      peerDownloadLimit: input.peerDownloadLimit ?? resume?.peerDownloadLimit ?? 0,
    };
    return init;
  }

  /** Adds a torrent from .torrent bytes or a magnet URI. Throws `TorrentEngineError('session')` on duplicates. */
  async addTorrent(input: AddTorrentOptions, resume?: ResumeData): Promise<Torrent> {
    const t = this.register(input, resume);
    await this.activate(t, resume);
    return t;
  }

  /** Creates the torrent and makes it visible; `activate` then checks its data. */
  private register(input: AddTorrentOptions, resume?: ResumeData): Torrent {
    const init = this.torrentInit(input, resume);
    const id = init.infoHash.toString('hex');
    const t = new Torrent(this.context(), init);
    if (input.magnet) t.magnetUri = input.magnet;
    t.queuePosition = this.nextQueuePosition++;
    t.forceStart = input.forceStart ?? resume?.forceStart ?? false;
    if (input.torrent) this.torrentFiles.set(id, Buffer.from(input.torrent));
    this.torrentsById.set(id, t);
    this.wire(t);
    if (input.peers) t.addPeers(input.peers, 'manual');
    this.emit('torrentAdded', t);
    return t;
  }

  private async activate(t: Torrent, resume?: ResumeData): Promise<void> {
    await t.init(resume);
    this.scheduleQueue();
    await this.saveResumeData(t);
  }

  private wire(t: Torrent): void {
    t.on('stateChange', (prev, next) => {
      this.emit('stateChange', t, prev, next);
      this.scheduleQueue();
    });
    t.on('completed', () => {
      this.emit('completed', t);
      void this.saveResumeData(t);
    });
    // 'error' is only emitted when someone listens, so an unobserved torrent failure cannot crash the process.
    t.on('error', (err) => {
      if (this.listenerCount('error') > 0) this.emit('error', t, err);
    });
    t.on('warning', (m) => this.emit('warning', `${t.infoHashHex}: ${m}`));
    t.on('metadata', () => {
      if (t.metainfo) this.torrentFiles.set(t.infoHashHex, torrentFileFromInfo(t.metainfo.info, t.magnet?.trackers ?? []));
      this.emit('metadata', t);
      void this.saveResumeData(t);
    });
    t.on('seedLimitReached', () => {
      this.emit('seedLimitReached', t);
      const action = this.settingsValue.seedLimitAction;
      if (action === 'pause') void this.pauseTorrent(t.infoHashHex);
      else if (action === 'remove') void this.removeTorrent(t.infoHashHex, false);
    });
  }

  getTorrent(id: string): Torrent | undefined {
    return this.torrentsById.get(id.toLowerCase());
  }

  getTorrents(): Torrent[] {
    return [...this.torrentsById.values()].sort((a, b) => a.queuePosition - b.queuePosition);
  }

  getStats(): TorrentStats[] {
    return this.getTorrents().map((t) => t.getStats());
  }

  private require(id: string): Torrent {
    const t = this.getTorrent(id);
    if (!t) throw new TorrentEngineError('session', `unknown torrent ${id}`);
    return t;
  }

  async removeTorrent(id: string, deleteData: boolean): Promise<void> {
    const t = this.require(id);
    this.torrentsById.delete(t.infoHashHex);
    this.torrentFiles.delete(t.infoHashHex);
    await t.close({ deleteData, announce: true });
    if (this.settingsValue.resumeDataDir) await deleteResumeData(this.settingsValue.resumeDataDir, t.infoHashHex);
    t.removeAllListeners();
    this.emit('torrentRemoved', t.infoHashHex);
    this.scheduleQueue();
  }

  async pauseTorrent(id: string): Promise<void> {
    const t = this.require(id);
    await t.pause();
    await this.saveResumeData(t);
    this.scheduleQueue();
  }

  async resumeTorrent(id: string): Promise<void> {
    const t = this.require(id);
    t.resume();
    this.scheduleQueue();
    await this.saveResumeData(t);
  }

  /** Asks trackers and the DHT for fresh peers of a torrent; null while it is not networking. */
  reannounceTorrent(id: string): { trackers: number; dht: boolean } | null {
    return this.require(id).reannounce();
  }

  /** Changes a torrent's category; with `move` the payload follows the category save path. */
  async setCategory(id: string, category: string, move = false): Promise<void> {
    const t = this.require(id);
    t.category = category;
    const target = this.settingsValue.categories[category]?.savePath;
    if (move && target && target !== t.savePath) await t.moveStorage(target);
    await this.saveResumeData(t);
  }

  /**
   * Updates settings. Rate limits, queue limits and the encryption policy apply
   * immediately; use `bindTo`/`setListenPort` for sockets (also needed for `tcp`, `utp`,
   * `ipv6` and `dht` to take effect).
   */
  updateSettings(patch: Partial<SessionSettings>): void {
    const { listenAddress: _a, listenPort: _p, ...rest } = patch;
    void _a;
    void _p;
    this.settingsValue = { ...this.settingsValue, ...rest };
    this.uploadBucket.setRate(this.settingsValue.uploadLimit);
    this.downloadBucket.setRate(this.settingsValue.downloadLimit);
    this.scheduleQueue();
  }

  /**
   * Closes peer connections until the session is within `maxConnections` (after it was
   * lowered), the ones moving the least data first. Returns how many were closed.
   */
  trimConnections(): number {
    const excess = this.connectionCount() - this.settingsValue.maxConnections;
    if (excess <= 0) return 0;
    const load = [...this.torrentsById.values()].flatMap((t) => t.connectionLoad()).sort((a, b) => a.rate - b.rate);
    const closing = load.slice(0, excess);
    for (const c of closing) c.close();
    return closing.length;
  }

  // ---- queueing ---------------------------------------------------------------------------------

  /**
   * Moves a torrent in the queue. Unfinished torrents move among the unfinished ones (the
   * download queue) and finished ones among the finished (the seed queue), so "up" always
   * passes a torrent that competes for the same kind of slot. Returns false when it was
   * already at that end.
   */
  async moveInQueue(id: string, move: QueueMove): Promise<boolean> {
    const t = this.require(id);
    const all = this.getTorrents();
    const peers = all.filter((o) => o.isComplete === t.isComplete);
    const at = peers.indexOf(t);
    let target: Torrent | undefined;
    let after = false;
    if (move === 'top') target = at > 0 ? peers[0] : undefined;
    else if (move === 'up') target = at > 0 ? peers[at - 1] : undefined;
    else if (move === 'down') [target, after] = [at < peers.length - 1 ? peers[at + 1] : undefined, true];
    else [target, after] = [at < peers.length - 1 ? peers[peers.length - 1] : undefined, true];
    if (!target) return false;
    const order = all.filter((o) => o !== t);
    order.splice(order.indexOf(target) + (after ? 1 : 0), 0, t);
    const changed: Torrent[] = [];
    order.forEach((o, i) => {
      if (o.queuePosition !== i) changed.push(o);
      o.queuePosition = i;
    });
    this.nextQueuePosition = order.length;
    this.scheduleQueue();
    for (const o of changed) await this.saveResumeData(o);
    return true;
  }

  /** Force start: the torrent runs regardless of the active limits and does not take a slot. */
  async setForceStart(id: string, enabled: boolean): Promise<void> {
    const t = this.require(id);
    if (t.forceStart === enabled) return;
    t.forceStart = enabled;
    this.scheduleQueue();
    await this.saveResumeData(t);
  }

  private scheduleQueue(): void {
    if (this.queueScheduled || this.stopping) return;
    this.queueScheduled = true;
    queueMicrotask(() => {
      this.queueScheduled = false;
      this.applyQueue();
    });
  }

  private applyQueue(): void {
    if (!this.started || this.stopping) return;
    let downloads = 0;
    let seeds = 0;
    const s = this.settingsValue;
    for (const t of this.getTorrents()) {
      const slot = t.wantsSlot;
      if (slot === 'none') {
        if (t.isActive) void t.setActive(false);
        continue;
      }
      if (t.forceStart) {
        if (!t.isActive) void t.setActive(true);
        continue;
      }
      const limit = slot === 'download' ? s.maxActiveDownloads : s.maxActiveSeeds;
      const used = slot === 'download' ? downloads : seeds;
      if (limit < 0 || used < limit) {
        if (slot === 'download') downloads++;
        else seeds++;
        if (!t.isActive) void t.setActive(true);
      } else if (t.isActive) void t.setActive(false);
    }
    this.shareCache();
  }

  /**
   * Splits cacheBytesTotal across the downloading torrents, each at most cacheBytesPerTorrent,
   * and gives each a write backlog of half its cache share: memory stays bounded however many
   * torrents download at once.
   */
  private shareCache(): void {
    const s = this.settingsValue;
    const downloading = this.getTorrents().filter((t) => t.wantsSlot === 'download' && (t.isActive || t.forceStart));
    if (downloading.length === 0) return;
    const share = Math.max(CACHE_SHARE_MIN, Math.min(s.cacheBytesPerTorrent, Math.floor(s.cacheBytesTotal / downloading.length)));
    const backlog = Math.max(CACHE_SHARE_MIN, Math.floor(share / 2));
    for (const t of downloading) t.setMemoryBudget(share, backlog);
  }

  // ---- network binding ------------------------------------------------------------------------

  /**
   * Re-binds the listener, DHT, outgoing peer connections and tracker requests to `address`
   * (null = all interfaces). Existing peer connections are dropped and torrents reconnect.
   */
  async bindTo(address: string | null): Promise<void> {
    this.settingsValue = { ...this.settingsValue, listenAddress: address };
    await this.rebindAll(this.listenPort || this.settingsValue.listenPort, address);
  }

  /** Moves the listener and DHT to another port; torrents re-announce the new port. */
  async setListenPort(port: number): Promise<void> {
    this.settingsValue = { ...this.settingsValue, listenPort: port };
    await this.rebindAll(port, this.settingsValue.listenAddress);
  }

  private async rebindAll(port: number, address: string | null): Promise<void> {
    const active = this.getTorrents().filter((t) => t.isActive);
    await Promise.all(active.map((t) => t.setActive(false)));
    if (this.started) await this.openSockets(port, address);
    this.scheduleQueue();
  }

  // ---- persistence ------------------------------------------------------------------------------

  async saveResumeData(t: Torrent): Promise<void> {
    const dir = this.settingsValue.resumeDataDir;
    if (!dir || !this.torrentsById.has(t.infoHashHex)) return;
    // Mid-check the bitfield is partial (or empty while waiting); keep the last good file.
    if (t.state === 'checking') return;
    try {
      await saveResumeData(dir, await t.resumeData(), this.torrentFiles.get(t.infoHashHex));
    } catch (err) {
      this.emit('warning', `saving resume data for ${t.infoHashHex} failed: ${errorMessage(err)}`);
    }
  }

  async saveAllResumeData(): Promise<void> {
    for (const t of this.torrentsById.values()) await this.saveResumeData(t);
  }

  /** Registers every saved torrent; returns the background checks (see `start`). */
  private async restore(): Promise<{ checked: Promise<void> }> {
    const pending: { t: Torrent; r: ResumeData }[] = [];
    const dir = this.settingsValue.resumeDataDir as string;
    const records: ResumeData[] = [];
    for (const id of await listResumeData(dir)) {
      if (this.torrentsById.has(id)) continue;
      const r = await loadResumeData(dir, id);
      if (r) records.push(r);
    }
    // Re-add in saved queue order (files without one keep their add order, after the rest).
    records.sort(
      (a, b) =>
        (a.queuePosition ?? Number.MAX_SAFE_INTEGER) - (b.queuePosition ?? Number.MAX_SAFE_INTEGER) ||
        a.addedAt.localeCompare(b.addedAt),
    );
    for (const r of records) {
      const id = r.infoHash;
      let torrent: Buffer | null = null;
      try {
        torrent = await readFile(torrentPath(dir, id));
      } catch {
        torrent = null;
      }
      const input: AddTorrentOptions = {
        savePath: r.savePath,
        category: r.category,
        tags: r.tags,
        paused: r.paused,
        sequential: r.sequential,
      };
      if (r.filePriorities.length > 0) input.filePriorities = r.filePriorities;
      if (r.seedRatioLimit !== null) input.seedRatioLimit = r.seedRatioLimit;
      if (r.seedTimeLimitMs !== null) input.seedTimeLimitMs = r.seedTimeLimitMs;
      if (torrent) input.torrent = torrent;
      else if (r.magnet) input.magnet = r.magnet;
      else continue;
      try {
        const t = this.register(input, r);
        t.markCheckPending();
        pending.push({ t, r });
      } catch (err) {
        this.emit('warning', `restoring ${id} failed: ${errorMessage(err)}`);
      }
    }
    // Check RESTORE_CHECKS at a time: fast-resume takes milliseconds, a full recheck reads every
    // byte, and several at once only make the disk seek.
    const next = async (): Promise<void> => {
      for (let job = pending.shift(); job && !this.stopping; job = pending.shift()) {
        const { t, r } = job;
        if (!this.torrentsById.has(t.infoHashHex)) continue;
        await this.activate(t, r).catch((err: unknown) => this.emit('warning', `restoring ${t.infoHashHex} failed: ${errorMessage(err)}`));
      }
    };
    // Wrapped so `start` can return without awaiting it (awaiting a promise of a promise waits for both).
    return { checked: Promise.all(Array.from({ length: RESTORE_CHECKS }, next)).then(() => undefined) };
  }

  // ---- events helpers ---------------------------------------------------------------------------

  onStateChange(cb: (torrent: Torrent, prev: TorrentState, next: TorrentState) => void): () => void {
    this.on('stateChange', cb);
    return () => this.off('stateChange', cb);
  }

  onCompleted(cb: (torrent: Torrent) => void): () => void {
    this.on('completed', cb);
    return () => this.off('completed', cb);
  }

  onError(cb: (torrent: Torrent, error: Error) => void): () => void {
    this.on('error', cb);
    return () => this.off('error', cb);
  }

  getSessionStats(): SessionStats {
    let down = 0;
    let up = 0;
    for (const t of this.torrentsById.values()) {
      const s = t.getStats();
      down += s.downloadRate;
      up += s.uploadRate;
    }
    return {
      torrents: this.torrentsById.size,
      connections: this.connectionCount(),
      downloadRate: down,
      uploadRate: up,
      dhtNodes: this.dhtNode?.nodeCount ?? 0,
      dht6Nodes: this.dht6Node?.nodeCount ?? 0,
      utpConnections: this.utp.connectionCount,
      listenPort: this.listenPort,
      listenAddress: this.settingsValue.listenAddress,
    };
  }

  /** Saves resume data, announces `stopped` to trackers and closes every socket. */
  async shutdown(): Promise<void> {
    if (this.stopping) return;
    await this.saveAllResumeData();
    this.stopping = true;
    if (this.resumeTimer) clearInterval(this.resumeTimer);
    await Promise.all([...this.torrentsById.values()].map((t) => t.close({ announce: true })));
    await this.listener.close();
    this.utp.close();
    for (const u of this.ownUdp.splice(0)) u.close();
    this.closeDht(4);
    this.closeDht(6);
  }
}

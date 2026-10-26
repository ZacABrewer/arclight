import { randomInt } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { encode } from './bencode.js';
import type { PeerAddress } from './compact.js';
import { DHT, type DhtOptions } from './dht/dht.js';
import { errorMessage, TorrentEngineError } from './errors.js';
import { type MagnetLink, parseMagnet } from './magnet.js';
import { type Metainfo, parseTorrent } from './metainfo.js';
import { PeerListener } from './peer/listener.js';
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
import { Torrent, type TorrentContext, type TorrentInit, type TorrentState, type TorrentStats } from './torrent.js';
import { createTrackerClient, type TrackerClientFactoryOptions } from './tracker/tracker-manager.js';
import type { TrackerClient } from './tracker/types.js';

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
}

export interface SessionOptions {
  settings?: Partial<SessionSettings>;
  /** Peer blocklist hook: return true to refuse an IP (incoming and outgoing). */
  isBlocked?: (ip: string) => boolean;
  /** Override tracker clients (tests inject fakes here). */
  trackerClientFactory?: (url: string, opts: TrackerClientFactoryOptions) => TrackerClient | null;
  /** Extra DHT options (timeouts, saved nodes, socket factory). */
  dht?: Partial<DhtOptions>;
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
  listenPort: number;
  listenAddress: string | null;
}

const PEER_ID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function generatePeerId(prefix: string): Buffer {
  const p = Buffer.from(prefix, 'latin1').subarray(0, 20);
  let rest = '';
  for (let i = p.length; i < 20; i++) rest += PEER_ID_CHARS[randomInt(0, PEER_ID_CHARS.length)];
  return Buffer.concat([p, Buffer.from(rest, 'latin1')]);
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
  private readonly uploadBucket: TokenBucket;
  private readonly downloadBucket: TokenBucket;
  private readonly now: () => number;
  private nextQueuePosition = 0;
  private queueScheduled = false;
  private resumeTimer: NodeJS.Timeout | undefined;
  private started = false;
  private stopping = false;
  private boundPort = 0;

  constructor(private readonly opts: SessionOptions = {}) {
    super();
    this.settingsValue = { ...DEFAULT_SETTINGS, ...opts.settings };
    this.now = opts.now ?? Date.now;
    this.peerId = generatePeerId(this.settingsValue.peerIdPrefix);
    this.uploadBucket = new TokenBucket(this.settingsValue.uploadLimit);
    this.downloadBucket = new TokenBucket(this.settingsValue.downloadLimit);
    const lOpts: ConstructorParameters<typeof PeerListener>[0] = {};
    if (opts.isBlocked) lOpts.isBlocked = opts.isBlocked;
    this.listener = new PeerListener(lOpts);
    this.listener.on('connection', (sock, hs, address) => {
      const t = this.torrentsById.get(hs.infoHash.toString('hex'));
      if (!t || this.stopping || !this.canConnect() || !t.acceptIncoming(sock, address)) sock.destroy();
    });
    this.listener.on('warning', (m) => this.emit('warning', m));
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

  /** Binds the listener and DHT, then restores torrents from the resume directory. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.openSockets(this.settingsValue.listenPort, this.settingsValue.listenAddress);
    if (this.settingsValue.resumeDataDir) await this.restore();
    this.scheduleResumeSaves();
    this.scheduleQueue();
  }

  private async openSockets(port: number, address: string | null): Promise<void> {
    await this.listener.listen(port, address ?? undefined);
    this.boundPort = this.listener.port;
    if (this.settingsValue.dht) {
      if (!this.dhtNode) {
        const dOpts: DhtOptions = { bootstrap: this.settingsValue.dhtBootstrapNodes, ...this.opts.dht };
        this.dhtNode = new DHT(dOpts);
        this.dhtNode.on('warning', (m) => this.emit('warning', m));
        await this.bindDht(this.boundPort, address);
        void this.dhtNode.bootstrap().catch((err: unknown) => this.emit('warning', `dht bootstrap failed: ${errorMessage(err)}`));
      } else {
        await this.dhtNode.rebind(this.boundPort, address ?? undefined).catch(() => this.dhtNode?.rebind(0, address ?? undefined));
      }
    }
  }

  private async bindDht(port: number, address: string | null): Promise<void> {
    const dht = this.dhtNode as DHT;
    try {
      await dht.listen(port, address ?? undefined);
    } catch {
      await dht.listen(0, address ?? undefined);
    }
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
      dht: () => this.dhtNode,
      canConnect: () => this.canConnect(),
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

  /** Adds a torrent from .torrent bytes or a magnet URI. Throws `TorrentEngineError('session')` on duplicates. */
  async addTorrent(input: AddTorrentOptions, resume?: ResumeData): Promise<Torrent> {
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
    const t = new Torrent(this.context(), init);
    if (input.magnet) t.magnetUri = input.magnet;
    t.queuePosition = this.nextQueuePosition++;
    if (input.torrent) this.torrentFiles.set(id, Buffer.from(input.torrent));
    this.torrentsById.set(id, t);
    this.wire(t);
    if (input.peers) t.addPeers(input.peers, 'manual');
    this.emit('torrentAdded', t);
    await t.init(resume);
    this.scheduleQueue();
    await this.saveResumeData(t);
    return t;
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

  /** Changes a torrent's category; with `move` the payload follows the category save path. */
  async setCategory(id: string, category: string, move = false): Promise<void> {
    const t = this.require(id);
    t.category = category;
    const target = this.settingsValue.categories[category]?.savePath;
    if (move && target && target !== t.savePath) await t.moveStorage(target);
    await this.saveResumeData(t);
  }

  /** Updates settings. Rate limits and queue limits apply immediately; use `bindTo`/`setListenPort` for sockets. */
  updateSettings(patch: Partial<SessionSettings>): void {
    const { listenAddress: _a, listenPort: _p, ...rest } = patch;
    void _a;
    void _p;
    this.settingsValue = { ...this.settingsValue, ...rest };
    this.uploadBucket.setRate(this.settingsValue.uploadLimit);
    this.downloadBucket.setRate(this.settingsValue.downloadLimit);
    this.scheduleQueue();
  }

  // ---- queueing ---------------------------------------------------------------------------------

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
      const limit = slot === 'download' ? s.maxActiveDownloads : s.maxActiveSeeds;
      const used = slot === 'download' ? downloads : seeds;
      if (limit < 0 || used < limit) {
        if (slot === 'download') downloads++;
        else seeds++;
        if (!t.isActive) void t.setActive(true);
      } else if (t.isActive) void t.setActive(false);
    }
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
    try {
      await saveResumeData(dir, await t.resumeData(), this.torrentFiles.get(t.infoHashHex));
    } catch (err) {
      this.emit('warning', `saving resume data for ${t.infoHashHex} failed: ${errorMessage(err)}`);
    }
  }

  async saveAllResumeData(): Promise<void> {
    for (const t of this.torrentsById.values()) await this.saveResumeData(t);
  }

  private async restore(): Promise<void> {
    const dir = this.settingsValue.resumeDataDir as string;
    for (const id of await listResumeData(dir)) {
      if (this.torrentsById.has(id)) continue;
      const r = await loadResumeData(dir, id);
      if (!r) continue;
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
        await this.addTorrent(input, r);
      } catch (err) {
        this.emit('warning', `restoring ${id} failed: ${errorMessage(err)}`);
      }
    }
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
    this.dhtNode?.close();
    this.dhtNode = null;
  }
}

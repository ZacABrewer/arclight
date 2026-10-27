import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { Bitfield } from './bitfield.js';
import { addressKey, hostFamily, normalizeHost, type PeerAddress } from './compact.js';
import type { DHT } from './dht/dht.js';
import { errorMessage, TorrentEngineError } from './errors.js';
import type { MagnetLink } from './magnet.js';
import { type Metainfo, metainfoFromInfo } from './metainfo.js';
import { Choker } from './peer/choker.js';
import { openPeerStream } from './peer/connect.js';
import { type BlockRequest, PeerConnection, type PeerTransport } from './peer/connection.js';
import {
  LOCAL_EXT,
  type MetadataMessage,
  MetadataAssembler,
  metadataPiece,
  PEX_FLAG,
  type PexPeer,
  PexTracker,
} from './peer/extensions.js';
import type { IncomingInfo } from './peer/listener.js';
import type { Handshake } from './peer/messages.js';
import { ALL_PIECES, bitfieldPieces, type PeerPieces, PiecePicker } from './picker.js';
import { consumeAll, RateMeter, TokenBucket } from './rate.js';
import type { SessionSettings } from './settings.js';
import type { ResumeData } from './storage/resume.js';
import { Storage } from './storage/storage.js';
import { TrackerManager, type TrackerStatus } from './tracker/tracker-manager.js';
import type { TrackerClient } from './tracker/types.js';
import type { UtpManager } from './utp/manager.js';
import { WebSeedManager, type WebSeedStats } from './webseed.js';

export type TorrentState =
  | 'checking'
  | 'downloadingMetadata'
  | 'downloading'
  | 'seeding'
  | 'paused'
  | 'queued'
  | 'error';

export type PeerSource = 'tracker' | 'dht' | 'pex' | 'incoming' | 'manual';

export interface TorrentStats {
  infoHash: string;
  name: string;
  state: TorrentState;
  /** 0..1 over the wanted (non-skipped) bytes. */
  progress: number;
  /** Bytes selected for download (skipped files excluded). */
  wantedBytes: number;
  totalBytes: number;
  /** Wanted bytes still missing. */
  bytesLeft: number;
  /** Payload bytes downloaded, all time. */
  downloaded: number;
  /** Payload bytes uploaded, all time. */
  uploaded: number;
  /** Bytes/s (exponential moving average). */
  downloadRate: number;
  uploadRate: number;
  /** Undefined while unknown (stalled, no metadata); 0 once complete. */
  etaSeconds?: number;
  ratio: number;
  connectedPeers: number;
  connectedSeeds: number;
  /** Largest seeder/leecher counts reported by trackers. */
  swarmSeeds: number;
  swarmLeechers: number;
  seedingTimeMs: number;
  activeTimeMs: number;
  addedAt: string;
  completedAt: string | null;
  savePath: string;
  /** Payload root: directory for multi-file torrents, file for single-file ones. */
  contentPath: string;
  category: string;
  tags: string[];
  piecesHave: number;
  pieceCount: number;
  error?: string;
}

export interface PeerStats {
  address: string;
  client: string;
  source: PeerSource;
  incoming: boolean;
  progress: number;
  downloadRate: number;
  uploadRate: number;
  amChoking: boolean;
  amInterested: boolean;
  peerChoking: boolean;
  peerInterested: boolean;
  snubbed: boolean;
  outstandingRequests: number;
  /** The connection is RC4-encrypted (MSE). */
  encrypted: boolean;
  transport: PeerTransport;
}

/** Per-torrent and per-peer rate limits in bytes/s (0 = unlimited). */
export interface TorrentRateLimits {
  uploadLimit: number;
  downloadLimit: number;
  peerUploadLimit: number;
  peerDownloadLimit: number;
}

export interface FileStats {
  index: number;
  path: string;
  length: number;
  priority: number;
  /** 0..1 by verified pieces. */
  progress: number;
}

/** What a torrent needs from its session. */
export interface TorrentContext {
  peerId: Buffer;
  settings: () => SessionSettings;
  listenPort: () => number;
  localAddress: () => string | undefined;
  uploadBuckets: TokenBucket[];
  downloadBuckets: TokenBucket[];
  dht: () => DHT | null;
  /** Every running DHT node (IPv4 and IPv6). */
  dhts: () => DHT[];
  /** The uTP manager when uTP is enabled and bound. */
  utp: () => UtpManager | null;
  /** Global connection budget check. */
  canConnect: () => boolean;
  /**
   * Blocks this session may still request while a global download limit is set (Infinity
   * without one). See Session.requestBudget.
   */
  requestBudget: () => number;
  /** Takes a slot for one more outgoing attempt (half-open limit and per-second rate). */
  canOpen: () => boolean;
  isBlocked: (ip: string) => boolean;
  trackerFactory: (url: string) => TrackerClient | null;
  now: () => number;
}

export interface TorrentInit {
  infoHash: Buffer;
  metainfo: Metainfo | null;
  magnet: MagnetLink | null;
  savePath: string;
  category: string;
  tags: string[];
  paused: boolean;
  sequential: boolean;
  filePriorities?: number[];
  /** undefined = session default, null = unlimited. */
  seedRatioLimit?: number | null;
  seedTimeLimitMs?: number | null;
  resume?: ResumeData;
  superSeeding?: boolean;
  limits?: TorrentRateLimits;
}

export interface TorrentEvents {
  stateChange: [prev: TorrentState, next: TorrentState];
  completed: [];
  error: [error: Error];
  /** Metadata became available (after a magnet fetch). */
  metadata: [];
  seedLimitReached: [];
  warning: [message: string];
}

interface PeerInfo {
  key: string;
  conn: PeerConnection;
  source: PeerSource;
  bitfield: Bitfield | null;
  rawBitfield: Buffer | null;
  pendingHaves: number[];
  haveAll: boolean;
  pex: PexTracker;
  metadataInflight: number;
  /** Candidate key of the peer's listen address (to avoid connecting twice). */
  listenKey: string | null;
  /** Super-seeding: the piece currently offered to this peer. */
  offered: number | null;
  /** Blocks the peer asked for, served one at a time (see `serveUploads`). */
  uploads: { index: number; begin: number; length: number }[];
  uploading: boolean;
}

interface Candidate {
  addr: PeerAddress;
  source: PeerSource;
  failures: number;
  nextAttemptAt: number;
  connected: boolean;
  banned: boolean;
  /** Advertised uTP support (PEX flag). */
  utp: boolean;
  /** MSE failed against this peer once: with `preferred`, connect in plaintext. */
  plainOnly: boolean;
}

const MAX_CANDIDATES = 2000;

/** One torrent: metadata, storage, peers, trackers, DHT/PEX discovery and its state machine. */
export class Torrent extends EventEmitter<TorrentEvents> {
  readonly infoHash: Buffer;
  readonly infoHashHex: string;
  metainfo: Metainfo | null;
  readonly magnet: MagnetLink | null;
  category: string;
  tags: string[];
  sequential: boolean;
  seedRatioLimit: number | null | undefined;
  seedTimeLimitMs: number | null | undefined;
  /**
   * Set by the session: the order the queue serves torrents in (lower first). New torrents go
   * to the end; `Session.moveInQueue` reorders.
   */
  queuePosition = 0;
  /** Runs regardless of the active-download/seed limits (and does not use a slot). */
  forceStart = false;

  private storage: Storage | null = null;
  private picker: PiecePicker | null = null;
  private savePathValue: string;
  private filePriorities: number[] | undefined;
  private readonly peers = new Map<string, PeerInfo>();
  private readonly connecting = new Set<string>();
  private readonly candidates = new Map<string, Candidate>();
  private trackers: TrackerManager | null = null;
  private choker: Choker;
  private readonly assembler: MetadataAssembler;
  private timers: NodeJS.Timeout[] = [];
  private networking = false;
  private userPaused: boolean;
  private active = false;
  private checking = false;
  private moving = false;
  private failure: Error | null = null;
  private seedLimitHit = false;
  private wantedLeft = 0;
  private lastState: TorrentState;
  private readonly downMeter: RateMeter;
  private readonly upMeter: RateMeter;
  private downloadedBase = 0;
  private uploadedBase = 0;
  private downloadedSession = 0;
  private uploadedSession = 0;
  private seedingTimeMs = 0;
  private activeTimeMs = 0;
  private lastTick: number;
  private lastChoke = 0;
  private lastPex = 0;
  private readonly addedAt: string;
  private completedAt: string | null = null;
  private hashFailures = 0;
  private closed = false;
  private superSeedingValue: boolean;
  /** How many peers each piece was offered to while super-seeding. */
  private superOffers = new Map<number, number>();
  private limits: TorrentRateLimits;
  private readonly uploadBucket: TokenBucket;
  private readonly downloadBucket: TokenBucket;
  private webSeeds: WebSeedManager | null = null;
  private webSeedPickerSeeds = 0;

  constructor(
    private readonly ctx: TorrentContext,
    init: TorrentInit,
  ) {
    super();
    this.infoHash = init.infoHash;
    this.infoHashHex = init.infoHash.toString('hex');
    this.metainfo = init.metainfo;
    this.magnet = init.magnet;
    this.savePathValue = init.savePath;
    this.category = init.category;
    this.tags = init.tags;
    this.userPaused = init.paused;
    this.sequential = init.sequential;
    this.filePriorities = init.filePriorities;
    this.seedRatioLimit = init.seedRatioLimit;
    this.seedTimeLimitMs = init.seedTimeLimitMs;
    this.superSeedingValue = init.superSeeding ?? false;
    this.limits = init.limits ?? { uploadLimit: 0, downloadLimit: 0, peerUploadLimit: 0, peerDownloadLimit: 0 };
    this.uploadBucket = new TokenBucket(this.limits.uploadLimit);
    this.downloadBucket = new TokenBucket(this.limits.downloadLimit);
    this.assembler = new MetadataAssembler(init.infoHash, ctx.now);
    this.downMeter = new RateMeter(5000, ctx.now);
    this.upMeter = new RateMeter(5000, ctx.now);
    this.choker = new Choker({ uploadSlots: ctx.settings().uploadSlotsPerTorrent, now: ctx.now });
    this.lastTick = ctx.now();
    this.addedAt = new Date(ctx.now()).toISOString();
    const r = init.resume;
    if (r) {
      this.downloadedBase = r.downloaded;
      this.uploadedBase = r.uploaded;
      this.seedingTimeMs = r.seedingTimeMs;
      this.activeTimeMs = r.activeTimeMs;
      this.addedAt = r.addedAt;
      this.completedAt = r.completedAt;
    }
    for (const p of init.magnet?.peers ?? []) this.addCandidate(p, 'manual');
    this.lastState = this.state;
  }

  // ---- public accessors ---------------------------------------------------------------------

  get name(): string {
    return this.metainfo?.name ?? this.magnet?.name ?? this.infoHashHex;
  }

  get savePath(): string {
    return this.savePathValue;
  }

  get hasMetadata(): boolean {
    return this.metainfo !== null;
  }

  /** All wanted pieces are verified. */
  get isComplete(): boolean {
    return this.metainfo !== null && this.storage !== null && !this.checking && this.wantedLeft === 0;
  }

  get isPaused(): boolean {
    return this.userPaused;
  }

  get state(): TorrentState {
    if (this.failure) return 'error';
    if (this.checking) return 'checking';
    if (this.userPaused) return 'paused';
    if (!this.active) return 'queued';
    if (!this.metainfo) return 'downloadingMetadata';
    return this.isComplete ? 'seeding' : 'downloading';
  }

  get error(): Error | null {
    return this.failure;
  }

  /** Blocks requested from peers and not received yet. */
  get outstandingRequests(): number {
    let n = 0;
    for (const p of this.peers.values()) n += p.conn.requests.size;
    return n;
  }

  private torrentRequestBudget(): number {
    const limit = this.limits.downloadLimit;
    return limit > 0 ? Math.max(0, requestBudgetBlocks(limit) - this.outstandingRequests) : Infinity;
  }

  /** Outgoing attempts still connecting (half-open). */
  get connectingCount(): number {
    return this.connecting.size;
  }

  get peerCount(): number {
    return this.peers.size + this.connecting.size;
  }

  /** Which queue slot the torrent competes for (none while paused, checking or failed). */
  get wantsSlot(): 'download' | 'seed' | 'none' {
    if (this.failure || this.checking || this.userPaused || this.closed) return 'none';
    return this.isComplete ? 'seed' : 'download';
  }

  private updateState(): void {
    const next = this.state;
    if (next !== this.lastState) {
      const prev = this.lastState;
      this.lastState = next;
      this.emit('stateChange', prev, next);
    }
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  /** Shows the torrent as checking while it waits its turn for `init` (restored at startup). */
  markCheckPending(): void {
    if (!this.metainfo || this.storage) return;
    this.checking = true;
    this.updateState();
  }

  /** Prepares storage and checks existing data (fast-resume when the saved state still matches). */
  async init(resume?: ResumeData): Promise<void> {
    if (!this.metainfo) {
      this.updateState();
      return;
    }
    await this.setupStorage(resume);
  }

  private async setupStorage(resume?: ResumeData): Promise<void> {
    const meta = this.metainfo as Metainfo;
    if (meta.version === 'v2') {
      this.fail(new TorrentEngineError('session', 'v2-only torrents cannot be downloaded yet'));
      return;
    }
    const settings = this.ctx.settings();
    const opts: ConstructorParameters<typeof Storage>[1] = {
      savePath: this.savePathValue,
      cacheBytes: settings.cacheBytesPerTorrent,
      onWriteDrain: () => {
        for (const p of this.peers.values()) this.requestBlocks(p);
      },
    };
    if (this.filePriorities) opts.filePriorities = this.filePriorities;
    if (settings.incompleteExtension) opts.incompleteExtension = settings.incompleteExtension;
    this.storage = new Storage(meta, opts);
    this.picker = new PiecePicker(this.storage.layout, this.storage.have, {
      sequential: this.sequential,
      requestTimeoutMs: settings.requestTimeoutMs,
      now: this.ctx.now,
    });
    this.picker.setFilePriorities(this.storage.filePriorities);
    this.checking = true;
    this.updateState();
    try {
      const resumed =
        resume !== undefined &&
        resume.pieceCount === meta.pieceCount &&
        (await this.storage.tryResume(Buffer.from(resume.bitfield, 'base64'), resume.fileStats));
      if (!resumed) await this.storage.recheck();
      await this.storage.createEmptyFiles();
    } catch (err) {
      this.checking = false;
      this.fail(err);
      return;
    }
    this.checking = false;
    this.wantedLeft = this.picker.wantedRemaining;
    if (this.wantedLeft === 0 && !this.completedAt) this.completedAt = new Date(this.ctx.now()).toISOString();
    // Peers connected while metadata was missing can now be evaluated.
    for (const p of this.peers.values()) this.applyPendingAvailability(p);
    this.updateState();
  }

  /** Session decision: run networking (true) or wait in the queue (false). */
  async setActive(active: boolean): Promise<void> {
    if (this.active === active) return;
    this.active = active;
    if (active) this.startNetworking();
    else await this.stopNetworking(true);
    this.updateState();
  }

  get isActive(): boolean {
    return this.active;
  }

  pause(): Promise<void> {
    this.userPaused = true;
    const p = this.stopNetworking(true);
    this.active = false;
    this.updateState();
    return p;
  }

  /**
   * Asks for fresh peers now: announces to every tracker (ignoring their min interval), runs a
   * DHT lookup when DHT applies (not for private torrents) and retries known candidates. Null
   * while the torrent is not networking (paused, queued, failed); otherwise what was contacted.
   */
  reannounce(): { trackers: number; dht: boolean } | null {
    if (!this.networking) return null;
    const trackers = this.trackers?.forceAnnounce() ?? 0;
    const dht = this.ctx.settings().dht && !(this.metainfo?.private ?? false) && this.ctx.dhts().some((d) => d.listening);
    if (dht) void this.dhtAnnounce();
    for (const c of this.candidates.values()) if (!c.connected && !c.banned) c.nextAttemptAt = 0;
    this.connectMore();
    return { trackers, dht };
  }

  /** Clears the paused flag; the session's queue decides when networking starts. */
  resume(): void {
    this.userPaused = false;
    this.seedLimitHit = false;
    if (this.failure && this.metainfo) {
      this.failure = null;
      void this.setupStorage();
    } else this.failure = null;
    this.updateState();
  }

  private fail(err: unknown): void {
    this.failure = err instanceof Error ? err : new Error(String(err));
    void this.stopNetworking(false);
    this.active = false;
    if (this.listenerCount('error') > 0) this.emit('error', this.failure);
    this.updateState();
  }

  /** Stops everything; optionally deletes downloaded data. */
  async close(opts: { deleteData?: boolean; announce?: boolean } = {}): Promise<void> {
    this.closed = true;
    await this.stopNetworking(opts.announce ?? true);
    this.active = false;
    if (this.storage) {
      if (opts.deleteData) await this.storage.deleteFiles().catch(() => {});
      await this.storage.close();
    }
  }

  /** Re-hashes everything on disk. */
  async forceRecheck(): Promise<void> {
    if (!this.metainfo || !this.storage) return;
    const wasActive = this.active;
    await this.setActive(false);
    await this.setupStorage();
    if (wasActive && !this.userPaused) await this.setActive(true);
  }

  async setFilePriorities(priorities: number[]): Promise<void> {
    this.filePriorities = priorities;
    if (!this.storage || !this.picker) return;
    await this.storage.setFilePriorities(priorities);
    this.picker.setFilePriorities(this.storage.filePriorities);
    this.wantedLeft = this.picker.wantedRemaining;
    for (const p of this.peers.values()) this.updateInterest(p);
    this.updateState();
  }

  setSequential(sequential: boolean): void {
    this.sequential = sequential;
    if (this.picker) this.picker.sequential = sequential;
  }

  /** Moves the payload to another directory. */
  async moveStorage(path: string): Promise<void> {
    if (!this.storage) {
      this.savePathValue = path;
      return;
    }
    this.moving = true;
    try {
      await this.storage.move(path);
      this.savePathValue = path;
    } finally {
      this.moving = false;
    }
  }

  /** Adds peers from outside (tracker, DHT, PEX, manual). PEX flags may advertise uTP. */
  addPeers(addrs: readonly PexPeer[], source: PeerSource = 'manual'): void {
    for (const a of addrs) this.addCandidate(a, source);
    if (this.networking) this.connectMore();
  }

  /** False for addresses we cannot reach from the configured bind address / IPv6 setting. */
  private reachable(host: string): boolean {
    const fam = hostFamily(host);
    if (fam === 0) return false;
    const settings = this.ctx.settings();
    if (fam === 6 && !settings.ipv6) return false;
    const local = this.ctx.localAddress();
    return !local || hostFamily(local) === fam;
  }

  private addCandidate(peer: PexPeer, source: PeerSource): void {
    const addr: PeerAddress = { host: normalizeHost(peer.host), port: peer.port };
    if (addr.port <= 0 || addr.port > 65535 || this.ctx.isBlocked(addr.host) || !this.reachable(addr.host)) return;
    const key = addressKey(addr);
    const utp = ((peer.flags ?? 0) & PEX_FLAG.utp) !== 0;
    const existing = this.candidates.get(key);
    if (existing) {
      if (utp) existing.utp = true;
      return;
    }
    if (this.candidates.size >= MAX_CANDIDATES) return;
    this.candidates.set(key, { addr, source, failures: 0, nextAttemptAt: 0, connected: false, banned: false, utp, plainOnly: false });
  }

  // ---- networking -----------------------------------------------------------------------------

  private startNetworking(): void {
    if (this.networking || this.failure || this.closed) return;
    this.networking = true;
    const settings = this.ctx.settings();
    const isPrivate = this.metainfo?.private ?? false;
    const tiers = this.metainfo?.announceList.length
      ? this.metainfo.announceList
      : (this.magnet?.trackers ?? []).map((t) => [t]);
    if (tiers.length > 0) {
      this.trackers = new TrackerManager({
        infoHash: this.infoHash,
        peerId: this.ctx.peerId,
        tiers,
        getPort: () => this.ctx.listenPort(),
        getStats: () => ({
          uploaded: this.uploadedSession,
          downloaded: this.downloadedSession,
          left: this.picker ? this.picker.wantedBytesLeft() : 16 * 1024,
        }),
        announceToAllTiers: settings.announceToAllTiers,
        clientFactory: this.ctx.trackerFactory,
        minIntervalSec: settings.trackerMinIntervalSec,
        retryBaseSec: settings.trackerRetrySec,
        now: this.ctx.now,
      });
      this.trackers.on('peers', (peers) => this.addPeers(peers, 'tracker'));
      this.trackers.on('error', () => {});
      this.trackers.on('warning', (url, msg) => this.emit('warning', `tracker ${url}: ${msg}`));
      this.trackers.start();
    }
    const tick = setInterval(() => this.tick(), settings.tickIntervalMs);
    tick.unref();
    this.timers.push(tick);
    if (settings.dht && !isPrivate) {
      const dhtTimer = setInterval(() => void this.dhtAnnounce(), settings.dhtAnnounceIntervalMs);
      dhtTimer.unref();
      this.timers.push(dhtTimer);
      void this.dhtAnnounce();
    }
    this.lastTick = this.ctx.now();
    this.startWebSeeds();
    this.connectMore();
  }

  private async stopNetworking(announce: boolean): Promise<void> {
    if (!this.networking) return;
    this.networking = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.stopWebSeeds();
    const trackers = this.trackers;
    this.trackers = null;
    for (const p of [...this.peers.values()]) p.conn.destroy();
    this.peers.clear();
    for (const c of this.candidates.values()) c.connected = false;
    // Half-finished pieces would otherwise sit in the cache until the torrent runs again.
    this.storage?.releaseCache();
    if (trackers) {
      if (announce) await trackers.stop(3000).catch(() => {});
      trackers.close();
    }
  }

  private async dhtAnnounce(): Promise<void> {
    await Promise.all(
      this.ctx.dhts().map(async (dht) => {
        if (!dht.listening || !this.networking) return;
        try {
          const res = await dht.announce(this.infoHash, this.ctx.listenPort());
          if (this.networking) this.addPeers(res.peers, 'dht');
        } catch (err) {
          this.emit('warning', `dht announce failed: ${errorMessage(err)}`);
        }
      }),
    );
  }

  private dhtFor(host: string): DHT | null {
    const fam = hostFamily(host);
    return this.ctx.dhts().find((d) => d.family === fam) ?? null;
  }

  private connectMore(): void {
    if (!this.networking || this.failure) return;
    const settings = this.ctx.settings();
    const max = settings.maxConnectionsPerTorrent;
    // one torrent may use half the session's half-open slots, so the others still get some
    const halfOpenShare = Math.max(4, Math.ceil(settings.maxHalfOpenConnections / 2));
    const now = this.ctx.now();
    const list = [...this.candidates.entries()]
      .filter(([k, c]) => !c.connected && !c.banned && c.nextAttemptAt <= now && !this.connecting.has(k))
      .sort((a, b) => a[1].failures - b[1].failures);
    for (const [key, c] of list) {
      // canOpen last: it spends one of the session's per-second connection tokens
      if (this.peerCount >= max || !this.ctx.canConnect() || this.connecting.size >= halfOpenShare || !this.ctx.canOpen()) break;
      void this.connectTo(key, c);
    }
  }

  /** Transport order for a candidate: uTP first when it advertised uTP, else TCP first. */
  private transportsFor(c: Candidate): PeerTransport[] {
    const settings = this.ctx.settings();
    const utp = settings.utp && this.ctx.utp() !== null;
    const out: PeerTransport[] = [];
    if (utp && c.utp) out.push('utp');
    if (settings.tcp) out.push('tcp');
    if (utp && !c.utp) out.push('utp');
    return out;
  }

  private async connectTo(key: string, c: Candidate): Promise<void> {
    this.connecting.add(key);
    c.connected = true;
    const settings = this.ctx.settings();
    let opened: Awaited<ReturnType<typeof openPeerStream>>;
    try {
      const opts: Parameters<typeof openPeerStream>[1] = {
        infoHash: this.infoHash,
        encryption: settings.encryption,
        transports: this.transportsFor(c),
        timeoutMs: settings.connectTimeoutMs,
        utp: this.ctx.utp(),
        plainOnly: c.plainOnly,
      };
      const local = this.ctx.localAddress();
      if (local) opts.localAddress = local;
      opened = await openPeerStream(c.addr, opts);
    } catch {
      this.connecting.delete(key);
      c.connected = false;
      c.failures++;
      c.nextAttemptAt = this.ctx.now() + settings.peerRetryMs * 2 ** Math.min(c.failures - 1, 5);
      if (c.failures > 6) this.candidates.delete(key);
      return;
    }
    this.connecting.delete(key);
    if (opened.fellBack) c.plainOnly = true;
    if (opened.transport === 'utp') c.utp = true;
    if (!this.networking || this.closed) {
      opened.stream.destroy();
      c.connected = false;
      return;
    }
    const conn = this.makeConnection(opened.stream, false, c.addr, { transport: opened.transport, encrypted: opened.encrypted });
    this.attach(conn, key, c.source, key);
  }

  /** Takes over a stream from the session listener (handshake bytes still unread). */
  acceptIncoming(socket: Duplex, address: PeerAddress, info: IncomingInfo = { transport: 'tcp', encrypted: false }): boolean {
    if (!this.networking || this.peerCount >= this.ctx.settings().maxConnectionsPerTorrent) return false;
    const key = addressKey(address);
    if (this.peers.has(key)) return false;
    const conn = this.makeConnection(socket, true, address, info);
    this.attach(conn, key, 'incoming', null);
    return true;
  }

  private makeConnection(socket: Duplex, incoming: boolean, address: PeerAddress, info: IncomingInfo): PeerConnection {
    const settings = this.ctx.settings();
    return new PeerConnection({
      socket,
      incoming,
      encrypted: info.encrypted,
      transport: info.transport,
      infoHash: this.infoHash,
      peerId: this.ctx.peerId,
      address,
      reserved: { extensions: true, fast: true, dht: settings.dht },
      uploadBuckets: [this.uploadBucket, ...this.ctx.uploadBuckets],
      downloadBuckets: [this.downloadBucket, ...this.ctx.downloadBuckets],
      uploadLimit: this.limits.peerUploadLimit,
      downloadLimit: this.limits.peerDownloadLimit,
      handshakeTimeoutMs: settings.connectTimeoutMs,
      now: this.ctx.now,
    });
  }

  private attach(conn: PeerConnection, key: string, source: PeerSource, listenKey: string | null): void {
    const p: PeerInfo = {
      key,
      conn,
      source,
      bitfield: null,
      rawBitfield: null,
      pendingHaves: [],
      haveAll: false,
      pex: new PexTracker(),
      metadataInflight: 0,
      listenKey,
      offered: null,
      uploads: [],
      uploading: false,
    };
    this.peers.set(key, p);
    conn.on('handshake', (hs) => this.onHandshake(p, hs));
    conn.on('extendedHandshake', (hs) => {
      if (conn.incoming && hs.port) {
        const lk = addressKey({ host: conn.address.host, port: hs.port });
        p.listenKey = lk;
        const existing = this.candidates.get(lk);
        if (existing) existing.connected = true;
        else if (this.candidates.size < MAX_CANDIDATES)
          this.candidates.set(lk, {
            addr: { host: conn.address.host, port: hs.port },
            source: 'incoming',
            failures: 0,
            nextAttemptAt: 0,
            connected: true,
            banned: false,
            utp: conn.transport === 'utp',
            plainOnly: false,
          });
      }
      if (!this.metainfo && hs.metadataSize && conn.remoteExtensionId('ut_metadata')) {
        if (this.assembler.setSize(hs.metadataSize)) this.requestMetadata(p);
      }
    });
    conn.on('bitfield', (bits) => {
      p.rawBitfield = bits;
      this.applyPendingAvailability(p);
    });
    conn.on('have', (i) => this.onHave(p, i));
    conn.on('haveAll', () => {
      p.haveAll = true;
      this.applyPendingAvailability(p);
    });
    conn.on('haveNone', () => this.applyPendingAvailability(p));
    conn.on('interested', () => this.rechoke(false));
    conn.on('notInterested', () => this.rechoke(false));
    conn.on('unchoke', () => this.requestBlocks(p));
    conn.on('requestsDropped', (list) => this.onRequestsDropped(p, list));
    conn.on('piece', (i, begin, data) => void this.onBlock(p, i, begin, data));
    conn.on('request', (i, begin, len) => void this.onPeerRequest(p, i, begin, len));
    conn.on('port', (port) => {
      if (!this.metainfo?.private) this.dhtFor(conn.address.host)?.addNode({ host: conn.address.host, port });
    });
    conn.on('metadata', (msg) => this.onMetadataMessage(p, msg));
    conn.on('pex', (msg) => {
      if (this.ctx.settings().pex && !this.metainfo?.private) this.addPeers(msg.added, 'pex');
    });
    conn.on('close', () => this.onPeerClose(p));
  }

  private onHandshake(p: PeerInfo, hs: Handshake): void {
    const conn = p.conn;
    if (hs.peerId.equals(this.ctx.peerId)) {
      // connected to ourselves
      const c = this.candidates.get(p.key);
      if (c) c.banned = true;
      conn.destroy();
      return;
    }
    for (const other of this.peers.values()) {
      if (other === p || !other.conn.remotePeerId?.equals(hs.peerId)) continue;
      // Duplicate connection (typically a simultaneous open). Both ends keep the connection
      // initiated by the lower peer id, so they agree on which one survives.
      const initiator = (x: PeerInfo): Buffer => (x.conn.incoming ? hs.peerId : this.ctx.peerId);
      if (other.conn.incoming !== conn.incoming && Buffer.compare(initiator(p), initiator(other)) < 0) {
        other.conn.destroy();
        break;
      }
      conn.destroy();
      return;
    }
    const settings = this.ctx.settings();
    const isPrivate = this.metainfo?.private ?? false;
    const ext: { ut_metadata: number; ut_pex?: number } = { ut_metadata: LOCAL_EXT.ut_metadata };
    if (settings.pex && !isPrivate) ext.ut_pex = LOCAL_EXT.ut_pex;
    const hsOpts: Parameters<PeerConnection['sendExtendedHandshake']>[0] = {
      extensions: ext,
      port: this.ctx.listenPort(),
      client: settings.userAgent,
      reqq: 500,
    };
    if (this.metainfo) hsOpts.metadataSize = this.metainfo.info.length;
    conn.sendExtendedHandshake(hsOpts);
    this.sendAvailability(p);
    const dht = this.dhtFor(conn.address.host);
    if (settings.dht && conn.remoteFlags.dht && dht?.listening) conn.port(dht.port);
  }

  private sendAvailability(p: PeerInfo): void {
    const have = this.storage?.have;
    if (!have || this.checking) {
      if (p.conn.supportsFast) p.conn.haveNone();
      return;
    }
    if (this.superSeedingActive) {
      // BEP 16: pretend to have nothing and reveal one piece at a time.
      if (p.conn.supportsFast) p.conn.haveNone();
      this.superOffer(p);
      return;
    }
    if (p.conn.supportsFast && have.hasAll()) p.conn.haveAll();
    else if (p.conn.supportsFast && have.hasNone()) p.conn.haveNone();
    else if (!have.hasNone()) p.conn.bitfield(have.toBuffer());
  }

  private applyPendingAvailability(p: PeerInfo): void {
    const picker = this.picker;
    const meta = this.metainfo;
    if (!picker || !meta || this.checking) return;
    if (p.haveAll) {
      if (!p.bitfield || !p.bitfield.hasAll()) {
        if (p.bitfield) picker.removePeer(p.bitfield);
        p.bitfield = Bitfield.full(meta.pieceCount);
        picker.addSeed();
      }
    } else if (p.rawBitfield) {
      if (p.rawBitfield.length !== Math.ceil(meta.pieceCount / 8) || Bitfield.hasSpareBits(meta.pieceCount, p.rawBitfield)) {
        p.conn.destroy(new TorrentEngineError('peer', 'invalid bitfield'));
        return;
      }
      if (p.bitfield) picker.removePeer(p.bitfield);
      p.bitfield = new Bitfield(meta.pieceCount, p.rawBitfield);
      p.rawBitfield = null;
      picker.addPeer(p.bitfield);
    }
    if (!p.bitfield) p.bitfield = new Bitfield(meta.pieceCount);
    for (const i of p.pendingHaves.splice(0)) this.onHave(p, i);
    this.updateInterest(p);
    if (this.superSeedingActive && p.offered !== null && p.bitfield.get(p.offered)) this.superAdvance(p);
  }

  private onHave(p: PeerInfo, i: number): void {
    if (!this.metainfo || !p.bitfield || !this.picker || this.checking) {
      if (p.pendingHaves.length < 100_000) p.pendingHaves.push(i);
      // a peer that started without a bitfield (it had nothing): start an empty one
      if (!p.bitfield && this.metainfo && this.picker && !this.checking) this.applyPendingAvailability(p);
      return;
    }
    if (i < 0 || i >= this.metainfo.pieceCount) {
      p.conn.destroy(new TorrentEngineError('peer', `have for invalid piece ${i}`));
      return;
    }
    if (p.haveAll || p.bitfield.get(i)) return;
    p.bitfield.set(i);
    this.picker.addHave(i);
    if (this.superSeedingActive) this.superOnHave(p, i);
    if (!p.conn.amInterested && this.picker.isWanted(i)) {
      p.conn.interested();
    }
    if (!p.conn.peerChoking) this.requestBlocks(p);
  }

  private peerPieces(p: PeerInfo): PeerPieces {
    if (p.haveAll) return ALL_PIECES;
    return p.bitfield ? bitfieldPieces(p.bitfield) : { has: () => false };
  }

  private updateInterest(p: PeerInfo): void {
    if (!this.picker || p.conn.isClosed || !p.conn.handshaken) return;
    const interesting = !this.isComplete && this.picker.isInteresting(this.peerPieces(p));
    if (interesting) {
      p.conn.interested();
      if (!p.conn.peerChoking) this.requestBlocks(p);
    } else p.conn.notInterested();
  }

  private requestBlocks(p: PeerInfo): void {
    const picker = this.picker;
    if (!picker || this.checking || this.moving || !this.networking) return;
    // the disk is behind: blocks already requested still arrive, new ones wait for the drain
    if (this.storage?.writeBackpressure) return;
    const conn = p.conn;
    if (conn.isClosed || conn.peerChoking || !conn.amInterested || this.isComplete) return;
    const depth = conn.isSnubbed() ? 1 : conn.desiredQueueDepth;
    let want = depth - conn.requests.size;
    if (want <= 0) return;
    // Under a download limit, only ~2 s worth of blocks may be outstanding (session-wide and per
    // torrent): pausing reads alone let every peer keep sending what it had been asked for,
    // tens of megabytes with a few hundred peers, which flooded a slow link anyway.
    want = Math.min(want, this.ctx.requestBudget(), this.torrentRequestBudget());
    if (want <= 0) return;
    for (const b of picker.pick(this.peerPieces(p), p.key, want)) conn.request(b.index, b.begin, b.length);
  }

  private onRequestsDropped(p: PeerInfo, list: BlockRequest[]): void {
    if (!this.picker) return;
    for (const r of list) this.picker.release(r.index, r.begin, p.key);
    // Give the freed blocks to other unchoked peers right away.
    for (const other of this.peers.values()) if (other !== p) this.requestBlocks(other);
  }

  private onBlock(p: PeerInfo, index: number, begin: number, data: Buffer): Promise<void> {
    return this.receiveBlock(p.key, index, begin, data, () => this.requestBlocks(p));
  }

  /** Stores a block from a peer or web seed (`key`), verifying the piece once complete. */
  private async receiveBlock(key: string, index: number, begin: number, data: Buffer, refill: () => void): Promise<void> {
    const picker = this.picker;
    const storage = this.storage;
    if (!picker || !storage || storage.have.get(index)) return;
    const res = picker.markReceived(index, begin, key);
    this.downloadedSession += data.length;
    this.downMeter.add(data.length);
    for (const other of res.cancelFrom) this.peers.get(other)?.conn.cancel(index, begin, data.length);
    refill();
    try {
      await storage.writeBlock(index, begin, data);
    } catch (err) {
      if (!this.closed) this.fail(err);
      return;
    }
    if (!res.pieceComplete) return;
    const ok = await storage.verifyPiece(index);
    if (this.closed) return;
    if (!ok) {
      this.hashFailures++;
      picker.pieceFailed(index);
      this.emit('warning', `piece ${index} failed hash check`);
      for (const other of this.peers.values()) this.requestBlocks(other);
      return;
    }
    picker.pieceVerified(index);
    if (picker.piecePriority(index) > 0) this.wantedLeft = Math.max(0, this.wantedLeft - 1);
    for (const other of this.peers.values()) if (!other.haveAll && other.conn.handshaken) other.conn.have(index);
    if (this.wantedLeft === 0) await this.onComplete();
  }

  // ---- web seeds (BEP 19) ---------------------------------------------------------------------

  private startWebSeeds(): void {
    const meta = this.metainfo;
    const settings = this.ctx.settings();
    if (this.webSeeds || !meta || !this.storage || !this.picker || this.isComplete || settings.webSeedConnectionsPerTorrent <= 0) return;
    const urls = [...meta.urlList, ...(this.magnet?.webSeeds ?? [])];
    if (urls.length === 0) return;
    const storage = this.storage;
    const mgr = new WebSeedManager(
      {
        metainfo: meta,
        layout: storage.layout,
        pick: (key, count) => {
          if (!this.picker || this.checking || this.moving || this.isComplete) return [];
          return this.picker.pick(ALL_PIECES, key, count);
        },
        release: (index, begin, key) => this.picker?.release(index, begin, key),
        deliver: (key, index, begin, data) => void this.receiveBlock(key, index, begin, data, () => {}),
        wantsData: () => this.networking && !this.isComplete && !this.checking && !this.moving,
        consumeDownload: (bytes) => consumeAll([this.downloadBucket, ...this.ctx.downloadBuckets], bytes),
        localAddress: () => this.ctx.localAddress(),
        now: this.ctx.now,
      },
      urls,
      { maxConnections: settings.webSeedConnectionsPerTorrent, retryMs: settings.webSeedRetryMs, userAgent: settings.userAgent, timeoutMs: settings.requestTimeoutMs },
    );
    if (mgr.count === 0) return;
    this.webSeeds = mgr;
    // web seeds have every piece: count them in availability like seeds
    for (let i = 0; i < mgr.count; i++) this.picker.addSeed();
    this.webSeedPickerSeeds = mgr.count;
    mgr.tick();
  }

  private stopWebSeeds(): void {
    this.webSeeds?.close();
    this.webSeeds = null;
    for (; this.webSeedPickerSeeds > 0; this.webSeedPickerSeeds--) this.picker?.removeSeed();
  }

  /** Web seed status (empty when the torrent has none or is not running). */
  getWebSeeds(): WebSeedStats[] {
    return this.webSeeds?.stats() ?? [];
  }

  // ---- super-seeding (BEP 16) -----------------------------------------------------------------

  get superSeeding(): boolean {
    return this.superSeedingValue;
  }

  private get superSeedingActive(): boolean {
    return this.superSeedingValue && this.isComplete;
  }

  /** Turns super-seeding on or off. Turning it off reveals full availability to every peer. */
  setSuperSeeding(on: boolean): void {
    if (this.superSeedingValue === on) return;
    const wasActive = this.superSeedingActive;
    this.superSeedingValue = on;
    if (wasActive && !on) {
      this.superOffers.clear();
      for (const p of this.peers.values()) {
        p.offered = null;
        if (p.conn.handshaken && !p.conn.isClosed && this.storage) p.conn.bitfield(this.storage.have.toBuffer());
      }
    } else if (on && this.superSeedingActive) for (const p of this.peers.values()) if (p.conn.handshaken) this.superOffer(p);
  }

  /** Offers the peer the rarest piece it lacks that was offered least often. */
  private superOffer(p: PeerInfo): void {
    const meta = this.metainfo;
    const picker = this.picker;
    if (!meta || !picker || p.offered !== null || p.haveAll || p.conn.isClosed) return;
    let best = -1;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let i = 0; i < meta.pieceCount; i++) {
      if (p.bitfield?.get(i)) continue;
      const score = (this.superOffers.get(i) ?? 0) * 1_000_000 + picker.availabilityOf(i) * 1000 + Math.random() * 999;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) return;
    p.offered = best;
    this.superOffers.set(best, (this.superOffers.get(best) ?? 0) + 1);
    p.conn.have(best);
  }

  /** The offered piece has spread: give the peer its next one. */
  private superAdvance(p: PeerInfo): void {
    p.offered = null;
    this.superOffer(p);
  }

  private superOnHave(from: PeerInfo, i: number): void {
    for (const q of this.peers.values()) {
      // another peer now has q's piece: q passed it on
      if (q !== from && q.offered === i) this.superAdvance(q);
    }
    if (from.offered === i) {
      const others = [...this.peers.values()].filter((q) => q !== from && q.conn.handshaken && !(q.haveAll || q.bitfield?.hasAll()));
      // with nobody to pass it to, move on right away
      if (others.length === 0) this.superAdvance(from);
    }
  }

  // ---- rate limits ----------------------------------------------------------------------------

  get rateLimits(): TorrentRateLimits {
    return { ...this.limits };
  }

  /** Changes this torrent's limits; applies to existing connections immediately. */
  setRateLimits(patch: Partial<TorrentRateLimits>): void {
    this.limits = { ...this.limits, ...patch };
    this.uploadBucket.setRate(this.limits.uploadLimit);
    this.downloadBucket.setRate(this.limits.downloadLimit);
    for (const p of this.peers.values()) p.conn.setLimits(this.limits.peerUploadLimit, this.limits.peerDownloadLimit);
  }

  private async onComplete(): Promise<void> {
    if (this.completedAt === null || this.downloadedSession > 0) this.completedAt = new Date(this.ctx.now()).toISOString();
    const settings = this.ctx.settings();
    const target = settings.categories[this.category]?.completedSavePath ?? settings.completedSavePath;
    for (const p of this.peers.values()) this.updateInterest(p);
    this.stopWebSeeds();
    if (target && target !== this.savePathValue && this.storage) {
      try {
        await this.moveStorage(target);
      } catch (err) {
        this.emit('warning', `move on completion failed: ${errorMessage(err)}`);
      }
    }
    this.trackers?.completed();
    this.updateState();
    this.emit('completed');
  }

  private async onPeerRequest(p: PeerInfo, index: number, begin: number, length: number): Promise<void> {
    const storage = this.storage;
    if (!storage || this.moving || !storage.have.get(index) || !storage.layout.isValidBlock(index, begin, length)) {
      p.conn.rejectRequest(index, begin, length);
      return;
    }
    p.uploads.push({ index, begin, length });
    await this.serveUploads(p);
  }

  /**
   * Serves a peer's requests one block at a time, reading each from disk only when it can be
   * sent. Reading them all up front held every requested block (up to 500 per peer) in memory
   * while the upload limit or a slow VPN uplink let them out, gigabytes across a few seeds.
   */
  private async serveUploads(p: PeerInfo): Promise<void> {
    if (p.uploading) return;
    p.uploading = true;
    try {
      for (let r = p.uploads.shift(); r; r = p.uploads.shift()) {
        // Cancelled, choked away or disconnected while it waited.
        if (!p.conn.hasPeerRequest(r.index, r.begin, r.length)) continue;
        const storage = this.storage;
        if (!storage || this.moving) {
          p.conn.rejectRequest(r.index, r.begin, r.length);
          continue;
        }
        try {
          const data = await storage.read(r.index, r.begin, r.length);
          if (await p.conn.sendPiece(r.index, r.begin, data)) {
            this.uploadedSession += r.length;
            this.upMeter.add(r.length);
          }
        } catch {
          p.conn.rejectRequest(r.index, r.begin, r.length);
        }
      }
    } finally {
      p.uploading = false;
    }
  }

  private onPeerClose(p: PeerInfo): void {
    if (this.peers.get(p.key) === p) this.peers.delete(p.key);
    if (p.offered !== null) {
      const n = (this.superOffers.get(p.offered) ?? 1) - 1;
      if (n > 0) this.superOffers.set(p.offered, n);
      else this.superOffers.delete(p.offered);
    }
    if (this.picker) {
      if (p.haveAll && p.bitfield) this.picker.removeSeed();
      else if (p.bitfield) this.picker.removePeer(p.bitfield);
      this.picker.releasePeer(p.key);
    }
    this.assembler.release(p.key);
    for (const k of [p.key, p.listenKey]) {
      if (!k) continue;
      const c = this.candidates.get(k);
      if (c) {
        c.connected = false;
        c.nextAttemptAt = this.ctx.now() + this.ctx.settings().peerRetryMs * (0.5 + Math.random());
      }
    }
    if (this.networking) {
      this.rechoke(false);
      for (const other of this.peers.values()) this.requestBlocks(other);
    }
  }

  // ---- metadata exchange (BEP 9) -------------------------------------------------------------

  private requestMetadata(p: PeerInfo): void {
    while (!this.metainfo && p.metadataInflight < 2) {
      const piece = this.assembler.nextRequest(p.key);
      if (piece === null) return;
      p.metadataInflight++;
      if (!p.conn.sendMetadata({ msgType: 0, piece })) return;
    }
  }

  private onMetadataMessage(p: PeerInfo, msg: MetadataMessage): void {
    if (msg.msgType === 0) {
      const piece = this.metainfo ? metadataPiece(this.metainfo.info, msg.piece) : null;
      if (piece && this.metainfo) p.conn.sendMetadata({ msgType: 1, piece: msg.piece, totalSize: this.metainfo.info.length, data: piece });
      else p.conn.sendMetadata({ msgType: 2, piece: msg.piece });
      return;
    }
    p.metadataInflight = Math.max(0, p.metadataInflight - 1);
    if (this.metainfo) return;
    if (msg.msgType === 2) {
      this.assembler.release(p.key, msg.piece);
      return;
    }
    let info: Buffer | null;
    try {
      info = this.assembler.add(msg.piece, msg.data);
    } catch (err) {
      this.emit('warning', errorMessage(err));
      return;
    }
    if (info) void this.onMetadata(info);
    else this.requestMetadata(p);
  }

  private async onMetadata(info: Buffer): Promise<void> {
    if (this.metainfo) return;
    try {
      this.metainfo = metainfoFromInfo(info, this.magnet?.trackers ?? []);
    } catch (err) {
      this.emit('warning', `metadata rejected: ${errorMessage(err)}`);
      return;
    }
    this.emit('metadata');
    await this.setupStorage();
    if (this.failure) return;
    if (this.networking) this.startWebSeeds();
    for (const p of this.peers.values()) {
      if (p.conn.handshaken && !p.conn.isClosed && !p.conn.supportsFast) this.sendAvailability(p);
      else if (p.conn.handshaken && this.storage && !this.storage.have.hasNone()) p.conn.bitfield(this.storage.have.toBuffer());
    }
    this.updateState();
  }

  // ---- periodic work --------------------------------------------------------------------------

  private rechoke(rotate: boolean): void {
    if (!this.networking) return;
    const seeding = this.isComplete;
    const list = [...this.peers.values()].filter((p) => p.conn.handshaken && !p.conn.isClosed);
    const unchoke = this.choker.run(
      list.map((p) => ({
        id: p.key,
        peerInterested: p.conn.peerInterested,
        downloadRate: p.conn.downloadMeter.rate(),
        uploadRate: p.conn.uploadMeter.rate(),
        snubbed: p.conn.isSnubbed(),
        isSeed: p.haveAll || (p.bitfield?.hasAll() ?? false),
        connectedAt: p.conn.connectedAt,
      })),
      seeding,
      rotate,
    );
    for (const p of list) {
      if (unchoke.has(p.key)) p.conn.unchoke();
      else p.conn.choke();
    }
  }

  private tick(): void {
    if (!this.networking) return;
    const now = this.ctx.now();
    const settings = this.ctx.settings();
    const dt = Math.max(0, now - this.lastTick);
    this.lastTick = now;
    this.activeTimeMs += dt;
    const seeding = this.isComplete;
    if (seeding) this.seedingTimeMs += dt;

    if (now - this.lastChoke >= settings.chokeIntervalMs) {
      this.lastChoke = now;
      this.rechoke(true);
    }
    for (const p of [...this.peers.values()]) {
      const conn = p.conn;
      if (!conn.handshaken) continue;
      if (seeding && (p.haveAll || p.bitfield?.hasAll())) {
        conn.destroy(); // seed to seed
        continue;
      }
      conn.expireRequests(now - settings.requestTimeoutMs);
      this.updateInterest(p);
      if (!this.metainfo && this.assembler.totalSize > 0 && conn.remoteExtensionId('ut_metadata')) {
        p.metadataInflight = 0;
        this.requestMetadata(p);
      }
    }
    for (const e of this.picker?.expire() ?? []) this.peers.get(e.peer)?.conn.cancel(e.index, e.begin, this.storage?.layout.blockSize(e.index, Math.floor(e.begin / 16384)) ?? 16384);
    if (settings.pex && !this.metainfo?.private && now - this.lastPex >= settings.pexIntervalMs) {
      this.lastPex = now;
      this.sendPex();
    }
    if (seeding) this.checkSeedLimits();
    if (this.webSeeds) this.webSeeds.tick();
    else if (!seeding && this.metainfo && (this.metainfo.urlList.length > 0 || (this.magnet?.webSeeds.length ?? 0) > 0)) this.startWebSeeds();
    if (this.superSeedingActive) for (const p of this.peers.values()) if (p.conn.handshaken && p.offered === null) this.superOffer(p);
    // Under a request budget, peers with nothing outstanding get a chance once a tick.
    if (this.limits.downloadLimit > 0 || this.ctx.requestBudget() !== Infinity) {
      for (const p of this.peers.values()) if (p.conn.requests.size === 0 && !p.conn.peerChoking) this.requestBlocks(p);
    }
    this.connectMore();
    if (this.peers.size < 5) this.trackers?.announceNow();
  }

  private sendPex(): void {
    const all = [...this.peers.values()].filter((p) => p.conn.handshaken && !p.conn.isClosed);
    for (const p of all) {
      if (!p.conn.remoteExtensionId('ut_pex')) continue;
      const others: PexPeer[] = all
        .filter((o) => o !== p && (!o.conn.incoming || o.conn.remoteExtensions?.port))
        .map((o) => {
          let flags = 0;
          if (o.conn.encrypted) flags |= PEX_FLAG.prefersEncryption;
          if (o.haveAll || o.bitfield?.hasAll()) flags |= PEX_FLAG.seed;
          if (o.conn.transport === 'utp') flags |= PEX_FLAG.utp;
          if (!o.conn.incoming) flags |= PEX_FLAG.reachable;
          return flags ? { ...o.conn.listenAddress, flags } : o.conn.listenAddress;
        });
      const msg = p.pex.diff(others);
      if (msg) p.conn.sendPex(msg);
    }
  }

  private checkSeedLimits(): void {
    if (this.seedLimitHit) return;
    const settings = this.ctx.settings();
    const ratioLimit = this.seedRatioLimit === undefined ? settings.seedRatioLimit : this.seedRatioLimit;
    const timeLimit = this.seedTimeLimitMs === undefined ? settings.seedTimeLimitMs : this.seedTimeLimitMs;
    const ratioHit = ratioLimit !== null && this.ratio >= ratioLimit;
    const timeHit = timeLimit !== null && this.seedingTimeMs >= timeLimit;
    if (ratioHit || timeHit) {
      this.seedLimitHit = true;
      this.emit('seedLimitReached');
    }
  }

  /** True once a seed limit fired (cleared by `resume`). */
  get seedLimitReached(): boolean {
    return this.seedLimitHit;
  }

  // ---- stats ----------------------------------------------------------------------------------

  get ratio(): number {
    const down = this.downloadedBase + this.downloadedSession;
    const up = this.uploadedBase + this.uploadedSession;
    if (down > 0) return up / down;
    const size = this.metainfo?.totalLength ?? 0;
    return up > 0 && size > 0 ? up / size : 0;
  }

  getStats(): TorrentStats {
    const meta = this.metainfo;
    const storage = this.storage;
    const picker = this.picker;
    let wanted = 0;
    let left = 0;
    if (meta && storage && picker) {
      for (let i = 0; i < storage.layout.pieceCount; i++) {
        if (picker.piecePriority(i) === 0) continue;
        const size = storage.layout.pieceSize(i);
        wanted += size;
        if (!storage.have.get(i)) left += size;
      }
    }
    let seeds = 0;
    let swarmSeeds = 0;
    let swarmLeechers = 0;
    for (const p of this.peers.values()) if (p.haveAll || p.bitfield?.hasAll()) seeds++;
    for (const t of this.trackers?.getTrackers() ?? []) {
      swarmSeeds = Math.max(swarmSeeds, t.seeds ?? 0);
      swarmLeechers = Math.max(swarmLeechers, t.leechers ?? 0);
    }
    const downloadRate = this.downMeter.rate();
    const state = this.state;
    const stats: TorrentStats = {
      infoHash: this.infoHashHex,
      name: this.name,
      state,
      progress: !meta || !storage ? 0 : wanted === 0 ? 1 : (wanted - left) / wanted,
      wantedBytes: wanted,
      totalBytes: meta?.totalLength ?? 0,
      bytesLeft: left,
      downloaded: this.downloadedBase + this.downloadedSession,
      uploaded: this.uploadedBase + this.uploadedSession,
      downloadRate,
      uploadRate: this.upMeter.rate(),
      ratio: this.ratio,
      connectedPeers: this.peers.size,
      connectedSeeds: seeds,
      swarmSeeds,
      swarmLeechers,
      seedingTimeMs: this.seedingTimeMs,
      activeTimeMs: this.activeTimeMs,
      addedAt: this.addedAt,
      completedAt: this.completedAt,
      savePath: this.savePathValue,
      contentPath: join(this.savePathValue, this.name),
      category: this.category,
      tags: [...this.tags],
      piecesHave: storage?.have.count() ?? 0,
      pieceCount: meta?.pieceCount ?? 0,
    };
    if (meta && storage && left === 0) stats.etaSeconds = 0;
    else if (downloadRate > 0 && (state === 'downloading' || state === 'downloadingMetadata')) stats.etaSeconds = Math.ceil(left / downloadRate);
    if (this.failure) stats.error = this.failure.message;
    return stats;
  }

  getPeers(): PeerStats[] {
    const n = this.metainfo?.pieceCount ?? 0;
    return [...this.peers.values()]
      .filter((p) => p.conn.handshaken)
      .map((p) => ({
        address: p.key,
        client: p.conn.remoteExtensions?.client ?? '',
        source: p.source,
        incoming: p.conn.incoming,
        progress: p.haveAll ? 1 : p.bitfield && n > 0 ? p.bitfield.count() / n : 0,
        downloadRate: p.conn.downloadMeter.rate(),
        uploadRate: p.conn.uploadMeter.rate(),
        amChoking: p.conn.amChoking,
        amInterested: p.conn.amInterested,
        peerChoking: p.conn.peerChoking,
        peerInterested: p.conn.peerInterested,
        snubbed: p.conn.isSnubbed(),
        outstandingRequests: p.conn.requests.size,
        encrypted: p.conn.encrypted,
        transport: p.conn.transport,
      }));
  }

  getFiles(): FileStats[] {
    const meta = this.metainfo;
    const storage = this.storage;
    if (!meta || !storage) return [];
    return meta.files
      .filter((f) => !f.padding)
      .map((f) => {
        const range = storage.layout.pieceRange(f.index);
        let progress = 1;
        if (range) {
          let have = 0;
          for (let i = range[0]; i <= range[1]; i++) if (storage.have.get(i)) have++;
          progress = have / (range[1] - range[0] + 1);
        }
        return { index: f.index, path: f.path, length: f.length, priority: storage.filePriorities[f.index] ?? 1, progress };
      });
  }

  getTrackers(): TrackerStatus[] {
    return this.trackers?.getTrackers() ?? [];
  }

  get hashFailureCount(): number {
    return this.hashFailures;
  }

  /** Snapshot for fast resume. */
  async resumeData(): Promise<ResumeData> {
    const storage = this.storage;
    return {
      version: 1,
      infoHash: this.infoHashHex,
      name: this.name,
      bitfield: storage ? storage.have.toBuffer().toString('base64') : '',
      pieceCount: this.metainfo?.pieceCount ?? 0,
      uploaded: this.uploadedBase + this.uploadedSession,
      downloaded: this.downloadedBase + this.downloadedSession,
      seedingTimeMs: this.seedingTimeMs,
      activeTimeMs: this.activeTimeMs,
      addedAt: this.addedAt,
      completedAt: this.completedAt,
      savePath: this.savePathValue,
      category: this.category,
      tags: [...this.tags],
      filePriorities: storage ? [...storage.filePriorities] : (this.filePriorities ?? []),
      paused: this.userPaused,
      sequential: this.sequential,
      fileStats: storage && !this.checking ? await storage.fileStats() : [],
      magnet: this.metainfo ? null : (this.magnetUri ?? null),
      seedRatioLimit: this.seedRatioLimit ?? null,
      seedTimeLimitMs: this.seedTimeLimitMs ?? null,
      superSeeding: this.superSeedingValue,
      ...this.limits,
      queuePosition: this.queuePosition,
      forceStart: this.forceStart,
    };
  }

  /** Original magnet URI, kept so magnets without metadata survive restarts. */
  magnetUri: string | undefined;
}

/** Seconds of data that may be requested ahead while a download limit applies. */
const REQUEST_BUDGET_SECONDS = 2;

/** Blocks that cover REQUEST_BUDGET_SECONDS at `limit` bytes/s (at least 8). */
export function requestBudgetBlocks(limit: number): number {
  return Math.max(8, Math.ceil((limit * REQUEST_BUDGET_SECONDS) / 16384));
}

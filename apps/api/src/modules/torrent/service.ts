import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Logger } from 'pino';
import { attachSeedRules, type SeedRuleProvider } from '@arclight/download-clients';
import { Session, type SessionOptions, type SessionSettings, type Torrent, type TorrentRateLimits } from '@arclight/torrent-engine';
import {
  TORRENT_TRANSPORT_DEFAULTS,
  TorrentSettings,
  type DownloadClientResource,
  type TorrentCounts,
  type TorrentDetail,
  type TorrentEncryptionMode,
  type TorrentEngineState,
  type TorrentLimitsRequest,
  type TorrentListQuery,
  type TorrentPriorityRequest,
  type TorrentSessionStatus,
  type TorrentSettingsResponse,
  type TorrentSettingsUpdate,
  type VpnStatus,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import type { EventBus } from '../../events.js';
import { getSection, setSection } from '../settings/service.js';

// The built-in torrent engine: owns the single `Session`, the `torrent` settings section and
// the VPN binding policy.
//
// VPN behaviour (only when `bindToVpn` is on and the VPN integration is enabled):
// - connected: every socket is bound to the tunnel address (`getTunnelAddress()`); with Gluetun
//   there is none (Arclight shares Gluetun's network namespace), so all interfaces are used,
//   which are the tunnel's. A port forwarded by the VPN replaces `listenPort`.
// - down, leaking, kill switch engaged, or not checked yet ("lockdown"): every running torrent
//   is paused and the listener and DHT are re-bound to 127.0.0.1, so nothing can reach the
//   internet through another interface. The ids paused this way are kept in
//   `<resumeDir>/killswitch-paused.json`; on reconnect (also after a restart) exactly those are
//   resumed, torrents the user paused stay paused.

export interface TorrentVpnPort {
  /** Whether the VPN integration is enabled in settings (status may not be known yet). */
  enabled(): boolean;
  getStatus(): VpnStatus;
  getTunnelAddress(): string | null;
}

export interface TorrentClientRegistry {
  list(): DownloadClientResource[];
  create(input: {
    name: string;
    implementation: 'builtin';
    enable: boolean;
    settings: Record<string, unknown>;
  }): DownloadClientResource;
}

export interface TorrentServiceOptions {
  db: Db;
  configDir: string;
  isDocker: boolean;
  bus?: EventBus | undefined;
  log?: Logger | undefined;
  vpn?: TorrentVpnPort | undefined;
  downloadClients?: TorrentClientRegistry | undefined;
  /** Builds the Session (tests inject fast timers and loopback-only settings). */
  sessionFactory?: (opts: SessionOptions) => Session;
  /** Extra session settings applied on top of the mapped ones (tests). */
  sessionOverrides?: Partial<SessionSettings>;
  /** Bind address when not bound to the VPN. Default null = all interfaces (tests use loopback). */
  defaultAddress?: string | null;
}

export type TorrentModuleErrorCode = 'NOT_FOUND' | 'NOT_RUNNING' | 'CONFLICT' | 'VALIDATION';

export class TorrentModuleError extends Error {
  override readonly name = 'TorrentModuleError';
  constructor(
    readonly code: TorrentModuleErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const LOCKDOWN_ADDRESS = '127.0.0.1';
const KILLSWITCH_FILE = 'killswitch-paused.json';

interface Binding {
  mode: 'open' | 'vpn' | 'lockdown';
  address: string | null;
  port: number;
  reason?: string;
}

export class TorrentService {
  private readonly db: Db;
  private readonly configDir: string;
  private readonly isDocker: boolean;
  private readonly bus: EventBus | undefined;
  private readonly log: Logger | undefined;
  private readonly vpn: TorrentVpnPort | undefined;
  private readonly downloadClients: TorrentClientRegistry | undefined;
  private readonly sessionFactory: (opts: SessionOptions) => Session;
  private readonly sessionOverrides: Partial<SessionSettings>;
  private readonly defaultAddress: string | null;

  private sessionValue: Session | null = null;
  private state: TorrentEngineState = 'disabled';
  private lastError: string | undefined;
  private lockdownReason: string | undefined;
  private killSwitchPaused = new Set<string>();
  /** Serializes start/stop/re-bind so VPN events and settings changes never interleave. */
  private chain: Promise<unknown> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;
  private seedRules: SeedRuleProvider | null = null;

  constructor(opts: TorrentServiceOptions) {
    this.db = opts.db;
    this.configDir = opts.configDir;
    this.isDocker = opts.isDocker;
    this.bus = opts.bus;
    this.log = opts.log;
    this.vpn = opts.vpn;
    this.downloadClients = opts.downloadClients;
    this.sessionFactory = opts.sessionFactory ?? ((o) => new Session(o));
    this.sessionOverrides = opts.sessionOverrides ?? {};
    this.defaultAddress = opts.defaultAddress ?? null;
  }

  /** The running Session, or null while disabled/stopped. */
  get session(): Session | null {
    return this.sessionValue;
  }

  // ---- settings -------------------------------------------------------------------------

  settings(): TorrentSettings {
    return getSection(this.db, 'torrent');
  }

  get resumeDir(): string {
    return join(this.configDir, 'torrents');
  }

  effectiveDownloadsRoot(s: TorrentSettings = this.settings()): string {
    if (s.downloadsRoot) return s.downloadsRoot;
    return this.isDocker ? '/downloads' : resolve(this.configDir, '..', 'downloads');
  }

  settingsResponse(s: TorrentSettings = this.settings()): TorrentSettingsResponse {
    return { ...withTransportDefaults(s), effectiveDownloadsRoot: this.effectiveDownloadsRoot(s), resumeDir: this.resumeDir };
  }

  /**
   * Hit-and-run rules for `builtin` download clients (the tracker-stats module sets them). They
   * are attached to the running Session and to every Session started later.
   */
  setSeedRuleProvider(provider: SeedRuleProvider | null): void {
    this.seedRules = provider;
    if (this.sessionValue) attachSeedRules(this.sessionValue, provider);
  }

  /** Saves a partial update and applies it to the running engine right away. */
  async updateSettings(update: TorrentSettingsUpdate): Promise<TorrentSettingsResponse> {
    const prev = this.settings();
    const merged = TorrentSettings.safeParse({ ...prev, ...stripUndefined(update) });
    if (!merged.success) throw new TorrentModuleError('VALIDATION', merged.error.message);
    const next = setSection(this.db, 'torrent', merged.data);
    this.bus?.publish({ type: 'settings', section: 'torrent' });
    await this.enqueue(() => this.applySettings(prev, next));
    return this.settingsResponse(next);
  }

  private sessionSettings(s: TorrentSettings, binding: Binding): Partial<SessionSettings> {
    const t = withTransportDefaults(s);
    return {
      encryption: t.encryption,
      tcp: t.tcp,
      utp: t.utp,
      ipv6: t.ipv6,
      webSeedConnectionsPerTorrent: t.webSeedConnectionsPerTorrent,
      listenPort: binding.port,
      listenAddress: binding.address,
      maxConnections: s.maxConnections,
      maxConnectionsPerTorrent: s.maxConnectionsPerTorrent,
      downloadLimit: s.downloadLimitKbps * 1024,
      uploadLimit: s.uploadLimitKbps * 1024,
      dht: s.dht,
      pex: s.pex,
      maxActiveDownloads: s.maxActiveDownloads,
      maxActiveSeeds: s.maxActiveSeeds,
      seedRatioLimit: s.defaultSeedRatio,
      seedTimeLimitMs: s.defaultSeedTimeMinutes === null ? null : s.defaultSeedTimeMinutes * 60_000,
      seedLimitAction: 'pause',
      savePath: this.effectiveDownloadsRoot(s),
      resumeDataDir: this.resumeDir,
      ...this.sessionOverrides,
    };
  }

  private async applySettings(prev: TorrentSettings, next: TorrentSettings): Promise<void> {
    if (!next.enabled) {
      await this.doStop();
      return;
    }
    // Socket-level options the Session only reads when it opens its sockets: restart.
    if (!this.sessionValue || prev.dht !== next.dht) {
      await this.doStop();
      await this.doStart();
      return;
    }
    const { listenPort: _p, listenAddress: _a, resumeDataDir: _r, ...live } = this.sessionSettings(next, this.desiredBinding(next));
    void _p;
    void _a;
    void _r;
    this.sessionValue.updateSettings(live);
    // tcp / utp / ipv6 take effect when the Session re-opens its sockets (same port).
    const p = withTransportDefaults(prev);
    const n = withTransportDefaults(next);
    if (p.tcp !== n.tcp || p.utp !== n.utp || p.ipv6 !== n.ipv6) {
      await this.sessionValue.setListenPort(this.sessionValue.listenPort || this.desiredBinding(next).port);
    }
    await this.doApplyBinding();
  }

  // ---- lifecycle --------------------------------------------------------------------------

  /** Boot: subscribe to VPN events, auto-register the client, start the engine when enabled. */
  async boot(): Promise<void> {
    this.subscribe();
    this.autoRegisterClient();
    if (this.settings().enabled) await this.start();
  }

  /** Listen for `vpn` events (idempotent). */
  subscribe(): void {
    if (this.unsubscribe || !this.bus) return;
    this.unsubscribe = this.bus.subscribe((event) => {
      if (event.type === 'vpn') void this.applyBinding().catch((err: unknown) => this.log?.warn({ err }, 'torrent re-bind failed'));
    });
  }

  start(): Promise<void> {
    return this.enqueue(() => this.doStart());
  }

  stop(): Promise<void> {
    return this.enqueue(() => this.doStop());
  }

  /** Re-evaluate the VPN binding and forwarded port now (also run on every `vpn` event). */
  applyBinding(): Promise<void> {
    return this.enqueue(() => this.doApplyBinding());
  }

  async shutdown(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.stop();
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async doStart(): Promise<void> {
    if (this.sessionValue) return;
    const s = this.settings();
    const binding = this.desiredBinding(s);
    this.state = 'starting';
    this.lastError = undefined;
    let session: Session | null = null;
    try {
      await mkdir(this.resumeDir, { recursive: true });
      this.killSwitchPaused = await this.loadKillSwitchSet();
      session = this.sessionFactory({ settings: this.sessionSettings(s, binding) });
      session.on('warning', (m) => this.log?.debug({ warning: m }, 'torrent engine warning'));
      if (this.seedRules) attachSeedRules(session, this.seedRules);
      await session.start();
      this.sessionValue = session;
      this.state = 'running';
      this.log?.info({ port: session.listenPort, address: binding.address, mode: binding.mode }, 'torrent engine started');
      if (binding.mode === 'lockdown') await this.enterLockdown(session, binding.reason ?? 'VPN down');
      else await this.leaveLockdown(session);
    } catch (err) {
      this.state = 'error';
      this.lastError = err instanceof Error ? err.message : String(err);
      this.log?.error({ err }, 'torrent engine failed to start');
      this.sessionValue = null;
      await session?.shutdown().catch(() => undefined);
    }
  }

  private async doStop(): Promise<void> {
    const session = this.sessionValue;
    this.sessionValue = null;
    if (session) {
      await session.shutdown();
      this.log?.info('torrent engine stopped');
    }
    this.state = 'disabled';
    this.lockdownReason = undefined;
  }

  // ---- VPN binding ------------------------------------------------------------------------

  private desiredBinding(s: TorrentSettings = this.settings()): Binding {
    const vpn = this.vpn;
    if (!s.bindToVpn || !vpn || !vpn.enabled()) return { mode: 'open', address: this.defaultAddress, port: s.listenPort };
    const st = vpn.getStatus();
    const lockdown = (reason: string): Binding => ({ mode: 'lockdown', address: LOCKDOWN_ADDRESS, port: s.listenPort, reason });
    if (!st.enabled || st.lastChecked === null) return lockdown('Waiting for the first VPN check.');
    if (st.killSwitchEngaged) return lockdown('VPN kill switch engaged.');
    if (st.leak) return lockdown('VPN leak: traffic would leave through the home IP.');
    if (!st.connected) return lockdown(st.error ? `VPN disconnected: ${st.error}` : 'VPN disconnected.');
    return { mode: 'vpn', address: vpn.getTunnelAddress() ?? this.defaultAddress, port: st.forwardedPort ?? s.listenPort };
  }

  private async doApplyBinding(): Promise<void> {
    const session = this.sessionValue;
    if (!session) return;
    const binding = this.desiredBinding();
    if (binding.mode === 'lockdown') {
      await this.enterLockdown(session, binding.reason ?? 'VPN down');
      return;
    }
    if (session.settings.listenAddress !== binding.address) {
      await session.bindTo(binding.address);
      this.log?.info({ address: binding.address }, 'torrent engine re-bound');
    }
    if (session.listenPort !== binding.port) {
      await session.setListenPort(binding.port);
      this.log?.info({ port: binding.port }, 'torrent engine listen port changed');
    }
    await this.leaveLockdown(session);
  }

  private async enterLockdown(session: Session, reason: string): Promise<void> {
    const wasLocked = this.state === 'lockdown';
    this.lockdownReason = reason;
    this.state = 'lockdown';
    for (const t of session.getTorrents()) {
      if (t.isPaused) continue;
      this.killSwitchPaused.add(t.infoHashHex);
      await session.pauseTorrent(t.infoHashHex);
    }
    await this.saveKillSwitchSet();
    if (session.settings.listenAddress !== LOCKDOWN_ADDRESS) await session.bindTo(LOCKDOWN_ADDRESS);
    if (!wasLocked) this.log?.warn({ reason, paused: this.killSwitchPaused.size }, 'torrent engine locked down');
  }

  private async leaveLockdown(session: Session): Promise<void> {
    const wasLocked = this.state === 'lockdown';
    this.state = 'running';
    this.lockdownReason = undefined;
    if (this.killSwitchPaused.size === 0) return;
    const ids = [...this.killSwitchPaused];
    for (const id of ids) {
      if (session.getTorrent(id)) await session.resumeTorrent(id);
      this.killSwitchPaused.delete(id);
    }
    await this.saveKillSwitchSet();
    if (wasLocked || ids.length > 0) this.log?.info({ resumed: ids.length }, 'torrent engine resumed after VPN reconnect');
  }

  private async loadKillSwitchSet(): Promise<Set<string>> {
    try {
      const raw: unknown = JSON.parse(await readFile(join(this.resumeDir, KILLSWITCH_FILE), 'utf8'));
      return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);
    } catch {
      return new Set();
    }
  }

  private async saveKillSwitchSet(): Promise<void> {
    const file = join(this.resumeDir, KILLSWITCH_FILE);
    try {
      if (this.killSwitchPaused.size === 0) await rm(file, { force: true });
      else await writeFile(file, JSON.stringify([...this.killSwitchPaused]));
    } catch (err) {
      this.log?.warn({ err }, 'could not persist kill-switch paused torrents');
    }
  }

  /** Torrents paused by the kill switch (resumed on reconnect). */
  killSwitchPausedIds(): string[] {
    return [...this.killSwitchPaused];
  }

  // ---- auto-registration -------------------------------------------------------------------

  /**
   * First boot: add a "Built-in" download client when none exists. Runs once: the
   * `autoRegisterClient` flag is cleared afterwards so deleting the client sticks.
   * Returns the created client, if any.
   */
  autoRegisterClient(): DownloadClientResource | null {
    const s = this.settings();
    if (!s.autoRegisterClient || !this.downloadClients) return null;
    let created: DownloadClientResource | null = null;
    if (this.downloadClients.list().length === 0) {
      created = this.downloadClients.create({ name: 'Built-in', implementation: 'builtin', enable: s.enabled, settings: {} });
      this.log?.info({ id: created.id }, 'registered the built-in download client');
    }
    setSection(this.db, 'torrent', { ...s, autoRegisterClient: false });
    return created;
  }

  // ---- status and details -------------------------------------------------------------------

  status(): TorrentSessionStatus {
    const s = this.settings();
    const session = this.sessionValue;
    const vpnEnabled = this.vpn?.enabled() ?? false;
    const vst = this.vpn?.getStatus();
    const tunnel = this.vpn?.getTunnelAddress() ?? vst?.tunnelAddress;
    const counts: TorrentCounts = { total: 0, downloading: 0, seeding: 0, paused: 0, queued: 0, checking: 0, error: 0 };
    let peers = 0;
    let down = 0;
    let up = 0;
    let dhtNodes = 0;
    let dht6Nodes = 0;
    let utpConnections = 0;
    let encryptedPeers = 0;
    let listedPeers = 0;
    if (session) {
      const st = session.getSessionStats();
      peers = st.connections;
      down = st.downloadRate;
      up = st.uploadRate;
      dhtNodes = st.dhtNodes;
      dht6Nodes = st.dht6Nodes;
      utpConnections = st.utpConnections;
      for (const t of session.getTorrents()) {
        for (const p of t.getPeers()) {
          listedPeers++;
          if (p.encrypted) encryptedPeers++;
        }
        counts.total++;
        const state = t.state;
        if (state === 'downloading' || state === 'downloadingMetadata') counts.downloading++;
        else if (state === 'seeding') counts.seeding++;
        else if (state === 'paused') counts.paused++;
        else if (state === 'queued') counts.queued++;
        else if (state === 'checking') counts.checking++;
        else counts.error++;
      }
    }
    const out: TorrentSessionStatus = {
      enabled: s.enabled,
      state: this.state,
      listenPort: session ? session.listenPort : null,
      configuredListenPort: s.listenPort,
      boundAddress: session ? session.settings.listenAddress : null,
      vpn: {
        bindToVpn: s.bindToVpn,
        enabled: vpnEnabled,
        connected: vst?.connected ?? false,
        killSwitchEngaged: vst?.killSwitchEngaged ?? false,
        ...(tunnel ? { tunnelAddress: tunnel } : {}),
        ...(vst?.forwardedPort !== undefined ? { forwardedPort: vst.forwardedPort } : {}),
      },
      dhtNodes,
      dht6Nodes,
      utpConnections,
      encryptedPeers,
      encryptedPeerRatio: listedPeers > 0 ? encryptedPeers / listedPeers : 0,
      peers,
      downloadRate: down,
      uploadRate: up,
      torrents: counts,
    };
    if (this.lastError) out.error = this.lastError;
    if (this.state === 'lockdown' && this.lockdownReason) out.lockdownReason = this.lockdownReason;
    return out;
  }

  listTorrents(query: TorrentListQuery = {}): TorrentDetail[] {
    const session = this.sessionValue;
    if (!session) return [];
    let torrents = session.getTorrents();
    if (query.id) torrents = torrents.filter((t) => t.infoHashHex === query.id!.toLowerCase());
    if (query.category !== undefined) torrents = torrents.filter((t) => t.category === query.category);
    return torrents.map(toDetail);
  }

  // ---- actions ------------------------------------------------------------------------------

  private require(id: string): { session: Session; torrent: Torrent } {
    const session = this.sessionValue;
    if (!session) throw new TorrentModuleError('NOT_RUNNING', 'The built-in torrent engine is not running.');
    const torrent = session.getTorrent(id);
    if (!torrent) throw new TorrentModuleError('NOT_FOUND', `Torrent ${id} not found`);
    return { session, torrent };
  }

  async recheck(id: string): Promise<void> {
    const { torrent } = this.require(id);
    await torrent.forceRecheck();
  }

  async pause(id: string): Promise<void> {
    const { session, torrent } = this.require(id);
    // A manual pause wins over the kill switch: it stays paused after reconnect.
    this.killSwitchPaused.delete(torrent.infoHashHex);
    await session.pauseTorrent(torrent.infoHashHex);
    await this.saveKillSwitchSet();
  }

  async resume(id: string): Promise<void> {
    const { session, torrent } = this.require(id);
    if (this.state === 'lockdown') {
      throw new TorrentModuleError('CONFLICT', `The VPN is down; torrents stay paused until it reconnects (${this.lockdownReason ?? ''}).`);
    }
    await session.resumeTorrent(torrent.infoHashHex);
  }

  async move(id: string, savePath: string): Promise<void> {
    const { session, torrent } = this.require(id);
    await torrent.moveStorage(savePath);
    await session.saveResumeData(torrent);
  }

  async setPriority(id: string, req: TorrentPriorityRequest): Promise<void> {
    const { session, torrent } = this.require(id);
    if (req.files && req.files.length > 0) {
      if (!torrent.hasMetadata) throw new TorrentModuleError('CONFLICT', 'Metadata not received yet.');
      const current = torrent.getFiles();
      const count = Math.max(0, ...current.map((f) => f.index + 1));
      const priorities = Array.from({ length: count }, (_, i) => current.find((f) => f.index === i)?.priority ?? 0);
      for (const f of req.files) {
        if (f.index >= count) throw new TorrentModuleError('VALIDATION', `File index ${f.index} is out of range`);
        priorities[f.index] = f.priority;
      }
      await torrent.setFilePriorities(priorities);
    }
    if (req.sequential !== undefined) torrent.setSequential(req.sequential);
    await session.saveResumeData(torrent);
  }

  /** Per-torrent and per-peer rate limits in bytes/s (0 = unlimited); omitted keys keep their value. */
  async setLimits(id: string, req: TorrentLimitsRequest): Promise<void> {
    const { session, torrent } = this.require(id);
    const patch: Partial<TorrentRateLimits> = {};
    for (const key of ['uploadLimit', 'downloadLimit', 'peerUploadLimit', 'peerDownloadLimit'] as const) {
      const v = req[key];
      if (v !== undefined) patch[key] = v;
    }
    torrent.setRateLimits(patch);
    await session.saveResumeData(torrent);
  }

  /** BEP 16 super-seeding on or off (takes effect while the torrent seeds). */
  async setSuperSeeding(id: string, enabled: boolean): Promise<void> {
    const { session, torrent } = this.require(id);
    torrent.setSuperSeeding(enabled);
    await session.saveResumeData(torrent);
  }
}

/** The settings with the optional transport fields filled from the engine defaults. */
export type TorrentSettingsFilled = Omit<TorrentSettings, keyof typeof TORRENT_TRANSPORT_DEFAULTS> & {
  encryption: TorrentEncryptionMode;
  tcp: boolean;
  utp: boolean;
  ipv6: boolean;
  webSeedConnectionsPerTorrent: number;
};

export function withTransportDefaults(s: TorrentSettings): TorrentSettingsFilled {
  return {
    ...s,
    encryption: s.encryption ?? TORRENT_TRANSPORT_DEFAULTS.encryption,
    tcp: s.tcp ?? TORRENT_TRANSPORT_DEFAULTS.tcp,
    utp: s.utp ?? TORRENT_TRANSPORT_DEFAULTS.utp,
    ipv6: s.ipv6 ?? TORRENT_TRANSPORT_DEFAULTS.ipv6,
    webSeedConnectionsPerTorrent: s.webSeedConnectionsPerTorrent ?? TORRENT_TRANSPORT_DEFAULTS.webSeedConnectionsPerTorrent,
  };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function toDetail(t: Torrent): TorrentDetail {
  const s = t.getStats();
  const detail: TorrentDetail = {
    id: s.infoHash,
    name: s.name,
    state: s.state,
    progress: s.progress,
    totalBytes: s.totalBytes,
    wantedBytes: s.wantedBytes,
    bytesLeft: s.bytesLeft,
    downloaded: s.downloaded,
    uploaded: s.uploaded,
    downloadRate: s.downloadRate,
    uploadRate: s.uploadRate,
    ratio: s.ratio,
    connectedPeers: s.connectedPeers,
    connectedSeeds: s.connectedSeeds,
    swarmSeeds: s.swarmSeeds,
    swarmLeechers: s.swarmLeechers,
    seedingTimeMs: Math.round(s.seedingTimeMs),
    addedAt: s.addedAt,
    completedAt: s.completedAt,
    savePath: s.savePath,
    contentPath: s.contentPath,
    category: s.category,
    tags: s.tags,
    piecesHave: s.piecesHave,
    pieceCount: s.pieceCount,
    private: t.metainfo?.private ?? false,
    sequential: t.sequential,
    peers: t.getPeers().map((p) => ({
      address: p.address,
      client: p.client,
      source: p.source,
      incoming: p.incoming,
      progress: p.progress,
      downloadRate: p.downloadRate,
      uploadRate: p.uploadRate,
      amChoking: p.amChoking,
      amInterested: p.amInterested,
      peerChoking: p.peerChoking,
      peerInterested: p.peerInterested,
      snubbed: p.snubbed,
      encrypted: p.encrypted,
      transport: p.transport,
    })),
    trackers: t.getTrackers().map((tr) => ({
      url: tr.url,
      tier: tr.tier,
      state: tr.state,
      peers: tr.peers,
      ...(tr.message !== undefined ? { message: tr.message } : {}),
      ...(tr.seeds !== undefined ? { seeds: tr.seeds } : {}),
      ...(tr.leechers !== undefined ? { leechers: tr.leechers } : {}),
      ...(tr.nextAnnounceAt !== undefined ? { nextAnnounce: new Date(tr.nextAnnounceAt).toISOString() } : {}),
    })),
    files: t.getFiles().map((f) => ({ index: f.index, path: f.path, length: f.length, priority: f.priority, progress: f.progress })),
    webSeeds: t.getWebSeeds().map((w) => ({
      url: w.url,
      downloadRate: w.downloadRate,
      downloaded: Math.round(w.downloaded),
      activeRequests: w.activeRequests,
      failures: w.failures,
      retryAt: w.retryAt === null ? null : new Date(w.retryAt).toISOString(),
      lastError: w.lastError,
    })),
    superSeeding: t.superSeeding,
    limits: { ...t.rateLimits },
  };
  if (s.etaSeconds !== undefined) detail.etaSeconds = s.etaSeconds;
  if (s.error !== undefined) detail.error = s.error;
  return detail;
}

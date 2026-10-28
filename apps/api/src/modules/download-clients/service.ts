import { randomUUID } from 'node:crypto';
import { stat, statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { and, asc, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  createDownloadClient,
  DownloadClientError,
  type ClientRuntime,
  type DownloadClient,
  type DownloadClientDeps,
  type DownloadItem,
  type DownloadItemPhase,
  type ItemSpeedLimits,
  type QueueMove,
  type SessionSource,
} from '@arclight/download-clients';
import {
  DOWNLOAD_CLIENT_PROTOCOLS,
  DOWNLOAD_CLIENT_SECRET_FIELDS,
  DownloadClientInput,
  type DownloadClientImplementation,
  DownloadClientResource,
  DownloadClientTestRequest,
  downloadClientHost,
  PASSWORD_MASK,
  QueueQuery,
  RemotePathMappingInput,
  TERMINAL_TRACKED_STATES,
  type DownloadClientTestAllResult,
  type DownloadClientTestResult,
  type MediaType,
  type DownloadEventType,
  type DownloadTimeline,
  type QueueItem,
  type QueueItemLive,
  type QueueItemStateCode,
  type QueuePage,
  type QueueQueryInput,
  type QueueReannounceResult,
  type QueueRemoveResult,
  type QueueReplaceResult,
  type QueueStatus,
  type QueueStatusMessage,
  type QueueSummaryItem,
  type ReleaseProtocol,
  type RemotePathMapping,
  type TrackedDownloadState,
  type TrackedDownloadStatus,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import type { EventBus } from '../../events.js';
import { getSection } from '../settings/service.js';
import {
  isValidLocalPath,
  mapLocalToRemote,
  mapRemoteToLocal,
  toDirectoryForm,
  type PathPlatform,
} from './remote-paths.js';
import {
  downloadClients,
  remotePathMappings,
  trackedDownloads,
  type DownloadClientRow,
  type PendingGrabPayload,
  type TrackedDownloadRow,
} from './schema.js';
import {
  DEFAULT_RECOVERY_SETTINGS,
  DISK_RESUME_MARGIN_BYTES,
  diskGuardAction,
  grabHoldReason,
  planStallRecovery,
  stallReplaceReason,
  type RecoverySettings,
} from './recovery.js';
import { deriveState, formatBytes, NOT_TRANSFERRING, type StateReason } from './state-reason.js';
import { implementationSchemas } from './templates.js';
import { DownloadTimelineStore, type RecordOptions } from './timeline.js';

// ---------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------

export type DownloadClientsErrorCode = 'NOT_FOUND' | 'VALIDATION' | 'CONFLICT' | 'NO_CLIENT' | 'CLIENT_ERROR';

export class DownloadClientsError extends Error {
  constructor(
    readonly code: DownloadClientsErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DownloadClientsError';
  }
}

// ---------------------------------------------------------------------------------------
// Public types for the pipeline
// ---------------------------------------------------------------------------------------

/** A queue item plus the fields the import/failed-download handling needs. */
/** Audio grabs carry `artistId`/`albumIds` or `authorId`/`bookIds` (from QueueItem) instead of series/movie ids. */
export type TrackedDownload = QueueItem & {
  /** Output path exactly as the client reports it. */
  remoteOutputPath?: string;
  category?: string;
  canMoveFiles: boolean;
  canBeRemoved: boolean;
  isReadOnly: boolean;
  grabbedRelease: unknown;
};

export type TrackedDownloadHook = (item: TrackedDownload) => void | Promise<void>;
export type BlocklistHook = (
  item: TrackedDownload,
  options: { skipRedownload: boolean; message?: string | undefined },
) => void | Promise<void>;

/** Starts a search for another release of a replaced download; false when there is nothing to search for. */
export type ReplacementSearch = (item: TrackedDownload) => boolean | Promise<boolean>;

/** A pending grab (held or delayed) was sent: its `pending:*` download id became the client's. */
export type PendingSentHook = (item: TrackedDownload, pendingDownloadId: string) => void | Promise<void>;

export interface GrabRequest {
  title: string;
  /** Torrent releases: a magnet link or the .torrent file. */
  magnet?: string;
  torrentFile?: Uint8Array;
  /** Usenet releases: the raw .nzb document. */
  nzb?: Uint8Array;
  /** Defaults to the client's configured category (the one the queue polls). */
  category?: string;
  /** Selects the client's recent vs older priority. */
  isRecent?: boolean;
  seedConfig?: { ratioLimit?: number; seedTimeLimitMinutes?: number };
  /** Defaults to 'torrent'. */
  protocol?: ReleaseProtocol;
  /** Release size when known; the disk-space guard holds grabs that would not fit. */
  sizeBytes?: number;
}

export interface TrackingInfo {
  mediaType?: MediaType;
  seriesId?: number;
  episodeIds?: number[];
  movieId?: number;
  /** Opaque release snapshot, handed back to blocklist hooks. */
  grabbedRelease?: unknown;
  /** Tags of the series/movie; used by `pickClient` when no client is given. */
  tags?: number[];
}

export interface PickedClient {
  id: number;
  name: string;
  protocol: ReleaseProtocol;
  client: DownloadClient;
}

export interface RefreshSummary {
  clients: number;
  failedClients: number;
  items: number;
  completed: number;
  failed: number;
  removed: number;
}

export type DownloadClientInputRaw = z.input<typeof DownloadClientInput>;
export type DownloadClientTestRequestRaw = z.input<typeof DownloadClientTestRequest>;

/** Builds a live client from an unmasked configuration. Injected in tests. */
export type DownloadClientFactory = (config: DownloadClientResource) => DownloadClient;

/**
 * What the built-in torrent engine tells the queue beyond `getItems` (the torrent module sets
 * it): kill-switch state and live numbers between queue polls.
 */
export interface EngineInsights {
  /** The engine's current lockdown (VPN kill switch), or null when not locked down. */
  lockdown(): { reason?: string | undefined; since?: string | undefined } | null;
  /** Info-hashes paused by the kill switch (resumed on reconnect). */
  killSwitchPaused(): readonly string[];
  /** The engine's active-download limit, when one is set. */
  maxActiveDownloads?(): number | null;
  /** Up-to-the-second numbers of one torrent, or null when the engine does not have it. */
  live?(infoHash: string): EngineLive | null;
  /** True while the engine is starting (restoring torrents and checking their files). */
  starting?(): boolean;
}

export interface EngineLive {
  live: QueueItemLive;
  phase?: DownloadItemPhase | undefined;
  progress: number;
  sizeLeft: number;
  etaMs?: number | undefined;
}

/** A download still transferring, for the disk-space and stall health checks. */
export interface ActiveDownloadInfo {
  id: number;
  title: string;
  clientName: string | null;
  /** Local content path (remote path mappings applied), when known. */
  path?: string;
  sizeLeft: number;
  stalledSince?: string;
  stateCode?: QueueItemStateCode;
}

export interface DownloadClientsServiceOptions {
  db: Db;
  log?: Logger;
  /** Timeline entries and queue changes are published here. */
  bus?: EventBus;
  /** Milliseconds without new data before a download counts as stalled; 0 turns it off. Default: settings. */
  stallAfterMs?: () => number;
  /** Free space to keep on download volumes (bytes). Default: settings (mediaManagement.minimumFreeSpaceMb). */
  minimumFreeSpaceBytes?: () => number;
  /** Bytes free on the volume holding `path`, null when unknown. Default: statfs. */
  freeSpace?: (path: string) => Promise<number | null>;
  /** Stall recovery and disk-space guard knobs. Default: settings (mediaManagement). */
  recoverySettings?: () => RecoverySettings;
  clientFactory?: DownloadClientFactory;
  /** Runtime overrides (fetch, timeouts) for clients built by the default factory. */
  clientRuntime?: Partial<ClientRuntime>;
  /** The built-in torrent engine for `builtin` clients (the torrent module sets it later otherwise). */
  torrentSession?: SessionSource;
  now?: () => Date;
  /** Platform local paths are validated against. Defaults to the running OS. */
  platform?: PathPlatform;
  directoryExists?: (path: string) => Promise<boolean>;
  /** How long a vanished, non-terminal item stays before it is dropped. Default 5 min. */
  missingGraceMs?: number;
  /** How long a vanished terminal item is remembered (prevents re-import). Default 14 days. */
  terminalRetentionMs?: number;
  /** Refresh interval when nothing is active. Default 5 min. */
  idleRefreshIntervalMs?: number;
}

// ---------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------

const IMPLEMENTATION_PROTOCOL = DOWNLOAD_CLIENT_PROTOCOLS;

const ACTIVE_STATES: TrackedDownloadState[] = ['downloading', 'importPending', 'importing', 'failedPending'];
/** States the missing-item grace rule never deletes. */
const PROTECTED_STATES: TrackedDownloadState[] = ['importing', ...TERMINAL_TRACKED_STATES];
const VISIBLE_STATES: TrackedDownloadState[] = ['pending', 'downloading', 'importPending', 'importing', 'failedPending'];

export const STATUS_TEXT = {
  clientWarning: 'The download client reported a problem with this download.',
  clientFailed: 'The download client reported this download as failed.',
  failedNotGrabbed: "Download failed and wasn't grabbed by Arclight, skipping automatic failed download handling.",
  noOutputPath: "Download doesn't contain an output path, skipping.",
  missing: (client: string) => `Download is no longer reported by ${client}.`,
  clientUnavailable: (client: string, message: string) => `${client} is unavailable: ${message}`,
  stalled: (minutes: number) => `No new data received for ${minutes} minutes.`,
  diskPaused: 'Paused by Arclight: the download volume is below the minimum free space. It resumes automatically when there is room.',
  invalidLocalPath: (path: string) => `"${path}" is not a valid local path. You may need a Remote Path Mapping.`,
  noFilesEligible: (path: string) => `No files found are eligible for import in ${path}`,
} as const;

const DEFAULT_MISSING_GRACE_MS = 5 * 60_000;
const DEFAULT_TERMINAL_RETENTION_MS = 14 * 24 * 60 * 60_000;
const DEFAULT_IDLE_INTERVAL_MS = 5 * 60_000;

// ---------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------

export class DownloadClientsService {
  private readonly db: Db;
  private readonly log: Logger | undefined;
  private readonly factory: DownloadClientFactory;
  private readonly now: () => Date;
  private readonly platform: PathPlatform;
  private readonly directoryExists: (path: string) => Promise<boolean>;
  private readonly missingGraceMs: number;
  private readonly terminalRetentionMs: number;
  private readonly idleIntervalMs: number;

  private readonly registry = new Map<number, { fingerprint: string; client: DownloadClient }>();
  private readonly rotation = new Map<string, number>();
  private readonly completedHooks = new Set<TrackedDownloadHook>();
  private readonly failedHooks = new Set<TrackedDownloadHook>();
  private readonly blocklistHooks = new Set<BlocklistHook>();
  private readonly pendingSentHooks = new Set<PendingSentHook>();
  private replacementSearch: ReplacementSearch | undefined;
  /** Answers false while an automatic replacement must wait (e.g. the VPN is down). */
  private replaceGuard: (() => boolean | Promise<boolean>) | undefined;
  /** Download folders below the minimum free space as of the last refresh (disk-space guard). */
  private lowVolumes: Array<{ path: string; freeBytes: number }> = [];
  private readonly recovery: () => RecoverySettings;
  private readonly clientHealth = new Map<number, { ok: boolean; at: string; message?: string }>();
  /** Copies into the library in progress, by download id (imports report them). */
  private readonly importCopies = new Map<string, { copiedBytes: number; totalBytes: number; startedAt: number }>();
  private lastRefreshAt: number | null = null;
  private dirty = true;
  private torrentSession: SessionSource | undefined;
  private engineInsights: EngineInsights | undefined;
  private readonly stallAfterMs: () => number;
  private readonly freeSpace: (path: string) => Promise<number | null>;
  private readonly bus: EventBus | undefined;
  readonly timeline: DownloadTimelineStore;

  constructor(options: DownloadClientsServiceOptions) {
    this.db = options.db;
    this.log = options.log;
    this.bus = options.bus;
    const runtime = options.clientRuntime ?? {};
    this.torrentSession = options.torrentSession;
    // Resolved on every call, so `builtin` clients follow the engine being started/stopped.
    const deps: DownloadClientDeps = {
      torrentSession: () => {
        const source = this.torrentSession;
        return typeof source === 'function' ? source() : (source ?? null);
      },
    };
    this.factory = options.clientFactory ?? ((config) => defaultClientFactory(config, runtime, deps));
    this.now = options.now ?? (() => new Date());
    this.platform = options.platform ?? (process.platform === 'win32' ? 'win32' : 'posix');
    this.directoryExists = options.directoryExists ?? defaultDirectoryExists;
    this.missingGraceMs = options.missingGraceMs ?? DEFAULT_MISSING_GRACE_MS;
    this.terminalRetentionMs = options.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS;
    this.idleIntervalMs = options.idleRefreshIntervalMs ?? DEFAULT_IDLE_INTERVAL_MS;
    this.stallAfterMs = options.stallAfterMs ?? (() => getSection(this.db, 'mediaManagement').stalledDownloadMinutes * 60_000);
    this.minimumFreeSpaceBytes =
      options.minimumFreeSpaceBytes ?? (() => getSection(this.db, 'mediaManagement').minimumFreeSpaceMb * 1024 * 1024);
    this.freeSpace = options.freeSpace ?? defaultFreeSpace;
    this.recovery = options.recoverySettings ?? (() => recoveryFromSettings(this.db));
    this.timeline = new DownloadTimelineStore(this.db, this.now, this.bus);
    // Kill-switch pauses can be shorter than a queue poll: record them as they happen.
    this.bus?.subscribe((event) => {
      if (event.type !== 'torrent') return;
      try {
        this.onEngineTransition(event.action, event.infoHashes, event.reason);
      } catch (err) {
        this.log?.warn({ err }, 'could not record a kill-switch transition');
      }
    });
  }

  readonly minimumFreeSpaceBytes: () => number;

  // ---- download client CRUD ------------------------------------------------------------

  list(): DownloadClientResource[] {
    return this.db
      .select()
      .from(downloadClients)
      .orderBy(asc(downloadClients.id))
      .all()
      .map((row) => mask(rowToResource(row)));
  }

  get(id: number): DownloadClientResource {
    return mask(rowToResource(this.requireRow(id)));
  }

  schemas() {
    return implementationSchemas();
  }

  create(raw: DownloadClientInputRaw): DownloadClientResource {
    const input = this.normalizeInput(raw, null);
    const row = this.db
      .insert(downloadClients)
      .values({ ...input, updatedAt: this.now().toISOString() })
      .returning()
      .get();
    this.dirty = true;
    return mask(rowToResource(row));
  }

  update(id: number, raw: DownloadClientInputRaw): DownloadClientResource {
    const existing = this.requireRow(id);
    const input = this.normalizeInput(raw, existing);
    const row = this.db
      .update(downloadClients)
      .set({ ...input, updatedAt: this.now().toISOString() })
      .where(eq(downloadClients.id, id))
      .returning()
      .get();
    if (!row) throw notFound('Download client', id);
    this.invalidate(id);
    this.dirty = true;
    return mask(rowToResource(row));
  }

  delete(id: number): void {
    this.requireRow(id);
    this.db.delete(downloadClients).where(eq(downloadClients.id, id)).run();
    this.invalidate(id);
    this.clientHealth.delete(id);
  }

  async test(raw: DownloadClientTestRequestRaw): Promise<DownloadClientTestResult> {
    const parsed = DownloadClientTestRequest.safeParse(raw);
    if (!parsed.success) throw new DownloadClientsError('VALIDATION', z.prettifyError(parsed.error));
    const { id, ...candidate } = parsed.data;
    const existing = id === undefined ? null : this.requireRow(id);
    const config = {
      ...candidate,
      id: id ?? 0,
      protocol: IMPLEMENTATION_PROTOCOL[candidate.implementation],
      settings: restoreSecrets(candidate.settings, existing),
    } as DownloadClientResource;
    return runTest(() => this.factory(config));
  }

  async testAll(): Promise<DownloadClientTestAllResult> {
    const rows = this.db.select().from(downloadClients).orderBy(asc(downloadClients.id)).all();
    const results: DownloadClientTestAllResult = [];
    for (const row of rows.filter((r) => r.enable)) {
      const result = await runTest(() => this.clientById(row.id));
      results.push({ id: row.id, name: row.name, ...result });
    }
    return results;
  }

  // ---- client registry -----------------------------------------------------------------

  /** Live client for a configured row (enabled or not), cached until the row changes. */
  clientById(id: number): DownloadClient {
    return this.clientFor(rowToResource(this.requireRow(id)));
  }

  /** Every enabled client with its unmasked configuration. */
  enabledClients(): Array<{ config: DownloadClientResource; client: DownloadClient }> {
    return this.db
      .select()
      .from(downloadClients)
      .where(eq(downloadClients.enable, true))
      .orderBy(asc(downloadClients.id))
      .all()
      .map((row) => {
        const config = rowToResource(row);
        return { config, client: this.clientFor(config) };
      });
  }

  /**
   * Chooses the client for a grab: enabled clients of `protocol`; those sharing a tag with
   * `tags` if any exist, otherwise those without tags; then the best (lowest) priority,
   * rotating between clients of equal priority. Null when nothing qualifies.
   */
  pickClient(protocol: ReleaseProtocol, tags: readonly number[] = []): PickedClient | null {
    const candidates = this.enabledClients().filter((c) => c.config.protocol === protocol);
    const wanted = new Set(tags);
    const tagged = candidates.filter((c) => c.config.tags.some((t) => wanted.has(t)));
    const pool = tagged.length > 0 ? tagged : candidates.filter((c) => c.config.tags.length === 0);
    if (pool.length === 0) return null;
    const best = Math.min(...pool.map((c) => c.config.priority));
    const top = pool.filter((c) => c.config.priority === best);
    const key = `${protocol}:${best}:${tagged.length > 0 ? [...wanted].sort().join(',') : ''}`;
    const last = this.rotation.get(key);
    const next = (last === undefined ? undefined : top.find((c) => c.config.id > last)) ?? top[0]!;
    this.rotation.set(key, next.config.id);
    return { id: next.config.id, name: next.config.name, protocol, client: next.client };
  }

  /** Called by the torrent module: the engine `builtin` clients drive (a getter; null while stopped). */
  setTorrentSession(source: SessionSource | undefined): void {
    this.torrentSession = source;
  }

  /** Called by the torrent module: kill-switch state and live numbers of the built-in engine. */
  /** Progress of an import that copies (hard link impossible); null when it ends. */
  setImportProgress(downloadId: string, progress: { copiedBytes: number; totalBytes: number } | null): void {
    if (!progress) this.importCopies.delete(downloadId);
    else {
      const startedAt = this.importCopies.get(downloadId)?.startedAt ?? Date.now();
      this.importCopies.set(downloadId, { ...progress, startedAt });
    }
    this.bus?.publish({ type: 'queue', action: 'changed' });
  }

  private importCopyOf(downloadId: string): { copiedBytes: number; totalBytes: number; bytesPerSecond: number } | undefined {
    const c = this.importCopies.get(downloadId);
    if (!c) return undefined;
    const seconds = Math.max(1, (Date.now() - c.startedAt) / 1000);
    return { copiedBytes: c.copiedBytes, totalBytes: c.totalBytes, bytesPerSecond: c.copiedBytes / seconds };
  }

  setEngineInsights(insights: EngineInsights | undefined): void {
    this.engineInsights = insights;
  }

  /**
   * Set the incoming-connections port on every enabled client that supports it (qBittorrent, Built-in,
   * Remote Engine with "Follow VPN port"), e.g. to follow a VPN's forwarded port. Per-client
   * failures are reported, never thrown.
   */
  async setListenPortOnAll(port: number): Promise<Array<{ id: number; name: string; ok: boolean; message?: string }>> {
    const results: Array<{ id: number; name: string; ok: boolean; message?: string }> = [];
    for (const { config, client } of this.enabledClients()) {
      if (!followsVpnPort(config) || !client.setListenPort) continue;
      try {
        await client.setListenPort(port);
        results.push({ id: config.id, name: config.name, ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log?.warn({ err, client: config.name, port }, 'could not set listen port');
        results.push({ id: config.id, name: config.name, ok: false, message });
      }
    }
    return results;
  }

  private clientFor(config: DownloadClientResource): DownloadClient {
    const fingerprint = JSON.stringify(config);
    const cached = this.registry.get(config.id);
    if (cached && cached.fingerprint === fingerprint) return cached.client;
    const client = this.factory(config);
    this.registry.set(config.id, { fingerprint, client });
    return client;
  }

  private invalidate(id: number): void {
    this.registry.delete(id);
  }

  // ---- remote path mappings ------------------------------------------------------------

  listMappings(): RemotePathMapping[] {
    return this.db.select().from(remotePathMappings).orderBy(asc(remotePathMappings.id)).all();
  }

  getMapping(id: number): RemotePathMapping {
    const row = this.db.select().from(remotePathMappings).where(eq(remotePathMappings.id, id)).get();
    if (!row) throw notFound('Remote path mapping', id);
    return row;
  }

  async createMapping(raw: z.input<typeof RemotePathMappingInput>): Promise<RemotePathMapping> {
    const values = await this.normalizeMapping(raw, null);
    return this.db.insert(remotePathMappings).values(values).returning().get();
  }

  async updateMapping(id: number, raw: z.input<typeof RemotePathMappingInput>): Promise<RemotePathMapping> {
    this.getMapping(id);
    const values = await this.normalizeMapping(raw, id);
    const row = this.db.update(remotePathMappings).set(values).where(eq(remotePathMappings.id, id)).returning().get();
    if (!row) throw notFound('Remote path mapping', id);
    return row;
  }

  deleteMapping(id: number): void {
    this.getMapping(id);
    this.db.delete(remotePathMappings).where(eq(remotePathMappings.id, id)).run();
  }

  /** Converts a path reported by the client on `host` to the path Arclight sees. */
  remotePathToLocal(host: string, path: string): string {
    return mapRemoteToLocal(this.listMappings(), host, path);
  }

  /** The reverse: a local path as the client on `host` would see it. */
  localPathToRemote(host: string, path: string): string {
    return mapLocalToRemote(this.listMappings(), host, path);
  }

  private async normalizeMapping(
    raw: z.input<typeof RemotePathMappingInput>,
    selfId: number | null,
  ): Promise<{ host: string; remotePath: string; localPath: string }> {
    const parsed = RemotePathMappingInput.safeParse(raw);
    if (!parsed.success) throw new DownloadClientsError('VALIDATION', z.prettifyError(parsed.error));
    const { host, remotePath, localPath } = parsed.data;
    if (remotePath.startsWith(' ') || remotePath.trim() === '') {
      throw new DownloadClientsError('VALIDATION', 'Remote path must not be empty or start with a space');
    }
    if (!isValidLocalPath(localPath, this.platform)) {
      throw new DownloadClientsError('VALIDATION', `Local path "${localPath}" is not an absolute path`);
    }
    if (!(await this.directoryExists(localPath))) {
      throw new DownloadClientsError('VALIDATION', `Local path "${localPath}" does not exist or is not a directory`);
    }
    const values = { host, remotePath: toDirectoryForm(remotePath), localPath: toDirectoryForm(localPath) };
    const clash = this.listMappings().find(
      (m) => m.id !== selfId && m.host.toLowerCase() === host.toLowerCase() && m.remotePath === values.remotePath,
    );
    if (clash) {
      throw new DownloadClientsError('CONFLICT', `A mapping for ${host} ${values.remotePath} already exists`);
    }
    return values;
  }

  // ---- hooks ---------------------------------------------------------------------------

  /** Fired once when a tracked download reaches `importPending`. Returns an unsubscribe. */
  onItemCompleted(cb: TrackedDownloadHook): () => void {
    this.completedHooks.add(cb);
    return () => this.completedHooks.delete(cb);
  }

  /** Fired once when a grabbed download reaches `failedPending`. Returns an unsubscribe. */
  onItemFailed(cb: TrackedDownloadHook): () => void {
    this.failedHooks.add(cb);
    return () => this.failedHooks.delete(cb);
  }

  /** Called by `removeQueueItems` when the user asked to blocklist the release. */
  onBlocklist(cb: BlocklistHook): () => void {
    this.blocklistHooks.add(cb);
    return () => this.blocklistHooks.delete(cb);
  }

  /** Fired when a pending grab is finally sent (its download id changes). Returns an unsubscribe. */
  onPendingSent(cb: PendingSentHook): () => void {
    this.pendingSentHooks.add(cb);
    return () => this.pendingSentHooks.delete(cb);
  }

  /** The search `replace` starts for another release (the app wires the releases module). */
  setReplacementSearch(search: ReplacementSearch | undefined): void {
    this.replacementSearch = search;
  }

  /** Automatic replacements wait while this answers false (the app wires the VPN grab guard). */
  setReplaceGuard(guard: (() => boolean | Promise<boolean>) | undefined): void {
    this.replaceGuard = guard;
  }

  // ---- queue refresh -------------------------------------------------------------------

  /** Asks the next scheduled refresh to run even when the queue is idle. */
  requestRefresh(): void {
    this.dirty = true;
  }

  /** Cheap check the 1-minute job uses: run when active, dirty, or the idle interval passed. */
  shouldRefresh(): boolean {
    if (this.dirty || this.lastRefreshAt === null) return true;
    const active = this.db
      .select({ id: trackedDownloads.id })
      .from(trackedDownloads)
      .where(inArray(trackedDownloads.state, ACTIVE_STATES))
      .limit(1)
      .get();
    if (active) return true;
    return this.now().getTime() - this.lastRefreshAt >= this.idleIntervalMs;
  }

  /**
   * Reachability of every enabled remote engine, for the RemoteEngineUnreachable health check:
   * the queue poller's last outcome, else a live status request.
   */
  async remoteEngineHealth(): Promise<Array<{ id: number; name: string; url: string; ok: boolean; message?: string }>> {
    const out: Array<{ id: number; name: string; url: string; ok: boolean; message?: string }> = [];
    for (const { config, client } of this.enabledClients()) {
      if (config.implementation !== 'remoteEngine') continue;
      const url = config.settings.url;
      const polled = this.clientHealth.get(config.id);
      if (polled) {
        out.push({ id: config.id, name: config.name, url, ok: polled.ok, ...(polled.message ? { message: polled.message } : {}) });
        continue;
      }
      try {
        await client.getStatus();
        out.push({ id: config.id, name: config.name, url, ok: true });
      } catch (err) {
        out.push({ id: config.id, name: config.name, url, ok: false, message: errorMessage(err) });
      }
    }
    return out;
  }

  /** Last poll outcome per client id, for health checks. */
  clientStatuses(): Map<number, { ok: boolean; at: string; message?: string }> {
    return new Map(this.clientHealth);
  }

  async refreshQueue(): Promise<RefreshSummary> {
    const now = this.now();
    const nowIso = now.toISOString();
    const mappings = this.listMappings();
    const clients = this.enabledClients();
    const completedIds: number[] = [];
    const failedIds: number[] = [];
    const summary: RefreshSummary = { clients: clients.length, failedClients: 0, items: 0, completed: 0, failed: 0, removed: 0 };
    const stallMs = Math.max(0, this.stallAfterMs());

    for (const { config, client } of clients) {
      let items: DownloadItem[];
      try {
        items = await client.getItems(config.settings.category);
        this.clientHealth.set(config.id, { ok: true, at: nowIso });
      } catch (err) {
        const message = errorMessage(err);
        summary.failedClients++;
        this.clientHealth.set(config.id, { ok: false, at: nowIso, message });
        this.log?.warn({ err, client: config.name }, 'download client poll failed');
        this.flagClientUnavailable(config, message, nowIso);
        continue;
      }

      const seen = new Set<string>();
      for (const item of items) {
        seen.add(item.id);
        summary.items++;
        const { id, transition } = this.trackItem(config, item, mappings, now, stallMs);
        if (transition === 'completed') completedIds.push(id);
        if (transition === 'failed') failedIds.push(id);
      }
      summary.removed += this.handleMissing(config, seen, now);
    }

    summary.removed += this.purgeTerminal(now);
    try {
      await this.guardDiskSpace(await this.updateDiskShortfall(mappings));
    } catch (err) {
      this.log?.warn({ err }, 'download disk space check failed');
    }
    try {
      await this.recoverStalled(now, stallMs);
    } catch (err) {
      this.log?.warn({ err }, 'stall recovery failed');
    }
    this.lastRefreshAt = now.getTime();
    this.dirty = false;
    summary.completed = completedIds.length;
    summary.failed = failedIds.length;

    for (const id of completedIds) await this.fire(this.completedHooks, id);
    for (const id of failedIds) await this.fire(this.failedHooks, id);
    this.bus?.publish({ type: 'queue', action: 'changed' });
    return summary;
  }

  private trackItem(
    config: DownloadClientResource,
    item: DownloadItem,
    mappings: RemotePathMapping[],
    now: Date,
    stallMs: number,
  ): { id: number; transition: 'completed' | 'failed' | null } {
    const nowIso = now.toISOString();
    const existing = this.db
      .select()
      .from(trackedDownloads)
      .where(and(eq(trackedDownloads.clientId, config.id), eq(trackedDownloads.downloadId, item.id)))
      .get();

    const snapshot = {
      clientStatus: item.status,
      category: item.category,
      size: Math.round(item.totalBytes),
      sizeLeft: Math.round(item.remainingBytes),
      progress: item.progress,
      etaMs: item.etaSeconds === undefined ? null : Math.round(item.etaSeconds * 1000),
      outputPath: item.outputPath === '' ? null : item.outputPath,
      canMoveFiles: item.canMoveFiles,
      canBeRemoved: item.canBeRemoved,
      isReadOnly: item.isReadOnly,
      lastSeenAt: nowIso,
      updatedAt: nowIso,
      phase: item.phase ?? null,
      live: item.live ?? null,
      downloadedBytes: Math.max(0, Math.round(item.downloadedBytes)),
    };

    let state: TrackedDownloadState = existing?.state ?? 'downloading';
    let transition: 'completed' | 'failed' | null = null;
    // Refresh owns status messages only while downloading; later states belong to the
    // import / failed-download handling that set them.
    let messages: QueueStatusMessage[] | undefined;
    let trackedStatus: TrackedDownloadStatus | undefined;

    if (state === 'downloading') {
      const title = existing?.title ?? item.title;
      messages = [];
      trackedStatus = 'ok';
      const grabbed = existing !== undefined && isGrabbed(existing);
      if (item.status === 'warning') {
        trackedStatus = 'warning';
        messages.push({ title, messages: [item.statusMessage ?? STATUS_TEXT.clientWarning] });
      } else if (item.status === 'failed') {
        trackedStatus = 'error';
        messages.push({ title, messages: [item.statusMessage ?? STATUS_TEXT.clientFailed] });
        if (grabbed) {
          state = 'failedPending';
          transition = 'failed';
        } else {
          messages.push({ title, messages: [STATUS_TEXT.failedNotGrabbed] });
        }
      } else if (item.status === 'completed' || item.status === 'seeding') {
        // Remote path mappings key on the client's configured host, whatever the kind.
        const problem = this.outputPathProblem(item.outputPath, downloadClientHost(config.settings), mappings);
        if (problem) {
          trackedStatus = 'warning';
          messages.push({ title, messages: [problem] });
        } else {
          state = 'importPending';
          transition = 'completed';
        }
      }
    }

    // Stall clock, kill switch and the derived state, then timeline entries for what changed.
    const killSwitch = this.killSwitchFor(config, item.id);
    const clock = this.progressClock(existing, item, snapshot.downloadedBytes, now, stallMs, killSwitch !== undefined);
    if (messages && trackedStatus) {
      const title = existing?.title ?? item.title;
      if (killSwitch) {
        if (trackedStatus === 'ok') trackedStatus = 'warning';
        messages.push({ title, messages: [killSwitchText(killSwitch.reason)] });
      } else if (existing?.diskPausedAt) {
        if (trackedStatus === 'ok') trackedStatus = 'warning';
        messages.push({ title, messages: [STATUS_TEXT.diskPaused] });
      } else if (clock.stalledSince) {
        if (trackedStatus === 'ok') trackedStatus = 'warning';
        messages.push({ title, messages: [STATUS_TEXT.stalled(Math.round(stallMs / 60_000))] });
      }
    }
    const derived = deriveState({
      state,
      clientStatus: item.status,
      trackedStatus: trackedStatus ?? existing?.trackedStatus ?? 'ok',
      statusMessages: messages ?? existing?.statusMessages ?? [],
      phase: item.phase,
      live: item.live,
      progress: item.progress,
      stalledSince: clock.stalledSince,
      diskShortfall: existing?.diskShortfall,
      clientName: config.name,
      killSwitch,
      diskPaused: existing?.diskPausedAt ? this.diskPausedInfo() : undefined,
    });

    if (existing) {
      this.db
        .update(trackedDownloads)
        .set({
          ...snapshot,
          state,
          progressAt: clock.progressAt,
          stalledSince: clock.stalledSince,
          // A new stall starts the recovery ladder from the first step again.
          reannouncedAt: clock.stalledSince ? existing.reannouncedAt : null,
          stateCode: derived.code,
          ...(messages ? { statusMessages: messages } : {}),
          ...(trackedStatus ? { trackedStatus } : {}),
        })
        .where(eq(trackedDownloads.id, existing.id))
        .run();
      if (existing.state === 'downloading') this.recordTransitions(existing, item, derived, clock.events, config.name);
      return { id: existing.id, transition };
    }

    const row = this.db
      .insert(trackedDownloads)
      .values({
        ...snapshot,
        downloadId: item.id,
        clientId: config.id,
        title: item.title,
        state,
        statusMessages: messages ?? [],
        trackedStatus: trackedStatus ?? 'ok',
        protocol: config.protocol,
        addedAt: nowIso,
        progressAt: clock.progressAt,
        stalledSince: clock.stalledSince,
        stateCode: derived.code,
      })
      .returning({ id: trackedDownloads.id })
      .get();
    return { id: row.id, transition };
  }

  /**
   * Advances the stall clock of a download: `progressAt` moves whenever downloaded bytes grow
   * (and while the download is not expected to transfer: paused, queued, checking, ...); it
   * counts as stalled once `stallMs` passed without growth.
   */
  private progressClock(
    existing: TrackedDownloadRow | undefined,
    item: DownloadItem,
    downloaded: number,
    now: Date,
    stallMs: number,
    killSwitch: boolean,
  ): { progressAt: string; stalledSince: string | null; events: Array<[DownloadEventType, RecordOptions]> } {
    const nowIso = now.toISOString();
    const events: Array<[DownloadEventType, RecordOptions]> = [];
    const prevStalled = existing?.stalledSince ?? null;
    const transferring =
      (existing?.state ?? 'downloading') === 'downloading' &&
      (item.status === 'downloading' || item.status === 'warning') &&
      item.phase !== 'metadata' &&
      item.phase !== 'checking' &&
      item.phase !== 'moving' &&
      !killSwitch &&
      item.progress < 1;
    if (!transferring) return { progressAt: nowIso, stalledSince: null, events };
    const prevBytes = existing?.downloadedBytes ?? null;
    // Coming out of a pause, queue slot, check, ...: the clock starts now.
    const resumed = !existing?.stateCode || NOT_TRANSFERRING.has(existing.stateCode);
    if (prevBytes === null || downloaded > prevBytes || !existing?.progressAt || resumed) {
      if (prevStalled) {
        const minutes = Math.max(1, Math.round((now.getTime() - Date.parse(prevStalled)) / 60_000));
        events.push(['recovered', { message: `Data is arriving again after ${minutes} minutes without progress.` }]);
      }
      return { progressAt: nowIso, stalledSince: null, events };
    }
    const progressAt = existing.progressAt;
    if (prevStalled) return { progressAt, stalledSince: prevStalled, events };
    if (stallMs > 0 && now.getTime() - Date.parse(progressAt) >= stallMs) {
      const peers = item.live?.connectedPeers;
      const seeds = item.live?.connectedSeeds;
      const detail = peers === undefined ? '' : ` ${peers} peer(s) connected${seeds === undefined ? '' : `, ${seeds} seed(s)`}.`;
      const message = `No new data for ${Math.round(stallMs / 60_000)} minutes at ${Math.round(item.progress * 100)}%.${detail}`;
      events.push(['stalled', { message, data: { progress: item.progress } }]);
      return { progressAt, stalledSince: progressAt, events };
    }
    return { progressAt, stalledSince: null, events };
  }

  /** Timeline entries for the difference between the last poll and this one. */
  private recordTransitions(
    prev: TrackedDownloadRow,
    item: DownloadItem,
    next: StateReason,
    clockEvents: Array<[DownloadEventType, RecordOptions]>,
    clientName: string,
  ): void {
    if (!isGrabbed(prev)) return;
    const subject = { id: prev.id, downloadId: prev.downloadId, title: prev.title };
    const prevCode = prev.stateCode;
    const record = (type: DownloadEventType, options: RecordOptions = {}) => this.timeline.record(subject, type, options);
    const paused = (code: QueueItemStateCode | null) => code === 'paused' || code === 'killSwitch';

    if (prevCode === 'metadata' && item.phase !== 'metadata') record('metadataReceived');
    if ((prev.downloadedBytes ?? 0) === 0 && item.downloadedBytes > 0) {
      record('started', { message: `Receiving data in ${clientName}.` });
    }
    if (next.code === 'killSwitch' && prevCode !== 'killSwitch') {
      record('paused', { message: next.reason, severity: 'warning', data: { reason: 'killSwitch' } });
    } else if (next.code === 'paused' && prevCode !== 'paused') {
      const message = prevCode === 'killSwitch' ? 'Still paused after the kill switch let go.' : next.reason;
      record('paused', { message, data: { reason: 'client' } });
    } else if (paused(prevCode) && !paused(next.code)) {
      record('resumed', { data: { reason: prevCode === 'killSwitch' ? 'killSwitch' : 'client' } });
    }
    for (const [type, options] of clockEvents) record(type, options);
    const done = (status: string) => status === 'completed' || status === 'seeding';
    if (done(item.status) && !done(prev.clientStatus)) record('completed', { message: `${clientName} finished the download.` });
    if (item.status === 'failed' && prev.clientStatus !== 'failed') {
      record('error', { message: item.statusMessage ?? STATUS_TEXT.clientFailed });
    }
  }

  /** Kill-switch info for a `builtin` client's torrent, when the engine paused it. */
  private killSwitchFor(
    config: Pick<DownloadClientResource, 'implementation'>,
    downloadId: string,
  ): { reason?: string } | undefined {
    if (config.implementation !== 'builtin' || !this.engineInsights) return undefined;
    if (!this.engineInsights.killSwitchPaused().includes(downloadId)) return undefined;
    const reason = this.engineInsights.lockdown()?.reason;
    return reason === undefined ? {} : { reason };
  }

  /**
   * The engine entered (or left) lockdown: write `paused` (or `resumed`) to the timelines of
   * the affected downloads right away, since a short lockdown can fall between two polls.
   */
  private onEngineTransition(action: 'lockdown' | 'unlocked', infoHashes: readonly string[], reason?: string): void {
    if (infoHashes.length === 0) return;
    const builtinIds = this.db
      .select({ id: downloadClients.id })
      .from(downloadClients)
      .where(eq(downloadClients.implementation, 'builtin'))
      .all()
      .map((r) => r.id);
    if (builtinIds.length === 0) return;
    const rows = this.db
      .select()
      .from(trackedDownloads)
      .where(
        and(
          inArray(trackedDownloads.clientId, builtinIds),
          inArray(trackedDownloads.downloadId, [...infoHashes]),
          eq(trackedDownloads.state, 'downloading'),
        ),
      )
      .all();
    const nowIso = this.now().toISOString();
    for (const row of rows) {
      const subject = { id: row.id, downloadId: row.downloadId, title: row.title };
      if (action === 'lockdown') {
        if (row.stateCode === 'killSwitch') continue;
        const text = killSwitchText(reason);
        this.timeline.record(subject, 'paused', { message: text, severity: 'warning', data: { reason: 'killSwitch' } });
        this.db
          .update(trackedDownloads)
          .set({
            stateCode: 'killSwitch',
            stalledSince: null,
            progressAt: nowIso,
            trackedStatus: 'warning',
            statusMessages: [{ title: row.title, messages: [text] }],
            updatedAt: nowIso,
          })
          .where(eq(trackedDownloads.id, row.id))
          .run();
      } else {
        if (row.stateCode !== 'killSwitch') continue;
        this.timeline.record(subject, 'resumed', { message: 'Resumed after the VPN reconnected.', data: { reason: 'killSwitch' } });
        this.db
          .update(trackedDownloads)
          .set({ stateCode: 'downloading', progressAt: nowIso, trackedStatus: 'ok', statusMessages: [], updatedAt: nowIso })
          .where(eq(trackedDownloads.id, row.id))
          .run();
      }
    }
    if (rows.length > 0) this.bus?.publish({ type: 'queue', action: 'changed' });
  }

  /**
   * Free space of each download folder against the bytes its downloads still need. Sets
   * `diskShortfall` on downloads that would not fit (0 when they do, null when unknown).
   */
  private async updateDiskShortfall(mappings: RemotePathMapping[]): Promise<Map<string, VolumeGroup>> {
    const out = new Map<string, VolumeGroup>();
    const rows = this.db.select().from(trackedDownloads).where(eq(trackedDownloads.state, 'downloading')).all();
    const ctx = this.queueContext(mappings);
    const groups = new Map<string, TrackedDownloadRow[]>();
    for (const row of rows) {
      const path = this.toTracked(row, ctx, { overlay: false }).outputPath;
      if (!path || row.sizeLeft <= 0) {
        if (row.diskShortfall !== null) {
          this.db.update(trackedDownloads).set({ diskShortfall: null }).where(eq(trackedDownloads.id, row.id)).run();
        }
        continue;
      }
      const dir = dirname(path);
      groups.set(dir, [...(groups.get(dir) ?? []), row]);
    }
    for (const [dir, group] of groups) {
      const free = await this.freeSpace(dir);
      const needed = group.reduce((sum, r) => sum + r.sizeLeft, 0);
      const shortfall = free === null ? null : Math.max(0, needed - free);
      for (const row of group) {
        if (row.diskShortfall === shortfall) continue;
        this.db.update(trackedDownloads).set({ diskShortfall: shortfall }).where(eq(trackedDownloads.id, row.id)).run();
      }
      out.set(dir, { free, rows: group });
    }
    return out;
  }

  // ---- disk-space guard ----------------------------------------------------------------

  /**
   * Pauses the downloads of a folder whose volume fell below the minimum free space and
   * resumes them once it has the minimum plus a margin again (or the guard is switched off).
   * Each pause/resume goes on the download's timeline.
   */
  private async guardDiskSpace(groups: Map<string, VolumeGroup>): Promise<void> {
    const enabled = this.recovery().diskGuard;
    const minimum = this.minimumFreeSpaceBytes();
    const low: Array<{ path: string; freeBytes: number }> = [];
    const handled = new Set<number>();
    let changed = false;
    for (const [dir, { free, rows }] of groups) {
      const action = diskGuardAction(free, minimum, enabled);
      if (enabled && free !== null && free < minimum) low.push({ path: dir, freeBytes: free });
      for (const row of rows) {
        handled.add(row.id);
        if (action === 'pause' && !row.diskPausedAt && isTransferring(row)) {
          changed = (await this.diskPause(row, dir, free ?? 0, minimum)) || changed;
        } else if (action === 'resume' && row.diskPausedAt) {
          changed = (await this.diskResume(row, enabled ? `${formatBytes(free ?? 0)} is free in ${dir} again.` : 'The disk-space guard was switched off.')) || changed;
        }
      }
    }
    // Paused rows that no longer sit in a measured folder (path gone, finished, ...): let go.
    const stranded = this.db
      .select()
      .from(trackedDownloads)
      .where(and(eq(trackedDownloads.state, 'downloading'), isNotNull(trackedDownloads.diskPausedAt)))
      .all()
      .filter((r) => !handled.has(r.id) && (!enabled || r.sizeLeft <= 0));
    for (const row of stranded) changed = (await this.diskResume(row, 'The disk-space guard no longer applies to it.')) || changed;
    this.lowVolumes = low;
    if (changed) this.bus?.publish({ type: 'queue', action: 'changed' });
  }

  private async diskPause(row: TrackedDownloadRow, dir: string, free: number, minimum: number): Promise<boolean> {
    if (row.clientId === null) return false;
    try {
      await this.clientById(row.clientId).pause(row.downloadId);
    } catch (err) {
      this.log?.warn({ err, id: row.id }, 'disk-space guard could not pause a download');
      return false;
    }
    const nowIso = this.now().toISOString();
    this.db
      .update(trackedDownloads)
      .set({
        diskPausedAt: nowIso,
        stateCode: 'diskPaused',
        stalledSince: null,
        progressAt: nowIso,
        trackedStatus: 'warning',
        statusMessages: [{ title: row.title, messages: [STATUS_TEXT.diskPaused] }],
        updatedAt: nowIso,
      })
      .where(eq(trackedDownloads.id, row.id))
      .run();
    this.timeline.record(subjectOf(row), 'paused', {
      message: `Paused: only ${formatBytes(free)} is free in ${dir}, below the ${formatBytes(minimum)} minimum. It resumes automatically once ${formatBytes(minimum + DISK_RESUME_MARGIN_BYTES)} is free.`,
      severity: 'warning',
      data: { reason: 'diskSpace', freeBytes: free },
    });
    return true;
  }

  private async diskResume(row: TrackedDownloadRow, why: string): Promise<boolean> {
    if (row.clientId !== null) {
      try {
        await this.clientById(row.clientId).resume(row.downloadId);
      } catch (err) {
        if (!(err instanceof DownloadClientError && err.code === 'not-found')) {
          this.log?.warn({ err, id: row.id }, 'disk-space guard could not resume a download');
          return false;
        }
      }
    }
    const nowIso = this.now().toISOString();
    this.db
      .update(trackedDownloads)
      // 'queued' restarts the stall clock: the client needs a moment to reconnect.
      .set({ diskPausedAt: null, stateCode: 'queued', progressAt: nowIso, trackedStatus: 'ok', statusMessages: [], updatedAt: nowIso })
      .where(eq(trackedDownloads.id, row.id))
      .run();
    this.timeline.record(subjectOf(row), 'resumed', { message: `Resumed: ${why}`, data: { reason: 'diskSpace' } });
    return true;
  }

  private diskPausedInfo(): { minimumBytes: number; resumeAboveBytes: number } {
    const minimumBytes = this.minimumFreeSpaceBytes();
    return { minimumBytes, resumeAboveBytes: minimumBytes + DISK_RESUME_MARGIN_BYTES };
  }

  /**
   * Why a grab must wait for disk space on its target client, or null when it fits (or the
   * size, the client's folder or its free space is unknown: the grab then goes ahead).
   */
  private async diskHoldReason(config: DownloadClientResource, client: DownloadClient, request: GrabRequest): Promise<string | null> {
    const size = request.sizeBytes ?? 0;
    if (size <= 0 || !this.recovery().diskGuard) return null;
    let root: string;
    try {
      root = (await client.getStatus()).outputRootDir;
    } catch (err) {
      this.log?.debug({ err, client: config.name }, 'disk-space guard: client folder unknown');
      return null;
    }
    if (!root) return null;
    const host = config.implementation === 'builtin' ? 'localhost' : downloadClientHost(config.settings);
    const dir = mapRemoteToLocal(this.listMappings(), host, root);
    const free = await this.freeSpace(dir).catch(() => null);
    if (free === null) return null;
    // What downloads already in that folder still need comes off the free space first.
    const ctx = this.queueContext();
    const prefix = dir.replace(/[\\/]+$/, '');
    const committed = this.db
      .select()
      .from(trackedDownloads)
      .where(and(eq(trackedDownloads.state, 'downloading'), eq(trackedDownloads.clientId, config.id)))
      .all()
      .filter((r) => r.diskPausedAt === null)
      .reduce((sum, r) => {
        const path = this.toTracked(r, ctx, { overlay: false }).outputPath;
        return path !== undefined && path.startsWith(prefix) ? sum + Math.max(0, r.sizeLeft) : sum;
      }, 0);
    return grabHoldReason({ sizeBytes: size, free, committed, minimumBytes: this.minimumFreeSpaceBytes(), dir });
  }

  /** Sends every grab the disk-space guard holds, where there is room now (the RetryHeldGrabs job). */
  async retryHeldGrabs(): Promise<{ held: number; sent: number }> {
    const rows = this.db
      .select()
      .from(trackedDownloads)
      .where(eq(trackedDownloads.state, 'pending'))
      .all()
      .filter((r) => r.pendingGrab?.hold === 'diskSpace');
    let sent = 0;
    for (const row of rows) {
      try {
        const item = await this.retryPending(row.id);
        if (item.trackedState !== 'pending') sent++;
      } catch (err) {
        this.log?.warn({ err, id: row.id }, 'held grab could not be sent');
      }
    }
    return { held: rows.length - sent, sent };
  }

  /** What the disk-space guard holds right now (queue status banner, health check). */
  diskGuardStatus(): NonNullable<QueueStatus['diskGuard']> & { pausedTitles: string[]; heldTitles: string[] } {
    const paused = this.db
      .select({ title: trackedDownloads.title })
      .from(trackedDownloads)
      .where(and(eq(trackedDownloads.state, 'downloading'), isNotNull(trackedDownloads.diskPausedAt)))
      .all();
    const held = this.db
      .select({ title: trackedDownloads.title, pendingGrab: trackedDownloads.pendingGrab })
      .from(trackedDownloads)
      .where(eq(trackedDownloads.state, 'pending'))
      .all()
      .filter((r) => r.pendingGrab?.hold === 'diskSpace');
    return {
      paused: paused.length,
      held: held.length,
      volumes: this.lowVolumes.map((v) => ({ path: v.path, freeBytes: Math.round(v.freeBytes) })),
      minimumFreeBytes: this.minimumFreeSpaceBytes(),
      pausedTitles: paused.map((r) => r.title),
      heldTitles: held.map((r) => r.title),
    };
  }

  // ---- stall recovery ------------------------------------------------------------------

  /**
   * The escalation ladder for stalled downloads: re-announce once per stall, then replace the
   * release when it stays stalled. Never replaces during an engine lockdown, a VPN outage, a
   * pause (user or disk guard), above the progress limit, or downloads Arclight did not grab.
   */
  private async recoverStalled(now: Date, stallMs: number): Promise<void> {
    const settings = this.recovery();
    if (!settings.stallRecovery) return;
    const rows = this.db
      .select()
      .from(trackedDownloads)
      .where(and(eq(trackedDownloads.state, 'downloading'), isNotNull(trackedDownloads.stalledSince)))
      .all();
    let guardOk: boolean | undefined;
    for (const row of rows) {
      if (row.clientId === null || row.stalledSince === null) continue;
      const plan = planStallRecovery(
        { stalledSince: row.stalledSince, reannouncedAt: row.reannouncedAt, progress: row.progress },
        settings,
        now,
        stallMs,
      );
      if (!plan) return;
      if (plan.reannounce) await this.autoReannounce(row);
      if (!plan.replace || !isGrabbed(row) || row.diskPausedAt !== null || row.clientStatus === 'paused') continue;
      if (this.engineLockedDown(row.clientId)) continue;
      guardOk ??= this.replaceGuard ? await this.replaceGuard() : true;
      if (!guardOk) continue;
      const reason = stallReplaceReason(plan.stalledMinutes);
      try {
        await this.replace(row.id, { blocklist: true, removeData: true }, { reason, automatic: true });
        this.log?.info({ id: row.id, title: row.title, reason }, 'replaced a stalled download');
      } catch (err) {
        this.log?.warn({ err, id: row.id }, 'could not replace a stalled download');
      }
    }
  }

  /** Step 1: one re-announce per stall; clients without re-announce just skip the step. */
  private async autoReannounce(row: TrackedDownloadRow): Promise<void> {
    if (row.clientId === null) return;
    const nowIso = this.now().toISOString();
    this.db.update(trackedDownloads).set({ reannouncedAt: nowIso }).where(eq(trackedDownloads.id, row.id)).run();
    const client = this.clientById(row.clientId);
    if (!client.reannounce) return;
    try {
      await client.reannounce(row.downloadId);
      this.timeline.record(subjectOf(row), 'reannounced', {
        message: 'Stalled: asked the trackers (and the DHT) for fresh peers.',
        data: { trigger: 'stall' },
      });
    } catch (err) {
      this.log?.warn({ err, id: row.id }, 'stall recovery: re-announce failed');
    }
  }

  /** True when `clientId` is the built-in engine and it is locked down by the VPN kill switch. */
  private engineLockedDown(clientId: number): boolean {
    const row = this.db.select({ implementation: downloadClients.implementation }).from(downloadClients).where(eq(downloadClients.id, clientId)).get();
    return row?.implementation === 'builtin' && (this.engineInsights?.lockdown() ?? null) !== null;
  }

  /** Re-announce action (POST /queue/:id/reannounce): fresh peers for one download. */
  async reannounce(id: number): Promise<QueueReannounceResult> {
    const row = this.db.select().from(trackedDownloads).where(eq(trackedDownloads.id, id)).get();
    if (!row) throw notFound('Queue item', id);
    if (row.clientId === null || row.state === 'pending') {
      throw new DownloadClientsError('VALIDATION', 'This download has not been sent to a download client yet');
    }
    const config = rowToResource(this.requireRow(row.clientId));
    const client = this.clientFor(config);
    if (!client.reannounce) throw new DownloadClientsError('VALIDATION', `${config.name} cannot re-announce downloads`);
    try {
      await client.reannounce(row.downloadId);
    } catch (err) {
      const code = err instanceof DownloadClientError && (err.code === 'rejected' || err.code === 'not-found') ? 'VALIDATION' : 'CLIENT_ERROR';
      throw new DownloadClientsError(code, `${config.name}: ${errorMessage(err)}`, { cause: err });
    }
    const message = `Asked ${config.name} for fresh peers.`;
    this.timeline.record(subjectOf(row), 'reannounced', { message, data: { trigger: 'manual' } });
    this.db.update(trackedDownloads).set({ reannouncedAt: this.now().toISOString() }).where(eq(trackedDownloads.id, id)).run();
    return { id, message };
  }

  /**
   * Gives up on a download's release: removes it from the client (with or without its data),
   * blocklists it through the failed-download pipeline (history `downloadFailed` + blocklist,
   * with `reason`) and starts a search for another release. Used by the "Try another release"
   * action and by stall recovery (`automatic`).
   */
  async replace(
    id: number,
    options: { blocklist: boolean; removeData: boolean },
    meta: { reason?: string; automatic?: boolean } = {},
  ): Promise<QueueReplaceResult> {
    const row = this.db.select().from(trackedDownloads).where(eq(trackedDownloads.id, id)).get();
    if (!row) throw notFound('Queue item', id);
    if (!VISIBLE_STATES.includes(row.state) || row.state === 'importing') {
      throw new DownloadClientsError('VALIDATION', `Queue item ${id} cannot be replaced while ${row.state}`);
    }
    const item = this.toTracked(row, this.queueContext());
    const sent = row.clientId !== null && row.state !== 'pending';
    const clientName = item.downloadClientName ?? 'the download client';
    if (sent && row.clientId !== null) {
      try {
        await this.clientById(row.clientId).removeItem(row.downloadId, options.removeData);
      } catch (err) {
        if (!(err instanceof DownloadClientError && err.code === 'not-found')) {
          throw new DownloadClientsError('CLIENT_ERROR', `${clientName}: ${errorMessage(err)}`, { cause: err });
        }
      }
    }
    const reason = meta.reason ?? 'replaced by the user';
    if (options.blocklist) {
      if (this.blocklistHooks.size === 0) this.log?.warn({ id }, 'blocklist requested but no blocklist handler is registered');
      for (const hook of this.blocklistHooks) {
        try {
          // The search below is the one re-search; the failed pipeline must not start another.
          await hook(item, { skipRedownload: true, message: capitalize(reason) });
        } catch (err) {
          this.log?.error({ err, id }, 'blocklist hook failed');
        }
      }
    }
    let searchStarted = false;
    if (this.replacementSearch) {
      try {
        searchStarted = await this.replacementSearch(item);
      } catch (err) {
        this.log?.warn({ err, id }, 'replacement search could not start');
      }
    }
    const steps = [
      sent ? `removed from ${clientName}${options.removeData ? ' with its data' : ''}` : 'dropped from the queue',
      options.blocklist ? 'release blocklisted' : null,
      searchStarted ? 'searching for another release' : 'nothing to search for',
    ].filter(Boolean);
    const message = `${meta.automatic ? 'Gave up on this release' : 'Replaced on request'} (${reason}): ${steps.join(', ')}.`;
    this.timeline.record(subjectOf(row), 'replaced', {
      message,
      data: { trigger: meta.automatic ? 'stall' : 'manual', blocklisted: options.blocklist, search: searchStarted },
    });
    this.db.delete(trackedDownloads).where(eq(trackedDownloads.id, id)).run();
    this.dirty = true;
    this.bus?.publish({ type: 'queue', action: 'changed' });
    return { id, blocklisted: options.blocklist, searchStarted, message };
  }

  /** Downloads still transferring, with local paths (disk-space and stall health checks). */
  activeDownloads(): ActiveDownloadInfo[] {
    const ctx = this.queueContext();
    return this.db
      .select()
      .from(trackedDownloads)
      .where(eq(trackedDownloads.state, 'downloading'))
      .all()
      .map((row) => {
        const tracked = this.toTracked(row, ctx, { overlay: false });
        return {
          id: row.id,
          title: row.title,
          clientName: tracked.downloadClientName,
          sizeLeft: row.sizeLeft,
          ...(tracked.outputPath !== undefined ? { path: tracked.outputPath } : {}),
          ...(row.stalledSince !== null ? { stalledSince: row.stalledSince } : {}),
          ...(row.stateCode !== null ? { stateCode: row.stateCode } : {}),
        };
      });
  }

  /** Timeline of a tracked download, oldest first (also after it left the queue). */
  getTimeline(id: number): DownloadTimeline {
    const exists = this.db.select({ id: trackedDownloads.id }).from(trackedDownloads).where(eq(trackedDownloads.id, id)).get();
    if (!exists && !this.timeline.has(id)) throw notFound('Queue item', id);
    return this.timeline.list(id);
  }

  /** Deletes timeline entries older than `days` (default 30). Returns the count. */
  pruneTimeline(days?: number): number {
    return this.timeline.prune(days);
  }


  private outputPathProblem(remotePath: string, host: string, mappings: RemotePathMapping[]): string | undefined {
    if (remotePath.trim() === '') return STATUS_TEXT.noOutputPath;
    const local = mapRemoteToLocal(mappings, host, remotePath);
    if (!isValidLocalPath(local, this.platform)) return STATUS_TEXT.invalidLocalPath(local);
    return undefined;
  }

  /** Items the client stopped reporting: flag them, then drop them after the grace period. */
  private handleMissing(config: DownloadClientResource, seen: Set<string>, now: Date): number {
    const rows = this.db.select().from(trackedDownloads).where(eq(trackedDownloads.clientId, config.id)).all();
    let removed = 0;
    for (const row of rows) {
      if (seen.has(row.downloadId) || PROTECTED_STATES.includes(row.state)) continue;
      const lastSeen = row.lastSeenAt ? Date.parse(row.lastSeenAt) : Date.parse(row.addedAt);
      if (now.getTime() - lastSeen >= this.missingGraceMs) {
        if (isGrabbed(row)) {
          this.timeline.record({ id: row.id, downloadId: row.downloadId, title: row.title }, 'removed', {
            message: `${config.name} stopped reporting this download; it is no longer tracked.`,
            severity: 'warning',
          });
        }
        this.db.delete(trackedDownloads).where(eq(trackedDownloads.id, row.id)).run();
        removed++;
        continue;
      }
      const update: Partial<TrackedDownloadRow> = { clientStatus: 'unknown', updatedAt: now.toISOString() };
      if (row.state === 'downloading') {
        update.trackedStatus = 'warning';
        update.statusMessages = [{ title: row.title, messages: [STATUS_TEXT.missing(config.name)] }];
      }
      this.db.update(trackedDownloads).set(update).where(eq(trackedDownloads.id, row.id)).run();
    }
    return removed;
  }

  private flagClientUnavailable(config: DownloadClientResource, message: string, nowIso: string): void {
    this.db
      .update(trackedDownloads)
      .set({
        trackedStatus: 'warning',
        statusMessages: [{ title: config.name, messages: [STATUS_TEXT.clientUnavailable(config.name, message)] }],
        updatedAt: nowIso,
      })
      .where(and(eq(trackedDownloads.clientId, config.id), eq(trackedDownloads.state, 'downloading')))
      .run();
  }

  private purgeTerminal(now: Date): number {
    const cutoff = new Date(now.getTime() - this.terminalRetentionMs).toISOString();
    const deleted = this.db
      .delete(trackedDownloads)
      .where(
        and(
          inArray(trackedDownloads.state, [...TERMINAL_TRACKED_STATES]),
          isNotNull(trackedDownloads.lastSeenAt),
          lt(trackedDownloads.lastSeenAt, cutoff),
        ),
      )
      .returning({ id: trackedDownloads.id })
      .all();
    return deleted.length;
  }

  private async fire(hooks: Set<TrackedDownloadHook>, id: number): Promise<void> {
    if (hooks.size === 0) return;
    const item = this.getTracked(id);
    for (const hook of hooks) {
      try {
        await hook(item);
      } catch (err) {
        this.log?.error({ err, trackedDownloadId: id }, 'download hook failed');
      }
    }
  }

  // ---- tracked downloads (pipeline-facing) ---------------------------------------------

  getTracked(id: number): TrackedDownload {
    const row = this.db.select().from(trackedDownloads).where(eq(trackedDownloads.id, id)).get();
    if (!row) throw notFound('Queue item', id);
    return this.toTracked(row, this.queueContext());
  }

  listTracked(states?: readonly TrackedDownloadState[]): TrackedDownload[] {
    const query = this.db.select().from(trackedDownloads);
    const rows = states ? query.where(inArray(trackedDownloads.state, [...states])).all() : query.all();
    const ctx = this.queueContext();
    return rows.map((row) => this.toTracked(row, ctx));
  }

  /** Moves a tracked download to another state (import/failed handling). */
  setState(
    id: number,
    state: TrackedDownloadState,
    options: { statusMessages?: QueueStatusMessage[]; trackedStatus?: TrackedDownloadStatus } = {},
  ): TrackedDownload {
    const before = this.getTracked(id);
    this.recordStateChange(before, state, options);
    this.db
      .update(trackedDownloads)
      .set({
        state,
        updatedAt: this.now().toISOString(),
        ...(options.statusMessages ? { statusMessages: options.statusMessages } : {}),
        ...(options.trackedStatus ? { trackedStatus: options.trackedStatus } : {}),
      })
      .where(eq(trackedDownloads.id, id))
      .run();
    return this.getTracked(id);
  }

  /** Timeline entry for a pipeline-driven state change (import started/blocked/failed, ...). */
  private recordStateChange(
    before: TrackedDownload,
    state: TrackedDownloadState,
    options: { statusMessages?: QueueStatusMessage[]; trackedStatus?: TrackedDownloadStatus },
  ): void {
    const message = options.statusMessages?.flatMap((m) => m.messages).find((m) => m.trim());
    const withMessage = message !== undefined ? { message } : {};
    let type: DownloadEventType | null = null;
    if (state === 'importing' && before.trackedState !== 'importing') type = 'importStarted';
    else if (state === 'imported' && before.trackedState !== 'imported') type = 'imported';
    else if (state === 'importPending' && options.trackedStatus !== undefined && options.trackedStatus !== 'ok') type = 'importBlocked';
    else if (state === 'failed') type = before.trackedState === 'importing' || before.trackedState === 'importPending' ? 'importFailed' : 'error';
    else if (state === 'failedPending' && before.trackedState !== 'failedPending') type = 'error';
    if (!type) return;
    const subject = { id: before.id, downloadId: before.downloadId, title: before.title };
    // Retried imports report the same blocker every pass: keep one entry per distinct message.
    const last = this.timeline.list(before.id).events.at(-1);
    if (type === 'importBlocked' && last?.type === 'importBlocked' && last.message === message) return;
    try {
      this.timeline.record(subject, type, withMessage);
    } catch (err) {
      this.log?.warn({ err, id: before.id }, 'could not record a timeline entry');
    }
  }

  /**
   * Marks an import as done: state `imported`, applies the client's post-import category and
   * removes the item when the client is set to remove completed downloads and may do so.
   */
  async markImported(id: number): Promise<TrackedDownload> {
    const item = this.setState(id, 'imported', { statusMessages: [], trackedStatus: 'ok' });
    if (item.downloadClientId === null) return item;
    const row = this.db.select().from(downloadClients).where(eq(downloadClients.id, item.downloadClientId)).get();
    if (!row) return item;
    const config = rowToResource(row);
    const client = this.clientFor(config);
    try {
      const postImport = config.settings.postImportCategory;
      if (postImport) await client.setCategory(item.downloadId, postImport);
      if (config.removeCompletedDownloads && item.canBeRemoved && item.status !== 'downloading') {
        await client.removeItem(item.downloadId, true);
      }
    } catch (err) {
      this.log?.warn({ err, downloadId: item.downloadId }, 'post-import client action failed');
    }
    return item;
  }

  // ---- grab ----------------------------------------------------------------------------

  /**
   * Sends a release to a download client and starts tracking it. `clientId` null picks a
   * client by protocol and `tracking.tags`. Throws `DownloadClientsError` (NO_CLIENT,
   * VALIDATION, CLIENT_ERROR with the package's `DownloadClientError` as cause).
   */
  async grab(clientId: number | null, request: GrabRequest, tracking: TrackingInfo = {}): Promise<TrackedDownload> {
    return this.sendAndRecord(clientId, request, tracking, null);
  }

  /** Records a grab that could not be sent yet (state `pending`); retry with `retryPending`. */
  addPending(request: GrabRequest, tracking: TrackingInfo = {}, reason?: string): TrackedDownload {
    return this.insertPending(request, tracking, reason);
  }

  private insertPending(
    request: GrabRequest,
    tracking: TrackingInfo,
    reason: string | undefined,
    hold?: { clientId: number | null },
  ): TrackedDownload {
    validateGrab(request);
    const nowIso = this.now().toISOString();
    const pendingGrab: PendingGrabPayload = {
      ...(hold ? { hold: 'diskSpace' as const, ...(hold.clientId !== null ? { clientId: hold.clientId } : {}) } : {}),
      ...(request.sizeBytes !== undefined ? { sizeBytes: request.sizeBytes } : {}),
      title: request.title,
      isRecent: request.isRecent ?? false,
      protocol: request.protocol ?? 'torrent',
      tags: tracking.tags ?? [],
      ...(request.magnet !== undefined ? { magnet: request.magnet } : {}),
      ...(request.torrentFile !== undefined ? { torrentFileBase64: Buffer.from(request.torrentFile).toString('base64') } : {}),
      ...(request.nzb !== undefined ? { nzbBase64: Buffer.from(request.nzb).toString('base64') } : {}),
      ...(request.category !== undefined ? { category: request.category } : {}),
      ...(request.seedConfig !== undefined ? { seedConfig: request.seedConfig } : {}),
      ...(reason !== undefined ? { reason } : {}),
    };
    const row = this.db
      .insert(trackedDownloads)
      .values({
        downloadId: `pending:${randomUUID()}`,
        clientId: null,
        title: request.title,
        state: 'pending',
        trackedStatus: reason ? 'warning' : 'ok',
        statusMessages: reason ? [{ title: request.title, messages: [reason] }] : [],
        protocol: pendingGrab.protocol,
        addedAt: nowIso,
        updatedAt: nowIso,
        pendingGrab,
        ...trackingColumns(tracking),
      })
      .returning()
      .get();
    this.timeline.record(subjectOf(row), hold ? 'held' : 'pending', {
      message: reason ?? 'Waiting to be sent to a download client.',
      ...(reason ? { severity: 'warning' as const } : {}),
    });
    this.bus?.publish({ type: 'queue', action: 'changed' });
    return this.toTracked(row, this.queueContext());
  }

  /**
   * Retries a `pending` queue item (POST /queue/grab/:id, and the RetryHeldGrabs job for grabs
   * the disk-space guard holds). `force` sends it even when the guard would hold it again.
   */
  async retryPending(id: number, options: { force?: boolean } = {}): Promise<TrackedDownload> {
    const row = this.db.select().from(trackedDownloads).where(eq(trackedDownloads.id, id)).get();
    if (!row) throw notFound('Queue item', id);
    if (row.state !== 'pending' || !row.pendingGrab) {
      throw new DownloadClientsError('VALIDATION', `Queue item ${id} is not a pending grab`);
    }
    const p = row.pendingGrab;
    const request: GrabRequest = {
      title: p.title,
      isRecent: p.isRecent,
      protocol: p.protocol,
      ...(p.magnet !== undefined ? { magnet: p.magnet } : {}),
      ...(p.torrentFileBase64 !== undefined ? { torrentFile: new Uint8Array(Buffer.from(p.torrentFileBase64, 'base64')) } : {}),
      ...(p.nzbBase64 !== undefined ? { nzb: new Uint8Array(Buffer.from(p.nzbBase64, 'base64')) } : {}),
      ...(p.category !== undefined ? { category: p.category } : {}),
      ...(p.seedConfig !== undefined ? { seedConfig: p.seedConfig } : {}),
      ...(p.sizeBytes !== undefined && !options.force ? { sizeBytes: p.sizeBytes } : {}),
    };
    const tracking: TrackingInfo = { tags: p.tags, grabbedRelease: row.grabbedRelease, ...trackingFromRow(row) };
    // The client it was meant for, while that client still exists; otherwise pick again.
    const clientId =
      p.clientId !== undefined && this.db.select({ id: downloadClients.id }).from(downloadClients).where(eq(downloadClients.id, p.clientId)).get()
        ? p.clientId
        : null;
    try {
      return await this.sendAndRecord(clientId, request, tracking, row.id);
    } catch (err) {
      this.db
        .update(trackedDownloads)
        .set({
          trackedStatus: 'warning',
          statusMessages: [{ title: row.title, messages: [`Grab failed: ${errorMessage(err)}`] }],
          updatedAt: this.now().toISOString(),
        })
        .where(eq(trackedDownloads.id, row.id))
        .run();
      throw err;
    }
  }

  private async sendAndRecord(
    clientId: number | null,
    request: GrabRequest,
    tracking: TrackingInfo,
    pendingRowId: number | null,
  ): Promise<TrackedDownload> {
    validateGrab(request);
    const protocol = request.protocol ?? 'torrent';
    let target: { config: DownloadClientResource; client: DownloadClient };
    if (clientId !== null) {
      const config = rowToResource(this.requireRow(clientId));
      if (!config.enable) throw new DownloadClientsError('VALIDATION', `Download client ${config.name} is disabled`);
      if (config.protocol !== protocol) {
        throw new DownloadClientsError('NO_CLIENT', `${config.name} is a ${config.protocol} client and cannot download ${protocol} releases`);
      }
      target = { config, client: this.clientFor(config) };
    } else {
      const picked = this.pickClient(protocol, tracking.tags ?? []);
      if (!picked) throw new DownloadClientsError('NO_CLIENT', `No enabled ${protocol} download client is available`);
      target = { config: rowToResource(this.requireRow(picked.id)), client: picked.client };
    }

    // Disk-space guard: a grab that would not leave the minimum free waits as a held item.
    const hold = await this.diskHoldReason(target.config, target.client, request);
    if (hold) return this.holdGrab(request, tracking, hold, clientId, pendingRowId);

    const category = request.category ?? target.config.settings.category;
    const isRecent = request.isRecent ?? false;
    let result;
    try {
      if (protocol === 'usenet') {
        const client = target.client;
        if (!client.addNzb || request.nzb === undefined) {
          throw new DownloadClientError('not-supported', `${target.config.name} cannot download NZB releases`);
        }
        result = await client.addNzb({ nzb: request.nzb, title: request.title, category, isRecent });
      } else {
        result = await target.client.addTorrent({
          title: request.title,
          category,
          isRecent,
          ...(request.magnet !== undefined ? { magnet: request.magnet } : {}),
          ...(request.torrentFile !== undefined ? { torrentFile: request.torrentFile } : {}),
          ...(request.seedConfig?.ratioLimit !== undefined ? { seedRatioLimit: request.seedConfig.ratioLimit } : {}),
          ...(request.seedConfig?.seedTimeLimitMinutes !== undefined
            ? { seedTimeLimitMinutes: request.seedConfig.seedTimeLimitMinutes }
            : {}),
        });
      }
    } catch (err) {
      throw new DownloadClientsError('CLIENT_ERROR', `${target.config.name}: ${errorMessage(err)}`, { cause: err });
    }

    const nowIso = this.now().toISOString();
    const values = {
      downloadId: result.id,
      clientId: target.config.id,
      title: request.title,
      state: 'downloading' as const,
      trackedStatus: (result.warnings.length > 0 ? 'warning' : 'ok') as TrackedDownloadStatus,
      statusMessages: result.warnings.length > 0 ? [{ title: request.title, messages: result.warnings }] : [],
      protocol: target.config.protocol,
      clientStatus: 'queued' as const,
      addedAt: nowIso,
      lastSeenAt: nowIso,
      updatedAt: nowIso,
      pendingGrab: null,
      ...trackingColumns(tracking),
    };

    const existing = this.db
      .select({ id: trackedDownloads.id })
      .from(trackedDownloads)
      .where(and(eq(trackedDownloads.clientId, target.config.id), eq(trackedDownloads.downloadId, result.id)))
      .get();

    const pendingDownloadId =
      pendingRowId === null
        ? undefined
        : this.db.select({ downloadId: trackedDownloads.downloadId }).from(trackedDownloads).where(eq(trackedDownloads.id, pendingRowId)).get()
            ?.downloadId;
    let id: number;
    if (existing) {
      // Re-grab of a known id: start over (drops a previous imported/failed/ignored state).
      if (pendingRowId !== null) this.db.delete(trackedDownloads).where(eq(trackedDownloads.id, pendingRowId)).run();
      this.db.update(trackedDownloads).set(values).where(eq(trackedDownloads.id, existing.id)).run();
      id = existing.id;
    } else if (pendingRowId !== null) {
      this.db.update(trackedDownloads).set(values).where(eq(trackedDownloads.id, pendingRowId)).run();
      id = pendingRowId;
    } else {
      id = this.db.insert(trackedDownloads).values(values).returning({ id: trackedDownloads.id }).get().id;
    }
    this.dirty = true;
    const warning = result.warnings.length > 0 ? ` (${result.warnings.join(' ')})` : '';
    this.timeline.record({ id, downloadId: result.id, title: request.title }, 'grabbed', {
      message: `Sent to ${target.config.name}${warning}.`,
      data: { client: target.config.name },
    });
    const sent = this.getTracked(id);
    if (pendingDownloadId !== undefined && pendingDownloadId !== sent.downloadId) {
      for (const hook of this.pendingSentHooks) {
        try {
          await hook(sent, pendingDownloadId);
        } catch (err) {
          this.log?.warn({ err, id }, 'pending-sent hook failed');
        }
      }
    }
    return sent;
  }

  /**
   * Keeps a grab back for disk space: a new held queue item, or (a retry of one) the same item
   * with the current reason. Only a new or changed hold goes on the timeline.
   */
  private holdGrab(
    request: GrabRequest,
    tracking: TrackingInfo,
    reason: string,
    clientId: number | null,
    pendingRowId: number | null,
  ): TrackedDownload {
    if (pendingRowId === null) {
      this.log?.info({ title: request.title, reason }, 'grab held for disk space');
      return this.insertPending(request, tracking, reason, { clientId });
    }
    const row = this.db.select().from(trackedDownloads).where(eq(trackedDownloads.id, pendingRowId)).get();
    if (!row) throw notFound('Queue item', pendingRowId);
    const wasHeld = row.pendingGrab?.hold === 'diskSpace';
    const nowIso = this.now().toISOString();
    this.db
      .update(trackedDownloads)
      .set({
        trackedStatus: 'warning',
        statusMessages: [{ title: row.title, messages: [reason] }],
        updatedAt: nowIso,
        ...(row.pendingGrab
          ? { pendingGrab: { ...row.pendingGrab, hold: 'diskSpace' as const, reason, ...(clientId !== null ? { clientId } : {}) } }
          : {}),
      })
      .where(eq(trackedDownloads.id, pendingRowId))
      .run();
    if (!wasHeld) this.timeline.record(subjectOf(row), 'held', { message: reason });
    return this.getTracked(pendingRowId);
  }

  // ---- queue view ----------------------------------------------------------------------

  listQueue(rawQuery: QueueQueryInput = {}): QueuePage {
    const parsed = QueueQuery.safeParse(rawQuery);
    if (!parsed.success) throw new DownloadClientsError('VALIDATION', z.prettifyError(parsed.error));
    const q = parsed.data;
    let items: QueueItem[] = this.visibleItems();
    if (!q.includeUnknownMediaItems) items = items.filter((i) => !isUnknownMedia(i));
    if (q.downloadClientId !== undefined) items = items.filter((i) => i.downloadClientId === q.downloadClientId);
    if (q.protocol) items = items.filter((i) => i.protocol === q.protocol);
    if (q.trackedState) items = items.filter((i) => i.trackedState === q.trackedState);
    if (q.status) items = items.filter((i) => i.status === q.status);
    if (q.mediaType) items = items.filter((i) => i.mediaType === q.mediaType);
    if (q.seriesId !== undefined) items = items.filter((i) => i.seriesId === q.seriesId);
    if (q.movieId !== undefined) items = items.filter((i) => i.movieId === q.movieId);

    const dir = q.sortDirection === 'asc' ? 1 : -1;
    items.sort((a, b) => {
      const c = compareValues(a[q.sortKey], b[q.sortKey]);
      return c !== 0 ? c * dir : a.id - b.id;
    });

    const start = (q.page - 1) * q.pageSize;
    return {
      page: q.page,
      pageSize: q.pageSize,
      sortKey: q.sortKey,
      sortDirection: q.sortDirection,
      totalRecords: items.length,
      records: items.slice(start, start + q.pageSize),
    };
  }

  /** GET /queue/summary: the state of every queue item linked to a series or movie, nothing else. */
  queueSummary(): QueueSummaryItem[] {
    return this.visibleItems()
      .filter((i) => !isUnknownMedia(i))
      .map((i) => ({
        id: i.id,
        ...(i.mediaType !== undefined ? { mediaType: i.mediaType } : {}),
        ...(i.seriesId !== undefined ? { seriesId: i.seriesId } : {}),
        ...(i.episodeIds !== undefined ? { episodeIds: i.episodeIds } : {}),
        ...(i.movieId !== undefined ? { movieId: i.movieId } : {}),
        trackedState: i.trackedState,
        trackedStatus: i.trackedStatus,
        status: i.status,
        progress: i.progress,
        ...(i.eta !== undefined ? { eta: i.eta } : {}),
        ...(i.stateCode !== undefined ? { stateCode: i.stateCode } : {}),
        ...(i.stateSeverity !== undefined ? { stateSeverity: i.stateSeverity } : {}),
      }));
  }

  getQueueItem(id: number): QueueItem {
    return stripTracked(this.getTracked(id));
  }

  queueStatus(): QueueStatus {
    const items = this.visibleItems();
    const unknownCount = items.filter(isUnknownMedia).length;
    const guard = this.diskGuardStatus();
    return {
      totalCount: items.length - unknownCount,
      unknownCount,
      errors: items.filter((i) => i.trackedStatus === 'error').length,
      warnings: items.filter((i) => i.trackedStatus === 'warning').length,
      diskGuard: { paused: guard.paused, held: guard.held, volumes: guard.volumes, minimumFreeBytes: guard.minimumFreeBytes },
    };
  }

  /**
   * Removes queue items. With `removeFromClient` the download (and its data) is deleted from
   * the client and tracking stops; without it the item is marked `ignored` so it stays out of
   * the queue. `blocklist` hands each item to the blocklist hooks first.
   */
  async removeQueueItems(
    ids: readonly number[],
    options: { removeFromClient: boolean; blocklist: boolean; skipRedownload: boolean },
  ): Promise<QueueRemoveResult> {
    const result: QueueRemoveResult = { removed: [], failed: [] };
    for (const id of ids) {
      const row = this.db.select().from(trackedDownloads).where(eq(trackedDownloads.id, id)).get();
      if (!row) {
        result.failed.push({ id, error: `Queue item ${id} not found` });
        continue;
      }
      const sent = row.clientId !== null && row.state !== 'pending';
      if (options.removeFromClient && sent && row.clientId !== null) {
        try {
          await this.clientById(row.clientId).removeItem(row.downloadId, true);
        } catch (err) {
          if (!(err instanceof DownloadClientError && err.code === 'not-found')) {
            result.failed.push({ id, error: errorMessage(err) });
            continue;
          }
        }
      }
      if (options.blocklist) {
        const item = this.toTracked(row, this.queueContext());
        if (this.blocklistHooks.size === 0) this.log?.warn({ id }, 'blocklist requested but no blocklist handler is registered');
        for (const hook of this.blocklistHooks) {
          try {
            await hook(item, { skipRedownload: options.skipRedownload });
          } catch (err) {
            this.log?.error({ err, id }, 'blocklist hook failed');
          }
        }
      }
      const how = [
        options.removeFromClient && sent ? 'deleted from the download client' : 'no longer tracked',
        options.blocklist ? 'release blocklisted' : null,
      ].filter(Boolean);
      this.timeline.record({ id: row.id, downloadId: row.downloadId, title: row.title }, 'removed', {
        message: `Removed from the queue: ${how.join(', ')}.`,
      });
      if (options.removeFromClient || !sent) {
        this.db.delete(trackedDownloads).where(eq(trackedDownloads.id, id)).run();
      } else {
        this.db
          .update(trackedDownloads)
          .set({ state: 'ignored', statusMessages: [], trackedStatus: 'ok', updatedAt: this.now().toISOString() })
          .where(eq(trackedDownloads.id, id))
          .run();
      }
      result.removed.push(id);
    }
    return result;
  }

  // ---- engine control: per-download limits, queue order, force start, slow mode ------------

  /** The client of a queue item that has been sent to one, with the item's client-side id. */
  private controllable(id: number): { row: TrackedDownloadRow; config: DownloadClientResource; client: DownloadClient } {
    const row = this.db.select().from(trackedDownloads).where(eq(trackedDownloads.id, id)).get();
    if (!row) throw notFound('Queue item', id);
    if (row.clientId === null || row.state === 'pending') throw new DownloadClientsError('CONFLICT', 'This download has not been sent to a download client yet.');
    const config = rowToResource(this.requireRow(row.clientId));
    return { row, config, client: this.clientFor(config) };
  }

  private async control(id: number, what: string, run: (client: DownloadClient, downloadId: string) => Promise<void> | undefined): Promise<QueueItem> {
    const { row, config, client } = this.controllable(id);
    let pending: Promise<void> | undefined;
    try {
      pending = run(client, row.downloadId);
    } catch (err) {
      throw new DownloadClientsError('CLIENT_ERROR', `${config.name}: ${errorMessage(err)}`, { cause: err });
    }
    if (!pending) throw new DownloadClientsError('CONFLICT', `${config.name} does not support ${what}.`);
    try {
      await pending;
    } catch (err) {
      throw new DownloadClientsError('CLIENT_ERROR', `${config.name}: ${errorMessage(err)}`, { cause: err });
    }
    // The built-in engine's numbers are overlaid live; other clients show the change on the next poll.
    this.requestRefresh();
    this.bus?.publish({ type: 'queue', action: 'changed' });
    return this.getQueueItem(id);
  }

  /** Speed limits of one download in bytes/s (0 = unlimited); omitted keys keep their value. */
  setItemLimits(id: number, limits: { downloadLimit?: number | undefined; uploadLimit?: number | undefined }): Promise<QueueItem> {
    const patch: ItemSpeedLimits = {};
    if (limits.downloadLimit !== undefined) patch.downloadLimit = limits.downloadLimit;
    if (limits.uploadLimit !== undefined) patch.uploadLimit = limits.uploadLimit;
    return this.control(id, 'per-download speed limits', (client, downloadId) => client.setItemLimits?.(downloadId, patch));
  }

  /** Moves a download in its client's queue (top / up / down / bottom). */
  moveInQueue(id: number, move: QueueMove): Promise<QueueItem> {
    return this.control(id, 'reordering its queue', (client, downloadId) => client.moveInQueue?.(downloadId, move));
  }

  /** Starts a download regardless of the client's active-download limit (or stops forcing it). */
  setForceStart(id: number, enabled: boolean): Promise<QueueItem> {
    return this.control(id, 'force start', (client, downloadId) => client.setForceStart?.(downloadId, enabled));
  }

  /**
   * Switches the alternative speed limits of every enabled client that has them (qBittorrent),
   * following Arclight's slow mode. Per-client failures are reported, never thrown.
   */
  async setAlternativeSpeedOnAll(enabled: boolean): Promise<Array<{ id: number; name: string; ok: boolean; message?: string }>> {
    const results: Array<{ id: number; name: string; ok: boolean; message?: string }> = [];
    for (const { config, client } of this.enabledClients()) {
      if (config.implementation === 'builtin' || !client.setAlternativeSpeed) continue;
      try {
        await client.setAlternativeSpeed(enabled);
        results.push({ id: config.id, name: config.name, ok: true });
      } catch (err) {
        results.push({ id: config.id, name: config.name, ok: false, message: errorMessage(err) });
      }
    }
    return results;
  }

  /**
   * Timeline entry for the built-in engine's torrent `infoHash`, whatever state its tracked
   * download is in (the seeding rules act after import). No-op when Arclight does not track it.
   */
  recordEngineEvent(infoHash: string, type: DownloadEventType, options: RecordOptions = {}): void {
    const builtinIds = this.db
      .select({ id: downloadClients.id })
      .from(downloadClients)
      .where(eq(downloadClients.implementation, 'builtin'))
      .all()
      .map((r) => r.id);
    if (builtinIds.length === 0) return;
    const rows = this.db
      .select()
      .from(trackedDownloads)
      .where(and(inArray(trackedDownloads.clientId, builtinIds), eq(trackedDownloads.downloadId, infoHash.toLowerCase())))
      .all();
    for (const row of rows) {
      try {
        this.timeline.record({ id: row.id, downloadId: row.downloadId, title: row.title }, type, options);
      } catch (err) {
        this.log?.warn({ err, id: row.id }, 'could not record a timeline entry');
      }
    }
  }

  private visibleItems(): QueueItem[] {
    const ctx = this.queueContext();
    return this.db
      .select()
      .from(trackedDownloads)
      .where(inArray(trackedDownloads.state, VISIBLE_STATES))
      .all()
      .map((row) => stripTracked(this.toTracked(row, ctx)));
  }

  private queueContext(mappings: RemotePathMapping[] = this.listMappings()): QueueContext {
    const clients = new Map<number, QueueContextClient>();
    for (const row of this.db.select().from(downloadClients).all()) {
      const host = row.implementation === 'builtin' ? 'localhost' : downloadClientHost(row.settings);
      clients.set(row.id, { name: row.name, host, implementation: row.implementation });
    }
    const insights = this.engineInsights;
    const killSwitch = new Set(insights?.killSwitchPaused() ?? []);
    const lockdownReason = insights?.lockdown()?.reason;
    return {
      clients,
      mappings,
      killSwitch,
      ...(lockdownReason !== undefined ? { lockdownReason } : {}),
      engineStarting: insights?.starting?.() ?? false,
      maxActiveDownloads: insights?.maxActiveDownloads?.() ?? null,
      stallMinutes: Math.round(Math.max(0, this.stallAfterMs()) / 60_000),
      stallMs: Math.max(0, this.stallAfterMs()),
      recovery: this.recovery(),
      diskPaused: this.diskPausedInfo(),
      now: this.now(),
    };
  }

  /**
   * Row -> pipeline shape, with the derived state reason. `overlay` (default) replaces the
   * last poll's numbers of a built-in engine torrent with the engine's live ones.
   */
  private toTracked(row: TrackedDownloadRow, ctx: QueueContext, options: { overlay?: boolean } = {}): TrackedDownload {
    const client = row.clientId === null ? undefined : ctx.clients.get(row.clientId);
    const localPath =
      row.outputPath === null ? undefined : client ? mapRemoteToLocal(ctx.mappings, client.host, row.outputPath) : row.outputPath;
    const builtin = client?.implementation === 'builtin' && row.state === 'downloading';
    const engine = builtin && (options.overlay ?? true) ? (this.engineInsights?.live?.(row.downloadId) ?? null) : null;
    const live = engine?.live ?? row.live ?? undefined;
    const progress = engine?.progress ?? row.progress;
    const health = row.clientId === null ? undefined : this.clientHealth.get(row.clientId);
    const killSwitch =
      builtin && ctx.killSwitch.has(row.downloadId) ? (ctx.lockdownReason !== undefined ? { reason: ctx.lockdownReason } : {}) : undefined;
    const state = deriveState({
      state: row.state,
      clientStatus: row.clientStatus,
      trackedStatus: row.trackedStatus,
      statusMessages: row.statusMessages,
      phase: engine ? engine.phase : row.phase,
      live,
      progress,
      stalledSince: row.stalledSince,
      stallMinutes: ctx.stallMinutes,
      diskShortfall: row.diskShortfall,
      clientName: client?.name ?? null,
      ...(builtin && ctx.engineStarting ? { engineStarting: true } : health && !health.ok ? { clientError: health.message ?? 'unknown error' } : {}),
      killSwitch,
      importCopy: this.importCopyOf(row.downloadId),
      maxActiveDownloads: builtin ? ctx.maxActiveDownloads : null,
      diskPaused: row.state === 'downloading' && row.diskPausedAt !== null ? ctx.diskPaused : undefined,
      diskHeld: row.state === 'pending' && row.pendingGrab?.hold === 'diskSpace',
      stallRecovery:
        row.stalledSince === null
          ? undefined
          : planStallRecovery(
              { stalledSince: row.stalledSince, reannouncedAt: row.reannouncedAt, progress },
              ctx.recovery,
              ctx.now,
              ctx.stallMs,
            )?.info,
    });
    const etaMs = engine ? engine.etaMs : row.etaMs ?? undefined;
    return {
      id: row.id,
      downloadId: row.downloadId,
      downloadClientId: row.clientId,
      downloadClientName: client?.name ?? null,
      title: row.title,
      status: row.clientStatus,
      trackedStatus: row.trackedStatus,
      statusMessages: row.statusMessages,
      protocol: row.protocol,
      sizeBytes: row.size,
      sizeLeftBytes: engine ? engine.sizeLeft : row.sizeLeft,
      progress,
      added: row.addedAt,
      trackedState: row.state,
      canMoveFiles: row.canMoveFiles,
      canBeRemoved: row.canBeRemoved,
      isReadOnly: row.isReadOnly,
      grabbedRelease: row.grabbedRelease ?? null,
      ...(etaMs !== undefined ? { eta: etaMs } : {}),
      ...(localPath !== undefined ? { outputPath: localPath } : {}),
      ...(row.outputPath !== null ? { remoteOutputPath: row.outputPath } : {}),
      ...(row.category !== null ? { category: row.category } : {}),
      ...trackingFromRow(row),
      stateCode: state.code,
      stateReason: state.reason,
      stateSeverity: state.severity,
      ...(row.stalledSince !== null ? { stalledSince: row.stalledSince } : {}),
      ...(live !== undefined ? { live } : {}),
    };
  }

  // ---- helpers -------------------------------------------------------------------------

  private requireRow(id: number): DownloadClientRow {
    const row = this.db.select().from(downloadClients).where(eq(downloadClients.id, id)).get();
    if (!row) throw notFound('Download client', id);
    return row;
  }

  private normalizeInput(raw: DownloadClientInputRaw, existing: DownloadClientRow | null) {
    const parsed = DownloadClientInput.safeParse(raw);
    if (!parsed.success) throw new DownloadClientsError('VALIDATION', z.prettifyError(parsed.error));
    const input = parsed.data;
    const protocol = IMPLEMENTATION_PROTOCOL[input.implementation];
    if (input.protocol !== undefined && input.protocol !== protocol) {
      throw new DownloadClientsError('VALIDATION', `${input.implementation} only supports the ${protocol} protocol`);
    }
    const clash = this.db
      .select({ id: downloadClients.id, name: downloadClients.name })
      .from(downloadClients)
      .all()
      .find((r) => r.id !== existing?.id && r.name.toLowerCase() === input.name.toLowerCase());
    if (clash) throw new DownloadClientsError('CONFLICT', `A download client named "${input.name}" already exists`);

    const settings: Record<string, unknown> = { ...restoreSecrets(input.settings, existing) };
    return {
      name: input.name,
      implementation: input.implementation,
      enable: input.enable,
      protocol,
      priority: input.priority,
      removeCompletedDownloads: input.removeCompletedDownloads,
      removeFailedDownloads: input.removeFailedDownloads,
      tags: [...new Set(input.tags)],
      settings,
    };
  }
}

// ---------------------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------------------

interface QueueContextClient {
  name: string;
  host: string;
  implementation: DownloadClientImplementation;
}

interface QueueContext {
  clients: Map<number, QueueContextClient>;
  mappings: RemotePathMapping[];
  /** Info-hashes the built-in engine's kill switch paused. */
  killSwitch: ReadonlySet<string>;
  lockdownReason?: string;
  engineStarting?: boolean;
  maxActiveDownloads: number | null;
  stallMinutes: number;
  stallMs: number;
  recovery: RecoverySettings;
  diskPaused: { minimumBytes: number; resumeAboveBytes: number };
  now: Date;
}

/** Downloads sharing a folder, with the free space of its volume (null when unknown). */
interface VolumeGroup {
  free: number | null;
  rows: TrackedDownloadRow[];
}

/** Stall recovery and disk-guard knobs from Settings > Media Management. */
function recoveryFromSettings(db: Db): RecoverySettings {
  const m = getSection(db, 'mediaManagement');
  return {
    stallRecovery: m.stallRecovery ?? DEFAULT_RECOVERY_SETTINGS.stallRecovery,
    replaceAfterMs: (m.stallReplaceMinutes ?? 30) * 60_000,
    replaceMaxProgress: (m.stallReplaceMaxProgress ?? 90) / 100,
    diskGuard: (m.diskSpaceGuard ?? DEFAULT_RECOVERY_SETTINGS.diskGuard) && !m.skipFreeSpaceCheck,
  };
}

/** A download still expected to transfer (the disk-space guard pauses only those). */
function isTransferring(row: TrackedDownloadRow): boolean {
  return (
    row.state === 'downloading' &&
    (row.clientStatus === 'downloading' || row.clientStatus === 'queued' || row.clientStatus === 'warning') &&
    row.progress < 1
  );
}

function subjectOf(row: Pick<TrackedDownloadRow, 'id' | 'downloadId' | 'title'>): { id: number; downloadId: string; title: string } {
  return { id: row.id, downloadId: row.downloadId, title: row.title };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function killSwitchText(reason: string | undefined): string {
  const why = reason ? `: ${reason.replace(/[.\s]+$/, '')}` : '';
  return `Paused by the VPN kill switch${why}. It resumes when the VPN reconnects.`;
}

/** Bytes free on the volume holding `path`; walks up to two parents when it does not exist yet. */
async function defaultFreeSpace(path: string): Promise<number | null> {
  let current = path;
  for (let i = 0; i < 3; i++) {
    try {
      const fs = await statfs(current);
      return Number(fs.bavail) * Number(fs.bsize);
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
  return null;
}

function rowToResource(row: DownloadClientRow): DownloadClientResource {
  // The discriminated union validates the settings with the implementation's own schema.
  return DownloadClientResource.parse({
    id: row.id,
    name: row.name,
    implementation: row.implementation,
    enable: row.enable,
    protocol: row.protocol,
    priority: row.priority,
    removeCompletedDownloads: row.removeCompletedDownloads,
    removeFailedDownloads: row.removeFailedDownloads,
    tags: row.tags,
    settings: row.settings,
  });
}

/** Clients that take the VPN's forwarded port: qBittorrent, Built-in, and remote engines that opted in. */
function followsVpnPort(config: DownloadClientResource): boolean {
  if (config.implementation === 'qbittorrent' || config.implementation === 'builtin') return true;
  return config.implementation === 'remoteEngine' && config.settings.followVpnPort;
}

/** Replaces every stored secret (password, API key, token) with the mask, or '' when unset. */
function mask(resource: DownloadClientResource): DownloadClientResource {
  const settings: Record<string, unknown> = { ...resource.settings };
  for (const key of DOWNLOAD_CLIENT_SECRET_FIELDS) {
    if (key in settings) settings[key] = settings[key] ? PASSWORD_MASK : '';
  }
  return { ...resource, settings } as DownloadClientResource;
}

/** Secrets sent back as the mask keep their stored value. */
function restoreSecrets<T extends object>(settings: T, row: DownloadClientRow | null): T {
  const out = { ...settings } as Record<string, unknown>;
  for (const key of DOWNLOAD_CLIENT_SECRET_FIELDS) {
    if (out[key] === PASSWORD_MASK) out[key] = storedSecret(row, key);
  }
  return out as unknown as T;
}

function storedSecret(row: DownloadClientRow | null, key: string): string {
  const value = row?.settings[key];
  return typeof value === 'string' ? value : '';
}

/** Builds the package client for a configuration; the package validates the settings again. */
function defaultClientFactory(
  config: DownloadClientResource,
  runtime: Partial<ClientRuntime>,
  deps: DownloadClientDeps,
): DownloadClient {
  return createDownloadClient(config.implementation, config.settings, runtime, deps);
}

async function defaultDirectoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function runTest(build: () => DownloadClient): Promise<DownloadClientTestResult> {
  try {
    const result = await build().test();
    return { ok: true, version: result.version, apiVersion: result.apiVersion, warnings: result.warnings };
  } catch (err) {
    const code = err instanceof DownloadClientError ? err.code : err instanceof z.ZodError ? 'validation' : 'unknown';
    return { ok: false, warnings: [], error: { code, message: errorMessage(err) } };
  }
}

function validateGrab(request: GrabRequest): void {
  if (!request.title.trim()) throw new DownloadClientsError('VALIDATION', 'A grab needs a title');
  if ((request.protocol ?? 'torrent') === 'usenet') {
    if (request.nzb === undefined || request.nzb.length === 0) {
      throw new DownloadClientsError('VALIDATION', 'A usenet grab needs an NZB document');
    }
  } else if (request.magnet === undefined && request.torrentFile === undefined) {
    throw new DownloadClientsError('VALIDATION', 'A grab needs a magnet link or a torrent file');
  }
}

function trackingColumns(t: TrackingInfo) {
  return {
    mediaType: t.mediaType ?? null,
    seriesId: t.seriesId ?? null,
    episodeIds: t.episodeIds ?? null,
    movieId: t.movieId ?? null,
    grabbedRelease: t.grabbedRelease ?? null,
  };
}

function trackingFromRow(row: TrackedDownloadRow) {
  return {
    ...(row.mediaType !== null ? { mediaType: row.mediaType } : {}),
    ...(row.seriesId !== null ? { seriesId: row.seriesId } : {}),
    ...(row.episodeIds !== null ? { episodeIds: row.episodeIds } : {}),
    ...(row.movieId !== null ? { movieId: row.movieId } : {}),
  };
}

function isGrabbed(row: TrackedDownloadRow): boolean {
  return row.grabbedRelease !== null || row.mediaType !== null || row.seriesId !== null || row.movieId !== null;
}

function isUnknownMedia(item: QueueItem): boolean {
  return item.mediaType === undefined && item.seriesId === undefined && item.movieId === undefined;
}

function stripTracked(item: TrackedDownload): QueueItem {
  const { remoteOutputPath, category, canMoveFiles, canBeRemoved, isReadOnly, grabbedRelease, ...rest } = item;
  void remoteOutputPath;
  void category;
  void canMoveFiles;
  void canBeRemoved;
  void isReadOnly;
  void grabbedRelease;
  return rest;
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return 1;
  if (b === undefined || b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function notFound(what: string, id: number): DownloadClientsError {
  return new DownloadClientsError('NOT_FOUND', `${what} ${id} not found`);
}

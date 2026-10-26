import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
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
  type SessionSource,
} from '@arclight/download-clients';
import {
  DOWNLOAD_CLIENT_PROTOCOLS,
  DOWNLOAD_CLIENT_SECRET_FIELDS,
  DownloadClientInput,
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
  type QueueItem,
  type QueuePage,
  type QueueQueryInput,
  type QueueRemoveResult,
  type QueueStatus,
  type QueueStatusMessage,
  type ReleaseProtocol,
  type RemotePathMapping,
  type TrackedDownloadState,
  type TrackedDownloadStatus,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
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
import { implementationSchemas } from './templates.js';

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
export type BlocklistHook = (item: TrackedDownload, options: { skipRedownload: boolean }) => void | Promise<void>;

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

export interface DownloadClientsServiceOptions {
  db: Db;
  log?: Logger;
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
  private readonly clientHealth = new Map<number, { ok: boolean; at: string; message?: string }>();
  private lastRefreshAt: number | null = null;
  private dirty = true;
  private torrentSession: SessionSource | undefined;

  constructor(options: DownloadClientsServiceOptions) {
    this.db = options.db;
    this.log = options.log;
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
  }

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

  /**
   * Set the incoming-connections port on every enabled client that supports it (qBittorrent, Built-in),
   * e.g. to follow a VPN's forwarded port. Per-client failures are reported, never thrown.
   */
  async setListenPortOnAll(port: number): Promise<Array<{ id: number; name: string; ok: boolean; message?: string }>> {
    const results: Array<{ id: number; name: string; ok: boolean; message?: string }> = [];
    for (const { config, client } of this.enabledClients()) {
      if ((config.implementation !== 'qbittorrent' && config.implementation !== 'builtin') || !client.setListenPort) continue;
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
        const { id, transition } = this.trackItem(config, item, mappings, nowIso);
        if (transition === 'completed') completedIds.push(id);
        if (transition === 'failed') failedIds.push(id);
      }
      summary.removed += this.handleMissing(config, seen, now);
    }

    summary.removed += this.purgeTerminal(now);
    this.lastRefreshAt = now.getTime();
    this.dirty = false;
    summary.completed = completedIds.length;
    summary.failed = failedIds.length;

    for (const id of completedIds) await this.fire(this.completedHooks, id);
    for (const id of failedIds) await this.fire(this.failedHooks, id);
    return summary;
  }

  private trackItem(
    config: DownloadClientResource,
    item: DownloadItem,
    mappings: RemotePathMapping[],
    nowIso: string,
  ): { id: number; transition: 'completed' | 'failed' | null } {
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

    if (existing) {
      this.db
        .update(trackedDownloads)
        .set({
          ...snapshot,
          state,
          ...(messages ? { statusMessages: messages } : {}),
          ...(trackedStatus ? { trackedStatus } : {}),
        })
        .where(eq(trackedDownloads.id, existing.id))
        .run();
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
      })
      .returning({ id: trackedDownloads.id })
      .get();
    return { id: row.id, transition };
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
    this.getTracked(id);
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
    validateGrab(request);
    const nowIso = this.now().toISOString();
    const pendingGrab: PendingGrabPayload = {
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
    return this.toTracked(row, this.queueContext());
  }

  /** Retries a `pending` queue item (POST /queue/grab/:id). */
  async retryPending(id: number): Promise<TrackedDownload> {
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
    };
    const tracking: TrackingInfo = { tags: p.tags, grabbedRelease: row.grabbedRelease, ...trackingFromRow(row) };
    try {
      return await this.sendAndRecord(null, request, tracking, row.id);
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
    return this.getTracked(id);
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

  getQueueItem(id: number): QueueItem {
    return stripTracked(this.getTracked(id));
  }

  queueStatus(): QueueStatus {
    const items = this.visibleItems();
    const unknownCount = items.filter(isUnknownMedia).length;
    return {
      totalCount: items.length - unknownCount,
      unknownCount,
      errors: items.filter((i) => i.trackedStatus === 'error').length,
      warnings: items.filter((i) => i.trackedStatus === 'warning').length,
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

  private visibleItems(): QueueItem[] {
    const ctx = this.queueContext();
    return this.db
      .select()
      .from(trackedDownloads)
      .where(inArray(trackedDownloads.state, VISIBLE_STATES))
      .all()
      .map((row) => stripTracked(this.toTracked(row, ctx)));
  }

  private queueContext(): QueueContext {
    const clients = new Map<number, { name: string; host: string }>();
    for (const row of this.db.select().from(downloadClients).all()) {
      const host = row.implementation === 'builtin' ? 'localhost' : typeof row.settings['host'] === 'string' ? row.settings['host'] : '';
      clients.set(row.id, { name: row.name, host });
    }
    return { clients, mappings: this.listMappings() };
  }

  private toTracked(row: TrackedDownloadRow, ctx: QueueContext): TrackedDownload {
    const client = row.clientId === null ? undefined : ctx.clients.get(row.clientId);
    const localPath =
      row.outputPath === null ? undefined : client ? mapRemoteToLocal(ctx.mappings, client.host, row.outputPath) : row.outputPath;
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
      sizeLeftBytes: row.sizeLeft,
      progress: row.progress,
      added: row.addedAt,
      trackedState: row.state,
      canMoveFiles: row.canMoveFiles,
      canBeRemoved: row.canBeRemoved,
      isReadOnly: row.isReadOnly,
      grabbedRelease: row.grabbedRelease ?? null,
      ...(row.etaMs !== null ? { eta: row.etaMs } : {}),
      ...(localPath !== undefined ? { outputPath: localPath } : {}),
      ...(row.outputPath !== null ? { remoteOutputPath: row.outputPath } : {}),
      ...(row.category !== null ? { category: row.category } : {}),
      ...trackingFromRow(row),
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

interface QueueContext {
  clients: Map<number, { name: string; host: string }>;
  mappings: RemotePathMapping[];
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

/** Replaces every stored secret (password, API key) with the mask, or '' when unset. */
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

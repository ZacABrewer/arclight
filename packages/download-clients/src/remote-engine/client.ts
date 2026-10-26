import { access, constants, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AgentClient,
  AgentClientError,
  type AgentStatus,
  type AgentSubscription,
  type AgentTorrent,
} from '@arclight/engine-agent';
import { hashFromMagnet, hashFromTorrentFile } from '../torrent-hash.js';
import {
  DownloadClientError,
  type AddNzbResult,
  type AddTorrentInput,
  type AddTorrentResult,
  type ClientRuntime,
  type DownloadClient,
  type DownloadClientErrorCode,
  type DownloadClientStatus,
  type DownloadClientTestResult,
  type DownloadItem,
  type DownloadItemStatus,
} from '../types.js';
import { pullManagerFor, type PullManager } from './pull.js';
import type { RemoteEngineSettings } from './settings.js';

/** Event subscriptions close after this long without a poll (rebuilt clients must not leak sockets). */
const WATCH_IDLE_MS = 10 * 60_000;

export interface RemoteEngineDeps {
  /** WebSocket implementation for the event stream (tests). */
  WebSocket?: typeof globalThis.WebSocket;
  /** Retry delay of failed pulls (tests). */
  pullRetryBaseMs?: number;
}

function mapError(error: unknown): unknown {
  if (!(error instanceof AgentClientError)) return error;
  const map: Record<AgentClientError['code'], DownloadClientErrorCode> = {
    auth: 'auth',
    unreachable: 'unreachable',
    'bad-response': 'bad-response',
    'not-found': 'not-found',
    rejected: 'rejected',
    conflict: 'rejected',
    'not-running': 'unreachable',
  };
  return new DownloadClientError(map[error.code], error.message, {
    cause: error,
    ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
  });
}

/**
 * Download client for Arclight's torrent engine running on another machine (the standalone
 * engine agent, or another Arclight with the engine-agent module enabled).
 *
 * Shared storage: items are reported with the agent's paths; remote path mappings translate
 * them. Pull mode: a finished torrent is copied to `localDownloadPath` first and reported as
 * downloading ("Copying from the remote engine") until every file is copied and verified, then
 * as completed at its local path.
 */
export class RemoteEngineClient implements DownloadClient {
  readonly name = 'Remote engine';
  readonly protocol = 'torrent' as const;
  readonly agent: AgentClient;
  private readonly pull: PullManager | null;
  private watch: AgentSubscription | null = null;
  private lastPoll = 0;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly settings: RemoteEngineSettings,
    private readonly runtime: ClientRuntime,
    private readonly deps: RemoteEngineDeps = {},
  ) {
    this.agent = new AgentClient({
      url: settings.url,
      token: settings.token,
      fetch: runtime.fetch,
      timeoutMs: runtime.requestTimeoutMs,
      ...(deps.WebSocket ? { WebSocket: deps.WebSocket } : {}),
    });
    const limit = settings.bandwidthLimitKbps ?? 0;
    this.pull =
      settings.pullMode && settings.localDownloadPath
        ? pullManagerFor({
            url: this.agent.baseUrl,
            root: settings.localDownloadPath,
            client: this.agent,
            bandwidthBps: () => limit * 1024,
            now: runtime.now,
            ...(deps.pullRetryBaseMs !== undefined ? { retryBaseMs: deps.pullRetryBaseMs } : {}),
          })
        : null;
  }

  /** The pull manager in pull mode (tests and diagnostics). */
  get pullManager(): PullManager | null {
    return this.pull;
  }

  private async call<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw mapError(error);
    }
  }

  async test(): Promise<DownloadClientTestResult> {
    const status = await this.call(() => this.agent.status());
    const warnings: string[] = [];
    if (!status.running) throw new DownloadClientError('unreachable', 'The remote Arclight answers, but its torrent engine is not running.');
    if (status.listenPort === 0) warnings.push('The remote engine is not listening for incoming connections; downloads may be slow.');
    if (status.vpn.interface && status.vpn.up === false) {
      warnings.push(`The remote engine's VPN interface ${status.vpn.interface} is down; torrents cannot connect until it is back.`);
    }
    if (this.settings.followVpnPort && status.portManaged) {
      warnings.push('The agent follows its own forwarded port, so "Follow VPN port" has no effect.');
    }
    if (this.settings.pullMode) {
      if (!this.settings.localDownloadPath) {
        throw new DownloadClientError('rejected', 'Pull mode needs a local download folder.');
      }
      try {
        await mkdir(this.settings.localDownloadPath, { recursive: true });
        await access(this.settings.localDownloadPath, constants.W_OK);
      } catch (error) {
        throw new DownloadClientError('rejected', `The local download folder ${this.settings.localDownloadPath} is not writable.`, { cause: error });
      }
    }
    this.ensureWatch();
    return { version: `Arclight engine agent ${status.agentVersion} (${status.kind})`, apiVersion: String(status.protocolVersion), warnings };
  }

  async addTorrent(input: AddTorrentInput): Promise<AddTorrentResult> {
    let id: string;
    try {
      if (input.torrentFile) id = await hashFromTorrentFile(input.torrentFile);
      else if (input.magnet) {
        const hash = hashFromMagnet(input.magnet);
        if (!hash) throw new DownloadClientError('rejected', 'The magnet link has no BitTorrent info-hash.');
        id = hash;
      } else throw new DownloadClientError('rejected', 'Neither a magnet link nor a torrent file was given.');
    } catch (error) {
      if (error instanceof DownloadClientError) throw error;
      throw new DownloadClientError('rejected', `Invalid torrent: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const options = {
      category: input.category,
      ...(input.magnet && !input.torrentFile ? { magnet: input.magnet } : {}),
      ...(input.savePath !== undefined ? { savePath: input.savePath } : {}),
      ...(input.paused !== undefined ? { paused: input.paused } : {}),
      ...(input.seedRatioLimit !== undefined ? { seedRatioLimit: input.seedRatioLimit } : {}),
      ...(input.seedTimeLimitMinutes !== undefined ? { seedTimeLimitMinutes: input.seedTimeLimitMinutes } : {}),
    };
    const result = await this.call(() => this.agent.add(options, input.torrentFile));
    this.ensureWatch();
    return {
      id: result.id || id,
      warnings: result.duplicate ? [`Torrent ${result.id} is already on the remote engine; it was not added again.`] : [],
    };
  }

  async addNzb(): Promise<AddNzbResult> {
    throw new DownloadClientError('not-supported', 'The remote torrent engine cannot download NZBs.');
  }

  async getItems(category: string): Promise<DownloadItem[]> {
    this.lastPoll = this.runtime.now();
    const torrents = await this.call(() => this.agent.list(category || undefined));
    this.ensureWatch();
    const items: DownloadItem[] = [];
    for (const t of torrents) items.push(await this.toItem(t));
    return items;
  }

  private async toItem(t: AgentTorrent): Promise<DownloadItem> {
    const wanted = t.wantedBytes || t.totalBytes;
    let status: DownloadItemStatus;
    let statusMessage: string | undefined;
    switch (t.state) {
      case 'checking':
        status = 'queued';
        statusMessage = 'Checking files';
        break;
      case 'downloadingMetadata':
        status = 'downloading';
        statusMessage = 'Downloading metadata';
        break;
      case 'downloading':
        status = t.trackerError ? 'warning' : 'downloading';
        if (t.trackerError) statusMessage = t.trackerError;
        break;
      case 'seeding':
        status = 'seeding';
        break;
      case 'paused':
        status = t.isComplete ? 'completed' : 'paused';
        break;
      case 'queued':
        status = t.isComplete ? 'completed' : 'queued';
        break;
      case 'error':
        status = 'failed';
        statusMessage = t.error ?? 'Unknown engine error';
        break;
    }
    const releasable = t.isComplete && (t.seedLimitsMet || t.state === 'paused');
    const item: DownloadItem = {
      id: t.id,
      title: t.name,
      category: t.category,
      totalBytes: wanted,
      remainingBytes: t.bytesLeft,
      downloadedBytes: Math.max(0, wanted - t.bytesLeft),
      progress: t.progress,
      status,
      outputPath: t.contentPath,
      isReadOnly: t.isComplete && t.isPrivate && !t.seedLimitsMet,
      canMoveFiles: releasable,
      canBeRemoved: releasable,
    };
    if (statusMessage !== undefined) item.statusMessage = statusMessage;
    if (t.isComplete) item.etaSeconds = 0;
    else if (t.etaSeconds !== undefined) item.etaSeconds = t.etaSeconds;

    if (this.pull && t.isComplete && (status === 'completed' || status === 'seeding')) return this.pulledItem(t, item);
    return item;
  }

  /** Pull mode: a finished torrent is "downloading" until its local copy is complete and verified. */
  private async pulledItem(t: AgentTorrent, item: DownloadItem): Promise<DownloadItem> {
    const pull = this.pull!;
    const manifest = await pull.manifest(t.id);
    if (manifest) {
      // The local copy is Arclight's own: the importer may move it whatever the agent seeds.
      return { ...item, outputPath: manifest.contentPath, isReadOnly: false, canMoveFiles: true };
    }
    pull.ensure(t);
    const p = pull.progress(t.id);
    const total = p?.totalBytes || item.totalBytes;
    const done = Math.min(total, p?.bytesDone ?? 0);
    const out: DownloadItem = {
      ...item,
      status: p?.state === 'failed' ? 'warning' : 'downloading',
      progress: total > 0 ? done / total : 0,
      downloadedBytes: done,
      remainingBytes: Math.max(0, total - done),
      outputPath: join(pull.root, t.name),
      isReadOnly: false,
    };
    const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
    out.statusMessage =
      p?.state === 'failed'
        ? `Copying from the remote engine failed (attempt ${p.attempts}): ${p.error ?? 'unknown error'}. Retrying.`
        : p?.state === 'verifying'
          ? `Verifying the copy from the remote engine (${pct}%)`
          : p?.state === 'queued' || !p
            ? 'Waiting to copy from the remote engine'
            : `Copying from the remote engine (${pct}%)`;
    if (p && p.rate > 0) out.etaSeconds = Math.ceil((total - done) / p.rate);
    else delete out.etaSeconds;
    return out;
  }

  async removeItem(id: string, deleteData: boolean): Promise<void> {
    let name: string | undefined;
    if (this.pull) {
      name = await this.agent.get(id).then(
        (t) => t.name,
        () => undefined,
      );
    }
    await this.call(() => this.agent.remove(id, deleteData));
    if (this.pull) await this.pull.forget(id, deleteData, name);
  }

  async getStatus(): Promise<DownloadClientStatus> {
    const status: AgentStatus = await this.call(() => this.agent.status());
    const category = this.settings.category;
    if (this.pull) {
      return { outputRootDir: this.pull.root, isLocalhost: true, removesCompletedDownloads: false };
    }
    return {
      outputRootDir: category ? join(status.downloadsRoot, category) : status.downloadsRoot,
      isLocalhost: false,
      removesCompletedDownloads: status.seedLimitAction === 'remove',
    };
  }

  async setCategory(id: string, category: string): Promise<void> {
    await this.call(() => this.agent.setCategory(id, category));
  }

  async pause(id: string): Promise<void> {
    await this.call(() => this.agent.pause(id));
  }

  async resume(id: string): Promise<void> {
    await this.call(() => this.agent.resume(id));
  }

  async setListenPort(port: number): Promise<void> {
    const status = await this.call(() => this.agent.status());
    if (status.listenPort === port) return;
    await this.call(() => this.agent.setListenPort(port));
  }

  async getListenPort(): Promise<number> {
    return (await this.call(() => this.agent.status())).listenPort;
  }

  // ---- event stream ------------------------------------------------------------------------

  /**
   * In pull mode, follows the agent's event stream so a copy starts the moment a torrent
   * completes instead of at the next poll. Closed again after a quiet period without polls.
   */
  private ensureWatch(): void {
    if (!this.pull || this.watch) return;
    this.lastPoll = this.runtime.now();
    this.watch = this.agent.subscribe((event) => {
      if (event.type === 'completed' && (!this.settings.category || event.torrent.category === this.settings.category)) {
        this.pull?.ensure(event.torrent);
      }
    });
    this.idleTimer = setInterval(() => {
      if (this.runtime.now() - this.lastPoll > WATCH_IDLE_MS) this.close();
    }, 60_000);
    this.idleTimer.unref();
  }

  /** Whether the event stream is connected (tests). */
  get watching(): boolean {
    return this.watch?.connected ?? false;
  }

  /** Closes the event stream (transfers keep running in the shared pull manager). */
  close(): void {
    this.watch?.close();
    this.watch = null;
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }
}

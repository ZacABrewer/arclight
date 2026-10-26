import { join } from 'node:path';
import { parseMagnet, parseTorrent, TorrentEngineError, type Session, type Torrent } from '@media-tron/torrent-engine';
import {
  DownloadClientError,
  type AddNzbResult,
  type AddTorrentInput,
  type AddTorrentResult,
  type DownloadClient,
  type DownloadClientStatus,
  type DownloadClientTestResult,
  type DownloadItem,
  type DownloadItemStatus,
} from '../types.js';
import type { BuiltinSettings } from './settings.js';

/** Version reported by `test()` for the in-process engine. */
export const BUILTIN_ENGINE_VERSION = '0.1.0';

/**
 * Where the client finds the api's torrent engine. A getter lets the api start, stop and
 * restart the engine without rebuilding clients; it returns null while the engine is off.
 */
export type SessionSource = Session | (() => Session | null);

const NOT_RUNNING = 'The built-in torrent engine is not running. Enable it under Settings > Torrent Engine.';

/**
 * Download client backed by the in-process `@media-tron/torrent-engine` Session. The api
 * owns the Session's lifetime; this client never starts or shuts it down.
 */
export class BuiltinClient implements DownloadClient {
  readonly name = 'Built-in';
  readonly protocol = 'torrent' as const;

  constructor(
    private readonly settings: BuiltinSettings,
    private readonly source: SessionSource,
  ) {}

  private session(): Session {
    const s = typeof this.source === 'function' ? this.source() : this.source;
    if (!s) throw new DownloadClientError('unreachable', NOT_RUNNING);
    return s;
  }

  private torrent(session: Session, id: string): Torrent {
    const t = session.getTorrent(id);
    if (!t) throw new DownloadClientError('not-found', `Torrent ${id} is not in the built-in engine.`);
    return t;
  }

  /** Save path for a category: its own folder, else <root>/<category>, else the root. */
  savePathFor(category: string, session: Session = this.session()): string {
    const own = this.settings.categories.find((c) => c.name === category);
    if (own) return own.savePath;
    const root = this.settings.savePath || session.settings.savePath;
    return category ? join(root, category) : root;
  }

  async test(): Promise<DownloadClientTestResult> {
    const session = this.session();
    const warnings: string[] = [];
    const seen = new Set<string>();
    const reported = new Set<string>();
    for (const { name } of this.settings.categories) {
      if (seen.has(name) && !reported.has(name)) {
        warnings.push(`Category "${name}" has more than one download folder; only the first is used.`);
        reported.add(name);
      }
      seen.add(name);
    }
    if (session.listenPort === 0) {
      warnings.push('The torrent engine is not listening for incoming connections; downloads may be slow.');
    }
    return { version: `Media-Tron engine ${BUILTIN_ENGINE_VERSION}`, apiVersion: '1', warnings };
  }

  async addTorrent(input: AddTorrentInput): Promise<AddTorrentResult> {
    const session = this.session();
    let id: string;
    try {
      if (input.torrentFile) id = parseTorrent(input.torrentFile).infoHash.toString('hex');
      else if (input.magnet) id = parseMagnet(input.magnet).infoHash.toString('hex');
      else throw new DownloadClientError('rejected', 'Neither a magnet link nor a torrent file was given.');
    } catch (error) {
      if (error instanceof DownloadClientError) throw error;
      throw new DownloadClientError('rejected', `Invalid torrent: ${errorMessage(error)}`, { cause: error });
    }
    const duplicate = (): AddTorrentResult => ({
      id,
      warnings: [`Torrent ${id} is already in the built-in engine; it was not added again.`],
    });
    if (session.getTorrent(id)) return duplicate();

    const category = input.category;
    const seedRatioLimit = input.seedRatioLimit ?? this.settings.seedRatioLimit;
    const seedTimeMinutes = input.seedTimeLimitMinutes ?? this.settings.seedTimeLimitMinutes;
    try {
      const t = await session.addTorrent({
        ...(input.torrentFile ? { torrent: input.torrentFile } : { magnet: input.magnet as string }),
        category,
        savePath: input.savePath ?? this.savePathFor(category, session),
        paused: input.paused ?? this.settings.initialState === 'pause',
        ...(seedRatioLimit !== undefined ? { seedRatioLimit } : {}),
        ...(seedTimeMinutes !== undefined ? { seedTimeLimitMs: seedTimeMinutes * 60_000 } : {}),
      });
      return { id: t.infoHashHex, warnings: [] };
    } catch (error) {
      // Lost a race with a concurrent add of the same torrent.
      if (session.getTorrent(id)) return duplicate();
      if (error instanceof TorrentEngineError) {
        throw new DownloadClientError('rejected', `The engine refused the torrent: ${error.message}`, { cause: error });
      }
      throw error;
    }
  }

  async addNzb(): Promise<AddNzbResult> {
    throw new DownloadClientError('not-supported', 'The built-in torrent engine cannot download NZBs.');
  }

  async getItems(category: string): Promise<DownloadItem[]> {
    const session = this.session();
    return session
      .getTorrents()
      .filter((t) => !category || t.category === category)
      .map((t) => this.toItem(session, t));
  }

  private toItem(session: Session, t: Torrent): DownloadItem {
    const stats = t.getStats();
    const complete = t.isComplete;
    const wanted = stats.wantedBytes || stats.totalBytes;
    let status: DownloadItemStatus;
    let statusMessage: string | undefined;
    switch (stats.state) {
      case 'checking':
        status = 'queued';
        statusMessage = 'Checking files';
        break;
      case 'downloadingMetadata':
        status = 'downloading';
        statusMessage = 'Downloading metadata';
        break;
      case 'downloading': {
        status = 'downloading';
        const trackers = t.getTrackers();
        if (trackers.length > 0 && trackers.every((tr) => tr.state === 'error') && stats.connectedPeers === 0) {
          status = 'warning';
          statusMessage = trackers[0]?.message ?? 'All trackers failed';
        }
        break;
      }
      case 'seeding':
        status = 'seeding';
        break;
      case 'paused':
        status = complete ? 'completed' : 'paused';
        break;
      case 'queued':
        status = complete ? 'completed' : 'queued';
        break;
      case 'error':
        status = 'failed';
        statusMessage = stats.error ?? 'Unknown engine error';
        break;
    }

    const ratioLimit = t.seedRatioLimit === undefined ? session.settings.seedRatioLimit : t.seedRatioLimit;
    const timeLimit = t.seedTimeLimitMs === undefined ? session.settings.seedTimeLimitMs : t.seedTimeLimitMs;
    const limitsMet =
      (ratioLimit != null && stats.ratio >= ratioLimit) || (timeLimit != null && stats.seedingTimeMs >= timeLimit);
    const isPrivate = t.metainfo?.private ?? false;
    const releasable = complete && (limitsMet || stats.state === 'paused');

    const item: DownloadItem = {
      id: t.infoHashHex,
      title: stats.name,
      category: stats.category,
      totalBytes: wanted,
      remainingBytes: stats.bytesLeft,
      downloadedBytes: Math.max(0, wanted - stats.bytesLeft),
      progress: stats.progress,
      status,
      outputPath: stats.contentPath,
      isReadOnly: complete && isPrivate && !limitsMet,
      canMoveFiles: releasable,
      canBeRemoved: releasable,
    };
    if (statusMessage !== undefined) item.statusMessage = statusMessage;
    if (complete) item.etaSeconds = 0;
    else if (stats.etaSeconds !== undefined) item.etaSeconds = stats.etaSeconds;
    return item;
  }

  async removeItem(id: string, deleteData: boolean): Promise<void> {
    const session = this.session();
    const t = this.torrent(session, id);
    await session.removeTorrent(t.infoHashHex, deleteData);
  }

  async getStatus(): Promise<DownloadClientStatus> {
    const session = this.session();
    return {
      outputRootDir: this.savePathFor(this.settings.category, session),
      isLocalhost: true,
      removesCompletedDownloads: session.settings.seedLimitAction === 'remove',
    };
  }

  async setCategory(id: string, category: string): Promise<void> {
    const session = this.session();
    const t = this.torrent(session, id);
    await session.setCategory(t.infoHashHex, category, false);
  }

  async pause(id: string): Promise<void> {
    const session = this.session();
    await session.pauseTorrent(this.torrent(session, id).infoHashHex);
  }

  async resume(id: string): Promise<void> {
    const session = this.session();
    await session.resumeTorrent(this.torrent(session, id).infoHashHex);
  }

  async setListenPort(port: number): Promise<void> {
    const session = this.session();
    if (session.listenPort === port) return;
    await session.setListenPort(port);
  }

  async getListenPort(): Promise<number> {
    return this.session().listenPort;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

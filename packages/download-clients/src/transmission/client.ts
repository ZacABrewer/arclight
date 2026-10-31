import { notSupported, toBase64 } from '../http.js';
import { isLocalhostAddress } from '../paths.js';
import { hashFromMagnet, hashFromTorrentFile, TorrentParseError } from '../torrent-hash.js';
import {
  DownloadClientError,
  type AddNzbResult,
  type AddTorrentInput,
  type AddTorrentResult,
  type ClientRuntime,
  type DownloadClient,
  type DownloadClientStatus,
  type DownloadClientTestResult,
  type DownloadItem,
} from '../types.js';
import { buildRpcUrl, TransmissionRpc } from './rpc.js';
import { TORRENT_FIELDS, TR_LIMIT_MODE, TrAnything, TrSession, TrTorrentAdd, TrTorrentGet, type TrTorrent } from './schemas.js';
import type { TransmissionSettings } from './settings.js';
import { categoryDir, inCategory, mapTorrent, type CategoryMode } from './state.js';

/** rpc-version 14 = Transmission 2.80; older daemons use different status codes. */
export const MIN_RPC_VERSION = 14;
/** rpc-version 16 = Transmission 3.00: torrent labels (torrent-get / torrent-set). */
export const LABELS_RPC_VERSION = 16;
/** rpc-version 17 = Transmission 4.0: `labels` accepted directly by torrent-add. */
export const ADD_LABELS_RPC_VERSION = 17;

/**
 * Transmission (2.80+) over its JSON RPC.
 *
 * Categories: on rpc-version 16+ the category is a torrent label and downloads go to
 * `settings.directory` (or Transmission's download-dir). On older daemons, which have no
 * labels, the category is a sub-directory of that base directory and listing filters on
 * `downloadDir`; `setCategory` is not supported there (it would mean moving data).
 *
 * Duplicates: when torrent-add reports "torrent-duplicate" the add succeeds with
 * `alreadyPresent` (the torrent is there; refusing would make the caller retry forever), but
 * its labels and seed limits are not touched: it may belong to someone else.
 */
export class TransmissionClient implements DownloadClient {
  readonly name = 'Transmission';
  readonly protocol = 'torrent' as const;
  private readonly rpc: TransmissionRpc;
  private rpcVersion: number | undefined;

  constructor(
    private readonly settings: TransmissionSettings,
    private readonly runtime: ClientRuntime,
  ) {
    this.rpc = new TransmissionRpc(
      {
        url: buildRpcUrl(settings.host, settings.port, settings.useSsl, settings.urlBase),
        username: settings.username,
        password: settings.password,
      },
      runtime,
      this.name,
    );
  }

  // ---------------------------------------------------------------- DownloadClient

  async test(): Promise<DownloadClientTestResult> {
    this.rpc.reset();
    this.rpcVersion = undefined;
    const session = await this.getSession();
    const rpcVersion = session['rpc-version'];
    const warnings: string[] = [];

    if (this.settings.category === '') {
      warnings.push('No label is set. A label keeps Arclight downloads apart from everything else.');
    } else if (rpcVersion < LABELS_RPC_VERSION) {
      warnings.push(
        `Transmission ${displayVersion(session.version)} has no labels; Arclight will keep its downloads in a "${this.settings.category}" sub-directory instead. Transmission 3.00 or newer is recommended.`,
      );
    }
    const wantsTop = this.settings.recentPriority === 'first' || this.settings.olderPriority === 'first';
    if (wantsTop && session['download-queue-enabled'] === false) {
      warnings.push('Queue priority is set to "first" but the download queue is disabled in Transmission.');
    }

    await this.listTorrents();
    return { version: displayVersion(session.version), apiVersion: String(rpcVersion), warnings };
  }

  async addTorrent(input: AddTorrentInput): Promise<AddTorrentResult> {
    const hasMagnet = input.magnet !== undefined && input.magnet !== '';
    const hasFile = input.torrentFile !== undefined && input.torrentFile.length > 0;
    if (hasMagnet === hasFile) {
      throw new DownloadClientError('rejected', 'Provide exactly one of a magnet link or a torrent file.');
    }
    const computedId = await this.computeId(input);
    const session = await this.getSession();
    const rpcVersion = session['rpc-version'];
    const mode = this.categoryMode(session);

    const args: Record<string, unknown> = {
      paused: input.paused ?? this.settings.addPaused,
    };
    if (hasMagnet) args['filename'] = input.magnet;
    else if (input.torrentFile !== undefined) args['metainfo'] = toBase64(input.torrentFile);

    const downloadDir = this.downloadDirFor(input, mode);
    if (downloadDir !== undefined && downloadDir !== '') args['download-dir'] = downloadDir;

    const wantsLabel = mode.useLabels && input.category !== '';
    if (wantsLabel && rpcVersion >= ADD_LABELS_RPC_VERSION) args['labels'] = [input.category];

    const reply = await this.rpc.call('torrent-add', args, TrTorrentAdd);
    const duplicate = reply['torrent-duplicate'];
    if (duplicate !== undefined) {
      return { id: duplicate.hashString.toLowerCase() || computedId, warnings: [], alreadyPresent: true };
    }
    const added = reply['torrent-added'];
    if (added === undefined) {
      throw new DownloadClientError('bad-response', 'Transmission did not report the added torrent.');
    }
    const id = added.hashString.toLowerCase() || computedId;
    const warnings: string[] = [];

    if (wantsLabel && rpcVersion < ADD_LABELS_RPC_VERSION) {
      await this.attempt(warnings, `set label "${input.category}" (the download will not be listed under it)`, () =>
        this.rpc.call('torrent-set', { ids: [id], labels: [input.category] }, TrAnything),
      );
    }

    const limits: Record<string, unknown> = {};
    if (input.seedRatioLimit !== undefined) {
      limits['seedRatioLimit'] = input.seedRatioLimit;
      limits['seedRatioMode'] = TR_LIMIT_MODE.single;
    }
    if (input.seedTimeLimitMinutes !== undefined) {
      // Transmission has no total seeding-time limit; the idle limit is the closest match.
      limits['seedIdleLimit'] = Math.max(0, Math.round(input.seedTimeLimitMinutes));
      limits['seedIdleMode'] = TR_LIMIT_MODE.single;
    }
    if (Object.keys(limits).length > 0) {
      await this.attempt(warnings, 'set seed limits', () =>
        this.rpc.call('torrent-set', { ids: [id], ...limits }, TrAnything),
      );
    }

    const priority = input.isRecent === true ? this.settings.recentPriority : this.settings.olderPriority;
    if (priority === 'first') {
      await this.attempt(warnings, 'move to top of queue', () => this.rpc.call('queue-move-top', { ids: [id] }, TrAnything));
    }

    return { id, warnings };
  }

  async addNzb(): Promise<AddNzbResult> {
    throw notSupported(this.name, 'NZB downloads');
  }

  async getItems(category: string): Promise<DownloadItem[]> {
    // Sequential: parallel first calls would each trigger the 409 session handshake.
    const session = await this.getSession();
    const torrents = await this.listTorrents();
    const mode = this.categoryMode(session);
    const nowMs = this.runtime.now();
    const knownCategories = [this.settings.category, this.settings.postImportCategory ?? ''].filter((c) => c !== '');
    return torrents
      .filter((torrent) => inCategory(torrent, category, mode))
      .map((torrent) =>
        mapTorrent(torrent, { session, nowMs, category: { ...mode, requested: category, knownCategories } }),
      );
  }

  async removeItem(id: string, deleteData: boolean): Promise<void> {
    await this.rpc.call('torrent-remove', { ids: [id.toLowerCase()], 'delete-local-data': deleteData }, TrAnything);
  }

  async getStatus(): Promise<DownloadClientStatus> {
    const session = await this.getSession();
    const mode = this.categoryMode(session);
    return {
      outputRootDir: mode.useLabels ? mode.baseDir : categoryDir(mode.baseDir, this.settings.category),
      isLocalhost: isLocalhostAddress(this.settings.host),
      // Transmission only stops torrents at seed limits; it never removes them itself.
      removesCompletedDownloads: false,
    };
  }

  /** Replaces the torrent's labels with `category` (rpc-version 16+ only). */
  async setCategory(id: string, category: string): Promise<void> {
    const rpcVersion = await this.getRpcVersion();
    if (rpcVersion < LABELS_RPC_VERSION) {
      throw notSupported(this.name, 'changing categories before version 3.00 (no labels)');
    }
    await this.rpc.call('torrent-set', { ids: [id.toLowerCase()], labels: category === '' ? [] : [category] }, TrAnything);
  }

  async pause(id: string): Promise<void> {
    await this.rpc.call('torrent-stop', { ids: [id.toLowerCase()] }, TrAnything);
  }

  async resume(id: string): Promise<void> {
    await this.rpc.call('torrent-start', { ids: [id.toLowerCase()] }, TrAnything);
  }

  async setListenPort(port: number): Promise<void> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new DownloadClientError('rejected', `Invalid listen port ${port}.`);
    }
    // Turn off random port on start, or Transmission would pick a new port next launch.
    await this.rpc.call('session-set', { 'peer-port': port, 'peer-port-random-on-start': false }, TrAnything);
  }

  async getListenPort(): Promise<number> {
    const session = await this.getSession();
    const port = session['peer-port'];
    if (port === undefined) throw new DownloadClientError('bad-response', 'Transmission did not report peer-port.');
    return port;
  }

  // ---------------------------------------------------------------- Transmission helpers

  private async getSession(): Promise<TrSession> {
    const session = await this.rpc.call('session-get', {}, TrSession);
    const rpcVersion = session['rpc-version'];
    if (rpcVersion < MIN_RPC_VERSION) {
      throw new DownloadClientError(
        'bad-response',
        `Transmission ${displayVersion(session.version)} (RPC ${rpcVersion}) is too old; 2.80 or newer is required.`,
      );
    }
    this.rpcVersion = rpcVersion;
    return session;
  }

  private async getRpcVersion(): Promise<number> {
    if (this.rpcVersion !== undefined) return this.rpcVersion;
    return (await this.getSession())['rpc-version'];
  }

  private categoryMode(session: TrSession): CategoryMode {
    const directory = this.settings.directory ?? '';
    return {
      useLabels: session['rpc-version'] >= LABELS_RPC_VERSION,
      baseDir: directory === '' ? session['download-dir'] : directory,
    };
  }

  private downloadDirFor(input: AddTorrentInput, mode: CategoryMode): string | undefined {
    if (input.savePath !== undefined && input.savePath !== '') return input.savePath;
    if (!mode.useLabels && input.category !== '') return categoryDir(mode.baseDir, input.category);
    return this.settings.directory;
  }

  private async listTorrents(): Promise<TrTorrent[]> {
    const reply = await this.rpc.call('torrent-get', { fields: [...TORRENT_FIELDS] }, TrTorrentGet);
    return reply.torrents;
  }

  private async computeId(input: AddTorrentInput): Promise<string> {
    try {
      if (input.magnet !== undefined && input.magnet !== '') {
        const hash = hashFromMagnet(input.magnet);
        if (hash === undefined) throw new TorrentParseError('Magnet link has no BitTorrent info-hash');
        return hash;
      }
      return await hashFromTorrentFile(input.torrentFile ?? new Uint8Array());
    } catch (error) {
      if (error instanceof TorrentParseError) {
        throw new DownloadClientError('rejected', `Invalid release: ${error.message}`, { cause: error });
      }
      throw error;
    }
  }

  private async attempt(warnings: string[], what: string, action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (error) {
      if (!(error instanceof DownloadClientError)) throw error;
      warnings.push(`Could not ${what}: ${error.message}`);
    }
  }
}

/** "4.0.5 (a6fe2a64aa)" -> "4.0.5". */
export function displayVersion(version: string): string {
  return version.trim().split(/\s+/)[0] ?? version.trim();
}

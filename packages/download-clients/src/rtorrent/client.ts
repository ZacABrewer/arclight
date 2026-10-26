import { buildBaseUrl, notSupported } from '../http.js';
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
import { CLIENT_NAME, RTorrentRpc } from './rpc.js';
import { RTorrentTorrentList, TORRENT_FIELDS, XmlRpcString, type RTorrentTorrent } from './schemas.js';
import { RTORRENT_PRIORITY_VALUES, type RTorrentSettings } from './settings.js';
import { decodeLabel, encodeLabel, mapTorrent } from './state.js';

type Version = readonly [number, number, number];

/** d.multicall2 and the load.* command family arrived in rTorrent 0.9.6. */
const MIN_VERSION: Version = [0, 9, 6];
const WAIT_FOR_TORRENT_ATTEMPTS = 10;
const WAIT_FOR_TORRENT_INTERVAL_MS = 250;

export function parseVersion(text: string): Version | undefined {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function isOlder(version: Version, than: Version): boolean {
  for (let i = 0; i < 3; i++) {
    const a = version[i] ?? 0;
    const b = than[i] ?? 0;
    if (a !== b) return a < b;
  }
  return false;
}

/**
 * Quotes an argument for an rTorrent command string such as `d.directory.set="..."`, so
 * spaces, commas and semicolons in paths do not split the command.
 */
export function quoteCommandArg(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * rTorrent over XML-RPC (0.9.6+), directly via a web server's SCGI bridge or through
 * ruTorrent's rpc plugin.
 *
 * Behaviour notes:
 * - Labels are stored in `d.custom1`, URI-encoded like ruTorrent does (see state.ts).
 * - `load.*` returns 0 even for garbage input, so after adding we poll `d.hash` until the
 *   torrent shows up; if it never does, the add is reported as rejected.
 * - pause/resume use d.pause / d.resume (the torrent stays "started"), so pausing a seeding
 *   torrent never makes it look finished-and-removable. resume also calls d.start, which
 *   restarts torrents that were stopped.
 * - rTorrent cannot delete files itself. With deleteData, `d.custom5` is set to "1" before
 *   `d.erase`; ruTorrent's erasedata plugin (and the common .rtorrent.rc
 *   `method.set_key = event.download.erased` recipes) delete the data for such torrents.
 *   Without such a handler only the torrent entry is removed.
 */
export class RTorrentClient implements DownloadClient {
  readonly name = CLIENT_NAME;
  readonly protocol = 'torrent' as const;
  private readonly rpc: RTorrentRpc;

  constructor(
    private readonly settings: RTorrentSettings,
    private readonly runtime: ClientRuntime,
  ) {
    this.rpc = new RTorrentRpc(
      {
        url: buildBaseUrl(settings.host, settings.port, settings.useSsl, settings.urlBase),
        username: settings.username,
        password: settings.password,
      },
      runtime,
    );
  }

  async test(): Promise<DownloadClientTestResult> {
    const version = (await this.rpc.callAs('system.client_version', [], XmlRpcString)).trim();
    const apiVersion = (await this.rpc.callAs('system.library_version', [], XmlRpcString)).trim();
    const warnings: string[] = [];

    const parsed = parseVersion(version);
    if (parsed === undefined || isOlder(parsed, MIN_VERSION)) {
      warnings.push(`rTorrent ${version} is too old; 0.9.6 or newer is required (d.multicall2 and load.* commands).`);
      return { version, apiVersion, warnings };
    }

    await this.defaultDirectory();
    if (this.settings.category === '') {
      warnings.push('No label is set. A label keeps Media-Tron downloads apart from everything else.');
    }
    await this.listTorrents();
    return { version, apiVersion, warnings };
  }

  async addTorrent(input: AddTorrentInput): Promise<AddTorrentResult> {
    const hasMagnet = input.magnet !== undefined && input.magnet !== '';
    const hasFile = input.torrentFile !== undefined && input.torrentFile.length > 0;
    if (hasMagnet === hasFile) {
      throw new DownloadClientError('rejected', 'Provide exactly one of a magnet link or a torrent file.');
    }
    const id = await this.computeId(input);

    const commands: string[] = [];
    if (input.category !== '') commands.push(`d.custom1.set=${quoteCommandArg(encodeLabel(input.category))}`);
    const directory = input.savePath !== undefined && input.savePath !== '' ? input.savePath : this.settings.directory;
    if (directory !== undefined && directory !== '') commands.push(`d.directory.set=${quoteCommandArg(directory)}`);
    const priority = input.isRecent === true ? this.settings.recentPriority : this.settings.olderPriority;
    if (priority !== 'normal') commands.push(`d.priority.set=${RTORRENT_PRIORITY_VALUES[priority]}`);

    const paused = input.paused ?? this.settings.addPaused;
    if (hasFile && input.torrentFile !== undefined) {
      await this.rpc.call(paused ? 'load.raw' : 'load.raw_start', ['', input.torrentFile, ...commands]);
    } else if (input.magnet !== undefined) {
      await this.rpc.call(paused ? 'load.normal' : 'load.start', ['', input.magnet, ...commands]);
    }

    if (!(await this.waitForTorrent(id))) {
      throw new DownloadClientError(
        'rejected',
        `rTorrent did not add torrent ${id}; the torrent may be invalid or the download directory unusable (see the rTorrent log).`,
      );
    }

    const warnings: string[] = [];
    if (input.seedRatioLimit !== undefined || input.seedTimeLimitMinutes !== undefined) {
      warnings.push('rTorrent has no per-torrent seed limits; configure ratio groups in rTorrent to enforce them.');
    }
    return { id, warnings };
  }

  async addNzb(): Promise<AddNzbResult> {
    throw notSupported(this.name, 'NZB downloads');
  }

  async getItems(category: string): Promise<DownloadItem[]> {
    const torrents = await this.listTorrents();
    return torrents
      .filter((t) => category === '' || t.label === category || decodeLabel(t.label) === category)
      .map(mapTorrent);
  }

  async removeItem(id: string, deleteData: boolean): Promise<void> {
    const hash = id.toUpperCase();
    // Honoured by ruTorrent's erasedata plugin and equivalent .rtorrent.rc handlers.
    if (deleteData) await this.rpc.call('d.custom5.set', [hash, '1']);
    await this.rpc.call('d.erase', [hash]);
  }

  async getStatus(): Promise<DownloadClientStatus> {
    // rTorrent has no per-label directories: everything lands in one directory.
    const configured = this.settings.directory;
    const outputRootDir = configured !== undefined && configured !== '' ? configured : await this.defaultDirectory();
    return {
      outputRootDir,
      isLocalhost: isLocalhostAddress(this.settings.host),
      removesCompletedDownloads: false,
    };
  }

  async setCategory(id: string, category: string): Promise<void> {
    await this.rpc.call('d.custom1.set', [id.toUpperCase(), encodeLabel(category)]);
  }

  async pause(id: string): Promise<void> {
    await this.rpc.call('d.pause', [id.toUpperCase()]);
  }

  async resume(id: string): Promise<void> {
    const hash = id.toUpperCase();
    await this.rpc.call('d.start', [hash]);
    await this.rpc.call('d.resume', [hash]);
  }

  // ---------------------------------------------------------------- helpers

  private defaultDirectory(): Promise<string> {
    return this.rpc.callAs('directory.default', [], XmlRpcString);
  }

  private listTorrents(): Promise<RTorrentTorrent[]> {
    return this.rpc.callAs('d.multicall2', ['', 'main', ...TORRENT_FIELDS], RTorrentTorrentList);
  }

  private async waitForTorrent(id: string): Promise<boolean> {
    for (let attempt = 0; attempt < WAIT_FOR_TORRENT_ATTEMPTS; attempt++) {
      try {
        const hash = await this.rpc.callAs('d.hash', [id.toUpperCase()], XmlRpcString);
        if (hash.toLowerCase() === id) return true;
      } catch (error) {
        if (!(error instanceof DownloadClientError && error.code === 'not-found')) throw error;
      }
      await this.runtime.sleep(WAIT_FOR_TORRENT_INTERVAL_MS);
    }
    return false;
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
}


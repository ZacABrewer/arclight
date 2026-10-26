import { buildBaseUrl, notSupported, releaseFileName, toBase64 } from '../http.js';
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
import { DelugeRpc } from './rpc.js';
import {
  DELUGE_CONFIG_KEYS,
  DELUGE_TORRENT_FIELDS,
  DelugeAddResult,
  DelugeAny,
  DelugeConfigValues,
  DelugeLabelOptions,
  DelugePort,
  DelugeStringList,
  DelugeTorrentMap,
  DelugeVersion,
} from './schemas.js';
import { DELUGE_LABEL_PATTERN, normalizeLabel, type DelugeSettings } from './settings.js';
import { mapTorrent } from './state.js';

const LABEL_PLUGIN = 'Label';

/** Whether Deluge itself deletes torrents once they reach the global stop ratio. */
export function removesCompletedDownloads(config: DelugeConfigValues): boolean {
  return config.stop_seed_at_ratio === true && config.remove_seed_at_ratio === true;
}

/**
 * Deluge (1.3 / 2.x) through its Web UI JSON-RPC API.
 *
 * Categories are Deluge labels (Label plugin), always lowercase: Arclight lowercases the
 * category before using it, and enables the bundled Label plugin when a category is set.
 */
export class DelugeClient implements DownloadClient {
  readonly name = 'Deluge';
  readonly protocol = 'torrent' as const;
  private readonly rpc: DelugeRpc;
  private labelPluginReady = false;
  private readonly knownLabels = new Set<string>();

  constructor(
    private readonly settings: DelugeSettings,
    runtime: ClientRuntime,
  ) {
    this.rpc = new DelugeRpc(
      {
        baseUrl: buildBaseUrl(settings.host, settings.port, settings.useSsl, settings.urlBase),
        password: settings.password,
      },
      runtime,
    );
  }

  private get label(): string {
    return normalizeLabel(this.settings.category);
  }

  // ---------------------------------------------------------------- DownloadClient

  async test(): Promise<DownloadClientTestResult> {
    this.rpc.reset();
    this.labelPluginReady = false;
    this.knownLabels.clear();

    let version: string;
    try {
      version = (await this.rpc.call('daemon.info', [], DelugeVersion)).trim();
    } catch (error) {
      // Very old daemons lack daemon.info; fall back to what the Connection Manager reported.
      if (!(error instanceof DownloadClientError && error.code === 'not-found') || this.rpc.hostVersion === undefined) {
        throw error;
      }
      version = this.rpc.hostVersion;
    }

    const warnings: string[] = [];
    if (this.label === '') {
      warnings.push('No label is set. A label keeps Arclight downloads apart from everything else in Deluge.');
    } else {
      if (this.label !== this.settings.category.trim()) {
        warnings.push(`Deluge labels are lowercase; Arclight uses the label "${this.label}".`);
      }
      if (await this.ensureLabelPlugin()) {
        warnings.push('Enabled the Label plugin in Deluge so Arclight can label its downloads.');
      }
      await this.ensureLabel(this.label);
    }

    const config = await this.getConfig();
    if (removesCompletedDownloads(config)) {
      warnings.push(
        'Deluge removes torrents when they reach their seed ratio, which can happen before Arclight imports them. Turn off "Remove at ratio" in Deluge\'s Queue preferences.',
      );
    }

    await this.listTorrents(this.label);
    return { version, apiVersion: 'json-rpc', warnings };
  }

  async addTorrent(input: AddTorrentInput): Promise<AddTorrentResult> {
    const hasMagnet = input.magnet !== undefined && input.magnet !== '';
    const hasFile = input.torrentFile !== undefined && input.torrentFile.length > 0;
    if (hasMagnet === hasFile) {
      throw new DownloadClientError('rejected', 'Provide exactly one of a magnet link or a torrent file.');
    }
    const expectedId = await this.computeId(input);

    // Prepare the label first: a torrent that cannot be labelled would be invisible to us.
    const label = normalizeLabel(input.category);
    if (label !== '') await this.ensureLabel(label);

    const options: Record<string, unknown> = { add_paused: input.paused ?? this.settings.addPaused };
    if (input.savePath !== undefined && input.savePath !== '') options['download_location'] = input.savePath;
    if (input.seedRatioLimit !== undefined) {
      options['stop_at_ratio'] = true;
      options['stop_ratio'] = input.seedRatioLimit;
      // Stop (pause) at the ratio; never let Deluge delete before the import.
      options['remove_at_ratio'] = false;
    }

    const result = hasMagnet && input.magnet !== undefined
      ? await this.rpc.call('core.add_torrent_magnet', [input.magnet, options], DelugeAddResult)
      : await this.rpc.call(
        'core.add_torrent_file',
        [releaseFileName(input.title, 'torrent'), toBase64(input.torrentFile ?? new Uint8Array()), options],
        DelugeAddResult,
      );
    if (result === null || result === '') {
      throw new DownloadClientError('rejected', 'Deluge refused the torrent (already added, or the torrent is invalid).');
    }
    const id = result.toLowerCase();
    const warnings: string[] = [];
    if (id !== expectedId) {
      warnings.push(`Deluge reported hash ${id}, expected ${expectedId}.`);
    }

    if (input.seedTimeLimitMinutes !== undefined) {
      warnings.push('Deluge has no per-torrent seeding time limit; the seed time limit was not applied.');
    }
    if (label !== '') {
      await this.attempt(warnings, `set label "${label}"`, () =>
        this.rpc.call('label.set_torrent', [id, label], DelugeAny),
      );
    }
    const priority = input.isRecent === true ? this.settings.recentPriority : this.settings.olderPriority;
    if (priority === 'first') {
      await this.attempt(warnings, 'move to top of queue', () => this.rpc.call('core.queue_top', [[id]], DelugeAny));
    }
    return { id, warnings };
  }

  async addNzb(): Promise<AddNzbResult> {
    throw notSupported(this.name, 'NZB downloads');
  }

  async getItems(category: string): Promise<DownloadItem[]> {
    const [config, torrents] = await Promise.all([this.getConfig(), this.listTorrents(normalizeLabel(category))]);
    return Object.entries(torrents).map(([hash, torrent]) => mapTorrent(hash, torrent, { config }));
  }

  async removeItem(id: string, deleteData: boolean): Promise<void> {
    await this.rpc.call('core.remove_torrent', [id.toLowerCase(), deleteData], DelugeAny);
  }

  async getStatus(): Promise<DownloadClientStatus> {
    const config = await this.getConfig();
    let outputRootDir = config.move_completed === true && config.move_completed_path
      ? config.move_completed_path
      : (config.download_location ?? '');

    let removes = removesCompletedDownloads(config);
    const label = this.label;
    if (label !== '') {
      try {
        const options = await this.rpc.call('label.get_options', [label], DelugeLabelOptions);
        if (options.apply_move_completed === true && options.move_completed === true && options.move_completed_path) {
          outputRootDir = options.move_completed_path;
        }
      } catch (error) {
        // Label plugin off or label missing: the global location applies.
        if (!(error instanceof DownloadClientError && (error.code === 'not-found' || error.code === 'bad-response'))) {
          throw error;
        }
      }
      if (!removes) {
        const torrents = await this.listTorrents(label, ['stop_at_ratio', 'remove_at_ratio']);
        removes = Object.values(torrents).some((t) => t.remove_at_ratio === true && t.stop_at_ratio === true);
      }
    }

    return {
      outputRootDir,
      isLocalhost: isLocalhostAddress(this.settings.host),
      removesCompletedDownloads: removes,
    };
  }

  async setCategory(id: string, category: string): Promise<void> {
    const label = normalizeLabel(category);
    if (label !== '') await this.ensureLabel(label);
    else await this.ensureLabelPlugin();
    await this.rpc.call('label.set_torrent', [id.toLowerCase(), label], DelugeAny);
  }

  async pause(id: string): Promise<void> {
    // A list works on both 1.3 (list only) and 2.x (single id or list).
    await this.rpc.call('core.pause_torrent', [[id.toLowerCase()]], DelugeAny);
  }

  async resume(id: string): Promise<void> {
    await this.rpc.call('core.resume_torrent', [[id.toLowerCase()]], DelugeAny);
  }

  async setListenPort(port: number): Promise<void> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new DownloadClientError('rejected', `Invalid listen port ${port}.`);
    }
    // random_port off, or Deluge would pick a new port on its next start.
    await this.rpc.call('core.set_config', [{ listen_ports: [port, port], random_port: false }], DelugeAny);
  }

  async getListenPort(): Promise<number> {
    return this.rpc.call('core.get_listen_port', [], DelugePort);
  }

  // ---------------------------------------------------------------- Deluge helpers

  /**
   * Makes sure the Label plugin is enabled, enabling it when it is not. Returns true when
   * this call enabled it.
   */
  private async ensureLabelPlugin(): Promise<boolean> {
    if (this.labelPluginReady) return false;
    const enabled = await this.rpc.call('core.get_enabled_plugins', [], DelugeStringList);
    if (enabled.includes(LABEL_PLUGIN)) {
      this.labelPluginReady = true;
      return false;
    }
    await this.rpc.call('core.enable_plugin', [LABEL_PLUGIN], DelugeAny);
    const after = await this.rpc.call('core.get_enabled_plugins', [], DelugeStringList);
    if (!after.includes(LABEL_PLUGIN)) {
      throw new DownloadClientError(
        'bad-response',
        'Deluge\'s Label plugin could not be enabled. Enable it in Preferences > Plugins, or clear the label setting.',
      );
    }
    // The Web UI learns about the plugin's methods when it (re)connects to the daemon.
    await this.rpc.reconnect();
    this.labelPluginReady = true;
    return true;
  }

  /** Creates the label if Deluge does not have it yet. */
  private async ensureLabel(label: string): Promise<void> {
    if (this.knownLabels.has(label)) return;
    if (!DELUGE_LABEL_PATTERN.test(label)) {
      throw new DownloadClientError('rejected', `"${label}" is not a valid Deluge label (letters, digits, "_", "-", "." only).`);
    }
    await this.ensureLabelPlugin();
    const labels = await this.rpc.call('label.get_labels', [], DelugeStringList);
    if (!labels.includes(label)) {
      try {
        await this.rpc.call('label.add', [label], DelugeAny);
      } catch (error) {
        // Created concurrently by someone else: fine.
        if (!(error instanceof DownloadClientError && /already exists/i.test(error.message))) throw error;
      }
    }
    this.knownLabels.add(label);
  }

  private getConfig(): Promise<DelugeConfigValues> {
    return this.rpc.call('core.get_config_values', [[...DELUGE_CONFIG_KEYS]], DelugeConfigValues);
  }

  private listTorrents(label: string, fields: readonly string[] = DELUGE_TORRENT_FIELDS): Promise<DelugeTorrentMap> {
    const filter = label === '' ? {} : { label };
    return this.rpc.call('core.get_torrents_status', [filter, [...fields]], DelugeTorrentMap);
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

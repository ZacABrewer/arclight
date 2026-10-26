import { buildBaseUrl, notSupported, releaseFileName } from '../http.js';
import { isLocalhostAddress } from '../paths.js';
import {
  DownloadClientError,
  type AddNzbInput,
  type AddNzbResult,
  type AddTorrentResult,
  type ClientRuntime,
  type DownloadClient,
  type DownloadClientStatus,
  type DownloadClientTestResult,
  type DownloadItem,
  type UsenetPriority,
} from '../types.js';
import { SABNZBD, SabnzbdApi } from './rpc.js';
import { SabConfig, SabHistory, SabQueue, SabStatusReply, SabVersion } from './schemas.js';
import type { SabnzbdPriority, SabnzbdSettings } from './settings.js';
import {
  categoryOutputDir,
  mapHistorySlot,
  mapQueueSlot,
  removesCompletedDownloads,
  sameCategory,
} from './state.js';

/** SAB's numeric priority for each settings value. */
export const SAB_PRIORITY_VALUES: Record<SabnzbdPriority, number> = {
  default: -100,
  paused: -2,
  low: -1,
  normal: 0,
  high: 1,
  force: 2,
};

/**
 * Normalized usenet priority to SAB's scale. SAB has no level below "low" (other than
 * "paused", which is a state, not a priority), so veryLow shares low; veryHigh maps to
 * high, since SAB's "force" also overrides a paused queue and is reserved for `force`.
 */
export const USENET_TO_SAB_PRIORITY: Record<UsenetPriority, number> = {
  veryLow: -1,
  low: -1,
  normal: 0,
  high: 1,
  veryHigh: 1,
  force: 2,
};

/** How many history entries getItems() reads (newest first). */
const HISTORY_LIMIT = 60;
const MIN_VERSION: readonly [number, number] = [1, 0];
const RECOMMENDED_VERSION: readonly [number, number] = [3, 0];

/** SAB's "no category" pseudo-category. */
const DEFAULT_CATEGORY = '*';

function parseVersion(text: string): [number, number] | undefined {
  const match = /^(\d+)\.(\d+)/.exec(text.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2])];
}

function below(version: [number, number], floor: readonly [number, number]): boolean {
  return version[0] !== floor[0] ? version[0] < floor[0] : version[1] < floor[1];
}

export class SabnzbdClient implements DownloadClient {
  readonly name = SABNZBD;
  readonly protocol = 'usenet' as const;
  private readonly api: SabnzbdApi;

  constructor(
    private readonly settings: SabnzbdSettings,
    runtime: ClientRuntime,
  ) {
    this.api = new SabnzbdApi(
      {
        baseUrl: buildBaseUrl(settings.host, settings.port, settings.useSsl, settings.urlBase),
        apiKey: settings.apiKey,
        username: settings.username,
        password: settings.password,
      },
      runtime,
    );
  }

  async test(): Promise<DownloadClientTestResult> {
    if (this.settings.apiKey === '' && this.settings.username === '') {
      throw new DownloadClientError('auth', 'SABnzbd requires an API key. Copy it from SABnzbd Config > General.');
    }
    // mode=version needs no key, so it isolates "wrong host" from "wrong key".
    const { version } = await this.api.callJson('version', SabVersion);
    const warnings: string[] = [];
    const parsed = parseVersion(version);
    if (parsed !== undefined && below(parsed, MIN_VERSION)) {
      throw new DownloadClientError(
        'bad-response',
        `SABnzbd ${version} is too old; version ${MIN_VERSION.join('.')} or newer is required (${RECOMMENDED_VERSION.join('.')}+ recommended).`,
      );
    }
    if (parsed !== undefined && below(parsed, RECOMMENDED_VERSION)) {
      warnings.push(`SABnzbd ${version} is old; version ${RECOMMENDED_VERSION.join('.')} or newer is recommended.`);
    }

    const { config } = await this.api.callJson('get_config', SabConfig);
    const category = this.settings.category;
    if (category === '') {
      warnings.push('No category is set. A category keeps Arclight downloads apart from everything else.');
    } else if (!config.categories.some((c) => sameCategory(c.name, category))) {
      warnings.push(
        `SABnzbd has no category "${category}"; downloads would fall back to the default (*) category. Create it in Config > Categories.`,
      );
    }
    if ((config.misc.complete_dir ?? '').trim() === '') {
      warnings.push('SABnzbd has no completed download folder set (Config > Folders).');
    }
    if (removesCompletedDownloads(config.misc)) {
      warnings.push(
        'SABnzbd removes jobs from its history on its own (Config > General > History Retention), which can happen before Arclight imports them. Set it to keep all jobs.',
      );
    }
    return { version, apiVersion: 'api', warnings };
  }

  async addTorrent(): Promise<AddTorrentResult> {
    throw notSupported(this.name, 'torrent downloads');
  }

  async addNzb(input: AddNzbInput): Promise<AddNzbResult> {
    if (input.nzb.length === 0) throw new DownloadClientError('rejected', 'The NZB document is empty.');
    const params: Record<string, string> = {
      nzbname: input.title,
      priority: String(this.priorityFor(input)),
    };
    if (input.category !== '') params['cat'] = input.category;

    const reply = await this.api.callJson('addfile', SabStatusReply, params, {
      field: 'name',
      filename: releaseFileName(input.title, 'nzb'),
      bytes: input.nzb,
      contentType: 'application/x-nzb',
    });
    const id = reply.nzo_ids?.[0];
    if (id === undefined || id === '') {
      throw new DownloadClientError('rejected', `SABnzbd did not accept the NZB for "${input.title}" (no job id returned).`);
    }
    return { id, warnings: [] };
  }

  async getItems(category: string): Promise<DownloadItem[]> {
    const historyParams: Record<string, string> = { limit: String(HISTORY_LIMIT) };
    if (category !== '') historyParams['category'] = category;
    const [queue, history] = await Promise.all([
      this.api.callJson('queue', SabQueue),
      this.api.callJson('history', SabHistory, historyParams),
    ]);

    const queuePaused = queue.queue.paused ?? queue.queue.status === 'Paused';
    const items = [
      ...queue.queue.slots.map((slot) => mapQueueSlot(slot, queuePaused)),
      ...history.history.slots.map((slot) => mapHistorySlot(slot)),
    ];
    // Filter again client-side: older SAB versions ignore the category parameters.
    return category === '' ? items : items.filter((item) => sameCategory(item.category, category));
  }

  /**
   * Deletes from the queue first; SAB echoes the ids it removed, so an id missing from the
   * reply means the job is not queued and is deleted from history instead.
   */
  async removeItem(id: string, deleteData: boolean): Promise<void> {
    const delFiles = deleteData ? '1' : '0';
    const queued = await this.api.callJson('queue', SabStatusReply, { name: 'delete', value: id, del_files: delFiles });
    if (queued.nzo_ids?.includes(id) === true) return;
    await this.api.callJson('history', SabStatusReply, {
      name: 'delete',
      value: id,
      del_files: delFiles,
      archive: '0',
    });
  }

  async getStatus(): Promise<DownloadClientStatus> {
    const { config } = await this.api.callJson('get_config', SabConfig);
    return {
      outputRootDir: categoryOutputDir(config.misc, config.categories, this.settings.category),
      isLocalhost: isLocalhostAddress(this.settings.host),
      removesCompletedDownloads: removesCompletedDownloads(config.misc),
    };
  }

  /**
   * mode=change_cat only affects queued jobs; SAB has no API to recategorize a history
   * entry and silently ignores those, so this is a no-op for finished downloads.
   */
  async setCategory(id: string, category: string): Promise<void> {
    await this.api.callJson('change_cat', SabStatusReply, {
      value: id,
      value2: category === '' ? DEFAULT_CATEGORY : category,
    });
  }

  async pause(id: string): Promise<void> {
    await this.api.callJson('queue', SabStatusReply, { name: 'pause', value: id });
  }

  async resume(id: string): Promise<void> {
    await this.api.callJson('queue', SabStatusReply, { name: 'resume', value: id });
  }

  private priorityFor(input: AddNzbInput): number {
    if (input.priority !== undefined) return USENET_TO_SAB_PRIORITY[input.priority];
    const setting = input.isRecent === true ? this.settings.recentPriority : this.settings.olderPriority;
    return SAB_PRIORITY_VALUES[setting];
  }
}

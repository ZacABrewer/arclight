import { notSupported, releaseFileName, toBase64 } from '../http.js';
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
import { categoryDestDir, categoryIndex, removesCompletedDownloads, toOptions, type NzbgetOptions } from './config.js';
import { NzbgetRpc } from './rpc.js';
import {
  NzbgetAppendResult,
  NzbgetBoolean,
  NzbgetConfig,
  NzbgetGroupList,
  NzbgetHistoryList,
  NzbgetStatus,
  NzbgetVersion,
  type NzbgetGroup,
  type NzbgetHistoryItem,
} from './schemas.js';
import type { NzbgetSettings } from './settings.js';
import { categoryMatches, downloadRate, isVisibleHistory, mapHistoryItem, mapQueueItem, queueEtas } from './state.js';

/** NZBGet's numeric priority scale. */
export const NZBGET_PRIORITY_VALUES: Record<UsenetPriority, number> = {
  veryLow: -100,
  low: -50,
  normal: 0,
  high: 50,
  veryHigh: 100,
  force: 900,
};

/**
 * The 10-argument `append` signature (with DupeKey/DupeScore/DupeMode/PPParameters) arrived in
 * NZBGet 16, the minimum supported version.
 */
export const MIN_NZBGET_MAJOR = 16;
/** NZBGet 18 dropped the Offset argument from editqueue: `[Command, Param, IDs]`. */
export const EDITQUEUE_NO_OFFSET_MAJOR = 18;

export function parseNzbgetVersion(text: string): [number, number] | undefined {
  const match = /^\s*v?(\d+)(?:\.(\d+))?/.exec(text);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2] ?? 0)];
}

type Location = 'queue' | 'history';

/**
 * NZBGet client over JSON-RPC (NZBGet 16+, including the nzbgetcom fork's v21-v24).
 * Queue ids are NZBGet NZBIDs as strings; the same NZBID is kept when an item moves to history.
 */
export class NzbgetClient implements DownloadClient {
  readonly name = 'NZBGet';
  readonly protocol = 'usenet' as const;
  private readonly rpc: NzbgetRpc;
  private majorVersion: number | undefined;

  constructor(
    private readonly settings: NzbgetSettings,
    runtime: ClientRuntime,
  ) {
    this.rpc = new NzbgetRpc(settings, runtime);
  }

  async test(): Promise<DownloadClientTestResult> {
    const version = (await this.rpc.call('version', [], NzbgetVersion)).trim();
    const parsed = parseNzbgetVersion(version);
    if (!parsed) throw new DownloadClientError('bad-response', `Unrecognised NZBGet version "${version}".`);
    this.majorVersion = parsed[0];
    if (parsed[0] < MIN_NZBGET_MAJOR) {
      throw new DownloadClientError('bad-response', `NZBGet ${version} is too old; version ${MIN_NZBGET_MAJOR} or newer is required.`);
    }

    const options = await this.options();
    const warnings: string[] = [];
    const category = this.settings.category;
    if (category === '') {
      warnings.push('No category is set. A category keeps Arclight downloads apart from everything else.');
    } else if (categoryIndex(options, category) === undefined) {
      warnings.push(`Category "${category}" does not exist in NZBGet. Add it under Settings > Categories.`);
    }
    const postImport = this.settings.postImportCategory;
    if (postImport !== undefined && postImport !== '' && categoryIndex(options, postImport) === undefined) {
      warnings.push(`Post-import category "${postImport}" does not exist in NZBGet.`);
    }
    if (removesCompletedDownloads(options)) {
      warnings.push(
        'NZBGet KeepHistory is 0, so finished downloads leave the history immediately, before Arclight can import them. Set KeepHistory to at least 1 day.',
      );
    }
    return { version, apiVersion: 'jsonrpc', warnings };
  }

  async addTorrent(): Promise<AddTorrentResult> {
    throw notSupported(this.name, 'torrent downloads');
  }

  async addNzb(input: AddNzbInput): Promise<AddNzbResult> {
    if (input.nzb.length === 0) throw new DownloadClientError('rejected', 'The NZB document is empty.');
    const priority = input.priority ?? (input.isRecent === true ? this.settings.recentPriority : this.settings.olderPriority);
    const nzbId = await this.rpc.call(
      'append',
      [
        releaseFileName(input.title, 'nzb'),
        toBase64(input.nzb),
        input.category,
        NZBGET_PRIORITY_VALUES[priority],
        false, // AddToTop
        this.settings.addPaused,
        '', // DupeKey
        0, // DupeScore
        'SCORE', // DupeMode
        [], // PPParameters
      ],
      NzbgetAppendResult,
    );
    if (!Number.isInteger(nzbId) || nzbId <= 0) {
      throw new DownloadClientError('rejected', `NZBGet refused the NZB "${input.title}" (append returned ${nzbId}).`);
    }
    return { id: String(nzbId), warnings: [] };
  }

  async getItems(category: string): Promise<DownloadItem[]> {
    const [groups, history, status] = await Promise.all([
      this.listGroups(),
      this.listHistory(),
      this.rpc.call('status', [], NzbgetStatus),
    ]);
    const globallyPaused = status.DownloadPaused === true;
    const etas = queueEtas(groups, downloadRate(status), globallyPaused);

    const items: DownloadItem[] = [];
    for (const group of groups) {
      if (!categoryMatches(group.Category, category)) continue;
      items.push(mapQueueItem(group, globallyPaused, etas.get(group.NZBID)));
    }
    for (const record of history) {
      if (!isVisibleHistory(record) || !categoryMatches(record.Category, category)) continue;
      items.push(mapHistoryItem(record));
    }
    return items;
  }

  /**
   * Queue items: GroupFinalDelete (deleteData; removes the download and its files without a
   * history record) or GroupDelete (moves it to history as DELETED/MANUAL). History items:
   * HistoryFinalDelete (deleteData; removes the record) or HistoryDelete (hides it, keeping it
   * for duplicate checks). NZBGet has no RPC to delete a history item's files on disk.
   */
  async removeItem(id: string, deleteData: boolean): Promise<void> {
    const nzbId = parseId(id);
    const location = await this.locate(nzbId);
    if (location === 'queue') {
      await this.editQueue(deleteData ? 'GroupFinalDelete' : 'GroupDelete', '', nzbId, 'remove');
    } else {
      await this.editQueue(deleteData ? 'HistoryFinalDelete' : 'HistoryDelete', '', nzbId, 'remove');
    }
  }

  async getStatus(): Promise<DownloadClientStatus> {
    const options = await this.options();
    return {
      outputRootDir: categoryDestDir(options, this.settings.category),
      isLocalhost: isLocalhostAddress(this.settings.host),
      removesCompletedDownloads: removesCompletedDownloads(options),
    };
  }

  /**
   * Queue items use GroupApplyCategory (also applies the category's post-processing settings).
   * History items use HistorySetCategory, which only newer NZBGet releases support; older ones
   * answer false, surfaced as 'rejected'.
   */
  async setCategory(id: string, category: string): Promise<void> {
    const nzbId = parseId(id);
    const location = await this.locate(nzbId);
    const command = location === 'queue' ? 'GroupApplyCategory' : 'HistorySetCategory';
    await this.editQueue(command, category, nzbId, 'set the category of');
  }

  async pause(id: string): Promise<void> {
    await this.editQueue('GroupPause', '', parseId(id), 'pause');
  }

  async resume(id: string): Promise<void> {
    await this.editQueue('GroupResume', '', parseId(id), 'resume');
  }

  // ------------------------------------------------------------------------- helpers

  private async options(): Promise<NzbgetOptions> {
    return toOptions(await this.rpc.call('config', [], NzbgetConfig));
  }

  private listGroups(): Promise<NzbgetGroup[]> {
    return this.rpc.call('listgroups', [0], NzbgetGroupList);
  }

  private listHistory(): Promise<NzbgetHistoryItem[]> {
    return this.rpc.call('history', [false], NzbgetHistoryList);
  }

  private async locate(nzbId: number): Promise<Location> {
    const groups = await this.listGroups();
    if (groups.some((g) => g.NZBID === nzbId)) return 'queue';
    const history = await this.listHistory();
    if (history.some((h) => h.NZBID === nzbId)) return 'history';
    throw new DownloadClientError('not-found', `NZBGet has no download with id ${nzbId}.`);
  }

  private async major(): Promise<number> {
    if (this.majorVersion === undefined) {
      const version = await this.rpc.call('version', [], NzbgetVersion);
      this.majorVersion = parseNzbgetVersion(version)?.[0] ?? EDITQUEUE_NO_OFFSET_MAJOR;
    }
    return this.majorVersion;
  }

  /** v18+: [Command, Param, IDs]; v16-17 also take an Offset (unused, 0) after Command. */
  private async editQueue(command: string, param: string, nzbId: number, what: string): Promise<void> {
    const params = (await this.major()) >= EDITQUEUE_NO_OFFSET_MAJOR ? [command, param, [nzbId]] : [command, 0, param, [nzbId]];
    const ok = await this.rpc.call('editqueue', params, NzbgetBoolean);
    if (!ok) {
      throw new DownloadClientError('rejected', `NZBGet could not ${what} download ${nzbId} (${command} returned false).`);
    }
  }
}

function parseId(id: string): number {
  const value = Number(id.trim());
  if (!/^\d+$/.test(id.trim()) || !Number.isSafeInteger(value) || value <= 0) {
    throw new DownloadClientError('not-found', `"${id}" is not an NZBGet download id.`);
  }
  return value;
}


/**
 * Pure mapping from NZBGet queue groups / history records to normalized `DownloadItem`s.
 *
 * Decisions:
 * - Queue items are never 'completed': anything in post-processing (PP_QUEUED, LOADING_PARS,
 *   VERIFYING_*, REPAIRING, RENAMING, UNPACKING, MOVING, EXECUTING_SCRIPT, PP_FINISHED) is
 *   'downloading' with a message until NZBGet moves it to history as SUCCESS.
 * - History SUCCESS/* is 'completed' unless the item was marked BAD ('failed').
 * - WARNING/* is 'warning': e.g. WARNING/SCRIPT means a post-processing script failed, but the
 *   files are usually fine; WARNING/SPACE is fixable by freeing disk space. A human decides.
 * - FAILURE/* is 'failed' (definitive) with a message naming the step that failed.
 * - DELETED/MANUAL is 'warning', not 'failed': a person (or Media-Tron itself via removeItem)
 *   deleted it, which must not trigger blocklisting.
 * - DELETED/DUPE, DELETED/COPY, DELETED/GOOD are 'warning': NZBGet's duplicate check dropped
 *   the item because another copy exists; the release itself is not bad.
 * - DELETED/HEALTH, DELETED/BAD, DELETED/SCAN are 'failed'.
 * - Hidden duplicate records (Kind 'DUPE') are skipped entirely.
 */
import { normalizeEta } from '../http.js';
import type { DownloadItem, DownloadItemStatus } from '../types.js';
import type { NzbgetGroup, NzbgetHistoryItem, NzbgetStatus } from './schemas.js';

const TWO_POW_32 = 4_294_967_296;
const MIB = 1024 * 1024;

/** Combines NZBGet's Lo/Hi uint32 pair into bytes, falling back to the MB figure. */
export function combineSize(lo: number | undefined, hi: number | undefined, mb: number | undefined): number {
  if (lo !== undefined) return (hi ?? 0) * TWO_POW_32 + (lo >>> 0);
  if (mb !== undefined) return Math.round(mb * MIB);
  return 0;
}

/** Bytes per second. Newer versions add a Lo/Hi pair next to the 32-bit DownloadRate. */
export function downloadRate(status: NzbgetStatus): number {
  if (status.DownloadRateLo !== undefined) return combineSize(status.DownloadRateLo, status.DownloadRateHi, undefined);
  return Math.max(0, status.DownloadRate ?? 0);
}

interface StateMapping {
  status: DownloadItemStatus;
  message?: string;
}

const POST_PROCESSING_MESSAGES: Record<string, string> = {
  PP_QUEUED: 'Queued for post-processing',
  LOADING_PARS: 'Post-processing: loading par files',
  VERIFYING_SOURCES: 'Post-processing: verifying files',
  REPAIRING: 'Post-processing: repairing',
  VERIFYING_REPAIRED: 'Post-processing: verifying repaired files',
  RENAMING: 'Post-processing: renaming files',
  UNPACKING: 'Post-processing: unpacking',
  MOVING: 'Post-processing: moving files',
  EXECUTING_SCRIPT: 'Post-processing: running scripts',
  PP_FINISHED: 'Post-processing finished; waiting for NZBGet to move it to history',
};

const GLOBAL_PAUSE_MESSAGE = 'NZBGet downloading is paused';

export function mapQueueStatus(status: string, globallyPaused: boolean): StateMapping {
  switch (status) {
    case 'QUEUED':
      return globallyPaused ? { status: 'paused', message: GLOBAL_PAUSE_MESSAGE } : { status: 'queued' };
    case 'PAUSED':
      return { status: 'paused' };
    case 'DOWNLOADING':
      return globallyPaused ? { status: 'paused', message: GLOBAL_PAUSE_MESSAGE } : { status: 'downloading' };
    case 'FETCHING':
      return { status: 'queued', message: 'Fetching the NZB file' };
    default: {
      const message = POST_PROCESSING_MESSAGES[status];
      if (message !== undefined) return { status: 'downloading', message };
      return { status: 'downloading', message: `Unknown NZBGet status "${status}"` };
    }
  }
}

const FAILURE_MESSAGES: Record<string, string> = {
  PAR: 'Par check/repair failed',
  UNPACK: 'Unpacking failed',
  MOVE: 'Moving the files failed',
  SCAN: 'The NZB file could not be parsed',
  BAD: 'Marked as bad',
  HEALTH: 'Download health too low: too many articles missing',
  FETCH: 'Fetching the NZB file failed',
  HIDDEN: 'Failed (hidden)',
};

const WARNING_MESSAGES: Record<string, string> = {
  SCRIPT: 'A post-processing script failed; the files may still be fine',
  SPACE: 'Not enough disk space to unpack; free space and post-process again in NZBGet',
  PASSWORD: 'The archive is password protected',
  DAMAGED: 'The download is damaged and was not repaired',
  REPAIRABLE: 'The download is damaged but repairable; par repair was not performed',
  HEALTH: 'Download health is low; files may be incomplete',
  SKIPPED: 'Post-processing was skipped',
};

const DUPLICATE_DELETES = new Set(['DUPE', 'COPY', 'GOOD']);
const FAILED_DELETES = new Set(['HEALTH', 'BAD', 'SCAN']);

export function mapHistoryStatus(record: Pick<NzbgetHistoryItem, 'Status' | 'MarkStatus'>): StateMapping {
  const [kind = '', detail = ''] = record.Status.toUpperCase().split('/', 2);
  if (record.MarkStatus?.toUpperCase() === 'BAD') return { status: 'failed', message: 'Marked as bad in NZBGet' };

  switch (kind) {
    case 'SUCCESS':
      return { status: 'completed' };
    case 'WARNING':
      return { status: 'warning', message: WARNING_MESSAGES[detail] ?? `NZBGet reported a warning (${record.Status})` };
    case 'FAILURE':
      return { status: 'failed', message: FAILURE_MESSAGES[detail] ?? `NZBGet reported a failure (${record.Status})` };
    case 'DELETED':
      if (detail === 'MANUAL') return { status: 'warning', message: 'Deleted manually in NZBGet' };
      if (DUPLICATE_DELETES.has(detail)) {
        return {
          status: 'warning',
          message: `Deleted by the NZBGet duplicate check (${detail}); disable duplicate checking for this category`,
        };
      }
      if (FAILED_DELETES.has(detail)) {
        return { status: 'failed', message: `Deleted by NZBGet: ${FAILURE_MESSAGES[detail] ?? detail}` };
      }
      return { status: 'warning', message: `Deleted in NZBGet (${record.Status})` };
    default:
      return { status: 'warning', message: `Unknown NZBGet history status "${record.Status}"` };
  }
}

function pausedBytes(group: NzbgetGroup): number {
  return combineSize(group.PausedSizeLo, group.PausedSizeHi, group.PausedSizeMB);
}

/** Remaining bytes NZBGet will actually fetch. Paused files (extra par2 volumes) are only fetched if repair needs them. */
export function groupRemainingBytes(group: NzbgetGroup): number {
  const remaining = combineSize(group.RemainingSizeLo, group.RemainingSizeHi, group.RemainingSizeMB);
  return Math.max(0, remaining - pausedBytes(group));
}

/**
 * Cumulative ETA per queue item in queue order: an item finishes after everything active ahead
 * of it. Undefined when the item is waiting (paused, fetching, nothing downloading, global
 * pause); 0 for items already in post-processing.
 */
export function queueEtas(groups: NzbgetGroup[], rate: number, globallyPaused: boolean): Map<number, number | undefined> {
  const etas = new Map<number, number | undefined>();
  let ahead = 0;
  for (const group of groups) {
    const active = group.Status === 'QUEUED' || group.Status === 'DOWNLOADING';
    if (active && !globallyPaused && rate > 0) {
      ahead += groupRemainingBytes(group);
      etas.set(group.NZBID, normalizeEta(ahead / rate));
    } else if (active || group.Status === 'PAUSED' || group.Status === 'FETCHING') {
      etas.set(group.NZBID, undefined);
    } else {
      etas.set(group.NZBID, 0);
    }
  }
  return etas;
}

export function mapQueueItem(group: NzbgetGroup, globallyPaused: boolean, etaSeconds: number | undefined): DownloadItem {
  const totalBytes = combineSize(group.FileSizeLo, group.FileSizeHi, group.FileSizeMB);
  const paused = pausedBytes(group);
  const remainingBytes = groupRemainingBytes(group);
  const effectiveTotal = Math.max(0, totalBytes - paused);
  const downloadedBytes =
    group.DownloadedSizeLo !== undefined || group.DownloadedSizeMB !== undefined
      ? combineSize(group.DownloadedSizeLo, group.DownloadedSizeHi, group.DownloadedSizeMB)
      : Math.max(0, effectiveTotal - remainingBytes);
  const progress = effectiveTotal > 0 ? Math.min(1, Math.max(0, (effectiveTotal - remainingBytes) / effectiveTotal)) : 0;
  const mapped = mapQueueStatus(group.Status, globallyPaused);

  const item: DownloadItem = {
    id: String(group.NZBID),
    title: group.NZBName,
    category: group.Category,
    totalBytes,
    remainingBytes,
    downloadedBytes,
    progress,
    status: mapped.status,
    outputPath: '',
    isReadOnly: false,
    canMoveFiles: false,
    canBeRemoved: false,
  };
  if (mapped.message !== undefined) item.statusMessage = mapped.message;
  if (etaSeconds !== undefined) item.etaSeconds = etaSeconds;
  return item;
}

export function mapHistoryItem(record: NzbgetHistoryItem): DownloadItem {
  const totalBytes = combineSize(record.FileSizeLo, record.FileSizeHi, record.FileSizeMB);
  const mapped = mapHistoryStatus(record);
  const item: DownloadItem = {
    id: String(record.NZBID),
    title: record.Name,
    category: record.Category,
    totalBytes,
    remainingBytes: 0,
    downloadedBytes: totalBytes,
    progress: 1,
    status: mapped.status,
    outputPath: record.FinalDir !== '' ? record.FinalDir : record.DestDir,
    etaSeconds: 0,
    isReadOnly: false,
    canMoveFiles: true,
    canBeRemoved: true,
  };
  if (mapped.message !== undefined) item.statusMessage = mapped.message;
  return item;
}

/** Hidden duplicate backups (Kind 'DUPE') are bookkeeping, not downloads. */
export function isVisibleHistory(record: NzbgetHistoryItem): boolean {
  return record.Kind?.toUpperCase() !== 'DUPE';
}

/** NZBGet compares category names case-insensitively. '' matches everything. */
export function categoryMatches(itemCategory: string, wanted: string): boolean {
  return wanted === '' || itemCategory.toLowerCase() === wanted.toLowerCase();
}

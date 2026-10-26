/**
 * Pure mapping of SABnzbd queue and history slots to normalized `DownloadItem`s.
 *
 * Queue (mode=queue) holds jobs still downloading; history (mode=history) holds jobs in
 * post-processing (verify/repair/unpack/move/script) and finished ones. Only history
 * `Completed` is ready to import, and only history `Failed` with a release-related reason
 * is reported as `failed` (which triggers blocklist + re-search).
 */
import { isRootedPath, joinRemotePath } from '../paths.js';
import type { DownloadItem, DownloadItemStatus } from '../types.js';
import type { SabCategory, SabHistorySlot, SabMisc, SabQueueSlot } from './schemas.js';

const MIB = 1024 * 1024;
const ONE_YEAR_SECONDS = 365 * 24 * 3600;

export interface StateMapping {
  status: DownloadItemStatus;
  message?: string;
}

/** History statuses that mean SAB is still post-processing the job. */
const POST_PROCESSING = new Set([
  'Queued',
  'Verifying',
  'Repairing',
  'Extracting',
  'Moving',
  'Running',
  'Fetching',
  'QuickCheck',
  'Checking',
]);

/**
 * Failures that are not the release's fault: a failing user post-processing script, or
 * the local disk/permissions. Reported as `warning` so the release is not blocklisted.
 */
const SCRIPT_FAILURE = /script|^exit\(/i;
const LOCAL_FAILURE =
  /disk (is )?full|write error|out of (disk )?space|no space left|not enough (disk )?space|permission denied|access is denied|errno 28/i;

/** Maps a mode=queue slot status. `queuePaused` is the global queue pause state. */
export function mapQueueStatus(status: string, queuePaused: boolean): StateMapping {
  if (status === 'Paused') return { status: 'paused' };
  if (queuePaused) return { status: 'paused', message: 'The SABnzbd queue is paused' };
  switch (status) {
    case 'Downloading':
      return { status: 'downloading' };
    case 'Queued':
      return { status: 'queued' };
    case 'Grabbing':
      return { status: 'queued', message: 'SABnzbd is fetching the NZB' };
    case 'Fetching':
      return { status: 'queued', message: 'SABnzbd is fetching additional recovery blocks' };
    case 'Propagating':
      return { status: 'queued', message: 'Delayed: waiting for the post to propagate' };
    case 'Checking':
    case 'QuickCheck':
      return { status: 'downloading', message: 'SABnzbd is checking the download' };
    default:
      return { status: 'downloading', message: `Unknown SABnzbd queue status "${status}"` };
  }
}

/** Maps a mode=history slot status (and its fail_message). */
export function mapHistoryStatus(status: string, failMessage: string): StateMapping {
  if (status === 'Completed') return { status: 'completed' };
  if (status === 'Failed') {
    const message = failMessage.trim() === '' ? 'SABnzbd reported the download as failed' : failMessage.trim();
    if (SCRIPT_FAILURE.test(message)) {
      return { status: 'warning', message: `Post-processing script failed: ${message}` };
    }
    if (LOCAL_FAILURE.test(message)) {
      return { status: 'warning', message: `SABnzbd could not write the download: ${message}` };
    }
    return { status: 'failed', message };
  }
  if (POST_PROCESSING.has(status)) return { status: 'downloading', message: `Post-processing (${status})` };
  return { status: 'downloading', message: `Unknown SABnzbd history status "${status}"` };
}

/** Parses SAB's `timeleft` ("h:mm:ss", or "d:hh:mm:ss" for long jobs) into seconds. */
export function parseTimeLeft(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const parts = text.trim().split(':');
  if (parts.length < 2 || parts.length > 4 || parts.some((p) => !/^\d+$/.test(p))) return undefined;
  const multipliers = [1, 60, 3600, 86400];
  let seconds = 0;
  parts.reverse().forEach((part, index) => {
    seconds += Number(part) * (multipliers[index] ?? 0);
  });
  return seconds > ONE_YEAR_SECONDS ? undefined : seconds;
}

export function mapQueueSlot(slot: SabQueueSlot, queuePaused: boolean): DownloadItem {
  const mapped = mapQueueStatus(slot.status, queuePaused);
  const totalBytes = Math.max(0, Math.round((slot.mb ?? 0) * MIB));
  const remainingBytes = Math.min(totalBytes, Math.max(0, Math.round((slot.mbleft ?? 0) * MIB)));
  const progress =
    totalBytes > 0
      ? (totalBytes - remainingBytes) / totalBytes
      : Math.min(1, Math.max(0, (slot.percentage ?? 0) / 100));

  const item: DownloadItem = {
    id: slot.nzo_id,
    title: slot.filename,
    category: slot.cat ?? '',
    totalBytes,
    remainingBytes,
    downloadedBytes: totalBytes - remainingBytes,
    progress,
    status: mapped.status,
    outputPath: '',
    isReadOnly: false,
    canMoveFiles: false,
    canBeRemoved: false,
  };
  if (mapped.message !== undefined) item.statusMessage = mapped.message;
  if (mapped.status === 'downloading') {
    const eta = parseTimeLeft(slot.timeleft);
    if (eta !== undefined && eta > 0) item.etaSeconds = eta;
  }
  return item;
}

export function mapHistorySlot(slot: SabHistorySlot): DownloadItem {
  let mapped = mapHistoryStatus(slot.status, slot.fail_message ?? '');
  const storage = slot.storage ?? '';
  if (mapped.status === 'completed' && storage === '') {
    mapped = { status: 'warning', message: 'SABnzbd did not report where the completed download was stored' };
  }
  const totalBytes = Math.max(0, Math.round(slot.bytes ?? 0));
  const finished = mapped.status === 'completed' || mapped.status === 'failed' || mapped.status === 'warning';

  const item: DownloadItem = {
    id: slot.nzo_id,
    title: slot.name,
    category: slot.category ?? '',
    totalBytes,
    remainingBytes: 0,
    downloadedBytes: totalBytes,
    progress: 1,
    status: mapped.status,
    outputPath: finished ? storage : '',
    isReadOnly: false,
    canMoveFiles: finished,
    canBeRemoved: finished,
  };
  if (mapped.message !== undefined) item.statusMessage = mapped.message;
  if (finished) item.etaSeconds = 0;
  return item;
}

export function sameCategory(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Directory SAB places completed jobs of `category` in: the category's folder (absolute,
 * or relative to misc.complete_dir), else misc.complete_dir. A trailing "*" on a category
 * folder (SAB's "no job subfolder" marker) is dropped.
 */
export function categoryOutputDir(misc: SabMisc, categories: SabCategory[], category: string): string {
  const completeDir = misc.complete_dir ?? '';
  if (category === '') return completeDir;
  const match = categories.find((c) => sameCategory(c.name, category));
  const dir = (match?.dir ?? '').trim().replace(/[\\/]?\*$/, '');
  if (dir === '') return completeDir;
  return isRootedPath(dir) ? dir : joinRemotePath(completeDir, dir);
}

/**
 * Whether SAB drops finished jobs from the (visible) history on its own, which can race
 * with imports. Up to 4.2 `history_retention` "" / "0" keeps everything; any other value
 * ("-1" none, "<n>" jobs, "<n>d" days) removes. 4.3+ `history_retention_option` "all"
 * keeps everything; every other option deletes or archives (archived jobs vanish from
 * mode=history), so it counts as removing.
 */
export function removesCompletedDownloads(misc: SabMisc): boolean {
  const option = (misc.history_retention_option ?? '').trim();
  if (option !== '') return option !== 'all';
  const legacy = String(misc.history_retention ?? '').trim();
  return legacy !== '' && legacy !== '0';
}

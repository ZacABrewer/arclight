import { normalizeEta } from '../http.js';
import { joinRemotePath } from '../paths.js';
import type { DownloadItem, DownloadItemStatus } from '../types.js';
import type { DelugeConfigValues, DelugeTorrentStatus } from './schemas.js';

/** Float slack when comparing ratios: Deluge stops at e.g. 1.9996 for a 2.0 limit. */
const RATIO_EPSILON = 0.001;

/** States in which a finished torrent is at rest (seeding, stopped, or queued to seed). */
const SETTLED_STATES = new Set(['Seeding', 'Paused', 'Queued']);

interface StateMapping {
  status: DownloadItemStatus;
  message?: string;
}

/** True once the payload is fully downloaded and Deluge is not checking/moving it. */
export function isFinished(torrent: DelugeTorrentStatus): boolean {
  return torrent.is_finished && SETTLED_STATES.has(torrent.state);
}

/** Maps a raw Deluge state to a normalized status, before seed-limit adjustments. */
export function mapDelugeState(torrent: DelugeTorrentStatus): StateMapping {
  const message = torrent.message !== undefined && torrent.message !== '' && torrent.message !== 'OK'
    ? torrent.message
    : undefined;
  switch (torrent.state) {
    case 'Downloading':
      return { status: 'downloading' };
    case 'Seeding':
      return { status: 'seeding' };
    case 'Paused':
      return torrent.is_finished ? { status: 'completed' } : { status: 'paused' };
    case 'Queued':
      // Auto-managed queue: finished torrents wait for a seeding slot.
      return torrent.is_finished ? { status: 'seeding' } : { status: 'queued' };
    case 'Checking':
      // A recheck may still fail; never report completed while it runs.
      return { status: 'queued', message: 'Deluge is checking the downloaded data' };
    case 'Allocating':
      return { status: 'queued', message: 'Deluge is allocating disk space' };
    case 'Moving':
      return { status: 'downloading', message: 'Deluge is moving the files' };
    case 'Error':
      // Warning rather than failed: Deluge errors (disk full, missing files) are often
      // transient and must not trigger failed-download handling.
      return { status: 'warning', message: message ?? 'Deluge reported an error for this torrent' };
    default:
      return { status: 'downloading', message: `Unknown Deluge state "${torrent.state}"` };
  }
}

/** The ratio at which Deluge stops this torrent, or undefined when it seeds forever. */
export function effectiveStopRatio(torrent: DelugeTorrentStatus, config: DelugeConfigValues): number | undefined {
  const stopAtRatio = torrent.stop_at_ratio ?? config.stop_seed_at_ratio ?? false;
  if (!stopAtRatio) return undefined;
  const ratio = torrent.stop_ratio ?? config.stop_seed_ratio;
  return ratio !== undefined && ratio >= 0 ? ratio : undefined;
}

export function hasReachedStopRatio(torrent: DelugeTorrentStatus, config: DelugeConfigValues): boolean {
  const limit = effectiveStopRatio(torrent, config);
  return limit !== undefined && limit - torrent.ratio <= RATIO_EPSILON;
}

/** Deluge 2 reports `download_location`, 1.3 `save_path`. */
export function saveDirectory(torrent: DelugeTorrentStatus): string {
  return torrent.download_location ?? torrent.save_path ?? '';
}

export interface MapContext {
  config: DelugeConfigValues;
}

/**
 * Converts one `core.get_torrents_status` entry into a normalized `DownloadItem`.
 *
 * Removal rules:
 * - Finished and paused: Deluge pauses torrents when they hit their stop ratio, so a
 *   paused finished torrent has no seeding obligation left → `completed`, removable.
 * - Seeding with the stop ratio already reached → `completed`, removable.
 * - Finished but still seeding (or queued to seed) below the limit → read-only.
 */
export function mapTorrent(hash: string, torrent: DelugeTorrentStatus, context: MapContext): DownloadItem {
  const mapped = mapDelugeState(torrent);
  let status = mapped.status;

  const finished = isFinished(torrent);
  const limitReached = finished && hasReachedStopRatio(torrent, context.config);
  const removable = finished && (torrent.state === 'Paused' || limitReached);
  if (limitReached) status = 'completed';

  const totalBytes = Math.max(0, Math.round(torrent.total_wanted ?? torrent.total_size));
  const progress = Math.min(1, Math.max(0, torrent.progress / 100));
  const remainingBytes = finished
    ? 0
    : Math.max(0, Math.min(totalBytes, Math.round(totalBytes - torrent.total_done)));

  const directory = saveDirectory(torrent);
  // The torrent name is the top-level folder for multi-file torrents and the file name for
  // single-file ones, so joining it onto the save directory gives the content root either way.
  const outputPath = torrent.name === '' ? directory : joinRemotePath(directory, torrent.name);

  const item: DownloadItem = {
    id: (torrent.hash ?? hash).toLowerCase(),
    title: torrent.name,
    category: torrent.label ?? '',
    totalBytes,
    remainingBytes,
    downloadedBytes: totalBytes - remainingBytes,
    progress: finished ? 1 : progress,
    status,
    outputPath,
    isReadOnly: finished && !removable,
    canMoveFiles: removable,
    canBeRemoved: removable,
  };
  if (mapped.message !== undefined) item.statusMessage = mapped.message;
  // Deluge reports 0 when it has no estimate.
  const eta = finished ? 0 : torrent.eta !== undefined && torrent.eta > 0 ? normalizeEta(torrent.eta) : undefined;
  if (eta !== undefined) item.etaSeconds = eta;
  return item;
}

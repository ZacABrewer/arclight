import { normalizeEta } from '../http.js';
import { joinRemotePath, sameRemotePath } from '../paths.js';
import type { DownloadItem, DownloadItemStatus } from '../types.js';
import { TR_ERROR, TR_LIMIT_MODE, TR_STATUS, type TrSession, type TrTorrent } from './schemas.js';

/** Float slack when comparing ratios: Transmission stops at e.g. 1.9996. */
const RATIO_EPSILON = 0.001;

export interface SeedLimits {
  ratio?: number;
  /** Minutes of inactivity. */
  idleMinutes?: number;
}

/**
 * The seed limits that apply to a torrent. Mode 0 defers to the session (global) setting,
 * 1 uses the torrent's own value, 2 means unlimited.
 */
export function effectiveSeedLimits(torrent: TrTorrent, session: TrSession): SeedLimits {
  const limits: SeedLimits = {};
  if (torrent.seedRatioMode === TR_LIMIT_MODE.single) {
    limits.ratio = torrent.seedRatioLimit;
  } else if (
    torrent.seedRatioMode === TR_LIMIT_MODE.global &&
    session.seedRatioLimited === true &&
    session.seedRatioLimit !== undefined
  ) {
    limits.ratio = session.seedRatioLimit;
  }
  if (torrent.seedIdleMode === TR_LIMIT_MODE.single) {
    limits.idleMinutes = torrent.seedIdleLimit;
  } else if (
    torrent.seedIdleMode === TR_LIMIT_MODE.global &&
    session['idle-seeding-limit-enabled'] === true &&
    session['idle-seeding-limit'] !== undefined
  ) {
    limits.idleMinutes = session['idle-seeding-limit'];
  }
  return limits;
}

export function hasAnySeedLimit(limits: SeedLimits): boolean {
  return limits.ratio !== undefined || limits.idleMinutes !== undefined;
}

/**
 * Whether seeding obligations are met. `isFinished` is Transmission's own verdict (it stopped
 * the torrent at a limit); the ratio/idle checks catch torrents that crossed a limit but were
 * not stopped yet.
 */
export function hasReachedSeedLimit(torrent: TrTorrent, limits: SeedLimits, nowMs: number): boolean {
  if (torrent.isFinished) return true;
  if (limits.ratio !== undefined && limits.ratio - torrent.uploadRatio <= RATIO_EPSILON) return true;
  if (limits.idleMinutes !== undefined && torrent.activityDate > 0) {
    const idleSeconds = Math.floor(nowMs / 1000) - torrent.activityDate;
    if (idleSeconds >= limits.idleMinutes * 60) return true;
  }
  return false;
}

/** All wanted data is present. */
export function isDownloaded(torrent: TrTorrent): boolean {
  return torrent.leftUntilDone <= 0 && torrent.percentDone >= 1;
}

interface StateMapping {
  status: DownloadItemStatus;
  message?: string;
}

/** Status from the raw status code, before error and seed-limit adjustments. */
export function mapTrStatus(torrent: TrTorrent): StateMapping {
  const downloaded = isDownloaded(torrent);
  switch (torrent.status) {
    case TR_STATUS.stopped:
      return downloaded ? { status: 'completed' } : { status: 'paused' };
    case TR_STATUS.checkWait:
    case TR_STATUS.checking:
      // A recheck may still find bad pieces; never report completed while verifying.
      return { status: 'queued', message: 'Transmission is verifying the data' };
    case TR_STATUS.downloadWait:
      return { status: 'queued' };
    case TR_STATUS.downloading:
      return { status: 'downloading' };
    case TR_STATUS.seedWait:
    case TR_STATUS.seeding:
      return { status: 'seeding' };
    default:
      return { status: 'downloading', message: `Unknown Transmission status ${torrent.status}` };
  }
}

/**
 * How categories are represented. With labels (rpc-version 16+, Transmission 3.00+) the
 * category is a torrent label; on older daemons it is a sub-directory of the base directory.
 */
export interface CategoryMode {
  useLabels: boolean;
  /** settings.directory, or the session download-dir. */
  baseDir: string;
}

export interface CategoryContext extends CategoryMode {
  /** The category being listed, or '' for all. */
  requested: string;
  /** Extra categories to recognise in directory mode (configured + post-import). */
  knownCategories: readonly string[];
}

export function labelMatches(labels: readonly string[] | undefined, category: string): boolean {
  const wanted = category.toLowerCase();
  return (labels ?? []).some((label) => label.toLowerCase() === wanted);
}

export function categoryDir(baseDir: string, category: string): string {
  return category === '' ? baseDir : joinRemotePath(baseDir, category);
}

/** True when the torrent belongs to `category` ('' matches everything). */
export function inCategory(torrent: TrTorrent, category: string, mode: CategoryMode): boolean {
  if (category === '') return true;
  if (mode.useLabels) return labelMatches(torrent.labels, category);
  return sameRemotePath(torrent.downloadDir, categoryDir(mode.baseDir, category));
}

export function categoryOf(torrent: TrTorrent, context: CategoryContext): string {
  if (context.useLabels) {
    const labels = torrent.labels ?? [];
    if (context.requested !== '') {
      const wanted = context.requested.toLowerCase();
      const match = labels.find((label) => label.toLowerCase() === wanted);
      if (match !== undefined) return match;
    }
    return labels[0] ?? '';
  }
  const candidates = [context.requested, ...context.knownCategories];
  return candidates.find((c) => c !== '' && sameRemotePath(torrent.downloadDir, categoryDir(context.baseDir, c))) ?? '';
}

export interface MapContext {
  session: TrSession;
  nowMs: number;
  category: CategoryContext;
}

/**
 * Converts a torrent-get entry into a normalized `DownloadItem`.
 *
 * - Transmission keeps content at `downloadDir/name` for both layouts: `name` is the file for
 *   single-file torrents and the top folder for multi-file ones.
 * - Seed limit reached (`isFinished`, or ratio/idle limit crossed) -> `completed`, removable.
 * - Seeding with limits outstanding, or with no limit at all -> `seeding`, read-only.
 * - Stopped after downloading with no limit in force: a public torrent is removable; a
 *   private (or unknown) one stays read-only since tracker rules are invisible to us.
 * - Error codes 1/2 (tracker) and 3 (local) -> `warning`, never `failed`: they are often
 *   transient and must not trigger blocklisting.
 */
export function mapTorrent(torrent: TrTorrent, context: MapContext): DownloadItem {
  const mapped = mapTrStatus(torrent);
  let status = mapped.status;
  let message = mapped.message;

  const totalBytes = Math.max(0, Math.round(torrent.totalSize));
  const progress = Math.min(1, Math.max(0, torrent.percentDone));
  const remainingBytes = Math.max(0, Math.min(totalBytes, Math.round(torrent.leftUntilDone)));

  const finished = isDownloaded(torrent) && (status === 'completed' || status === 'seeding');
  let removable = false;
  if (finished) {
    const limits = effectiveSeedLimits(torrent, context.session);
    const limitReached = hasReachedSeedLimit(torrent, limits, context.nowMs);
    const stoppedWithoutObligation =
      torrent.status === TR_STATUS.stopped && !hasAnySeedLimit(limits) && torrent.isPrivate === false;
    removable = limitReached || stoppedWithoutObligation;
    if (limitReached) status = 'completed';
  }

  if (torrent.error !== TR_ERROR.ok) {
    const kind =
      torrent.error === TR_ERROR.trackerWarning
        ? 'Tracker warning'
        : torrent.error === TR_ERROR.trackerError
          ? 'Tracker error'
          : 'Transmission error';
    status = 'warning';
    message = torrent.errorString === '' ? kind : `${kind}: ${torrent.errorString}`;
    // A local error (disk full, missing files) means the payload may be incomplete.
    if (torrent.error === TR_ERROR.localError) removable = false;
  }

  const item: DownloadItem = {
    id: torrent.hashString.toLowerCase(),
    title: torrent.name,
    category: categoryOf(torrent, context.category),
    totalBytes,
    remainingBytes,
    downloadedBytes: totalBytes - remainingBytes,
    progress,
    status,
    outputPath: joinRemotePath(torrent.downloadDir, torrent.name),
    isReadOnly: finished && !removable,
    canMoveFiles: removable,
    canBeRemoved: removable,
  };
  if (message !== undefined) item.statusMessage = message;
  const eta = finished ? 0 : normalizeEta(torrent.eta);
  if (eta !== undefined) item.etaSeconds = eta;
  return item;
}

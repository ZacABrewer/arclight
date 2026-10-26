import { sameRemotePath } from '../paths.js';
import type { DownloadItem, DownloadItemLive, DownloadItemPhase, DownloadItemStatus } from '../types.js';
import type { QbtPreferences, QbtTorrent } from './schemas.js';

/** qBittorrent reports this ETA (100 days) when it has no estimate. */
const ETA_UNKNOWN = 8_640_000;
const ONE_YEAR_SECONDS = 365 * 24 * 3600;
/** Float slack when comparing ratios: qBittorrent stops at e.g. 0.99951. */
const RATIO_EPSILON = 0.001;
/** Per-torrent limit sentinel: defer to the global preference. */
const USE_GLOBAL = -2;

/** Download finished; torrent is stopped. 4.x says "paused", 5.x says "stopped". */
const STOPPED_UPLOAD_STATES = new Set(['pausedUP', 'stoppedUP']);
/** Download finished; torrent is (or wants to be) seeding. */
const ACTIVE_UPLOAD_STATES = new Set(['uploading', 'stalledUP', 'forcedUP', 'queuedUP']);

export function isStoppedUpload(state: string): boolean {
  return STOPPED_UPLOAD_STATES.has(state);
}

export function isFinishedState(state: string): boolean {
  return STOPPED_UPLOAD_STATES.has(state) || ACTIVE_UPLOAD_STATES.has(state);
}

interface StateMapping {
  status: DownloadItemStatus;
  message?: string;
}

/** Maps a raw qBittorrent state to a normalized status, before seed-limit adjustments. */
export function mapQbtState(state: string, dhtEnabled: boolean): StateMapping {
  switch (state) {
    case 'downloading':
    case 'forcedDL':
      return { status: 'downloading' };
    case 'moving':
      // Files are being relocated; not safe to import until it settles.
      return { status: 'downloading', message: 'qBittorrent is moving the files' };
    case 'pausedDL':
    case 'stoppedDL':
      return { status: 'paused' };
    case 'queuedDL':
    case 'checkingDL':
    case 'checkingResumeData':
      return { status: 'queued' };
    case 'checkingUP':
      // A post-completion recheck may still fail; do not report completed yet.
      return { status: 'queued', message: 'qBittorrent is checking the downloaded data' };
    case 'metaDL':
    case 'forcedMetaDL':
      return dhtEnabled
        ? { status: 'queued', message: 'Downloading metadata' }
        : { status: 'warning', message: 'Waiting for metadata, but DHT is disabled in qBittorrent' };
    case 'stalledDL':
      return { status: 'warning', message: 'Download stalled: no connections to peers' };
    case 'missingFiles':
      return { status: 'warning', message: 'qBittorrent reports missing files' };
    case 'error':
      // Warning rather than failed: an I/O error is often transient and must not trigger
      // failed-download handling (blocklisting the release).
      return { status: 'warning', message: 'qBittorrent reported an error for this torrent' };
    case 'uploading':
    case 'stalledUP':
    case 'forcedUP':
    case 'queuedUP':
      return { status: 'seeding' };
    case 'pausedUP':
    case 'stoppedUP':
      return { status: 'completed' };
    default:
      return { status: 'downloading', message: `Unknown qBittorrent state "${state}"` };
  }
}

export interface SeedLimits {
  ratio?: number;
  /** Minutes. */
  seedingTime?: number;
  /** Minutes. */
  inactiveSeedingTime?: number;
}

function resolveLimit(perTorrent: number | undefined, globalEnabled: boolean, globalValue: number | undefined): number | undefined {
  const value = perTorrent ?? USE_GLOBAL;
  if (value >= 0) return value;
  if (value === USE_GLOBAL && globalEnabled && globalValue !== undefined && globalValue >= 0) return globalValue;
  return undefined;
}

function globalRatioEnabled(prefs: QbtPreferences): boolean {
  return prefs.max_ratio_enabled ?? (prefs.max_ratio !== undefined && prefs.max_ratio >= 0);
}

function globalSeedingTimeEnabled(prefs: QbtPreferences): boolean {
  return prefs.max_seeding_time_enabled ?? (prefs.max_seeding_time !== undefined && prefs.max_seeding_time >= 0);
}

function globalInactiveTimeEnabled(prefs: QbtPreferences): boolean {
  return (
    prefs.max_inactive_seeding_time_enabled ??
    (prefs.max_inactive_seeding_time !== undefined && prefs.max_inactive_seeding_time >= 0)
  );
}

/** The seeding limits that actually apply to a torrent, per-torrent overriding global. */
export function effectiveSeedLimits(torrent: QbtTorrent, prefs: QbtPreferences): SeedLimits {
  const limits: SeedLimits = {};
  const ratio = resolveLimit(torrent.ratio_limit, globalRatioEnabled(prefs), prefs.max_ratio);
  if (ratio !== undefined) limits.ratio = ratio;
  const time = resolveLimit(torrent.seeding_time_limit, globalSeedingTimeEnabled(prefs), prefs.max_seeding_time);
  if (time !== undefined) limits.seedingTime = time;
  const inactive = resolveLimit(
    torrent.inactive_seeding_time_limit,
    globalInactiveTimeEnabled(prefs),
    prefs.max_inactive_seeding_time,
  );
  if (inactive !== undefined) limits.inactiveSeedingTime = inactive;
  return limits;
}

export function hasAnySeedLimit(limits: SeedLimits): boolean {
  return limits.ratio !== undefined || limits.seedingTime !== undefined || limits.inactiveSeedingTime !== undefined;
}

/** Extra per-torrent facts that torrents/info may not carry, fetched from torrents/properties. */
export interface TorrentExtras {
  /** Seconds spent seeding. */
  seedingTimeSeconds?: number;
  isPrivate?: boolean;
}

/**
 * Whether `torrents/properties` must be consulted to decide removability: a seeding-time
 * limit applies but torrents/info did not report seeding time, or the torrent is stopped
 * with no limits at all and we cannot tell whether it is private.
 */
export function needsProperties(torrent: QbtTorrent, prefs: QbtPreferences): boolean {
  if (!isFinishedState(torrent.state)) return false;
  const limits = effectiveSeedLimits(torrent, prefs);
  if (limits.seedingTime !== undefined && torrent.seeding_time === undefined) return true;
  if (isStoppedUpload(torrent.state) && !hasAnySeedLimit(limits) && torrent.private === undefined) return true;
  return false;
}

export function hasReachedSeedLimit(
  torrent: QbtTorrent,
  limits: SeedLimits,
  nowMs: number,
  extras: TorrentExtras = {},
): boolean {
  if (limits.ratio !== undefined && limits.ratio - torrent.ratio <= RATIO_EPSILON) return true;

  const seedingTime = torrent.seeding_time ?? extras.seedingTimeSeconds;
  if (limits.seedingTime !== undefined && seedingTime !== undefined && seedingTime >= limits.seedingTime * 60) {
    return true;
  }

  if (limits.inactiveSeedingTime !== undefined && torrent.last_activity !== undefined) {
    const idleSeconds = Math.floor(nowMs / 1000) - torrent.last_activity;
    if (idleSeconds > limits.inactiveSeedingTime * 60) return true;
  }
  return false;
}

function etaSeconds(eta: number): number | undefined {
  if (eta < 0 || eta > ONE_YEAR_SECONDS || eta === ETA_UNKNOWN) return undefined;
  return Math.floor(eta);
}

export interface MapContext {
  prefs: QbtPreferences;
  nowMs: number;
  extras?: TorrentExtras;
  /** Output path derived from the file list when torrents/info lacks content_path. */
  fallbackOutputPath?: string;
}

/**
 * Converts a torrents/info entry into a normalized `DownloadItem`.
 *
 * Removal rules:
 * - Seed ratio/time limit reached → `completed`, movable and removable, even if qBittorrent
 *   keeps it active (e.g. super-seeding action).
 * - Finished but limits not met → read-only: the importer must copy/hardlink.
 * - Stopped with no limits configured: a public torrent the user stopped is removable; a
 *   private torrent (or one whose privacy is unknown) stays read-only, since the tracker's
 *   seeding requirements are not visible to us.
 */
export function mapTorrent(torrent: QbtTorrent, context: MapContext): DownloadItem {
  const { prefs, nowMs, extras = {} } = context;
  const mapped = mapQbtState(torrent.state, prefs.dht ?? true);
  let status = mapped.status;
  let message = mapped.message;

  const totalBytes = Math.max(0, Math.round(torrent.size));
  const progress = Math.min(1, Math.max(0, torrent.progress));
  const remainingBytes = Math.max(
    0,
    Math.min(totalBytes, Math.round(torrent.amount_left ?? totalBytes * (1 - progress))),
  );

  const finished = isFinishedState(torrent.state);
  let limitReached = false;
  let removable = false;
  if (finished) {
    const limits = effectiveSeedLimits(torrent, prefs);
    limitReached = hasReachedSeedLimit(torrent, limits, nowMs, extras);
    const isPrivate = torrent.private ?? extras.isPrivate;
    const stoppedWithoutObligation =
      isStoppedUpload(torrent.state) && !hasAnySeedLimit(limits) && isPrivate === false;
    removable = limitReached || stoppedWithoutObligation;
    if (limitReached) status = 'completed';
  }

  const outputPath = torrent.content_path ?? context.fallbackOutputPath ?? torrent.save_path;
  if (finished && torrent.content_path !== undefined && sameRemotePath(torrent.content_path, torrent.save_path)) {
    // Content sits directly in the shared save folder (e.g. "Don't create subfolder"
    // layout with a multi-file torrent): importing would sweep up unrelated downloads.
    status = 'warning';
    message = 'Content path equals the save path; set qBittorrent to create a subfolder for multi-file torrents';
    removable = false;
  }

  const item: DownloadItem = {
    id: torrent.hash.toLowerCase(),
    title: torrent.name,
    category: torrent.category ?? '',
    totalBytes,
    remainingBytes,
    downloadedBytes: totalBytes - remainingBytes,
    progress,
    status,
    outputPath,
    isReadOnly: finished && !removable,
    canMoveFiles: removable,
    canBeRemoved: removable,
  };
  if (message !== undefined) item.statusMessage = message;
  const live = qbtLive(torrent);
  if (live) item.live = live;
  const phase = QBT_PHASES[torrent.state];
  if (phase !== undefined) item.phase = phase;
  const eta = finished ? 0 : etaSeconds(torrent.eta);
  if (eta !== undefined) item.etaSeconds = eta;
  return item;
}

const QBT_PHASES: Readonly<Record<string, DownloadItemPhase>> = {
  metaDL: 'metadata',
  forcedMetaDL: 'metadata',
  checkingDL: 'checking',
  checkingUP: 'checking',
  checkingResumeData: 'checking',
  moving: 'moving',
  stalledDL: 'stalled',
};

/** Rates and peer counts from torrents/info; undefined when this qBittorrent reports no rates. */
export function qbtLive(torrent: QbtTorrent): DownloadItemLive | undefined {
  if (torrent.dlspeed === undefined && torrent.upspeed === undefined) return undefined;
  const live: DownloadItemLive = { downloadRate: torrent.dlspeed ?? 0, uploadRate: torrent.upspeed ?? 0, ratio: torrent.ratio };
  if (torrent.num_seeds !== undefined) {
    live.connectedSeeds = torrent.num_seeds;
    live.connectedPeers = torrent.num_seeds + (torrent.num_leechs ?? 0);
  }
  if (torrent.num_complete !== undefined) live.swarmSeeds = torrent.num_complete;
  if (torrent.num_incomplete !== undefined) live.swarmLeechers = torrent.num_incomplete;
  // qBittorrent reports "no limit" as 0 or -1.
  if (torrent.dl_limit !== undefined) live.downloadLimit = Math.max(0, torrent.dl_limit);
  if (torrent.up_limit !== undefined) live.uploadLimit = Math.max(0, torrent.up_limit);
  // `priority` is the queue position; 0 or -1 when queueing is off or the torrent is not queued.
  if (torrent.priority !== undefined && torrent.priority > 0) live.queuePosition = torrent.priority;
  if (torrent.force_start !== undefined) live.forceStart = torrent.force_start;
  return live;
}

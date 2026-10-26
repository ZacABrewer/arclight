import { formatBytes, type StallRecoveryInfo } from './state-reason.js';

// Self-healing downloads, the decisions only (the service carries them out):
//
// * Stall recovery. A download that stops receiving data is first re-announced (fresh peers
//   from the trackers and the DHT). If it is still stalled `replaceAfterMs` after it was
//   flagged, Arclight gives up on the release: removes it with its data, blocklists it and
//   searches for another one. Downloads past `replaceMaxProgress` are only re-announced.
// * Disk-space guard. A grab that would leave its download volume below the minimum free
//   space is held back as a pending queue item and sent when there is room; downloads on a
//   volume that fell below the minimum are paused and resumed once it has the minimum plus
//   a margin free again (the margin keeps them from flapping around the threshold).

/** Free space above the minimum a volume needs before guard-paused downloads resume. */
export const DISK_RESUME_MARGIN_BYTES = 1024 ** 3;

export interface RecoverySettings {
  /** Master switch of stall recovery (re-announce and replace). */
  stallRecovery: boolean;
  /** Time stalled (after being flagged) before the release is replaced; 0 never replaces. */
  replaceAfterMs: number;
  /** 0..1: downloads at or above this progress are never replaced. */
  replaceMaxProgress: number;
  /** Master switch of the disk-space guard (held grabs and paused downloads). */
  diskGuard: boolean;
}

export const DEFAULT_RECOVERY_SETTINGS: RecoverySettings = {
  stallRecovery: true,
  replaceAfterMs: 30 * 60_000,
  replaceMaxProgress: 0.9,
  diskGuard: true,
};

export interface StalledDownload {
  /** ISO-8601: when data stopped arriving. */
  stalledSince: string;
  /** ISO-8601: when fresh peers were last asked for during this stall, if they were. */
  reannouncedAt: string | null;
  progress: number;
}

export interface StallPlan {
  /** Step 1 is due: ask the client for fresh peers. */
  reannounce: boolean;
  /** Step 2 is due: replace the release (the caller still checks lockdown, pauses, ...). */
  replace: boolean;
  /** What the state reason says about it. */
  info: StallRecoveryInfo;
  /** Minutes without data so far (for the blocklist reason). */
  stalledMinutes: number;
}

/**
 * Where a stalled download stands on the escalation ladder. `stallMs` is the stall threshold:
 * the download was flagged `stallMs` after `stalledSince`, and the replacement clock starts
 * then. Null when recovery is off.
 */
export function planStallRecovery(
  d: StalledDownload,
  settings: RecoverySettings,
  now: Date,
  stallMs: number,
): StallPlan | null {
  if (!settings.stallRecovery) return null;
  const nowMs = now.getTime();
  const stalledAt = Date.parse(d.stalledSince);
  const stalledMinutes = Math.max(0, Math.round((nowMs - stalledAt) / 60_000));
  const info: StallRecoveryInfo = {};
  if (d.reannouncedAt) info.reannouncedMinutesAgo = Math.max(0, Math.floor((nowMs - Date.parse(d.reannouncedAt)) / 60_000));
  let replace = false;
  if (settings.replaceAfterMs > 0) {
    const maxPercent = Math.round(settings.replaceMaxProgress * 100);
    if (d.progress >= settings.replaceMaxProgress) {
      info.keptAtProgress = maxPercent;
    } else {
      const dueAt = stalledAt + Math.max(0, stallMs) + settings.replaceAfterMs;
      replace = nowMs >= dueAt;
      info.replaceInMinutes = Math.max(0, Math.ceil((dueAt - nowMs) / 60_000));
    }
  }
  return { reannounce: d.reannouncedAt === null, replace, info, stalledMinutes };
}

/** Blocklist / timeline reason of an automatic replacement. */
export function stallReplaceReason(minutes: number): string {
  return `stalled: no data for ${minutes} min`;
}

export type DiskGuardAction = 'pause' | 'resume' | 'none';

/**
 * What the guard does to a download folder's downloads: pause below the minimum, resume at
 * the minimum plus the margin (or as soon as the guard is switched off), nothing in between.
 */
export function diskGuardAction(free: number | null, minimumBytes: number, enabled: boolean): DiskGuardAction {
  if (!enabled) return 'resume';
  if (free === null) return 'none';
  if (free < minimumBytes) return 'pause';
  if (free >= minimumBytes + DISK_RESUME_MARGIN_BYTES) return 'resume';
  return 'none';
}

/**
 * Why a grab of `sizeBytes` must wait, or null when it fits: `free` on the target folder minus
 * what downloads already there still need (`committed`) minus the release must stay at or
 * above the minimum.
 */
export function grabHoldReason(input: {
  sizeBytes: number;
  free: number;
  committed: number;
  minimumBytes: number;
  dir: string;
}): string | null {
  const available = input.free - input.committed;
  if (available - input.sizeBytes >= input.minimumBytes) return null;
  const where = `in ${input.dir}`;
  const committed = input.committed > 0 ? ` (after the ${formatBytes(input.committed)} other downloads there still need)` : '';
  if (available < input.sizeBytes) {
    return `Held: the release needs ${formatBytes(input.sizeBytes)} but only ${formatBytes(Math.max(0, available))} is free ${where}${committed}. It is sent automatically when there is room.`;
  }
  return `Held: grabbing it would leave ${formatBytes(available - input.sizeBytes)} free ${where}${committed}, below the ${formatBytes(input.minimumBytes)} minimum. It is sent automatically when there is room.`;
}

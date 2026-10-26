import { inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { DownloadAlertInfo, HealthCheck, NotificationEvent } from '@arclight/notifications';
import type { DownloadEvent, ServerEvent } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { trackedDownloads } from '../../db/schema.js';

// Download problems as notifications. Reads the bus: timeline entries (`download` events), the
// built-in engine's kill switch (`torrent` events) and health results (`health` events), and
// turns them into the download alert events. Stateful (one lockdown at a time, last disk-space
// level per check), so one instance per app.
//
// Timeline entry types without a dedicated trigger and not in IGNORED (recovered, and whatever
// the self-healing code adds later) become generic `downloadUpdate` alerts carrying the entry's
// own message, so new entry types are delivered without changes here.

/** Health checks about free space; their warning/error transitions are `diskSpaceLow` alerts. */
export const DISK_SPACE_CHECKS: ReadonlySet<string> = new Set(['DownloadDiskSpace', 'RootFolderFreeSpace', 'ConfigDiskSpace']);

/** A lockdown lasting this long is reported again, as urgent, to connections in quiet hours. */
export const KILL_SWITCH_URGENT_MS = 30 * 60_000;

/** Routine timeline entries (other triggers cover grabs and imports; pauses come via `torrent`). */
const IGNORED: ReadonlySet<string> = new Set([
  'pending',
  'grabbed',
  'metadataReceived',
  'started',
  'paused',
  'resumed',
  'completed',
  'importStarted',
  'imported',
  'removed',
]);

const MAX_TITLES = 10;

const LEVEL: Record<HealthCheck['status'], number> = { ok: 0, warning: 1, error: 2 };

export interface DownloadAlertsOptions {
  db: Db;
  log?: Logger;
  now?: () => Date;
  instanceName?: string;
  applicationUrl?: string;
}

interface Lockdown {
  since: Date;
  reason?: string;
  pausedCount: number;
  titles: string[];
  /** The opening alert was raised (it is skipped when nothing was paused). */
  alerted: boolean;
  reminded: boolean;
}

export class DownloadAlerts {
  private readonly db: Db;
  private readonly log: Logger | undefined;
  private readonly now: () => Date;
  private readonly instanceName: string;
  private readonly applicationUrl: string | undefined;
  private lockdown: Lockdown | null = null;
  /** Worst level per disk-space check as of the last health event. */
  private diskLevels = new Map<string, number>();

  constructor(options: DownloadAlertsOptions) {
    this.db = options.db;
    this.log = options.log;
    this.now = options.now ?? (() => new Date());
    this.instanceName = options.instanceName ?? 'Arclight';
    this.applicationUrl = options.applicationUrl;
  }

  translate(event: ServerEvent): NotificationEvent[] {
    switch (event.type) {
      case 'download':
        return this.timeline(event.event);
      case 'torrent':
        return event.action === 'lockdown' ? this.locked(event.infoHashes, event.reason) : this.unlocked(event.infoHashes);
      case 'health':
        return this.health(event.health.checks);
      default:
        return [];
    }
  }

  /** Periodic check (AlertsTick): a lockdown past KILL_SWITCH_URGENT_MS yields one urgent reminder. */
  tick(): NotificationEvent[] {
    const l = this.lockdown;
    if (!l || !l.alerted || l.reminded) return [];
    const elapsed = this.now().getTime() - l.since.getTime();
    if (elapsed < KILL_SWITCH_URGENT_MS) return [];
    l.reminded = true;
    return [{ ...this.killSwitchEvent(l), pausedMinutes: Math.floor(elapsed / 60_000), urgent: true }];
  }

  // ---- timeline ----------------------------------------------------------------------------

  private timeline(entry: DownloadEvent): NotificationEvent[] {
    const download: DownloadAlertInfo = { trackedDownloadId: entry.trackedDownloadId, downloadId: entry.downloadId, title: entry.title };
    const message = entry.message !== undefined ? { message: entry.message } : {};
    // Widened: entry types added after this file was written still arrive here.
    const type: string = entry.type;
    if (IGNORED.has(type)) return [];
    switch (type) {
      case 'stalled':
        return [{ ...this.base(), type: 'downloadStalled', download, ...message }];
      case 'importFailed':
      case 'importBlocked':
        return [{ ...this.base(), type: 'importProblem', problem: type === 'importFailed' ? 'failed' : 'blocked', download, ...message }];
      default:
        return [{ ...this.base(), type: 'downloadUpdate', download, timelineType: type, severity: entry.severity, ...message }];
    }
  }

  // ---- kill switch -------------------------------------------------------------------------

  private locked(infoHashes: readonly string[], reason: string | undefined): NotificationEvent[] {
    // One alert per lockdown: torrents paused later in the same lockdown join it silently.
    if (this.lockdown) return [];
    const titles = this.titlesFor(infoHashes);
    const lockdown: Lockdown = {
      since: this.now(),
      ...(reason !== undefined && reason.trim() !== '' ? { reason: reason.trim() } : {}),
      pausedCount: infoHashes.length,
      titles,
      alerted: infoHashes.length > 0,
      reminded: false,
    };
    this.lockdown = lockdown;
    return lockdown.alerted ? [this.killSwitchEvent(lockdown)] : [];
  }

  private unlocked(infoHashes: readonly string[]): NotificationEvent[] {
    const l = this.lockdown;
    this.lockdown = null;
    if (!l || !l.alerted) return [];
    return [
      {
        ...this.base(),
        type: 'killSwitchResumed',
        ...(l.reason !== undefined ? { reason: l.reason } : {}),
        resumedCount: infoHashes.length,
        durationMs: Math.max(0, this.now().getTime() - l.since.getTime()),
      },
    ];
  }

  private killSwitchEvent(l: Lockdown): Extract<NotificationEvent, { type: 'killSwitch' }> {
    return {
      ...this.base(),
      type: 'killSwitch',
      ...(l.reason !== undefined ? { reason: l.reason } : {}),
      since: l.since.toISOString(),
      pausedCount: l.pausedCount,
      titles: l.titles,
    };
  }

  private titlesFor(infoHashes: readonly string[]): string[] {
    if (infoHashes.length === 0) return [];
    try {
      const rows = this.db
        .select({ downloadId: trackedDownloads.downloadId, title: trackedDownloads.title })
        .from(trackedDownloads)
        .where(inArray(trackedDownloads.downloadId, infoHashes.slice(0, 500)))
        .all();
      const byHash = new Map(rows.map((r) => [r.downloadId.toLowerCase(), r.title]));
      return infoHashes.flatMap((h) => byHash.get(h.toLowerCase()) ?? []).slice(0, MAX_TITLES);
    } catch (err) {
      this.log?.warn({ err }, 'could not look up paused download titles');
      return [];
    }
  }

  // ---- disk space --------------------------------------------------------------------------

  private health(checks: readonly HealthCheck[]): NotificationEvent[] {
    const worst = new Map<string, HealthCheck>();
    for (const c of checks) {
      if (!DISK_SPACE_CHECKS.has(c.source) || c.status === 'ok') continue;
      const prev = worst.get(c.source);
      if (!prev || LEVEL[c.status] > LEVEL[prev.status]) worst.set(c.source, c);
    }
    const out: NotificationEvent[] = [];
    const levels = new Map<string, number>();
    for (const [source, check] of worst) {
      const level = LEVEL[check.status];
      levels.set(source, level);
      // Once per transition into warning or error (and warning -> error), not on every run.
      if (level > (this.diskLevels.get(source) ?? 0)) {
        out.push({ ...this.base(), type: 'diskSpaceLow', health: check, ...(check.status === 'error' ? { urgent: true } : {}) });
      }
    }
    this.diskLevels = levels;
    return out;
  }

  private base() {
    return {
      instanceName: this.instanceName,
      timestamp: this.now().toISOString(),
      ...(this.applicationUrl ? { applicationUrl: this.applicationUrl } : {}),
    };
  }
}

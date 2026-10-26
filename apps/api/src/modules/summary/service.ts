import { and, asc, desc, eq, gte, isNull, lt, lte, or } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { DailySummaryEvent } from '@arclight/notifications';
import type {
  AlertSettings,
  AlertSettingsResponse,
  DailySummary,
  DailySummaryDisk,
  DailySummaryProblem,
  DailySummarySettings,
  HealthCheck,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { dailySummaries, downloadEvents, killSwitchLockdowns, trackedDownloads } from '../../db/schema.js';
import type { EventBus } from '../../events.js';
import { getSection, setSection } from '../settings/service.js';
import type { DailySummaryRow } from './schema.js';

// The daily summary: what happened to downloads in the last 24 hours (from the download
// timeline), how long the kill switch held them, disk free per volume against the previous
// summary, open health issues and what is still downloading. Stored for SUMMARY_RETENTION_DAYS
// and sent through the `onDailySummary` trigger by the DailySummary job.

export const SUMMARY_RETENTION_DAYS = 30;
const PERIOD_MS = 86_400_000;
const MAX_LIST = 10;

/** Timeline entry types counted as problems in the summary list. */
const PROBLEM_TYPES: ReadonlySet<string> = new Set(['importFailed', 'importBlocked', 'error', 'stalled']);

/** Replacement entries come from the self-healing code; matched by name so new types count. */
const isReplacement = (type: string) => /replac/i.test(type);

export interface SummaryVolume {
  path: string;
  kind: DailySummaryDisk['kind'];
}

export interface SummaryServiceOptions {
  db: Db;
  log?: Logger;
  bus?: EventBus;
  now?: () => Date;
  instanceName?: string;
  /** Root folders and download folders to report free space for. */
  volumes: () => Promise<SummaryVolume[]>;
  freeSpace: (path: string) => Promise<number | null>;
  /** Current non-ok health checks. */
  healthIssues: () => Promise<HealthCheck[]>;
  /** Sends the summary through the notification connections. */
  notify?: (event: DailySummaryEvent) => Promise<void>;
  /** Alerts held for quiet hours and whether they are in effect (GET /settings/alerts). */
  quietState?: () => { heldAlerts: number; quietNow: boolean };
  /** Called after the alert settings were saved (reschedules the job). */
  settingsChanged?: (settings: AlertSettings) => void;
}

/** Cron for the DailySummary job, or null when the summary is off. */
export function summaryCron(settings: DailySummarySettings): string | null {
  if (!settings.enabled) return null;
  const [h, m] = settings.time.split(':').map(Number);
  return `${m ?? 0} ${h ?? 8} * * *`;
}

export class SummaryService {
  private readonly db: Db;
  private readonly now: () => Date;

  constructor(private readonly opts: SummaryServiceOptions) {
    this.db = opts.db;
    this.now = opts.now ?? (() => new Date());
  }

  // ---- settings ----------------------------------------------------------------------------

  settings(): AlertSettingsResponse {
    const state = this.opts.quietState?.() ?? { heldAlerts: 0, quietNow: false };
    return { ...getSection(this.db, 'alerts'), ...state };
  }

  saveSettings(value: AlertSettings): AlertSettingsResponse {
    const saved = setSection(this.db, 'alerts', value, this.now().toISOString());
    this.opts.settingsChanged?.(saved);
    this.opts.bus?.publish({ type: 'settings', section: 'alerts' });
    return this.settings();
  }

  // ---- kill switch lockdowns -----------------------------------------------------------------

  /** Bus `torrent` events: open a lockdown row, or close the open one. */
  recordLockdown(action: 'lockdown' | 'unlocked', reason: string | undefined, pausedCount: number): void {
    const nowIso = this.now().toISOString();
    const open = isNull(killSwitchLockdowns.endedAt);
    if (action === 'unlocked') {
      this.db.update(killSwitchLockdowns).set({ endedAt: nowIso }).where(open).run();
      return;
    }
    // Still locked (a second lockdown event): keep the first row.
    if (this.db.select({ id: killSwitchLockdowns.id }).from(killSwitchLockdowns).where(open).get()) return;
    this.db
      .insert(killSwitchLockdowns)
      .values({ startedAt: nowIso, endedAt: null, reason: reason ?? null, pausedCount })
      .run();
  }

  // ---- summaries -----------------------------------------------------------------------------

  latest(): DailySummary | null {
    const row = this.db.select().from(dailySummaries).orderBy(desc(dailySummaries.generatedAt), desc(dailySummaries.id)).get();
    return row ? toSummary(row) : null;
  }

  list(limit: number): DailySummary[] {
    return this.db
      .select()
      .from(dailySummaries)
      .orderBy(desc(dailySummaries.generatedAt), desc(dailySummaries.id))
      .limit(limit)
      .all()
      .map(toSummary);
  }

  /** Build, store and (with `notify`) send a summary of the 24 hours up to now. */
  async generate(options: { notify?: boolean } = {}): Promise<DailySummary> {
    const end = this.now();
    const start = new Date(end.getTime() - PERIOD_MS);
    const startIso = start.toISOString();
    const endIso = end.toISOString();
    const previous = this.latest();

    const entries = this.db
      .select()
      .from(downloadEvents)
      .where(and(gte(downloadEvents.time, startIso), lte(downloadEvents.time, endIso)))
      .orderBy(asc(downloadEvents.time), asc(downloadEvents.id))
      .all();
    // Widened: entry types added after this file was written are counted too.
    const typeOf = (e: (typeof entries)[number]): string => e.type;
    const countOf = (pred: (type: string) => boolean) => entries.filter((e) => pred(typeOf(e))).length;
    const counts = {
      grabbed: countOf((t) => t === 'grabbed'),
      imported: countOf((t) => t === 'imported'),
      failed: countOf((t) => t === 'importFailed' || t === 'error'),
      stalled: countOf((t) => t === 'stalled'),
      recovered: countOf((t) => t === 'recovered'),
      replaced: countOf(isReplacement),
    };
    const problems: DailySummaryProblem[] = entries
      .filter((e) => PROBLEM_TYPES.has(typeOf(e)) || isReplacement(typeOf(e)))
      .reverse()
      .slice(0, MAX_LIST)
      .map((e) => ({ title: e.title, type: e.type, time: e.time, ...(e.message ? { message: e.message } : {}) }));

    const body = {
      counts,
      killSwitch: this.killSwitchTotals(start, end),
      disk: await this.disk(previous),
      problems,
      healthIssues: await this.safe(() => this.opts.healthIssues(), [] as HealthCheck[]),
      downloading: this.downloading(),
    };
    const row = this.db
      .insert(dailySummaries)
      .values({ generatedAt: endIso, periodStart: startIso, periodEnd: endIso, data: body })
      .returning()
      .get();
    this.prune();
    const summary = toSummary(row);
    this.opts.bus?.publish({ type: 'summary', action: 'generated', id: summary.id });
    if (options.notify && this.opts.notify) {
      await this.opts
        .notify({ type: 'dailySummary', instanceName: this.opts.instanceName ?? 'Arclight', timestamp: endIso, summary })
        .catch((err: unknown) => this.opts.log?.warn({ err }, 'daily summary notification failed'));
    }
    return summary;
  }

  /** Deletes summaries and closed lockdowns older than the retention. Returns the count. */
  prune(): number {
    const cutoff = new Date(this.now().getTime() - SUMMARY_RETENTION_DAYS * PERIOD_MS).toISOString();
    const summaries = this.db.delete(dailySummaries).where(lt(dailySummaries.generatedAt, cutoff)).run().changes;
    const lockdowns = this.db
      .delete(killSwitchLockdowns)
      .where(and(lt(killSwitchLockdowns.startedAt, cutoff), lt(killSwitchLockdowns.endedAt, cutoff)))
      .run().changes;
    return summaries + lockdowns;
  }

  // ---- parts ---------------------------------------------------------------------------------

  private killSwitchTotals(start: Date, end: Date): DailySummary['killSwitch'] {
    const startIso = start.toISOString();
    const rows = this.db
      .select()
      .from(killSwitchLockdowns)
      .where(
        and(lte(killSwitchLockdowns.startedAt, end.toISOString()), or(isNull(killSwitchLockdowns.endedAt), gte(killSwitchLockdowns.endedAt, startIso))),
      )
      .all();
    let totalMs = 0;
    for (const r of rows) {
      const from = Math.max(Date.parse(r.startedAt), start.getTime());
      const to = Math.min(r.endedAt ? Date.parse(r.endedAt) : end.getTime(), end.getTime());
      totalMs += Math.max(0, to - from);
    }
    return { pauses: rows.length, totalMs };
  }

  private async disk(previous: DailySummary | null): Promise<DailySummaryDisk[]> {
    const volumes = await this.safe(() => this.opts.volumes(), [] as SummaryVolume[]);
    const before = new Map((previous?.disk ?? []).map((d) => [`${d.kind}:${d.path}`, d.freeBytes]));
    const seen = new Set<string>();
    const out: DailySummaryDisk[] = [];
    for (const v of volumes) {
      const key = `${v.kind}:${v.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const free = await this.safe(() => this.opts.freeSpace(v.path), null);
      const prev = before.get(key);
      out.push({
        path: v.path,
        kind: v.kind,
        freeBytes: free,
        changeBytes: free !== null && prev !== undefined && prev !== null ? free - prev : null,
      });
    }
    return out;
  }

  private downloading(): DailySummary['downloading'] {
    const rows = this.db
      .select({ id: trackedDownloads.id, title: trackedDownloads.title, progress: trackedDownloads.progress, stateCode: trackedDownloads.stateCode })
      .from(trackedDownloads)
      .where(eq(trackedDownloads.state, 'downloading'))
      .orderBy(desc(trackedDownloads.progress), asc(trackedDownloads.id))
      .all();
    return {
      count: rows.length,
      items: rows.slice(0, MAX_LIST).map((r) => ({
        id: r.id,
        title: r.title,
        progress: Math.min(1, Math.max(0, r.progress)),
        ...(r.stateCode ? { state: r.stateCode } : {}),
      })),
    };
  }

  private async safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      this.opts.log?.warn({ err }, 'daily summary: a source failed');
      return fallback;
    }
  }
}

function toSummary(row: DailySummaryRow): DailySummary {
  return { id: row.id, generatedAt: row.generatedAt, periodStart: row.periodStart, periodEnd: row.periodEnd, ...row.data };
}

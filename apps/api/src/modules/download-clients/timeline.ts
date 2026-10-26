import { and, asc, eq, gte, lt } from 'drizzle-orm';
import type { DownloadEvent, DownloadEventType, DownloadTimeline, QueueSeverity } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import type { EventBus } from '../../events.js';
import { downloadEvents, type DownloadEventRow } from './schema.js';

// Per-download timeline: what happened to a tracked download and when (grabbed, started,
// paused by the kill switch, stalled, imported, ...). Written by the download-clients service
// as it sees transitions; every entry is also published on the bus for live UIs.

/** Default severity per event type; `record` callers may override (e.g. a kill-switch pause). */
export const EVENT_SEVERITY: Readonly<Record<DownloadEventType, QueueSeverity>> = {
  pending: 'info',
  grabbed: 'info',
  metadataReceived: 'info',
  started: 'info',
  paused: 'info',
  resumed: 'info',
  stalled: 'warning',
  recovered: 'ok',
  completed: 'ok',
  importStarted: 'info',
  importBlocked: 'warning',
  imported: 'ok',
  importFailed: 'error',
  removed: 'info',
  error: 'error',
  reannounced: 'info',
  replaced: 'warning',
  held: 'warning',
};

/** Timeline entries are kept this long by default (DownloadEventsCleanup). */
export const DEFAULT_EVENT_RETENTION_DAYS = 30;

export interface TimelineSubject {
  id: number;
  downloadId: string;
  title: string;
}

export interface RecordOptions {
  message?: string | undefined;
  severity?: QueueSeverity | undefined;
  data?: Record<string, string | number | boolean> | undefined;
  /** ISO-8601; defaults to the store's clock. */
  time?: string | undefined;
}

export class DownloadTimelineStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date,
    private readonly bus?: EventBus | undefined,
  ) {}

  record(subject: TimelineSubject, type: DownloadEventType, options: RecordOptions = {}): DownloadEvent {
    const row = this.db
      .insert(downloadEvents)
      .values({
        trackedDownloadId: subject.id,
        downloadId: subject.downloadId,
        title: subject.title,
        type,
        severity: options.severity ?? EVENT_SEVERITY[type],
        message: options.message ?? null,
        data: options.data ?? null,
        time: options.time ?? this.now().toISOString(),
      })
      .returning()
      .get();
    const event = toEvent(row);
    this.bus?.publish({ type: 'download', action: 'event', event });
    return event;
  }

  /** Oldest first. */
  list(trackedDownloadId: number): DownloadTimeline {
    const rows = this.db
      .select()
      .from(downloadEvents)
      .where(eq(downloadEvents.trackedDownloadId, trackedDownloadId))
      .orderBy(asc(downloadEvents.time), asc(downloadEvents.id))
      .all();
    return { trackedDownloadId, events: rows.map(toEvent) };
  }

  /** Whether any entry exists for the tracked download (the route 404s otherwise). */
  has(trackedDownloadId: number): boolean {
    return (
      this.db
        .select({ id: downloadEvents.id })
        .from(downloadEvents)
        .where(eq(downloadEvents.trackedDownloadId, trackedDownloadId))
        .limit(1)
        .get() !== undefined
    );
  }

  /** Every entry of `type` since `sinceIso` (oldest first), across downloads. */
  since(sinceIso: string, type?: DownloadEventType): DownloadEvent[] {
    const after = gte(downloadEvents.time, sinceIso);
    return this.db
      .select()
      .from(downloadEvents)
      .where(type === undefined ? after : and(after, eq(downloadEvents.type, type)))
      .orderBy(asc(downloadEvents.time), asc(downloadEvents.id))
      .all()
      .map(toEvent);
  }

  /** Deletes entries older than `days` (0 keeps everything). Returns the count. */
  prune(days: number = DEFAULT_EVENT_RETENTION_DAYS): number {
    if (days <= 0) return 0;
    const cutoff = new Date(this.now().getTime() - days * 86_400_000).toISOString();
    return this.db.delete(downloadEvents).where(lt(downloadEvents.time, cutoff)).run().changes;
  }
}

function toEvent(row: DownloadEventRow): DownloadEvent {
  return {
    id: row.id,
    trackedDownloadId: row.trackedDownloadId,
    downloadId: row.downloadId,
    title: row.title,
    type: row.type,
    severity: row.severity,
    time: row.time,
    ...(row.message !== null ? { message: row.message } : {}),
    ...(row.data !== null ? { data: row.data } : {}),
  };
}

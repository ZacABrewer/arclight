import { and, count, desc, eq, gt, lt, notInArray } from 'drizzle-orm';
import {
  applyTemplate,
  formatEvent,
  NotificationError,
  redactSecrets,
  type MessageTemplates,
  type NotificationEvent,
} from '@arclight/notifications';
import type {
  NotificationDelivery,
  NotificationDeliveryState,
  NotificationDeliveryStatus,
  NotificationFilters,
} from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { notificationDeliveries, type NotificationDeliveryRow } from './schema.js';

// Delivery machinery shared by system connections and personal destinations: retries with
// backoff, per-destination rate limits, filters and the delivery log.

/** Rows kept per destination in the delivery log. */
export const DELIVERY_LOG_SIZE = 100;
/** Longest wait between two attempts. */
export const MAX_BACKOFF_MS = 60_000;

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Which destination a log row or rate-limit bucket belongs to. */
export type DeliveryTarget = { notificationId: number } | { destinationId: number };

// ---- retries ---------------------------------------------------------------------------

/** Failures worth trying again: the service may answer next time. Bad settings never will. */
export function isRetryable(err: unknown): boolean {
  if (!(err instanceof NotificationError)) return false;
  switch (err.code) {
    case 'network':
    case 'timeout':
    case 'rateLimited':
      return true;
    case 'remoteError':
      return err.status === undefined || err.status >= 500;
    default:
      return false;
  }
}

/** Wait before attempt `attempt + 1` (attempt counts from 1): 2 s, 4 s, 8 s... or 5 s, 10 s... after a 429. */
export function backoffMs(attempt: number, err: unknown): number {
  const base = err instanceof NotificationError && err.code === 'rateLimited' ? 5_000 : 2_000;
  return Math.min(MAX_BACKOFF_MS, base * 2 ** (attempt - 1));
}

export interface SendResult {
  ok: boolean;
  attempts: number;
  /** Redacted. */
  error?: string;
  code?: string;
  /** HTTP status of the last failure, when it came from one. */
  status?: number;
}

/**
 * `send` up to `maxAttempts` times, backing off between attempts while the failure is
 * retryable. The error is passed through `redact` before it leaves this function.
 */
export async function sendWithRetry(
  send: () => Promise<void>,
  opts: { maxAttempts: number; sleep: Sleep; redact: (text: string) => string },
): Promise<SendResult> {
  const max = Math.max(1, opts.maxAttempts);
  for (let attempt = 1; ; attempt++) {
    try {
      await send();
      return { ok: true, attempts: attempt };
    } catch (err) {
      if (attempt < max && isRetryable(err)) {
        await opts.sleep(backoffMs(attempt, err));
        continue;
      }
      return {
        ok: false,
        attempts: attempt,
        error: opts.redact(err instanceof Error ? err.message : String(err)),
        ...(err instanceof NotificationError ? { code: err.code, ...(err.status !== undefined ? { status: err.status } : {}) } : {}),
      };
    }
  }
}

// ---- rate limits -------------------------------------------------------------------------

/** Sliding one-minute window per destination, in memory. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  private window(key: string, now: number): number[] {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < 60_000);
    this.hits.set(key, recent);
    return recent;
  }

  /** Whether one more message fits under `limit` a minute; counts it when it does. 0 is unlimited. */
  take(key: string, limit: number, now: number): boolean {
    const recent = this.window(key, now);
    if (limit > 0 && recent.length >= limit) return false;
    recent.push(now);
    return true;
  }

  /** Count a message that went out regardless of the limit (urgent alerts, tests). */
  note(key: string, now: number): void {
    this.window(key, now).push(now);
  }

  /** Whether a message would fit right now, without counting it. */
  hasRoom(key: string, limit: number, now: number): boolean {
    return limit <= 0 || this.window(key, now).length < limit;
  }

  forget(key: string): void {
    this.hits.delete(key);
  }
}

export function targetKey(target: DeliveryTarget): string {
  return 'notificationId' in target ? `n:${target.notificationId}` : `p:${target.destinationId}`;
}

// ---- filters -----------------------------------------------------------------------------

/**
 * Media kind, quality and user filters. Empty lists do not filter; events without media,
 * without a quality or without a user pass the filters they cannot be judged by.
 */
export function passesFilters(filters: NotificationFilters | null | undefined, event: NotificationEvent): boolean {
  if (!filters || event.type === 'heldAlerts' || event.type === 'test') return true;
  const media = 'media' in event ? event.media : undefined;
  if (filters.mediaTypes.length > 0 && media && !filters.mediaTypes.includes(media.mediaType)) return false;
  if (filters.qualities.length > 0) {
    const quality = ('file' in event ? event.file?.quality : undefined) ?? ('release' in event ? event.release?.quality : undefined);
    if (quality !== undefined) {
      const wanted = new Set(filters.qualities.map((q) => q.toLowerCase()));
      if (!wanted.has(quality.toLowerCase())) return false;
    }
  }
  if (filters.users.length > 0) {
    const userId =
      ('request' in event ? event.request?.requestedBy.id : undefined) ?? ('issue' in event ? event.issue?.reportedBy.id : undefined);
    if (userId !== undefined && !filters.users.includes(userId)) return false;
  }
  return true;
}

// ---- delivery log ------------------------------------------------------------------------

export interface DeliveryEntry {
  event: NotificationEvent;
  templates?: MessageTemplates | undefined;
  state: NotificationDeliveryState;
  attempts?: number;
  error?: string | undefined;
  code?: string | undefined;
  test?: boolean;
}

function whereTarget(target: DeliveryTarget) {
  return 'notificationId' in target
    ? eq(notificationDeliveries.notificationId, target.notificationId)
    : eq(notificationDeliveries.destinationId, target.destinationId);
}

/** The headline a log row shows: the message title as the destination sends it. */
export function headlineOf(event: NotificationEvent, templates?: MessageTemplates): string {
  try {
    const formatted = applyTemplate(event, formatEvent(event), templates);
    return `${formatted.subject}: ${formatted.title}`.slice(0, 300);
  } catch {
    return event.type;
  }
}

export class DeliveryLog {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date,
  ) {}

  add(target: DeliveryTarget, entry: DeliveryEntry): void {
    try {
      this.db
        .insert(notificationDeliveries)
        .values({
          ...('notificationId' in target ? { notificationId: target.notificationId } : { destinationId: target.destinationId }),
          eventType: entry.event.type,
          title: headlineOf(entry.event, entry.templates),
          state: entry.state,
          attempts: entry.attempts ?? (entry.state === 'sent' || entry.state === 'failed' ? 1 : 0),
          error: entry.error ?? null,
          code: entry.code ?? null,
          test: entry.test ?? false,
          at: this.now().toISOString(),
        })
        .run();
      this.prune(target);
    } catch {
      // The log is diagnostics; a failed write (e.g. the destination was just deleted) never
      // turns a delivery into a failure.
    }
  }

  private prune(target: DeliveryTarget): void {
    const keep = this.db
      .select({ id: notificationDeliveries.id })
      .from(notificationDeliveries)
      .where(whereTarget(target))
      .orderBy(desc(notificationDeliveries.id))
      .limit(DELIVERY_LOG_SIZE)
      .all()
      .map((r) => r.id);
    if (keep.length < DELIVERY_LOG_SIZE) return;
    this.db
      .delete(notificationDeliveries)
      .where(and(whereTarget(target), notInArray(notificationDeliveries.id, keep)))
      .run();
  }

  list(target: DeliveryTarget, limit = DELIVERY_LOG_SIZE): NotificationDelivery[] {
    return this.db
      .select()
      .from(notificationDeliveries)
      .where(whereTarget(target))
      .orderBy(desc(notificationDeliveries.id))
      .limit(limit)
      .all()
      .map(toDelivery);
  }

  /** Failures since the last success, and when each last happened. */
  status(target: DeliveryTarget): NotificationDeliveryStatus {
    const lastSent = this.db
      .select()
      .from(notificationDeliveries)
      .where(and(whereTarget(target), eq(notificationDeliveries.state, 'sent')))
      .orderBy(desc(notificationDeliveries.id))
      .limit(1)
      .get();
    const lastFailed = this.db
      .select()
      .from(notificationDeliveries)
      .where(and(whereTarget(target), eq(notificationDeliveries.state, 'failed')))
      .orderBy(desc(notificationDeliveries.id))
      .limit(1)
      .get();
    const failures =
      this.db
        .select({ n: count() })
        .from(notificationDeliveries)
        .where(
          and(
            whereTarget(target),
            eq(notificationDeliveries.state, 'failed'),
            ...(lastSent ? [gt(notificationDeliveries.id, lastSent.id)] : []),
          ),
        )
        .get()?.n ?? 0;
    return {
      consecutiveFailures: failures,
      ...(lastFailed?.error ? { lastError: lastFailed.error } : {}),
      ...(lastFailed ? { lastFailureAt: lastFailed.at } : {}),
      ...(lastSent ? { lastSuccessAt: lastSent.at } : {}),
    };
  }

  /** Statuses for many system connections at once (the list endpoint). */
  statuses(notificationIds: number[]): Map<number, NotificationDeliveryStatus> {
    return new Map(notificationIds.map((id) => [id, this.status({ notificationId: id })]));
  }

  /** Drop rows older than `before` (housekeeping). */
  pruneOlderThan(before: Date): void {
    this.db.delete(notificationDeliveries).where(lt(notificationDeliveries.at, before.toISOString())).run();
  }

  /** Remove the log of destinations that no longer exist (deleted rows cascade; this is a safety net). */
  clear(target: DeliveryTarget): void {
    this.db.delete(notificationDeliveries).where(whereTarget(target)).run();
  }
}

function toDelivery(row: NotificationDeliveryRow): NotificationDelivery {
  return {
    id: row.id,
    eventType: row.eventType,
    title: row.title,
    state: row.state,
    attempts: row.attempts,
    ...(row.error ? { error: row.error } : {}),
    ...(row.code ? { code: row.code } : {}),
    test: row.test,
    at: row.at,
  };
}

/** `text` with the secrets of `settings` removed. */
export function redactorFor(settings: Record<string, unknown>): (text: string) => string {
  return (text) => redactSecrets(text, settings);
}

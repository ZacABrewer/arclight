import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';
import { maskSecrets } from '../config-export/secrets.js';
import { getSection } from '../settings/service.js';
import { auditEvents } from './schema.js';

// The write side of the audit log. One recorder per database, registered when the audit module
// (or installAudit) starts; `audit(db)` from anywhere returns it, or a no-op when auditing is not
// installed (tests of other modules, tools), so callers never need to care.

export interface AuditEntry {
  action: string;
  userId?: number | null;
  username?: string | null;
  ip?: string | null;
  target?: string | number | null;
  method?: string | null;
  route?: string | null;
  statusCode?: number | null;
  details?: Record<string, unknown> | null;
  /** Defaults to now. */
  time?: string;
}

export interface AuditSink {
  record(entry: AuditEntry): void;
}

/** Serialised details above this many characters are replaced by a summary. */
const MAX_DETAILS = 4096;

/** Secrets masked and size bounded, so the trail never stores a password or a megabyte body. */
export function sanitizeDetails(details: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!details) return null;
  const masked = maskSecrets(details);
  const json = JSON.stringify(masked);
  if (json.length <= MAX_DETAILS) return masked;
  const summary: Record<string, unknown> = { truncated: true, size: json.length };
  for (const [k, v] of Object.entries(masked)) {
    if (v === null || typeof v !== 'object') summary[k] = v;
    else summary[k] = Array.isArray(v) ? { items: v.length } : { keys: Object.keys(v).slice(0, 50) };
  }
  return summary;
}

export class AuditRecorder implements AuditSink {
  constructor(
    private readonly db: Db,
    private readonly log?: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(entry: AuditEntry): void {
    try {
      if (!getSection(this.db, 'audit').enabled) return;
      this.db
        .insert(auditEvents)
        .values({
          time: entry.time ?? this.now().toISOString(),
          userId: entry.userId ?? null,
          username: entry.username ?? null,
          ip: entry.ip ?? null,
          action: entry.action,
          target: entry.target === undefined || entry.target === null ? null : String(entry.target),
          method: entry.method ?? null,
          route: entry.route ?? null,
          statusCode: entry.statusCode ?? null,
          details: sanitizeDetails(entry.details),
        })
        .run();
    } catch (err) {
      // Auditing must never fail the action it records.
      this.log?.warn({ err, action: entry.action }, 'audit record failed');
    }
  }
}

const NOOP: AuditSink = { record: () => undefined };
const recorders = new WeakMap<object, AuditRecorder>();

export function registerAuditRecorder(db: Db, recorder: AuditRecorder): AuditRecorder {
  recorders.set(db, recorder);
  return recorder;
}

/** The recorder for a database, creating and registering it on first use. */
export function auditRecorderFor(db: Db, log?: Logger, now?: () => Date): AuditRecorder {
  return recorders.get(db) ?? registerAuditRecorder(db, new AuditRecorder(db, log, now));
}

/** Forget the recorder (tests). */
export function unregisterAuditRecorder(db: Db): void {
  recorders.delete(db);
}

function isContext(target: object): target is { db: Db } {
  return 'db' in target && typeof (target as { db?: unknown }).db === 'object';
}

/**
 * `audit(ctx).record({ action: 'login.failed', ... })` from any module or service (accepts the
 * AppContext, anything with a `db`, or the Db itself). A no-op until the audit module is
 * installed for that database.
 */
export function audit(target: Db | { db: Db }): AuditSink {
  const db: object = isContext(target) ? target.db : target;
  return recorders.get(db) ?? NOOP;
}

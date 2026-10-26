import { and, count, desc, eq, gte, lt, or, sql, type SQL } from 'drizzle-orm';
import type { AuditEvent, AuditPage, AuditQuery } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { getSection } from '../settings/service.js';
import { auditEvents, type AuditEventRow } from './schema.js';

// The read side of the audit log: filtered pages, CSV export and retention.

export type AuditFilter = Omit<AuditQuery, 'page' | 'pageSize'>;

function toEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    time: row.time,
    userId: row.userId,
    username: row.username,
    ip: row.ip,
    action: row.action,
    target: row.target,
    method: row.method,
    route: row.route,
    statusCode: row.statusCode,
    details: row.details ?? null,
  };
}

/** LIKE pattern for a literal prefix (escapes % and _). */
function prefixPattern(value: string): string {
  return `${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function where(f: AuditFilter): SQL | undefined {
  const parts: SQL[] = [];
  if (f.user) {
    const id = /^\d+$/.test(f.user) ? Number(f.user) : null;
    const byName = sql`lower(${auditEvents.username}) = ${f.user.toLowerCase()}`;
    parts.push(id !== null ? (or(eq(auditEvents.userId, id), byName) as SQL) : byName);
  }
  if (f.action) {
    parts.push(or(eq(auditEvents.action, f.action), sql`${auditEvents.action} LIKE ${prefixPattern(`${f.action}.`)} ESCAPE '\\'`) as SQL);
  }
  if (f.from) parts.push(gte(auditEvents.time, new Date(f.from).toISOString()));
  if (f.to) parts.push(lt(auditEvents.time, new Date(f.to).toISOString()));
  return parts.length ? and(...parts) : undefined;
}

export class AuditError extends Error {
  constructor(
    readonly code: 'VALIDATION',
    message: string,
  ) {
    super(message);
    this.name = 'AuditError';
  }
}

function checkDates(f: AuditFilter): void {
  for (const key of ['from', 'to'] as const) {
    const v = f[key];
    if (v !== undefined && Number.isNaN(Date.parse(v))) throw new AuditError('VALIDATION', `${key} is not a date`);
  }
}

const CSV_COLUMNS = ['time', 'username', 'userId', 'ip', 'action', 'target', 'method', 'route', 'statusCode', 'details'] as const;

/** RFC 4180 quoting, plus a leading quote on cells a spreadsheet would run as a formula. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export class AuditService {
  constructor(
    readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(q: AuditQuery): AuditPage {
    checkDates(q);
    const filter = where(q);
    const total = this.db.select({ n: count() }).from(auditEvents).where(filter).get()?.n ?? 0;
    const rows = this.db
      .select()
      .from(auditEvents)
      .where(filter)
      .orderBy(desc(auditEvents.time), desc(auditEvents.id))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize)
      .all();
    return { page: q.page, pageSize: q.pageSize, totalRecords: total, records: rows.map(toEvent) };
  }

  /** Every matching event as CSV (newest first), header row included. */
  csv(f: AuditFilter): string {
    checkDates(f);
    const rows = this.db.select().from(auditEvents).where(where(f)).orderBy(desc(auditEvents.time), desc(auditEvents.id)).all();
    const lines = [CSV_COLUMNS.join(',')];
    for (const row of rows.map(toEvent)) lines.push(CSV_COLUMNS.map((c) => csvCell(row[c])).join(','));
    return lines.join('\r\n') + '\r\n';
  }

  /** Delete events older than `audit.retentionDays` (0 keeps everything). Returns the count. */
  prune(): number {
    const days = getSection(this.db, 'audit').retentionDays;
    if (days <= 0) return 0;
    const cutoff = new Date(this.now().getTime() - days * 86_400_000).toISOString();
    return this.db.delete(auditEvents).where(lt(auditEvents.time, cutoff)).run().changes;
  }

  /** Distinct action names (for the UI's filter list). */
  actions(): string[] {
    return this.db
      .selectDistinct({ action: auditEvents.action })
      .from(auditEvents)
      .orderBy(auditEvents.action)
      .all()
      .map((r) => r.action);
  }
}

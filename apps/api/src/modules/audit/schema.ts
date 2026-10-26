import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core';

// Audit module table. Append-only; the daily AuditCleanup job deletes rows older than
// `audit.retentionDays`. No foreign key to users: the trail outlives deleted accounts, so the
// username is stored alongside the id.

export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** ISO-8601. */
    time: text('time').notNull(),
    userId: integer('user_id'),
    /** Username at the time, or `(apikey)` / `(bypass)` / `(basic)` for callers without a user. */
    username: text('username'),
    ip: text('ip'),
    /** Dotted action, e.g. `settings.update`, `series.delete`, `login.failed`. */
    action: text('action').notNull(),
    target: text('target'),
    method: text('method'),
    /** Route pattern relative to /api/v1, e.g. `/series/:id`. */
    route: text('route'),
    statusCode: integer('status_code'),
    details: text('details', { mode: 'json' }).$type<Record<string, unknown>>(),
  },
  (t) => [
    index('audit_events_time_idx').on(t.time),
    index('audit_events_action_idx').on(t.action),
    index('audit_events_user_idx').on(t.userId),
  ],
);

export type AuditEventRow = typeof auditEvents.$inferSelect;

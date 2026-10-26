import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core';
import type { DailySummary } from '@arclight/shared';

// Summary module tables: the stored daily summaries (kept 30 days) and the built-in engine's
// kill-switch lockdowns, which the summary totals (the engine only keeps the last hour).

export const dailySummaries = sqliteTable(
  'daily_summaries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** ISO-8601 */
    generatedAt: text('generated_at').notNull(),
    periodStart: text('period_start').notNull(),
    periodEnd: text('period_end').notNull(),
    /** The summary body (everything but id and the three timestamps). */
    data: text('data', { mode: 'json' })
      .$type<Omit<DailySummary, 'id' | 'generatedAt' | 'periodStart' | 'periodEnd'>>()
      .notNull(),
  },
  (t) => [index('daily_summaries_generated_idx').on(t.generatedAt)],
);

export type DailySummaryRow = typeof dailySummaries.$inferSelect;

export const killSwitchLockdowns = sqliteTable(
  'kill_switch_lockdowns',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** ISO-8601 */
    startedAt: text('started_at').notNull(),
    /** Null while the lockdown lasts. */
    endedAt: text('ended_at'),
    reason: text('reason'),
    /** Torrents the engine paused when it locked down. */
    pausedCount: integer('paused_count').notNull().default(0),
  },
  (t) => [index('kill_switch_lockdowns_started_idx').on(t.startedAt)],
);

export type KillSwitchLockdownRow = typeof killSwitchLockdowns.$inferSelect;

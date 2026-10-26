import { sqliteTable, integer, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { RetentionAction, RetentionCandidateStatus, RetentionCondition, RetentionMediaType, RetentionScope } from '@arclight/shared';

// Retention tables. Candidates point at series/movies by id without a foreign key (modules do
// not reference each other's tables); the sweep drops candidates whose item is gone.

export const retentionRules = sqliteTable('retention_rules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  mediaType: text('media_type').$type<RetentionMediaType>().notNull(),
  scope: text('scope', { mode: 'json' }).$type<RetentionScope>().notNull(),
  conditions: text('conditions', { mode: 'json' }).$type<RetentionCondition[]>().notNull(),
  graceDays: integer('grace_days').notNull().default(7),
  action: text('action').$type<RetentionAction>().notNull(),
  addExclusion: integer('add_exclusion', { mode: 'boolean' }).notNull().default(false),
  keepIfRequestedWithinDays: integer('keep_if_requested_within_days'),
  keepIfInCollection: integer('keep_if_in_collection', { mode: 'boolean' }).notNull().default(false),
  dryRun: integer('dry_run', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const retentionCandidates = sqliteTable(
  'retention_candidates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ruleId: integer('rule_id')
      .notNull()
      .references(() => retentionRules.id, { onDelete: 'cascade' }),
    mediaType: text('media_type').$type<RetentionMediaType>().notNull(),
    mediaId: integer('media_id').notNull(),
    tmdbId: integer('tmdb_id').notNull(),
    title: text('title').notNull(),
    year: integer('year'),
    sizeBytes: integer('size_bytes').notNull().default(0),
    action: text('action').$type<RetentionAction>().notNull(),
    reasons: text('reasons', { mode: 'json' }).$type<string[]>().notNull(),
    watchedBy: text('watched_by', { mode: 'json' }).$type<string[]>().notNull(),
    status: text('status').$type<RetentionCandidateStatus>().notNull(),
    firstSeenAt: text('first_seen_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    applyAfter: text('apply_after').notNull(),
    appliedAt: text('applied_at'),
    keptAt: text('kept_at'),
    error: text('error'),
  },
  (t) => [
    uniqueIndex('retention_candidates_rule_media_idx').on(t.ruleId, t.mediaType, t.mediaId),
    index('retention_candidates_status_idx').on(t.status),
  ],
);

export type RetentionRuleRow = typeof retentionRules.$inferSelect;
export type RetentionCandidateRow = typeof retentionCandidates.$inferSelect;

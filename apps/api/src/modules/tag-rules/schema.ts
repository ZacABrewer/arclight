import { sqliteTable, integer, text, index, primaryKey } from 'drizzle-orm/sqlite-core';
import type { TagEntityType, TagRuleCondition, TagRuleMatch, TagRuleRunSummary } from '@arclight/shared';
import { tags } from '../library/schema.js';

// Tag rules (docs/using/tags.md). `tag_rule_applications` records which rule put which tag on
// which item, so a rule only ever takes off tags it added itself: tags the user added by hand
// have no row here. Item ids are plain integers (movies, series, artists, authors live in four
// tables); rows of deleted items are pruned by the daily TagRules pass.

export const tagRules = sqliteTable(
  'tag_rules',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    appliesTo: text('applies_to', { mode: 'json' }).$type<TagEntityType[]>().notNull(),
    match: text('match').$type<TagRuleMatch>().notNull().default('all'),
    conditions: text('conditions', { mode: 'json' }).$type<TagRuleCondition[]>().notNull(),
    addTags: text('add_tags', { mode: 'json' }).$type<string[]>().notNull(),
    removeTagIds: text('remove_tag_ids', { mode: 'json' }).$type<number[]>().notNull(),
    removeWhenUnmatched: integer('remove_when_unmatched', { mode: 'boolean' }).notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    starterKey: text('starter_key'),
    lastRun: text('last_run', { mode: 'json' }).$type<TagRuleRunSummary>(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('tag_rules_sort_idx').on(t.sortOrder)],
);

export const tagRuleApplications = sqliteTable(
  'tag_rule_applications',
  {
    ruleId: integer('rule_id')
      .notNull()
      .references(() => tagRules.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').$type<TagEntityType>().notNull(),
    entityId: integer('entity_id').notNull(),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    appliedAt: text('applied_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ruleId, t.entityType, t.entityId, t.tagId] }),
    index('tag_rule_applications_entity_idx').on(t.entityType, t.entityId),
    index('tag_rule_applications_tag_idx').on(t.tagId),
  ],
);

export type TagRuleRow = typeof tagRules.$inferSelect;
export type TagRuleApplicationRow = typeof tagRuleApplications.$inferSelect;

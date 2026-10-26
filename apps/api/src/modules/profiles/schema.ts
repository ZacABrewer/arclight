import { sqliteTable, integer, text, real, index } from 'drizzle-orm/sqlite-core';
import type {
  CustomFormatSpec,
  LanguageCode,
  ProfileFormatItem,
  QualityProfileItem,
  ReleaseProtocol,
} from '@arclight/shared';

// Profiles module tables. Ordered/nested structures (items, specs, term lists) are JSON
// columns: they are always read and written whole, never queried by member.

export const qualityProfiles = sqliteTable('quality_profiles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  upgradeAllowed: integer('upgrade_allowed', { mode: 'boolean' }).notNull().default(true),
  cutoff: integer('cutoff').notNull(),
  items: text('items', { mode: 'json' }).$type<QualityProfileItem[]>().notNull(),
  minFormatScore: integer('min_format_score').notNull().default(0),
  cutoffFormatScore: integer('cutoff_format_score').notNull().default(0),
  minUpgradeFormatScore: integer('min_upgrade_format_score').notNull().default(1),
  formatItems: text('format_items', { mode: 'json' }).$type<ProfileFormatItem[]>().notNull(),
  languages: text('languages', { mode: 'json' }).$type<LanguageCode[]>().notNull(),
});

export const customFormats = sqliteTable('custom_formats', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  includeWhenRenaming: integer('include_when_renaming', { mode: 'boolean' }).notNull().default(false),
  specifications: text('specifications', { mode: 'json' }).$type<CustomFormatSpec[]>().notNull(),
});

export const delayProfiles = sqliteTable(
  'delay_profiles',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    order: integer('order').notNull(),
    tags: text('tags', { mode: 'json' }).$type<number[]>().notNull(),
    preferredProtocol: text('preferred_protocol').$type<ReleaseProtocol>().notNull().default('usenet'),
    usenetDelayMinutes: integer('usenet_delay_minutes').notNull().default(0),
    torrentDelayMinutes: integer('torrent_delay_minutes').notNull().default(0),
    bypassIfHighestQuality: integer('bypass_if_highest_quality', { mode: 'boolean' }).notNull().default(false),
    bypassIfAboveCustomFormatScore: integer('bypass_if_above_custom_format_score', { mode: 'boolean' })
      .notNull()
      .default(false),
    minimumCustomFormatScore: integer('minimum_custom_format_score').notNull().default(0),
  },
  (t) => [index('delay_profiles_order_idx').on(t.order)],
);

export const releaseProfiles = sqliteTable('release_profiles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  required: text('required', { mode: 'json' }).$type<string[]>().notNull(),
  ignored: text('ignored', { mode: 'json' }).$type<string[]>().notNull(),
  indexerId: integer('indexer_id'),
  tags: text('tags', { mode: 'json' }).$type<number[]>().notNull(),
});

/** Per-quality size limits in MB per minute; the vocabulary itself lives in code. */
export const qualityDefinitions = sqliteTable('quality_definitions', {
  qualityId: integer('quality_id').primaryKey(),
  minSize: real('min_size'),
  maxSize: real('max_size'),
  preferredSize: real('preferred_size'),
});

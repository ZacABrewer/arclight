import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';
import type { NotificationImplementation } from '@arclight/shared';

// Notifications module tables. Settings are the agent's JSON (validated by the agent package's
// schema for `implementation`), stored unmasked; masking happens on read.

const flag = (name: string) => integer(name, { mode: 'boolean' }).notNull().default(false);

export const notifications = sqliteTable('notifications', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  implementation: text('implementation').$type<NotificationImplementation>().notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  onGrab: flag('on_grab'),
  onDownload: flag('on_download'),
  onUpgrade: flag('on_upgrade'),
  onRename: flag('on_rename'),
  onSeriesAdd: flag('on_series_add'),
  onMovieAdd: flag('on_movie_add'),
  onSeriesDelete: flag('on_series_delete'),
  onMovieDelete: flag('on_movie_delete'),
  onFileDelete: flag('on_file_delete'),
  onHealthIssue: flag('on_health_issue'),
  onHealthRestored: flag('on_health_restored'),
  onApplicationUpdate: flag('on_application_update'),
  onManualInteractionRequired: flag('on_manual_interaction_required'),
  // Sitewide request/issue events (the requests module dispatches them).
  onRequestCreated: flag('on_request_created'),
  onRequestApproved: flag('on_request_approved'),
  onRequestDeclined: flag('on_request_declined'),
  onRequestAvailable: flag('on_request_available'),
  onIssueCreated: flag('on_issue_created'),
  onIssueUpdated: flag('on_issue_updated'),
  includeHealthWarnings: flag('include_health_warnings'),
  tags: text('tags', { mode: 'json' }).$type<number[]>().notNull(),
  settings: text('settings', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  addedAt: text('added_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export type NotificationRow = typeof notifications.$inferSelect;

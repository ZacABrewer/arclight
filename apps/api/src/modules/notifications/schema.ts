import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core';
import type { NotificationImplementation } from '@arclight/shared';
import type { NotificationEvent } from '@arclight/notifications';

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
  // Download problems and the daily summary (download-alerts.ts, the summary module).
  onDownloadStalled: flag('on_download_stalled'),
  onKillSwitch: flag('on_kill_switch'),
  onKillSwitchResumed: flag('on_kill_switch_resumed'),
  onImportProblem: flag('on_import_problem'),
  onDiskSpaceLow: flag('on_disk_space_low'),
  onDownloadRecovered: flag('on_download_recovered'),
  onDailySummary: flag('on_daily_summary'),
  includeHealthWarnings: flag('include_health_warnings'),
  respectQuietHours: integer('respect_quiet_hours', { mode: 'boolean' }).notNull().default(true),
  tags: text('tags', { mode: 'json' }).$type<number[]>().notNull(),
  settings: text('settings', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  addedAt: text('added_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export type NotificationRow = typeof notifications.$inferSelect;

/** Alerts held for a connection during quiet hours; sent as one batch when they end. */
export const notificationHeld = sqliteTable(
  'notification_held',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    notificationId: integer('notification_id')
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),
    event: text('event', { mode: 'json' }).$type<NotificationEvent>().notNull(),
    /** ISO-8601 */
    heldAt: text('held_at').notNull(),
  },
  (t) => [index('notification_held_notification_idx').on(t.notificationId)],
);

export type NotificationHeldRow = typeof notificationHeld.$inferSelect;

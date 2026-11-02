import { sql } from 'drizzle-orm';
import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core';
import type {
  NotificationDeliveryState,
  NotificationFilters,
  NotificationImplementation,
  NotificationTemplates,
  PersonalNotificationEvent,
  PersonalNotificationImplementation,
  QuietHoursSettings,
} from '@arclight/shared';
import { users } from '../auth/schema.js';
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
  /** Media kind / quality / user filters on top of the flags and tags. */
  filters: text('filters', { mode: 'json' })
    .$type<NotificationFilters>()
    .notNull()
    .default(sql`'{"mediaTypes":[],"qualities":[],"users":[]}'`),
  /** Per-event message templates ({{variables}}). */
  templates: text('templates', { mode: 'json' }).$type<NotificationTemplates>().notNull().default(sql`'{}'`),
  /** Own quiet hours; null follows the global ones (settings section `alerts`). */
  quietHours: text('quiet_hours', { mode: 'json' }).$type<QuietHoursSettings | null>(),
  /** Messages a minute at most; 0 is unlimited. */
  rateLimitPerMinute: integer('rate_limit_per_minute').notNull().default(0),
  /** Attempts per message including the first. */
  maxAttempts: integer('max_attempts').notNull().default(3),
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
    /** Why it waits: quiet hours, or the connection's rate limit. */
    reason: text('reason').$type<HeldReason>().notNull().default('quiet'),
  },
  (t) => [index('notification_held_notification_idx').on(t.notificationId)],
);

export type NotificationHeldRow = typeof notificationHeld.$inferSelect;

export type HeldReason = 'quiet' | 'rate';

/**
 * Personal destinations: a user's own Telegram chat, ntfy topic... and which of their own
 * events (request approved, watchlist episode available...) go there.
 */
export const userNotificationDestinations = sqliteTable(
  'user_notification_destinations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    implementation: text('implementation').$type<PersonalNotificationImplementation>().notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    events: text('events', { mode: 'json' }).$type<PersonalNotificationEvent[]>().notNull(),
    settings: text('settings', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    templates: text('templates', { mode: 'json' }).$type<NotificationTemplates>().notNull().default(sql`'{}'`),
    /** null: no quiet hours. */
    quietHours: text('quiet_hours', { mode: 'json' }).$type<QuietHoursSettings | null>(),
    addedAt: text('added_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('user_notification_destinations_user_idx').on(t.userId)],
);

export type UserNotificationDestinationRow = typeof userNotificationDestinations.$inferSelect;

/** Personal alerts waiting for the destination's quiet hours or rate limit. */
export const userNotificationHeld = sqliteTable(
  'user_notification_held',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    destinationId: integer('destination_id')
      .notNull()
      .references(() => userNotificationDestinations.id, { onDelete: 'cascade' }),
    event: text('event', { mode: 'json' }).$type<NotificationEvent>().notNull(),
    heldAt: text('held_at').notNull(),
    reason: text('reason').$type<HeldReason>().notNull().default('quiet'),
  },
  (t) => [index('user_notification_held_destination_idx').on(t.destinationId)],
);

/**
 * Delivery log: one row per message per destination (system connection or personal
 * destination), newest kept. Errors are stored with secrets redacted.
 */
export const notificationDeliveries = sqliteTable(
  'notification_deliveries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    notificationId: integer('notification_id').references(() => notifications.id, { onDelete: 'cascade' }),
    destinationId: integer('destination_id').references(() => userNotificationDestinations.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    title: text('title').notNull(),
    state: text('state').$type<NotificationDeliveryState>().notNull(),
    attempts: integer('attempts').notNull().default(1),
    error: text('error'),
    code: text('code'),
    test: integer('test', { mode: 'boolean' }).notNull().default(false),
    /** ISO-8601 */
    at: text('at').notNull(),
  },
  (t) => [
    index('notification_deliveries_notification_idx').on(t.notificationId, t.id),
    index('notification_deliveries_destination_idx').on(t.destinationId, t.id),
  ],
);

export type NotificationDeliveryRow = typeof notificationDeliveries.$inferSelect;

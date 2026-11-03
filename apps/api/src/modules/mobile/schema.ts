import { sqliteTable, integer, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { MobilePlatform } from '@arclight/shared';
import { sealedText } from '../../db/secret-box.js';
import { users } from '../auth/schema.js';

// Arclight Admin (companion app) devices. A row is created when the app's "Notifications on this device"
// toggle registers with the push relay and hands us the relay device id and secret. The secret
// is a capability for that one device at the relay: it is sealed at rest (secret-box.ts; the
// server needs it back to send), never returned by any route, masked in the audit trail and removed from backup
// snapshots (modules/backup/service.ts).

export const mobileDevices = sqliteTable(
  'mobile_devices',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The relay's id for the device (its push token stays at the relay). */
    relayDeviceId: text('relay_device_id').notNull(),
    /** Bearer secret for POST /v1/send for this device only. Never leaves the server. */
    relaySecret: sealedText('relay_secret').notNull(),
    platform: text('platform').$type<MobilePlatform>().notNull(),
    deviceName: text('device_name').notNull().default(''),
    appVersion: text('app_version'),
    /** Bundle ID of the app that registered (APNs topic at the relay); null for older apps. */
    appId: text('app_id'),
    createdAt: text('created_at').notNull(),
    /** Last registration from the app (each toggle-on or app start re-registers). */
    lastSeenAt: text('last_seen_at').notNull(),
    /** Last delivery problem; cleared by the next successful send. */
    lastError: text('last_error'),
  },
  (t) => [uniqueIndex('mobile_devices_relay_device_idx').on(t.relayDeviceId), index('mobile_devices_user_idx').on(t.userId)],
);

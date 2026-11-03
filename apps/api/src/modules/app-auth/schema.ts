import { sqliteTable, integer, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { AppPlatform } from '@arclight/shared';
import { users } from '../auth/schema.js';

// Signed-in installs of the Arclight player app. A row is created by POST /app/sign-in or
// POST /app/pair and holds the sha256 of the device token (the token itself is returned once).
// Deleting the row ends the token; so do deleting the user, a password reset and "sign out
// everywhere" (AuthService.revokeAllSessions).

export const appDevices = sqliteTable(
  'app_devices',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    platform: text('platform').$type<AppPlatform>().notNull(),
    appVersion: text('app_version').notNull(),
    /** sha256 hex of the bearer token. */
    tokenHash: text('token_hash').notNull(),
    /** How the device signed in: `password`, `pairing` or `device-code` (TV sign-in). */
    method: text('method').$type<'password' | 'pairing' | 'device-code'>().notNull().default('password'),
    createdAt: text('created_at').notNull(),
    /** Last request with the token (written at most once a minute). */
    lastSeenAt: text('last_seen_at').notNull(),
    lastIp: text('last_ip'),
  },
  (t) => [uniqueIndex('app_devices_token_idx').on(t.tokenHash), index('app_devices_user_idx').on(t.userId)],
);

export type AppDeviceRow = typeof appDevices.$inferSelect;

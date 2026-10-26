import { sqliteTable, integer, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { UserRole, UserSettings } from '@media-tron/shared';

// Auth module tables. The API key and auth method live in the `settings` table (section
// `security`), not here. `permissions` and `settings` exist now so the requests phase can
// add request permissions and quota columns without reshaping users.

export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    username: text('username').notNull(),
    /** Lowercased username; uniqueness is case-insensitive. */
    usernameKey: text('username_key').notNull(),
    /** `scrypt$N$r$p$salt$hash` (base64url parts); see password.ts. */
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name'),
    email: text('email'),
    role: text('role').$type<UserRole>().notNull(),
    /** Permission bitfield (Permission in @media-tron/shared). */
    permissions: integer('permissions').notNull().default(0),
    avatar: text('avatar'),
    settings: text('settings', { mode: 'json' }).$type<UserSettings>().notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    lastLoginAt: text('last_login_at'),
  },
  (t) => [uniqueIndex('users_username_key_idx').on(t.usernameKey)],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** sha256 of the cookie token (hex); the token itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** false: the cookie has no Max-Age and ends with the browser session. */
    persistent: integer('persistent', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
  },
  (t) => [uniqueIndex('sessions_token_hash_idx').on(t.tokenHash), index('sessions_user_idx').on(t.userId)],
);

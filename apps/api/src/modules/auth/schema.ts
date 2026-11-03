import { sqliteTable, integer, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { AppArea, UserRole, UserSettings } from '@arclight/shared';
import { householdProfiles } from '../households/schema.js';

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
    /** Permission bitfield (Permission in @arclight/shared). */
    permissions: integer('permissions').notNull().default(0),
    /**
     * Read-only admin-app areas an admin granted this (non-admin) user; [] = request portal
     * only. Enforced by the auth hook (route `config.access.areas`).
     */
    appAccess: text('app_access', { mode: 'json' }).$type<AppArea[]>().notNull().default([]),
    /**
     * The password hash is one the user (or an admin) chose. false for accounts created by a
     * media-server sign-in or an import, whose hash is random or unusable; such an account
     * cannot be made admin until an admin sets a password.
     */
    localPassword: integer('local_password', { mode: 'boolean' }).notNull().default(true),
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
    /** How it was opened: password, oidc:<provider>, passkey, jellyfin/emby/plex, setup; null for older sessions. */
    method: text('method'),
    /** The household profile this session is on; null: the owner profile. */
    profileId: integer('profile_id').references(() => householdProfiles.id, { onDelete: 'set null' }),
  },
  (t) => [uniqueIndex('sessions_token_hash_idx').on(t.tokenHash), index('sessions_user_idx').on(t.userId)],
);

/**
 * API keys with a purpose narrower than the install-wide admin key (which lives in the `security`
 * settings section). `jellyfin-plugin` keys may call /api/v1/jellyfin/* and nothing else (the
 * auth hook enforces it). Only the sha256 of a key is stored; the key is shown once.
 */
export const pluginApiKeys = sqliteTable(
  'plugin_api_keys',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    purpose: text('purpose').$type<'jellyfin-plugin'>().notNull().default('jellyfin-plugin'),
    keyHash: text('key_hash').notNull(),
    /** First characters of the key, to tell keys apart in the UI. */
    prefix: text('prefix').notNull(),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at'),
    lastPingAt: text('last_ping_at'),
  },
  (t) => [uniqueIndex('plugin_api_keys_hash_idx').on(t.keyHash)],
);

/**
 * An external identity (OpenID Connect provider + subject) linked to an Arclight account. One
 * per provider per account; a (provider, subject) pair belongs to one account.
 */
export const userIdentities = sqliteTable(
  'user_identities',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** OidcProvider.id from the `identity` settings section. */
    providerId: text('provider_id').notNull(),
    subject: text('subject').notNull(),
    email: text('email'),
    linkedAt: text('linked_at').notNull(),
    lastLoginAt: text('last_login_at'),
  },
  (t) => [uniqueIndex('user_identities_subject_idx').on(t.providerId, t.subject), uniqueIndex('user_identities_user_idx').on(t.userId, t.providerId)],
);

/**
 * TOTP second factor. `enabledAt` null: set up but not confirmed with a code yet. `lastStep` is
 * the last accepted 30-second step, so a code cannot be used twice. Recovery codes are sha256
 * hashes; a used one is removed.
 */
export const userTwoFactor = sqliteTable('user_two_factor', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Base32 TOTP secret. */
  totpSecret: text('totp_secret').notNull(),
  enabledAt: text('enabled_at'),
  lastStep: integer('last_step').notNull().default(0),
  recoveryCodes: text('recovery_codes', { mode: 'json' }).$type<string[]>().notNull().default([]),
  updatedAt: text('updated_at').notNull(),
});

/** WebAuthn credentials (passkeys). */
export const webauthnCredentials = sqliteTable(
  'webauthn_credentials',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** base64url credential id. */
    credentialId: text('credential_id').notNull(),
    /** base64url COSE public key. */
    publicKey: text('public_key').notNull(),
    counter: integer('counter').notNull().default(0),
    transports: text('transports', { mode: 'json' }).$type<string[]>().notNull().default([]),
    backedUp: integer('backed_up', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at'),
  },
  (t) => [uniqueIndex('webauthn_credentials_cred_idx').on(t.credentialId), index('webauthn_credentials_user_idx').on(t.userId)],
);

/**
 * Per-user API keys (alu_…). The scope limits what the key can do, on top of the account's own
 * access, which is read at every use. Only the sha256 of a key is stored; the key is shown once.
 */
export const userApiKeys = sqliteTable(
  'user_api_keys',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    scope: text('scope').$type<'read' | 'requests' | 'admin'>().notNull(),
    keyHash: text('key_hash').notNull(),
    prefix: text('prefix').notNull(),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at'),
    expiresAt: text('expires_at'),
  },
  (t) => [uniqueIndex('user_api_keys_hash_idx').on(t.keyHash), index('user_api_keys_user_idx').on(t.userId)],
);

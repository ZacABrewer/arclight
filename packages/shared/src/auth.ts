import { z } from 'zod';
import { MediaType } from './library.js';

// Authentication, users and first-run setup. Behaviour: docs/API.md "Authentication".
// Users carry a `permissions` bitfield and a free-form `settings` record now so that the
// requests phase (docs/spec/requests.md section 2-3) can add request permissions and quota
// columns without reshaping the user.

export const UserRole = z.enum(['admin', 'user']);
export type UserRole = z.infer<typeof UserRole>;

/**
 * Permission bits. Only ADMIN is enforced today (admins pass every check); the requests
 * phase adds the rest of the table from docs/spec/requests.md section 3.
 */
export const Permission = {
  NONE: 0,
  ADMIN: 2,
  MANAGE_USERS: 8,
  REQUEST: 32,
} as const;
export type PermissionName = keyof typeof Permission;

/** True when `held` satisfies `wanted`: ADMIN implies everything and 0 always passes. */
export function hasPermission(held: number, wanted: number): boolean {
  if (wanted === 0) return true;
  if ((held & Permission.ADMIN) !== 0) return true;
  return (held & wanted) === wanted;
}

export const ThemeName = z.enum(['tron', 'dark', 'light']);
export type ThemeName = z.infer<typeof ThemeName>;

/** Per-user preferences. Unknown keys are kept so later phases can add their own. */
export const UserSettings = z.looseObject({
  locale: z.string().min(2).max(35).optional(),
  theme: ThemeName.optional(),
});
export type UserSettings = z.infer<typeof UserSettings>;

export const User = z.object({
  id: z.number().int(),
  username: z.string(),
  displayName: z.string().optional(),
  email: z.string().optional(),
  role: UserRole,
  permissions: z.number().int(),
  avatar: z.string().optional(),
  createdAt: z.string(),
  lastLoginAt: z.string().optional(),
  settings: UserSettings,
});
export type User = z.infer<typeof User>;

const Username = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[A-Za-z0-9._@-]+$/, 'letters, digits and . _ @ - only');
export const PASSWORD_MIN_LENGTH = 8;
const Password = z.string().min(PASSWORD_MIN_LENGTH).max(256);
const DisplayName = z.string().trim().min(1).max(100);
const Email = z.email().max(254);

/** POST /api/v1/user (admin). */
export const UserCreate = z.object({
  username: Username,
  password: Password,
  displayName: DisplayName.optional(),
  email: Email.optional(),
  role: UserRole.default('user'),
  permissions: z.number().int().min(0).optional(),
  avatar: z.string().max(2048).optional(),
  settings: UserSettings.optional(),
});
export type UserCreate = z.input<typeof UserCreate>;

/** PUT /api/v1/user/:id (admin). `password` resets the password; null clears an optional field. */
export const UserUpdate = z.object({
  username: Username.optional(),
  password: Password.optional(),
  displayName: DisplayName.nullable().optional(),
  email: Email.nullable().optional(),
  role: UserRole.optional(),
  permissions: z.number().int().min(0).optional(),
  avatar: z.string().max(2048).nullable().optional(),
  settings: UserSettings.optional(),
});
export type UserUpdate = z.infer<typeof UserUpdate>;

/** PUT /api/v1/user/me: what a user may change about themselves. */
export const UserSelfUpdate = z.object({
  displayName: DisplayName.nullable().optional(),
  email: Email.nullable().optional(),
  avatar: z.string().max(2048).nullable().optional(),
  settings: UserSettings.optional(),
});
export type UserSelfUpdate = z.infer<typeof UserSelfUpdate>;

/** PUT /api/v1/user/me/password. */
export const PasswordChange = z.object({
  currentPassword: z.string().min(1),
  newPassword: Password,
});
export type PasswordChange = z.infer<typeof PasswordChange>;

// ---------------------------------------------------------------------------------------
// login and sessions
// ---------------------------------------------------------------------------------------

export const AuthMethod = z.enum(['forms', 'basic', 'none']);
export type AuthMethod = z.infer<typeof AuthMethod>;

/** POST /api/v1/auth/login. `rememberMe: false` makes the cookie end with the browser session. */
export const LoginRequest = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
  rememberMe: z.boolean().default(true),
});
export type LoginRequest = z.input<typeof LoginRequest>;

/** How the current request was authenticated. */
export const AuthVia = z.enum(['session', 'apikey', 'basic', 'bypass']);
export type AuthVia = z.infer<typeof AuthVia>;

/** Response of POST /auth/login and GET /auth/me. `user` is null for API-key and bypass callers. */
export const Session = z.object({
  user: User.nullable(),
  via: AuthVia,
  isAdmin: z.boolean(),
  expiresAt: z.string().optional(),
});
export type Session = z.infer<typeof Session>;

/** GET /api/v1/auth/status: public; what the web needs to route before anything else. */
export const AuthStatus = z.object({
  needsSetup: z.boolean(),
  authMethod: AuthMethod,
  authenticated: z.boolean(),
  session: Session.nullable(),
});
export type AuthStatus = z.infer<typeof AuthStatus>;

/** One row of GET /api/v1/auth/sessions (the caller's own sessions). */
export const SessionRecord = z.object({
  id: z.number().int(),
  createdAt: z.string(),
  expiresAt: z.string(),
  lastSeenAt: z.string(),
  userAgent: z.string().optional(),
  ip: z.string().optional(),
  current: z.boolean(),
});
export type SessionRecord = z.infer<typeof SessionRecord>;

// ---------------------------------------------------------------------------------------
// security settings
// ---------------------------------------------------------------------------------------

/** The user-editable part of the `security` settings section (GET/PUT /settings/security). */
export const AuthSettings = z.object({
  method: AuthMethod.default('forms'),
  /** false: requests from loopback/private (RFC1918, ULA, link-local) addresses skip auth. */
  requireForLocal: z.boolean().default(true),
  sessionDays: z.number().int().min(1).max(365).default(30),
});
export type AuthSettings = z.infer<typeof AuthSettings>;

/** Stored form of the `security` settings section. */
export const SecuritySettings = AuthSettings.extend({
  /** Per-install API key, generated on first boot. */
  apiKey: z.string().min(16).optional(),
  setupComplete: z.boolean().default(false),
  setupCompletedAt: z.string().optional(),
});
export type SecuritySettings = z.infer<typeof SecuritySettings>;

/** GET /settings/security and POST /settings/security/apikey. */
export const ApiKeyResponse = z.object({ apiKey: z.string() });
export type ApiKeyResponse = z.infer<typeof ApiKeyResponse>;

export const SecuritySettingsResponse = AuthSettings.extend({ apiKey: z.string() });
export type SecuritySettingsResponse = z.infer<typeof SecuritySettingsResponse>;

// ---------------------------------------------------------------------------------------
// first-run setup
// ---------------------------------------------------------------------------------------

export const SetupStepId = z.enum(['admin', 'tmdb', 'rootFolders', 'downloadClient', 'indexer']);
export type SetupStepId = z.infer<typeof SetupStepId>;

export const SetupStep = z.object({
  id: SetupStepId,
  complete: z.boolean(),
  optional: z.boolean(),
});
export type SetupStep = z.infer<typeof SetupStep>;

/** GET /api/v1/setup/status: public. */
export const SetupStatus = z.object({
  needsSetup: z.boolean(),
  steps: z.array(SetupStep),
});
export type SetupStatus = z.infer<typeof SetupStatus>;

/** POST /api/v1/setup/admin: creates the first admin and signs it in. Only while no user exists. */
export const SetupAdminRequest = z.object({
  username: Username,
  password: Password,
  email: Email.optional(),
  displayName: DisplayName.optional(),
});
export type SetupAdminRequest = z.infer<typeof SetupAdminRequest>;

export const SetupRootFolder = z.object({
  path: z.string().trim().min(1),
  mediaType: MediaType,
});
export type SetupRootFolder = z.infer<typeof SetupRootFolder>;

/** POST /api/v1/setup/rootfolder: add a root folder, creating the directory when asked. */
export const SetupRootFolderRequest = SetupRootFolder.extend({
  createIfMissing: z.boolean().default(true),
});
export type SetupRootFolderRequest = z.input<typeof SetupRootFolderRequest>;

/**
 * POST /api/v1/setup/complete. The admin fields are required only when no user exists yet
 * (a headless one-call setup); otherwise the caller must be signed in as an admin.
 */
export const SetupRequest = z.object({
  username: Username.optional(),
  password: Password.optional(),
  email: Email.optional(),
  tmdbApiKey: z.string().trim().min(1).optional(),
  rootFolders: z.array(SetupRootFolder).optional(),
  authMethod: AuthMethod.default('forms'),
});
export type SetupRequest = z.input<typeof SetupRequest>;

export const AuthErrorResponse = z.object({ error: z.string(), code: z.string().optional() });
export type AuthErrorResponse = z.infer<typeof AuthErrorResponse>;

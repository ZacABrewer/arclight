import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, lt, ne, sql } from 'drizzle-orm';
import {
  ADMIN_MANAGED_USER_SETTINGS,
  APP_AREAS,
  AppAccess,
  AuthSettings,
  Permission,
  PlayerAccess,
  SignInSettings,
  type ApiKeyScope,
  type AppArea,
  type AuthVia,
  type IdentitySettings,
  type SecondFactor,
  type LoginMethod,
  type SecuritySettings,
  type SessionRecord,
  type User,
  type UserCreate,
  type UserSelfUpdate,
  type UserUpdate,
} from '@arclight/shared';
import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';
import { pluginApiKeys, sessions, users } from '../../db/schema.js';
import { getSection, setSection } from '../settings/service.js';
import { dummyHash, hashPassword, needsRehash, verifyPassword } from './password.js';
import { allLocal } from './network.js';
import { TwoFactorError, TwoFactorService, type RelyingParty } from './two-factor.js';
import { ApiKeyNotFoundError } from './api-keys.js';
import { UserApiKeyService } from './api-keys.js';
import { audit } from '../audit/recorder.js';
import { hashToken } from './hash.js';

export type AuthErrorCode =
  | 'VALIDATION'
  | 'INVALID_CREDENTIALS'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'USER_EXISTS'
  | 'LAST_ADMIN'
  | 'RATE_LIMITED'
  | 'SETUP_COMPLETE'
  | 'SETUP_REQUIRED'
  | 'PASSWORD_REQUIRED'
  | 'TWO_FACTOR_REQUIRED'
  | 'CHALLENGE_EXPIRED'
  | 'TWO_FACTOR_SETUP_REQUIRED'
  | 'LAST_SIGN_IN_METHOD'
  | 'TOTP_REQUIRED'
  | 'TOTP_INVALID'
  | 'PAIRING_REQUIRED';

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export const AUTH_ERROR_STATUS: Record<AuthErrorCode, number> = {
  VALIDATION: 400,
  INVALID_CREDENTIALS: 401,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  USER_EXISTS: 409,
  LAST_ADMIN: 409,
  RATE_LIMITED: 429,
  SETUP_COMPLETE: 409,
  SETUP_REQUIRED: 403,
  PASSWORD_REQUIRED: 400,
  TWO_FACTOR_REQUIRED: 200,
  CHALLENGE_EXPIRED: 401,
  TWO_FACTOR_SETUP_REQUIRED: 403,
  LAST_SIGN_IN_METHOD: 409,
  TOTP_REQUIRED: 401,
  TOTP_INVALID: 401,
  PAIRING_REQUIRED: 403,
};

/**
 * The password was right and the account has a second factor: no session yet. POST /auth/login
 * answers the challenge (TwoFactorChallenge); POST /auth/login/2fa or /auth/passkey/login finish.
 */
export class TwoFactorRequiredError extends AuthError {
  constructor(
    readonly challenge: string,
    readonly methods: SecondFactor[],
  ) {
    super('TWO_FACTOR_REQUIRED', 'enter the code from your authenticator app');
  }
}

/** Who a request is, as decided by the auth hook. `user` is null for API-key and bypass callers. */
export interface RequestAuth {
  user: User | null;
  via: AuthVia;
  isAdmin: boolean;
  /** Read-only admin-app areas; every area for admins, [] for portal users. */
  appAccess: readonly AppArea[];
  sessionId?: number;
  expiresAt?: string;
  /** `via: 'plugin'`: the plugin key's id. */
  pluginKeyId?: number;
  /** `via: 'userkey'`: the key's id and scope. */
  apiKeyId?: number;
  apiKeyScope?: ApiKeyScope;
  /** `via: 'session'`: how the session was opened (password, oidc:<id>, passkey, ...). */
  sessionMethod?: string;
  /** `via: 'app'`: the app device (app_devices.id) whose token this is. */
  appDeviceId?: number;
}

/** The credentials a request carried, extracted by the hook. */
export interface RequestCredentials {
  sessionToken?: string | undefined;
  apiKey?: string | undefined;
  basic?: { username: string; password: string } | undefined;
  /** `Authorization: Bearer alt_…`: an Arclight player app device token. */
  bearer?: string | undefined;
  /** Socket peer followed by every forwarded address. */
  addresses: readonly (string | undefined)[];
  /** The TCP peer alone (forward-auth trusts only this). */
  peer?: string | undefined;
  /** Reads a request header (forward-auth). */
  header?: ((name: string) => string | undefined) | undefined;
}

/**
 * Resolves forward-auth (trusted header) requests; registered by the identity service. Returns
 * null when forward-auth is off, the peer is not a trusted proxy or no user header was sent.
 */
export type ForwardAuthResolver = (creds: RequestCredentials) => Promise<RequestAuth | null>;

/** Resolves an app device token (registered by the app-auth module); null: unknown or revoked. */
export type BearerResolver = (token: string, creds: RequestCredentials) => RequestAuth | null;

/** What a `requests`-scoped key of an admin may do: the portal's request rights. */
export const REQUESTS_KEY_ADMIN_PERMISSIONS =
  Permission.REQUEST |
  Permission.AUTO_APPROVE |
  Permission.REQUEST_4K |
  Permission.AUTO_APPROVE_4K |
  Permission.REQUEST_MUSIC |
  Permission.REQUEST_AUDIOBOOK |
  Permission.REQUEST_LANGUAGE |
  Permission.VIEW_ISSUES |
  Permission.CREATE_ISSUES |
  Permission.REQUEST_VIEW |
  Permission.VOTE;

export interface ResolvedRequest {
  auth: RequestAuth | null;
  /** Set when the session's expiry moved; the hook re-issues the cookie. */
  renewed?: { maxAgeSeconds: number | null };
}

export interface LoginResult {
  token: string;
  user: User;
  sessionId: number;
  expiresAt: string;
  /** null: browser-session cookie (rememberMe false). */
  maxAgeSeconds: number | null;
}

export interface SessionMeta {
  ip?: string | undefined;
  userAgent?: string | undefined;
  rememberMe?: boolean | undefined;
  /** Stored on the session (SessionRecord.method). */
  method?: string | undefined;
}

/**
 * Checks credentials against something other than Arclight's own passwords (a Jellyfin/Emby
 * server). Registered by the requests module, which owns the media-server settings.
 */
export interface ExternalLoginProvider {
  /** The local user id to sign in, or null for wrong credentials. Throws AuthError to refuse. */
  login(method: Exclude<LoginMethod, 'local'>, username: string, password: string): Promise<number | null>;
}

export interface AuthServiceOptions {
  db: Db;
  log?: Logger;
  now?: () => Date;
  /** Failed logins per address allowed inside `lockoutWindowMs` before 429. */
  maxFailures?: number;
  lockoutWindowMs?: number;
}

const DAY_MS = 24 * 60 * 60_000;
/** Sessions without rememberMe live for a day on the server side. */
const SHORT_SESSION_MS = DAY_MS;

type UserRow = typeof users.$inferSelect;

/** A stored app-access value, cleaned; admins have no grants (they have everything). */
export function appAccessOf(row: Pick<UserRow, 'role' | 'appAccess'>): AppArea[] {
  if (row.role === 'admin') return [];
  const parsed = AppAccess.safeParse(row.appAccess ?? []);
  return parsed.success ? parsed.data : [];
}

/** What the auth hook checks app areas against. */
export function effectiveAppAccess(user: Pick<User, 'role' | 'appAccess'> | null, isAdmin: boolean): readonly AppArea[] {
  if (isAdmin) return APP_AREAS;
  if (!user || user.role === 'admin') return [];
  return user.appAccess ?? [];
}

export function toUser(row: UserRow): User {
  const user: User = {
    id: row.id,
    username: row.username,
    role: row.role,
    permissions: row.permissions,
    appAccess: appAccessOf(row),
    localPassword: row.localPassword ?? true,
    createdAt: row.createdAt,
    settings: row.settings ?? {},
  };
  if (row.displayName) user.displayName = row.displayName;
  if (row.email) user.email = row.email;
  if (row.avatar) user.avatar = row.avatar;
  if (row.lastLoginAt) user.lastLoginAt = row.lastLoginAt;
  return user;
}

export { hashToken };

/** Constant-time string comparison that does not leak length (both sides are hashed first). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

export function generateApiKey(): string {
  return randomBytes(16).toString('hex');
}

/** Plugin keys carry a recognisable prefix so they are not mistaken for the admin key. */
export function generatePluginKey(): string {
  return `alj_${randomBytes(24).toString('base64url')}`;
}

export type PluginKeyRow = typeof pluginApiKeys.$inferSelect;

/** lastUsedAt is written at most this often per key (every event batch would otherwise write). */
const PLUGIN_KEY_TOUCH_MS = 60_000;

function permissionsFor(role: User['role'], requested: number | undefined): number {
  const base = requested ?? (role === 'admin' ? Permission.ADMIN : 0);
  return role === 'admin' ? base | Permission.ADMIN : base & ~Permission.ADMIN;
}

/**
 * Admin-managed settings with a schema: `player` (PlayerAccess) is validated and stored with its
 * defaults filled in; null removes it. Other keys pass through as before.
 */
function checkedSettings(settings: Record<string, unknown>): Record<string, unknown> {
  if (!('player' in settings) || settings['player'] === null) return settings;
  const parsed = PlayerAccess.safeParse(settings['player']);
  if (!parsed.success) throw new AuthError('VALIDATION', `invalid player access: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'player'}: ${i.message}`).join('; ')}`);
  return { ...settings, player: parsed.data };
}

export class AuthService {
  readonly db: Db;
  private readonly log: Logger | undefined;
  private readonly now: () => Date;
  private readonly maxFailures: number;
  private readonly lockoutWindowMs: number;
  private readonly failures = new Map<string, { count: number; first: number }>();
  /** Media-server sign-in (set by the requests module); absent: only local logins work. */
  externalLogin: ExternalLoginProvider | undefined;
  /** Media-server sign-in shown on the login page (set by the requests module); absent: none. */
  mediaServerLogin: (() => { kind: 'jellyfin' | 'emby' | 'plex'; name?: string | undefined } | null) | undefined;
  /** Settings a new non-admin account starts with (set by the requests module: the default request type filter); absent: none. */
  newUserSettings: (() => Record<string, unknown>) | undefined;
  /** Permission bits for accounts created by an identity provider or forward-auth (requests module: default permissions). */
  newUserPermissions: (() => number) | undefined;
  /** Forward-auth (set by the identity service); absent: off. */
  forwardAuth: ForwardAuthResolver | undefined;
  /** App device tokens (set by the app-auth module); absent: Bearer tokens are ignored. */
  bearerAuth: BearerResolver | undefined;
  /** Ends every app device of a user (set by the app-auth module); called with revokeAllSessions. */
  revokeAppDevices: ((userId: number) => void) | undefined;
  readonly twoFactor: TwoFactorService;
  readonly apiKeys: UserApiKeyService;

  constructor(opts: AuthServiceOptions) {
    this.db = opts.db;
    this.log = opts.log;
    this.now = opts.now ?? (() => new Date());
    this.maxFailures = opts.maxFailures ?? 10;
    this.lockoutWindowMs = opts.lockoutWindowMs ?? 15 * 60_000;
    this.twoFactor = new TwoFactorService(this.db, this.now, this.log);
    this.apiKeys = new UserApiKeyService(this.db, this.now);
  }

  /** Settings section `identity`: providers, password form, 2FA requirement, forward-auth. */
  identitySettings(): IdentitySettings {
    return getSection(this.db, 'identity');
  }

  /**
   * "Require two-factor for admins" applies to this request and the admin has no second factor
   * yet. Only password-based sessions and Basic count: an identity provider or a passkey already
   * did more than a password, and API keys are separate credentials.
   */
  twoFactorSetupRequired(auth: RequestAuth | null): boolean {
    if (!auth?.user || auth.user.role !== 'admin') return false;
    if (auth.via !== 'session' && auth.via !== 'basic') return false;
    const method = auth.sessionMethod ?? 'password';
    if (method.startsWith('oidc:') || method === 'passkey') return false;
    if (!this.identitySettings().requireTwoFactorForAdmins) return false;
    return !this.twoFactor.hasSecondFactor(auth.user.id);
  }

  // -------------------------------------------------------------------------------------
  // security settings and the API key
  // -------------------------------------------------------------------------------------

  security(): SecuritySettings {
    return getSection(this.db, 'security');
  }

  private saveSecurity(next: SecuritySettings): SecuritySettings {
    return setSection(this.db, 'security', next, this.now().toISOString());
  }

  /** Generates the per-install API key on first boot; returns the key. */
  ensureApiKey(): string {
    const current = this.security();
    if (current.apiKey) return current.apiKey;
    const apiKey = generateApiKey();
    this.saveSecurity({ ...current, apiKey });
    this.log?.info('generated API key');
    return apiKey;
  }

  apiKey(): string {
    return this.ensureApiKey();
  }

  regenerateApiKey(): string {
    const apiKey = generateApiKey();
    this.saveSecurity({ ...this.security(), apiKey });
    return apiKey;
  }

  verifyApiKey(candidate: string | undefined): boolean {
    if (!candidate) return false;
    const key = this.security().apiKey;
    return key !== undefined && safeEqual(candidate, key);
  }

  // -------------------------------------------------------------------------------------
  // plugin keys (purpose-limited API keys)
  // -------------------------------------------------------------------------------------

  listPluginKeys(): PluginKeyRow[] {
    return this.db.select().from(pluginApiKeys).orderBy(pluginApiKeys.id).all();
  }

  /** Creates a Jellyfin plugin key; the returned `key` is never stored or shown again. */
  createPluginKey(name: string): { row: PluginKeyRow; key: string } {
    const key = generatePluginKey();
    const row = this.db
      .insert(pluginApiKeys)
      .values({ name, purpose: 'jellyfin-plugin', keyHash: hashToken(key), prefix: key.slice(0, 10), createdAt: this.now().toISOString() })
      .returning()
      .get();
    return { row, key };
  }

  deletePluginKey(id: number): void {
    const deleted = this.db.delete(pluginApiKeys).where(eq(pluginApiKeys.id, id)).returning().get();
    if (!deleted) throw new AuthError('NOT_FOUND', `plugin key ${id} not found`);
  }

  /** The plugin key matching `candidate`, if any (its lastUsedAt is refreshed, throttled). */
  verifyPluginKey(candidate: string | undefined): PluginKeyRow | null {
    if (!candidate?.startsWith('alj_')) return null;
    const row = this.db.select().from(pluginApiKeys).where(eq(pluginApiKeys.keyHash, hashToken(candidate))).get();
    if (!row) return null;
    const now = this.now();
    if (!row.lastUsedAt || now.getTime() - Date.parse(row.lastUsedAt) > PLUGIN_KEY_TOUCH_MS) {
      this.db.update(pluginApiKeys).set({ lastUsedAt: now.toISOString() }).where(eq(pluginApiKeys.id, row.id)).run();
    }
    return row;
  }

  /** GET /jellyfin/ping with a plugin key. */
  markPluginPing(id: number): void {
    const at = this.now().toISOString();
    this.db.update(pluginApiKeys).set({ lastPingAt: at, lastUsedAt: at }).where(eq(pluginApiKeys.id, id)).run();
  }

  authSettings(): AuthSettings {
    const { method, requireForLocal, sessionDays } = this.security();
    return { method, requireForLocal, sessionDays };
  }

  updateAuthSettings(update: AuthSettings): AuthSettings {
    const parsed = AuthSettings.parse(update);
    this.saveSecurity({ ...this.security(), ...parsed });
    return this.authSettings();
  }

  /** Setup is needed until it was completed and while no admin account exists. */
  needsSetup(): boolean {
    return !this.security().setupComplete || !this.hasAdmin();
  }

  /** How non-admins sign in (settings section `signIn`). */
  signInSettings(): SignInSettings {
    return getSection(this.db, 'signIn');
  }

  updateSignInSettings(update: SignInSettings): SignInSettings {
    return setSection(this.db, 'signIn', SignInSettings.parse(update), this.now().toISOString());
  }

  markSetupComplete(): void {
    this.saveSecurity({ ...this.security(), setupComplete: true, setupCompletedAt: this.now().toISOString() });
  }

  // -------------------------------------------------------------------------------------
  // users
  // -------------------------------------------------------------------------------------

  hasUsers(): boolean {
    return this.db.select({ id: users.id }).from(users).limit(1).get() !== undefined;
  }

  /** An admin account exists (until then only setup answers; see the auth hook). */
  hasAdmin(): boolean {
    return this.db.select({ id: users.id }).from(users).where(eq(users.role, 'admin')).limit(1).get() !== undefined;
  }

  private adminCount(): number {
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(users)
      .where(eq(users.role, 'admin'))
      .get();
    return row?.n ?? 0;
  }

  listUsers(): User[] {
    return this.db.select().from(users).orderBy(users.id).all().map(toUser);
  }

  getUser(id: number): User {
    return toUser(this.row(id));
  }

  private row(id: number): UserRow {
    const row = this.db.select().from(users).where(eq(users.id, id)).get();
    if (!row) throw new AuthError('NOT_FOUND', `user ${id} not found`);
    return row;
  }

  private assertUsernameFree(username: string, exceptId?: number): void {
    const key = username.toLowerCase();
    const clash = this.db
      .select({ id: users.id })
      .from(users)
      .where(exceptId === undefined ? eq(users.usernameKey, key) : and(eq(users.usernameKey, key), ne(users.id, exceptId)))
      .get();
    if (clash) throw new AuthError('USER_EXISTS', `username already taken: ${username}`);
  }

  async createUser(input: UserCreate): Promise<User> {
    const username = input.username.trim();
    this.assertUsernameFree(username);
    const role = input.role ?? 'user';
    const now = this.now().toISOString();
    const row = this.db
      .insert(users)
      .values({
        username,
        usernameKey: username.toLowerCase(),
        passwordHash: await hashPassword(input.password),
        displayName: input.displayName ?? null,
        email: input.email?.toLowerCase() ?? null,
        role,
        permissions: permissionsFor(role, input.permissions),
        appAccess: role === 'admin' ? [] : AppAccess.parse(input.appAccess ?? []),
        localPassword: true,
        avatar: input.avatar ?? null,
        // Explicit settings win over the defaults for new users.
        settings: { ...(role === 'admin' ? {} : (this.newUserSettings?.() ?? {})), ...checkedSettings(input.settings ?? {}) },
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return toUser(row);
  }

  /**
   * Admin update. Refuses to demote the last admin, and to promote an account without a local
   * password (one made by a media-server sign-in or an import) unless this update sets one. A
   * password reset or a role change ends the user's sessions, so a session opened through a
   * media server never carries admin rights.
   */
  async updateUser(id: number, input: UserUpdate): Promise<User> {
    const current = this.row(id);
    if (input.role === 'user' && current.role === 'admin' && this.adminCount() <= 1) {
      throw new AuthError('LAST_ADMIN', 'cannot demote the only admin');
    }
    const role = input.role ?? current.role;
    const promoting = role === 'admin' && current.role !== 'admin';
    if (promoting && input.password === undefined && !current.localPassword) {
      throw new AuthError(
        'PASSWORD_REQUIRED',
        'set a password for this account before making it an admin: admins sign in with their Arclight username and password',
      );
    }
    const patch: Partial<typeof users.$inferInsert> = { updatedAt: this.now().toISOString(), role };
    if (input.username !== undefined) {
      this.assertUsernameFree(input.username, id);
      patch.username = input.username.trim();
      patch.usernameKey = patch.username.toLowerCase();
    }
    if (input.password !== undefined) {
      patch.passwordHash = await hashPassword(input.password);
      patch.localPassword = true;
    }
    if (input.displayName !== undefined) patch.displayName = input.displayName;
    if (input.email !== undefined) patch.email = input.email?.toLowerCase() ?? null;
    if (input.avatar !== undefined) patch.avatar = input.avatar;
    if (input.settings !== undefined) patch.settings = { ...current.settings, ...checkedSettings(input.settings) };
    patch.permissions = permissionsFor(role, input.permissions ?? current.permissions);
    if (role === 'admin') patch.appAccess = [];
    else if (input.appAccess !== undefined) patch.appAccess = AppAccess.parse(input.appAccess);
    const row = this.db.update(users).set(patch).where(eq(users.id, id)).returning().get()!;
    if (input.password !== undefined || role !== current.role) this.revokeAllSessions(id);
    return toUser(row);
  }

  deleteUser(id: number, actorId: number | null): void {
    const current = this.row(id);
    if (actorId === id) throw new AuthError('VALIDATION', 'you cannot delete your own account');
    if (current.role === 'admin' && this.adminCount() <= 1) {
      throw new AuthError('LAST_ADMIN', 'cannot delete the only admin');
    }
    this.db.delete(users).where(eq(users.id, id)).run();
  }

  updateSelf(id: number, input: UserSelfUpdate): User {
    const current = this.row(id);
    const patch: Partial<typeof users.$inferInsert> = { updatedAt: this.now().toISOString() };
    if (input.displayName !== undefined) patch.displayName = input.displayName;
    if (input.email !== undefined) patch.email = input.email?.toLowerCase() ?? null;
    if (input.avatar !== undefined) patch.avatar = input.avatar;
    if (input.settings !== undefined) {
      // Manager-owned keys (quota, content caps, approval overrides, Discord link) keep their stored value.
      const incoming: Record<string, unknown> = { ...input.settings };
      for (const key of ADMIN_MANAGED_USER_SETTINGS) delete incoming[key];
      patch.settings = { ...current.settings, ...incoming };
    }
    return toUser(this.db.update(users).set(patch).where(eq(users.id, id)).returning().get()!);
  }

  /** Changes the caller's password and ends every other session of theirs. */
  async changePassword(id: number, currentPassword: string, newPassword: string, keepSessionId?: number): Promise<void> {
    const row = this.row(id);
    if (!(await verifyPassword(currentPassword, row.passwordHash))) {
      throw new AuthError('INVALID_CREDENTIALS', 'current password is incorrect');
    }
    this.db
      .update(users)
      .set({ passwordHash: await hashPassword(newPassword), localPassword: true, updatedAt: this.now().toISOString() })
      .where(eq(users.id, id))
      .run();
    this.revokeAllSessions(id, keepSessionId);
  }

  // -------------------------------------------------------------------------------------
  // login, sessions
  // -------------------------------------------------------------------------------------

  /** 429 RATE_LIMITED while `address` has too many failed sign-ins (shared by every sign-in path). */
  checkRateLimit(address: string): void {
    const entry = this.failures.get(address);
    if (!entry) return;
    if (this.now().getTime() - entry.first > this.lockoutWindowMs) {
      this.failures.delete(address);
      return;
    }
    if (entry.count >= this.maxFailures) {
      throw new AuthError('RATE_LIMITED', 'too many failed logins; try again later');
    }
  }

  /** Counts a failed sign-in (wrong password, code or pair code) for `address`. */
  recordFailure(address: string): void {
    const t = this.now().getTime();
    const entry = this.failures.get(address);
    if (!entry || t - entry.first > this.lockoutWindowMs) this.failures.set(address, { count: 1, first: t });
    else entry.count++;
  }

  /** Checks a username/password pair. Unknown users cost the same as wrong passwords. */
  async verifyCredentials(username: string, password: string): Promise<UserRow | null> {
    const row = this.db.select().from(users).where(eq(users.usernameKey, username.trim().toLowerCase())).get();
    if (!row) {
      await verifyPassword(password, await dummyHash());
      return null;
    }
    if (!(await verifyPassword(password, row.passwordHash))) return null;
    if (needsRehash(row.passwordHash)) {
      this.db.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, row.id)).run();
    }
    return row;
  }

  async login(
    username: string,
    password: string,
    meta: { ip?: string | undefined; userAgent?: string | undefined; rememberMe?: boolean | undefined } = {},
  ): Promise<LoginResult> {
    const address = meta.ip ?? 'unknown';
    this.checkRateLimit(address);
    const row = await this.verifyCredentials(username, password);
    if (!row) {
      this.recordFailure(address);
      this.log?.warn({ username, ip: meta.ip }, 'failed login');
      audit(this.db).record({ action: 'login.failed', username, ip: meta.ip ?? null, details: { method: 'local' } });
      throw new AuthError('INVALID_CREDENTIALS', 'invalid username or password');
    }
    this.failures.delete(address);
    if (!this.localLoginAllowed(row)) {
      audit(this.db).record({ action: 'login.failed', userId: row.id, username: row.username, ip: meta.ip ?? null, details: { method: 'local', reason: 'local sign-in off' } });
      throw new AuthError('FORBIDDEN', 'signing in with an Arclight password is turned off for user accounts; sign in with your media server');
    }
    this.requireNoSecondStep(row.id, 'password', meta);
    audit(this.db).record({ action: 'login.success', userId: row.id, username: row.username, ip: meta.ip ?? null, details: { method: 'local' } });
    return this.loginAs(row.id, { ...meta, method: 'password' });
  }

  /** Throws TwoFactorRequiredError (with a parked sign-in) when the account has a second factor. */
  private requireNoSecondStep(userId: number, method: string, meta: SessionMeta): void {
    const methods = this.twoFactor.methodsFor(userId);
    if (methods.length === 0) return;
    throw new TwoFactorRequiredError(this.twoFactor.createChallenge(userId, method, meta), methods);
  }

  /** POST /auth/login/2fa: finishes a parked password sign-in with a TOTP or recovery code. */
  completeTwoFactor(challenge: string, proof: { code?: string | undefined; recoveryCode?: string | undefined }, ip?: string): LoginResult {
    const address = ip ?? 'unknown';
    this.checkRateLimit(address);
    let pending;
    try {
      pending = this.twoFactor.completeChallenge(challenge, proof);
    } catch (err) {
      if (err instanceof TwoFactorError && err.code === 'INVALID_CREDENTIALS') {
        this.recordFailure(address);
        audit(this.db).record({ action: 'login.failed', ip: ip ?? null, details: { method: 'two-factor' } });
      }
      throw toAuthError(err);
    }
    this.failures.delete(address);
    const row = this.row(pending.userId);
    const factor = proof.code !== undefined ? 'totp' : 'recovery';
    audit(this.db).record({ action: 'login.success', userId: row.id, username: row.username, ip: pending.meta.ip ?? null, details: { method: pending.method, factor } });
    return this.loginAs(row.id, { ...pending.meta, method: pending.method });
  }

  /** Options for a passkey prompt on the sign-in page (second factor when `challenge` is set). */
  async passkeyOptions(rp: RelyingParty, challenge?: string) {
    try {
      return await this.twoFactor.authenticationOptions(rp, challenge);
    } catch (err) {
      throw toAuthError(err);
    }
  }

  /**
   * POST /auth/passkey/login: a passkey as the second factor of a parked password sign-in
   * (`challenge`), or as a sign-in of its own.
   */
  async loginWithPasskey(ceremony: string, response: Record<string, unknown>, challenge: string | undefined, meta: SessionMeta): Promise<LoginResult> {
    const address = meta.ip ?? 'unknown';
    this.checkRateLimit(address);
    let result;
    try {
      result = await this.twoFactor.authenticate(ceremony, response, challenge);
    } catch (err) {
      if (err instanceof TwoFactorError && err.code === 'INVALID_CREDENTIALS') {
        this.recordFailure(address);
        audit(this.db).record({ action: 'login.failed', ip: meta.ip ?? null, details: { method: 'passkey' } });
      }
      throw toAuthError(err);
    }
    this.failures.delete(address);
    const row = this.row(result.userId);
    // Passwordless passkeys are an Arclight sign-in: the same switch as passwords for non-admins.
    if (!result.pending && !this.localLoginAllowed(row)) {
      throw new AuthError('FORBIDDEN', 'signing in with Arclight credentials is turned off for user accounts');
    }
    const method = result.pending ? result.pending.method : 'passkey';
    audit(this.db).record({ action: 'login.success', userId: row.id, username: row.username, ip: meta.ip ?? null, details: { method, factor: 'passkey' } });
    return this.loginAs(row.id, { ...(result.pending?.meta ?? meta), method });
  }

  /**
   * Login by method: `local` checks Arclight's password, anything else asks the registered
   * external provider (media server). Both share the failed-login rate limit.
   */
  async loginWith(
    method: LoginMethod,
    username: string,
    password: string,
    meta: { ip?: string | undefined; userAgent?: string | undefined; rememberMe?: boolean | undefined } = {},
  ): Promise<LoginResult> {
    if (method === 'local') return this.login(username, password, meta);
    const address = meta.ip ?? 'unknown';
    this.checkRateLimit(address);
    if (!this.externalLogin) throw new AuthError('VALIDATION', 'media server sign-in is not available');
    let userId: number | null;
    try {
      userId = await this.externalLogin.login(method, username, password);
    } catch (err) {
      if (err instanceof AuthError && err.code === 'INVALID_CREDENTIALS') this.recordFailure(address);
      throw err;
    }
    if (userId === null) {
      this.recordFailure(address);
      this.log?.warn({ username, ip: meta.ip, method }, 'failed media server login');
      audit(this.db).record({ action: 'login.failed', username, ip: meta.ip ?? null, details: { method } });
      throw new AuthError('INVALID_CREDENTIALS', 'invalid username or password');
    }
    this.failures.delete(address);
    if (this.row(userId).role !== 'admin') this.requireNoSecondStep(userId, method, meta);
    const result = this.loginExternal(userId, { ...meta, method });
    audit(this.db).record({ action: 'login.success', userId, username, ip: meta.ip ?? null, details: { method } });
    return result;
  }

  /**
   * POST /app/sign-in: checks a password and, when the account has TOTP on, the code, without
   * opening a session (the app gets a device token instead). Same rate limit, audit and local
   * sign-in switch as POST /auth/login. Accounts whose only second factor is a passkey, and
   * admins who still have to set up two-factor, are told to pair with a QR code instead.
   */
  async verifyAppSignIn(
    input: { username: string; password: string; totp?: string | undefined; recoveryCode?: string | undefined },
    ip?: string,
  ): Promise<User> {
    const address = ip ?? 'unknown';
    this.checkRateLimit(address);
    const row = await this.verifyCredentials(input.username, input.password);
    if (!row) {
      this.recordFailure(address);
      this.log?.warn({ username: input.username, ip }, 'failed app sign-in');
      audit(this.db).record({ action: 'login.failed', username: input.username, ip: ip ?? null, details: { method: 'app' } });
      throw new AuthError('INVALID_CREDENTIALS', 'invalid username or password');
    }
    if (!this.localLoginAllowed(row)) {
      audit(this.db).record({ action: 'login.failed', userId: row.id, username: row.username, ip: ip ?? null, details: { method: 'app', reason: 'local sign-in off' } });
      throw new AuthError('PAIRING_REQUIRED', 'signing in with an Arclight password is turned off for user accounts; pair the app with the QR code in the web player');
    }
    const methods = this.twoFactor.methodsFor(row.id);
    let factor: string | undefined;
    if (methods.length > 0) {
      if (!methods.includes('totp')) {
        throw new AuthError('PAIRING_REQUIRED', 'this account signs in with a passkey; pair the app with the QR code in the web player');
      }
      if (!input.totp && !input.recoveryCode) {
        // The password was right: not a failure, the app asks for the code.
        throw new AuthError('TOTP_REQUIRED', 'enter the code from your authenticator app');
      }
      const ok = input.totp ? this.twoFactor.checkTotp(row.id, input.totp) : this.twoFactor.useRecoveryCode(row.id, input.recoveryCode!);
      if (!ok) {
        this.recordFailure(address);
        audit(this.db).record({ action: 'login.failed', userId: row.id, username: row.username, ip: ip ?? null, details: { method: 'app', factor: input.totp ? 'totp' : 'recovery' } });
        throw new AuthError('TOTP_INVALID', 'that code is not right; check the time on your phone and try again');
      }
      factor = input.totp ? 'totp' : 'recovery';
    } else if (row.role === 'admin' && this.identitySettings().requireTwoFactorForAdmins) {
      throw new AuthError('TWO_FACTOR_SETUP_REQUIRED', 'set up two-factor sign-in on your account first (Profile → Security), then sign in again');
    }
    this.failures.delete(address);
    const now = this.now().toISOString();
    this.db.update(users).set({ lastLoginAt: now }).where(eq(users.id, row.id)).run();
    audit(this.db).record({ action: 'login.success', userId: row.id, username: row.username, ip: ip ?? null, details: { method: 'app', ...(factor ? { factor } : {}) } });
    return toUser({ ...row, lastLoginAt: now });
  }

  /** Admins (role admin) and accounts that may use local sign-in pass; others need `signIn.local`. */
  private localLoginAllowed(row: Pick<UserRow, 'role'>): boolean {
    return row.role === 'admin' || this.signInSettings().local;
  }

  /**
   * Signs in a user whose identity a media server proved (Jellyfin/Emby password, Plex PIN).
   * Never an admin: admins sign in with their Arclight username and password only.
   */
  loginExternal(
    userId: number,
    meta: SessionMeta = {},
  ): LoginResult {
    const row = this.row(userId);
    if (row.role === 'admin') {
      audit(this.db).record({ action: 'login.failed', userId: row.id, username: row.username, ip: meta.ip ?? null, details: { reason: 'admin via media server' } });
      throw new AuthError('FORBIDDEN', 'admins sign in with their Arclight username and password, not a media server');
    }
    return this.loginAs(userId, { method: 'mediaServer', ...meta });
  }

  /**
   * Issues a session for a user whose identity is already established: loginExternal, the
   * second factor, an identity provider (identity.ts). Callers have done every check.
   */
  loginAs(userId: number, meta: SessionMeta = {}): LoginResult {
    const row = this.row(userId);
    const now = this.now().toISOString();
    this.db.update(users).set({ lastLoginAt: now }).where(eq(users.id, row.id)).run();
    return { ...this.createSession(row.id, meta), user: toUser({ ...row, lastLoginAt: now }) };
  }

  /** Issues a session for a user (login and the setup wizard's first admin). */
  createSession(userId: number, meta: SessionMeta = {}): Omit<LoginResult, 'user'> {
    this.purgeExpired();
    const persistent = meta.rememberMe ?? true;
    const now = this.now();
    const lifetime = persistent ? this.authSettings().sessionDays * DAY_MS : SHORT_SESSION_MS;
    const expiresAt = new Date(now.getTime() + lifetime).toISOString();
    const token = randomBytes(32).toString('base64url');
    const row = this.db
      .insert(sessions)
      .values({
        tokenHash: hashToken(token),
        userId,
        persistent,
        createdAt: now.toISOString(),
        expiresAt,
        lastSeenAt: now.toISOString(),
        userAgent: meta.userAgent?.slice(0, 512) ?? null,
        ip: meta.ip ?? null,
        method: meta.method ?? null,
      })
      .returning()
      .get();
    return { token, sessionId: row.id, expiresAt, maxAgeSeconds: persistent ? Math.floor(lifetime / 1000) : null };
  }

  logout(token: string | undefined): void {
    if (!token) return;
    this.db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token))).run();
  }

  /**
   * Looks up a session token. Expired sessions are deleted. A persistent session past half
   * its lifetime slides forward, so active users stay signed in.
   */
  resolveSession(token: string): { user: User; sessionId: number; expiresAt: string; method: string | null; renewed?: { maxAgeSeconds: number | null } } | null {
    const found = this.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.tokenHash, hashToken(token)))
      .get();
    if (!found) return null;
    const now = this.now();
    const t = now.getTime();
    if (Date.parse(found.session.expiresAt) <= t) {
      this.db.delete(sessions).where(eq(sessions.id, found.session.id)).run();
      return null;
    }
    let expiresAt = found.session.expiresAt;
    let renewed: { maxAgeSeconds: number | null } | undefined;
    const lifetime = found.session.persistent ? this.authSettings().sessionDays * DAY_MS : SHORT_SESSION_MS;
    const patch: Partial<typeof sessions.$inferInsert> = {};
    if (Date.parse(expiresAt) - t < lifetime / 2) {
      expiresAt = new Date(t + lifetime).toISOString();
      patch.expiresAt = expiresAt;
      renewed = { maxAgeSeconds: found.session.persistent ? Math.floor(lifetime / 1000) : null };
    }
    // Throttle last-seen writes to one a minute per session.
    if (t - Date.parse(found.session.lastSeenAt) > 60_000) patch.lastSeenAt = now.toISOString();
    if (Object.keys(patch).length > 0) this.db.update(sessions).set(patch).where(eq(sessions.id, found.session.id)).run();
    return { user: toUser(found.user), sessionId: found.session.id, expiresAt, method: found.session.method ?? null, ...(renewed ? { renewed } : {}) };
  }

  listSessions(userId: number, currentId?: number): SessionRecord[] {
    const t = this.now().toISOString();
    return this.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .orderBy(sessions.id)
      .all()
      .filter((s) => s.expiresAt > t)
      .map((s) => {
        const rec: SessionRecord = {
          id: s.id,
          createdAt: s.createdAt,
          expiresAt: s.expiresAt,
          lastSeenAt: s.lastSeenAt,
          current: s.id === currentId,
        };
        if (s.userAgent) rec.userAgent = s.userAgent;
        if (s.ip) rec.ip = s.ip;
        if (s.method) rec.method = s.method;
        return rec;
      });
  }

  revokeSession(userId: number, sessionId: number): void {
    const deleted = this.db
      .delete(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
      .returning()
      .get();
    if (!deleted) throw new AuthError('NOT_FOUND', `session ${sessionId} not found`);
  }

  /** Ends the user's sessions (but `exceptId`) and every app device of theirs. */
  revokeAllSessions(userId: number, exceptId?: number): void {
    this.revokeAppDevices?.(userId);
    this.db
      .delete(sessions)
      .where(exceptId === undefined ? eq(sessions.userId, userId) : and(eq(sessions.userId, userId), ne(sessions.id, exceptId)))
      .run();
  }

  purgeExpired(): number {
    return this.db.delete(sessions).where(lt(sessions.expiresAt, this.now().toISOString())).run().changes;
  }

  // -------------------------------------------------------------------------------------
  // request resolution
  // -------------------------------------------------------------------------------------

  /** True when the bypass rule lets this request through without credentials. */
  bypasses(addresses: readonly (string | undefined)[]): boolean {
    const s = this.security();
    if (!s.setupComplete || !this.hasAdmin()) return false;
    if (s.method !== 'none' && s.requireForLocal) return false;
    return allLocal(addresses);
  }

  /**
   * Decides who a request is: an app device token (Bearer), the session cookie, then Basic
   * credentials (method basic), then the API key, then the local-address bypass. null means
   * anonymous.
   */
  async resolve(creds: RequestCredentials): Promise<ResolvedRequest> {
    // An app token is decisive: a revoked one is anonymous (401), never the local bypass, so the
    // app knows to sign in again.
    if (creds.bearer && this.bearerAuth) return { auth: this.bearerAuth(creds.bearer, creds) };
    if (creds.sessionToken) {
      const found = this.resolveSession(creds.sessionToken);
      if (found) {
        const isAdmin = found.user.role === 'admin';
        return {
          auth: {
            user: found.user,
            via: 'session',
            isAdmin,
            appAccess: effectiveAppAccess(found.user, isAdmin),
            sessionId: found.sessionId,
            expiresAt: found.expiresAt,
            ...(found.method ? { sessionMethod: found.method } : {}),
          },
          ...(found.renewed ? { renewed: found.renewed } : {}),
        };
      }
    }
    if (creds.basic && this.security().method === 'basic') {
      const address = creds.addresses[0] ?? 'unknown';
      this.checkRateLimit(address);
      const row = await this.verifyCredentials(creds.basic.username, creds.basic.password);
      // Basic cannot carry a second factor: accounts with one use an API key instead.
      if (row && this.localLoginAllowed(row) && !this.twoFactor.hasSecondFactor(row.id)) {
        const user = toUser(row);
        const isAdmin = user.role === 'admin';
        return { auth: { user, via: 'basic', isAdmin, appAccess: effectiveAppAccess(user, isAdmin) } };
      }
      if (!row) this.recordFailure(address);
    }
    if (creds.apiKey && this.verifyApiKey(creds.apiKey)) {
      return { auth: { user: null, via: 'apikey', isAdmin: true, appAccess: APP_AREAS } };
    }
    const userKey = creds.apiKey ? this.apiKeys.verify(creds.apiKey) : null;
    if (userKey) {
      const keyAuth = this.userKeyAuth(userKey.userId, userKey.id, userKey.scope);
      if (keyAuth) return { auth: keyAuth };
    }
    const pluginKey = creds.apiKey ? this.verifyPluginKey(creds.apiKey) : null;
    if (pluginKey) {
      // Never admin and no app areas: the hook confines it to /api/v1/jellyfin/*.
      return { auth: { user: null, via: 'plugin', isAdmin: false, appAccess: [], pluginKeyId: pluginKey.id } };
    }
    if (this.forwardAuth) {
      const forwarded = await this.forwardAuth(creds);
      if (forwarded) return { auth: forwarded };
    }
    if (this.bypasses(creds.addresses)) {
      return { auth: { user: null, via: 'bypass', isAdmin: true, appAccess: APP_AREAS } };
    }
    return { auth: null };
  }

  /**
   * The request identity of a per-user key: the account's current role and grants, narrowed by
   * the scope. `admin` keys of an account that is no longer an admin act as `requests`.
   */
  private userKeyAuth(userId: number, apiKeyId: number, scope: ApiKeyScope): RequestAuth | null {
    const row = this.db.select().from(users).where(eq(users.id, userId)).get();
    if (!row) return null;
    const user = toUser(row);
    const isAdminAccount = user.role === 'admin';
    const effective: ApiKeyScope = scope === 'admin' && !isAdminAccount ? 'requests' : scope;
    if (effective === 'requests') {
      // Never admin, no admin-app areas: the request portal's rights only.
      const permissions = isAdminAccount ? REQUESTS_KEY_ADMIN_PERMISSIONS : user.permissions & ~Permission.ADMIN;
      const portalUser: User = { ...user, role: 'user', permissions, appAccess: [] };
      return { user: portalUser, via: 'userkey', isAdmin: false, appAccess: [], apiKeyId, apiKeyScope: 'requests' };
    }
    return { user, via: 'userkey', isAdmin: isAdminAccount, appAccess: effectiveAppAccess(user, isAdminAccount), apiKeyId, apiKeyScope: effective };
  }

  /**
   * Creates an account for an identity proven elsewhere (identity provider, forward-auth). It has
   * no usable password (localPassword false) until an admin sets one.
   */
  async createExternalUser(input: { username: string; email?: string | undefined; displayName?: string | undefined; role: User['role'] }): Promise<User> {
    const now = this.now().toISOString();
    const row = this.db
      .insert(users)
      .values({
        username: input.username,
        usernameKey: input.username.toLowerCase(),
        passwordHash: await hashPassword(randomBytes(32).toString('base64url')),
        displayName: input.displayName ?? null,
        email: input.email?.toLowerCase() ?? null,
        role: input.role,
        permissions: permissionsFor(input.role, input.role === 'admin' ? undefined : (this.newUserPermissions?.() ?? 0)),
        appAccess: [],
        localPassword: false,
        settings: input.role === 'admin' ? {} : (this.newUserSettings?.() ?? {}),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return toUser(row);
  }

  /** A free username based on `wanted` (wanted, wanted-2, wanted-3, ...). */
  freeUsername(wanted: string): string {
    const cleaned = wanted.replace(/[^A-Za-z0-9._@-]/g, '').slice(0, 56) || 'user';
    const base = cleaned.length < 2 ? `${cleaned}-user` : cleaned;
    for (let i = 1; i < 1000; i++) {
      const candidate = i === 1 ? base : `${base}-${i}`;
      if (!this.findUserByUsername(candidate)) return candidate;
    }
    return `${base}-${randomBytes(4).toString('hex')}`;
  }

  /**
   * Sets the role an identity provider's groups ask for. Never demotes the last admin; a change
   * ends the account's sessions (as an admin edit would).
   */
  syncRole(userId: number, role: User['role']): User {
    const current = this.row(userId);
    if (current.role === role) return toUser(current);
    if (role === 'user' && current.role === 'admin' && this.adminCount() <= 1) {
      this.log?.warn({ userId }, 'identity provider groups would demote the only admin; keeping the admin role');
      return toUser(current);
    }
    const row = this.db
      .update(users)
      .set({
        role,
        permissions: permissionsFor(role, role === 'admin' ? undefined : current.role === 'admin' ? (this.newUserPermissions?.() ?? 0) : current.permissions),
        appAccess: role === 'admin' ? [] : current.appAccess,
        updatedAt: this.now().toISOString(),
      })
      .where(eq(users.id, userId))
      .returning()
      .get()!;
    this.revokeAllSessions(userId);
    audit(this.db).record({ action: 'user.role.sync', userId, username: row.username, details: { role } });
    return toUser(row);
  }

  findUsersByEmail(email: string): UserRow[] {
    return this.db.select().from(users).where(eq(users.email, email.toLowerCase())).all();
  }

  findUserByUsername(username: string): UserRow | undefined {
    return this.db.select().from(users).where(eq(users.usernameKey, username.trim().toLowerCase())).get();
  }

  userRow(id: number): UserRow {
    return this.row(id);
  }
}

/** TwoFactorError → AuthError (same codes; the routes' error handler knows AuthError). */
export function toAuthError(err: unknown): unknown {
  if (err instanceof TwoFactorError) return new AuthError(err.code, err.message);
  if (err instanceof ApiKeyNotFoundError) return new AuthError('NOT_FOUND', err.message);
  return err;
}

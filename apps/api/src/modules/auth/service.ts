import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, lt, ne, sql } from 'drizzle-orm';
import {
  ADMIN_MANAGED_USER_SETTINGS,
  APP_AREAS,
  AppAccess,
  AuthSettings,
  Permission,
  SignInSettings,
  type AppArea,
  type AuthVia,
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
import { sessions, users } from '../../db/schema.js';
import { getSection, setSection } from '../settings/service.js';
import { dummyHash, hashPassword, needsRehash, verifyPassword } from './password.js';
import { allLocal } from './network.js';
import { audit } from '../audit/recorder.js';

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
  | 'PASSWORD_REQUIRED';

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
};

/** Who a request is, as decided by the auth hook. `user` is null for API-key and bypass callers. */
export interface RequestAuth {
  user: User | null;
  via: AuthVia;
  isAdmin: boolean;
  /** Read-only admin-app areas; every area for admins, [] for portal users. */
  appAccess: readonly AppArea[];
  sessionId?: number;
  expiresAt?: string;
}

/** The credentials a request carried, extracted by the hook. */
export interface RequestCredentials {
  sessionToken?: string | undefined;
  apiKey?: string | undefined;
  basic?: { username: string; password: string } | undefined;
  /** Socket peer followed by every forwarded address. */
  addresses: readonly (string | undefined)[];
}

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

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time string comparison that does not leak length (both sides are hashed first). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

export function generateApiKey(): string {
  return randomBytes(16).toString('hex');
}

function permissionsFor(role: User['role'], requested: number | undefined): number {
  const base = requested ?? (role === 'admin' ? Permission.ADMIN : 0);
  return role === 'admin' ? base | Permission.ADMIN : base & ~Permission.ADMIN;
}

export class AuthService {
  private readonly db: Db;
  private readonly log: Logger | undefined;
  private readonly now: () => Date;
  private readonly maxFailures: number;
  private readonly lockoutWindowMs: number;
  private readonly failures = new Map<string, { count: number; first: number }>();
  /** Media-server sign-in (set by the requests module); absent: only local logins work. */
  externalLogin: ExternalLoginProvider | undefined;
  /** Media-server sign-in shown on the login page (set by the requests module); absent: none. */
  mediaServerLogin: (() => { kind: 'jellyfin' | 'emby' | 'plex'; name?: string | undefined } | null) | undefined;

  constructor(opts: AuthServiceOptions) {
    this.db = opts.db;
    this.log = opts.log;
    this.now = opts.now ?? (() => new Date());
    this.maxFailures = opts.maxFailures ?? 10;
    this.lockoutWindowMs = opts.lockoutWindowMs ?? 15 * 60_000;
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
        settings: input.settings ?? {},
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
    if (input.settings !== undefined) patch.settings = { ...current.settings, ...input.settings };
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

  private checkRateLimit(address: string): void {
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

  private recordFailure(address: string): void {
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
    audit(this.db).record({ action: 'login.success', userId: row.id, username: row.username, ip: meta.ip ?? null, details: { method: 'local' } });
    const now = this.now();
    this.db.update(users).set({ lastLoginAt: now.toISOString() }).where(eq(users.id, row.id)).run();
    return { ...this.createSession(row.id, meta), user: toUser({ ...row, lastLoginAt: now.toISOString() }) };
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
    const result = this.loginExternal(userId, meta);
    audit(this.db).record({ action: 'login.success', userId, username, ip: meta.ip ?? null, details: { method } });
    return result;
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
    meta: { ip?: string | undefined; userAgent?: string | undefined; rememberMe?: boolean | undefined } = {},
  ): LoginResult {
    const row = this.row(userId);
    if (row.role === 'admin') {
      audit(this.db).record({ action: 'login.failed', userId: row.id, username: row.username, ip: meta.ip ?? null, details: { reason: 'admin via media server' } });
      throw new AuthError('FORBIDDEN', 'admins sign in with their Arclight username and password, not a media server');
    }
    return this.loginAs(userId, meta);
  }

  /** Issues a session for a user whose identity is already established (internal; see loginExternal). */
  private loginAs(
    userId: number,
    meta: { ip?: string | undefined; userAgent?: string | undefined; rememberMe?: boolean | undefined } = {},
  ): LoginResult {
    const row = this.row(userId);
    const now = this.now().toISOString();
    this.db.update(users).set({ lastLoginAt: now }).where(eq(users.id, row.id)).run();
    return { ...this.createSession(row.id, meta), user: toUser({ ...row, lastLoginAt: now }) };
  }

  /** Issues a session for a user (login and the setup wizard's first admin). */
  createSession(
    userId: number,
    meta: { ip?: string | undefined; userAgent?: string | undefined; rememberMe?: boolean | undefined } = {},
  ): Omit<LoginResult, 'user'> {
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
  resolveSession(token: string): { user: User; sessionId: number; expiresAt: string; renewed?: { maxAgeSeconds: number | null } } | null {
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
    return { user: toUser(found.user), sessionId: found.session.id, expiresAt, ...(renewed ? { renewed } : {}) };
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

  revokeAllSessions(userId: number, exceptId?: number): void {
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
   * Decides who a request is: session cookie, then Basic credentials (method basic), then
   * the API key, then the local-address bypass. null means anonymous.
   */
  async resolve(creds: RequestCredentials): Promise<ResolvedRequest> {
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
          },
          ...(found.renewed ? { renewed: found.renewed } : {}),
        };
      }
    }
    if (creds.basic && this.security().method === 'basic') {
      const address = creds.addresses[0] ?? 'unknown';
      this.checkRateLimit(address);
      const row = await this.verifyCredentials(creds.basic.username, creds.basic.password);
      if (row && this.localLoginAllowed(row)) {
        const user = toUser(row);
        const isAdmin = user.role === 'admin';
        return { auth: { user, via: 'basic', isAdmin, appAccess: effectiveAppAccess(user, isAdmin) } };
      }
      if (!row) this.recordFailure(address);
    }
    if (creds.apiKey && this.verifyApiKey(creds.apiKey)) {
      return { auth: { user: null, via: 'apikey', isAdmin: true, appAccess: APP_AREAS } };
    }
    if (this.bypasses(creds.addresses)) {
      return { auth: { user: null, via: 'bypass', isAdmin: true, appAccess: APP_AREAS } };
    }
    return { auth: null };
  }
}

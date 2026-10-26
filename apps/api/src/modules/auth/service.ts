import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, lt, ne, sql } from 'drizzle-orm';
import {
  AuthSettings,
  Permission,
  type AuthVia,
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

export type AuthErrorCode =
  | 'VALIDATION'
  | 'INVALID_CREDENTIALS'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'USER_EXISTS'
  | 'LAST_ADMIN'
  | 'RATE_LIMITED'
  | 'SETUP_COMPLETE';

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
};

/** Who a request is, as decided by the auth hook. `user` is null for API-key and bypass callers. */
export interface RequestAuth {
  user: User | null;
  via: AuthVia;
  isAdmin: boolean;
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

export function toUser(row: UserRow): User {
  const user: User = {
    id: row.id,
    username: row.username,
    role: row.role,
    permissions: row.permissions,
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

  needsSetup(): boolean {
    return !this.security().setupComplete;
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
        avatar: input.avatar ?? null,
        settings: input.settings ?? {},
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return toUser(row);
  }

  /** Admin update. Refuses to demote the last admin. A password reset ends the user's sessions. */
  async updateUser(id: number, input: UserUpdate): Promise<User> {
    const current = this.row(id);
    if (input.role === 'user' && current.role === 'admin' && this.adminCount() <= 1) {
      throw new AuthError('LAST_ADMIN', 'cannot demote the only admin');
    }
    const role = input.role ?? current.role;
    const patch: Partial<typeof users.$inferInsert> = { updatedAt: this.now().toISOString(), role };
    if (input.username !== undefined) {
      this.assertUsernameFree(input.username, id);
      patch.username = input.username.trim();
      patch.usernameKey = patch.username.toLowerCase();
    }
    if (input.password !== undefined) patch.passwordHash = await hashPassword(input.password);
    if (input.displayName !== undefined) patch.displayName = input.displayName;
    if (input.email !== undefined) patch.email = input.email?.toLowerCase() ?? null;
    if (input.avatar !== undefined) patch.avatar = input.avatar;
    if (input.settings !== undefined) patch.settings = { ...current.settings, ...input.settings };
    patch.permissions = permissionsFor(role, input.permissions ?? current.permissions);
    const row = this.db.update(users).set(patch).where(eq(users.id, id)).returning().get()!;
    if (input.password !== undefined) this.revokeAllSessions(id);
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
    if (input.settings !== undefined) patch.settings = { ...current.settings, ...input.settings };
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
      .set({ passwordHash: await hashPassword(newPassword), updatedAt: this.now().toISOString() })
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
      throw new AuthError('INVALID_CREDENTIALS', 'invalid username or password');
    }
    this.failures.delete(address);
    const now = this.now();
    this.db.update(users).set({ lastLoginAt: now.toISOString() }).where(eq(users.id, row.id)).run();
    return { ...this.createSession(row.id, meta), user: toUser({ ...row, lastLoginAt: now.toISOString() }) };
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
    if (!s.setupComplete) return false;
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
        return {
          auth: {
            user: found.user,
            via: 'session',
            isAdmin: found.user.role === 'admin',
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
      if (row) {
        const user = toUser(row);
        return { auth: { user, via: 'basic', isAdmin: user.role === 'admin' } };
      }
      this.recordFailure(address);
    }
    if (creds.apiKey && this.verifyApiKey(creds.apiKey)) {
      return { auth: { user: null, via: 'apikey', isAdmin: true } };
    }
    if (this.bypasses(creds.addresses)) {
      return { auth: { user: null, via: 'bypass', isAdmin: true } };
    }
    return { auth: null };
  }
}

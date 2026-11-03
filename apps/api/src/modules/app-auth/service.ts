import { randomBytes, randomInt } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  APP_PAIR_CODE_ALPHABET,
  APP_PAIR_CODE_LENGTH,
  APP_PAIR_CODE_TTL_MS,
  APP_TOKEN_PREFIX,
  appPairingUri,
  type AppDevice,
  type AppDeviceInfo,
  type AppPairCode,
  type AppSignInResponse,
  type User,
} from '@arclight/shared';
import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';
import { users } from '../auth/schema.js';
import { effectiveAppAccess, hashToken, toUser, type AuthService, type RequestAuth, type RequestCredentials } from '../auth/service.js';
import { audit } from '../audit/recorder.js';
import { decide, playerSettings } from '../playback/access.js';
import { VERSION } from '../../version.js';
import { appDevices, type AppDeviceRow } from './schema.js';

// Device tokens for the Arclight player app: sign-in with a password (POST /app/sign-in), QR
// pairing from a signed-in browser (POST /app/pair-codes, then POST /app/pair), the Bearer
// resolver the auth hook calls, and device management. Pair codes live in memory only: they are
// valid for five minutes and once, so a restart simply asks for a new one.

export type AppAuthErrorCode =
  | 'NO_USER'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'NOT_APP'
  | 'PAIR_CODE_INVALID'
  | 'PAIR_CODE_EXPIRED'
  | 'PLAYER_DISABLED'
  | 'PLAYER_NOT_ALLOWED';

export const APP_AUTH_ERROR_STATUS: Record<AppAuthErrorCode, number> = {
  NO_USER: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  NOT_APP: 400,
  PAIR_CODE_INVALID: 401,
  PAIR_CODE_EXPIRED: 410,
  PLAYER_DISABLED: 403,
  PLAYER_NOT_ALLOWED: 403,
};

export class AppAuthError extends Error {
  constructor(
    readonly code: AppAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AppAuthError';
  }
}

/** lastSeenAt / lastIp are written at most this often per device. */
export const APP_DEVICE_TOUCH_MS = 60_000;
/** Pair codes one user may create per window (each new one replaces the previous). */
export const PAIR_CODES_PER_WINDOW = 10;
export const PAIR_CODE_WINDOW_MS = 10 * 60_000;
/** Server name in sign-in answers. */
export const SERVER_NAME = 'Arclight';

export function generateAppToken(): string {
  return `${APP_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function generatePairCode(): string {
  let code = '';
  for (let i = 0; i < APP_PAIR_CODE_LENGTH; i++) code += APP_PAIR_CODE_ALPHABET[randomInt(APP_PAIR_CODE_ALPHABET.length)];
  return code;
}

export interface AppAuthServiceOptions {
  db: Db;
  auth: AuthService;
  /** The configured public URL (Application URL), if any. */
  serverUrl: () => string | undefined;
  log?: Logger;
  now?: () => number;
}

interface PendingCode {
  userId: number;
  expiresAt: number;
}

export class AppAuthService {
  private readonly db: Db;
  private readonly auth: AuthService;
  private readonly now: () => number;
  private readonly codes = new Map<string, PendingCode>();
  private readonly issued = new Map<number, number[]>();

  constructor(private readonly opts: AppAuthServiceOptions) {
    this.db = opts.db;
    this.auth = opts.auth;
    this.now = opts.now ?? Date.now;
  }

  /** PLAYER_DISABLED / PLAYER_NOT_ALLOWED unless the account may use the player (admins always, once it is on). */
  assertPlayerAllowed(user: Pick<User, 'id' | 'role' | 'settings'>): void {
    const decision = decide(playerSettings(this.db), { userId: user.id, isAdmin: user.role === 'admin', settings: user.settings }, false);
    if (decision.denial === 'PLAYER_DISABLED') throw new AppAuthError('PLAYER_DISABLED', 'the player is turned off on this server (Settings → Player)');
    if (decision.denial) throw new AppAuthError('PLAYER_NOT_ALLOWED', 'your account may not use the player; ask an admin to allow it');
  }

  private server() {
    return { name: SERVER_NAME, version: VERSION };
  }

  /** Creates the device row and its token (returned once). */
  private issue(user: User, info: AppDeviceInfo, method: 'password' | 'pairing', ip: string | undefined): AppSignInResponse {
    const token = generateAppToken();
    const at = new Date(this.now()).toISOString();
    const row = this.db
      .insert(appDevices)
      .values({ userId: user.id, name: info.deviceName, platform: info.platform, appVersion: info.appVersion, tokenHash: hashToken(token), method, createdAt: at, lastSeenAt: at, lastIp: ip ?? null })
      .returning()
      .get();
    audit(this.db).record({ action: 'app.device.create', userId: user.id, username: user.username, ip: ip ?? null, target: String(row.id), details: { name: info.deviceName, platform: info.platform, appVersion: info.appVersion, method } });
    this.opts.log?.info({ userId: user.id, deviceId: row.id, platform: info.platform, method }, 'app device signed in');
    return { token, deviceId: row.id, user, server: this.server() };
  }

  /** POST /app/sign-in. */
  async signIn(input: AppDeviceInfo & { username: string; password: string; totp?: string | undefined; recoveryCode?: string | undefined }, ip?: string): Promise<AppSignInResponse> {
    const user = await this.auth.verifyAppSignIn(input, ip);
    this.assertPlayerAllowed(user);
    return this.issue(user, input, 'password', ip);
  }

  /** POST /app/pair-codes: a fresh one-time code for `userId` (replaces their previous one). */
  createPairCode(user: Pick<User, 'id' | 'role' | 'settings'>, fallbackOrigin: string): AppPairCode {
    this.assertPlayerAllowed(user);
    const t = this.now();
    this.purge(t);
    const recent = (this.issued.get(user.id) ?? []).filter((at) => t - at < PAIR_CODE_WINDOW_MS);
    if (recent.length >= PAIR_CODES_PER_WINDOW) throw new AppAuthError('RATE_LIMITED', 'too many sign-in codes; wait a few minutes');
    recent.push(t);
    this.issued.set(user.id, recent);
    for (const [code, pending] of this.codes) if (pending.userId === user.id) this.codes.delete(code);
    let code = generatePairCode();
    while (this.codes.has(code)) code = generatePairCode();
    const expiresAt = t + APP_PAIR_CODE_TTL_MS;
    this.codes.set(code, { userId: user.id, expiresAt });
    const serverUrl = this.opts.serverUrl() ?? fallbackOrigin.replace(/\/+$/, '');
    return { code, expiresAt: new Date(expiresAt).toISOString(), serverUrl, qr: appPairingUri(serverUrl, code) };
  }

  /** POST /app/pair: trades a code for a device token. Shares the failed sign-in limit per address. */
  pair(input: AppDeviceInfo & { code: string }, ip?: string): AppSignInResponse {
    const address = ip ?? 'unknown';
    this.auth.checkRateLimit(address);
    const t = this.now();
    const pending = this.codes.get(input.code);
    if (!pending) {
      this.auth.recordFailure(address);
      audit(this.db).record({ action: 'login.failed', ip: ip ?? null, details: { method: 'app-pairing' } });
      throw new AppAuthError('PAIR_CODE_INVALID', 'that code is not valid; make a new one in the web player');
    }
    // One try per code, right or not.
    this.codes.delete(input.code);
    if (pending.expiresAt <= t) throw new AppAuthError('PAIR_CODE_EXPIRED', 'that code has expired; make a new one in the web player');
    const row = this.db.select().from(users).where(eq(users.id, pending.userId)).get();
    if (!row) throw new AppAuthError('PAIR_CODE_INVALID', 'that code is not valid; make a new one in the web player');
    const user = toUser(row);
    this.assertPlayerAllowed(user);
    audit(this.db).record({ action: 'login.success', userId: user.id, username: user.username, ip: ip ?? null, details: { method: 'app-pairing' } });
    return this.issue(user, input, 'pairing', ip);
  }

  /** Expired codes go; issue timestamps outside the window go. */
  private purge(t: number): void {
    for (const [code, pending] of this.codes) if (pending.expiresAt + APP_PAIR_CODE_TTL_MS <= t) this.codes.delete(code);
    for (const [userId, list] of this.issued) {
      const left = list.filter((at) => t - at < PAIR_CODE_WINDOW_MS);
      if (left.length === 0) this.issued.delete(userId);
      else this.issued.set(userId, left);
    }
  }

  /** The auth hook's Bearer resolver: the token's user acting as themselves. */
  resolveBearer(token: string, creds: RequestCredentials): RequestAuth | null {
    const found = this.db
      .select({ device: appDevices, user: users })
      .from(appDevices)
      .innerJoin(users, eq(users.id, appDevices.userId))
      .where(eq(appDevices.tokenHash, hashToken(token)))
      .get();
    if (!found) return null;
    const t = this.now();
    if (t - Date.parse(found.device.lastSeenAt) > APP_DEVICE_TOUCH_MS) {
      const ip = creds.addresses.at(-1) ?? creds.peer ?? null;
      this.db.update(appDevices).set({ lastSeenAt: new Date(t).toISOString(), lastIp: ip }).where(eq(appDevices.id, found.device.id)).run();
    }
    const user = toUser(found.user);
    const isAdmin = user.role === 'admin';
    return { user, via: 'app', isAdmin, appAccess: effectiveAppAccess(user, isAdmin), appDeviceId: found.device.id };
  }

  private toResource(row: AppDeviceRow, currentId: number | undefined, userName?: string): AppDevice {
    return {
      id: row.id,
      userId: row.userId,
      ...(userName !== undefined ? { userName } : {}),
      name: row.name,
      platform: row.platform,
      appVersion: row.appVersion,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      lastIp: row.lastIp ?? null,
      method: row.method,
      current: row.id === currentId,
    };
  }

  list(userId: number, currentId?: number): AppDevice[] {
    return this.db
      .select()
      .from(appDevices)
      .where(eq(appDevices.userId, userId))
      .orderBy(appDevices.id)
      .all()
      .map((r) => this.toResource(r, currentId));
  }

  /** Admins: every device (`userId`: one user's), with the owner's username. */
  listAll(currentId: number | undefined, userId?: number): AppDevice[] {
    return this.db
      .select({ device: appDevices, userName: users.username })
      .from(appDevices)
      .innerJoin(users, eq(users.id, appDevices.userId))
      .where(userId === undefined ? undefined : eq(appDevices.userId, userId))
      .orderBy(appDevices.id)
      .all()
      .map((r) => this.toResource(r.device, currentId, r.userName));
  }

  /** Removes a device (own, or anyone's for admins); its token stops working at once. */
  remove(callerId: number | null, isAdmin: boolean, id: number): void {
    const row = this.db.select().from(appDevices).where(eq(appDevices.id, id)).get();
    // Someone else's device reads as missing to non-admins.
    if (!row || (!isAdmin && row.userId !== callerId)) throw new AppAuthError('NOT_FOUND', `app device ${id} not found`);
    this.db.delete(appDevices).where(eq(appDevices.id, id)).run();
  }

  /** POST /app/sign-out: the calling token's device. */
  signOut(userId: number, deviceId: number): void {
    this.db
      .delete(appDevices)
      .where(and(eq(appDevices.id, deviceId), eq(appDevices.userId, userId)))
      .run();
  }

  /** Every device of a user (password reset, role change, "sign out everywhere"). */
  revokeAll(userId: number): void {
    this.db.delete(appDevices).where(eq(appDevices.userId, userId)).run();
  }

  /** Whether the user has any signed-in app device (signed stream links stay valid while one does). */
  hasDevice(userId: number): boolean {
    return this.db.select({ id: appDevices.id }).from(appDevices).where(eq(appDevices.userId, userId)).limit(1).get() !== undefined;
  }
}

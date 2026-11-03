import { randomBytes, randomInt } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  APP_DEVICE_CODE_INTERVAL_SEC,
  APP_DEVICE_CODE_TTL_MS,
  APP_PAIR_CODE_ALPHABET,
  APP_PAIR_CODE_LENGTH,
  APP_PAIR_CODE_TTL_MS,
  APP_TOKEN_PREFIX,
  appPairingUri,
  type AppDevice,
  type AppDeviceCode,
  type AppDeviceCodePlatform,
  type AppDeviceCodePollResponse,
  type AppDeviceInfo,
  type AppPairCode,
  type AppSignInResponse,
  type User,
} from '@arclight/shared';
import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';
import { users } from '../auth/schema.js';
import { AuthError, effectiveAppAccess, hashToken, toUser, type AuthService, type RequestAuth, type RequestCredentials } from '../auth/service.js';
import { audit } from '../audit/recorder.js';
import { decide, playerSettings } from '../playback/access.js';
import { VERSION } from '../../version.js';
import { appDevices, type AppDeviceRow } from './schema.js';

// Device tokens for the Arclight player app: sign-in with a password (POST /app/sign-in), QR
// pairing from a signed-in browser (POST /app/pair-codes, then POST /app/pair), the Bearer
// resolver the auth hook calls, and device management. Pair codes live in memory only: they are
// valid for five minutes and once, so a restart simply asks for a new one.
//
// TV sign-in (device codes): the TV asks for a code (POST /app/device-codes, public, limited per
// address), shows it with <playerUrl>/link (the player address, else <serverUrl>/player/link) and polls with a secret poll token; a signed-in
// browser with player access approves the code (POST /app/device-codes/approve) and the next poll
// gets the device token, once. Device codes are in memory too (ten minutes, single use).

export type AppAuthErrorCode =
  | 'NO_USER'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'NOT_APP'
  | 'PAIR_CODE_INVALID'
  | 'PAIR_CODE_EXPIRED'
  | 'DEVICE_CODE_INVALID'
  | 'PLAYER_DISABLED'
  | 'PLAYER_NOT_ALLOWED'
  | 'INVALID_CREDENTIALS';

export const APP_AUTH_ERROR_STATUS: Record<AppAuthErrorCode, number> = {
  NO_USER: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  NOT_APP: 400,
  PAIR_CODE_INVALID: 401,
  PAIR_CODE_EXPIRED: 410,
  DEVICE_CODE_INVALID: 404,
  PLAYER_DISABLED: 403,
  PLAYER_NOT_ALLOWED: 403,
  // Not 401: the device token is fine, only the password typed to confirm it was wrong.
  INVALID_CREDENTIALS: 403,
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
/** An app device token unused for this long stops working and its device row is removed. */
export const APP_DEVICE_IDLE_MS = 90 * 24 * 60 * 60_000;
/** Pair codes one user may create per window (each new one replaces the previous). */
export const PAIR_CODES_PER_WINDOW = 10;
export const PAIR_CODE_WINDOW_MS = 10 * 60_000;
/** Device codes one address may ask for per window. */
export const DEVICE_CODES_PER_WINDOW = 10;
export const DEVICE_CODE_WINDOW_MS = 10 * 60_000;
/** At most this many device codes wait at once (a flood of requests cannot grow memory). */
export const MAX_PENDING_DEVICE_CODES = 500;
/** How long a password confirmed in the app (POST /app/reauth) lets that device write the command routes. */
export const APP_REAUTH_MS = 10 * 60_000;
/** At most this many devices hold a confirmation at once. */
export const MAX_APP_REAUTHS = 10_000;
/** Polls closer together than this answer 429. */
export const DEVICE_CODE_MIN_POLL_MS = 2_000;

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
  /**
   * The player address the owner set (Settings > Player > Player address), for TV sign-in's
   * `<playerUrl>/link`; null: none, so the TV's own address (or the Application URL) + /player.
   */
  verifyBase?: () => string | null;
  /** The server address the phone sign-in QR carries: a player hostname first; absent: `serverUrl`. */
  pairServerUrl?: () => string | undefined;
  log?: Logger;
  now?: () => number;
}

interface PendingCode {
  userId: number;
  expiresAt: number;
}

interface PendingDeviceCode {
  userCode: string;
  pollToken: string;
  deviceName: string;
  platform: AppDeviceCodePlatform;
  appVersion: string;
  expiresAt: number;
  lastPollAt: number;
  /** Set by approve; the next poll issues the token. */
  approvedUserId: number | null;
}

export class AppAuthService {
  private readonly db: Db;
  private readonly auth: AuthService;
  private readonly now: () => number;
  private readonly codes = new Map<string, PendingCode>();
  private readonly issued = new Map<number, number[]>();
  /** Device codes by user code, and the user code of each poll token. */
  private readonly deviceCodes = new Map<string, PendingDeviceCode>();
  private readonly pollTokens = new Map<string, string>();
  private readonly deviceCodeRequests = new Map<string, number[]>();
  /**
   * Devices that confirmed their password, until when. Keyed by id and creation time, so a removed
   * device whose id SQLite hands out again does not inherit it. In memory: a restart asks again.
   */
  private readonly reauths = new Map<string, number>();

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
  private issue(user: User, info: AppDeviceInfo, method: 'password' | 'pairing' | 'device-code', ip: string | undefined): AppSignInResponse {
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
    const serverUrl = (this.opts.pairServerUrl ?? this.opts.serverUrl)() ?? fallbackOrigin.replace(/\/+$/, '');
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

  // ---- TV sign-in ------------------------------------------------------------------------

  /** POST /app/device-codes: a code for the TV to show, and the secret it polls with. */
  createDeviceCode(input: { deviceName: string; platform: AppDeviceCodePlatform; appVersion: string; serverUrl?: string | undefined }, fallbackOrigin: string, ip?: string): AppDeviceCode {
    const t = this.now();
    this.purgeDeviceCodes(t);
    const address = ip ?? 'unknown';
    const recent = (this.deviceCodeRequests.get(address) ?? []).filter((at) => t - at < DEVICE_CODE_WINDOW_MS);
    if (recent.length >= DEVICE_CODES_PER_WINDOW) throw new AppAuthError('RATE_LIMITED', 'too many sign-in codes; wait a few minutes');
    // Full: the oldest code nobody approved yet makes room, so a flood cannot block every TV's
    // sign-in until the codes expire; approved codes wait for their device's next poll.
    if (this.deviceCodes.size >= MAX_PENDING_DEVICE_CODES) {
      const oldest = [...this.deviceCodes.values()].find((p) => p.approvedUserId === null);
      if (!oldest) throw new AppAuthError('RATE_LIMITED', 'too many sign-in codes; wait a few minutes');
      this.dropDeviceCode(oldest);
    }
    recent.push(t);
    this.deviceCodeRequests.set(address, recent);
    let userCode = generatePairCode();
    while (this.deviceCodes.has(userCode)) userCode = generatePairCode();
    const pollToken = randomBytes(32).toString('base64url');
    const expiresAt = t + APP_DEVICE_CODE_TTL_MS;
    this.deviceCodes.set(userCode, { userCode, pollToken, deviceName: input.deviceName, platform: input.platform, appVersion: input.appVersion, expiresAt, lastPollAt: 0, approvedUserId: null });
    this.pollTokens.set(pollToken, userCode);
    // The owner's player address wins over the address the TV used (a LAN IP, say).
    const player = this.opts.verifyBase?.() ?? null;
    const base = deviceServerUrl(input.serverUrl) ?? this.opts.serverUrl() ?? fallbackOrigin.replace(/\/+$/, '');
    return { userCode, pollToken, expiresAt: new Date(expiresAt).toISOString(), intervalSec: APP_DEVICE_CODE_INTERVAL_SEC, verifyUrl: `${player ?? `${base}/player`}/link` };
  }

  /** POST /app/device-codes/poll: pending, expired (or unknown), or the device token once approved. */
  pollDeviceCode(pollToken: string, ip?: string): AppDeviceCodePollResponse {
    const t = this.now();
    this.purgeDeviceCodes(t);
    const userCode = this.pollTokens.get(pollToken);
    const pending = userCode ? this.deviceCodes.get(userCode) : undefined;
    if (!pending || pending.expiresAt <= t) return { status: 'expired' };
    if (t - pending.lastPollAt < DEVICE_CODE_MIN_POLL_MS) throw new AppAuthError('RATE_LIMITED', `poll at most every ${APP_DEVICE_CODE_INTERVAL_SEC} seconds`);
    pending.lastPollAt = t;
    if (pending.approvedUserId === null) return { status: 'pending' };
    this.dropDeviceCode(pending);
    const row = this.db.select().from(users).where(eq(users.id, pending.approvedUserId)).get();
    if (!row) return { status: 'expired' };
    const user = toUser(row);
    this.assertPlayerAllowed(user);
    audit(this.db).record({ action: 'login.success', userId: user.id, username: user.username, ip: ip ?? null, details: { method: 'app-device-code' } });
    const info: AppDeviceInfo = { deviceName: pending.deviceName, platform: pending.platform === 'ios' ? 'ios' : 'android', appVersion: pending.appVersion };
    return { status: 'approved', ...this.issue(user, info, 'device-code', ip) };
  }

  /** POST /app/device-codes/approve: the signed-in user (with player access) claims the code. */
  approveDeviceCode(user: Pick<User, 'id' | 'role' | 'settings' | 'username'>, code: string, ip?: string): { deviceName: string; platform: AppDeviceCodePlatform } {
    this.assertPlayerAllowed(user);
    const address = ip ?? 'unknown';
    this.auth.checkRateLimit(address);
    const t = this.now();
    this.purgeDeviceCodes(t);
    const pending = this.deviceCodes.get(code);
    if (!pending || pending.expiresAt <= t || pending.approvedUserId !== null) {
      this.auth.recordFailure(address);
      throw new AppAuthError('DEVICE_CODE_INVALID', 'that code is not valid or has expired; check the code on the TV');
    }
    pending.approvedUserId = user.id;
    audit(this.db).record({ action: 'app.device-code.approve', userId: user.id, username: user.username, ip: ip ?? null, details: { name: pending.deviceName, platform: pending.platform } });
    return { deviceName: pending.deviceName, platform: pending.platform };
  }

  private dropDeviceCode(pending: PendingDeviceCode): void {
    this.deviceCodes.delete(pending.userCode);
    this.pollTokens.delete(pending.pollToken);
  }

  private purgeDeviceCodes(t: number): void {
    for (const pending of [...this.deviceCodes.values()]) if (pending.expiresAt <= t) this.dropDeviceCode(pending);
    for (const [address, list] of this.deviceCodeRequests) {
      const left = list.filter((at) => t - at < DEVICE_CODE_WINDOW_MS);
      if (left.length === 0) this.deviceCodeRequests.delete(address);
      else this.deviceCodeRequests.set(address, left);
    }
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
    // Idle too long: the device is signed out (a forgotten phone or TV does not stay a way in).
    if (t - Date.parse(found.device.lastSeenAt) > APP_DEVICE_IDLE_MS) {
      this.db.delete(appDevices).where(eq(appDevices.id, found.device.id)).run();
      audit(this.db).record({ action: 'app.device.expired', userId: found.user.id, username: found.user.username, details: { name: found.device.name, lastSeenAt: found.device.lastSeenAt } });
      return null;
    }
    if (t - Date.parse(found.device.lastSeenAt) > APP_DEVICE_TOUCH_MS) {
      const ip = creds.addresses.at(-1) ?? creds.peer ?? null;
      this.db.update(appDevices).set({ lastSeenAt: new Date(t).toISOString(), lastIp: ip }).where(eq(appDevices.id, found.device.id)).run();
    }
    const user = toUser(found.user);
    const isAdmin = user.role === 'admin';
    const reauthKey = `${found.device.id}:${found.device.createdAt}`;
    const confirmedUntil = this.reauths.get(reauthKey);
    if (confirmedUntil !== undefined && confirmedUntil <= t) this.reauths.delete(reauthKey);
    return {
      user,
      via: 'app',
      isAdmin,
      appAccess: effectiveAppAccess(user, isAdmin),
      appDeviceId: found.device.id,
      reauthenticated: confirmedUntil !== undefined && confirmedUntil > t,
      // The household profile the device selected (AuthService.resolve attaches and masks it).
      credentialProfileId: found.device.profileId ?? null,
      credentialCreatedAt: found.device.createdAt,
    };
  }

  /**
   * POST /app/reauth: the app's user types their password again; for APP_REAUTH_MS this device may
   * then write the command routes (backups and restores, VPN, solver and subtitle settings,
   * custom-script notifications). Rate-limited and audited like a sign-in.
   */
  async reauthenticate(auth: RequestAuth | null | undefined, password: string, ip: string): Promise<{ expiresAt: string }> {
    if (auth?.via !== 'app' || auth.appDeviceId === undefined || !auth.user) throw new AppAuthError('NOT_APP', 'this confirms an Arclight app device; in a browser, sign in again instead');
    const device = this.db.select().from(appDevices).where(eq(appDevices.id, auth.appDeviceId)).get();
    if (!device) throw new AppAuthError('NOT_FOUND', 'device not found');
    try {
      await this.auth.confirmPassword(auth, password, ip);
    } catch (err) {
      if (err instanceof AuthError && err.code === 'INVALID_CREDENTIALS') throw new AppAuthError('INVALID_CREDENTIALS', err.message);
      throw err;
    }
    const t = this.now();
    for (const [key, until] of this.reauths) if (until <= t) this.reauths.delete(key);
    while (this.reauths.size >= MAX_APP_REAUTHS) {
      const oldest = this.reauths.keys().next().value;
      if (oldest === undefined) break;
      this.reauths.delete(oldest);
    }
    const until = t + APP_REAUTH_MS;
    this.reauths.set(`${device.id}:${device.createdAt}`, until);
    audit(this.db).record({ action: 'app.device.reauth', userId: auth.user.id, username: auth.user.username, ip, target: String(device.id), details: { name: device.name } });
    return { expiresAt: new Date(until).toISOString() };
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

/** The address a device says it reached the server at, when it is a plain http(s) URL. */
export function deviceServerUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password || u.search || u.hash) return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

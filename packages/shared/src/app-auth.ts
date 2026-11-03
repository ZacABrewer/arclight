import { z } from 'zod';
import { User } from './auth.js';
import { MobilePlatform } from './mobile.js';

// Sign-in for the standalone Arclight player app (table `app_devices`). The app's UI is bundled
// in the app (origin capacitor://localhost on iOS, https://localhost on Android), so it cannot
// use the server's session cookie: it signs in once (password, or a QR pairing code from the web
// player) and gets a device token it sends as `Authorization: Bearer <token>`. Only the sha256
// of a token is stored; the token itself is returned once. Removing the device ends the token.

/** Prefix of every device token (`alt_` + 43 base64url characters). */
export const APP_TOKEN_PREFIX = 'alt_';

/** Pair codes: 8 characters from an alphabet without look-alikes (no 0/O, 1/I/L). */
export const APP_PAIR_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const APP_PAIR_CODE_LENGTH = 8;
/** A pair code is valid this long, and only once. */
export const APP_PAIR_CODE_TTL_MS = 5 * 60_000;

/** Upper-cases a typed code and drops spaces and dashes ("abcd-efgh" → "ABCDEFGH"). */
export function normalisePairCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]+/g, '');
}

/** "ABCDEFGH" → "ABCD-EFGH" (how the web shows it; the app accepts either). */
export function formatPairCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

export const AppPairCodeValue = z
  .string()
  .max(20)
  .transform(normalisePairCode)
  .pipe(z.string().regex(new RegExp(`^[${APP_PAIR_CODE_ALPHABET}]{${APP_PAIR_CODE_LENGTH}}$`), 'not a pair code'));

/** What the QR code in the web player encodes: the app opens it, connects to `server` and pairs with `code`. */
export function appPairingUri(serverUrl: string, code: string): string {
  return `arclight://pair?server=${encodeURIComponent(serverUrl)}&code=${encodeURIComponent(code)}`;
}

/** Reads an `arclight://pair?server=…&code=…` link; null for anything else. */
export function parseAppPairingUri(uri: string): { server: string; code: string } | null {
  const m = /^arclight:\/\/pair\?(.*)$/i.exec(uri.trim());
  if (!m) return null;
  const params = new URLSearchParams(m[1]);
  const server = params.get('server');
  const code = params.get('code');
  if (!server || !code) return null;
  return { server, code: normalisePairCode(code) };
}

export const AppPlatform = MobilePlatform;
export type AppPlatform = z.infer<typeof AppPlatform>;

/** The device part of a sign-in or pairing. */
export const AppDeviceInfo = z.object({
  deviceName: z.string().trim().min(1).max(100),
  platform: AppPlatform,
  appVersion: z.string().trim().min(1).max(40),
});
export type AppDeviceInfo = z.infer<typeof AppDeviceInfo>;

/**
 * POST /api/v1/app/sign-in. `totp`: the authenticator code when the account has two-factor on
 * (the first try without it answers 401 TOTP_REQUIRED); `recoveryCode` instead of `totp` uses up
 * a recovery code.
 */
export const AppSignInRequest = AppDeviceInfo.extend({
  username: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(1000),
  totp: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'six digits')
    .optional(),
  recoveryCode: z.string().trim().min(1).max(100).optional(),
});
export type AppSignInRequest = z.input<typeof AppSignInRequest>;

/** POST /api/v1/app/pair: a code from POST /app/pair-codes (shown as a QR code in the web player). */
export const AppPairRequest = AppDeviceInfo.extend({ code: AppPairCodeValue });
export type AppPairRequest = z.input<typeof AppPairRequest>;

export const AppServerInfo = z.object({ name: z.string(), version: z.string() });
export type AppServerInfo = z.infer<typeof AppServerInfo>;

/** Answer of sign-in and pairing. `token` is shown only here; `user` is what GET /user/me returns. */
export const AppSignInResponse = z.object({
  token: z.string(),
  deviceId: z.number().int(),
  user: User,
  server: AppServerInfo,
});
export type AppSignInResponse = z.infer<typeof AppSignInResponse>;

/** POST /api/v1/app/pair-codes (signed-in web user). */
export const AppPairCode = z.object({
  code: z.string(),
  expiresAt: z.string(),
  /** The server address the app should connect to (Application URL, else the request's origin). */
  serverUrl: z.string(),
  /** `arclight://pair?server=<serverUrl>&code=<code>`: what the QR code holds. */
  qr: z.string(),
});
export type AppPairCode = z.infer<typeof AppPairCode>;

/** A signed-in app install (GET /api/v1/app/devices). */
export const AppDevice = z.object({
  id: z.number().int(),
  userId: z.number().int(),
  /** Admin listings (`?all=true`, `?userId=`): the owner's username. */
  userName: z.string().optional(),
  name: z.string(),
  platform: AppPlatform,
  appVersion: z.string(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  lastIp: z.string().nullable(),
  /** `password` or `pairing`. */
  method: z.enum(['password', 'pairing']),
  /** The request was made with this device's token. */
  current: z.boolean(),
});
export type AppDevice = z.infer<typeof AppDevice>;

export const AppDeviceListQuery = z.object({
  /** Admins: every user's devices. */
  all: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  /** Admins: one user's devices. */
  userId: z.coerce.number().int().positive().optional(),
});

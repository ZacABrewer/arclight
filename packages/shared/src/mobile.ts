import { z } from 'zod';

// Arclight Admin (the companion app, apps/mobile): phones paired with this server (table `mobile_devices`). The app's
// native shell registers with the push relay and hands the server a relay device id plus a
// per-device relay secret; the server keeps the secret (it never leaves the server again) and
// sends notifications through the relay with it. Preferences are the web push ones
// (PushPreferences, `users.settings.notifications.push`).

export const MOBILE_PLATFORMS = ['ios', 'android'] as const;
export const MobilePlatform = z.enum(MOBILE_PLATFORMS);
export type MobilePlatform = z.infer<typeof MobilePlatform>;

/** The default push relay; `ARCLIGHT_PUSH_RELAY_URL` overrides it, `ARCLIGHT_PUSH_RELAY=off` disables mobile push. */
export const DEFAULT_PUSH_RELAY_URL = 'https://arclight-push.moviemethat.com';

/** Where the "Get the app" links point until the store listings exist. */
export const MOBILE_APP_URL = 'https://arclight.moviemethat.com/';

/** What the QR code in the web UI encodes: the app opens it and connects to `serverUrl`. */
export function mobilePairingUri(serverUrl: string): string {
  return `arclight-admin://pair?url=${encodeURIComponent(serverUrl)}`;
}

/** App IDs (iOS bundle ID / Android application ID) of the Arclight apps that register for push. */
export const MOBILE_ADMIN_APP_ID = 'com.moviemethat.arclight.admin';
export const MOBILE_PLAYER_APP_ID = 'com.moviemethat.arclight';
/** Reverse-DNS app id as the push relay accepts it. */
export const MOBILE_APP_ID_RE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/** Body of POST /mobile/devices: the app's `ArclightShell.registerPush()` result plus its version. */
export const MobileDeviceInput = z.object({
  relayDeviceId: z.string().trim().min(1).max(200),
  relaySecret: z.string().min(16).max(512),
  platform: MobilePlatform,
  deviceName: z.string().trim().max(200).default(''),
  appVersion: z.string().trim().max(64).optional(),
  /**
   * Bundle ID / application ID of the app that registered. The relay uses it as the APNs topic.
   * Older apps do not send it; the relay then assumes Arclight Admin (MOBILE_ADMIN_APP_ID).
   */
  appId: z.string().trim().max(155).regex(MOBILE_APP_ID_RE).optional(),
});
export type MobileDeviceInput = z.infer<typeof MobileDeviceInput>;

/** A paired device as the api returns it. The relay secret is never part of it. */
export const MobileDeviceResource = z.object({
  id: z.number().int(),
  userId: z.number().int(),
  /** Owner's display name or username (admin list). */
  userName: z.string().optional(),
  relayDeviceId: z.string(),
  platform: MobilePlatform,
  deviceName: z.string(),
  appVersion: z.string().optional(),
  /** Bundle ID of the app on this device, when the app reported it. */
  appId: z.string().optional(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  /** Last delivery problem (rate limited, relay unreachable…); cleared by the next success. */
  lastError: z.string().optional(),
});
export type MobileDeviceResource = z.infer<typeof MobileDeviceResource>;

export const MobileDeviceListQuery = z.object({
  /** Admins only: every user's devices. */
  all: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
export type MobileDeviceListQuery = z.infer<typeof MobileDeviceListQuery>;

/** GET /mobile/pairing: what the "Mobile app" section needs. */
export const MobilePairingInfo = z.object({
  /** Application URL (Settings → Requests) when set; null: the web UI uses its own origin. */
  serverUrl: z.string().nullable(),
  /** False when the server runs with ARCLIGHT_PUSH_RELAY=off. */
  pushEnabled: z.boolean(),
});
export type MobilePairingInfo = z.infer<typeof MobilePairingInfo>;

export const MobileTestResult = z.object({
  ok: z.boolean(),
  /** 'sent' | 'removed' (device gone, row deleted) | 'rate_limited' | 'failed' | 'disabled'. */
  outcome: z.enum(['sent', 'removed', 'rate_limited', 'failed', 'disabled']),
  message: z.string().optional(),
});
export type MobileTestResult = z.infer<typeof MobileTestResult>;

/** The body of the relay's POST /v1/send (the relay never stores it). */
export interface RelaySendBody {
  deviceId: string;
  title: string;
  body: string;
  data?: { url?: string; server?: string; [k: string]: string | undefined };
  badge?: number;
  threadId?: string;
  /** Bundle ID of the receiving app (APNs topic); omitted for devices registered without one. */
  appId?: string;
}

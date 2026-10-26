import { z } from 'zod';

// Web push (browser notifications): VAPID public key, per-user subscriptions (table
// `push_subscriptions`) and per-user preferences stored in `users.settings.notifications.push`.

export const PushPublicKey = z.object({
  /** Uncompressed P-256 point, base64url: pass to PushManager.subscribe({ applicationServerKey }). */
  publicKey: z.string(),
});
export type PushPublicKey = z.infer<typeof PushPublicKey>;

/** What PushSubscription.toJSON() gives the browser, plus the user agent. */
export const PushSubscriptionInput = z.object({
  endpoint: z.url().max(2048),
  expirationTime: z.number().nullish(),
  keys: z.object({
    /** Client public key, base64url (65 bytes). */
    p256dh: z.string().min(80).max(100),
    /** Auth secret, base64url (16 bytes). */
    auth: z.string().min(16).max(32),
  }),
  userAgent: z.string().max(512).optional(),
});
export type PushSubscriptionInput = z.infer<typeof PushSubscriptionInput>;

export const PushSubscriptionDelete = z.object({ endpoint: z.string().min(1).max(2048) });
export type PushSubscriptionDelete = z.infer<typeof PushSubscriptionDelete>;

export const PushSubscriptionResource = z.object({
  id: z.number().int(),
  endpoint: z.string(),
  userAgent: z.string().optional(),
  createdAt: z.string(),
});
export type PushSubscriptionResource = z.infer<typeof PushSubscriptionResource>;

/** Which events reach this user's browsers. */
export const PushPreferences = z.object({
  /** Requests: new requests (managers), approved / declined / failed (requester). */
  requests: z.boolean().default(true),
  /** Requested titles became available or got new files. */
  availability: z.boolean().default(true),
  /** Issues: new issues (managers), updates to issues you reported. */
  issues: z.boolean().default(true),
});
export type PushPreferences = z.infer<typeof PushPreferences>;

/** The JSON a push carries; the service worker shows it and opens `url` on click. */
export const PushPayload = z.object({
  title: z.string(),
  body: z.string().optional(),
  /** In-app deep link, e.g. `/requests` or `/library/movie/12`. */
  url: z.string().optional(),
  /** Notifications with the same tag replace each other. */
  tag: z.string().optional(),
});
export type PushPayload = z.infer<typeof PushPayload>;

export const PushTestResult = z.object({
  sent: z.number().int(),
  failed: z.number().int(),
  removed: z.number().int(),
});
export type PushTestResult = z.infer<typeof PushTestResult>;

import { byteLength } from "./crypto";
import { HttpError } from "./http";
import type { Notification } from "./provider";

export type Platform = "ios" | "android";

export const LIMITS = {
  title: 200,
  body: 1000,
  dataBytes: 2048,
  threadId: 64,
  appVersion: 64,
  appId: 155,
  badgeMax: 99_999,
} as const;

/** deviceId: 128 random bits, base64url without padding (22 characters). */
export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** App id: reverse-DNS bundle ID / application ID, e.g. com.moviemethat.arclight.admin. */
export const APP_ID_RE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

export function validAppId(v: unknown): v is string {
  return typeof v === "string" && v.length <= LIMITS.appId && APP_ID_RE.test(v);
}

export function isPlatform(v: unknown): v is Platform {
  return v === "ios" || v === "android";
}

/** APNs tokens are hex (64 characters today); FCM tokens are URL-safe text up to a few hundred bytes. */
export function validToken(platform: Platform, token: unknown): token is string {
  if (typeof token !== "string") return false;
  if (platform === "ios") return /^[0-9a-fA-F]{32,200}$/.test(token);
  return /^[A-Za-z0-9_:.\-]{20,4096}$/.test(token);
}

/** Keys that APNs or FCM reserve and that must not appear in `data`. */
function reservedDataKey(k: string): boolean {
  return (
    k === "aps" ||
    k === "from" ||
    k === "notification" ||
    k === "message_type" ||
    k === "collapse_key" ||
    k.startsWith("google.") ||
    k.startsWith("gcm.")
  );
}

function bad(message: string): never {
  throw new HttpError(400, message);
}

export interface SendRequest extends Notification {
  deviceId: string;
  /** App id the server has on record for the device; used when the device registered without one. */
  appId?: string;
}

export function parseSend(body: Record<string, unknown>): SendRequest {
  const { deviceId, title, body: text, data, badge, threadId, appId } = body;
  if (typeof deviceId !== "string" || deviceId.length === 0 || deviceId.length > 64) bad("deviceId is required");
  if (typeof title !== "string") bad("title must be a string");
  if (typeof text !== "string") bad("body must be a string");
  if (title.length > LIMITS.title) bad(`title exceeds ${LIMITS.title} characters`);
  if (text.length > LIMITS.body) bad(`body exceeds ${LIMITS.body} characters`);
  if (title.length === 0 && text.length === 0) bad("title or body is required");

  const out: SendRequest = { deviceId, title, body: text };

  if (data !== undefined && data !== null) {
    if (typeof data !== "object" || Array.isArray(data)) bad("data must be an object of strings");
    const entries = Object.entries(data as Record<string, unknown>);
    for (const [k, v] of entries) {
      if (typeof v !== "string") bad("data values must be strings");
      if (k.length === 0 || reservedDataKey(k)) bad(`data key not allowed: ${k.slice(0, 32)}`);
    }
    if (byteLength(JSON.stringify(data)) > LIMITS.dataBytes) bad(`data exceeds ${LIMITS.dataBytes} bytes`);
    if (entries.length > 0) out.data = data as Record<string, string>;
  }
  if (badge !== undefined && badge !== null) {
    if (typeof badge !== "number" || !Number.isInteger(badge) || badge < 0 || badge > LIMITS.badgeMax) {
      bad("badge must be a non-negative integer");
    }
    out.badge = badge;
  }
  if (threadId !== undefined && threadId !== null) {
    if (typeof threadId !== "string" || !/^[A-Za-z0-9_.:\-]{1,64}$/.test(threadId)) {
      bad(`threadId must be 1-${LIMITS.threadId} characters of A-Z a-z 0-9 _ . : -`);
    }
    out.threadId = threadId;
  }
  if (appId !== undefined && appId !== null) {
    if (!validAppId(appId)) bad("invalid appId");
    out.appId = appId;
  }
  return out;
}

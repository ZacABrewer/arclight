// Apple Push Notification service, token-based (JWT, ES256) provider authentication.
// https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns
//
// APNs speaks HTTP/2 only. workerd itself has no HTTP/2 client, but in production Workers
// subrequests leave through Cloudflare's proxy stack, which negotiates HTTP/2 with the origin, so a
// plain fetch() reaches APNs. This is observed behaviour, not documented by Cloudflare: see
// README.md, "APNs and HTTP/2", and the APNS_*_ORIGIN overrides for the fallback.

import type { Env } from "./env";
import { base64url, base64urlJson, byteLength, pemToDer, utf8 } from "./crypto";
import { MAX_PAYLOAD_BYTES, type Notification, type SendResult } from "./provider";

export const APNS_PRODUCTION = "https://api.push.apple.com";
export const APNS_SANDBOX = "https://api.sandbox.push.apple.com";
/** Arclight Admin (the companion app); also the topic for registrations without an appId. */
export const ADMIN_TOPIC = "com.moviemethat.arclight.admin";
/** Arclight, the player app. */
export const PLAYER_TOPIC = "com.moviemethat.arclight";
export const DEFAULT_TOPICS = [ADMIN_TOPIC, PLAYER_TOPIC] as const;
/** Apple accepts a provider token for up to 60 minutes and rejects refreshes more often than every 20. */
const JWT_TTL_MS = 50 * 60 * 1000;

export type ApnsEnvironment = "production" | "sandbox";

export function apnsConfigured(env: Env): boolean {
  return Boolean(env.APNS_KEY_P8 && env.APNS_KEY_ID && env.APNS_TEAM_ID);
}

/**
 * The APNs topics this relay sends for, default first: APNS_TOPICS (comma-separated), else the
 * older single APNS_TOPIC, else DEFAULT_TOPICS. One .p8 key covers every app of the team.
 */
export function apnsTopics(env: Env): string[] {
  const list = (env.APNS_TOPICS ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (list.length > 0) return [...new Set(list)];
  const single = env.APNS_TOPIC?.trim();
  return single ? [single] : [...DEFAULT_TOPICS];
}

/**
 * The topic for a device: its app id when that is allowed, the default topic when it has none,
 * undefined when the app id is not in the allow-list.
 */
export function resolveTopic(env: Env, appId: string | null | undefined): string | undefined {
  const topics = apnsTopics(env);
  if (!appId) return topics[0];
  return topics.includes(appId) ? appId : undefined;
}

interface CachedJwt {
  cacheKey: string;
  jwt: string;
  issuedAt: number;
}
let cachedKey: { pem: string; key: CryptoKey } | undefined;
let cachedJwt: CachedJwt | undefined;

/** Test hook: forget cached keys and tokens. */
export function resetApnsCache(): void {
  cachedKey = undefined;
  cachedJwt = undefined;
}

async function signingKey(pem: string): Promise<CryptoKey> {
  if (cachedKey?.pem === pem) return cachedKey.key;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(pem),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  cachedKey = { pem, key };
  return key;
}

export async function apnsJwt(env: Env, now = Date.now()): Promise<string> {
  const keyId = env.APNS_KEY_ID!;
  const teamId = env.APNS_TEAM_ID!;
  const cacheKey = `${teamId}.${keyId}`;
  if (cachedJwt && cachedJwt.cacheKey === cacheKey && now - cachedJwt.issuedAt < JWT_TTL_MS) {
    return cachedJwt.jwt;
  }
  const key = await signingKey(env.APNS_KEY_P8!);
  const signingInput = `${base64urlJson({ alg: "ES256", kid: keyId })}.${base64urlJson({
    iss: teamId,
    iat: Math.floor(now / 1000),
  })}`;
  // WebCrypto ECDSA returns the raw r||s signature, which is exactly the JWS ES256 format.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(signingInput));
  const jwt = `${signingInput}.${base64url(sig)}`;
  cachedJwt = { cacheKey, jwt, issuedAt: now };
  return jwt;
}

export function apnsPayload(n: Notification): string {
  const aps: Record<string, unknown> = {
    alert: { title: n.title, body: n.body },
    sound: "default",
  };
  if (n.badge !== undefined) aps.badge = n.badge;
  if (n.threadId !== undefined) aps["thread-id"] = n.threadId;
  return JSON.stringify({ ...(n.data ?? {}), aps });
}

/** APNs `reason` values that mean the token will never work again for this app. */
const DEAD_TOKEN_REASONS = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"]);

export async function sendApns(
  env: Env,
  token: string,
  environment: ApnsEnvironment,
  topic: string,
  n: Notification,
): Promise<SendResult> {
  const payload = apnsPayload(n);
  if (byteLength(payload) > MAX_PAYLOAD_BYTES) return { kind: "too-large", reason: "PayloadTooLarge" };

  const origin =
    environment === "sandbox"
      ? env.APNS_SANDBOX_ORIGIN || APNS_SANDBOX
      : env.APNS_PRODUCTION_ORIGIN || APNS_PRODUCTION;
  const url = `${origin}/3/device/${encodeURIComponent(token)}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const headers: Record<string, string> = {
      authorization: `bearer ${await apnsJwt(env)}`,
      "apns-topic": topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    };
    if (n.threadId !== undefined) headers["apns-collapse-id"] = n.threadId;

    const res = await fetch(url, { method: "POST", headers, body: payload });
    if (res.status === 200) {
      await res.body?.cancel();
      return { kind: "ok" };
    }
    const reason = await readReason(res);
    if (res.status === 410 || DEAD_TOKEN_REASONS.has(reason)) return { kind: "invalid-token", reason: reason || "Unregistered" };
    if (res.status === 413 || reason === "PayloadTooLarge") return { kind: "too-large", reason: "PayloadTooLarge" };
    if (res.status === 403 && reason === "ExpiredProviderToken" && attempt === 0) {
      cachedJwt = undefined;
      continue;
    }
    return { kind: "error", status: res.status, reason: reason || `HTTP ${res.status}`, retryAfter: res.headers.get("retry-after") ?? undefined };
  }
  return { kind: "error", status: 403, reason: "ExpiredProviderToken" };
}

async function readReason(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { reason?: unknown };
    return typeof body.reason === "string" ? body.reason : "";
  } catch {
    return "";
  }
}

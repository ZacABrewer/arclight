// Firebase Cloud Messaging HTTP v1, authenticated with a service-account OAuth2 token (JWT, RS256).
// https://firebase.google.com/docs/cloud-messaging/send/v1-api

import type { Env } from "./env";
import { base64url, base64urlJson, byteLength, pemToDer, utf8 } from "./crypto";
import { MAX_PAYLOAD_BYTES, type Notification, type SendResult } from "./provider";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  private_key_id?: string;
}

export function parseServiceAccount(env: Env): ServiceAccount | undefined {
  if (!env.FCM_SERVICE_ACCOUNT_JSON) return undefined;
  try {
    const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON) as Partial<ServiceAccount>;
    if (typeof sa.project_id === "string" && typeof sa.client_email === "string" && typeof sa.private_key === "string") {
      return sa as ServiceAccount;
    }
  } catch {
    // fall through
  }
  return undefined;
}

export function fcmConfigured(env: Env): boolean {
  return parseServiceAccount(env) !== undefined;
}

let cachedKey: { pem: string; key: CryptoKey } | undefined;
let cachedToken: { email: string; token: string; expiresAt: number } | undefined;

/** Test hook: forget cached keys and tokens. */
export function resetFcmCache(): void {
  cachedKey = undefined;
  cachedToken = undefined;
}

async function signingKey(pem: string): Promise<CryptoKey> {
  if (cachedKey?.pem === pem) return cachedKey.key;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  cachedKey = { pem, key };
  return key;
}

export async function serviceAccountJwt(sa: ServiceAccount, now = Date.now()): Promise<string> {
  const iat = Math.floor(now / 1000);
  const header: Record<string, string> = { alg: "RS256", typ: "JWT" };
  if (sa.private_key_id) header.kid = sa.private_key_id;
  const signingInput = `${base64urlJson(header)}.${base64urlJson({
    iss: sa.client_email,
    scope: FCM_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat,
    exp: iat + 3600,
  })}`;
  const key = await signingKey(sa.private_key);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, utf8(signingInput));
  return `${signingInput}.${base64url(sig)}`;
}

class TokenError extends Error {
  constructor(readonly status: number) {
    super(`oauth token exchange failed: HTTP ${status}`);
  }
}

async function accessToken(sa: ServiceAccount, now = Date.now()): Promise<string> {
  if (cachedToken && cachedToken.email === sa.client_email && now < cachedToken.expiresAt) {
    return cachedToken.token;
  }
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: await serviceAccountJwt(sa, now),
    }),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new TokenError(res.status);
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new TokenError(502);
  const lifetimeS = typeof body.expires_in === "number" ? body.expires_in : 3600;
  // Refresh five minutes early.
  cachedToken = { email: sa.client_email, token: body.access_token, expiresAt: now + Math.max(60, lifetimeS - 300) * 1000 };
  return body.access_token;
}

export function fcmMessage(token: string, n: Notification): string {
  const notification: Record<string, unknown> = { channel_id: n.data?.channel || "general" };
  if (n.threadId !== undefined) notification.tag = n.threadId;
  if (n.badge !== undefined) notification.notification_count = n.badge;
  const message: Record<string, unknown> = {
    token,
    notification: { title: n.title, body: n.body },
    android: { priority: "high", notification },
  };
  if (n.data && Object.keys(n.data).length > 0) message.data = n.data;
  return JSON.stringify({ message });
}

interface FcmErrorBody {
  error?: {
    status?: string;
    message?: string;
    details?: Array<{
      "@type"?: string;
      errorCode?: string;
      fieldViolations?: Array<{ field?: string }>;
    }>;
  };
}

export async function sendFcm(env: Env, token: string, n: Notification): Promise<SendResult> {
  const sa = parseServiceAccount(env);
  if (!sa) return { kind: "error", status: 503, reason: "not configured" };

  const message = fcmMessage(token, n);
  if (byteLength(message) > MAX_PAYLOAD_BYTES + 512) return { kind: "too-large", reason: "PayloadTooLarge" };
  const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`;

  for (let attempt = 0; attempt < 2; attempt++) {
    let bearer: string;
    try {
      bearer = await accessToken(sa);
    } catch (e) {
      return { kind: "error", status: 502, reason: e instanceof TokenError ? `oauth HTTP ${e.status}` : "oauth failed" };
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: message,
    });
    if (res.ok) {
      await res.body?.cancel();
      return { kind: "ok" };
    }
    let body: FcmErrorBody = {};
    try {
      body = (await res.json()) as FcmErrorBody;
    } catch {
      // non-JSON error
    }
    const err = body.error ?? {};
    const codes = (err.details ?? []).map((d) => d.errorCode).filter((c): c is string => typeof c === "string");
    const tokenField = (err.details ?? []).some((d) => (d.fieldViolations ?? []).some((f) => f.field === "message.token"));

    if (codes.includes("UNREGISTERED") || (res.status === 404 && err.status === "NOT_FOUND")) {
      return { kind: "invalid-token", reason: "UNREGISTERED" };
    }
    // INVALID_ARGUMENT is also used for bad payloads, so only treat it as a dead token when FCM
    // points at the token (a field violation on message.token, or its "not a valid FCM
    // registration token" message).
    if (
      (codes.includes("INVALID_ARGUMENT") || err.status === "INVALID_ARGUMENT") &&
      (tokenField || /registration token/i.test(err.message ?? ""))
    ) {
      return { kind: "invalid-token", reason: "INVALID_ARGUMENT" };
    }
    if (res.status === 401 && attempt === 0) {
      cachedToken = undefined;
      continue;
    }
    return {
      kind: "error",
      status: res.status,
      reason: codes[0] ?? err.status ?? `HTTP ${res.status}`,
      retryAfter: res.headers.get("retry-after") ?? undefined,
    };
  }
  return { kind: "error", status: 401, reason: "UNAUTHENTICATED" };
}

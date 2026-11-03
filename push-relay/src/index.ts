// Arclight push relay. See README.md for the API contract and the privacy guarantees.
//
// Privacy rules this file must keep:
//  - Notification title/body/data are never written to D1 and never logged.
//  - Device tokens, device IDs and secrets are never logged.
//  - The secret is stored only as a SHA-256 hash.

import { apnsConfigured, resolveTopic, sendApns, type ApnsEnvironment } from "./apns";
import { randomBase64url, sha256Hex, timingSafeEqualStr } from "./crypto";
import type { Env } from "./env";
import { fcmConfigured, sendFcm } from "./fcm";
import {
  HttpError,
  bearer,
  clientIp,
  corsHeaders,
  empty,
  error,
  json,
  readJsonObject,
  withHeaders,
} from "./http";
import type { SendResult } from "./provider";
import { DEVICE_ID_RE, isPlatform, parseSend, validAppId, validToken, type Platform } from "./validate";

export type { Env } from "./env";

/** Per-device send limit: token bucket of 10, refilled at one per minute (60/hour, burst 10). */
export const SEND_BUCKET_CAPACITY = 10;
export const SEND_REFILL_MS = 60_000;
/** Devices with no use for this long are deleted by the daily cron. */
export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

interface DeviceRow {
  device_id: string;
  platform: Platform;
  token: string;
  secret_hash: string;
  environment: ApnsEnvironment;
  app_id: string | null;
  send_tokens: number;
  send_refill_at: number;
}

// A fixed hash compared against when the device does not exist, so unknown-device and
// wrong-secret requests take the same path.
const DUMMY_HASH = "0".repeat(64);

function providerConfigured(env: Env, platform: Platform): boolean {
  return platform === "ios" ? apnsConfigured(env) : fcmConfigured(env);
}

async function rateLimited(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) return false;
  const { success } = await limiter.limit({ key });
  return !success;
}

const tooMany = (retryAfterS: number) =>
  error(429, "rate limited", { "retry-after": String(Math.max(1, Math.ceil(retryAfterS))) });

/** Looks up a device and checks the bearer secret in constant time. Undefined means "404". */
async function authenticate(env: Env, deviceId: string, secret: string): Promise<DeviceRow | undefined> {
  const row = DEVICE_ID_RE.test(deviceId)
    ? await env.DB.prepare(
        "SELECT device_id, platform, token, secret_hash, environment, app_id, send_tokens, send_refill_at FROM devices WHERE device_id = ?",
      )
        .bind(deviceId)
        .first<DeviceRow>()
    : null;
  const presented = await sha256Hex(secret);
  const ok = timingSafeEqualStr(presented, row?.secret_hash ?? DUMMY_HASH);
  return row && ok ? row : undefined;
}

async function deleteDevice(env: Env, deviceId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM devices WHERE device_id = ?").bind(deviceId).run();
}

// ---------------------------------------------------------------------------------------------
// POST /v1/devices

async function registerDevice(request: Request, env: Env): Promise<Response> {
  if (await rateLimited(env.REGISTER_LIMITER, `register:${clientIp(request)}`)) return tooMany(60);

  const body = await readJsonObject(request);
  const { token, platform, appVersion, environment, appId } = body;
  if (!isPlatform(platform)) return error(400, "platform must be 'ios' or 'android'");
  if (!validToken(platform, token)) return error(400, "invalid token");
  if (appVersion !== undefined && appVersion !== null) {
    if (typeof appVersion !== "string" || !/^[\x20-\x7e]{1,64}$/.test(appVersion)) {
      return error(400, "invalid appVersion");
    }
  }
  if (environment !== undefined && environment !== null && environment !== "production" && environment !== "sandbox") {
    return error(400, "environment must be 'production' or 'sandbox'");
  }
  // appId picks the APNs topic, so on iOS it must be one this relay sends for (APNS_TOPICS).
  // FCM does not use it (the Firebase project covers its apps); it is only checked for shape.
  let appId_: string | null = null;
  if (appId !== undefined && appId !== null) {
    if (!validAppId(appId)) return error(400, "invalid appId");
    if (platform === "ios" && !resolveTopic(env, appId)) return error(400, "appId not allowed");
    appId_ = appId;
  }
  // The APNs environment only matters for iOS; FCM has no sandbox.
  const env_: ApnsEnvironment = platform === "ios" && environment === "sandbox" ? "sandbox" : "production";

  const deviceId = randomBase64url(16); // 128 bits
  const secret = randomBase64url(32); // 256 bits
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO devices (device_id, platform, token, secret_hash, app_version, environment, app_id, created_at, last_used_at, send_tokens, send_refill_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(deviceId, platform, token, await sha256Hex(secret), (appVersion as string | undefined) ?? null, env_, appId_, now, now, SEND_BUCKET_CAPACITY, now)
    .run();
  return json(201, { deviceId, secret });
}

// ---------------------------------------------------------------------------------------------
// PUT /v1/devices/:deviceId

async function updateDevice(request: Request, env: Env, deviceId: string): Promise<Response> {
  if (await rateLimited(env.DEVICE_LIMITER, `device:${clientIp(request)}`)) return tooMany(60);
  const secret = bearer(request);
  if (!secret) return error(401, "unauthorized");
  const body = await readJsonObject(request);
  const device = await authenticate(env, deviceId, secret);
  if (!device) return error(404, "not found");
  if (!validToken(device.platform, body.token)) return error(400, "invalid token");
  await env.DB.prepare("UPDATE devices SET token = ?, last_used_at = ? WHERE device_id = ?")
    .bind(body.token, Date.now(), device.device_id)
    .run();
  return empty(204);
}

// ---------------------------------------------------------------------------------------------
// DELETE /v1/devices/:deviceId

async function unregisterDevice(request: Request, env: Env, deviceId: string): Promise<Response> {
  if (await rateLimited(env.DEVICE_LIMITER, `device:${clientIp(request)}`)) return tooMany(60);
  const secret = bearer(request);
  if (!secret) return error(401, "unauthorized");
  const exists = DEVICE_ID_RE.test(deviceId)
    ? await env.DB.prepare("SELECT 1 AS x FROM devices WHERE device_id = ?").bind(deviceId).first()
    : null;
  if (!exists) return empty(204); // already gone
  const device = await authenticate(env, deviceId, secret);
  if (!device) return error(404, "not found");
  await deleteDevice(env, device.device_id);
  return empty(204);
}

// ---------------------------------------------------------------------------------------------
// POST /v1/send

/**
 * Atomically takes one token from the device's bucket and marks the device used. Returns the
 * number of seconds to wait when the bucket is empty, or 0 on success.
 */
async function consumeSendToken(env: Env, device: DeviceRow, now: number): Promise<number> {
  const level = `MIN(${SEND_BUCKET_CAPACITY}.0, send_tokens + MAX(0, ?1 - send_refill_at) / ${SEND_REFILL_MS}.0)`;
  const taken = await env.DB.prepare(
    `UPDATE devices
        SET send_tokens = ${level} - 1,
            send_refill_at = MAX(send_refill_at, ?1),
            last_used_at = ?1
      WHERE device_id = ?2 AND ${level} >= 1
      RETURNING device_id`,
  )
    .bind(now, device.device_id)
    .first();
  if (taken) return 0;
  const current = Math.min(
    SEND_BUCKET_CAPACITY,
    device.send_tokens + Math.max(0, now - device.send_refill_at) / SEND_REFILL_MS,
  );
  return ((1 - current) * SEND_REFILL_MS) / 1000;
}

async function send(request: Request, env: Env): Promise<Response> {
  if (await rateLimited(env.SEND_IP_LIMITER, `send:${clientIp(request)}`)) return tooMany(60);
  const secret = bearer(request);
  if (!secret) return error(401, "unauthorized");
  const req = parseSend(await readJsonObject(request));

  const device = await authenticate(env, req.deviceId, secret);
  if (!device) return error(404, "not found");
  if (!providerConfigured(env, device.platform)) return error(503, "not configured");

  // APNs topic: the app id stored at registration wins (the token belongs to that app); for
  // devices registered without one, the server's appId for the device, else the default topic.
  let topic: string | undefined;
  if (device.platform === "ios") {
    topic = resolveTopic(env, device.app_id ?? req.appId);
    if (!topic) return error(400, "appId not allowed");
  }

  const wait = await consumeSendToken(env, device, Date.now());
  if (wait > 0) return tooMany(wait);

  let result: SendResult;
  try {
    result =
      device.platform === "ios"
        ? await sendApns(env, device.token, device.environment, topic!, req)
        : await sendFcm(env, device.token, req);
  } catch (e) {
    // Network-level failure (for APNs, possibly the HTTP/2 path; see README.md).
    console.error(`${device.platform === "ios" ? "apns" : "fcm"} request failed: ${e instanceof Error ? e.name : "error"}`);
    return error(502, "provider unreachable");
  }

  switch (result.kind) {
    case "ok":
      return json(200, { ok: true });
    case "invalid-token":
      await deleteDevice(env, device.device_id);
      return json(410, { error: "device token is no longer valid", reason: result.reason });
    case "too-large":
      return error(413, "notification too large");
    case "error": {
      console.error(`${device.platform === "ios" ? "apns" : "fcm"} rejected: ${result.status} ${result.reason}`);
      if (result.status === 503 && result.reason === "not configured") return error(503, "not configured");
      const headers: Record<string, string> = result.retryAfter ? { "retry-after": result.retryAfter } : {};
      return json(502, { error: "provider error", reason: result.reason }, headers);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Routing

function health(env: Env): Response {
  return json(200, { ok: true, apns: apnsConfigured(env), fcm: fcmConfigured(env) });
}

function methodNotAllowed(allow: string): Response {
  return error(405, "method not allowed", { allow });
}

async function route(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  const method = request.method.toUpperCase();

  if (pathname === "/v1/health") {
    const cors = corsHeaders(request);
    if (method === "OPTIONS") return empty(204, cors);
    if (method !== "GET" && method !== "HEAD") return withHeaders(methodNotAllowed("GET, HEAD, OPTIONS"), cors);
    return withHeaders(health(env), cors);
  }

  if (pathname === "/v1/devices") {
    const cors = corsHeaders(request);
    if (method === "OPTIONS") return empty(204, cors);
    if (method !== "POST") return withHeaders(methodNotAllowed("POST, OPTIONS"), cors);
    return withHeaders(await registerDevice(request, env), cors);
  }

  const m = /^\/v1\/devices\/([^/]+)$/.exec(pathname);
  if (m) {
    const cors = corsHeaders(request);
    const deviceId = m[1]!;
    if (method === "OPTIONS") return empty(204, cors);
    if (method === "PUT") return withHeaders(await updateDevice(request, env, deviceId), cors);
    if (method === "DELETE") return withHeaders(await unregisterDevice(request, env, deviceId), cors);
    return withHeaders(methodNotAllowed("PUT, DELETE, OPTIONS"), cors);
  }

  if (pathname === "/v1/send") {
    if (method !== "POST") return methodNotAllowed("POST");
    return send(request, env);
  }

  return error(404, "not found");
}

/** Deletes devices unused for RETENTION_MS. Returns the number deleted. */
export async function cleanup(env: Env, now = Date.now()): Promise<number> {
  const res = await env.DB.prepare("DELETE FROM devices WHERE last_used_at < ?").bind(now - RETENTION_MS).run();
  return res.meta.changes ?? 0;
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (e) {
      if (e instanceof HttpError) {
        const res = error(e.status, e.message);
        const { pathname } = new URL(request.url);
        return pathname.startsWith("/v1/devices") ? withHeaders(res, corsHeaders(request)) : res;
      }
      console.error(`unhandled error: ${e instanceof Error ? e.name : "error"}`);
      return error(500, "internal error");
    }
  },

  async scheduled(_controller, env): Promise<void> {
    const n = await cleanup(env);
    console.log(`cleanup: deleted ${n} devices unused for 90 days`);
  },
} satisfies ExportedHandler<Env>;

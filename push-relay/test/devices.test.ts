import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/crypto";
import { ANDROID_TOKEN, IOS_TOKEN, call, fakeLimiter, makeEnv, register } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

async function row(deviceId: string) {
  return env.DB.prepare("SELECT * FROM devices WHERE device_id = ?").bind(deviceId).first<Record<string, unknown>>();
}

describe("GET /v1/health", () => {
  it("reports provider configuration without secrets", async () => {
    const res = await call(await makeEnv(), "GET", "/v1/health");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true, apns: true, fcm: true });
    expect(text).not.toMatch(/PRIVATE KEY|KEYID|TEAMID|service_account/);
  });

  it("reports missing providers", async () => {
    const res = await call(await makeEnv({ apns: false, fcm: false }), "GET", "/v1/health");
    expect(await res.json()).toEqual({ ok: true, apns: false, fcm: false });
  });

  it("treats a malformed service account as not configured", async () => {
    const e = await makeEnv();
    e.FCM_SERVICE_ACCOUNT_JSON = "{not json";
    expect(await (await call(e, "GET", "/v1/health")).json()).toEqual({ ok: true, apns: true, fcm: false });
  });
});

describe("POST /v1/devices", () => {
  it("creates a device with a random id and secret, storing only the secret's hash", async () => {
    const e = await makeEnv();
    const res = await call(e, "POST", "/v1/devices", { body: { token: IOS_TOKEN, platform: "ios", appVersion: "1.2.3" } });
    expect(res.status).toBe(201);
    const { deviceId, secret } = (await res.json()) as { deviceId: string; secret: string };
    expect(deviceId).toMatch(/^[A-Za-z0-9_-]{22}$/); // 128 bits
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256 bits

    const r = (await row(deviceId))!;
    expect(r.platform).toBe("ios");
    expect(r.token).toBe(IOS_TOKEN);
    expect(r.app_version).toBe("1.2.3");
    expect(r.environment).toBe("production");
    expect(r.secret_hash).toBe(await sha256Hex(secret));
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(r.created_at).toBe(r.last_used_at);

    const second = await register(e);
    expect(second.deviceId).not.toBe(deviceId);
    expect(second.secret).not.toBe(secret);
  });

  it("stores the APNs sandbox environment for development builds", async () => {
    const e = await makeEnv();
    const { deviceId } = await register(e, { token: IOS_TOKEN, platform: "ios", environment: "sandbox" });
    expect((await row(deviceId))!.environment).toBe("sandbox");
    const android = await register(e, { token: ANDROID_TOKEN, platform: "android", environment: "sandbox" });
    expect((await row(android.deviceId))!.environment).toBe("production");
    expect((await row(android.deviceId))!.app_version).toBeNull();
  });

  it.each([
    [{ token: IOS_TOKEN }, "platform"],
    [{ token: IOS_TOKEN, platform: "windows" }, "platform"],
    [{ platform: "ios" }, "invalid token"],
    [{ token: "not-hex", platform: "ios" }, "invalid token"],
    [{ token: "short", platform: "android" }, "invalid token"],
    [{ token: 42, platform: "android" }, "invalid token"],
    [{ token: IOS_TOKEN, platform: "ios", appVersion: "x".repeat(65) }, "appVersion"],
    [{ token: IOS_TOKEN, platform: "ios", environment: "staging" }, "environment"],
  ])("rejects %j", async (body, msg) => {
    const res = await call(await makeEnv(), "POST", "/v1/devices", { body });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(msg);
  });

  it("rejects invalid JSON, non-objects and oversized bodies", async () => {
    const e = await makeEnv();
    expect((await call(e, "POST", "/v1/devices", { body: "{nope" })).status).toBe(400);
    expect((await call(e, "POST", "/v1/devices", { body: "[1,2]" })).status).toBe(400);
    const big = await call(e, "POST", "/v1/devices", { body: { token: IOS_TOKEN, platform: "ios", pad: "x".repeat(9000) } });
    expect(big.status).toBe(413);
  });

  it("rate-limits registrations by client IP", async () => {
    const allow = fakeLimiter();
    await register(await makeEnv({ register: allow }));
    expect(allow.keys).toEqual(["register:203.0.113.7"]);

    const res = await call(await makeEnv({ register: fakeLimiter(true) }), "POST", "/v1/devices", {
      body: { token: IOS_TOKEN, platform: "ios" },
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
  });

  it("works with the real rate limiting binding from wrangler.jsonc", async () => {
    const e = await makeEnv({ register: env.REGISTER_LIMITER });
    const res = await call(e, "POST", "/v1/devices", { body: { token: IOS_TOKEN, platform: "ios" }, headers: { "cf-connecting-ip": "198.51.100.1" } });
    expect(res.status).toBe(201);
  });
});

describe("PUT /v1/devices/:deviceId", () => {
  it("rotates the token", async () => {
    const e = await makeEnv();
    const { deviceId, secret } = await register(e);
    await env.DB.prepare("UPDATE devices SET last_used_at = 1 WHERE device_id = ?").bind(deviceId).run();
    const newToken = "b2".repeat(32);
    const res = await call(e, "PUT", `/v1/devices/${deviceId}`, { secret, body: { token: newToken } });
    expect(res.status).toBe(204);
    const r = (await row(deviceId))!;
    expect(r.token).toBe(newToken);
    expect(r.last_used_at as number).toBeGreaterThan(1);
  });

  it("returns 404 for a wrong secret or unknown device, 401 without a secret", async () => {
    const e = await makeEnv();
    const { deviceId } = await register(e);
    const wrong = await call(e, "PUT", `/v1/devices/${deviceId}`, { secret: "A".repeat(43), body: { token: "c3".repeat(32) } });
    const unknown = await call(e, "PUT", `/v1/devices/${"B".repeat(22)}`, { secret: "A".repeat(43), body: { token: "c3".repeat(32) } });
    expect(wrong.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await wrong.text()).toBe(await unknown.text());
    expect((await row(deviceId))!.token).toBe(IOS_TOKEN);
    expect((await call(e, "PUT", `/v1/devices/${deviceId}`, { body: { token: "c3".repeat(32) } })).status).toBe(401);
  });

  it("validates the new token against the device platform", async () => {
    const e = await makeEnv();
    const { deviceId, secret } = await register(e);
    const res = await call(e, "PUT", `/v1/devices/${deviceId}`, { secret, body: { token: ANDROID_TOKEN } });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /v1/devices/:deviceId", () => {
  it("deletes the device, and is idempotent", async () => {
    const e = await makeEnv();
    const { deviceId, secret } = await register(e);
    expect((await call(e, "DELETE", `/v1/devices/${deviceId}`, { secret })).status).toBe(204);
    expect(await row(deviceId)).toBeNull();
    expect((await call(e, "DELETE", `/v1/devices/${deviceId}`, { secret })).status).toBe(204);
  });

  it("refuses a wrong secret and keeps the device", async () => {
    const e = await makeEnv();
    const { deviceId } = await register(e);
    expect((await call(e, "DELETE", `/v1/devices/${deviceId}`, { secret: "Z".repeat(43) })).status).toBe(404);
    expect(await row(deviceId)).not.toBeNull();
    expect((await call(e, "DELETE", `/v1/devices/${deviceId}`)).status).toBe(401);
  });

  it("rate-limits by client IP", async () => {
    const e = await makeEnv({ device: fakeLimiter(true) });
    const res = await call(e, "DELETE", `/v1/devices/${"B".repeat(22)}`, { secret: "Z".repeat(43) });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
  });
});

describe("CORS and routing", () => {
  it("answers preflights for the app origins only", async () => {
    const e = await makeEnv();
    for (const origin of ["capacitor://localhost", "https://localhost", "http://localhost"]) {
      const res = await call(e, "OPTIONS", "/v1/devices", { headers: { origin, "access-control-request-method": "POST" } });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
      expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
    }
    const evil = await call(e, "OPTIONS", "/v1/devices/abc", { headers: { origin: "https://evil.example" } });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("adds CORS headers to device responses, including errors", async () => {
    const e = await makeEnv();
    const ok = await call(e, "POST", "/v1/devices", { body: { token: IOS_TOKEN, platform: "ios" }, headers: { origin: "capacitor://localhost" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("capacitor://localhost");
    const bad = await call(e, "POST", "/v1/devices", { body: "{", headers: { origin: "capacitor://localhost" } });
    expect(bad.status).toBe(400);
    expect(bad.headers.get("access-control-allow-origin")).toBe("capacitor://localhost");
  });

  it("does not offer CORS on /v1/send", async () => {
    const res = await call(await makeEnv(), "OPTIONS", "/v1/send", { headers: { origin: "capacitor://localhost" } });
    expect(res.status).toBe(405);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("returns JSON 404 and 405 for unknown paths and methods", async () => {
    const e = await makeEnv();
    const nf = await call(e, "GET", "/nope");
    expect(nf.status).toBe(404);
    expect(await nf.json()).toEqual({ error: "not found" });
    const sendGet = await call(e, "GET", "/v1/send");
    expect(sendGet.status).toBe(405);
    expect(sendGet.headers.get("allow")).toBe("POST");
    expect(await sendGet.json()).toEqual({ error: "method not allowed" });
    expect((await call(e, "PATCH", "/v1/devices/abc")).status).toBe(405);
    expect((await call(e, "GET", "/v1/devices")).status).toBe(405);
    expect((await call(e, "POST", "/v1/health")).status).toBe(405);
    expect((await call(e, "GET", "/v1/devices/a/b")).status).toBe(404);
  });
});

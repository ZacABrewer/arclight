import { createScheduledController, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { RETENTION_MS, cleanup } from "../src/index";
import {
  ANDROID_TOKEN,
  IOS_TOKEN,
  call,
  captureLogs,
  dumpDatabase,
  happyProviders,
  makeEnv,
  mockFetch,
  okJson,
  register,
  resetProviderCaches,
} from "./helpers";

beforeEach(() => {
  resetProviderCaches();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("notification content is never stored or logged", () => {
  it("leaves no title, body, data or thread id in D1 or the logs, on success and on every failure path", async () => {
    const logs = captureLogs();
    const e = await makeEnv();
    const ios = await register(e);
    const android = await register(e, { token: ANDROID_TOKEN, platform: "android" });
    const marker = {
      title: "SECRET-TITLE-7f3a",
      body: "SECRET-BODY-91c2",
      data: { route: "SECRET-DATA-55e0" },
      threadId: "SECRET-THREAD-0b1d",
    };
    const send = (d: { deviceId: string; secret: string }) =>
      call(e, "POST", "/v1/send", { secret: d.secret, body: { deviceId: d.deviceId, ...marker } });

    mockFetch(happyProviders);
    expect((await send(ios)).status).toBe(200);
    expect((await send(android)).status).toBe(200);
    vi.mocked(globalThis.fetch).mockRestore();

    // Provider errors.
    mockFetch((c) => (c.url.includes("oauth2") ? happyProviders(c) : okJson({ reason: "InternalServerError", error: { status: "INTERNAL" } }, 500)));
    expect((await send(ios)).status).toBe(502);
    expect((await send(android)).status).toBe(502);
    vi.mocked(globalThis.fetch).mockRestore();

    // Network failure.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error(`connect failed ${IOS_TOKEN}`));
    expect((await send(ios)).status).toBe(502);
    vi.mocked(globalThis.fetch).mockRestore();

    // Bad request and wrong secret.
    expect((await call(e, "POST", "/v1/send", { secret: ios.secret, body: { deviceId: ios.deviceId, ...marker, badge: -5 } })).status).toBe(400);
    expect((await call(e, "POST", "/v1/send", { secret: "X".repeat(43), body: { deviceId: ios.deviceId, ...marker } })).status).toBe(404);

    // Invalid token: device deleted.
    mockFetch(() => okJson({ reason: "Unregistered" }, 410));
    expect((await send(ios)).status).toBe(410);

    const db = await dumpDatabase();
    const logText = logs.join("\n");
    for (const value of [marker.title, marker.body, marker.data.route, marker.threadId]) {
      expect(db).not.toContain(value);
      expect(logText).not.toContain(value);
    }
    // Logs also never carry tokens, device IDs or secrets.
    for (const value of [IOS_TOKEN, ANDROID_TOKEN, ios.deviceId, ios.secret, android.deviceId, android.secret]) {
      expect(logText).not.toContain(value);
    }
  });

  it("stores only the documented columns", async () => {
    const e = await makeEnv();
    await register(e, { token: IOS_TOKEN, platform: "ios", appVersion: "2.0.0" });
    const cols = await env.DB.prepare("SELECT name FROM pragma_table_info('devices')").all<{ name: string }>();
    expect(cols.results.map((c) => c.name).sort()).toEqual(
      [
        "app_id",
        "app_version",
        "created_at",
        "device_id",
        "environment",
        "last_used_at",
        "platform",
        "secret_hash",
        "send_refill_at",
        "send_tokens",
        "token",
      ].sort(),
    );
  });
});

describe("cleanup cron", () => {
  async function insert(id: string, lastUsedAt: number) {
    await env.DB.prepare(
      "INSERT INTO devices (device_id, platform, token, secret_hash, environment, created_at, last_used_at) VALUES (?, 'ios', ?, ?, 'production', ?, ?)",
    )
      .bind(id, IOS_TOKEN, "0".repeat(64), lastUsedAt, lastUsedAt)
      .run();
  }

  it("deletes devices unused for 90 days and keeps the rest", async () => {
    await env.DB.prepare("DELETE FROM devices").run();
    const now = Date.now();
    await insert("old-device-aaaaaaaaaaaa", now - RETENTION_MS - 60_000);
    await insert("edge-device-bbbbbbbbbbb", now - RETENTION_MS + 60_000);
    await insert("new-device-cccccccccccc", now - 1000);

    const e = await makeEnv();
    const logs = captureLogs();
    await worker.scheduled(createScheduledController({ scheduledTime: new Date(now), cron: "17 3 * * *" }), e);

    const left = await env.DB.prepare("SELECT device_id FROM devices ORDER BY device_id").all<{ device_id: string }>();
    expect(left.results.map((r) => r.device_id)).toEqual(["edge-device-bbbbbbbbbbb", "new-device-cccccccccccc"]);
    expect(logs.join("\n")).toContain("deleted 1 devices");
    expect(await cleanup(e)).toBe(0);
  });

  it("counts a send or a token rotation as use", async () => {
    await env.DB.prepare("DELETE FROM devices").run();
    const e = await makeEnv();
    const sent = await register(e);
    const rotated = await register(e);
    const idle = await register(e);
    const old = Date.now() - RETENTION_MS - 60_000;
    await env.DB.prepare("UPDATE devices SET last_used_at = ?, send_refill_at = ?").bind(old, old).run();

    mockFetch(happyProviders);
    expect((await call(e, "POST", "/v1/send", { secret: sent.secret, body: { deviceId: sent.deviceId, title: "t", body: "b" } })).status).toBe(200);
    expect((await call(e, "PUT", `/v1/devices/${rotated.deviceId}`, { secret: rotated.secret, body: { token: "d4".repeat(32) } })).status).toBe(204);

    expect(await cleanup(e)).toBe(1);
    const left = await env.DB.prepare("SELECT device_id FROM devices").all<{ device_id: string }>();
    expect(left.results.map((r) => r.device_id).sort()).toEqual([sent.deviceId, rotated.deviceId].sort());
    expect(left.results.map((r) => r.device_id)).not.toContain(idle.deviceId);
  });
});

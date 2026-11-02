import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANDROID_TOKEN,
  IOS_TOKEN,
  call,
  decodeJwt,
  fakeLimiter,
  happyProviders,
  keys,
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

const note = { title: "Download finished", body: "Your request is ready", data: { route: "/requests/42", channel: "downloads" }, badge: 3, threadId: "request-42" };

async function row(deviceId: string) {
  return env.DB.prepare("SELECT * FROM devices WHERE device_id = ?").bind(deviceId).first<Record<string, unknown>>();
}

describe("POST /v1/send via APNs", () => {
  it("sends an alert with a valid ES256 provider token and updates lastUsedAt", async () => {
    const e = await makeEnv();
    const { deviceId, secret } = await register(e);
    await env.DB.prepare("UPDATE devices SET last_used_at = 5 WHERE device_id = ?").bind(deviceId).run();
    const calls = mockFetch(happyProviders);

    const res = await call(e, "POST", "/v1/send", { secret, body: { deviceId, ...note } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.method).toBe("POST");
    expect(c.url).toBe(`https://api.push.apple.com/3/device/${IOS_TOKEN}`);
    expect(c.headers["apns-topic"]).toBe("com.moviemethat.arclight.admin"); // no appId: the default topic
    expect(c.headers["apns-push-type"]).toBe("alert");
    expect(c.headers["apns-priority"]).toBe("10");
    expect(c.headers["apns-collapse-id"]).toBe("request-42");
    expect(JSON.parse(c.body)).toEqual({
      aps: { alert: { title: note.title, body: note.body }, sound: "default", badge: 3, "thread-id": "request-42" },
      route: "/requests/42",
      channel: "downloads",
    });

    const jwt = c.headers.authorization!.replace(/^bearer /, "");
    const { header, claims, signingInput, signature } = decodeJwt(jwt);
    expect(header).toEqual({ alg: "ES256", kid: "KEYID12345" });
    expect(claims.iss).toBe("TEAMID1234");
    expect(Math.abs((claims.iat as number) - Date.now() / 1000)).toBeLessThan(60);
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      (await keys()).apnsPublic,
      signature,
      new TextEncoder().encode(signingInput),
    );
    expect(valid).toBe(true);

    expect((await row(deviceId))!.last_used_at as number).toBeGreaterThan(5);
  });

  it("reuses the cached provider token across sends", async () => {
    const e = await makeEnv();
    const { deviceId, secret } = await register(e);
    const calls = mockFetch(happyProviders);
    await call(e, "POST", "/v1/send", { secret, body: { deviceId, title: "a", body: "b" } });
    await call(e, "POST", "/v1/send", { secret, body: { deviceId, title: "c", body: "d" } });
    expect(calls[0]!.headers.authorization).toBe(calls[1]!.headers.authorization);
    expect(JSON.parse(calls[1]!.body)).toEqual({ aps: { alert: { title: "c", body: "d" }, sound: "default" } });
    expect(calls[1]!.headers["apns-collapse-id"]).toBeUndefined();
  });

  it("uses the sandbox host for development-build devices", async () => {
    const e = await makeEnv();
    const { deviceId, secret } = await register(e, { token: IOS_TOKEN, platform: "ios", environment: "sandbox" });
    const calls = mockFetch(happyProviders);
    expect((await call(e, "POST", "/v1/send", { secret, body: { deviceId, title: "t", body: "b" } })).status).toBe(200);
    expect(calls[0]!.url).toBe(`https://api.sandbox.push.apple.com/3/device/${IOS_TOKEN}`);
  });

  it("retries once with a fresh provider token on ExpiredProviderToken", async () => {
    const e = await makeEnv();
    const { deviceId, secret } = await register(e);
    let n = 0;
    const calls = mockFetch(() => (n++ === 0 ? okJson({ reason: "ExpiredProviderToken" }, 403) : new Response(null, { status: 200 })));
    expect((await call(e, "POST", "/v1/send", { secret, body: { deviceId, title: "t", body: "b" } })).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it.each([
    ["410 Unregistered", 410, "Unregistered"],
    ["400 BadDeviceToken", 400, "BadDeviceToken"],
    ["400 DeviceTokenNotForTopic", 400, "DeviceTokenNotForTopic"],
  ])("deletes the device on %s and returns 410", async (_label, status, reason) => {
    const e = await makeEnv();
    const { deviceId, secret } = await register(e);
    mockFetch(() => okJson({ reason }, status));
    const res = await call(e, "POST", "/v1/send", { secret, body: { deviceId, title: "t", body: "b" } });
    expect(res.status).toBe(410);
    expect(await row(deviceId)).toBeNull();
    // The server then sees the device as gone.
    expect((await call(e, "POST", "/v1/send", { secret, body: { deviceId, title: "t", body: "b" } })).status).toBe(404);
  });

  it("maps other APNs errors to 502 and keeps the device", async () => {
    const e = await makeEnv();
    const { deviceId, secret } = await register(e);
    mockFetch(() => okJson({ reason: "TooManyRequests" }, 429, { "retry-after": "30" }));
    const res = await call(e, "POST", "/v1/send", { secret, body: { deviceId, title: "t", body: "b" } });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "provider error", reason: "TooManyRequests" });
    expect(res.headers.get("retry-after")).toBe("30");
    expect(await row(deviceId)).not.toBeNull();
  });

  it("returns 502 when the APNs connection fails", async () => {
    const e = await makeEnv();
    const { deviceId, secret } = await register(e);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network connection lost."));
    const res = await call(e, "POST", "/v1/send", { secret, body: { deviceId, title: "t", body: "b" } });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "provider unreachable" });
  });

  it("returns 503 when APNs credentials are missing", async () => {
    const e = await makeEnv({ apns: false });
    const { deviceId, secret } = await register(e);
    const calls = mockFetch(happyProviders);
    const res = await call(e, "POST", "/v1/send", { secret, body: { deviceId, title: "t", body: "b" } });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "not configured" });
    expect(calls).toHaveLength(0);
  });

  it("honours APNS_*_ORIGIN overrides for an HTTP/2 forwarder", async () => {
    const e = await makeEnv();
    e.APNS_PRODUCTION_ORIGIN = "https://apns-forwarder.moviemethat.com";
    const { deviceId, secret } = await register(e);
    const calls = mockFetch(() => new Response(null, { status: 200 }));
    await call(e, "POST", "/v1/send", { secret, body: { deviceId, title: "t", body: "b" } });
    expect(calls[0]!.url).toBe(`https://apns-forwarder.moviemethat.com/3/device/${IOS_TOKEN}`);
  });
});

describe("APNs topic per app", () => {
  const topicOf = (c: { headers: Record<string, string> }) => c.headers["apns-topic"];

  it("uses the app id stored at registration", async () => {
    const e = await makeEnv();
    const player = await register(e, { token: IOS_TOKEN, platform: "ios", appId: "com.moviemethat.arclight" });
    const admin = await register(e, { token: IOS_TOKEN, platform: "ios", appId: "com.moviemethat.arclight.admin" });
    expect((await row(player.deviceId))!.app_id).toBe("com.moviemethat.arclight");
    const calls = mockFetch(happyProviders);
    expect((await call(e, "POST", "/v1/send", { secret: player.secret, body: { deviceId: player.deviceId, title: "t", body: "b" } })).status).toBe(200);
    expect((await call(e, "POST", "/v1/send", { secret: admin.secret, body: { deviceId: admin.deviceId, title: "t", body: "b" } })).status).toBe(200);
    expect(calls.map(topicOf)).toEqual(["com.moviemethat.arclight", "com.moviemethat.arclight.admin"]);
  });

  it("prefers the registered app id over the server's, and uses the server's for older registrations", async () => {
    const e = await makeEnv();
    const admin = await register(e, { token: IOS_TOKEN, platform: "ios", appId: "com.moviemethat.arclight.admin" });
    const legacy = await register(e);
    expect((await row(legacy.deviceId))!.app_id).toBeNull();
    const calls = mockFetch(happyProviders);
    const body = (deviceId: string) => ({ deviceId, title: "t", body: "b", appId: "com.moviemethat.arclight" });
    expect((await call(e, "POST", "/v1/send", { secret: admin.secret, body: body(admin.deviceId) })).status).toBe(200);
    expect((await call(e, "POST", "/v1/send", { secret: legacy.secret, body: body(legacy.deviceId) })).status).toBe(200);
    expect(calls.map(topicOf)).toEqual(["com.moviemethat.arclight.admin", "com.moviemethat.arclight"]);
  });

  it("refuses app ids outside APNS_TOPICS on iOS, at registration and at send", async () => {
    const e = await makeEnv();
    const reg = await call(e, "POST", "/v1/devices", { body: { token: IOS_TOKEN, platform: "ios", appId: "com.example.other" } });
    expect(reg.status).toBe(400);
    expect(((await reg.json()) as { error: string }).error).toBe("appId not allowed");

    const legacy = await register(e);
    const calls = mockFetch(happyProviders);
    const res = await call(e, "POST", "/v1/send", { secret: legacy.secret, body: { deviceId: legacy.deviceId, title: "t", body: "b", appId: "com.example.other" } });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
    const bad = await call(e, "POST", "/v1/send", { secret: legacy.secret, body: { deviceId: legacy.deviceId, title: "t", body: "b", appId: "not an id" } });
    expect(bad.status).toBe(400);
  });

  it("reads the allow-list from APNS_TOPICS, else APNS_TOPIC, else the built-in default", async () => {
    const custom = { ...(await makeEnv()), APNS_TOPICS: " org.example.fork , org.example.fork.player " };
    const a = await register(custom);
    const b = await register(custom, { token: IOS_TOKEN, platform: "ios", appId: "org.example.fork.player" });
    const single = { ...(await makeEnv()), APNS_TOPICS: undefined, APNS_TOPIC: "org.example.single" };
    const c = await register(single);
    const builtIn = { ...(await makeEnv()), APNS_TOPICS: undefined };
    const d = await register(builtIn, { token: IOS_TOKEN, platform: "ios", appId: "com.moviemethat.arclight" });
    const f = await register(builtIn);
    const calls = mockFetch(happyProviders);
    for (const [envX, dev] of [[custom, a], [custom, b], [single, c], [builtIn, d], [builtIn, f]] as const) {
      expect((await call(envX, "POST", "/v1/send", { secret: dev.secret, body: { deviceId: dev.deviceId, title: "t", body: "b" } })).status).toBe(200);
    }
    expect(calls.map(topicOf)).toEqual([
      "org.example.fork",
      "org.example.fork.player",
      "org.example.single",
      "com.moviemethat.arclight",
      "com.moviemethat.arclight.admin",
    ]);
  });

  it("leaves FCM alone: any well-formed app id is stored, none is required", async () => {
    const e = await makeEnv();
    const { deviceId, secret } = await register(e, { token: ANDROID_TOKEN, platform: "android", appId: "com.example.other" });
    expect((await row(deviceId))!.app_id).toBe("com.example.other");
    const calls = mockFetch(happyProviders);
    expect((await call(e, "POST", "/v1/send", { secret, body: { deviceId, title: "t", body: "b", appId: "com.example.whatever" } })).status).toBe(200);
    expect(calls.some((c) => c.url.startsWith("https://fcm.googleapis.com/"))).toBe(true);
    expect((await call(e, "POST", "/v1/devices", { body: { token: ANDROID_TOKEN, platform: "android", appId: "bad id" } })).status).toBe(400);
  });
});

describe("POST /v1/send via FCM", () => {
  it("exchanges a service-account JWT for an access token and sends an HTTP v1 message", async () => {
    const e = await makeEnv();
    const { deviceId, secret } = await register(e, { token: ANDROID_TOKEN, platform: "android" });
    const calls = mockFetch(happyProviders);

    const res = await call(e, "POST", "/v1/send", { secret, body: { deviceId, ...note } });
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual([
      "https://oauth2.googleapis.com/token",
      "https://fcm.googleapis.com/v1/projects/arclight-test/messages:send",
    ]);

    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const { header, claims, signingInput, signature } = decodeJwt(form.get("assertion")!);
    expect(header).toEqual({ alg: "RS256", typ: "JWT", kid: "test-key-id" });
    expect(claims.iss).toBe("relay@arclight-test.iam.gserviceaccount.com");
    expect(claims.scope).toBe("https://www.googleapis.com/auth/firebase.messaging");
    expect(claims.aud).toBe("https://oauth2.googleapis.com/token");
    expect((claims.exp as number) - (claims.iat as number)).toBe(3600);
    expect(
      await crypto.subtle.verify("RSASSA-PKCS1-v1_5", (await keys()).fcmPublic, signature, new TextEncoder().encode(signingInput)),
    ).toBe(true);

    expect(calls[1]!.headers.authorization).toBe("Bearer ya29.test-access-token");
    expect(JSON.parse(calls[1]!.body)).toEqual({
      message: {
        token: ANDROID_TOKEN,
        notification: { title: note.title, body: note.body },
        data: note.data,
        android: { priority: "high", notification: { channel_id: "downloads", tag: "request-42", notification_count: 3 } },
      },
    });
  });

  it("caches the access token and defaults the channel", async () => {
    const e = await makeEnv();
    const { deviceId, secret } = await register(e, { token: ANDROID_TOKEN, platform: "android" });
    const calls = mockFetch(happyProviders);
    await call(e, "POST", "/v1/send", { secret, body: { deviceId, title: "a", body: "b" } });
    await call(e, "POST", "/v1/send", { secret, body: { deviceId, title: "c", body: "d" } });
    expect(calls.filter((c) => c.url.includes("oauth2")).length).toBe(1);
    const last = JSON.parse(calls.at(-1)!.body);
    expect(last.message.android.notification).toEqual({ channel_id: "general" });
    expect(last.message.data).toBeUndefined();
  });

  it("deletes the device on UNREGISTERED", async () => {
    const e = await makeEnv();
    const { deviceId, secret } = await register(e, { token: ANDROID_TOKEN, platform: "android" });
    mockFetch((c) =>
      c.url.includes("oauth2")
        ? happyProviders(c)
        : okJson(
            {
              error: {
                code: 404,
                status: "NOT_FOUND",
                message: "Requested entity was not found.",
                details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "UNREGISTERED" }],
              },
            },
            404,
          ),
    );
    const res = await call(e, "POST", "/v1/send", { secret, body: { deviceId, title: "t", body: "b" } });
    expect(res.status).toBe(410);
    expect(await row(deviceId)).toBeNull();
  });

  it("deletes the device when INVALID_ARGUMENT points at the token", async () => {
    const e = await makeEnv();
    const { deviceId, secret } = await register(e, { token: ANDROID_TOKEN, platform: "android" });
    mockFetch((c) =>
      c.url.includes("oauth2")
        ? happyProviders(c)
        : okJson(
            {
              error: {
                code: 400,
                status: "INVALID_ARGUMENT",
                message: "The registration token is not a valid FCM registration token",
                details: [
                  { "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "INVALID_ARGUMENT" },
                  { "@type": "type.googleapis.com/google.rpc.BadRequest", fieldViolations: [{ field: "message.token" }] },
                ],
              },
            },
            400,
          ),
    );
    expect((await call(e, "POST", "/v1/send", { secret, body: { deviceId, title: "t", body: "b" } })).status).toBe(410);
    expect(await row(deviceId)).toBeNull();
  });

  it("keeps the device when INVALID_ARGUMENT is about the payload", async () => {
    const e = await makeEnv();
    const { deviceId, secret } = await register(e, { token: ANDROID_TOKEN, platform: "android" });
    mockFetch((c) =>
      c.url.includes("oauth2")
        ? happyProviders(c)
        : okJson(
            {
              error: {
                code: 400,
                status: "INVALID_ARGUMENT",
                message: "Invalid value at 'message.android.notification.channel_id'",
                details: [{ "@type": "type.googleapis.com/google.rpc.BadRequest", fieldViolations: [{ field: "message.android.notification.channel_id" }] }],
              },
            },
            400,
          ),
    );
    const res = await call(e, "POST", "/v1/send", { secret, body: { deviceId, title: "t", body: "b" } });
    expect(res.status).toBe(502);
    expect(await row(deviceId)).not.toBeNull();
  });

  it("refreshes the access token once on 401", async () => {
    const e = await makeEnv();
    const { deviceId, secret } = await register(e, { token: ANDROID_TOKEN, platform: "android" });
    let fcmCalls = 0;
    const calls = mockFetch((c) => {
      if (c.url.includes("oauth2")) return happyProviders(c);
      return fcmCalls++ === 0 ? okJson({ error: { code: 401, status: "UNAUTHENTICATED" } }, 401) : okJson({ name: "x" });
    });
    expect((await call(e, "POST", "/v1/send", { secret, body: { deviceId, title: "t", body: "b" } })).status).toBe(200);
    expect(calls.filter((c) => c.url.includes("oauth2")).length).toBe(2);
  });

  it("returns 502 when the OAuth exchange fails", async () => {
    const e = await makeEnv();
    const { deviceId, secret } = await register(e, { token: ANDROID_TOKEN, platform: "android" });
    mockFetch(() => okJson({ error: "invalid_grant" }, 400));
    const res = await call(e, "POST", "/v1/send", { secret, body: { deviceId, title: "t", body: "b" } });
    expect(res.status).toBe(502);
    expect(await row(deviceId)).not.toBeNull();
  });

  it("returns 503 when FCM credentials are missing", async () => {
    const e = await makeEnv({ fcm: false });
    const { deviceId, secret } = await register(e, { token: ANDROID_TOKEN, platform: "android" });
    const res = await call(e, "POST", "/v1/send", { secret, body: { deviceId, title: "t", body: "b" } });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "not configured" });
  });
});

describe("POST /v1/send authentication", () => {
  it("returns an identical 404 for an unknown device and a wrong secret", async () => {
    const e = await makeEnv();
    const { deviceId } = await register(e);
    const calls = mockFetch(happyProviders);
    const wrong = await call(e, "POST", "/v1/send", { secret: "W".repeat(43), body: { deviceId, title: "t", body: "b" } });
    const unknown = await call(e, "POST", "/v1/send", { secret: "W".repeat(43), body: { deviceId: "U".repeat(22), title: "t", body: "b" } });
    const malformed = await call(e, "POST", "/v1/send", { secret: "W".repeat(43), body: { deviceId: "../../etc", title: "t", body: "b" } });
    expect([wrong.status, unknown.status, malformed.status]).toEqual([404, 404, 404]);
    const bodies = [await wrong.text(), await unknown.text(), await malformed.text()];
    expect(new Set(bodies).size).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("requires a bearer secret", async () => {
    const e = await makeEnv();
    const { deviceId } = await register(e);
    expect((await call(e, "POST", "/v1/send", { body: { deviceId, title: "t", body: "b" } })).status).toBe(401);
    expect(
      (await call(e, "POST", "/v1/send", { body: { deviceId, title: "t", body: "b" }, headers: { authorization: "Basic abc" } })).status,
    ).toBe(401);
  });

  it("does not let one device's secret send to another device", async () => {
    const e = await makeEnv();
    const a = await register(e);
    const b = await register(e);
    mockFetch(happyProviders);
    expect((await call(e, "POST", "/v1/send", { secret: a.secret, body: { deviceId: b.deviceId, title: "t", body: "b" } })).status).toBe(404);
  });
});

describe("POST /v1/send limits", () => {
  it.each([
    [{ title: "x".repeat(201), body: "b" }, "title"],
    [{ title: "t", body: "x".repeat(1001) }, "body"],
    [{ title: "", body: "" }, "title or body"],
    [{ title: 1, body: "b" }, "title"],
    [{ title: "t", body: "b", data: { big: "x".repeat(2100) } }, "data exceeds"],
    [{ title: "t", body: "b", data: { n: 1 } }, "strings"],
    [{ title: "t", body: "b", data: ["x"] }, "data"],
    [{ title: "t", body: "b", data: { aps: "x" } }, "not allowed"],
    [{ title: "t", body: "b", data: { "google.x": "x" } }, "not allowed"],
    [{ title: "t", body: "b", badge: -1 }, "badge"],
    [{ title: "t", body: "b", badge: 1.5 }, "badge"],
    [{ title: "t", body: "b", threadId: "has spaces" }, "threadId"],
    [{ title: "t", body: "b", threadId: "x".repeat(65) }, "threadId"],
  ])("rejects %j with 400", async (fields, msg) => {
    const e = await makeEnv();
    const { deviceId, secret } = await register(e);
    const calls = mockFetch(happyProviders);
    const res = await call(e, "POST", "/v1/send", { secret, body: { deviceId, ...fields } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(msg);
    expect(calls).toHaveLength(0);
  });

  it("accepts the maximum sizes", async () => {
    const e = await makeEnv();
    const { deviceId, secret } = await register(e);
    mockFetch(happyProviders);
    const data: Record<string, string> = { k: "x".repeat(2048 - 10) }; // {"k":"..."} = 2048 bytes
    const res = await call(e, "POST", "/v1/send", { secret, body: { deviceId, title: "t".repeat(200), body: "b".repeat(1000), data } });
    expect(res.status).toBe(200);
  });

  it("rejects a notification whose encoded payload exceeds 4 KB with 413", async () => {
    const e = await makeEnv();
    const { deviceId, secret } = await register(e);
    const calls = mockFetch(happyProviders);
    // 1000 four-byte characters (emoji are two UTF-16 units each, so 500 of them) + max data
    const res = await call(e, "POST", "/v1/send", {
      secret,
      body: { deviceId, title: "\u{1F4FA}".repeat(100), body: "\u{1F3AC}".repeat(500), data: { k: "x".repeat(2000) } },
    });
    expect(res.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it("enforces 10 sends of burst, then one per minute, with Retry-After", async () => {
    const e = await makeEnv();
    const { deviceId, secret } = await register(e);
    mockFetch(happyProviders);
    const send = () => call(e, "POST", "/v1/send", { secret, body: { deviceId, title: "t", body: "b" } });
    for (let i = 0; i < 10; i++) expect((await send()).status).toBe(200);
    const limited = await send();
    expect(limited.status).toBe(429);
    const retry = Number(limited.headers.get("retry-after"));
    expect(retry).toBeGreaterThanOrEqual(55);
    expect(retry).toBeLessThanOrEqual(60);

    // A minute later, exactly one more send is allowed.
    await env.DB.prepare("UPDATE devices SET send_refill_at = send_refill_at - 60000 WHERE device_id = ?").bind(deviceId).run();
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);

    // An hour later the bucket is full again, but never above 10.
    await env.DB.prepare("UPDATE devices SET send_refill_at = send_refill_at - 3600000 WHERE device_id = ?").bind(deviceId).run();
    for (let i = 0; i < 10; i++) expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);
  });

  it("keeps per-device limits independent", async () => {
    const e = await makeEnv();
    const a = await register(e);
    const b = await register(e);
    mockFetch(happyProviders);
    for (let i = 0; i < 10; i++) await call(e, "POST", "/v1/send", { secret: a.secret, body: { deviceId: a.deviceId, title: "t", body: "b" } });
    expect((await call(e, "POST", "/v1/send", { secret: a.secret, body: { deviceId: a.deviceId, title: "t", body: "b" } })).status).toBe(429);
    expect((await call(e, "POST", "/v1/send", { secret: b.secret, body: { deviceId: b.deviceId, title: "t", body: "b" } })).status).toBe(200);
  });

  it("applies the per-IP send limiter before touching the database", async () => {
    const limiter = fakeLimiter(true);
    const e = await makeEnv({ sendIp: limiter });
    const res = await call(e, "POST", "/v1/send", { secret: "S".repeat(43), body: { deviceId: "U".repeat(22), title: "t", body: "b" } });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(limiter.keys).toEqual(["send:203.0.113.7"]);
  });
});

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipBucket } from "../src/http";
import { DEFAULT_REGISTER_DAILY_CAP, cleanup } from "../src/index";
import { BASE, IOS_TOKEN, call, fakeLimiter, makeEnv } from "./helpers";
import worker from "../src/index";

describe("ipBucket", () => {
  it("keeps IPv4 addresses as they are", () => {
    expect(ipBucket("203.0.113.7")).toBe("203.0.113.7");
  });

  it("buckets IPv6 addresses by their /64", () => {
    expect(ipBucket("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(ipBucket("2001:DB8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(ipBucket("2001:0db8:0001:0002:ffff::9")).toBe("2001:db8:1:2::/64");
    expect(ipBucket("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipBucket("::1")).toBe("0:0:0:0::/64");
    expect(ipBucket("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  it("treats IPv4-mapped IPv6 as IPv4", () => {
    expect(ipBucket("::ffff:198.51.100.4")).toBe("198.51.100.4");
    expect(ipBucket("::ffff:c633:6404")).toBe("198.51.100.4");
  });

  it("uses unparsable values verbatim", () => {
    expect(ipBucket("1:2:3")).toBe("1:2:3");
    expect(ipBucket("1::2::3")).toBe("1::2::3");
    expect(ipBucket("::ffff:300.1.1.1")).toBe("::ffff:300.1.1.1");
  });
});

describe("per-IP limits", () => {
  it("share one bucket across an IPv6 /64", async () => {
    const limiter = fakeLimiter();
    const e = await makeEnv({ register: limiter });
    for (const ip of ["2001:db8:5:6::1", "2001:db8:5:6:ffff:ffff:ffff:ffff"]) {
      const res = await call(e, "POST", "/v1/devices", { body: { token: IOS_TOKEN, platform: "ios" }, headers: { "cf-connecting-ip": ip } });
      expect(res.status).toBe(201);
    }
    expect(limiter.keys).toEqual(["register:2001:db8:5:6::/64", "register:2001:db8:5:6::/64"]);
  });

  it("refuse requests without a client address instead of pooling them", async () => {
    const register = fakeLimiter();
    const device = fakeLimiter();
    const sendIp = fakeLimiter();
    const e = await makeEnv({ register, device, sendIp });
    const noIp = (method: string, path: string, body?: unknown) =>
      worker.fetch(
        new Request(BASE + path, {
          method,
          headers: { "content-type": "application/json", authorization: `Bearer ${"S".repeat(43)}` },
          body: body === undefined ? undefined : JSON.stringify(body),
        }) as Request<unknown, IncomingRequestCfProperties>,
        e,
      );
    const responses = [
      await noIp("POST", "/v1/devices", { token: IOS_TOKEN, platform: "ios" }),
      await noIp("PUT", `/v1/devices/${"A".repeat(22)}`, { token: IOS_TOKEN }),
      await noIp("DELETE", `/v1/devices/${"A".repeat(22)}`),
      await noIp("POST", "/v1/send", { deviceId: "A".repeat(22), title: "t", body: "b" }),
    ];
    expect(responses.map((r) => r.status)).toEqual([400, 400, 400, 400]);
    expect(await responses[0]!.json()).toEqual({ error: "missing client address" });
    expect([...register.keys, ...device.keys, ...sendIp.keys]).toEqual([]);
  });
});

describe("global daily registration cap", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM registration_days").run();
    vi.restoreAllMocks();
  });

  const registerFrom = (e: Awaited<ReturnType<typeof makeEnv>>, ip: string) =>
    call(e, "POST", "/v1/devices", { body: { token: IOS_TOKEN, platform: "ios" }, headers: { "cf-connecting-ip": ip } });

  it("stops registrations from every address once the day's cap is reached", async () => {
    const e = await makeEnv();
    e.REGISTER_DAILY_CAP = "2";
    const before = (await env.DB.prepare("SELECT COUNT(*) AS n FROM devices").first<{ n: number }>())!.n;
    expect((await registerFrom(e, "198.51.100.1")).status).toBe(201);
    expect((await registerFrom(e, "198.51.100.2")).status).toBe(201);
    const capped = await registerFrom(e, "2001:db8:9::1");
    expect(capped.status).toBe(429);
    const retry = Number(capped.headers.get("retry-after"));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(24 * 60 * 60);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM devices").first<{ n: number }>())!.n).toBe(before + 2);
    const counter = await env.DB.prepare("SELECT day, count FROM registration_days").all<{ day: string; count: number }>();
    expect(counter.results).toEqual([{ day: new Date().toISOString().slice(0, 10), count: 2 }]);
  });

  it("does not count rejected requests", async () => {
    const e = await makeEnv();
    e.REGISTER_DAILY_CAP = "1";
    expect((await call(e, "POST", "/v1/devices", { body: { token: "nope", platform: "ios" } })).status).toBe(400);
    expect((await call(await makeEnv({ register: fakeLimiter(true) }), "POST", "/v1/devices", { body: { token: IOS_TOKEN, platform: "ios" } })).status).toBe(429);
    expect((await registerFrom(e, "198.51.100.3")).status).toBe(201);
  });

  it("starts again on the next UTC day", async () => {
    const e = await makeEnv();
    e.REGISTER_DAILY_CAP = "1";
    await env.DB.prepare("INSERT INTO registration_days (day, count) VALUES ('2000-01-01', 1)").run();
    expect((await registerFrom(e, "198.51.100.4")).status).toBe(201);
    expect((await registerFrom(e, "198.51.100.5")).status).toBe(429);
  });

  it("falls back to the default for a missing or invalid setting", async () => {
    const e = await makeEnv();
    for (const v of [undefined, "", "0", "-3", "1.5", "lots"]) {
      e.REGISTER_DAILY_CAP = v;
      await env.DB.prepare("DELETE FROM registration_days").run();
      await env.DB.prepare("INSERT INTO registration_days (day, count) VALUES (?, ?)")
        .bind(new Date().toISOString().slice(0, 10), DEFAULT_REGISTER_DAILY_CAP - 1)
        .run();
      expect((await registerFrom(e, "198.51.100.6")).status, String(v)).toBe(201);
      expect((await registerFrom(e, "198.51.100.6")).status, String(v)).toBe(429);
    }
  });

  it("is configured in wrangler.jsonc", () => {
    expect(env.REGISTER_DAILY_CAP).toBe(String(DEFAULT_REGISTER_DAILY_CAP));
  });

  it("old counters are removed by the cleanup cron", async () => {
    const now = Date.now();
    const day = (offset: number) => new Date(now - offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    for (const d of [day(0), day(6), day(8), "2000-01-01"]) {
      await env.DB.prepare("INSERT INTO registration_days (day, count) VALUES (?, 1)").bind(d).run();
    }
    await cleanup(await makeEnv(), now);
    const left = await env.DB.prepare("SELECT day FROM registration_days ORDER BY day DESC").all<{ day: string }>();
    expect(left.results.map((r) => r.day)).toEqual([day(0), day(6)]);
  });
});

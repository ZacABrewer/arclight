import { env } from "cloudflare:test";
import { vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { resetApnsCache } from "../src/apns";
import { resetFcmCache } from "../src/fcm";

export const BASE = "https://arclight-push.moviemethat.com";
export const IOS_TOKEN = "a1".repeat(32); // 64 hex chars
export const ANDROID_TOKEN = "fcm-token:" + "Ab0_-".repeat(30);

/** Rate limiter double: allows everything unless `deny` is set. Records keys. */
export function fakeLimiter(deny = false): RateLimit & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    async limit({ key }: RateLimitOptions) {
      keys.push(key);
      return { success: !deny };
    },
  } as RateLimit & { keys: string[] };
}

function toPem(der: ArrayBuffer, label: string): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  const lines = b64.match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

export interface Keys {
  apnsPem: string;
  apnsPublic: CryptoKey;
  fcmJson: string;
  fcmPublic: CryptoKey;
}

let keysPromise: Promise<Keys> | undefined;
export function keys(): Promise<Keys> {
  keysPromise ??= (async () => {
    const ec = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const rsa = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const apnsPem = toPem((await crypto.subtle.exportKey("pkcs8", ec.privateKey)) as ArrayBuffer, "PRIVATE KEY");
    const rsaPem = toPem((await crypto.subtle.exportKey("pkcs8", rsa.privateKey)) as ArrayBuffer, "PRIVATE KEY");
    const fcmJson = JSON.stringify({
      type: "service_account",
      project_id: "arclight-test",
      private_key_id: "test-key-id",
      private_key: rsaPem,
      client_email: "relay@arclight-test.iam.gserviceaccount.com",
      token_uri: "https://oauth2.googleapis.com/token",
    });
    return { apnsPem, apnsPublic: ec.publicKey, fcmJson, fcmPublic: rsa.publicKey };
  })();
  return keysPromise;
}

export interface TestEnvOptions {
  apns?: boolean;
  fcm?: boolean;
  register?: RateLimit;
  device?: RateLimit;
  sendIp?: RateLimit;
}

/** The real D1 binding from wrangler.jsonc, plus provider secrets and limiter doubles. */
export async function makeEnv(opts: TestEnvOptions = {}): Promise<Env> {
  const k = await keys();
  const e: Env = {
    DB: env.DB,
    REGISTER_LIMITER: opts.register ?? fakeLimiter(),
    DEVICE_LIMITER: opts.device ?? fakeLimiter(),
    SEND_IP_LIMITER: opts.sendIp ?? fakeLimiter(),
    APNS_TOPIC: "com.moviemethat.arclight",
  };
  if (opts.apns ?? true) {
    e.APNS_KEY_P8 = k.apnsPem;
    e.APNS_KEY_ID = "KEYID12345";
    e.APNS_TEAM_ID = "TEAMID1234";
  }
  if (opts.fcm ?? true) e.FCM_SERVICE_ACCOUNT_JSON = k.fcmJson;
  return e;
}

export async function call(e: Env, method: string, path: string, init: { body?: unknown; secret?: string; headers?: Record<string, string> } = {}): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": "203.0.113.7", ...(init.headers ?? {}) };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.secret) headers.authorization = `Bearer ${init.secret}`;
  const req = new Request(BASE + path, {
    method,
    headers,
    body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  });
  return worker.fetch(req as Request<unknown, IncomingRequestCfProperties>, e);
}

export async function register(
  e: Env,
  body: Record<string, unknown> = { token: IOS_TOKEN, platform: "ios" },
): Promise<{ deviceId: string; secret: string }> {
  const res = await call(e, "POST", "/v1/devices", { body });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export type FetchHandler = (c: Captured) => Response | Promise<Response>;

/** Replaces global fetch with `handler` and records every outbound request. */
export function mockFetch(handler: FetchHandler): Captured[] {
  const calls: Captured[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const c: Captured = {
      url: req.url,
      method: req.method,
      headers: Object.fromEntries(req.headers),
      body: new TextDecoder().decode(await req.arrayBuffer()),
    };
    calls.push(c);
    return handler(c);
  });
  return calls;
}

export const okJson = (body: unknown = {}, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** Default provider double: APNs 200, Google OAuth token, FCM 200. */
export const happyProviders: FetchHandler = (c) => {
  if (c.url.startsWith("https://oauth2.googleapis.com/token")) {
    return okJson({ access_token: "ya29.test-access-token", expires_in: 3599, token_type: "Bearer" });
  }
  if (c.url.startsWith("https://fcm.googleapis.com/")) return okJson({ name: "projects/arclight-test/messages/1" });
  if (c.url.includes("push.apple.com")) return new Response(null, { status: 200, headers: { "apns-id": "x" } });
  return new Response("unexpected", { status: 599 });
};

/** Captures everything written to the console. */
export function captureLogs(): string[] {
  const lines: string[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
  return lines;
}

/** Dumps every row of every user table in D1 as one string. */
export async function dumpDatabase(): Promise<string> {
  const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all<{ name: string }>();
  let out = "";
  for (const { name } of tables.results) {
    const rows = await env.DB.prepare(`SELECT * FROM "${name}"`).all();
    out += `${name}: ${JSON.stringify(rows.results)}\n`;
  }
  return out;
}

export function resetProviderCaches(): void {
  resetApnsCache();
  resetFcmCache();
}

export function b64urlDecode(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

export function decodeJwt(jwt: string): { header: Record<string, unknown>; claims: Record<string, unknown>; signingInput: string; signature: Uint8Array } {
  const [h, c, s] = jwt.split(".");
  return {
    header: JSON.parse(new TextDecoder().decode(b64urlDecode(h!))),
    claims: JSON.parse(new TextDecoder().decode(b64urlDecode(c!))),
    signingInput: `${h}.${c}`,
    signature: b64urlDecode(s!),
  };
}

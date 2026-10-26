import net from 'node:net';
import { ProxyError } from './errors.js';
import type { FlareSolverrConfig, NetworkProxy } from './types.js';

export const DEFAULT_FLARESOLVERR_TIMEOUT_MS = 60_000;
/** Extra HTTP time allowed on top of the solver's maxTimeout (S14.8). */
const HTTP_TIMEOUT_GRACE_MS = 5_000;
/** URL solved by `test()` when none is given. */
export const DEFAULT_FLARESOLVERR_TEST_URL = 'https://example.com/';

/** Lower-cased substrings that mark a challenge page (S14.7); data, not logic. */
export const CHALLENGE_MARKERS: readonly string[] = [
  'just a moment...',
  'access denied',
  'attention required! | cloudflare',
  'ddos-guard',
];

/** Lower-cased `Server` header values of challenge providers (S14.7). */
export const CHALLENGE_SERVERS: readonly string[] = ['cloudflare', 'cloudflare-nginx', 'ddos-guard'];

const ERROR_1020 = 'error code: 1020';

/**
 * S14.7 detection: `Server` is a known challenge provider, status 403/503 and the body has a
 * marker; or the body is exactly `error code: 1020`; or the legacy DDoS heuristic
 * (`Vary: Accept-Encoding,User-Agent`, no Content-Encoding, body mentions "ddos", status 403/503).
 */
export function isChallengeResponse(status: number, headers: Headers, body: string): boolean {
  if (body.trim() === ERROR_1020) return true;
  if (status !== 403 && status !== 503) return false;
  const lower = body.toLowerCase();
  const server = (headers.get('server') ?? '').trim().toLowerCase();
  if (CHALLENGE_SERVERS.includes(server) && CHALLENGE_MARKERS.some((m) => lower.includes(m))) return true;
  const vary = (headers.get('vary') ?? '').replace(/\s+/g, '').toLowerCase();
  return vary === 'accept-encoding,user-agent' && !headers.has('content-encoding') && lower.includes('ddos');
}

export interface FlareSolverrCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
}

export interface FlareSolverrSolution {
  url: string;
  status: number;
  response: string;
  headers: Record<string, string>;
  cookies: FlareSolverrCookie[];
  userAgent: string;
}

export interface FlareSolverrClientOptions {
  fetchImpl?: typeof fetch;
  /** Forwarded to the solver as `{proxy:{url,username,password}}` so it egresses from the same IP. */
  proxy?: NetworkProxy;
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function parseCookies(raw: unknown): FlareSolverrCookie[] {
  if (!Array.isArray(raw)) return [];
  const out: FlareSolverrCookie[] = [];
  for (const c of raw) {
    if (!isObject(c)) continue;
    const name = asString(c['name']);
    if (!name) continue;
    const cookie: FlareSolverrCookie = { name, value: asString(c['value']) ?? '' };
    const domain = asString(c['domain']);
    const path = asString(c['path']);
    const expires = c['expires'];
    if (domain !== undefined) cookie.domain = domain;
    if (path !== undefined) cookie.path = path;
    if (typeof expires === 'number' && Number.isFinite(expires)) cookie.expires = expires;
    out.push(cookie);
  }
  return out;
}

function parseSolution(raw: unknown, requestedUrl: string): FlareSolverrSolution {
  if (!isObject(raw)) throw new ProxyError('flaresolverr', 'FlareSolverr response has no solution');
  const headers: Record<string, string> = {};
  const rawHeaders = raw['headers'];
  if (isObject(rawHeaders)) {
    for (const [k, v] of Object.entries(rawHeaders)) if (v !== undefined && v !== null) headers[k] = String(v);
  }
  const cookies = parseCookies(raw['cookies']);
  if (cookies.length === 0) throw new ProxyError('flaresolverr', 'Empty cookies returned by FlareSolverr');
  const status = raw['status'];
  return {
    url: asString(raw['url']) ?? requestedUrl,
    status: typeof status === 'number' ? status : 0,
    response: asString(raw['response']) ?? '',
    headers,
    cookies,
    userAgent: asString(raw['userAgent']) ?? '',
  };
}

function proxyPayload(proxy: NetworkProxy): Json {
  const host = net.isIPv6(proxy.host) ? `[${proxy.host}]` : proxy.host;
  const payload: Json = { url: `${proxy.type === 'socks5' ? 'socks5' : 'http'}://${host}:${proxy.port}` };
  if (proxy.username !== undefined && proxy.username !== '') payload['username'] = proxy.username;
  if (proxy.password !== undefined && proxy.password !== '') payload['password'] = proxy.password;
  return payload;
}

/** Client for the FlareSolverr `/v1` JSON API (S14.8-S14.13). */
export class FlareSolverrClient {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly useSession: boolean;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly proxy: NetworkProxy | undefined;
  private readonly apiKey: string | undefined;
  private sessionPromise: Promise<string> | undefined;

  constructor(config: FlareSolverrConfig, options: FlareSolverrClientOptions = {}) {
    this.endpoint = `${config.url.replace(/\/+$/, '')}/v1`;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_FLARESOLVERR_TIMEOUT_MS;
    this.useSession = config.useSession ?? false;
    this.fetchImpl = options.fetchImpl;
    this.proxy = options.proxy;
    this.apiKey = config.apiKey;
  }

  /** `request.get` */
  get(url: string): Promise<FlareSolverrSolution> {
    return this.solve({ cmd: 'request.get', url });
  }

  /** `request.post` with an `application/x-www-form-urlencoded` body string. */
  post(url: string, postData: string): Promise<FlareSolverrSolution> {
    return this.solve({ cmd: 'request.post', url, postData });
  }

  /** `sessions.create`; the id is remembered and used by later get/post calls. */
  async createSession(): Promise<string> {
    const payload: Json = { cmd: 'sessions.create' };
    if (this.proxy) payload['proxy'] = proxyPayload(this.proxy);
    const json = await this.call(payload);
    const id = asString(json['session']);
    if (!id) throw new ProxyError('flaresolverr', 'FlareSolverr did not return a session id');
    this.sessionPromise = Promise.resolve(id);
    return id;
  }

  /** `sessions.destroy` for the session in use, if any. */
  async destroy(): Promise<void> {
    const pending = this.sessionPromise;
    this.sessionPromise = undefined;
    if (!pending) return;
    let id: string;
    try {
      id = await pending;
    } catch {
      return; // creation failed; nothing to destroy
    }
    await this.call({ cmd: 'sessions.destroy', session: id });
  }

  /** S14.13: solve a harmless URL; requires HTTP 200 and parseable JSON. */
  async test(url: string = DEFAULT_FLARESOLVERR_TEST_URL): Promise<{ ok: true; version?: string } | { ok: false; message: string }> {
    try {
      const { status, json } = await this.post200or500({ cmd: 'request.get', url, maxTimeout: this.timeoutMs });
      if (status !== 200) return { ok: false, message: `FlareSolverr returned HTTP ${status}${json && asString(json['message']) ? `: ${asString(json['message'])}` : ''}` };
      if (!json) return { ok: false, message: 'FlareSolverr returned an unparseable response' };
      const version = asString(json['version']);
      return version === undefined ? { ok: true } : { ok: true, version };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private ensureSession(): Promise<string> {
    if (!this.sessionPromise) {
      const p = this.createSession();
      this.sessionPromise = p;
      p.catch(() => {
        if (this.sessionPromise === p) this.sessionPromise = undefined;
      });
    }
    return this.sessionPromise;
  }

  private async solve(base: Json): Promise<FlareSolverrSolution> {
    const payload: Json = { ...base, maxTimeout: this.timeoutMs };
    if (this.useSession) payload['session'] = await this.ensureSession();
    if (this.proxy) payload['proxy'] = proxyPayload(this.proxy);
    const json = await this.call(payload);
    return parseSolution(json['solution'], String(base['url']));
  }

  /** POST a command; maps transport, HTTP and `status:"error"` failures to ProxyError. */
  private async call(payload: Json): Promise<Json> {
    const { status, json } = await this.post200or500(payload);
    if (!json) throw new ProxyError('flaresolverr', `FlareSolverr returned an unparseable response (HTTP ${status})`);
    const st = asString(json['status']);
    if (status !== 200 || (st !== undefined && st !== 'ok')) {
      const message = asString(json['message']) ?? `HTTP ${status}`;
      throw new ProxyError('flaresolverr', `FlareSolverr error: ${message}`);
    }
    return json;
  }

  private async post200or500(payload: Json): Promise<{ status: number; json: Json | undefined }> {
    const f = this.fetchImpl ?? globalThis.fetch;
    const httpTimeout = this.timeoutMs + HTTP_TIMEOUT_GRACE_MS;
    let response: Response;
    try {
      response = await f(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(httpTimeout),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'TimeoutError' || (err instanceof ProxyError && err.code === 'timeout')) {
        throw new ProxyError('timeout', `FlareSolverr did not answer within ${httpTimeout} ms`, { cause: err });
      }
      throw new ProxyError('flaresolverr', `Cannot reach FlareSolverr at ${this.endpoint}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    const text = await response.text();
    if (response.status !== 200 && response.status !== 500) {
      throw new ProxyError('flaresolverr', `FlareSolverr returned HTTP ${response.status}`);
    }
    let json: Json | undefined;
    try {
      const parsed: unknown = JSON.parse(text);
      json = isObject(parsed) ? parsed : undefined;
    } catch {
      json = undefined;
    }
    return { status: response.status, json };
  }
}

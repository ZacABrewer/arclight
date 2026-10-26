import { MigrateError } from './errors.js';

// HTTP access to a running source app (API mode). One `SourceHttp` per source: base URL, the
// auth header the app expects, a timeout, a small concurrency limit (an old Sonarr with a few
// thousand series is read with one request per series) and error mapping to MigrateError.
// Read-only by convention: readers only GET. The two exceptions are qBittorrent's login (a
// POST that changes nothing) and the explicitly confirmed qBittorrent pause/remove step.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface SourceHttpOptions {
  baseUrl: string;
  /** Extra headers on every request, e.g. `{ 'X-Api-Key': key }`. */
  headers?: Record<string, string>;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Requests in flight at once. Default 6. */
  concurrency?: number;
  /** For error messages, e.g. "Sonarr". */
  appName: string;
}

export type Query = Record<string, string | number | boolean | Array<string | number> | undefined>;

export interface RequestInitLite {
  method?: 'GET' | 'POST';
  query?: Query;
  /** Form-urlencoded body (POST). */
  form?: Record<string, string>;
  headers?: Record<string, string>;
  /** Statuses returned instead of thrown (e.g. 404 for "endpoint absent in this version"). */
  allow?: number[];
}

const DEFAULT_TIMEOUT_MS = 30_000;

function describe(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'the request timed out';
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return cause.message;
    return err.message;
  }
  return String(err);
}

/** `http://host:port/base` with no trailing slash. */
export function normaliseBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export class SourceHttp {
  readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly concurrency: number;
  private readonly appName: string;
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(opts: SourceHttpOptions) {
    this.baseUrl = normaliseBaseUrl(opts.baseUrl);
    this.headers = { Accept: 'application/json', ...(opts.headers ?? {}) };
    this.fetchImpl = opts.fetch ?? ((u, i) => globalThis.fetch(u, i));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.concurrency = Math.max(1, opts.concurrency ?? 6);
    this.appName = opts.appName;
  }

  url(path: string, query?: Query): string {
    const u = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const item of v) u.searchParams.append(k, String(item));
      else u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  /** Raw response; network failures and unexpected statuses become MigrateError. */
  async request(path: string, init: RequestInitLite = {}): Promise<Response> {
    return this.slot(async () => {
      const method = init.method ?? (init.form ? 'POST' : 'GET');
      const headers: Record<string, string> = { ...this.headers, ...(init.headers ?? {}) };
      let body: string | undefined;
      if (init.form) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams(init.form).toString();
      }
      let res: Response;
      try {
        res = await this.fetchImpl(this.url(path, init.query), { method, headers, ...(body !== undefined ? { body } : {}), signal: AbortSignal.timeout(this.timeoutMs), redirect: 'manual' });
      } catch (err) {
        throw new MigrateError('UNREACHABLE', `${this.appName} could not be reached at ${this.baseUrl}: ${describe(err)}`);
      }
      if (res.ok || init.allow?.includes(res.status)) return res;
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 401 || res.status === 403) throw new MigrateError('AUTH', `${this.appName} rejected the API key or credentials (HTTP ${res.status})`);
      if (res.status >= 300 && res.status < 400) {
        throw new MigrateError('UNREACHABLE', `${this.appName} redirected ${path} (HTTP ${res.status}); check the URL base, or whether a login page or reverse proxy sits in front of it`);
      }
      throw new MigrateError('SOURCE_UNREADABLE', `${this.appName} answered HTTP ${res.status} for ${path}`);
    });
  }

  async json<T = unknown>(path: string, init: RequestInitLite = {}): Promise<T> {
    const res = await this.request(path, init);
    const text = await res.text();
    if (init.allow?.includes(res.status) && !res.ok) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new MigrateError('SOURCE_UNREADABLE', `${this.appName} returned something that is not JSON for ${path} (is the URL right?)`);
    }
  }

  /** JSON, or `fallback` when the endpoint does not exist in this version (404/405). */
  async optionalJson<T>(path: string, fallback: T, init: RequestInitLite = {}): Promise<T> {
    const res = await this.request(path, { ...init, allow: [...(init.allow ?? []), 404, 405] });
    if (res.status === 404 || res.status === 405) {
      await res.body?.cancel().catch(() => undefined);
      return fallback;
    }
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      return fallback;
    }
  }

  async text(path: string, init: RequestInitLite = {}): Promise<string> {
    return (await this.request(path, init)).text();
  }

  async bytes(path: string, init: RequestInitLite = {}): Promise<Buffer> {
    return Buffer.from(await (await this.request(path, init)).arrayBuffer());
  }

  /** Maps over items with this client's concurrency (each callback usually makes one request). */
  async map<T, R>(items: readonly T[], fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    return Promise.all(items.map((item, i) => fn(item, i)));
  }
}

/**
 * Every record of a paged arr endpoint (`{ page, pageSize, totalRecords, records }`), oldest
 * first. Stops at `limit` records.
 */
export async function fetchAllPages<T>(http: SourceHttp, path: string, query: Query = {}, pageSize = 1000, limit = 200_000): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; out.length < limit; page++) {
    const body = await http.json<{ records?: T[]; totalRecords?: number }>(path, { query: { ...query, page, pageSize } });
    const records = Array.isArray(body?.records) ? body.records : [];
    out.push(...records);
    const total = typeof body?.totalRecords === 'number' ? body.totalRecords : out.length;
    if (records.length < pageSize || out.length >= total) break;
  }
  return out.slice(0, limit);
}

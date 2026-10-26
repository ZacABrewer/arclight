import { eq } from 'drizzle-orm';
import type { IndexerProxyCreate, IndexerProxyUpdate, ProxyAutoDetectResult } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { indexerProxies, tags } from '../../db/schema.js';

// ProxyAutoDetect: keeps the challenge-solver indexer proxies in step with the environment.
//  - "FlareSolverr (bundled)": created once when no (non-built-in) FlareSolverr proxy exists and
//    ARCLIGHT_FLARESOLVERR_URL is set or a FlareSolverr answers at the default URL.
//  - "Built-in solver": the api's own FlareSolverr-compatible endpoint (/api/v1/solver), present
//    while `solver.enabled` is on and a browser was found; its API key / port / timeout are
//    re-synced on every run and it is removed when the solver becomes unavailable.
// Both are tagged `cloudflare`.

export const PROXY_AUTODETECT_JOB = 'ProxyAutoDetect';
export const PROXY_AUTODETECT_CRON = '*/10 * * * *';
export const BUNDLED_PROXY_NAME = 'FlareSolverr (bundled)';
export const BUILTIN_PROXY_NAME = 'Built-in solver';
export const CLOUDFLARE_TAG = 'cloudflare';
export const DEFAULT_FLARESOLVERR_URL = 'http://localhost:8191';
/** Path of the built-in endpoint; FlareSolverr clients append `/v1`. */
export const SOLVER_ROUTE_BASE = '/api/v1/solver';
const FLARESOLVERR_DEFAULT_PORT = 8191;

type ProxyRow = typeof indexerProxies.$inferSelect;

export interface BuiltinSolverState {
  available: boolean;
  /** Host the api listens on (config.host) and its port. */
  listenHost: string;
  port: number;
  apiKey: string;
  timeoutSeconds: number;
}

export interface AutoDetectDeps {
  db: Db;
  proxies: {
    allRows(): ProxyRow[];
    create(input: IndexerProxyCreate): { id: number };
    update(id: number, input: IndexerProxyUpdate): { id: number };
    delete(id: number): void;
  };
  /** ARCLIGHT_FLARESOLVERR_URL. */
  envUrl: string | undefined;
  /** True when a FlareSolverr answers at `url` (base URL, no /v1). */
  probe(url: string): Promise<boolean>;
  builtin(): BuiltinSolverState;
  log?: { info(msg: string): void; warn(msg: string): void };
}

export function isBuiltinSolverRow(row: Pick<ProxyRow, 'type' | 'host'>): boolean {
  return row.type === 'flaresolverr' && row.host.includes(SOLVER_ROUTE_BASE);
}

/** The id of the `cloudflare` tag, created when missing. */
export function ensureTag(db: Db, label: string): number {
  const normalised = label.trim().toLowerCase();
  const existing = db.select().from(tags).where(eq(tags.label, normalised)).get();
  if (existing) return existing.id;
  return db.insert(tags).values({ label: normalised }).returning().get().id;
}

/** `{host, port}` for a proxy row from a FlareSolverr base URL (scheme kept in host). */
export function proxyTarget(raw: string): { host: string; port: number } | undefined {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `http://${raw.trim()}`);
  } catch {
    return undefined;
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  return { host: `${url.protocol}//${url.hostname}${path}`, port: url.port ? Number(url.port) : FLARESOLVERR_DEFAULT_PORT };
}

/** Loopback address the api reaches itself on, given the address it listens on. */
export function loopbackFor(listenHost: string): string {
  const h = listenHost.trim();
  if (h === '' || h === '0.0.0.0' || h === 'localhost' || h === '127.0.0.1') return '127.0.0.1';
  if (h === '::' || h === '[::]' || h === '::1') return '[::1]';
  return h.includes(':') && !h.startsWith('[') ? `[${h}]` : h;
}

/** POST {cmd:"sessions.list"} to `${base}/v1`; true on a FlareSolverr-shaped "ok". */
export async function probeFlareSolverr(base: string, fetchImpl: typeof fetch = fetch, timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await fetchImpl(`${base.replace(/\/+$/, '')}/v1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: 'sessions.list' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const json = (await res.json().catch(() => null)) as { status?: unknown } | null;
    return json?.status === 'ok';
  } catch {
    return false;
  }
}

export async function runProxyAutoDetect(deps: AutoDetectDeps): Promise<ProxyAutoDetectResult> {
  const messages: string[] = [];
  let bundledCreated: number | null = null;
  let builtinProxyId: number | null = null;
  let tagId: number | undefined;
  const tag = () => (tagId ??= ensureTag(deps.db, CLOUDFLARE_TAG));
  const nameTaken = (name: string) => deps.proxies.allRows().some((r) => r.name.toLowerCase() === name.toLowerCase());

  // ---- bundled / external FlareSolverr ------------------------------------------------
  const external = deps.proxies.allRows().filter((r) => r.type === 'flaresolverr' && !isBuiltinSolverRow(r));
  if (external.length === 0) {
    const envUrl = deps.envUrl?.trim();
    let url: string | undefined;
    if (envUrl) url = envUrl;
    else if (await deps.probe(DEFAULT_FLARESOLVERR_URL)) url = DEFAULT_FLARESOLVERR_URL;
    const target = url ? proxyTarget(url) : undefined;
    if (url && !target) {
      messages.push(`ARCLIGHT_FLARESOLVERR_URL "${url}" is not a valid URL`);
      deps.log?.warn(messages.at(-1) as string);
    } else if (target && !nameTaken(BUNDLED_PROXY_NAME)) {
      const created = deps.proxies.create({ name: BUNDLED_PROXY_NAME, type: 'flaresolverr', host: target.host, port: target.port, tags: [tag()] });
      bundledCreated = created.id;
      messages.push(`Registered ${BUNDLED_PROXY_NAME} at ${url}`);
      deps.log?.info(messages.at(-1) as string);
    }
  }

  // ---- built-in solver ----------------------------------------------------------------
  const state = deps.builtin();
  const existing = deps.proxies.allRows().find(isBuiltinSolverRow);
  if (state.available) {
    const desired = {
      host: `http://${loopbackFor(state.listenHost)}${SOLVER_ROUTE_BASE}`,
      port: state.port,
      password: state.apiKey,
      requestTimeout: Math.min(600, Math.max(1, state.timeoutSeconds)),
    };
    if (!existing) {
      const name = nameTaken(BUILTIN_PROXY_NAME) ? `${BUILTIN_PROXY_NAME} (Arclight)` : BUILTIN_PROXY_NAME;
      builtinProxyId = deps.proxies.create({ name, type: 'flaresolverr', ...desired, tags: [tag()] }).id;
      messages.push(`Registered ${name}`);
      deps.log?.info(messages.at(-1) as string);
    } else {
      builtinProxyId = existing.id;
      const stale =
        existing.host !== desired.host ||
        existing.port !== desired.port ||
        existing.password !== desired.password ||
        existing.requestTimeout !== desired.requestTimeout;
      if (stale) {
        deps.proxies.update(existing.id, desired);
        messages.push(`Updated ${existing.name}`);
      }
    }
  } else if (existing) {
    deps.proxies.delete(existing.id);
    messages.push(`Removed ${existing.name}: the built-in solver is disabled or no browser was found`);
    deps.log?.info(messages.at(-1) as string);
  }

  return { bundledCreated, builtinProxyId, messages };
}

import { PROBE_TIMEOUT_MS } from '../config';
import { candidateUrls, isInsecurePublic, normalizeBaseUrl, parseAddress } from './address';
import { transportOf } from './transport';

// Is there an Arclight server at this base URL?
//   GET /api/v1/system/ping   -> 200 { status: "ok" }                          (public)
//   GET /api/v1/auth/status   -> 200 { needsSetup, adminExists, authenticated } (public)
// /auth/status is what proves it is Arclight (other apps answer a ping too).
// The app's pages are served from capacitor://localhost / https://localhost, so these are
// cross-origin requests: the server allows those origins (CORS) for /api/v1.

export type ProbeFailure = 'unreachable' | 'timeout' | 'tls' | 'not-arclight' | 'cors';

export type ProbeResult =
  | { ok: true; url: string; needsSetup: boolean; insecure: boolean }
  | { ok: false; url: string; reason: ProbeFailure; detail?: string };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function getJson(fetchImpl: FetchLike, url: string, timeoutMs: number): Promise<{ status: number; data: unknown; url: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: ctl.signal, credentials: 'omit' });
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      data = undefined;
    }
    return { status: res.status, data, url: res.url || url };
  } finally {
    clearTimeout(timer);
  }
}

function isPing(d: unknown): boolean {
  const o = d as Record<string, unknown> | undefined;
  return !!o && typeof o === 'object' && typeof o.status === 'string' && o.status.toLowerCase() === 'ok';
}

function isAuthStatus(d: unknown): d is { needsSetup: boolean; adminExists: boolean; authenticated: boolean } {
  const o = d as Record<string, unknown> | undefined;
  return !!o && typeof o === 'object' && typeof o.needsSetup === 'boolean' && typeof o.authenticated === 'boolean' && typeof o.adminExists === 'boolean';
}

export function classifyFetchError(err: unknown): ProbeFailure {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout';
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  if (/certificate|ssl|tls|trust/.test(msg)) return 'tls';
  return 'unreachable';
}

/** Base URL after redirects: the final ping URL minus the ping path. */
function baseFromFinal(requested: string, finalUrl: string): string {
  const suffix = '/api/v1/system/ping';
  try {
    const u = new URL(finalUrl);
    if (u.pathname.endsWith(suffix)) {
      u.pathname = u.pathname.slice(0, -suffix.length);
      u.search = '';
      return normalizeBaseUrl(u.toString());
    }
  } catch {
    /* fall through */
  }
  return requested;
}

export async function probeServer(fetchImpl: FetchLike, baseUrl: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  const base = normalizeBaseUrl(baseUrl);
  let url = base;
  try {
    const ping = await getJson(fetchImpl, `${base}/api/v1/system/ping`, timeoutMs);
    if (ping.status !== 200 || !isPing(ping.data)) return { ok: false, url, reason: 'not-arclight', detail: `ping answered HTTP ${ping.status}` };
    url = baseFromFinal(base, ping.url);
    const status = await getJson(fetchImpl, `${url}/api/v1/auth/status`, timeoutMs);
    if (status.status !== 200 || !isAuthStatus(status.data)) return { ok: false, url, reason: 'not-arclight', detail: `auth status answered HTTP ${status.status}` };
    return { ok: true, url, needsSetup: status.data.needsSetup || !status.data.adminExists, insecure: isInsecurePublic(url) };
  } catch (err) {
    return { ok: false, url, reason: classifyFetchError(err), detail: (err as Error)?.message };
  }
}

export type ConnectResult =
  | { ok: true; url: string; needsSetup: boolean; insecure: boolean; tried: string[] }
  | { ok: false; reason: ProbeFailure | 'invalid'; message: string; tried: string[] };

const FAILURE_PRIORITY: ProbeFailure[] = ['not-arclight', 'tls', 'timeout', 'cors', 'unreachable'];

/**
 * Probes every candidate for what the user typed (in parallel) and returns the first, in
 * candidate order, that is Arclight. On failure, reports the most telling reason.
 * `message` is an i18n key (app.addServer.error.*) the screen translates with { host }.
 */
export async function connect(fetchImpl: FetchLike, input: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ConnectResult & { host?: string }> {
  let parsed;
  try {
    parsed = parseAddress(input);
  } catch (err) {
    return { ok: false, reason: 'invalid', message: (err as Error).message, tried: [] };
  }
  const tried = candidateUrls(parsed);
  const results = await Promise.all(tried.map((u) => probeServer(fetchImpl, u, timeoutMs)));
  const hit = results.find((r) => r.ok);
  if (hit && hit.ok) return { ok: true, url: hit.url, needsSetup: hit.needsSetup, insecure: hit.insecure, tried };
  const reasons = results.map((r) => (r.ok ? 'unreachable' : r.reason));
  const reason = FAILURE_PRIORITY.find((p) => reasons.includes(p)) ?? 'unreachable';
  return { ok: false, reason, message: `app.addServer.error.${reason}`, tried, host: parsed.host + (parsed.port ? `:${parsed.port}` : '') };
}

/**
 * The https:// address of an http:// server, when Arclight answers there: the same port first,
 * then the default port (a reverse proxy in front of :7878). Null when none answers, or `url` is
 * already https.
 */
export async function findHttps(fetchImpl: FetchLike, url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<string | null> {
  if (transportOf(url) === 'https') return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const path = u.pathname.replace(/\/+$/, '');
  const bareHost = u.host.replace(/:\d+$/, '');
  const tries = [...new Set([`https://${u.host}${path}`, `https://${bareHost}${path}`])];
  const results = await Promise.all(tries.map((t) => probeServer(fetchImpl, t, timeoutMs)));
  const hit = results.find((r) => r.ok && transportOf(r.url) === 'https');
  return hit ? hit.url : null;
}

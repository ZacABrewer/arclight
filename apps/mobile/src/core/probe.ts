import { PROBE_TIMEOUT_MS } from '../config.js';
import { candidateUrls, isInsecurePublic, normalizeBaseUrl, parseAddress } from './address.js';
import { classifyNetworkError, type HttpClient } from './http.js';

// Is there an Arclight server at this base URL?
//   GET /api/v1/system/ping   -> 200 { status: "ok" }           (public)
//   GET /api/v1/auth/status   -> 200 { needsSetup, adminExists, authMethod, authenticated, session, ... } (public)
// Both are public routes (apps/api/src/modules/auth/hook.ts); /auth/status is what proves it is
// Arclight (the *arr apps also answer a ping) and tells whether someone must sign in.

export type ProbeFailure = 'unreachable' | 'timeout' | 'tls' | 'not-arclight';

export type ProbeResult =
  | { ok: true; url: string; needsSignIn: boolean; needsSetup: boolean; insecure: boolean }
  | { ok: false; url: string; reason: ProbeFailure; detail?: string };

interface AuthStatusShape {
  needsSetup: boolean;
  adminExists: boolean;
  authenticated: boolean;
}

function parseJson(data: unknown): unknown {
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

export function isAuthStatus(data: unknown): data is AuthStatusShape {
  const d = parseJson(data) as Record<string, unknown> | undefined;
  return !!d && typeof d === 'object' && typeof d.needsSetup === 'boolean' && typeof d.authenticated === 'boolean' && typeof d.adminExists === 'boolean';
}

function isPing(data: unknown): boolean {
  const d = parseJson(data) as Record<string, unknown> | undefined;
  return !!d && typeof d === 'object' && typeof d.status === 'string' && d.status.toLowerCase() === 'ok';
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

export async function probeServer(http: HttpClient, baseUrl: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  const base = normalizeBaseUrl(baseUrl);
  let url = base;
  try {
    const ping = await http({ method: 'GET', url: `${base}/api/v1/system/ping`, timeoutMs });
    if (ping.status !== 200 || !isPing(ping.data)) return { ok: false, url, reason: 'not-arclight', detail: `ping answered HTTP ${ping.status}` };
    url = baseFromFinal(base, ping.url || '');
    const status = await http({ method: 'GET', url: `${url}/api/v1/auth/status`, timeoutMs });
    const data = parseJson(status.data);
    if (status.status !== 200 || !isAuthStatus(data)) return { ok: false, url, reason: 'not-arclight', detail: `auth status answered HTTP ${status.status}` };
    return { ok: true, url, needsSignIn: !data.authenticated, needsSetup: data.needsSetup || !data.adminExists, insecure: isInsecurePublic(url) };
  } catch (err) {
    return { ok: false, url, reason: classifyNetworkError(err), detail: (err as Error)?.message };
  }
}

export type ConnectResult =
  | { ok: true; url: string; needsSignIn: boolean; needsSetup: boolean; insecure: boolean; tried: string[] }
  | { ok: false; reason: ProbeFailure | 'invalid'; message: string; tried: string[] };

const FAILURE_PRIORITY: ProbeFailure[] = ['not-arclight', 'tls', 'timeout', 'unreachable'];

export function failureMessage(reason: ProbeFailure | 'invalid', host?: string): string {
  switch (reason) {
    case 'not-arclight':
      return `Something answered at ${host ?? 'that address'}, but it is not an Arclight server. Check the port (Arclight uses 7878 by default) and any reverse-proxy path.`;
    case 'tls':
      return `The secure (HTTPS) connection to ${host ?? 'the server'} failed: its certificate is not trusted by this device. Use a certificate from a public authority (for example Let's Encrypt), or connect over http:// on your home network.`;
    case 'timeout':
      return `${host ?? 'The server'} did not answer in time. Check that it is running and that this phone is on the same network or VPN.`;
    case 'unreachable':
      return `Could not reach ${host ?? 'the server'}. Check the address, that the server is running, and that this phone is on the same network or VPN.`;
    case 'invalid':
      return 'That does not look like a server address.';
  }
}

/**
 * Probes every candidate for what the user typed (in parallel) and returns the first, in
 * candidate order, that is Arclight. On failure, reports the most telling reason
 * (something answered but was not Arclight > TLS > timeout > unreachable).
 */
export async function connect(http: HttpClient, input: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ConnectResult> {
  let parsed;
  try {
    parsed = parseAddress(input);
  } catch (err) {
    return { ok: false, reason: 'invalid', message: (err as Error).message, tried: [] };
  }
  const tried = candidateUrls(parsed);
  const results = await Promise.all(tried.map((u) => probeServer(http, u, timeoutMs)));
  const hit = results.find((r) => r.ok);
  if (hit && hit.ok) return { ok: true, url: hit.url, needsSignIn: hit.needsSignIn, needsSetup: hit.needsSetup, insecure: hit.insecure, tried };
  const reasons = results.map((r) => (r.ok ? 'unreachable' : r.reason));
  const reason = FAILURE_PRIORITY.find((p) => reasons.includes(p)) ?? 'unreachable';
  return { ok: false, reason, message: failureMessage(reason, parsed.host + (parsed.port ? `:${parsed.port}` : '')), tried };
}

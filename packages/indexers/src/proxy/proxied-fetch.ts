import type { CookieJar } from '../definitions/cookies.js';
import { ProxyError } from './errors.js';
import { FlareSolverrClient, isChallengeResponse } from './flaresolverr.js';
import type { FlareSolverrCookie } from './flaresolverr.js';
import { fetchWithProxy } from './http-client.js';
import { isFlareSolverr, isNetworkProxy } from './types.js';
import type { ProxyConfig } from './types.js';

export interface ProxiedFetchOptions {
  /** Base fetch used when there is no network proxy (tests inject fakes); also used to call FlareSolverr. */
  fetchImpl?: typeof fetch;
  /** Solved cookies are imported here. The jar is not read: callers build the Cookie header. */
  jar?: CookieJar;
  /** Per-host User-Agent cache (S14.10-S14.11); created internally if absent. */
  userAgents?: Map<string, string>;
}

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';

async function normalizeInput(input: RequestInfo | URL, init: RequestInit | undefined): Promise<{ url: URL; init: RequestInit }> {
  if (typeof Request !== 'undefined' && input instanceof Request) {
    const base: RequestInit = { method: input.method, headers: input.headers, redirect: input.redirect, signal: input.signal };
    if (input.method !== 'GET' && input.method !== 'HEAD' && input.body !== null) {
      const ct = (input.headers.get('content-type') ?? '').toLowerCase();
      base.body = ct.startsWith(FORM_CONTENT_TYPE) ? await input.text() : new Uint8Array(await input.arrayBuffer());
    }
    return { url: new URL(input.url), init: { ...base, ...(init ?? {}) } };
  }
  return { url: new URL(input as string | URL), init: { ...(init ?? {}) } };
}

/** The urlencoded body FlareSolverr's request.post needs, or a ProxyError (S14.8/S14.15). */
function formBodyFor(init: RequestInit, headers: Headers): string {
  const body = init.body;
  const ct = headers.get('content-type');
  const mime = ct === null ? null : (ct.split(';', 1)[0] ?? '').trim().toLowerCase();
  const formOk = mime === null || mime === FORM_CONTENT_TYPE;
  if (formOk && body instanceof URLSearchParams) return body.toString();
  if (formOk && typeof body === 'string') return body;
  if (body === null || body === undefined) return '';
  throw new ProxyError('flaresolverr', `Unsupported POST Content-Type${ct ? `: ${ct}` : ''}`);
}

function mergeCookieHeader(existing: string | null, cookies: readonly FlareSolverrCookie[]): string {
  const map = new Map<string, string>();
  if (existing) {
    for (const part of existing.split(';')) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      map.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
  }
  for (const c of cookies) map.set(c.name, c.value);
  return [...map].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function readChallengeCandidate(response: Response): Promise<string | undefined> {
  if (response.status !== 403 && response.status !== 503) return undefined;
  try {
    return await response.clone().text();
  } catch {
    return undefined;
  }
}

/**
 * Compose the proxies (at most one network proxy + at most one FlareSolverr; first of each kind
 * wins, S14.2) into a fetch-compatible function. See S14.7-S14.11 for the challenge flow: the
 * original request is tried first; a challenge response is solved by FlareSolverr, its cookies go
 * into `jar`, its UA is cached per host, and the original request is replayed with both.
 * Request bodies must be replayable (string, URLSearchParams, bytes), not streams.
 */
export function createProxiedFetch(proxies: ProxyConfig | readonly ProxyConfig[] | undefined, options: ProxiedFetchOptions = {}): typeof fetch {
  const list: readonly ProxyConfig[] = proxies === undefined ? [] : 'type' in proxies ? [proxies] : proxies;
  const network = list.find(isNetworkProxy);
  const solverConfig = list.find(isFlareSolverr);
  const userAgents = options.userAgents ?? new Map<string, string>();
  const solver = solverConfig
    ? new FlareSolverrClient(solverConfig, {
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(network ? { proxy: network } : {}),
    })
    : undefined;

  const send = (url: URL, init: RequestInit): Promise<Response> =>
    network ? fetchWithProxy(url, init, network, options.fetchImpl) : (options.fetchImpl ?? globalThis.fetch)(url, init);

  const proxied = async (input: RequestInfo | URL, rawInit?: RequestInit): Promise<Response> => {
    const { url, init } = await normalizeInput(input, rawInit);
    const headers = new Headers(init.headers);
    const cachedUa = userAgents.get(url.host);
    if (cachedUa && !headers.has('user-agent')) headers.set('user-agent', cachedUa);
    const first = await send(url, { ...init, headers });
    if (!solver) return first;

    const body = await readChallengeCandidate(first);
    if (body === undefined || !isChallengeResponse(first.status, first.headers, body)) return first;
    await first.body?.cancel().catch(() => {});

    const method = (init.method ?? 'GET').toUpperCase();
    let solution;
    if (method === 'GET' || method === 'HEAD') solution = await solver.get(url.href);
    else if (method === 'POST') solution = await solver.post(url.href, formBodyFor(init, headers));
    else throw new ProxyError('flaresolverr', `FlareSolverr cannot solve ${method} requests`);
    if (solution.cookies.length === 0) throw new ProxyError('flaresolverr', 'Empty cookies returned by FlareSolverr');

    if (options.jar) for (const c of solution.cookies) options.jar.set(c.name, c.value);
    if (solution.userAgent) userAgents.set(url.host, solution.userAgent);

    const replayHeaders = new Headers(headers);
    replayHeaders.set('cookie', mergeCookieHeader(headers.get('cookie'), solution.cookies));
    if (solution.userAgent) replayHeaders.set('user-agent', solution.userAgent);
    const replay = await send(url, { ...init, headers: replayHeaders });

    const replayBody = await readChallengeCandidate(replay);
    if (replayBody !== undefined && isChallengeResponse(replay.status, replay.headers, replayBody)) {
      await replay.body?.cancel().catch(() => {});
      throw new ProxyError('flaresolverr', `CloudflareChallenge: ${url.host} still returned a challenge after FlareSolverr solved it`);
    }
    return replay;
  };
  return proxied as typeof fetch;
}

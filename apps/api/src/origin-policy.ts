import type { FastifyRequest } from 'fastify';
import type { Db } from './db/index.js';
import { normalizeHostname } from './modules/requests/portal-routing.js';
import { getSection } from './modules/settings/service.js';
import { hasLinkParams } from './modules/playback/links.js';

// Which browser origins may read API responses (CORS) and open the /events WebSocket.
//
// The session cookie is SameSite=Lax, which stops other *sites* but not other origins of the same
// site: another app on the same NAS (a different port) or a sibling subdomain gets the cookie
// sent along. The local-address bypass and cached Basic credentials need no cookie at all. So an
// origin is never reflected just because it asked:
//   - credentialed (cookies): the page's own origin (same host as the request), the Application
//     URL and the portal hostnames (Settings > Requests), and ARCLIGHT_CORS_ORIGINS;
//   - without credentials: the Arclight apps (capacitor://localhost, http(s)://localhost), which
//     send `Authorization: Bearer`, and signed media links (cast receivers fetch them from their
//     own origin; the signature is the authorisation);
//   - anyone else: no CORS headers, so the browser keeps the response from the page.
// Without a built web app to serve (development: the Vite dev server on another localhost port
// proxies /api), http://localhost:<port> and http://127.0.0.1:<port> count as the page's own origin.

/** The player and companion apps' WebView origins (iOS, Android). */
export const APP_ORIGINS: ReadonlySet<string> = new Set(['capacitor://localhost', 'https://localhost', 'http://localhost']);

export type OriginVerdict = 'credentialed' | 'anonymous' | 'refused';

interface CachedHosts {
  at: number;
  origins: Set<string>;
  hostnames: Set<string>;
}

const CACHE_MS = 5_000;

/** "https://Example.com:443/x" → "https://example.com"; null when it is not an http(s) URL. */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}

/** ARCLIGHT_CORS_ORIGINS: a comma- or space-separated list of extra origins allowed with cookies. */
export function parseCorsOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[\s,]+/)
    .map((o) => originOf(o.trim()))
    .filter((o): o is string => o !== null);
}

/** GET / HEAD, or the preflight of one. */
function readsOnly(req: FastifyRequest): boolean {
  const method = req.method === 'OPTIONS' ? String(req.headers['access-control-request-method'] ?? '').toUpperCase() : req.method;
  return method === 'GET' || method === 'HEAD';
}

export class OriginPolicy {
  private cached: CachedHosts | null = null;
  private readonly extra: Set<string>;
  private readonly dev: boolean;
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    extraOrigins: readonly string[] = [],
    opts: { dev?: boolean; now?: () => number } = {},
  ) {
    this.extra = new Set(extraOrigins);
    this.dev = opts.dev ?? false;
    this.now = opts.now ?? Date.now;
  }

  /** How a request with this Origin header may be answered. */
  verdict(req: FastifyRequest, origin: string | undefined): OriginVerdict {
    if (!origin) return 'refused';
    const lower = origin.toLowerCase();
    if (this.isSameHost(req, lower)) return 'credentialed';
    if (this.extra.has(lower)) return 'credentialed';
    if (this.dev && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(lower)) return 'credentialed';
    const configured = this.configured();
    if (configured.origins.has(lower)) return 'credentialed';
    const parsed = originOf(lower);
    if (parsed && configured.hostnames.has(normalizeHostname(new URL(parsed).host))) return 'credentialed';
    if (APP_ORIGINS.has(lower)) return 'anonymous';
    if (readsOnly(req) && hasLinkParams(req.query)) return 'anonymous';
    return 'refused';
  }

  /** Whether a browser page from `origin` may use the caller's cookies here (the WebSocket check). */
  allowsCredentials(req: FastifyRequest, origin: string | undefined): boolean {
    // No Origin: not a browser page (scripts, the apps' native code); they authenticate on their own.
    if (!origin) return true;
    return this.verdict(req, origin) === 'credentialed';
  }

  private isSameHost(req: FastifyRequest, origin: string): boolean {
    const parsed = originOf(origin);
    if (!parsed) return false;
    const host = new URL(parsed).host;
    const own = (req.host ?? '').toLowerCase();
    if (!own) return false;
    // Ports are dropped by URL for the scheme's default; compare both ways.
    return host === own || host === own.replace(/:(80|443)$/, '');
  }

  private configured(): CachedHosts {
    const t = this.now();
    if (this.cached && t - this.cached.at < CACHE_MS) return this.cached;
    const origins = new Set<string>();
    const hostnames = new Set<string>();
    try {
      const requests = getSection(this.db, 'requests');
      const app = originOf(requests.applicationUrl);
      if (app) origins.add(app);
      if (requests.publicPortal.enabled) for (const h of requests.publicPortal.hosts) hostnames.add(normalizeHostname(h.hostname));
    } catch {
      // Settings unreadable (a broken database): only the page's own origin and the env list.
    }
    this.cached = { at: t, origins, hostnames };
    return this.cached;
  }
}

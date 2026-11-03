import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../../db/index.js';
import { normalizeHostname } from '../requests/portal-routing.js';
import { getSection } from '../settings/service.js';
import { isPublicRoute } from './hook.js';

// A portal-only hostname (Settings > Requests > public portal, "portal only") is a real boundary
// for the API too (AUTH-25), not only for page loads: there, a signed-in admin (browser session,
// Basic, an app token or the local-address rule) reaches the same routes as a portal user, so
// someone who guesses or phishes an admin password on the public portal address still cannot
// use the admin API through it. Routes open to portal users (`config.access`) and public routes
// (sign-in, setup) answer as before. API keys keep working on every hostname: they are not typed
// into the portal's sign-in form, and automations may use the public address.

const CACHE_MS = 5_000;
const BROWSER_VIAS: ReadonlySet<string> = new Set(['session', 'basic', 'app', 'bypass']);

export class PortalOnlyHosts {
  private cached: { at: number; hosts: Set<string> } | null = null;

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether `host` (a Host header) is a portal-only hostname of the enabled public portal. */
  has(host: string | undefined): boolean {
    const t = this.now();
    if (!this.cached || t - this.cached.at >= CACHE_MS) {
      const hosts = new Set<string>();
      try {
        const portal = getSection(this.db, 'requests').publicPortal;
        if (portal.enabled) for (const h of portal.hosts) if (h.portalOnly) hosts.add(normalizeHostname(h.hostname));
      } catch {
        // Settings unreadable: no portal hostnames.
      }
      this.cached = { at: t, hosts };
    }
    return this.cached.hosts.size > 0 && this.cached.hosts.has(normalizeHostname(host));
  }
}

/** The onRequest hook (after the auth hook): 403 PORTAL_ONLY_HOST for admin-only routes on a portal-only hostname. */
export function portalHostGuard(hosts: PortalOnlyHosts) {
  return async function guard(req: FastifyRequest, reply: FastifyReply) {
    const auth = req.auth;
    if (!auth?.isAdmin || !BROWSER_VIAS.has(auth.via)) return;
    const routeUrl = req.routeOptions.url;
    if (!routeUrl || isPublicRoute(routeUrl) || req.routeOptions.config?.access) return;
    if (!hosts.has(req.host)) return;
    return reply.code(403).send({ error: 'admin pages are not available on the request portal address', code: 'PORTAL_ONLY_HOST' });
  };
}

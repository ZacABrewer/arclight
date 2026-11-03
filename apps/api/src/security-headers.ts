import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from './db/index.js';
import { normalizeHostname } from './modules/requests/portal-routing.js';
import { getSection } from './modules/settings/service.js';

// Response headers that make the browser stricter about Arclight's pages:
//   - every response: X-Content-Type-Options nosniff, Referrer-Policy same-origin (signed links
//     and tokens in URLs never leave in a Referer), and frame protection (X-Frame-Options
//     SAMEORIGIN plus CSP frame-ancestors 'self'), so no other site can frame the admin UI for
//     clickjacking;
//   - HTML pages: a Content-Security-Policy that only runs Arclight's own scripts. Images, media,
//     styles and fonts may come from anywhere (posters, theme packs, media servers on the LAN);
//   - Strict-Transport-Security on https requests to the Application URL's host when that URL is
//     https, so browsers stop trying plain http there. Other hosts (a LAN address with a
//     self-signed certificate) never get it, so it cannot lock anyone out of plain-http access.
// A route that sets its own Content-Security-Policy (the Wrapped share page) keeps it.

export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' data: blob: https: http:",
  "media-src 'self' data: blob: https: http:",
  "font-src 'self' data: https:",
  "connect-src 'self' https: http: ws: wss:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "frame-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
].join('; ');

/** Only frame-ancestors: for responses that are not pages (JSON, files, streams). */
export const DEFAULT_CSP = "frame-ancestors 'self'";

/** Six months, without includeSubDomains (other services on the domain may still be http). */
export const HSTS_VALUE = 'max-age=15552000';

const CACHE_MS = 5_000;

/** The Application URL's hostname when it is https; null otherwise. */
export function httpsApplicationHost(applicationUrl: string): string | null {
  try {
    const u = new URL(applicationUrl);
    return u.protocol === 'https:' ? normalizeHostname(u.host) : null;
  } catch {
    return null;
  }
}

/** Reads the Application URL (Settings > Requests) at most every few seconds. */
export class ApplicationUrlCache {
  private cached: { at: number; host: string | null } | null = null;

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  httpsHost(): string | null {
    const t = this.now();
    if (this.cached && t - this.cached.at < CACHE_MS) return this.cached.host;
    let host: string | null = null;
    try {
      host = httpsApplicationHost(getSection(this.db, 'requests').applicationUrl);
    } catch {
      host = null;
    }
    this.cached = { at: t, host };
    return host;
  }

  /** Whether `req` is for the https Application URL's host. */
  matches(req: FastifyRequest): boolean {
    const host = this.httpsHost();
    return host !== null && normalizeHostname(req.host) === host;
  }
}

export function installSecurityHeaders(app: FastifyInstance, db: Db): void {
  const appUrl = new ApplicationUrlCache(db);
  app.addHook('onSend', async (req, reply, payload) => {
    if (!reply.hasHeader('x-content-type-options')) reply.header('x-content-type-options', 'nosniff');
    if (!reply.hasHeader('referrer-policy')) reply.header('referrer-policy', 'same-origin');
    if (!reply.hasHeader('x-frame-options')) reply.header('x-frame-options', 'SAMEORIGIN');
    if (!reply.hasHeader('content-security-policy')) {
      const type = String(reply.getHeader('content-type') ?? '');
      reply.header('content-security-policy', type.startsWith('text/html') ? PAGE_CSP : DEFAULT_CSP);
    }
    if (req.protocol === 'https' && appUrl.matches(req)) reply.header('strict-transport-security', HSTS_VALUE);
    return payload;
  });
}

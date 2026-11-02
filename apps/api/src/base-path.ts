import type { IncomingMessage } from 'node:http';
import type { FastifyInstance } from 'fastify';

// Sub-path hosting (ARCLIGHT_BASE_PATH): the whole app answers below a prefix such as
// /arclight behind a reverse proxy that forwards the full path. Fastify's rewriteUrl strips
// the prefix before routing, so every route keeps its registered path (/api/v1/..., /api/v3/...,
// /metrics, the SPA fallback) and route-pattern checks such as the auth hook's public routes
// are unaffected. Anything outside the prefix is routed to OUTSIDE_BASE_ROUTE, which answers
// 404 (or redirects the bare root to the app). WebSocket upgrades go through the same router.
// See docs/getting-started/sub-path-hosting.md.

/** Internal route that every request outside the base path is rewritten to. */
export const OUTSIDE_BASE_ROUTE = '/__arclight_outside_base_path__';

const SEGMENT = /^[A-Za-z0-9._~-]+$/;

/**
 * "/arclight", "arclight/", "/apps/arclight" → "/apps/arclight"; "", "/" or undefined → "" (root).
 * Throws on anything that is not a plain path: "..", ".", empty segments in the middle are
 * collapsed, but query strings, encoded characters, spaces and backslashes are rejected.
 */
export function normalizeBasePath(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (value === '' || value === '/') return '';
  if (/[\\?#%\s]/.test(value)) throw new Error(`ARCLIGHT_BASE_PATH "${value}" must be a plain path such as /arclight`);
  const segments = value.split('/').filter((s) => s !== '');
  for (const seg of segments) {
    if (seg === '.' || seg === '..' || !SEGMENT.test(seg)) {
      throw new Error(`ARCLIGHT_BASE_PATH "${value}" must be a plain path such as /arclight (letters, digits, . _ ~ - per segment, no ..)`);
    }
  }
  return segments.length ? `/${segments.join('/')}` : '';
}

/** `url` (path + query) without the base path, or null when it lies outside it. */
export function stripBasePath(base: string, url: string): string | null {
  if (!base) return url;
  if (!url.startsWith(base)) return null;
  const rest = url.slice(base.length);
  // "/arclight" itself is redirected to "/arclight/" (outsideBaseRedirect), so relative URLs
  // and the service worker scope line up; "/arclightfoo" is a different path.
  return rest.startsWith('/') ? rest : null;
}

/** Fastify's rewriteUrl for a base path: strips it, or sends the request to OUTSIDE_BASE_ROUTE. */
export function basePathRewriter(base: string): (req: IncomingMessage) => string {
  return (req) => {
    const url = req.url ?? '/';
    return stripBasePath(base, url) ?? OUTSIDE_BASE_ROUTE;
  };
}

/**
 * Where a request outside the base path goes: the bare root and the base path without its
 * trailing slash (GET/HEAD) redirect to `${base}/`; everything else is a 404 (null).
 */
export function outsideBaseRedirect(base: string, method: string, originalUrl: string): string | null {
  if (method !== 'GET' && method !== 'HEAD') return null;
  const q = originalUrl.indexOf('?');
  const pathname = q >= 0 ? originalUrl.slice(0, q) : originalUrl;
  const search = q >= 0 ? originalUrl.slice(q) : '';
  return pathname === '/' || pathname === '' || pathname === base ? `${base}/${search}` : null;
}

/** A server-issued Location for an app path ("/" → "/arclight/"); absolute URLs pass through. */
export function withBasePath(base: string, location: string): string {
  if (!base || !location.startsWith('/') || location.startsWith('//')) return location;
  return `${base}${location}`;
}

/** The route behind OUTSIDE_BASE_ROUTE: redirects the bare root into the app, 404 otherwise. */
export function installBasePath(app: FastifyInstance, base: string): void {
  app.route({
    method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    url: OUTSIDE_BASE_ROUTE,
    handler: async (req, reply) => {
      const location = outsideBaseRedirect(base, req.method, req.originalUrl);
      if (location) return reply.redirect(location, 302);
      return reply.code(404).send({ error: 'not found', message: `Arclight is served under ${base}/` });
    },
  });
}

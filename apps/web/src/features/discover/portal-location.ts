import type { LocationRewrite } from '@tanstack/react-router';
import { PORTAL_ROUTE_SEGMENTS, PortalDocument } from '@arclight/shared';

// The request portal lives at /portal/... in the route tree. The server answers it on more
// addresses (Settings > Requests > Public request portal): extra paths such as /watch on any
// hostname, and the root of portal hostnames. It tells the page which one it is through
// <meta name="arclight-portal"> (apps/api/src/modules/requests/portal-routing.ts); the router
// then maps the address bar onto /portal (input) and its links back (output), so deep links
// and refreshes stay on the address the visitor used.

export const PORTAL_ROOT = '/portal';

/** The portal mapping the server wrote into this page, or null (plain app page). */
export function readPortalDocument(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): PortalDocument | null {
  const content = doc?.querySelector('meta[name="arclight-portal"]')?.getAttribute('content');
  if (!content) return null;
  try {
    const parsed = PortalDocument.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const under = (pathname: string, base: string) => {
  const p = pathname.toLowerCase();
  return p === base || p.startsWith(`${base}/`);
};

/** Whether an address on a portal hostname is a portal page (root or a portal route). */
export function isPortalHostAddress(pathname: string): boolean {
  const seg = (pathname.split('/')[1] ?? '').toLowerCase();
  return seg === '' || PORTAL_ROUTE_SEGMENTS.includes(seg);
}

/** Address bar → route path. */
export function portalInput(portal: PortalDocument, pathname: string): string {
  if (portal.mode === 'path') {
    if (portal.base === PORTAL_ROOT || !under(pathname, portal.base)) return pathname;
    return `${PORTAL_ROOT}${pathname.slice(portal.base.length)}`;
  }
  if (under(pathname, PORTAL_ROOT) || !isPortalHostAddress(pathname)) return pathname;
  return pathname === '/' ? PORTAL_ROOT : `${PORTAL_ROOT}${pathname}`;
}

/** Route path → address bar. */
export function portalOutput(portal: PortalDocument, pathname: string): string {
  if (!under(pathname, PORTAL_ROOT)) return pathname;
  const rest = pathname.slice(PORTAL_ROOT.length);
  if (portal.mode === 'path') return `${portal.base}${rest}`;
  return rest === '' ? '/' : rest;
}

/** The router rewrite for this page; undefined when the address bar already matches the routes. */
export function portalRewrite(portal: PortalDocument | null): LocationRewrite | undefined {
  if (!portal || (portal.mode === 'path' && portal.base === PORTAL_ROOT)) return undefined;
  return {
    input: ({ url }) => {
      const next = portalInput(portal, url.pathname);
      if (next === url.pathname) return undefined;
      url.pathname = next;
      return url;
    },
    output: ({ url }) => {
      const next = portalOutput(portal, url.pathname);
      if (next === url.pathname) return undefined;
      url.pathname = next;
      return url;
    },
  };
}

/** On a portal-only hostname, where a route path must go instead (null: it may stay). */
export function portalOnlyRedirect(portal: PortalDocument | null | undefined, pathname: string): string | null {
  if (!portal || portal.mode !== 'host' || !portal.portalOnly) return null;
  if (under(pathname, PORTAL_ROOT) || pathname === '/login' || pathname === '/setup') return null;
  return PORTAL_ROOT;
}

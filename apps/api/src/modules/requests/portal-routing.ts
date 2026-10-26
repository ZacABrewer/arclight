import {
  DEFAULT_PORTAL_PATH,
  PORTAL_ROUTE_SEGMENTS,
  type PortalDocument,
  type PublicPortalSettings,
} from '@arclight/shared';

// Where the public request portal answers: below /portal and the extra portal paths on any
// hostname, and at the root of each portal hostname. The server uses this for page loads
// (the SPA fallback): it tells the web app how to map the address bar onto its routes
// (PortalDocument, written into index.html) and keeps portal-only hostnames out of the admin
// pages. The api routes are unaffected: they check permissions on every call regardless of
// the hostname, so portal-only mode hides the admin UI but is not an access control.

/** Pages a portal-only hostname still serves outside the portal: signing in and first-run setup. */
const PORTAL_HOST_EXTRAS: ReadonlySet<string> = new Set(['login', 'setup']);

export type SpaDecision = { kind: 'serve'; portal: PortalDocument | null } | { kind: 'redirect'; location: string };

/** "Requests.Example.com:443" → "requests.example.com". IPv6 literals keep their brackets. */
export function normalizeHostname(host: string | undefined): string {
  const h = (host ?? '').trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.replace(/:\d+$/, '').replace(/\.$/, '');
}

function firstSegment(pathname: string): string {
  return (pathname.split('/')[1] ?? '').toLowerCase();
}

/** Whether `pathname` is a portal page on a portal hostname (its root or one of the portal routes). */
export function isPortalHostPath(pathname: string): boolean {
  const seg = firstSegment(pathname);
  return seg === '' || seg === DEFAULT_PORTAL_PATH.slice(1) || PORTAL_ROUTE_SEGMENTS.includes(seg);
}

/** The portal base path `pathname` is under (e.g. "/watch"), or null. */
export function portalBaseOf(settings: PublicPortalSettings, pathname: string): string | null {
  const seg = firstSegment(pathname);
  if (!seg) return null;
  const base = `/${seg}`;
  if (base === DEFAULT_PORTAL_PATH || settings.paths.includes(base)) return base;
  return null;
}

/** What a page load of `pathname` on `hostname` gets: the app (with its portal mapping) or a redirect. */
export function spaDecision(settings: PublicPortalSettings, hostname: string | undefined, pathname: string): SpaDecision {
  if (!settings.enabled) return { kind: 'serve', portal: null };
  const host = normalizeHostname(hostname);
  const portalHost = host ? settings.hosts.find((h) => h.hostname === host) : undefined;
  if (portalHost) {
    if (portalHost.portalOnly && !isPortalHostPath(pathname) && !PORTAL_HOST_EXTRAS.has(firstSegment(pathname))) {
      return { kind: 'redirect', location: '/' };
    }
    return { kind: 'serve', portal: { mode: 'host', portalOnly: portalHost.portalOnly } };
  }
  const base = portalBaseOf(settings, pathname);
  return { kind: 'serve', portal: base ? { mode: 'path', base } : null };
}

const META_NAME = 'arclight-portal';

/** index.html with the portal mapping as a meta tag (no inline script, so a strict CSP still holds). */
export function injectPortalDocument(html: string, portal: PortalDocument | null): string {
  if (!portal) return html;
  const content = JSON.stringify(portal).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const tag = `<meta name="${META_NAME}" content="${content}" />`;
  return html.includes('</head>') ? html.replace('</head>', `    ${tag}\n  </head>`) : `${tag}${html}`;
}

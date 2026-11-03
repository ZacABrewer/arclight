import type { PortalDocument } from '@arclight/shared';
import { basePath } from '../../lib/base-path.js';
import { PORTAL_ROOT, portalOutput } from './portal-location.js';

// Where a plain "Request portal" link goes (the player's account menu, the player-off page):
// the portal's public address (GET /playback/me `portalUrl`, Settings > Requests > Public
// portal). On this page's own origin it stays a path, so the browser keeps its sign-in; on
// another hostname it is the full address. Without one, the built-in /portal, mapped like the
// router maps it when this page is itself a portal page.

/**
 * `portalUrl`: the configured address or null. `currentOrigin`: this page's origin
 * ("https://example.com"). `portal`: the page's portal mapping; `base`: ARCLIGHT_BASE_PATH.
 */
export function portalHref(portalUrl: string | null | undefined, currentOrigin: string, portal: PortalDocument | null = null, base: string = basePath()): string {
  if (portalUrl) {
    try {
      const url = new URL(portalUrl);
      if (url.origin !== currentOrigin) return url.href.replace(/\/+$/, '') || url.href;
      return `${url.pathname.replace(/\/+$/, '')}${url.search}` || '/';
    } catch {
      // not a URL: fall through to the built-in address
    }
  }
  const path = portal ? portalOutput(portal, PORTAL_ROOT) : PORTAL_ROOT;
  return `${base}${path}` || '/';
}

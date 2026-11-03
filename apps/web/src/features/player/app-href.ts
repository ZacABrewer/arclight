import type { PlayerDocument } from '@arclight/shared';
import { basePath } from '../../lib/base-path.js';

// Where "Open Arclight" (the player's account menu, the player-off page) goes. On a player
// hostname the root is the player's, so the link uses the address the server names for the
// rest of Arclight (GET /playback/me `appUrl`: the Application URL), and is hidden without one
// rather than opening the player again. Elsewhere it is a path on this page's address, unless
// the server names another origin (the "player is off" page on a player hostname). The server
// answers `appUrl: null` only on a player hostname without such an address: the link is hidden
// there too, because the hostname's root only redirects back to the player.

/**
 * `appHome`: appHomeFor(access), null for no app pages. `player`: this page's player mapping.
 * `appUrl`: /playback/me `appUrl`. `currentOrigin`: this page's origin.
 */
export function appHref(appHome: string | null, player: PlayerDocument | null, appUrl: string | null | undefined, currentOrigin: string, base: string = basePath()): string | null {
  if (appHome === null) return null;
  if (player?.mode !== 'host') {
    if (appUrl === null) return null;
    return foreignApp(appUrl, currentOrigin, appHome) ?? `${base}${appHome}`;
  }
  if (!appUrl) return null;
  try {
    const url = new URL(appUrl);
    // The same origin is this player hostname: the link would only open the player.
    if (url.origin === currentOrigin) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}${appHome}`;
  } catch {
    return null;
  }
}

// A page without the player mapping (the "player is off" page) can still sit on a player
// hostname, where the root only redirects back to it. The server names another origin then.
function foreignApp(appUrl: string | null | undefined, currentOrigin: string, appHome: string): string | null {
  if (!appUrl) return null;
  try {
    const url = new URL(appUrl);
    if (url.origin === currentOrigin) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}${appHome}`;
  } catch {
    return null;
  }
}

/**
 * The button of the "player is off" page: Back to Arclight (`app`), else Back to the portal.
 * `appUrl`: /playback/me `appUrl`; null means this is a player hostname with no other address
 * for Arclight, where a portal path on this origin would only redirect back here as well, so
 * only a portal on another origin is linked. Null: no button, only the message.
 */
export function playerOffLink(app: string | null, portal: string, appUrl: string | null | undefined, currentOrigin: string): { href: string; kind: 'app' | 'portal' } | null {
  if (app !== null) return { href: app, kind: 'app' };
  if (appUrl !== null) return { href: portal, kind: 'portal' };
  try {
    const url = new URL(portal, currentOrigin);
    return url.origin === currentOrigin ? null : { href: portal, kind: 'portal' };
  } catch {
    return null;
  }
}

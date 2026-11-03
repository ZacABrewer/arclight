import type { PlayerDocument } from '@arclight/shared';
import { basePath } from '../../lib/base-path.js';

// Where "Open Arclight" (the player's account menu, the player-off page) goes. On a player
// hostname the root is the player's, so the link uses the address the server names for the
// rest of Arclight (GET /playback/me `appUrl`: the Application URL), and is hidden without one
// rather than opening the player again. Elsewhere it is a path on this page's address.

/**
 * `appHome`: appHomeFor(access), null for no app pages. `player`: this page's player mapping.
 * `appUrl`: /playback/me `appUrl`. `currentOrigin`: this page's origin.
 */
export function appHref(appHome: string | null, player: PlayerDocument | null, appUrl: string | null | undefined, currentOrigin: string, base: string = basePath()): string | null {
  if (appHome === null) return null;
  if (player?.mode !== 'host') return `${base}${appHome}`;
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

import type { LocationRewrite } from '@tanstack/react-router';
import { DEFAULT_PLAYER_PATH, PLAYER_ROUTE_SEGMENTS, PlayerDocument } from '@arclight/shared';

// The player lives at /player/... in the route tree. The server answers it on more addresses
// (Settings > Player > Player address): extra paths such as /watch on any hostname, and the
// root of player hostnames. It says which one through <meta name="arclight-player">
// (apps/api/src/address-routing.ts); the router then maps the address bar onto /player (input)
// and its links back (output), like the request portal (features/discover/portal-location.ts).

export const PLAYER_ROOT = DEFAULT_PLAYER_PATH;

/** The player mapping the server wrote into this page, or null (plain app page). */
export function readPlayerDocument(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): PlayerDocument | null {
  const content = doc?.querySelector('meta[name="arclight-player"]')?.getAttribute('content');
  if (!content) return null;
  try {
    const parsed = PlayerDocument.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const under = (pathname: string, base: string) => {
  const p = pathname.toLowerCase();
  return p === base || p.startsWith(`${base}/`);
};

/** Whether an address on a player hostname is a player page (root or a player route). */
export function isPlayerHostAddress(pathname: string): boolean {
  const seg = (pathname.split('/')[1] ?? '').toLowerCase();
  return seg === '' || PLAYER_ROUTE_SEGMENTS.includes(seg);
}

/** Address bar → route path. */
export function playerInput(player: PlayerDocument, pathname: string): string {
  if (player.mode === 'path') {
    if (player.base === PLAYER_ROOT || !under(pathname, player.base)) return pathname;
    return `${PLAYER_ROOT}${pathname.slice(player.base.length)}`;
  }
  if (under(pathname, PLAYER_ROOT) || !isPlayerHostAddress(pathname)) return pathname;
  return pathname === '/' ? PLAYER_ROOT : `${PLAYER_ROOT}${pathname}`;
}

/** Route path → address bar. */
export function playerOutput(player: PlayerDocument, pathname: string): string {
  if (!under(pathname, PLAYER_ROOT)) return pathname;
  const rest = pathname.slice(PLAYER_ROOT.length);
  if (player.mode === 'path') return `${player.base}${rest}`;
  return rest === '' ? '/' : rest;
}

/** The router rewrite for this page; undefined when the address bar already matches the routes. */
export function playerRewrite(player: PlayerDocument | null | undefined): LocationRewrite | undefined {
  if (!player || (player.mode === 'path' && player.base === PLAYER_ROOT)) return undefined;
  return {
    input: ({ url }) => {
      const next = playerInput(player, url.pathname);
      if (next === url.pathname) return undefined;
      url.pathname = next;
      return url;
    },
    output: ({ url }) => {
      const next = playerOutput(player, url.pathname);
      if (next === url.pathname) return undefined;
      url.pathname = next;
      return url;
    },
  };
}

/** On a player-only hostname, where a route path must go instead (null: it may stay). */
export function playerOnlyRedirect(player: PlayerDocument | null | undefined, pathname: string): string | null {
  if (!player || player.mode !== 'host' || !player.playerOnly) return null;
  if (under(pathname, PLAYER_ROOT) || pathname === '/login' || pathname === '/setup') return null;
  return PLAYER_ROOT;
}

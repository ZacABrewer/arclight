import { DEFAULT_PLAYER_PATH, PLAYER_ROUTE_SEGMENTS, type PublicPlayerAddress } from '@arclight/shared';

// Where the player answers besides /player (Settings > Player > Player address): extra paths
// such as /watch on any hostname, and the root of player hostnames. The twin of
// requests/portal-routing.ts; address-routing.ts combines the two for page loads. Like the
// portal, player-only mode keeps the admin pages off a hostname but is not an access control:
// every api route still checks the caller.

/** Pages a player-only hostname still serves outside the player: signing in and first-run setup. */
export const PLAYER_HOST_EXTRAS: ReadonlySet<string> = new Set(['login', 'setup']);

function firstSegment(pathname: string): string {
  return (pathname.split('/')[1] ?? '').toLowerCase();
}

/** Whether `pathname` is a player page on a player hostname (its root, /player or one of the player routes). */
export function isPlayerHostPath(pathname: string): boolean {
  const seg = firstSegment(pathname);
  return seg === '' || seg === DEFAULT_PLAYER_PATH.slice(1) || PLAYER_ROUTE_SEGMENTS.includes(seg);
}

/** The extra player path `pathname` is under (e.g. "/watch"), or null (/player itself needs no mapping). */
export function playerBaseOf(address: Pick<PublicPlayerAddress, 'paths'>, pathname: string): string | null {
  const seg = firstSegment(pathname);
  if (!seg) return null;
  const base = `/${seg}`;
  return address.paths.includes(base) ? base : null;
}

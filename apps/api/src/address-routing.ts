import type { PlayerDocument, PortalDocument, PublicPlayerAddress, PublicPortalSettings } from '@arclight/shared';
import { isPlayerHostPath, PLAYER_HOST_EXTRAS, playerBaseOf } from './modules/playback/player-routing.js';
import { normalizeHostname, portalBaseOf, spaDecision } from './modules/requests/portal-routing.js';

// What a page load gets, given the request portal's and the player's public addresses (the
// SPA fallback in spa.ts). Hostnames come first: a portal hostname is the portal's, a player
// hostname the player's (addressClash keeps the two lists apart). Elsewhere the first path
// segment decides: a portal path, a player path, or a plain app page. The page learns both
// mappings through meta tags and the web router rewrites the address bar onto /portal and
// /player (apps/web/src/features/discover/portal-location.ts, features/player/player-location.ts).

export type SpaRoute =
  | { kind: 'serve'; portal: PortalDocument | null; player: PlayerDocument | null }
  | { kind: 'redirect'; location: string };

function firstSegment(pathname: string): string {
  return (pathname.split('/')[1] ?? '').toLowerCase();
}

function playerPathDoc(player: PublicPlayerAddress, pathname: string): PlayerDocument | null {
  const base = playerBaseOf(player, pathname);
  return base ? { mode: 'path', base } : null;
}

export function spaRoute(portal: PublicPortalSettings, player: PublicPlayerAddress, hostname: string | undefined, pathname: string): SpaRoute {
  const host = normalizeHostname(hostname);
  if (portal.enabled && host && portal.hosts.some((h) => h.hostname === host)) {
    const decision = spaDecision(portal, hostname, pathname);
    if (decision.kind === 'redirect') return decision;
    // A portal hostname that also shows the app: player paths still work there.
    const portalOnly = decision.portal?.mode === 'host' && decision.portal.portalOnly;
    return { kind: 'serve', portal: decision.portal, player: portalOnly ? null : playerPathDoc(player, pathname) };
  }
  const playerHost = host ? player.hosts.find((h) => h.hostname === host) : undefined;
  if (playerHost) {
    if (playerHost.playerOnly && !isPlayerHostPath(pathname) && !PLAYER_HOST_EXTRAS.has(firstSegment(pathname))) {
      return { kind: 'redirect', location: '/' };
    }
    // With "Player only" off the rest of the app answers at its own paths, the portal's included.
    const portalBase = !playerHost.playerOnly && portal.enabled ? portalBaseOf(portal, pathname) : null;
    return { kind: 'serve', portal: portalBase ? { mode: 'path', base: portalBase } : null, player: { mode: 'host', playerOnly: playerHost.playerOnly } };
  }
  const decision = spaDecision(portal, hostname, pathname);
  if (decision.kind === 'redirect') return decision;
  return { kind: 'serve', portal: decision.portal, player: decision.portal ? null : playerPathDoc(player, pathname) };
}

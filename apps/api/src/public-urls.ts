import { DEFAULT_PLAYER_PATH, DEFAULT_PORTAL_PATH } from '@arclight/shared';
import type { Db } from './db/index.js';
import { normaliseServerUrl } from './modules/mobile/service.js';
import { getSection } from './modules/settings/service.js';
import { normalizeHostname } from './modules/requests/portal-routing.js';

// The one public address Arclight gives out for the player and for the request portal (TV
// sign-in, the phone sign-in QR, share links, the account menus):
// 1. the first hostname of the list: https://<host> (the Application URL's scheme when one is
//    set; a sub-path install keeps its base path),
// 2. else the Application URL (Settings > Requests) + the first extra path,
// 3. else the Application URL + the built-in path (/player, /portal),
// 4. else null: callers fall back to the address the request came in on.

interface AddressList {
  paths: readonly string[];
  hosts: readonly { hostname: string }[];
}

/** The rules above for one address list; `basePath` is ARCLIGHT_BASE_PATH ("" at the root). */
export function publicUrlOf(applicationUrl: string, address: AddressList, builtInPath: string, basePath = ''): string | null {
  const app = normaliseServerUrl(applicationUrl);
  const host = address.hosts[0]?.hostname;
  if (host) {
    const scheme = app ? new URL(app).protocol : 'https:';
    return `${scheme}//${host}${basePath}`;
  }
  if (!app) return null;
  return `${app}${address.paths[0] ?? builtInPath}`;
}

/** The player's public address. */
export function playerUrlOf(db: Db, basePath = ''): string | null {
  return publicUrlOf(getSection(db, 'requests').applicationUrl, getSection(db, 'player').address, DEFAULT_PLAYER_PATH, basePath);
}

/** The request portal's public address; null while the portal is off. */
export function portalUrlOf(db: Db, basePath = ''): string | null {
  const requests = getSection(db, 'requests');
  if (!requests.publicPortal.enabled) return null;
  return publicUrlOf(requests.applicationUrl, requests.publicPortal, DEFAULT_PORTAL_PATH, basePath);
}

/** The origin of the first player hostname (as playerUrlOf builds it), or null when there is none. */
export function playerOriginOf(db: Db, basePath = ''): string | null {
  const address = getSection(db, 'player').address;
  if (!address.hosts[0]) return null;
  return publicUrlOf(getSection(db, 'requests').applicationUrl, address, DEFAULT_PLAYER_PATH, basePath);
}

/** Whether the owner set any player address (an extra path or a hostname). */
export function hasPlayerAddress(db: Db): boolean {
  const address = getSection(db, 'player').address;
  return address.paths.length > 0 || address.hosts.length > 0;
}

/**
 * Where the rest of Arclight answers for a page on `host` ("Open Arclight"): `requestOrigin`
 * (origin plus base path) unless `host` is a player hostname, whose root is the player's. Then
 * the Application URL, unless that is a player hostname too; else null. A player hostname stays
 * one while the player is off: its root then redirects to the "player is off" page.
 */
export function appUrlOf(db: Db, host: string, requestOrigin: string): string | null {
  const player = getSection(db, 'player');
  const isPlayerHost = (h: string) => player.address.hosts.some((p) => p.hostname === h);
  if (!isPlayerHost(normalizeHostname(host))) return requestOrigin;
  const app = normaliseServerUrl(getSection(db, 'requests').applicationUrl);
  if (!app || isPlayerHost(normalizeHostname(new URL(app).host))) return null;
  return app;
}

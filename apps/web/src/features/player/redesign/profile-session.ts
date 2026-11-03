import type { Session } from '@arclight/shared';

// Who's watching on the web (redesign spec §4.6, §9 Q1). The picker shows on entering /player
// when the account has two or more profiles and none was picked in this tab yet. Choosing a
// non-owner profile switches the whole browser session: while it is active, every page outside
// /player (admin and request portal) redirects to /player. The api enforces the same rule.

export const PROFILE_PICKED_KEY = 'arclight.profilePicked';

export function wasProfilePicked(): boolean {
  try {
    return sessionStorage.getItem(PROFILE_PICKED_KEY) === '1';
  } catch {
    return false;
  }
}

export function markProfilePicked(): void {
  try {
    sessionStorage.setItem(PROFILE_PICKED_KEY, '1');
  } catch {
    // Blocked storage: the picker shows again next time, which is safe.
  }
}

/** Pages a non-owner profile may still open outside /player. */
const ALWAYS_OPEN = ['/login', '/setup'];

/**
 * Where a navigation must go while a non-owner profile is active: /player for any page outside
 * it (the admin app, settings, the request portal); null when it may stay.
 */
export function profileRedirect(session: Pick<Session, 'activeProfile'> | null | undefined, pathname: string): string | null {
  const active = session?.activeProfile;
  if (!active || active.isOwner) return null;
  if (pathname === '/player' || pathname.startsWith('/player/')) return null;
  if (ALWAYS_OPEN.includes(pathname)) return null;
  return '/player';
}

/** Search params of /player/profiles: `select` opens that profile's PIN, `manage=1` Manage profiles. */
export interface ProfilesSearch {
  select?: number | undefined;
  manage?: 1 | undefined;
}

export function parseProfilesSearch(raw: Record<string, unknown>): ProfilesSearch {
  const select = Number(raw.select);
  return {
    select: Number.isInteger(select) && select > 0 ? select : undefined,
    manage: raw.manage === 1 || raw.manage === '1' ? 1 : undefined,
  };
}

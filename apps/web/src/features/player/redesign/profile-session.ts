import { HOUSEHOLD_PROFILE_COLORS, type Session } from '@arclight/shared';

// Who's watching on the web (redesign spec §4.6, §9 Q1). The picker shows on entering /player
// when the account has two or more profiles and none was picked in this tab yet. Choosing a
// non-owner profile switches the whole browser session: while it is active, every page outside
// /player (admin and request portal) redirects to /player. The api enforces the same rule.

/** The web's own key: the player app keeps a per-account list under a different one (households/state.ts). */
export const PROFILE_PICKED_KEY = 'arclight.web.profilePicked';

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

/** Forgets the pick (sign-out): the next person in this tab sees the picker. */
export function clearProfilePicked(): void {
  try {
    sessionStorage.removeItem(PROFILE_PICKED_KEY);
  } catch {
    // Blocked storage: nothing was stored.
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

/**
 * Search params of /player/profiles: `select` opens that profile's PIN, `manage=1` Manage profiles,
 * `add=1` (with manage) the editor for a new profile.
 */
export interface ProfilesSearch {
  select?: number | undefined;
  manage?: 1 | undefined;
  add?: 1 | undefined;
}

const flag = (v: unknown): 1 | undefined => (v === 1 || v === '1' ? 1 : undefined);

export function parseProfilesSearch(raw: Record<string, unknown>): ProfilesSearch {
  const select = Number(raw.select);
  return {
    select: Number.isInteger(select) && select > 0 ? select : undefined,
    manage: flag(raw.manage),
    add: flag(raw.add),
  };
}

/** Where "Add profile" goes (account menu, Settings): Manage profiles with the new-profile editor open. */
export const ADD_PROFILE_SEARCH = { manage: 1, add: 1 } as const satisfies ProfilesSearch;

/** The owner profile may add one while the account is below the server's maximum. */
export function canAddProfile(view: { canManage: boolean; count: number; max: number }): boolean {
  return view.canManage && view.count < view.max;
}

/** A new profile's colour: the first of the editor's colours no profile has yet (the first when all are taken). */
export function firstFreeColor(profiles: readonly { color: string }[]): string {
  const used = new Set(profiles.map((p) => p.color.toLowerCase()));
  return HOUSEHOLD_PROFILE_COLORS.find((c) => !used.has(c.toLowerCase())) ?? HOUSEHOLD_PROFILE_COLORS[0];
}

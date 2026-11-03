import type { HouseholdProfilesResponse } from '@arclight/shared';

// "Who's watching?" once per app run (spec §9 Q5/Q9): the picker shows on a cold launch when the
// account has two or more profiles, and not again until the app is started anew. The flag
// lives in sessionStorage (a WebView's session ends with the process), per account.

const KEY = 'arclight.profilePicked';

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function read(s: Storage | null): string[] {
  try {
    const v = JSON.parse(s?.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function isPicked(accountId: string, s: Storage | null = storage()): boolean {
  return read(s).includes(accountId);
}

export function markPicked(accountId: string, s: Storage | null = storage()): void {
  const list = read(s);
  if (list.includes(accountId)) return;
  try {
    s?.setItem(KEY, JSON.stringify([...list, accountId]));
  } catch {
    // Blocked storage: the picker may show again, which is safe.
  }
}

/** Does this account need the picker now? */
export function needsPicker(res: Pick<HouseholdProfilesResponse, 'profiles'> | null, accountId: string, s: Storage | null = storage()): boolean {
  if (!res || res.profiles.length < 2) return false;
  return !isPicked(accountId, s);
}

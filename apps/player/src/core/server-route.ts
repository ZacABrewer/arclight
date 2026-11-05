import { User } from '@arclight/shared';
import { ROUTE_TIMEOUT_MS } from '../config';
import type { Account } from './accounts';
import { request } from './api';

// An account with two addresses for its server (home network and internet): each time the app
// opens, the first one is tried and the other is used when it does not answer. An address counts
// only when the account's own token is accepted there for the same user, so another Arclight
// server at the same home-network address (a friend's house) is skipped, never signed out of.

/** Does `url` answer as the account's server for this user? Never throws. */
export type AddressCheck = (url: string, timeoutMs: number) => Promise<boolean>;

/**
 * The first of `addresses`, in order, that passes `check`; null when none does. All are checked at
 * once, so a dead first address costs at most `timeoutMs` before the second is used.
 */
export async function pickAddress(addresses: readonly string[], check: AddressCheck, timeoutMs = ROUTE_TIMEOUT_MS): Promise<string | null> {
  const results = addresses.map((url) => check(url, timeoutMs).catch(() => false));
  for (let i = 0; i < addresses.length; i++) {
    if (await results[i]) return addresses[i]!;
  }
  return null;
}

/** The address the account should use now, or null to keep the one it has. */
export async function routeAccount(account: Account, check: AddressCheck, timeoutMs = ROUTE_TIMEOUT_MS): Promise<string | null> {
  if (!account.addresses || account.addresses.length < 2) return null;
  const url = await pickAddress(account.addresses, check, timeoutMs);
  return url && url !== account.serverUrl ? url : null;
}

/** The account's own token, accepted for the same user: `url` reaches this account's server. */
export function reachesAccount(account: Pick<Account, 'userId'>, token: string): AddressCheck {
  return async (url, timeoutMs) => {
    try {
      const me = await request('/user/me', User, { target: { serverUrl: url, token }, timeoutMs });
      return me.id === account.userId;
    } catch {
      return false;
    }
  };
}

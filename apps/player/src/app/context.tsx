import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { Account } from '../core/accounts';
import { netState, onNetChange, type NetState } from '../core/network';
import { getSession, onSessionChange, type Session } from '../core/session';
import type { AppSettings } from '../core/settings';
import type { DownloadEntry } from '../offline/download-index';
import type { AppServices } from './services';

export const AppServicesContext = createContext<AppServices | null>(null);

export function useServices(): AppServices {
  const s = useContext(AppServicesContext);
  if (!s) throw new Error('AppServicesContext missing');
  return s;
}

export function useNet(): NetState {
  return useSyncExternalStore(onNetChange, netState, netState);
}

export function useSession(): Session | null {
  return useSyncExternalStore(onSessionChange, getSession, getSession);
}

export function useAccounts(): { accounts: Account[]; active: Account | null } {
  const { accounts } = useServices();
  const [state, setState] = useState(() => ({ accounts: accounts.list(), active: accounts.active() }));
  useEffect(() => accounts.subscribe(setState), [accounts]);
  return state;
}

export function useAppSettings(): [AppSettings, (patch: Partial<AppSettings>) => Promise<void>] {
  const { settings } = useServices();
  const value = useSyncExternalStore(
    (cb) => settings.subscribe(cb),
    () => settings.get(),
    () => settings.get(),
  );
  return [value, async (patch) => void (await settings.update(patch))];
}

/** Downloads of the active account, re-rendering on every index change. */
export function useDownloads(): DownloadEntry[] {
  const { index } = useServices();
  const session = useSession();
  const [, bump] = useState(0);
  useEffect(() => index.subscribe(() => bump((n) => n + 1)), [index]);
  return session ? index.all(session.accountId) : [];
}

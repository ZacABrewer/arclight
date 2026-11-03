import { useMemo, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { authApi } from '@web/api/auth';
import { accessOf } from '@web/auth/access';
import { AuthStateProvider, type AuthState } from '@web/auth/auth-context';
import { authKeys } from '@web/auth/guard';
import { useAccounts, useServices, useSession } from '../app/context';
import { signOut } from '../core/sign-in';

// The redesign pages the phone shares with the web /player (profiles picker, settings) read who is
// signed in, and the active profile, from the web's auth state. The app signs in with its device
// token instead of a session cookie, so it fills that state from GET /auth/me itself. A profile
// switch re-reads /auth/me (the web pages invalidate the "auth" queries), so the pages follow it.

export function AppAuthBridge({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const services = useServices();
  const session = useSession();
  const { accounts, active } = useAccounts();
  const me = useQuery({ queryKey: authKeys.me, queryFn: authApi.me, enabled: Boolean(session), retry: false, staleTime: 30_000, meta: { silent: true } });
  const data = session ? (me.data ?? null) : null;

  const value = useMemo<AuthState>(
    () => ({
      status: null,
      session: data,
      user: data?.user ?? null,
      isAdmin: data?.isAdmin ?? false,
      access: accessOf(data),
      refresh: async () => {
        await qc.invalidateQueries({ queryKey: authKeys.all });
      },
      logout: async () => {
        if (!active) return;
        await signOut(services.accounts, active.id);
        if (accounts.length > 1) await services.switchAccount(null);
      },
    }),
    [data, qc, services, active, accounts.length],
  );
  return <AuthStateProvider value={value}>{children}</AuthStateProvider>;
}

import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuthStatus, Session, User } from '@arclight/shared';
import { authApi } from '../api/auth.js';
import { authKeys, authStatusQuery } from './guard.js';
import { readUiPreferences, setActiveUiPreferences } from '../lib/ui-preferences.js';

export interface AuthState {
  /** null until loaded, or when the api does not serve /auth/status. */
  status: AuthStatus | null;
  session: Session | null;
  user: User | null;
  /**
   * Admin unless the api says otherwise. When auth status is unavailable the UI shows
   * everything; the api still refuses what the caller may not do.
   */
  isAdmin: boolean;
  /** Re-reads /auth/status and /auth/me (after login, setup, profile edits). */
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/** Fetches /auth/status and, when signed in, /auth/me; shares them with the tree. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const status = useQuery(authStatusQuery);
  const authenticated = status.data?.authenticated ?? false;
  const me = useQuery({ queryKey: authKeys.me, queryFn: authApi.me, enabled: authenticated, retry: false, staleTime: 30_000 });

  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: authKeys.all });
  }, [qc]);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      qc.removeQueries({ queryKey: authKeys.all });
      // Everything cached belonged to the signed-in user.
      qc.clear();
    }
  }, [qc]);

  const value = useMemo<AuthState>(() => {
    const session = (authenticated ? me.data : null) ?? status.data?.session ?? null;
    // Plain formatters (tables, dates) read the signed-in user's UI preferences from here.
    setActiveUiPreferences(readUiPreferences(session?.user?.settings));
    return {
      status: status.data ?? null,
      session,
      user: session?.user ?? null,
      isAdmin: session ? session.isAdmin : true,
      refresh,
      logout,
    };
  }, [authenticated, me.data, status.data, refresh, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

const FALLBACK: AuthState = {
  status: null,
  session: null,
  user: null,
  isAdmin: true,
  refresh: async () => {},
  logout: async () => {},
};

/** Auth state from the nearest AuthProvider (a permissive fallback outside one). */
export function useAuth(): AuthState {
  return useContext(AuthContext) ?? FALLBACK;
}

/** Name to show for a user. */
export function displayNameOf(user: User | null, session: Session | null): string {
  if (user) return user.displayName ?? user.username;
  if (session?.via === 'apikey') return 'API key';
  if (session?.via === 'bypass') return 'Local access';
  return 'Guest';
}

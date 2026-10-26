import { useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AuthStatus, Session, User } from '@arclight/shared';
import { usersApi } from '../api/auth.js';
import { useAuth } from '../auth/auth-context.js';
import { authKeys } from '../auth/guard.js';
import { readUiPreferences, setActiveUiPreferences, type UiPreferences } from '../lib/ui-preferences.js';
import { t, chooseLocale } from '../i18n/index.js';

/** The signed-in user's UI preferences, with defaults for anything unset. */
export function useUiPreferences(): UiPreferences {
  const { user } = useAuth();
  const settings = user?.settings;
  return useMemo(() => readUiPreferences(settings), [settings]);
}

/** Writes the cached session's user so the shell and pages pick up the new settings at once. */
export function writeCachedUser(qc: ReturnType<typeof useQueryClient>, user: User): void {
  qc.setQueryData<Session>(authKeys.me, (s) => (s ? { ...s, user } : s));
  qc.setQueryData<AuthStatus>(authKeys.status, (st) => (st?.session ? { ...st, session: { ...st.session, user } } : st));
}

/** PUT /user/me { settings }: the server shallow-merges the keys into the stored settings. */
export function useSaveUiPreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (prefs: Partial<UiPreferences>) => usersApi.updateMe({ settings: { ...prefs } }),
    meta: { errorTitle: t('hooks.uiPreferences.couldNotSaveUiPreferences') },
    onSuccess: (user) => {
      const prefs = readUiPreferences(user.settings);
      setActiveUiPreferences(prefs);
      // Remember the language on this device too, so the sign-in page uses it next time.
      void chooseLocale(prefs.locale);
      writeCachedUser(qc, user);
    },
  });
}

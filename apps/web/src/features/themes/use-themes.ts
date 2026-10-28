import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { applyTheme, getActiveTheme } from '../../arclight/index.js';
import type { ThemeSettings } from '@arclight/shared';
import { themesApi } from '../../api/themes.js';
import { useInvalidatingMutation } from '../../hooks/settings-keys.js';
import { t } from '../../i18n/index.js';
import { activeThemeOf, resolveTheme } from './resolve.js';

export const themeKeys = {
  all: ['theme'] as const,
  catalog: ['theme', 'catalog'] as const,
  status: ['theme', 'status'] as const,
  settings: ['theme', 'settings'] as const,
};

/** GET /theme (public). */
export function useThemeCatalog() {
  return useQuery({ queryKey: themeKeys.catalog, queryFn: themesApi.catalog, staleTime: 5 * 60_000, retry: 1 });
}

/**
 * Keeps the page on the right theme: the signed-in user's pick (null when signed out), the server
 * default, or the device's last theme on the sign-in page. Until the catalogue loads, the theme
 * restored from this device stays.
 */
export function useThemeController(userTheme: string | null, isAdmin: boolean): void {
  const catalog = useThemeCatalog();
  const data = catalog.data;
  const info = data ? resolveTheme(data, { userTheme, isAdmin, deviceTheme: getActiveTheme().id }) : null;
  const key = info ? `${info.id}@${info.version}` : null;
  useEffect(() => {
    if (info) applyTheme(activeThemeOf(info));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run only when the resolved theme or its version changes
  }, [key]);
}

/** GET /theme/status (admins): settings, the last sync and every installed theme. */
export function useThemeStatus() {
  return useQuery({ queryKey: themeKeys.status, queryFn: themesApi.status, retry: false });
}

export function useSaveThemeSettings() {
  return useInvalidatingMutation((body: ThemeSettings) => themesApi.settings.save(body), [themeKeys.all], {
    errorTitle: t('features.themes.couldNotSaveSettings'),
  });
}

export function useSyncThemes() {
  return useInvalidatingMutation(() => themesApi.sync(), [themeKeys.all], { errorTitle: t('features.themes.couldNotSync') });
}

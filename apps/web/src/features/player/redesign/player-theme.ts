import { useEffect, useRef } from 'react';
import { BASE_THEME_ID, type ThemeCatalog } from '@arclight/shared';
import { applyTheme, getActiveTheme, useActiveTheme } from '../../../arclight/index.js';
import { useThemeCatalog } from '../../themes/use-themes.js';
import { activeThemeOf, resolveTheme } from '../../themes/resolve.js';

// The player draws in the profile's theme (redesign spec §4.1, §9 Q7): ProfileSettings.theme,
// null meaning `cinema`. The admin portal keeps the account theme, so leaving /player puts the
// account's theme back.

export const PLAYER_DEFAULT_THEME = 'cinema';

/** The theme id the player shows for a profile pick: the pick, else cinema, else the base look. */
export function playerThemeId(catalog: ThemeCatalog, pick: string | null): string {
  const has = (id: string) => catalog.themes.some((t) => t.id === id);
  if (pick && pick !== 'default' && has(pick)) return pick;
  if (pick === 'default' && has(catalog.defaultTheme)) return catalog.defaultTheme;
  if (has(PLAYER_DEFAULT_THEME)) return PLAYER_DEFAULT_THEME;
  return has(BASE_THEME_ID) ? BASE_THEME_ID : (catalog.themes[0]?.id ?? BASE_THEME_ID);
}

/**
 * While mounted, the page uses the profile's player theme; on unmount, the account theme
 * (`accountTheme` as stored in the user's UI preferences) comes back.
 */
export function usePlayerTheme(profileTheme: string | null, accountTheme: string | null, isAdmin: boolean): void {
  const catalog = useThemeCatalog().data;
  const id = catalog ? playerThemeId(catalog, profileTheme) : null;
  const info = catalog && id ? catalog.themes.find((t) => t.id === id) : undefined;
  const key = info ? `${info.id}@${info.version}` : null;
  // The account theme controller (AuthProvider) applies its theme after this one in the same
  // commit (parent effects run last), and a later applyTheme cancels a stylesheet still loading.
  // So apply on the next task, after every effect of the commit, and again whenever the page
  // drifts off the player theme. Three failed tries in a row (a stylesheet that keeps failing)
  // leave the base look; landing on the player theme resets the count.
  const activeId = useActiveTheme().id;
  const tries = useRef(new Map<string, number>());
  useEffect(() => {
    if (!info || !key) return;
    if (activeId === info.id) {
      tries.current.delete(key);
      return;
    }
    const timer = setTimeout(() => {
      if (getActiveTheme().id === info.id) return;
      const n = tries.current.get(key) ?? 0;
      if (n >= 3) return;
      tries.current.set(key, n + 1);
      applyTheme(activeThemeOf(info));
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the resolved theme and the active one
  }, [key, activeId]);
  const account = useRef({ catalog, accountTheme, isAdmin });
  account.current = { catalog, accountTheme, isAdmin };
  useEffect(
    () => () => {
      const a = account.current;
      if (a.catalog) applyTheme(activeThemeOf(resolveTheme(a.catalog, { userTheme: a.accountTheme, isAdmin: a.isAdmin, deviceTheme: null })));
    },
    [],
  );
}

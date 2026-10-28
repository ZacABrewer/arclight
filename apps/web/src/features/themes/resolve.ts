import { BASE_THEME_ID, type ThemeCatalog, type ThemeInfo } from '@arclight/shared';
import type { ActiveTheme } from '../../arclight/index.js';
import { themeCssUrl } from '../../api/themes.js';

/**
 * The theme to show: a signed-in user's own pick ('default' = the server default; ignored when
 * the admin turned user choice off, except for admins), signed out the one this device used last.
 * An id the catalogue no longer has falls back to the default, then to Tron.
 */
export function resolveTheme(
  catalog: ThemeCatalog,
  pick: { userTheme: string | null; isAdmin: boolean; deviceTheme: string | null },
): ThemeInfo {
  const byId = (id: string | null) => (id ? catalog.themes.find((t) => t.id === id) : undefined);
  const own = pick.userTheme !== null ? (pick.userTheme !== 'default' && (catalog.allowUserChoice || pick.isAdmin) ? pick.userTheme : null) : pick.deviceTheme;
  return byId(own) ?? byId(catalog.defaultTheme) ?? byId(BASE_THEME_ID) ?? catalog.themes[0]!;
}

export function activeThemeOf(info: ThemeInfo): ActiveTheme {
  return {
    id: info.id,
    href: info.css ? themeCssUrl(info.css) : null,
    colorScheme: info.colorScheme,
    backdrop: info.backdrop,
    themeColor: info.colorScheme === 'dark' && info.id === BASE_THEME_ID ? '#000000' : (info.swatches[0] ?? '#000000'),
  };
}

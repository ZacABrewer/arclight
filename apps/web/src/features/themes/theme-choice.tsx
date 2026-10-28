import { applyTheme, Skeleton, useActiveTheme } from '../../arclight/index.js';
import { useAuth } from '../../auth/auth-context.js';
import { useSaveUiPreferences, useUiPreferences } from '../../hooks/ui-preferences.js';
import { t } from '../../i18n/index.js';
import { activeThemeOf } from './resolve.js';
import { ThemePicker } from './theme-picker.js';
import { useThemeCatalog } from './use-themes.js';

/**
 * The theme cards for the signed-in user (saved to their account at once) or, without an account
 * (API key, local bypass), for this device. Read-only when the admin turned user choice off.
 */
export function ThemeChoice({ className }: { className?: string | undefined }) {
  const { user, isAdmin } = useAuth();
  const prefs = useUiPreferences();
  const save = useSaveUiPreferences();
  const active = useActiveTheme();
  const catalog = useThemeCatalog();
  const data = catalog.data;
  if (!data) return catalog.isError ? <p className="al-caption">{t('features.themes.couldNotLoad')}</p> : <Skeleton lines={2} />;
  const locked = !data.allowUserChoice && !isAdmin;
  const defaultTheme = data.themes.find((th) => th.id === data.defaultTheme);
  const choose = (id: string) => {
    const info = data.themes.find((th) => th.id === (id === 'default' ? data.defaultTheme : id));
    // Applied straight away; the saved preference keeps it on the next visit.
    if (info) applyTheme(activeThemeOf(info));
    if (user) save.mutate({ theme: id });
  };
  return (
    <>
      <ThemePicker
        className={className}
        aria-label={t('features.themes.theme')}
        themes={data.themes}
        defaultTheme={user ? defaultTheme : undefined}
        value={user ? prefs.theme : active.id}
        onChange={choose}
        disabled={locked || save.isPending}
      />
      {locked ? <p className="al-caption">{t('features.themes.chosenByAdmin', { name: defaultTheme?.name ?? data.defaultTheme })}</p> : null}
    </>
  );
}

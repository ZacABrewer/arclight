import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { authRoutes, renderAt, stubApi, user } from '../../../features/requests/test-utils.js';
import { getActiveUiPreferences } from '../../../lib/ui-preferences.js';
import { formatDateTime } from '../../../lib/format.js';
import { getLocale, setLocale } from '../../../i18n/index.js';
import { BUILTIN_THEME, applyTheme, getReduceMotion, setReduceMotion } from '../../../arclight/index.js';

afterEach(async () => {
  vi.unstubAllGlobals();
  setReduceMotion('system');
  localStorage.clear();
  await setLocale('en');
});

const CATALOG = {
  defaultTheme: 'tron',
  allowUserChoice: true,
  themes: [
    { id: 'tron', name: 'Tron', version: '1.0.0', description: '', author: '', colorScheme: 'dark', backdrop: 'tron', swatches: ['#02090c', '#6ef6ff'], source: 'builtin', css: null },
    { id: 'sorbet', name: 'Sorbet', version: '1.0.0', description: 'Pastel', author: '', colorScheme: 'light', backdrop: 'shapes', swatches: ['#fff7ef', '#ff8fa3'], source: 'bundled', css: 'theme/sorbet/theme.css?v=1.0.0' },
  ],
};

const admin = (settings: Record<string, unknown> = {}) => user({ id: 1, username: 'root', role: 'admin', permissions: 2, settings });

describe('UI preferences', () => {
  it('saves the chosen preferences into the user settings and updates the cache', async () => {
    const calls = stubApi({ ...authRoutes(admin({ locale: 'en' })), '/api/v1/theme': CATALOG }, (url, method, body) =>
      method === 'PUT' && url === '/api/v1/user/me'
        ? { body: admin({ locale: 'en', ...(body as { settings: Record<string, unknown> }).settings }) }
        : undefined,
    );
    const { toasts } = renderAt('/settings/general');
    const section = await screen.findByRole('region', { name: 'UI' });
    const save = within(section).getByRole('button', { name: 'Save preferences' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(await within(section).findByRole('radiogroup', { name: 'Theme' })).toBeTruthy();
    expect((within(section).getByLabelText('Poster size') as HTMLSelectElement).value).toBe('7');

    fireEvent.click(within(section).getByRole('button', { name: 'Sunday' }));
    fireEvent.click(within(section).getByRole('button', { name: '12-hour' }));
    fireEvent.change(within(section).getByLabelText('Date format'), { target: { value: 'YYYY-MM-DD' } });
    fireEvent.change(within(section).getByLabelText('Poster size'), { target: { value: '9' } });
    expect(within(section).getByText('Example: 2026-10-06')).toBeTruthy();
    fireEvent.click(save);

    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')).toEqual({
        url: '/api/v1/user/me',
        method: 'PUT',
        body: { settings: { firstDayOfWeek: 0, timeFormat: '12h', dateFormat: 'YYYY-MM-DD', posterColumns: 9, locale: 'en', reduceMotion: 'system' } },
      }),
    );
    await waitFor(() => expect(toasts.list().some((t) => t.title === 'UI preferences saved')).toBe(true));
    // The cached user now carries the settings, so the form is clean and formatters follow them.
    await waitFor(() => expect(save.disabled).toBe(true));
    expect(getActiveUiPreferences()).toEqual({ firstDayOfWeek: 0, timeFormat: '12h', dateFormat: 'YYYY-MM-DD', posterColumns: 9, locale: 'en', reduceMotion: 'system', theme: 'default' });
    expect(formatDateTime(new Date(2026, 9, 6, 21, 5).toISOString())).toBe('2026-10-06 9:05 PM');
  });

  it('saves the UI language with the preferences and switches the app to it', async () => {
    const calls = stubApi({ ...authRoutes(admin()) }, (url, method, body) =>
      method === 'PUT' && url === '/api/v1/user/me' ? { body: admin((body as { settings: Record<string, unknown> }).settings) } : undefined,
    );
    renderAt('/settings/general');
    const section = await screen.findByRole('region', { name: 'UI' });
    const language = within(section).getByLabelText('Language') as HTMLSelectElement;
    expect(language.value).toBe('auto');
    fireEvent.change(language, { target: { value: 'fr' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Save preferences' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ settings: expect.objectContaining({ locale: 'fr' }) }));
    await waitFor(() => expect(getLocale()).toBe('fr'));
    expect(document.documentElement.lang).toBe('fr');
    expect(localStorage.getItem('arclight.locale')).toBe('fr');
  });

  it('saves "Reduce motion" with the user and applies it to the app root', async () => {
    const calls = stubApi({ ...authRoutes(admin()) }, (url, method, body) =>
      method === 'PUT' && url === '/api/v1/user/me' ? { body: admin((body as { settings: Record<string, unknown> }).settings) } : undefined,
    );
    renderAt('/settings/general');
    const section = await screen.findByRole('region', { name: 'UI' });
    const group = within(section).getByRole('group', { name: 'Reduce motion' });
    // Default: follow the OS.
    expect(within(group).getByRole('button', { name: 'System' }).getAttribute('aria-pressed')).toBe('true');
    expect(document.documentElement.hasAttribute('data-motion')).toBe(false);

    fireEvent.click(within(group).getByRole('button', { name: 'On' }));
    fireEvent.click(within(section).getByRole('button', { name: 'Save preferences' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ settings: expect.objectContaining({ reduceMotion: 'on' }) }));
    await waitFor(() => expect(document.documentElement.getAttribute('data-motion')).toBe('off'));
    expect(getReduceMotion()).toBe('on');
  });

  it('applies a stored "Reduce motion" off override on load', async () => {
    stubApi({ ...authRoutes(admin({ reduceMotion: 'off' })) });
    renderAt('/settings/general');
    await screen.findByRole('region', { name: 'UI' });
    await waitFor(() => expect(getReduceMotion()).toBe('off'));
    expect(document.documentElement.hasAttribute('data-motion')).toBe(false);
  });

  it('saves a picked theme at once and switches the page to it once its stylesheet loads', async () => {
    const calls = stubApi({ ...authRoutes(admin()), '/api/v1/theme': CATALOG }, (url, method, body) =>
      method === 'PUT' && url === '/api/v1/user/me' ? { body: admin((body as { settings: Record<string, unknown> }).settings) } : undefined,
    );
    renderAt('/settings/general');
    const section = await screen.findByRole('region', { name: 'UI' });
    const sorbet = await within(section).findByRole('radio', { name: /Sorbet/ });
    expect(within(section).getByRole('radio', { name: /Server default/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sorbet);
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ settings: { theme: 'sorbet' } }));
    const link = document.head.querySelector<HTMLLinkElement>('link[data-al-theme="sorbet"]');
    expect(link?.getAttribute('href')).toBe('/api/v1/theme/sorbet/theme.css?v=1.0.0');
    expect(document.documentElement.dataset.theme).toBeUndefined();
    link!.dispatchEvent(new Event('load'));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('sorbet'));
    await waitFor(() => expect(within(section).getByRole('radio', { name: /Sorbet/ }).getAttribute('aria-checked')).toBe('true'));
    applyTheme(BUILTIN_THEME);
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(document.head.querySelector('link[data-al-theme]')).toBeNull();
  });
});

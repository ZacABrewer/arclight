import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { authRoutes, renderAt, stubApi, user } from '../../../features/requests/test-utils.js';
import { getActiveUiPreferences } from '../../../lib/ui-preferences.js';
import { formatDateTime } from '../../../lib/format.js';
import { getLocale, setLocale } from '../../../i18n/index.js';

afterEach(async () => {
  vi.unstubAllGlobals();
  localStorage.clear();
  await setLocale('en');
});

const admin = (settings: Record<string, unknown> = {}) => user({ id: 1, username: 'root', role: 'admin', permissions: 2, settings });

describe('UI preferences', () => {
  it('saves the chosen preferences into the user settings and updates the cache', async () => {
    const calls = stubApi({ ...authRoutes(admin({ locale: 'en' })) }, (url, method, body) =>
      method === 'PUT' && url === '/api/v1/user/me'
        ? { body: admin({ locale: 'en', ...(body as { settings: Record<string, unknown> }).settings }) }
        : undefined,
    );
    const { toasts } = renderAt('/settings/general');
    const section = await screen.findByRole('region', { name: 'UI' });
    const save = within(section).getByRole('button', { name: 'Save preferences' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect((within(section).getByLabelText('Theme') as HTMLSelectElement).disabled).toBe(true);
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
        body: { settings: { firstDayOfWeek: 0, timeFormat: '12h', dateFormat: 'YYYY-MM-DD', posterColumns: 9, locale: 'en' } },
      }),
    );
    await waitFor(() => expect(toasts.list().some((t) => t.title === 'UI preferences saved')).toBe(true));
    // The cached user now carries the settings, so the form is clean and formatters follow them.
    await waitFor(() => expect(save.disabled).toBe(true));
    expect(getActiveUiPreferences()).toEqual({ firstDayOfWeek: 0, timeFormat: '12h', dateFormat: 'YYYY-MM-DD', posterColumns: 9, locale: 'en' });
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
});

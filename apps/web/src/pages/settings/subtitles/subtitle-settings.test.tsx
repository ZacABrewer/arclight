import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { SECRET_MASK, SubtitleSettings, type SubtitleProvidersResponse } from '@arclight/shared';
import { languageProfiles, languages, mockApi, renderAt, type Call } from '../../subtitles/test-harness.js';
import { cutoffOptions, toProfileBody } from './language-profiles-card.js';
import { moveProvider, orderedProviders } from './providers-card.js';

afterEach(() => vi.unstubAllGlobals());

const settings = SubtitleSettings.parse({
  providers: [{ id: 'opensubtitlescom', enabled: true, settings: { username: 'bob', password: SECRET_MASK } }],
});

const providers: SubtitleProvidersResponse = {
  schema: [
    {
      id: 'opensubtitlescom',
      name: 'OpenSubtitles.com',
      description: 'Largest database',
      mediaTypes: ['series', 'movie'],
      needsAuth: true,
      fields: [
        { name: 'username', label: 'Username', type: 'text', required: true, secret: false },
        { name: 'password', label: 'Password', type: 'password', required: true, secret: true },
      ],
    },
    { id: 'podnapisi', name: 'Podnapisi', description: 'Slovenian site', mediaTypes: ['series', 'movie'], needsAuth: false, fields: [] },
  ],
  status: [
    { id: 'opensubtitlescom', name: 'OpenSubtitles.com', enabled: true, configured: true, configError: null, throttle: null },
    {
      id: 'podnapisi',
      name: 'Podnapisi',
      enabled: false,
      configured: true,
      configError: null,
      throttle: { code: 'TOO_MANY', description: 'Too many requests', until: '2026-10-26T10:00:00.000Z' },
    },
  ],
};

const routes = {
  'GET /health': { status: 'ok', checks: [] },
  'GET /subtitle/languages': languages,
  'GET /languageprofile': languageProfiles,
  'GET /subtitle/settings': settings,
  'GET /subtitle/providers': providers,
  'PUT /subtitle/settings': (c: Call) => c.body,
  'POST /subtitle/providers/test': { ok: true, message: 'Logged in' },
  'POST /subtitle/providers/reset': providers,
  'POST /languageprofile': (c: Call) => ({ id: 3, ...(c.body as object) }),
};

describe('language profile helpers', () => {
  it('offers None, Any and each profile language as cutoff', () => {
    const opts = cutoffOptions([{ code: 'en', forced: 'never', hi: 'also' }, { code: 'en', forced: 'only', hi: 'never' }, { code: 'fr', forced: 'never', hi: 'also' }]);
    expect(opts.map((o) => o.value)).toEqual(['', '*', 'en', 'fr']);
  });

  it('drops a cutoff that no longer names a profile language', () => {
    const body = toProfileBody({ name: ' X ', languages: [{ code: 'en', forced: 'never', hi: 'also' }], cutoff: 'fr', mustContain: [], mustNotContain: [], originalFormat: false });
    expect(body).toMatchObject({ name: 'X', cutoff: null });
  });

  it('lists every schema provider in priority order and moves them', () => {
    const list = orderedProviders([{ id: 'podnapisi', enabled: true, settings: {} }], providers.schema);
    expect(list.map((p) => p.id)).toEqual(['podnapisi', 'opensubtitlescom']);
    expect(list[1]!.enabled).toBe(false);
    expect(moveProvider(list, 1, -1).map((p) => p.id)).toEqual(['opensubtitlescom', 'podnapisi']);
  });
});

describe('subtitle settings page', () => {
  it('creates a language profile with a picked language, flag modes and cutoff', async () => {
    const calls = mockApi(routes);
    renderAt('/settings/subtitles');
    fireEvent.click(await screen.findByRole('button', { name: /Add language profile/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Add language profile' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'French first' } });
    fireEvent.change(within(dialog).getByLabelText('Add language'), { target: { value: 'fre' } });
    fireEvent.click(await within(dialog).findByRole('option', { name: /French/ }));
    fireEvent.change(within(dialog).getByLabelText('Forced for fr'), { target: { value: 'also' } });
    fireEvent.change(within(dialog).getByLabelText('HI for fr'), { target: { value: 'never' } });
    const cutoff = within(dialog).getByLabelText('Cutoff') as HTMLSelectElement;
    expect([...cutoff.options].map((o) => o.textContent)).toEqual(['None', 'Any language', 'French']);
    fireEvent.change(cutoff, { target: { value: 'fr' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/languageprofile')).toBeTruthy());
    expect(calls.find((c) => c.path === '/languageprofile' && c.method === 'POST')!.body).toEqual({
      name: 'French first',
      languages: [{ code: 'fr', forced: 'also', hi: 'never' }],
      cutoff: 'fr',
      mustContain: [],
      mustNotContain: [],
      originalFormat: false,
    });
  });

  it('shows throttles, tests a provider with the stored secret, and saves the whole settings object', async () => {
    const calls = mockApi(routes);
    renderAt('/settings/subtitles');
    const throttle = await screen.findByTestId('throttle-podnapisi');
    expect(throttle.textContent).toContain('TOO_MANY');
    expect(throttle.textContent).toContain('Too many requests');
    // Days shown, ms stored.
    expect((screen.getByLabelText(/Adaptive delay/) as HTMLInputElement).value).toBe('21');

    fireEvent.click(screen.getByRole('switch', { name: 'Enable Podnapisi' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit OpenSubtitles.com' }));
    const dialog = await screen.findByRole('dialog', { name: 'OpenSubtitles.com settings' });
    const password = within(dialog).getByLabelText(/Password/) as HTMLInputElement;
    expect(password.value).toBe('');
    expect(password.placeholder).toContain('unchanged');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/subtitle/providers/test')).toBeTruthy());
    expect(calls.find((c) => c.path === '/subtitle/providers/test')!.body).toEqual({
      id: 'opensubtitlescom',
      settings: { username: 'bob', password: SECRET_MASK },
    });
    expect(await within(dialog).findByText('Test passed')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(/Username/), { target: { value: 'alice' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toBeTruthy());
    const body = calls.find((c) => c.method === 'PUT')!.body as SubtitleSettings;
    expect(body.providers).toEqual([
      { id: 'opensubtitlescom', enabled: true, settings: { username: 'alice', password: SECRET_MASK } },
      { id: 'podnapisi', enabled: true, settings: {} },
    ]);
    expect(body.search.adaptiveDelayMs).toBe(21 * 24 * 3600 * 1000);
    expect(body.sync).toEqual(settings.sync);

    fireEvent.click(screen.getByRole('button', { name: 'Reset throttles' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/subtitle/providers/reset')?.body).toEqual({ onlyAuthOrConfig: false }));
  });
});

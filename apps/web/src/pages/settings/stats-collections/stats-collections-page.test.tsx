import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { CollectionsSettings, WatchStatsSettings, type MediaServerResource } from '@arclight/shared';
import { renderAt, stubApi } from '../../../test/route-harness.js';
import { statsCollectionsErrors } from './stats-collections-page.js';

afterEach(() => vi.unstubAllGlobals());

const server = (over: Partial<MediaServerResource>): MediaServerResource => ({
  id: 'jf',
  kind: 'jellyfin',
  name: 'Jellyfin',
  url: 'http://jellyfin.example.com:8096',
  apiKey: '********',
  enabled: true,
  usedForAvailability: true,
  usedForRetention: true,
  usedForRefresh: false,
  loginEnabled: false,
  createUsersOnLogin: false,
  syncWatchHistory: true,
  ...over,
});

const stats = WatchStatsSettings.parse({});
const collections = CollectionsSettings.parse({});
const newsletter = {
  preview: { subject: 'New on Arclight this week', from: 'arclight@example.com', to: 'family@example.com', items: [], html: '<p>Hello</p>', text: 'Hello', recipients: 2, problem: null },
  runs: [{ id: 1, sentAt: '2026-10-30T09:00:00.000Z', trigger: 'scheduled', recipients: 2, items: 8, error: null }],
};

function routes(extra: Record<string, unknown> = {}) {
  return stubApi({
    '/api/v1/settings/watchstats': stats,
    '/api/v1/settings/collections': collections,
    '/api/v1/watchstats/newsletter': newsletter,
    '/api/v1/notification': [
      { id: 3, name: 'Family mail', implementation: 'email' },
      { id: 4, name: 'Discord', implementation: 'discord' },
    ],
    '/api/v1/mediaserver': [
      server({}),
      server({ id: 'px', kind: 'plex', name: 'Plex' }),
    ],
    ...extra,
  });
}

describe('stats & collections validation', () => {
  it('needs a connection for the newsletter and a Leaving Soon name', () => {
    expect(statsCollectionsErrors({ stats, collections })).toEqual([]);
    expect(
      statsCollectionsErrors({
        stats: { ...stats, newsletter: { ...stats.newsletter, enabled: true } },
        collections: { ...collections, leavingSoon: { ...collections.leavingSoon, name: ' ' } },
      }),
    ).toEqual(['Pick the email connection that sends the newsletter.', 'Give the Leaving Soon collection a name (up to 100 characters).']);
  });
});

describe('Settings → Stats & collections', () => {
  it('offers email connections and Jellyfin servers and saves both sections', async () => {
    const api = routes({
      'PUT /api/v1/settings/watchstats': (init: RequestInit | undefined) => JSON.parse(String(init?.body)) as unknown,
      'PUT /api/v1/settings/collections': (init: RequestInit | undefined) => JSON.parse(String(init?.body)) as unknown,
    });
    renderAt('/settings/statscollections');
    const connection = (await screen.findByLabelText('Email connection')) as HTMLSelectElement;
    await waitFor(() => expect(Array.from(connection.options).map((o) => o.textContent)).toEqual(['Pick a connection', 'Family mail']));
    fireEvent.click(screen.getByRole('switch', { name: 'Weekly newsletter' }));
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(connection, { target: { value: '3' } });

    const servers = screen.getByRole('group', { name: 'Servers' });
    await within(servers).findByLabelText('Jellyfin');
    expect(within(servers).queryByText('Plex')).toBeNull();
    fireEvent.click(within(servers).getByLabelText('Jellyfin'));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.calls.filter((c) => c.method === 'PUT').length).toBe(2));
    expect(api.calls.find((c) => c.path === '/api/v1/settings/watchstats' && c.method === 'PUT')?.body).toMatchObject({ newsletter: { enabled: true, notificationId: 3 } });
    expect(api.calls.find((c) => c.path === '/api/v1/settings/collections' && c.method === 'PUT')?.body).toMatchObject({ serverIds: ['jf'] });
  });

  it('shows the newsletter preview and sends it now', async () => {
    const api = routes({ 'POST /api/v1/watchstats/newsletter/send': { id: 2, sentAt: '2026-11-01T09:00:00.000Z', trigger: 'manual', recipients: 2, items: 8, error: null } });
    renderAt('/settings/statscollections');
    const pane = await screen.findByRole('region', { name: 'Newsletter preview' });
    expect(await within(pane).findByText('New on Arclight this week')).toBeTruthy();
    const frame = within(pane).getByTitle('Newsletter email') as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toBe('<p>Hello</p>');
    fireEvent.click(within(pane).getByRole('button', { name: 'Send now' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/v1/watchstats/newsletter/send')).toBe(true));
    expect(await screen.findByText('Newsletter sent to 2 recipients')).toBeTruthy();
  });
});

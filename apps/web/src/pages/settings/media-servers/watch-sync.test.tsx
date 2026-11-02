import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Permission, type MediaServerResource, type MediaServerSyncStatus } from '@arclight/shared';
import { authRoutes, renderAt, stubApi, user } from '../../../features/requests/test-utils.js';
import { pluginConnected, watchServers } from './watch-sync.js';

afterEach(() => vi.unstubAllGlobals());

const admin = user({ id: 1, username: 'root', role: 'admin', permissions: Permission.ADMIN });

const server = (over: Partial<MediaServerResource> = {}): MediaServerResource => ({
  id: 'jf1',
  kind: 'jellyfin',
  name: 'Living room',
  url: 'http://jellyfin.lan:8096',
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

const status: MediaServerSyncStatus = {
  serverId: 'jf1',
  watchSyncEnabled: true,
  lastSyncAt: '2026-10-30T10:00:00.000Z',
  lastFullSyncAt: '2026-10-30T04:00:00.000Z',
  lastStatus: 'ok',
  lastError: null,
  itemsTracked: 1234,
  lastUserSyncAt: null,
  lastUserSyncStatus: null,
  lastUserSyncError: null,
  lastEventAt: null,
  users: 3,
  linkedUsers: 2,
};

function routes(extra: Record<string, unknown> = {}) {
  return {
    ...authRoutes(admin),
    '/api/v1/mediaserver': [server(), server({ id: 'px', kind: 'plex', name: 'Den', syncWatchHistory: false })],
    '/api/v1/settings/mediaserver': { kind: null, url: '', apiKey: '', name: '', loginEnabled: false, createUsersOnLogin: false },
    '/api/v1/mediaserver/jf1/sync': status,
    '/api/v1/settings/watchhistory': { syncIntervalMinutes: 10, fullSyncHours: 24, eventRetentionDays: 400 },
    '/api/v1/settings/jellyfinplugin': {
      manifestUrl: 'https://arclight.moviemethat.com/jellyfin/manifest.json',
      latestVersion: '1.0.0.0',
      keys: [{ id: 3, name: 'Old key', prefix: 'alj_abcdef', createdAt: '2026-10-01T00:00:00.000Z', lastUsedAt: null, lastPingAt: null }],
      lastPingAt: null,
      servers: [{ serverId: 'jf1', name: 'Living room', remoteId: null, lastEventAt: null }],
    },
    ...extra,
  };
}

describe('watch sync helpers', () => {
  it('keeps Jellyfin/Emby servers only', () => {
    expect(watchServers([server(), server({ id: 'p', kind: 'plex' }), server({ id: 'e', kind: 'emby' })]).map((s) => s.id)).toEqual(['jf1', 'e']);
  });

  it('calls the plugin connected after recent contact', () => {
    const now = Date.parse('2026-11-01T12:00:00.000Z');
    expect(pluginConnected('2026-11-01T08:00:00.000Z', null, now)).toBe(true);
    expect(pluginConnected(null, '2026-10-20T08:00:00.000Z', now)).toBe(false);
    expect(pluginConnected(null, null, now)).toBe(false);
  });
});

describe('Settings → Media servers: watch history and plugin', () => {
  it('offers the sync toggle for Jellyfin/Emby, not Plex', async () => {
    const calls = stubApi(routes(), (url, method, body) => (method === 'PUT' && url === '/api/v1/mediaserver/jf1' ? { body: { ...server(), ...(body as object) } } : undefined));
    renderAt('/settings/mediaservers');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Living room' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Living room' });
    const toggle = within(dialog).getByRole('switch', { name: 'Sync watch history' }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ syncWatchHistory: false }));
    expect((calls.find((c) => c.method === 'PUT')?.body as Record<string, unknown>)['remoteId']).toBeUndefined();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit Den' }));
    const plex = await screen.findByRole('dialog', { name: 'Edit Den' });
    expect(within(plex).queryByRole('switch', { name: 'Sync watch history' })).toBeNull();
  });

  it('shows the sync state and runs Sync now', async () => {
    const calls = stubApi(routes(), (url, method) =>
      method === 'POST' && url === '/api/v1/mediaserver/jf1/sync' ? { body: { serverId: 'jf1', name: 'Living room', status: 'ok', users: 3, changed: 7, events: 2 } } : undefined,
    );
    const { toasts } = renderAt('/settings/mediaservers');
    const group = await screen.findByRole('group', { name: 'Watch history sync of Living room' });
    expect(await within(group).findByText('1234')).toBeTruthy();
    expect(within(group).getByText('2 linked of 3')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Watch history sync of Den' })).toBeNull();
    fireEvent.click(within(group).getByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url === '/api/v1/mediaserver/jf1/sync')?.body).toEqual({ full: false }));
    await waitFor(() => expect(toasts.list().map((t) => t.title)).toContain('Living room: 3 users, 7 changes'));
    fireEvent.click(within(group).getByRole('button', { name: 'Full resync' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST' && c.url === '/api/v1/mediaserver/jf1/sync').at(-1)?.body).toEqual({ full: true }));
  });

  it('lists synced accounts with their Arclight user', async () => {
    stubApi(
      routes({
        '/api/v1/mediaserver/jf1/accounts': [
          { id: 1, serverId: 'jf1', externalId: 'a', name: 'amy', isAdmin: false, disabled: false, deleted: false, lastActivityAt: null, firstSeenAt: '2026-10-01T00:00:00.000Z', arclightUserId: 4, arclightUsername: 'amy-local', lastWatchSyncAt: null },
          { id: 2, serverId: 'jf1', externalId: 'b', name: 'bob', isAdmin: false, disabled: false, deleted: true, lastActivityAt: null, firstSeenAt: '2026-10-01T00:00:00.000Z', arclightUserId: null, arclightUsername: null, lastWatchSyncAt: null },
        ],
      }),
    );
    renderAt('/settings/mediaservers');
    const group = await screen.findByRole('group', { name: 'Watch history sync of Living room' });
    fireEvent.click(within(group).getByRole('button', { name: 'Synced accounts on Living room' }));
    const dialog = await screen.findByRole('dialog', { name: 'Synced accounts on Living room' });
    expect(await within(dialog).findByText('amy-local')).toBeTruthy();
    expect(within(dialog).getByText('Deleted')).toBeTruthy();
    expect(within(dialog).getByText('Not linked')).toBeTruthy();
  });

  it('creates a plugin key and shows the secret once', async () => {
    const calls = stubApi(routes(), (url, method) =>
      method === 'POST' && url === '/api/v1/settings/jellyfinplugin/keys'
        ? { status: 201, body: { id: 4, name: 'Living room plugin', prefix: 'alj_secret', createdAt: '2026-11-01T00:00:00.000Z', lastUsedAt: null, lastPingAt: null, key: 'alj_secret-value' } }
        : undefined,
    );
    renderAt('/settings/mediaservers');
    const section = await screen.findByRole('region', { name: 'Jellyfin plugin' });
    expect((within(section).getByLabelText('Repository URL') as HTMLInputElement).value).toBe('https://arclight.moviemethat.com/jellyfin/manifest.json');
    expect(await within(section).findByText('Old key')).toBeTruthy();
    expect(within(section).getByText('Not connected')).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'Create plugin key' }));
    const naming = await screen.findByRole('dialog', { name: 'Create plugin key' });
    fireEvent.change(within(naming).getByLabelText('Name'), { target: { value: 'Living room plugin' } });
    fireEvent.click(within(naming).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url === '/api/v1/settings/jellyfinplugin/keys')?.body).toEqual({ name: 'Living room plugin' }));
    const created = await screen.findByRole('dialog', { name: 'Plugin key created' });
    expect((within(created).getByLabelText('Plugin key') as HTMLInputElement).value).toBe('alj_secret-value');
  });

  it('saves the watch history settings', async () => {
    const calls = stubApi(routes(), (url, method, body) => (method === 'PUT' && url === '/api/v1/settings/watchhistory' ? { body } : undefined));
    renderAt('/settings/mediaservers');
    const form = await screen.findByRole('form', { name: 'Watch history settings' });
    fireEvent.change(await within(form).findByLabelText('Sync every (minutes)'), { target: { value: '30' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT' && c.url === '/api/v1/settings/watchhistory')?.body).toEqual({ syncIntervalMinutes: 30, fullSyncHours: 24, eventRetentionDays: 400 }));
  });
});

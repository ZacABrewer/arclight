import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Permission, type MediaServerResource, type TagSyncPreview } from '@arclight/shared';
import { authRoutes, renderAt, stubApi, user } from '../../../features/requests/test-utils.js';
import { tagSyncLabel } from './tag-sync.js';

afterEach(() => vi.unstubAllGlobals());

const admin = user({ id: 1, username: 'root', role: 'admin', permissions: Permission.ADMIN });

const server = (over: Partial<MediaServerResource> = {}): MediaServerResource => ({
  id: 'jf1',
  kind: 'jellyfin',
  name: 'Living room',
  url: 'http://jellyfin.example.com:8096',
  apiKey: '********',
  enabled: true,
  usedForAvailability: true,
  usedForRetention: false,
  usedForRefresh: false,
  loginEnabled: false,
  createUsersOnLogin: false,
  syncWatchHistory: false,
  ...over,
});

const preview: TagSyncPreview = {
  changes: [{ entityType: 'movie', entityId: 4, title: 'Arrival', remoteItemId: 'm1', add: ['arclight:kids'], remove: ['arclight:old'] }],
  totalChanges: 1,
  unmatched: 2,
  truncated: false,
};

function routes(servers: MediaServerResource[]) {
  return {
    ...authRoutes(admin),
    '/api/v1/mediaserver': servers,
    '/api/v1/settings/mediaserver': { kind: null, url: '', apiKey: '', name: '', loginEnabled: false, createUsersOnLogin: false },
    '/api/v1/settings/watchhistory': { syncIntervalMinutes: 10, fullSyncHours: 24, eventRetentionDays: 400 },
    '/api/v1/tag': [
      { id: 1, label: 'kids' },
      { id: 2, label: 'adult' },
    ],
    '/api/v1/mediaserver/jf1/tag-sync': { running: false, lastRunAt: '2026-11-02T03:50:00.000Z', lastChanged: 7, lastUnmatched: 2, lastError: null },
  };
}

async function openEditor(name = 'Living room') {
  fireEvent.click(await screen.findByRole('button', { name: `Edit ${name}` }));
  return screen.findByRole('dialog', { name: `Edit ${name}` });
}

describe('tagSyncLabel', () => {
  it('puts the prefix before the tag', () => {
    expect(tagSyncLabel('arclight:', 'kids')).toBe('arclight:kids');
    expect(tagSyncLabel('', 'kids')).toBe('kids');
  });
});

describe('Settings → Media servers: sync tags', () => {
  it('turns sync on with selected tags and a prefix, showing the written label', async () => {
    const calls = stubApi(routes([server()]), (url, method, body) => (method === 'PUT' && url === '/api/v1/mediaserver/jf1' ? { body: { ...server(), ...(body as object) } } : undefined));
    renderAt('/settings/mediaservers');
    const dialog = await openEditor();
    const section = within(dialog).getByRole('region', { name: 'Sync tags' });
    expect(within(section).queryByRole('button', { name: 'Preview' })).toBeNull();
    fireEvent.click(within(section).getByRole('switch', { name: 'Sync tags' }));
    fireEvent.click(within(section).getByRole('button', { name: 'Selected tags' }));
    fireEvent.click(await within(section).findByRole('button', { name: /Choose tags/ }));
    fireEvent.click(within(section).getByRole('checkbox', { name: 'kids' }));
    fireEvent.change(within(section).getByLabelText('Prefix'), { target: { value: 'arclight:' } });
    expect(within(section).getByText('kids is written as arclight:kids')).toBeTruthy();
    expect((within(section).getByRole('switch', { name: 'Lock tags in the media server' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ tagSync: { enabled: true, mode: 'selected', tagIds: [1], prefix: 'arclight:', lockTags: true } }),
    );
  });

  it('previews the changes and shows the status line', async () => {
    const on = server({ tagSync: { enabled: true, mode: 'all', tagIds: [], prefix: 'arclight:', lockTags: true } });
    const calls = stubApi(routes([on]), (url, method) => {
      if (method === 'POST' && url === '/api/v1/mediaserver/jf1/tag-sync/preview') return { body: preview };
      if (method === 'POST' && url === '/api/v1/mediaserver/jf1/tag-sync/run') return { status: 202 };
      return undefined;
    });
    renderAt('/settings/mediaservers');
    const dialog = await openEditor();
    const section = within(dialog).getByRole('region', { name: 'Sync tags' });
    expect(await within(section).findByText(/: 7 items changed/)).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'Preview' }));
    const modal = await screen.findByRole('dialog', { name: 'Tag changes' });
    expect(within(modal).getByText('1 item to change, 2 not on the server')).toBeTruthy();
    expect(within(modal).getByText('Arrival')).toBeTruthy();
    expect(within(modal).getByText('arclight:kids')).toBeTruthy();
    expect(within(modal).getByText('arclight:old')).toBeTruthy();
    fireEvent.click(within(modal).getAllByRole('button', { name: 'Close' }).at(-1)!);
    fireEvent.click(within(section).getByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/v1/mediaserver/jf1/tag-sync/run')).toBe(true));
  });

  it('asks Remove or Keep when turning sync off, and applies the choice after saving', async () => {
    const on = server({ tagSync: { enabled: true, mode: 'all', tagIds: [], prefix: '', lockTags: true } });
    const calls = stubApi(routes([on]), (url, method, body) => {
      if (method === 'PUT' && url === '/api/v1/mediaserver/jf1') return { body: { ...on, ...(body as object) } };
      if (method === 'POST' && url.startsWith('/api/v1/mediaserver/jf1/tag-sync/')) return { status: url.endsWith('forget') ? 204 : 202 };
      return undefined;
    });
    renderAt('/settings/mediaservers');
    let dialog = await openEditor();
    let section = within(dialog).getByRole('region', { name: 'Sync tags' });
    const toggle = within(section).getByRole('switch', { name: 'Sync tags' }) as HTMLInputElement;

    // Dismissing the question leaves sync on.
    fireEvent.click(toggle);
    let confirm = await screen.findByRole('dialog', { name: 'Remove the tags Arclight added?' });
    fireEvent.keyDown(confirm, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Remove the tags Arclight added?' })).toBeNull());
    expect(toggle.checked).toBe(true);

    fireEvent.click(toggle);
    confirm = await screen.findByRole('dialog', { name: 'Remove the tags Arclight added?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    expect(toggle.checked).toBe(false);
    expect(calls.some((c) => c.url.includes('/tag-sync/'))).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/v1/mediaserver/jf1/tag-sync/remove-all')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ tagSync: { enabled: false } });

    // Keep only forgets.
    dialog = await openEditor();
    section = within(dialog).getByRole('region', { name: 'Sync tags' });
    fireEvent.click(within(section).getByRole('switch', { name: 'Sync tags' }));
    confirm = await screen.findByRole('dialog', { name: 'Remove the tags Arclight added?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/v1/mediaserver/jf1/tag-sync/forget')).toBe(true));
  });

  it('marks Plex as best-effort and hides the section for Audiobookshelf', async () => {
    stubApi(routes([server({ id: 'px', kind: 'plex', name: 'Den' }), server({ id: 'ab', kind: 'audiobookshelf', name: 'Books' })]));
    renderAt('/settings/mediaservers');
    const plex = await openEditor('Den');
    expect(within(plex).getByText('Plex labels are best-effort.')).toBeTruthy();
    fireEvent.click(within(plex).getByRole('button', { name: 'Cancel' }));
    const abs = await openEditor('Books');
    expect(within(abs).queryByRole('region', { name: 'Sync tags' })).toBeNull();
  });
});

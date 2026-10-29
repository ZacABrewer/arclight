import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Permission } from '@arclight/shared';
import { defaultSettings, renderAt, stubApi } from '../../../features/requests/test-utils.js';
import { moveItem } from './sliders-card.js';
import { fromDraft, parseIdList, toDraft } from './override-rules-card.js';

afterEach(() => vi.unstubAllGlobals());

describe('settings → requests', () => {
  it('saves the edited settings section', async () => {
    const settings = defaultSettings();
    const calls = stubApi(
      { '/api/v1/settings/requests': settings, '/api/v1/discoverslider': [], '/api/v1/overriderule': [], '/api/v1/rootfolder': [], '/api/v1/qualityprofile': [], '/api/v1/tag': [] },
      (url, method, body) => (method === 'PUT' && url === '/api/v1/settings/requests' ? { body } : undefined),
    );
    const { toasts } = renderAt('/settings/requests');
    fireEvent.click(await screen.findByLabelText('Allow partial series requests'));
    fireEvent.click(screen.getByLabelText('Auto-approve all 4K movies'));
    fireEvent.click(screen.getByLabelText('View requests'));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const sent = calls.find((c) => c.method === 'PUT')?.body as typeof settings;
    expect(sent.partialRequestsEnabled).toBe(false);
    expect(sent.autoApprove).toEqual({ movie: false, series: false, movie4k: true, series4k: false });
    expect(sent.defaultPermissions).toBe(Permission.REQUEST | Permission.CREATE_ISSUES | Permission.REQUEST_VIEW);
    await waitFor(() => expect(toasts.list().map((t) => t.title)).toContain('Request settings saved'));
  });

  it('shows the unsaved-changes bar on edit and Discard reverts the form', async () => {
    const settings = defaultSettings();
    const calls = stubApi({ '/api/v1/settings/requests': settings, '/api/v1/discoverslider': [], '/api/v1/overriderule': [], '/api/v1/rootfolder': [], '/api/v1/qualityprofile': [], '/api/v1/tag': [] });
    renderAt('/settings/requests');
    const partial = (await screen.findByLabelText('Allow partial series requests')) as HTMLInputElement;
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    const before = partial.checked;
    fireEvent.click(partial);
    fireEvent.click(screen.getByLabelText('Hide available titles'));
    const bar = await screen.findByRole('region', { name: 'Unsaved changes' });
    expect(bar.textContent).toContain('2 unsaved changes');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull());
    expect((screen.getByLabelText('Allow partial series requests') as HTMLInputElement).checked).toBe(before);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  describe('music and audiobook request defaults', () => {
    const profile = (id: number, name: string) => ({
      id,
      name,
      upgradeAllowed: true,
      cutoff: 3,
      items: [{ kind: 'quality', qualityId: 3, allowed: true }],
      minFormatScore: 0,
      cutoffFormatScore: 0,
      minUpgradeFormatScore: 1,
      formatItems: [],
      languages: [],
    });
    const base = (features: { music: boolean; audiobooks: boolean }) => ({
      '/api/v1/settings/requests': defaultSettings(),
      '/api/v1/discoverslider': [],
      '/api/v1/overriderule': [],
      '/api/v1/tag': [],
      '/api/v1/settings/features': features,
      '/api/v1/settings/audiorequests': { music: { rootFolderPath: null, qualityProfileId: null }, audiobook: { rootFolderPath: '/books', qualityProfileId: null } },
      '/api/v1/rootfolder': [
        { id: 1, path: '/movies', mediaType: 'movie', accessible: true },
        { id: 2, path: '/music', mediaType: 'music', accessible: true },
        { id: 3, path: '/books', mediaType: 'audiobook', accessible: true },
      ],
    });

    it('is hidden while both flags are off', async () => {
      stubApi({ ...base({ music: false, audiobooks: false }), '/api/v1/qualityprofile': [] });
      renderAt('/settings/requests');
      await screen.findByLabelText('Allow partial series requests');
      await waitFor(() => expect(screen.queryByText('Music and audiobook requests')).toBeNull());
      expect(screen.queryByLabelText('Music root folder')).toBeNull();
    });

    it('shows only the audiobook half when only audiobooks are on', async () => {
      stubApi({ ...base({ music: false, audiobooks: true }), '/api/v1/qualityprofile': [] });
      renderAt('/settings/requests');
      expect(await screen.findByText('Music and audiobook requests')).toBeTruthy();
      expect(((await screen.findByLabelText('Audiobooks root folder')) as HTMLSelectElement).value).toBe('/books');
      expect(screen.queryByLabelText('Music root folder')).toBeNull();
    });

    it('saves the chosen music folder and profile', async () => {
      const calls = stubApi({ ...base({ music: true, audiobooks: true }) }, (url, method, body) => {
        if (url === '/api/v1/settings/audiorequests' && method === 'PUT') return { body };
        if (url.startsWith('/api/v1/qualityprofile') && method === 'GET') {
          const domain = new URL(url, 'http://x').searchParams.get('mediaDomain');
          return { body: domain === 'music' ? [{ ...profile(7, 'Lossless'), mediaDomain: 'music' }] : [] };
        }
        return undefined;
      });
      const { toasts } = renderAt('/settings/requests');
      const root = (await screen.findByLabelText('Music root folder')) as HTMLSelectElement;
      await waitFor(() => expect(Array.from(root.options).map((o) => o.value)).toEqual(['', '/music']));
      fireEvent.change(root, { target: { value: '/music' } });
      const prof = screen.getByLabelText('Music quality profile') as HTMLSelectElement;
      await waitFor(() => expect(Array.from(prof.options).map((o) => o.textContent)).toEqual(['Automatic (first available)', 'Lossless']));
      fireEvent.change(prof, { target: { value: '7' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url === '/api/v1/settings/audiorequests')).toBe(true));
      expect(calls.find((c) => c.method === 'PUT' && c.url === '/api/v1/settings/audiorequests')?.body).toEqual({
        music: { rootFolderPath: '/music', qualityProfileId: 7 },
        audiobook: { rootFolderPath: '/books', qualityProfileId: null },
      });
      await waitFor(() => expect(toasts.list().map((t) => t.title)).toContain('Music and audiobook defaults saved'));
    });
  });

  it('reorders sliders and round-trips override rule drafts', () => {
    expect(moveItem(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(parseIdList('12, 34|x 56')).toEqual([12, 34, 56]);
    const rule = {
      id: 1,
      name: 'Anime',
      mediaType: 'series' as const,
      is4k: false,
      enabled: true,
      users: [2],
      genres: [16],
      languages: ['ja'],
      keywords: [210024],
      qualityProfileId: 3,
      rootFolderPath: '/anime',
      tags: [1],
      autoApprove: true,
    };
    const { id, ...input } = rule;
    void id;
    expect(fromDraft(toDraft(rule))).toEqual(input);
  });
});

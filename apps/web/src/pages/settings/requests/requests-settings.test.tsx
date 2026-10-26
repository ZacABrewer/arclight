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
    fireEvent.click(screen.getByRole('button', { name: 'Save request settings' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const sent = calls.find((c) => c.method === 'PUT')?.body as typeof settings;
    expect(sent.partialRequestsEnabled).toBe(false);
    expect(sent.autoApprove).toEqual({ movie: false, series: false, movie4k: true, series4k: false });
    expect(sent.defaultPermissions).toBe(Permission.REQUEST | Permission.CREATE_ISSUES | Permission.REQUEST_VIEW);
    await waitFor(() => expect(toasts.list().map((t) => t.title)).toContain('Request settings saved'));
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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { DEFAULT_COMMUNITY_CATALOGUE_URL, type CommunityCatalogueStatus } from '@arclight/shared';
import { renderAt, stubApi } from '../../../test/route-harness.js';
import { communitySyncSummary, validateCommunitySettings } from './indexer-catalogue-page.js';

afterEach(() => vi.unstubAllGlobals());

const status: CommunityCatalogueStatus = {
  settings: { enabled: true, url: DEFAULT_COMMUNITY_CATALOGUE_URL, intervalHours: 24 },
  lastSyncAt: '2026-10-26T00:00:00Z',
  lastSuccessAt: '2026-10-26T00:00:00Z',
  lastError: null,
  sourceUrl: DEFAULT_COMMUNITY_CATALOGUE_URL,
  files: 577,
  supported: 572,
  limited: 45,
  unsupported: 5,
  overridden: 7,
  topReasons: [
    { reason: 'login.captcha (image) is not supported; login proceeds without it', count: 45 },
    { reason: 'id "…" does not match file name "…"', count: 5 },
  ],
  previousAvailable: true,
  previousSyncedAt: '2026-10-25T00:00:00Z',
  stale: false,
};

function stub(extra: Record<string, unknown> = {}) {
  return stubApi({
    '/api/v1/indexer/catalogue/community/status': status,
    'PUT /api/v1/indexer/catalogue/community/settings': (init: RequestInit | undefined) => JSON.parse(String(init?.body)) as unknown,
    'POST /api/v1/indexer/catalogue/community/sync': { notModified: false, added: 2, updated: 1, removed: 0, unchanged: 574, failed: [], total: 577 },
    'POST /api/v1/indexer/catalogue/community/rollback': status,
    ...extra,
  });
}

describe('Settings → Indexer catalogue', () => {
  it('shows both sources, counts and the most common limitations', async () => {
    stub();
    renderAt('/settings/indexercatalogue');
    expect(await screen.findByRole('heading', { name: 'Indexer catalogue' })).toBeTruthy();
    const builtin = (await screen.findByRole('switch', { name: /Always on|Arclight built-in/ })) as HTMLInputElement;
    expect(builtin.checked).toBe(true);
    expect(builtin.disabled).toBe(true);
    expect((screen.getByRole('switch', { name: /Use community definitions|Community catalogue/ }) as HTMLInputElement).checked).toBe(true);
    const pane = screen.getByLabelText('Community catalogue status');
    expect(within(pane).getByText('577')).toBeTruthy();
    expect(within(pane).getByText('572')).toBeTruthy();
    expect(within(pane).getByText(/login.captcha \(image\) is not supported/)).toBeTruthy();
    expect(within(pane).getByText(/does not match file name/)).toBeTruthy();
  });

  it('turns the community catalogue off and saves', async () => {
    const api = stub();
    renderAt('/settings/indexercatalogue');
    fireEvent.click(await screen.findByRole('switch', { name: /Use community definitions|Community catalogue/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save catalogue settings' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'PUT' && c.path === '/api/v1/indexer/catalogue/community/settings')?.body).toEqual({ ...status.settings, enabled: false }),
    );
  });

  it('syncs now and rolls back', async () => {
    const api = stub();
    renderAt('/settings/indexercatalogue');
    fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/v1/indexer/catalogue/community/sync')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Roll back to previous sync' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/v1/indexer/catalogue/community/rollback')).toBe(true));
  });

  it('shows the last error and validates the form', async () => {
    stub({ '/api/v1/indexer/catalogue/community/status': { ...status, lastError: 'HTTP 403 (rate limited until 2026-10-26T01:00:00.000Z)' } });
    renderAt('/settings/indexercatalogue');
    expect(await screen.findByText(/Last sync failed: HTTP 403/)).toBeTruthy();
    expect(validateCommunitySettings({ enabled: true, url: 'ftp://x', intervalHours: 0 })).toEqual({ url: 'Use an http(s) URL', intervalHours: 'Use 1 to 168 hours' });
    expect(communitySyncSummary({ notModified: true, added: 0, updated: 0, removed: 0, unchanged: 3, failed: [], total: 3 })).toBe('Listing unchanged · 3 definitions');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { ToastProvider } from '../../components/toast.js';
import { createToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { routeTree } from '../../router.js';

class FakeSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}

const hd = {
  id: 1,
  name: 'HD-1080p',
  upgradeAllowed: true,
  cutoff: 3,
  items: [
    { kind: 'quality', qualityId: 4, allowed: true },
    { kind: 'quality', qualityId: 3, allowed: true },
  ],
  minFormatScore: 0,
  cutoffFormatScore: 0,
  minUpgradeFormatScore: 1,
  formatItems: [],
  languages: [],
};

const responses: Record<string, unknown> = {
  '/api/v1/qualityprofile': [hd],
  '/api/v1/qualityprofile/schema': { ...hd, id: undefined, name: 'New profile' },
  '/api/v1/customformat': [],
  '/api/v1/delayprofile': [],
  '/api/v1/releaseprofile': [],
  '/api/v1/indexer': [],
  '/api/v1/tag': [],
  '/api/v1/rootfolder': [],
};

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/qualityprofile/1' && init?.method === 'DELETE') {
        return new Response(JSON.stringify({ error: 'quality profile 1 is in use', code: 'IN_USE' }), { status: 409 });
      }
      const body = responses[url];
      return body === undefined
        ? new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
        : new Response(JSON.stringify(body), { status: 200 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function renderAt(path: string) {
  const toasts = createToastStore();
  const queryClient = createQueryClient(toasts);
  const router = createRouter({ routeTree, context: { queryClient }, history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider store={toasts}>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return router;
}

describe('settings routes', () => {
  it('redirects the old hyphenated path to /settings/mediamanagement', async () => {
    const router = renderAt('/settings/media-management');
    expect(await screen.findByRole('heading', { name: 'Media management' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/settings/mediamanagement');
    // Naming and media-management routes are not on this server: the page says so instead of failing.
    expect((await screen.findAllByText(/not available on this server yet/)).length).toBeGreaterThan(0);
  });

  it('opens a quality profile in the editor and shows the in-use guard on delete', async () => {
    renderAt('/settings/profiles');
    fireEvent.click(await screen.findByRole('button', { name: 'HD-1080p' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit HD-1080p' });
    const cutoff = within(dialog).getByLabelText('Upgrade until') as HTMLSelectElement;
    expect(cutoff.value).toBe('3');
    // Best first in the editor.
    expect(within(dialog).getAllByTestId('quality-item').map((li) => li.textContent)).toEqual([
      expect.stringContaining('WEBDL-1080p'),
      expect.stringContaining('HDTV-720p'),
    ]);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete profile' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete HD-1080p?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete profile' }));
    expect((await within(confirm).findByRole('alert')).textContent).toMatch(/still in use/);
  });

  it('shows quality profile cards with the cutoff and allowed qualities as mono quality tags', async () => {
    renderAt('/settings/profiles');
    const title = await screen.findByRole('button', { name: 'HD-1080p' });
    const card = title.closest('.al-item-card') as HTMLElement;
    const allowed = within(card).getByLabelText('Allowed qualities in HD-1080p');
    expect(Array.from(allowed.querySelectorAll('.al-quality')).map((t) => t.textContent)).toEqual(['WEBDL-1080p', 'HDTV-720p']);
    expect(card.querySelector('[data-cutoff="true"]')?.textContent).toBe('WEBDL-1080p');
  });

  it('reorders qualities with the move buttons and keeps the cutoff marker on the cutoff quality', async () => {
    renderAt('/settings/profiles');
    fireEvent.click(await screen.findByRole('button', { name: 'HD-1080p' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit HD-1080p' });
    const rows = () => within(dialog).getAllByTestId('quality-item');
    const markerRow = () => rows().find((r) => within(r).queryByTestId('cutoff-marker'));
    expect(markerRow()?.textContent).toContain('WEBDL-1080p');
    expect(within(markerRow()!).getByTestId('cutoff-marker').textContent).toBe('CUTOFF');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Move WEBDL-1080p down' }));
    expect(rows().map((r) => r.textContent)).toEqual([expect.stringContaining('HDTV-720p'), expect.stringContaining('WEBDL-1080p')]);
    // The marker follows the cutoff quality to its new row.
    expect(rows()[1]!.getAttribute('data-cutoff')).toBe('true');
    expect(markerRow()?.textContent).toContain('WEBDL-1080p');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Move WEBDL-1080p up' }));
    expect(rows()[0]!.textContent).toContain('WEBDL-1080p');

    // Changing the cutoff moves the marker.
    fireEvent.change(within(dialog).getByLabelText('Upgrade until'), { target: { value: '4' } });
    expect(markerRow()?.textContent).toContain('HDTV-720p');
  });
});

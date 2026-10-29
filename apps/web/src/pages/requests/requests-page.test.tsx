import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Permission } from '@arclight/shared';
import { authRoutes, makeRequest, renderAt, stubApi, user } from '../../features/requests/test-utils.js';
import { requestTimeline } from './my-requests-page.js';

afterEach(() => vi.unstubAllGlobals());

const page = (results: unknown[]) => ({ pageInfo: { total: results.length, take: 20, skip: 0 }, results });

describe('requests page', () => {
  it('maps tabs and the media filter to query params', async () => {
    const calls = stubApi({ '/api/v1/request': page([makeRequest()]) });
    renderAt('/requests');
    expect(await screen.findByRole('link', { name: 'The Matrix' })).toBeTruthy();
    const listUrls = () => calls.filter((c) => c.url.startsWith('/api/v1/request?')).map((c) => c.url);
    // Admin (auth status unavailable → admin fallback) lands on Pending.
    expect(listUrls()[0]).toContain('filter=pending');
    fireEvent.click(screen.getByRole('tab', { name: 'Declined' }));
    await waitFor(() => expect(listUrls().some((u) => u.includes('filter=declined'))).toBe(true));
    fireEvent.change(screen.getByLabelText('Media type filter'), { target: { value: 'series' } });
    await waitFor(() => expect(listUrls().some((u) => u.includes('filter=declined') && u.includes('mediaType=series'))).toBe(true));
  });

  it('bulk-approves the selected pending requests', async () => {
    const calls = stubApi(
      { '/api/v1/request': page([makeRequest({ id: 1 }), makeRequest({ id: 2, mediaTitle: 'Heat', mediaTmdbId: 949 })]) },
      (url, method) => (method === 'POST' && url === '/api/v1/request/bulk/approve' ? { body: { ok: [1, 2], failed: [] } } : undefined),
    );
    const { toasts } = renderAt('/requests');
    await screen.findByRole('link', { name: 'Heat' });
    fireEvent.click(screen.getByLabelText('Select all pending'));
    const bar = screen.getByRole('toolbar', { name: 'Bulk actions' });
    expect(within(bar).getByText('2 selected')).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Approve selected' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/request/bulk/approve')).toBe(true));
    expect(calls.find((c) => c.url === '/api/v1/request/bulk/approve')?.body).toEqual({ ids: [1, 2] });
    await waitFor(() => expect(toasts.list().map((t) => t.title)).toContain('Approved 2 requests'));
  });

  it('shows no admin actions to a user who may only view all requests', async () => {
    stubApi({ ...authRoutes(user({ permissions: Permission.REQUEST | Permission.REQUEST_VIEW })), '/api/v1/request': page([makeRequest()]) });
    renderAt('/requests');
    expect(await screen.findByRole('link', { name: 'The Matrix' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByLabelText('Select all pending')).toBeNull();
    // Owner of a pending request may still delete it.
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
  });

  it('lists music requests from the media filter and approves one', async () => {
    const album = {
      id: 7,
      kind: 'album',
      status: 'pending',
      foreignId: 'rg-1',
      title: 'Blue Shore',
      subtitle: 'The Example Band',
      year: 2020,
      requestedBy: { id: 2, username: 'amy' },
      modifiedBy: null,
      mediaStatus: 'pending',
      canRemove: true,
      createdAt: '2026-10-20T10:00:00.000Z',
      updatedAt: '2026-10-20T10:00:00.000Z',
    };
    const calls = stubApi(
      { '/api/v1/request': page([makeRequest()]), '/api/v1/audiorequest': page([album]), '/api/v1/settings/features': { music: true, audiobooks: false } },
      (url, method) => (method === 'POST' && url === '/api/v1/audiorequest/7/approve' ? { body: { ...album, status: 'approved', mediaStatus: 'processing' } } : undefined),
    );
    renderAt('/requests');
    expect(await screen.findByRole('link', { name: 'The Matrix' })).toBeTruthy();
    const filter = screen.getByLabelText('Media type filter') as HTMLSelectElement;
    await waitFor(() => expect([...filter.options].map((o) => o.value)).toContain('music'));
    expect([...filter.options].map((o) => o.value)).not.toContain('audiobook');
    fireEvent.change(filter, { target: { value: 'music' } });
    const link = await screen.findByRole('link', { name: 'Blue Shore' });
    expect(link.getAttribute('href')).toBe('/discover/music/album/rg-1');
    const audioUrl = calls.find((c) => c.url.startsWith('/api/v1/audiorequest?'))?.url ?? '';
    expect(audioUrl).toContain('domain=music');
    expect(audioUrl).toContain('filter=pending');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/v1/audiorequest/7/approve')).toBe(true));
  });

  it('switches My requests (the portal page for a user) to audiobooks while that flag is on', async () => {
    const calls = stubApi({
      ...authRoutes(user({ permissions: Permission.REQUEST })),
      '/api/v1/request': page([makeRequest()]),
      '/api/v1/audiorequest': page([
        {
          id: 9,
          kind: 'book',
          status: 'pending',
          foreignId: 'B000TEST01',
          region: 'us',
          title: 'Quiet Harbour',
          requestedBy: { id: 2, username: 'amy' },
          modifiedBy: null,
          mediaStatus: 'pending',
          canRemove: true,
          createdAt: '2026-10-20T10:00:00.000Z',
          updatedAt: '2026-10-20T10:00:00.000Z',
        },
      ]),
      '/api/v1/settings/features': { music: false, audiobooks: true },
    });
    renderAt('/requests/mine');
    expect(await screen.findByRole('link', { name: /The Matrix/ })).toBeTruthy();
    const media = await screen.findByRole('group', { name: 'Media type' });
    expect(within(media).queryByRole('button', { name: 'Music' })).toBeNull();
    fireEvent.click(within(media).getByRole('button', { name: 'Audiobooks' }));
    expect((await screen.findByRole('link', { name: /Quiet Harbour/ })).getAttribute('href')).toBe('/portal/audiobooks/book/B000TEST01?region=us');
    expect(calls.find((c) => c.url.startsWith('/api/v1/audiorequest?'))?.url).toContain('requestedBy=2');
    expect(screen.getByRole('button', { name: 'Cancel request' })).toBeTruthy();
  });

  it('builds the my-requests timeline', () => {
    expect(requestTimeline(makeRequest()).map((s) => [s.label, s.done])).toEqual([
      ['Requested', true],
      ['Awaiting approval', false],
      ['Available', false],
    ]);
    expect(requestTimeline(makeRequest({ status: 'completed', mediaStatus: 'available' })).map((s) => s.done)).toEqual([true, true, true]);
    expect(requestTimeline(makeRequest({ status: 'declined' })).map((s) => s.label)).toEqual(['Requested', 'Declined']);
  });
});

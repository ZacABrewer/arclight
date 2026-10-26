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

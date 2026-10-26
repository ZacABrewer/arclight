import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { authRoutes, makeRequest, renderAt, stubApi, user } from '../../features/requests/test-utils.js';
import { initials, problemLabel } from '../issues/issues-page.js';
import { quotaPercent } from '../profile-page.js';
import { requestTimelineItem } from './my-requests-page.js';

afterEach(() => vi.unstubAllGlobals());

const page = (results: unknown[]) => ({ pageInfo: { total: results.length, take: 20, skip: 0 }, results });

describe('requests area on Arclight', () => {
  it('helpers: initials, problem label, quota percent, timeline tone', () => {
    expect(initials('amy')).toBe('am');
    expect(initials('Jane Doe')).toBe('JD');
    expect(problemLabel({ problemSeason: 2, problemEpisode: 0 })).toBe('Season 2');
    expect(quotaPercent({ limit: 4, used: 1 })).toBe(25);
    expect(quotaPercent({ limit: null, used: 9 })).toBeNull();
    expect(requestTimelineItem(makeRequest({ status: 'declined' })).tone).toBe('warn');
    expect(requestTimelineItem(makeRequest({ status: 'failed' })).tone).toBe('danger');
  });

  it('my requests renders a timeline with the status chip and cancels after confirming', async () => {
    const calls = stubApi(
      { ...authRoutes(user()), '/api/v1/request': page([makeRequest({ id: 7 })]) },
      (url, method) => (method === 'DELETE' && url === '/api/v1/request/7' ? { status: 204 } : undefined),
    );
    renderAt('/requests/mine');
    expect(await screen.findByRole('link', { name: /The Matrix/ })).toBeTruthy();
    expect(document.querySelector('.al-timeline')).toBeTruthy();
    expect(screen.getByText('Pending approval')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel your request for The Matrix?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel request' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/v1/request/7')).toBe(true));
  });

  it('declining opens a confirm that names the title', async () => {
    const calls = stubApi({ '/api/v1/request': page([makeRequest({ id: 3 })]) }, (url, method) =>
      method === 'POST' && url === '/api/v1/request/3/decline' ? { body: makeRequest({ id: 3, status: 'declined' }) } : undefined,
    );
    renderAt('/requests');
    await screen.findByRole('link', { name: 'The Matrix' });
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    const dialog = await screen.findByRole('dialog', { name: 'Decline The Matrix?' });
    fireEvent.change(within(dialog).getByLabelText('Reason (optional)'), { target: { value: 'Already owned' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Decline request' }));
    await waitFor(() => expect(calls.find((c) => c.url === '/api/v1/request/3/decline')?.body).toEqual({ reason: 'Already owned' }));
  });

  it('issues list renders a table with status chips and filters by type', async () => {
    const base = {
      status: 'open',
      mediaType: 'movie',
      mediaTmdbId: 603,
      problemSeason: 0,
      problemEpisode: 0,
      createdBy: { id: 2, username: 'amy' },
      modifiedBy: null,
      comments: [],
      createdAt: '2026-10-20T10:00:00.000Z',
      updatedAt: '2026-10-20T10:00:00.000Z',
    };
    stubApi({
      '/api/v1/issue': page([
        { ...base, id: 1, type: 'audio', mediaTitle: 'Loud Film' },
        { ...base, id: 2, type: 'video', mediaTitle: 'Dark Film' },
      ]),
    });
    renderAt('/issues');
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('link', { name: 'Loud Film' })).toBeTruthy();
    expect(within(table).getAllByText('Open')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Issue type filter'), { target: { value: 'video' } });
    expect(within(screen.getByRole('table')).queryByRole('link', { name: 'Loud Film' })).toBeNull();
    expect(within(screen.getByRole('table')).getByRole('link', { name: 'Dark Film' })).toBeTruthy();
  });

  it('watchlist removes a title from the poster grid', async () => {
    const calls = stubApi(
      {
        '/api/v1/watchlist': [
          { id: 11, userId: 2, mediaType: 'movie', tmdbId: 603, title: 'The Matrix', source: 'manual', createdAt: '2026-10-20T10:00:00.000Z', mediaStatus: 'available' },
        ],
      },
      (url, method) => (method === 'DELETE' && url === '/api/v1/watchlist/11' ? { status: 204 } : undefined),
    );
    renderAt('/watchlist');
    const grid = await screen.findByTestId('watchlist-grid');
    const card = within(grid).getByRole('article', { name: 'The Matrix' });
    expect(within(card).getByText('Available')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Remove The Matrix' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/v1/watchlist/11')).toBe(true));
  });
});

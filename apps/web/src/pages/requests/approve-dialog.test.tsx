import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { authRoutes, makeRequest, makeTitle, renderAt, season, stubApi, user } from '../../features/requests/test-utils.js';
import { rootFolders } from '../library/test-fixtures.js';
import { approveDraftFor, buildApproveBody } from './approve-dialog.js';

afterEach(() => vi.unstubAllGlobals());

const page = (results: unknown[]) => ({ pageInfo: { total: results.length, take: 20, skip: 0 }, results });
const admin = user({ id: 1, username: 'root', role: 'admin', permissions: 2 });

const seriesRequest = makeRequest({
  id: 9,
  type: 'series',
  mediaTmdbId: 1399,
  mediaTitle: 'Andor',
  rootFolderPath: '/data/tv',
  tags: [4],
  seasons: [
    { seasonNumber: 1, status: 'pending' },
    { seasonNumber: 2, status: 'pending' },
  ],
});

describe('approve overrides', () => {
  it('builds a body with only the chosen overrides', () => {
    const movie = makeRequest();
    expect(buildApproveBody(movie, approveDraftFor(movie))).toEqual({ tags: [] });
    expect(buildApproveBody(movie, { ...approveDraftFor(movie), qualityProfileId: '2', minimumAvailability: 'released', monitorOption: 'all' })).toEqual({
      tags: [],
      qualityProfileId: 2,
      minimumAvailability: 'released',
    });
    // Unchanged seasons are not sent; a changed set is sent sorted.
    expect(buildApproveBody(seriesRequest, approveDraftFor(seriesRequest))).toEqual({ tags: [4], rootFolderPath: '/data/tv' });
    expect(buildApproveBody(seriesRequest, { ...approveDraftFor(seriesRequest), seasons: [3, 1], monitorOption: 'future', minimumAvailability: 'released' })).toEqual({
      tags: [4],
      rootFolderPath: '/data/tv',
      monitorOption: 'future',
      seasons: [1, 3],
    });
  });

  it('Approve opens the dialog prefilled from the request and posts the overrides', async () => {
    const calls = stubApi(
      {
        ...authRoutes(admin),
        '/api/v1/request': page([seriesRequest]),
        '/api/v1/rootfolder': rootFolders,
        '/api/v1/tag': [{ id: 4, label: 'kids' }],
        '/api/v1/discover/tv/1399': makeTitle({ mediaType: 'series', tmdbId: 1399, title: 'Andor', seasons: [season(1), season(2), season(3)] }),
      },
      (url, method) => (method === 'POST' && url === '/api/v1/request/9/approve' ? { body: { ...seriesRequest, status: 'approved' } } : undefined),
    );
    renderAt('/requests');
    await screen.findByRole('link', { name: 'Andor' });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve Andor' });
    const root = within(dialog).getByLabelText('Root folder') as HTMLSelectElement;
    await waitFor(() => expect(root.value).toBe('/data/tv'));
    fireEvent.change(root, { target: { value: 'D:\\Media\\TV' } });
    fireEvent.change(within(dialog).getByLabelText(/^Monitor/), { target: { value: 'future' } });
    fireEvent.click(await within(dialog).findByRole('checkbox', { name: 'Season 3' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Season 1' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve request' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/api/v1/request/9/approve')?.body).toEqual({
        tags: [4],
        rootFolderPath: 'D:\\Media\\TV',
        monitorOption: 'future',
        seasons: [2, 3],
      }),
    );
  });

  it('movies offer minimum availability instead of monitor and seasons', async () => {
    const calls = stubApi(
      { ...authRoutes(admin), '/api/v1/request': page([makeRequest({ id: 5 })]), '/api/v1/rootfolder': rootFolders, '/api/v1/tag': [] },
      (url, method) => (method === 'POST' && url === '/api/v1/request/5/approve' ? { body: makeRequest({ id: 5, status: 'approved' }) } : undefined),
    );
    renderAt('/requests');
    await screen.findByRole('link', { name: 'The Matrix' });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve The Matrix' });
    expect(within(dialog).queryByLabelText(/^Monitor/)).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Minimum availability'), { target: { value: 'inCinemas' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve request' }));
    await waitFor(() => expect(calls.find((c) => c.url === '/api/v1/request/5/approve')?.body).toEqual({ tags: [], minimumAvailability: 'inCinemas' }));
  });
});

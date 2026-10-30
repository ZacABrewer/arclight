import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Issue } from '@arclight/shared';
import { renderAt, stubApi } from '../../features/requests/test-utils.js';

afterEach(() => vi.unstubAllGlobals());

const amy = { id: 2, username: 'amy' };
const issue = (id: number, mediaTitle: string): Issue => ({
  id,
  type: 'audio',
  status: 'open',
  mediaType: 'movie',
  mediaTmdbId: 100 + id,
  mediaTitle,
  problemSeason: 0,
  problemEpisode: 0,
  createdBy: amy,
  modifiedBy: null,
  comments: [],
  createdAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-20T10:00:00.000Z',
});
const page = (results: Issue[], total = results.length) => ({ pageInfo: { total, take: 25, skip: 0 }, results });

describe('issues page search', () => {
  it('sends q, shows the server count, resets the page and clears from the empty state', async () => {
    const calls = stubApi({}, (url, method) => {
      if (method !== 'GET' || !url.startsWith('/api/v1/issue?')) return undefined;
      return { body: url.includes('q=nothing') ? page([]) : page([issue(1, 'Heat')], 60) };
    });
    renderAt('/issues?q=heat');
    expect(await screen.findByRole('link', { name: 'Heat' })).toBeTruthy();
    const urls = () => calls.filter((c) => c.url.startsWith('/api/v1/issue?')).map((c) => c.url);
    expect(urls()[0]).toContain('q=heat');
    expect(screen.getByText('60 results')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(urls().some((u) => u.includes('skip=25'))).toBe(true));
    const box = screen.getByRole('searchbox', { name: 'Search this list' });
    fireEvent.change(box, { target: { value: 'nothing' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(urls().some((u) => u.includes('q=nothing'))).toBe(true));
    expect(urls().find((u) => u.includes('q=nothing'))).toContain('skip=0');
    fireEvent.click(await screen.findByRole('button', { name: 'Clear search' }));
    await waitFor(() => expect(urls().at(-1)).not.toContain('q='));
    expect(await screen.findByRole('link', { name: 'Heat' })).toBeTruthy();
  });

  it('the filter bar Clear also clears the search; Select all selects the matching rows shown', async () => {
    const calls = stubApi({}, (url, method) => {
      if (method === 'GET' && url.startsWith('/api/v1/issue?')) return { body: url.includes('q=') ? page([issue(1, 'Heat')]) : page([issue(1, 'Heat'), issue(2, 'Alien')]) };
      return undefined;
    });
    renderAt('/issues?q=heat');
    await screen.findByRole('link', { name: 'Heat' });
    fireEvent.click(screen.getByLabelText('Select all rows'));
    expect(within(screen.getByRole('toolbar', { name: 'Bulk actions' })).getByText('1 selected')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('group', { name: 'Filters' })).getByRole('button', { name: 'Clear' }));
    expect(await screen.findByRole('link', { name: 'Alien' })).toBeTruthy();
    expect(calls.filter((c) => c.url.startsWith('/api/v1/issue?')).at(-1)?.url).not.toContain('q=');
  });
});

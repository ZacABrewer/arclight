import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import type { CalendarItem } from '@arclight/shared';
import { ToastProvider } from '../../components/toast.js';
import { createToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { routeTree } from '../../router.js';
import { makeEpisode } from '../library/test-fixtures.js';

class FakeSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}

const at = (d: number, h: number) => new Date(2026, 9, d, h, 0).toISOString();
const items: CalendarItem[] = [
  { type: 'episode', date: at(6, 21), seriesId: 4, seriesTitle: 'Severance', episode: makeEpisode({ id: 1, seriesId: 4, seasonNumber: 2, episodeNumber: 9, title: 'The After Hours', hasFile: true, airDateUtc: at(6, 21) }) },
  { type: 'episode', date: at(14, 21), seriesId: 5, seriesTitle: 'Andor', episode: makeEpisode({ id: 2, seriesId: 5, seasonNumber: 2, episodeNumber: 3, airDateUtc: at(14, 21) }) },
  { type: 'episode', date: at(27, 21), seriesId: 5, seriesTitle: 'Fallout', episode: makeEpisode({ id: 3, seriesId: 6, seasonNumber: 1, episodeNumber: 4, airDateUtc: at(27, 21) }) },
];

let calls: string[] = [];
let posts: Array<{ url: string; body: unknown }> = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 15, 12, 0));
  calls = [];
  posts = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url);
      const path = url.split('?')[0];
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ releases: 0, approved: 0, pending: 0, grabbed: [] }), { status: 200 });
      }
      const routes: Record<string, unknown> = {
        '/api/v1/calendar': items,
        '/api/v1/calendar/feed': { path: '/calendar/feed.ics?token=abc', token: 'abc' },
        '/api/v1/health': { status: 'ok', checks: [] },
        '/api/v1/system/status': {},
      };
      const body = path ? routes[path] : undefined;
      return body === undefined ? new Response(JSON.stringify({ error: 'not found' }), { status: 404 }) : new Response(JSON.stringify(body), { status: 200 });
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderAt(path: string) {
  const queryClient = createQueryClient(createToastStore());
  const router = createRouter({ routeTree, context: { queryClient }, history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider store={createToastStore()}>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('calendar page', () => {
  it('renders the month grid with event bars toned by state', async () => {
    renderAt('/calendar');
    const severance = await screen.findByRole('button', { name: /^Severance, S02E09/ });
    expect(severance.getAttribute('data-tone')).toBe('downloaded');
    expect(screen.getByRole('button', { name: /^Andor, S02E03/ }).getAttribute('data-tone')).toBe('missing');
    expect(screen.getByRole('button', { name: /^Fallout, S01E04/ }).getAttribute('data-tone')).toBe('upcoming');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/2026/);
    expect(screen.getAllByRole('columnheader')).toHaveLength(7);
    expect(calls.some((u) => u.startsWith('/api/v1/calendar?'))).toBe(true);
  });

  it('opens the item popover with chip and actions; Search posts the episode', async () => {
    renderAt('/calendar');
    fireEvent.click(await screen.findByRole('button', { name: /^Andor, S02E03/ }));
    const pop = await screen.findByRole('dialog', { name: 'Andor S02E03' });
    expect(within(pop).getByText('Missing')).toBeTruthy();
    expect(within(pop).getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('/library/series/5');
    fireEvent.click(within(pop).getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(posts[0]).toEqual({ url: '/api/v1/command/search', body: { episodeIds: [2] } }));
  });

  it('switches to the agenda and week views', async () => {
    renderAt('/calendar');
    await screen.findByRole('button', { name: /^Severance, S02E09/ });
    fireEvent.click(screen.getByRole('button', { name: 'Agenda' }));
    expect(await screen.findByRole('region', { name: /October 6, 2026/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Week' }));
    expect(await screen.findByRole('grid', { name: 'Week' })).toBeTruthy();
    expect(screen.getAllByRole('columnheader')).toHaveLength(7);
    expect(screen.getByRole('button', { name: /^Andor, S02E03.*21:00/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Severance/ })).toBeNull();
  });

  it('steps the month with the arrow buttons', async () => {
    renderAt('/calendar');
    await screen.findByRole('button', { name: /^Severance, S02E09/ });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/November/));
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/October/));
  });

  it('shows the iCal URL in mono with a Copy button', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    renderAt('/calendar');
    fireEvent.click(await screen.findByRole('button', { name: 'iCal' }));
    const dialog = await screen.findByRole('dialog', { name: 'iCal feed' });
    const url = within(dialog).getByLabelText('Feed URL') as HTMLInputElement;
    await waitFor(() => expect(url.value).toContain('/api/v1/calendar/feed.ics?token=abc&pastDays=7&futureDays=28'));
    expect(url.className).toContain('al-input--mono');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Copied' })).toBeTruthy());
    expect(writeText).toHaveBeenCalledWith(url.value);
  });
});

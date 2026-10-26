import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { CalendarItem } from '@arclight/shared';
import { authRoutes, renderAt, stubApi, user } from '../../features/requests/test-utils.js';
import { makeEpisode } from '../library/test-fixtures.js';
import { monthGrid, weekdayLabels } from './calendar-math.js';

const at = (d: number, h: number) => new Date(2026, 9, d, h, 0).toISOString();
const items: CalendarItem[] = [
  { type: 'episode', date: at(14, 21), seriesId: 5, seriesTitle: 'Andor', episode: makeEpisode({ id: 2, seriesId: 5, seasonNumber: 2, episodeNumber: 3, airDateUtc: at(14, 21) }) },
];
const admin = (settings: Record<string, unknown> = {}) => user({ id: 1, username: 'root', role: 'admin', permissions: 2, settings });
const feed = { path: '/api/v1/calendar/feed.ics?token=old', token: 'old' };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 15, 12, 0));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('calendar preferences', () => {
  it('month grids start on the chosen weekday', () => {
    expect(monthGrid(new Date(2026, 9, 1), 0)[0]!.getDay()).toBe(0);
    expect(monthGrid(new Date(2026, 9, 1), 1)[0]!.getDay()).toBe(1);
    expect(weekdayLabels(0, 'en-US')[0]).toBe('Sun');
  });

  it('uses the user’s first day of week and 12-hour times', async () => {
    stubApi({ ...authRoutes(admin({ firstDayOfWeek: 0, timeFormat: '12h' })), '/api/v1/calendar': items, '/api/v1/calendar/feed': feed });
    renderAt('/calendar');
    expect(await screen.findByRole('button', { name: /^Andor, S02E03.*9:00 PM/ })).toBeTruthy();
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers[0]).toBe(new Date(2026, 9, 4).toLocaleDateString(undefined, { weekday: 'short' }));
    // October 2026 starts on a Thursday; a Sunday-first grid opens on 27 September.
    expect(screen.getAllByRole('gridcell')[0]!.getAttribute('aria-label')).toBe(new Date(2026, 8, 27).toLocaleDateString(undefined, { dateStyle: 'full' }));
  });

  it('defaults to Monday and 24-hour times', async () => {
    stubApi({ ...authRoutes(admin()), '/api/v1/calendar': items, '/api/v1/calendar/feed': feed });
    renderAt('/calendar');
    expect(await screen.findByRole('button', { name: /^Andor, S02E03.*21:00/ })).toBeTruthy();
    expect(screen.getAllByRole('gridcell')[0]!.getAttribute('aria-label')).toBe(new Date(2026, 8, 28).toLocaleDateString(undefined, { dateStyle: 'full' }));
  });

  it('regenerates the iCal URL after confirming and shows the new one', async () => {
    const calls = stubApi({ ...authRoutes(admin()), '/api/v1/calendar': items, '/api/v1/calendar/feed': feed }, (url, method) =>
      method === 'POST' && url === '/api/v1/calendar/feed/regenerate' ? { body: { path: '/api/v1/calendar/feed.ics?token=fresh', token: 'fresh' } } : undefined,
    );
    renderAt('/calendar');
    fireEvent.click(await screen.findByRole('button', { name: 'iCal' }));
    const dialog = await screen.findByRole('dialog', { name: 'iCal feed' });
    const url = within(dialog).getByLabelText('Feed URL') as HTMLInputElement;
    await waitFor(() => expect(url.value).toContain('token=old'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Regenerate' }));
    expect(within(dialog).getByText(/current URL stops working/)).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Regenerate URL' }));
    await waitFor(() => expect(url.value).toContain('token=fresh'));
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual(['/api/v1/calendar/feed/regenerate']);
    expect(within(dialog).getByRole('status').textContent).toMatch(/New feed URL ready/);
  });

  it('hides Regenerate from non-admins', async () => {
    stubApi({ ...authRoutes(user()), '/api/v1/calendar': items, '/api/v1/calendar/feed': feed });
    renderAt('/calendar');
    fireEvent.click(await screen.findByRole('button', { name: 'iCal' }));
    const dialog = await screen.findByRole('dialog', { name: 'iCal feed' });
    await waitFor(() => expect((within(dialog).getByLabelText('Feed URL') as HTMLInputElement).value).toContain('token=old'));
    expect(within(dialog).queryByRole('button', { name: 'Regenerate' })).toBeNull();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Permission, WatchStatsSettings, type LibraryGrowth, type PlaybackStats, type Wrapped, type WrappedShare } from '@arclight/shared';
import { renderAt, stubApi } from '../../test/route-harness.js';
import { authRoutes, user } from '../requests/test-utils.js';
import { attachmentName } from '../../api/watch-stats.js';
import { bucketRows, fillPlayDays, heatmapMax, hourLabel, playMethodRows, shareLink, watchTime } from './stats-model.js';

afterEach(() => vi.unstubAllGlobals());

const admin = authRoutes(user({ id: 1, username: 'admin', role: 'admin', permissions: Permission.ADMIN }));

const grid = () => Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));

const stats = (over: Partial<PlaybackStats> = {}): PlaybackStats => {
  const heatmap = grid();
  heatmap[5]![21] = 3;
  return {
    from: '2026-10-01T00:00:00.000Z',
    to: '2026-10-03T00:00:00.000Z',
    userId: null,
    totals: { plays: 4, watchMs: 5 * 3_600_000, titles: 2, users: 2, movies: 1, episodes: 3 },
    playMethods: { directPlay: 3, directStream: 0, transcode: 1, unknown: 0 },
    topMovies: [{ key: 'm1', mediaType: 'movie', title: 'Heat', year: 1995, movieId: 7, seriesId: null, tmdbId: 949, plays: 1, watchMs: 10_000_000, users: 1, lastPlayedAt: '2026-10-02T20:00:00.000Z' }],
    topSeries: [{ key: 's1', mediaType: 'series', title: 'Dark', year: 2017, movieId: null, seriesId: 3, tmdbId: 70523, plays: 3, watchMs: 8_000_000, users: 2, lastPlayedAt: '2026-10-03T20:00:00.000Z' }],
    topGenres: [{ name: 'Drama', plays: 4, watchMs: 18_000_000 }],
    clients: [{ name: 'Jellyfin Web', plays: 4, watchMs: 18_000_000 }],
    devices: [{ name: 'Living room TV', plays: 4, watchMs: 18_000_000 }],
    users: [
      { key: 'u1', arclightUserId: 2, name: 'Sam', plays: 3, watchMs: 12_000_000, lastPlayedAt: '2026-10-03T20:00:00.000Z' },
      { key: 'u2', arclightUserId: null, name: 'Guest', plays: 1, watchMs: 6_000_000, lastPlayedAt: null },
    ],
    perDay: [{ date: '2026-10-02', plays: 4, watchMs: 18_000_000 }],
    heatmap,
    ...over,
  };
};

const growth: LibraryGrowth = { snapshots: [], added: [{ month: '2026-10', movies: 2, series: 1, episodes: 9 }] };

const wrapped = (over: Partial<Wrapped> = {}): Wrapped => ({
  year: 2026,
  userId: 1,
  name: 'admin',
  plays: 40,
  watchMs: 60 * 3_600_000,
  movies: 10,
  episodes: 30,
  series: 4,
  activeDays: 22,
  topMovies: stats().topMovies,
  topSeries: stats().topSeries,
  topGenres: [{ name: 'Drama', plays: 20, watchMs: 1 }],
  topDevice: 'Living room TV',
  busiestMonth: 3,
  favouriteWeekday: 5,
  favouriteHour: 21,
  longestDay: { date: '2026-03-14', watchMs: 6 * 3_600_000 },
  firstPlay: { title: 'Heat', at: '2026-01-02T20:00:00.000Z' },
  monthly: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => m * 3_600_000),
  percentile: 80,
  years: [2026, 2025],
  ...over,
});

const share: WrappedShare = { id: 5, userId: 1, year: 2026, path: '/wrapped/abc', url: 'https://arclight.example.com/wrapped/abc', imagePath: '/wrapped/abc/image.svg', createdAt: '2026-10-01T00:00:00.000Z', expiresAt: '2026-10-15T00:00:00.000Z' };

describe('watch stats model', () => {
  it('formats time, shares, days and links', () => {
    expect(watchTime(42 * 60_000)).toBe('42 min');
    expect(watchTime(5.5 * 3_600_000)).toBe('5.5 h');
    expect(hourLabel(7)).toBe('07:00');
    expect(playMethodRows({ directPlay: 3, directStream: 0, transcode: 1, unknown: 0 }).map((r) => [r.key, r.pct])).toEqual([
      ['directPlay', 75],
      ['directStream', 0],
      ['transcode', 25],
    ]);
    expect(bucketRows([{ name: '', plays: 1, watchMs: 0 }, { name: 'Roku', plays: 3, watchMs: 0 }]).map((r) => r.label)).toEqual(['Roku', 'Unknown']);
    expect(fillPlayDays([{ date: '2026-10-02', plays: 4, watchMs: 1 }], '2026-10-01T00:00:00Z', '2026-10-03T00:00:00Z').map((d) => d.plays)).toEqual([0, 4, 0]);
    expect(heatmapMax(grid())).toBe(1);
    expect(shareLink({ url: null, path: '/wrapped/x' }, 'https://arclight.example.com')).toBe('https://arclight.example.com/wrapped/x');
    expect(attachmentName('attachment; filename="wrapped-2026.svg"', 'x.svg')).toBe('wrapped-2026.svg');
    expect(attachmentName(null, 'x.svg')).toBe('x.svg');
  });
});

describe('Activity → Playback stats', () => {
  it('shows totals, breakdowns, users and growth, and refetches for the picked period', async () => {
    const api = stubApi({
      '/api/v1/watchstats': (_init: RequestInit | undefined, url: URL) => stats({ from: url.searchParams.get('days') === '7' ? '2026-09-27T00:00:00.000Z' : '2026-10-01T00:00:00.000Z' }),
      '/api/v1/watchstats/growth': growth,
      ...admin,
      '/api/v1/user': [],
    });
    renderAt('/activity/playbackstats');
    const totals = await screen.findByRole('list', { name: 'Totals' });
    expect(within(totals).getByRole('listitem', { name: 'Plays' }).textContent).toContain('4');
    expect(within(totals).getByRole('listitem', { name: 'Plays' }).textContent).toContain('1 movies · 3 episodes');
    expect(within(screen.getByRole('region', { name: 'Play methods' })).getByText('Direct play')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Top movies' })).getByText('Heat (1995)')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Devices' })).getByText('Living room TV')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Most active users' })).getByText('Guest')).toBeTruthy();
    expect(await screen.findByText('Added per month')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Plays by weekday and hour, 3 in total' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/v1/watchstats' && c.method === 'GET')).toBe(true));
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some(([u]) => String(u).includes('days=7'))).toBe(true));
  });

  it('shows the Year in review with share links and creates one', async () => {
    let shares: WrappedShare[] = [];
    const api = stubApi({
      '/api/v1/watchstats': stats(),
      '/api/v1/watchstats/growth': growth,
      ...admin,
      '/api/v1/user': [],
      '/api/v1/watchstats/wrapped': wrapped(),
      '/api/v1/settings/watchstats': WatchStatsSettings.parse({}),
      '/api/v1/watchstats/wrapped/shares': () => shares,
      'POST /api/v1/watchstats/wrapped/shares': () => {
        shares = [share];
        return share;
      },
    });
    renderAt('/activity/playbackstats');
    fireEvent.click(await screen.findByRole('tab', { name: 'Year in review' }));
    expect(await screen.findByText('admin: 2026 in review')).toBeTruthy();
    const highlights = screen.getByRole('list', { name: 'Highlights' });
    expect(within(highlights).getByRole('listitem', { name: 'Days watching' }).textContent).toContain('22');
    expect(screen.getByText('More than 80% of users')).toBeTruthy();
    const pane = screen.getByRole('region', { name: 'Share links' });
    expect(await within(pane).findByText('No share links')).toBeTruthy();
    fireEvent.click(within(pane).getByRole('button', { name: 'Create share link' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/v1/watchstats/wrapped/shares')).toBe(true));
    expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({ year: 2026 });
    expect(((await within(pane).findByLabelText('Share link for 2026')) as HTMLInputElement).value).toBe(share.url);
  });

  it('hides creating links when share links are off', async () => {
    stubApi({
      '/api/v1/watchstats': stats(),
      '/api/v1/watchstats/growth': growth,
      ...admin,
      '/api/v1/user': [],
      '/api/v1/watchstats/wrapped': wrapped(),
      '/api/v1/settings/watchstats': WatchStatsSettings.parse({ wrapped: { shareLinks: false, shareLinkDays: 14 } }),
      '/api/v1/watchstats/wrapped/shares': [],
    });
    renderAt('/activity/playbackstats');
    fireEvent.click(await screen.findByRole('tab', { name: 'Year in review' }));
    const pane = await screen.findByRole('region', { name: 'Share links' });
    expect(await within(pane).findByText('Share links are turned off.')).toBeTruthy();
    expect(within(pane).queryByRole('button', { name: 'Create share link' })).toBeNull();
  });
});

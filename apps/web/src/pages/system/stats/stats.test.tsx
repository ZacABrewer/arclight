import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ActivityStats, LibraryStats, StorageStats } from '@arclight/shared';
import { renderAt, stubApi } from '../../../test/route-harness.js';
import { ActivityChart, BucketPane } from './stats-page.js';
import { activityMax, bucketShares, fillDays, formatDelta, groupedBars, rootUsage, seriesPath } from './stats-model.js';

afterEach(() => vi.unstubAllGlobals());

const TB = 1024 ** 4;
const GB = 1024 ** 3;

const storage: StorageStats = {
  totalUsedBytes: 3 * TB,
  totalFiles: 4200,
  rootFolders: [
    { path: '/media/tv', mediaType: 'series', accessible: true, totalBytes: 10 * TB, freeBytes: 0.5 * TB, usedByArclightBytes: 2 * TB, fileCount: 4000 },
    { path: '/media/movies', mediaType: 'movie', accessible: true, totalBytes: 8 * TB, freeBytes: 4 * TB, usedByArclightBytes: 1 * TB, fileCount: 200 },
  ],
  topSeries: [{ mediaType: 'series', id: 3, title: 'Severance', year: 2022, sizeBytes: 300 * GB, fileCount: 19 }],
  topMovies: [{ mediaType: 'movie', id: 8, title: 'Dune', year: 2021, sizeBytes: 80 * GB, fileCount: 1 }],
  byQuality: [
    { key: 'WEBDL-1080p', count: 3000, sizeBytes: 2 * TB },
    { key: 'Bluray-2160p', count: 100, sizeBytes: 1 * TB },
  ],
  byVideoCodec: [{ key: 'x265', count: 2000, sizeBytes: 2 * TB }],
  byResolution: [{ key: '1080p', count: 3000, sizeBytes: 2 * TB }],
  byDynamicRange: [],
  growth: {
    last30: { days: 30, fromBytes: Math.round(2.9 * TB), toBytes: 3 * TB, deltaBytes: Math.round(0.1 * TB) },
    last90: { days: 90, fromBytes: null, toBytes: 3 * TB, deltaBytes: null },
    points: [
      { date: '2026-10-24', usedBytes: Math.round(2.9 * TB), fileCount: 4100 },
      { date: '2026-10-25', usedBytes: 3 * TB, fileCount: 4200 },
    ],
  },
};

const library: LibraryStats = {
  series: { total: 40, monitored: 35, continuing: 12, ended: 28 },
  episodes: { total: 2000, downloaded: 1800, missing: 42, unaired: 30, unmonitored: 128, cutoffUnmet: 7 },
  movies: { total: 200, monitored: 180, downloaded: 170, missing: 10, cutoffUnmet: 3 },
  files: { total: 4200, sizeBytes: 3 * TB },
};

const activity: ActivityStats = {
  days: 3,
  since: '2026-10-24',
  totals: { grabbed: 5, imported: 4, failed: 1 },
  perDay: [
    { date: '2026-10-24', grabbed: 3, imported: 2, failed: 1 },
    { date: '2026-10-26', grabbed: 2, imported: 2, failed: 0 },
  ],
};

describe('stats model', () => {
  it('turns low free space orange and handles unknown volumes', () => {
    expect(rootUsage(storage.rootFolders[0]!)).toMatchObject({ tone: 'warn', text: '512.0 GiB free of 10.0 TiB' });
    expect(rootUsage(storage.rootFolders[0]!).usedPct).toBeCloseTo(95);
    expect(rootUsage(storage.rootFolders[1]!)).toMatchObject({ tone: 'default', usedPct: 50 });
    expect(rootUsage({ accessible: false, totalBytes: null, freeBytes: null })).toEqual({ usedPct: null, tone: 'warn', text: 'Not reachable' });
    expect(rootUsage({ accessible: true, totalBytes: null, freeBytes: null }).text).toBe('Volume size unknown');
  });

  it('sorts buckets by size with their share and drops empty ones', () => {
    const rows = bucketShares([
      { key: 'SD', count: 0, sizeBytes: 0 },
      { key: '720p', count: 10, sizeBytes: 25 },
      { key: '', count: 1, sizeBytes: 75 },
    ]);
    expect(rows.map((r) => [r.label, r.pct])).toEqual([
      ['Unknown', 75],
      ['720p', 25],
    ]);
  });

  it('fills missing days with zeros', () => {
    const days = fillDays(activity.perDay, activity.since, 3);
    expect(days.map((d) => d.date)).toEqual(['2026-10-24', '2026-10-25', '2026-10-26']);
    expect(days[1]).toEqual({ date: '2026-10-25', grabbed: 0, imported: 0, failed: 0 });
  });

  it('lays out grouped bars on one scale', () => {
    const days = fillDays(activity.perDay, activity.since, 3);
    expect(activityMax(days, ['grabbed', 'failed'])).toBe(3);
    const bars = groupedBars(days, ['grabbed', 'imported', 'failed'], 300, 100, 0);
    expect(bars).toHaveLength(9);
    expect(bars[0]).toMatchObject({ metric: 'grabbed', value: 3, x: 0, height: 100, y: 0 });
    expect(bars[0]!.width).toBeCloseTo(100 / 3);
    expect(bars[2]!.metric).toBe('failed');
    expect(bars[2]!.height).toBeCloseTo(100 / 3);
    expect(bars[3]).toMatchObject({ date: '2026-10-25', height: 0, x: 100 });
    expect(groupedBars([], ['grabbed'], 10, 10)).toEqual([]);
  });

  it('draws the growth path and formats deltas', () => {
    expect(seriesPath([1, 3], 100, 50)).toBe('M0 50 L100 0');
    expect(seriesPath([2, 2, 2], 100, 50)).toBe('M0 25 L50 25 L100 25');
    expect(seriesPath([], 10, 10)).toBe('');
    expect(formatDelta(null)).toBe('—');
    expect(formatDelta(0)).toBe('No change');
    expect(formatDelta(2 * GB)).toBe('+2.0 GiB');
    expect(formatDelta(-GB)).toBe('−1.0 GiB');
  });
});

describe('stats charts', () => {
  it('labels the activity chart and skips zero bars', () => {
    const { container } = render(<ActivityChart stats={activity} />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Activity over 3 days: 5 grabbed, 4 imported, 1 failed');
    expect(container.querySelectorAll('rect[data-metric]').length).toBe(5);
    expect(container.querySelector('rect[data-metric="failed"]')?.getAttribute('stroke')).toBe('var(--al-danger)');
    // Rule: fills at most 12%.
    for (const r of container.querySelectorAll('rect[data-metric]')) expect(Number(r.getAttribute('fill-opacity'))).toBeLessThanOrEqual(0.12);
  });

  it('renders bucket meters with mono size and count', () => {
    render(<BucketPane title="By quality" buckets={storage.byQuality} />);
    const pane = screen.getByRole('region', { name: 'By quality' });
    expect(within(pane).getByText('WEBDL-1080p')).toBeTruthy();
    expect(within(pane).getByText('2.0 TiB · 3000')).toBeTruthy();
    expect(within(pane).getAllByRole('progressbar')[0]!.getAttribute('aria-valuenow')).toBe('67');
  });
});

describe('System → Stats', () => {
  it('shows storage, library counts, activity, breakdowns and top items', async () => {
    stubApi({
      '/api/v1/stats/storage': storage,
      '/api/v1/stats/library': library,
      '/api/v1/stats/activity': activity,
    });
    renderAt('/system/stats');
    const storagePane = await screen.findByRole('region', { name: 'Storage' });
    expect(within(storagePane).getByText('/media/tv')).toBeTruthy();
    expect(within(storagePane).getByText('512.0 GiB free of 10.0 TiB').getAttribute('data-tone')).toBe('warn');
    expect(within(storagePane).getByText('+102.4 GiB')).toBeTruthy();

    const lib = await screen.findByRole('region', { name: 'Library counts' });
    expect(within(lib).getByText('1800 / 2000')).toBeTruthy();

    expect(await screen.findByRole('img', { name: /Activity over 3 days/ })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Library size' })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'By dynamic range' })).getByText('No files yet.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Severance' }).getAttribute('href')).toBe('/library/series/3');
    expect(screen.getByRole('link', { name: 'Dune' }).getAttribute('href')).toBe('/library/movie/8');
    expect(screen.getByRole('link', { name: 'Indexer stats' }).getAttribute('href')).toBe('/indexers/stats');
  });

  it('shows an error per pane when a stats call fails', async () => {
    stubApi({ '/api/v1/stats/library': library, '/api/v1/stats/activity': activity });
    renderAt('/system/stats');
    expect(await screen.findByText("Couldn't load storage")).toBeTruthy();
    expect(await screen.findByRole('region', { name: 'Library counts' })).toBeTruthy();
  });
});

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AutomaticSearchPlan, ItemSearchStatus, QueueSummaryItem } from '@arclight/shared';
import {
  aggregateChip,
  buildQueueIndex,
  groupSearchText,
  lastSearchText,
  nextSearchText,
  QueueStateChip,
  replacementText,
  SearchStatusLines,
  summaryChip,
} from './pipeline-status.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-27T12:00:00.000Z');

const item = (over: Partial<QueueSummaryItem> = {}): QueueSummaryItem => ({
  id: 1,
  mediaType: 'series',
  seriesId: 5,
  episodeIds: [51],
  trackedState: 'downloading',
  trackedStatus: 'ok',
  status: 'downloading',
  progress: 0.42,
  ...over,
});

const plan = (over: Partial<AutomaticSearchPlan> = {}): AutomaticSearchPlan => ({
  state: 'scheduled',
  job: 'MissingEpisodeSearch',
  nextSearchAt: new Date(NOW + 5 * HOUR).toISOString(),
  searchCount: 1,
  runsAhead: 0,
  ...over,
});

const status = (over: Partial<ItemSearchStatus> = {}): ItemSearchStatus => ({
  mediaType: 'episode',
  id: 51,
  monitored: true,
  lastSearch: { time: new Date(NOW - 3 * HOUR).toISOString(), source: 'automatic', outcome: 'noResults', releases: 0, approved: 0, detail: null },
  automatic: plan(),
  ...over,
});

describe('queue state chips', () => {
  it('maps a download to the library vocabulary', () => {
    expect(summaryChip(item())).toEqual({ status: 'downloading', label: 'Downloading 42%' });
    expect(summaryChip(item({ trackedState: 'pending', status: 'queued' })).status).toBe('queued');
    expect(summaryChip(item({ trackedState: 'importing', status: 'completed', progress: 1 })).status).toBe('importing');
    expect(summaryChip(item({ trackedState: 'failedPending', trackedStatus: 'error' }))).toMatchObject({ status: 'failed' });
    expect(summaryChip(item({ stateCode: 'noPeers' }))).toMatchObject({ status: 'stalled', cause: 'no peers' });
    expect(summaryChip(item({ stateCode: 'killSwitch' })).status).toBe('paused');
  });

  it('sums up a series: the state that needs attention first, with the count', () => {
    const chip = aggregateChip([item(), item({ id: 2, episodeIds: [52], trackedStatus: 'error', trackedState: 'failedPending' })]);
    expect(chip?.status).toBe('failed');
    expect(chip?.label).toMatch(/· 2 in queue$/);
    expect(aggregateChip([])).toBeNull();
  });

  it('indexes downloads by movie, episode and series', () => {
    const index = buildQueueIndex([item(), item({ id: 3, mediaType: 'movie', seriesId: undefined, episodeIds: undefined, movieId: 9 })]);
    expect(index.episodes.get(51)?.id).toBe(1);
    expect(index.movies.get(9)?.id).toBe(3);
    expect(index.series.get(5)).toHaveLength(1);
  });

  it('renders nothing for an item that is not in the queue', () => {
    const { container } = render(<QueueStateChip items={[]} />);
    expect(container.textContent).toBe('');
    render(<QueueStateChip item={item()} />);
    expect(screen.getByTestId('queue-state').textContent).toBe('Downloading 42%');
  });
});

describe('search status lines', () => {
  it('says when an item was last searched and what came of it', () => {
    expect(lastSearchText(null, NOW)).toBe('Not searched yet');
    expect(lastSearchText(status().lastSearch, NOW)).toBe('Last searched 3h ago · nothing found');
    const rejected = { ...status().lastSearch!, outcome: 'rejected' as const, releases: 4, detail: 'Quality not wanted' };
    expect(lastSearchText(rejected, NOW)).toBe('Last searched 3h ago · all results rejected: Quality not wanted');
  });

  it('says when the next automatic search comes, or why there is none', () => {
    expect(nextSearchText(plan(), NOW)).toBe('Next automatic search ~in 5h');
    expect(nextSearchText(plan({ runsAhead: 2, nextSearchAt: new Date(NOW + 2 * 24 * HOUR).toISOString() }), NOW)).toBe(
      'Next automatic search ~in 2d (waits 2 runs for the per-run limit)',
    );
    expect(nextSearchText(plan({ nextSearchAt: null }), NOW)).toBe('Next automatic search: not within two weeks');
    expect(nextSearchText(plan({ state: 'unmonitored', job: null, nextSearchAt: null }), NOW)).toBe('Not monitored: never searched automatically');
    expect(nextSearchText(plan({ state: 'jobDisabled', nextSearchAt: null }), NOW)).toBe('MissingEpisodeSearch is switched off: no automatic search');
  });

  it('sums up a season by its soonest search', () => {
    const later = status({ id: 52, automatic: plan({ nextSearchAt: new Date(NOW + 30 * HOUR).toISOString() }) });
    expect(groupSearchText([later, status()], NOW)).toBe('2 missing episodes · Next automatic search ~in 5h');
    expect(groupSearchText([], NOW)).toBeNull();
  });

  it('renders both lines', () => {
    render(<SearchStatusLines status={status({ lastSearch: null })} />);
    const lines = screen.getByTestId('search-status');
    expect(lines.textContent).toContain('Not searched yet');
    expect(lines.textContent).toContain('Next automatic search');
  });
});

describe('profile mismatch replacement', () => {
  it('says whether and when a file will be replaced', () => {
    const scheduled = { replacement: { state: 'scheduled' as const, nextSearchAt: new Date(NOW + HOUR).toISOString(), maxAttempts: 3 }, migration: null };
    expect(replacementText(scheduled, NOW)).toBe('Will be replaced: next search ~in 1h');
    expect(replacementText({ replacement: { state: 'noRule', nextSearchAt: null, maxAttempts: 3 }, migration: null }, NOW)).toBe("Kept: the profile's rule is to do nothing");
    expect(
      replacementText(
        { replacement: { state: 'failed', nextSearchAt: null, maxAttempts: 3 }, migration: { state: 'failed', attempts: 3, lastSearchedAt: null, message: null } },
        NOW,
      ),
    ).toBe('Not replaced: no fitting release after 3 searches');
    expect(replacementText({ migration: null }, NOW)).toBe('—');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { DecisionLogPage } from '@arclight/shared';
import { DecisionLogPage as DecisionLogPageSchema } from '@arclight/shared';
import type { HistoryRecord } from '../../../api/history.js';
import { ToastProvider } from '../../../components/toast.js';
import { createToastStore } from '../../../lib/toast.js';
import { createQueryClient } from '../../../query-client.js';
import { renderAt, stubApi, type FakeApi } from '../../../test/route-harness.js';
import { HistoryDetails, decisionBatchIdOf } from '../../activity/history-page.js';
import { makeEpisode, makeMovie, makeSeries } from '../test-fixtures.js';
import { makeBatch, makeDecision } from './fixtures.js';

configure({ asyncUtilTimeout: 4000 });

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

const show = makeSeries({ id: 1, title: 'Severance', seasons: [{ seasonNumber: 1, monitored: true }] });
const film = makeMovie({ id: 7, title: 'Dune: Part Two', hasFile: false, isAvailable: true });

function page(over: Partial<DecisionLogPage> = {}): DecisionLogPage {
  return DecisionLogPageSchema.parse({ page: 1, pageSize: 10, totalRecords: 1, records: [makeBatch()], ...over });
}

function baseRoutes(decisions: unknown) {
  return {
    '/api/v1/series/1': show,
    '/api/v1/episode': [makeEpisode({ id: 12, title: 'Half Loop', airDate: '2022-02-25' })],
    '/api/v1/mediafile': [],
    '/api/v1/movie/7': film,
    '/api/v1/tag': [],
    '/api/v1/qualityprofile': [],
    '/api/v1/rootfolder': [],
    '/api/v1/release/decisions': decisions,
  };
}

const decisionCalls = (api: FakeApi) => api.calls.filter((c) => c.path === '/api/v1/release/decisions');

async function openTab(name: string) {
  fireEvent.click(await screen.findByRole('tab', { name }));
}

describe('Decisions tab', () => {
  it('shows batches with the grabbed row highlighted, rejection chips and a History link', async () => {
    let lastUrl: URL | undefined;
    stubApi(
      baseRoutes((_init: RequestInit | undefined, url: URL) => {
        lastUrl = url;
        return page();
      }),
    );
    renderAt('/library/series/1');
    await openTab('Decisions');
    const batch = await screen.findByRole('region', { name: /^Search at / });
    expect(lastUrl?.searchParams.get('seriesId')).toBe('1');
    expect(lastUrl?.searchParams.get('page')).toBe('1');
    expect(within(batch).getByText('3 releases · 2 approved · 1 rejected')).toBeTruthy();

    const rows = within(within(batch).getByRole('list', { name: 'Releases judged' })).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]?.getAttribute('data-state')).toBe('grabbed');
    expect(rows[0]?.getAttribute('aria-current')).toBe('true');
    expect(within(rows[0]!).getByText('x265')).toBeTruthy();
    expect(rows[2]?.getAttribute('data-state')).toBe('rejected');
    expect(within(rows[2]!).getByRole('button', { name: 'Rejected: CAM is not wanted in profile (Permanent)' })).toBeTruthy();
    expect(within(rows[2]!).getByRole('button', { name: /Waiting for the delay profile/ })).toBeTruthy();

    // The single grabbed episode narrows the History link.
    const link = within(batch).getByRole('link', { name: 'View grab in History' });
    expect(link.getAttribute('href')).toBe('/activity/history?eventType=grabbed&episodeId=12');
  });

  it('highlights the best approved row when nothing was grabbed and pages through batches', async () => {
    const pages: string[] = [];
    const api = stubApi(
      baseRoutes((_init: RequestInit | undefined, url: URL) => {
        pages.push(`${url.searchParams.get('movieId')}:${url.searchParams.get('page')}`);
        return page({
          page: Number(url.searchParams.get('page')),
          totalRecords: 12,
          records: [
            makeBatch({
              batchId: `b-${url.searchParams.get('page')}`,
              source: 'rss',
              grabbed: false,
              winnerId: 2,
              decisions: [makeDecision({ id: 2, rank: 1 }), makeDecision({ id: 5, rank: 2 })],
            }),
          ],
        });
      }),
    );
    renderAt('/library/movie/7');
    await openTab('Decisions');
    const batch = await screen.findByRole('region', { name: /^RSS sync at / });
    expect(within(batch).getByText('Nothing grabbed')).toBeTruthy();
    expect(within(batch).queryByRole('link', { name: 'View grab in History' })).toBeNull();
    const rows = within(batch).getAllByRole('listitem');
    expect(rows[0]?.getAttribute('data-state')).toBe('winner');
    expect(within(rows[0]!).getByText('Best match')).toBeTruthy();
    expect(decisionCalls(api).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(pages).toContain('7:2'));
    expect(pages[0]).toBe('7:1');
  });

  it('shows an empty state when nothing was logged', async () => {
    stubApi(baseRoutes(page({ totalRecords: 0, records: [] })));
    renderAt('/library/series/1');
    await openTab('Decisions');
    expect(await screen.findByText('No decisions logged yet')).toBeTruthy();
  });
});

describe('Decisions in the episode drawer', () => {
  it('lists the episode decisions (episodeId, 5 per page)', async () => {
    let lastUrl: URL | undefined;
    stubApi(
      baseRoutes((_init: RequestInit | undefined, url: URL) => {
        lastUrl = url;
        return page();
      }),
    );
    renderAt('/library/series/1');
    fireEvent.click(await screen.findByRole('button', { name: 'Half Loop' }));
    const drawer = await screen.findByRole('dialog');
    const section = within(drawer).getByRole('region', { name: 'Decisions' });
    expect(await within(section).findByText('Show.S01E02.CAM-BAD')).toBeTruthy();
    expect(lastUrl?.searchParams.get('episodeId')).toBe('12');
    expect(lastUrl?.searchParams.get('pageSize')).toBe('5');
  });
});

describe('History deep link', () => {
  it('filters GET /history to the linked item and event type', async () => {
    const api = stubApi({ '/api/v1/history': { page: 1, pageSize: 25, totalRecords: 0, records: [] } });
    renderAt('/activity/history?eventType=grabbed&episodeId=12');
    expect(await screen.findByText('One item only')).toBeTruthy();
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/v1/history')).toBe(true));
    const url = (vi.mocked(fetch).mock.calls.map((c) => String(c[0])).find((u) => u.startsWith('/api/v1/history?')) ?? '');
    const q = new URL(url, 'http://x').searchParams;
    expect(q.get('episodeId')).toBe('12');
    expect(q.get('eventType')).toBe('grabbed');
  });
});

describe('History → Why this release', () => {
  const record: HistoryRecord = {
    id: 9,
    eventType: 'grabbed',
    sourceTitle: 'Show.S01E02.1080p.WEB-DL-WINNER',
    date: '2026-10-25T10:00:00.000Z',
    episodeId: 12,
    data: { indexer: 'Nyaa', decisionBatchId: 'b-42' },
  };

  function renderDrawer(r: HistoryRecord) {
    const toasts = createToastStore();
    render(
      <QueryClientProvider client={createQueryClient(toasts)}>
        <ToastProvider store={toasts}>
          <HistoryDetails record={r} onClose={() => {}} />
        </ToastProvider>
      </QueryClientProvider>,
    );
  }

  it('reads the batch id from the record data', () => {
    expect(decisionBatchIdOf(record)).toBe('b-42');
    expect(decisionBatchIdOf({ data: {} })).toBeNull();
    expect(decisionBatchIdOf({ data: null })).toBeNull();
  });

  it('opens the whole batch from GET /release/decisions/:batchId', async () => {
    const api = stubApi({ '/api/v1/release/decisions/b-42': makeBatch({ batchId: 'b-42', source: 'interactive' }) });
    renderDrawer(record);
    fireEvent.click(screen.getByRole('button', { name: 'Why this release' }));
    const dialog = await screen.findByRole('dialog', { name: 'Why this release' });
    expect(await within(dialog).findByText('Show.S01E02.1080p.WEB-DL-WINNER')).toBeTruthy();
    expect(within(dialog).getByText('Interactive search')).toBeTruthy();
    expect(api.calls.some((c) => c.path === '/api/v1/release/decisions/b-42')).toBe(true);
  });

  it('has no "Why this release" without a batch id', () => {
    stubApi({});
    renderDrawer({ ...record, data: { indexer: 'Nyaa' } });
    expect(screen.queryByRole('button', { name: 'Why this release' })).toBeNull();
  });
});

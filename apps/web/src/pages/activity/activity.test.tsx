import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { QUALITIES, matchesListSearch, type QueueItem } from '@arclight/shared';
import { DEFAULT_HISTORY_FILTER, historyQuery, type HistoryFilter, type HistoryRecord } from '../../api/history.js';
import { Trail } from '../../arclight/index.js';
import { ToastProvider } from '../../components/toast.js';
import { createToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { formatEta } from './activity-shared.js';
import { HistoryDetails, HistoryFilterBar, redownloadTarget, toggleEventType } from './history-page.js';
import { DelayCountdown, formatDelay } from './pending-page.js';
import { QueueChipCell, RemoveQueueDialog, queueSearchFields } from './queue-page.js';
import { initialRemoveState, removeReducer, toRemoveOptions } from './queue-remove.js';
import { causeFromMessage, qualityFromTitle, queueChip, queueTrailState, trailState } from './queue-status.js';
import { renderAt, stubApi } from '../../test/route-harness.js';

const item = (over: Partial<QueueItem> = {}): QueueItem => ({
  id: 1,
  downloadId: 'abc123',
  downloadClientId: 1,
  downloadClientName: 'qBit',
  title: 'Show.S01E01.1080p.WEB-DL',
  status: 'downloading',
  trackedStatus: 'ok',
  statusMessages: [],
  protocol: 'torrent',
  sizeBytes: 1000,
  sizeLeftBytes: 500,
  progress: 0.5,
  added: '2026-10-25T10:00:00.000Z',
  trackedState: 'downloading',
  ...over,
});

const msg = (title: string, ...messages: string[]) => [{ title, messages }];

afterEach(() => vi.unstubAllGlobals());

describe('queue chip', () => {
  it('labels failed rows with their cause', () => {
    const sample = item({ trackedState: 'failedPending', trackedStatus: 'error', statusMessages: msg('Show.S01E01.mkv', 'Sample file') });
    expect(queueChip(sample)).toMatchObject({ status: 'failed', cause: 'sample only' });
    render(<QueueChipCell item={sample} />);
    expect(screen.getByText('Failed · sample only')).toBeTruthy();
    // A failure without messages still says why.
    expect(queueChip(item({ status: 'failed', trackedStatus: 'error' }))).toMatchObject({ status: 'failed', cause: 'client error' });
    expect(queueChip(item({ trackedState: 'failedPending', trackedStatus: 'error' }))).toMatchObject({ status: 'failed', cause: 'import failed' });
  });

  it('queue search matches the status chip ("stalled", "no peers") as well as the row text', () => {
    const stalled = item({ trackedStatus: 'warning', statusMessages: msg('Download', 'No connected peers.') });
    const fields = queueSearchFields(stalled, undefined, []);
    expect(matchesListSearch('stalled', fields)).toBe(true);
    expect(matchesListSearch('no peers', fields)).toBe(true);
    expect(matchesListSearch('stalled', queueSearchFields(item({}), undefined, []))).toBe(false);
  });

  it('labels stalled downloads and blocked imports with their cause', () => {
    const stalled = item({ trackedStatus: 'warning', statusMessages: msg('Download', 'No connected peers.') });
    expect(queueChip(stalled)).toMatchObject({ status: 'stalled', cause: 'no peers' });
    render(<QueueChipCell item={stalled} />);
    expect(screen.getByText('Stalled · no peers')).toBeTruthy();
    expect(queueChip(item({ status: 'warning' }))).toMatchObject({ status: 'stalled', cause: 'no peers' });
    const blocked = item({ trackedState: 'importPending', trackedStatus: 'warning', progress: 1, statusMessages: msg('Import', 'Unknown Series') });
    expect(queueChip(blocked)).toMatchObject({ status: 'stalled', cause: 'unknown series' });
    expect(queueChip(item({ trackedState: 'importPending', trackedStatus: 'warning' }))).toMatchObject({ status: 'stalled', cause: 'import blocked' });
  });

  it('uses the plain vocabulary for healthy rows', () => {
    expect(queueChip(item()).status).toBe('downloading');
    expect(queueChip(item({ status: 'queued' })).status).toBe('queued');
    expect(queueChip(item({ status: 'paused' })).status).toBe('paused');
    expect(queueChip(item({ trackedState: 'importing', status: 'completed', progress: 1 })).status).toBe('importing');
    expect(queueChip(item({ status: 'seeding', progress: 1 })).status).toBe('importing');
    expect(queueChip(item({ trackedState: 'pending', downloadClientId: null, downloadId: 'pending:3' })).status).toBe('queued');
    expect(queueChip(item()).cause).toBeUndefined();
  });

  it('shortens unknown messages into a sentence-case cause', () => {
    expect(causeFromMessage('Destination folder is read-only.')).toBe('destination folder is read-only');
    expect(causeFromMessage('VPN tunnel is down')).toBe('VPN tunnel is down');
    expect(causeFromMessage('x'.repeat(80))!.length).toBeLessThanOrEqual(48);
    expect(causeFromMessage('   ')).toBeUndefined();
  });

  it('reads the quality from the release title', () => {
    expect(qualityFromTitle('Show.S01E01.1080p.WEB-DL.x264-GRP')).toBe('1080p WEB-DL');
    expect(qualityFromTitle('Movie.2021.2160p.BluRay.REMUX')).toBe('2160p Remux');
    expect(qualityFromTitle('Some.Release')).toBeNull();
  });
});

describe('trail state', () => {
  it('matches the chip: only a live download glows', () => {
    expect(trailState('downloading')).toBe('active');
    expect(trailState('queued')).toBe('queued');
    expect(trailState('paused')).toBe('paused');
    expect(trailState('stalled')).toBe('stalled');
    expect(trailState('failed')).toBe('failed');
    expect(trailState('importing')).toBe('complete');
    expect(trailState('downloaded')).toBe('complete');
    expect(trailState(queueChip(item({ trackedStatus: 'warning' })))).toBe('stalled');
  });

  it('never shows an active (flowing) trail while the item is held', () => {
    expect(queueTrailState(item())).toBe('active');
    expect(queueTrailState(item({ stateCode: 'downloading' }))).toBe('active');
    expect(queueTrailState(item({ stateCode: 'killSwitch' }))).toBe('paused');
    expect(queueTrailState(item({ stateCode: 'diskSpace' }))).toBe('stalled');
    expect(queueTrailState(item({ stateCode: 'noPeers' }))).toBe('stalled');
    expect(queueTrailState(item({ stateCode: 'paused' }))).toBe('paused');
    expect(queueTrailState(item({ stateCode: 'error' }))).toBe('failed');
    // A held code never upgrades a trail that is already flat.
    expect(queueTrailState(item({ status: 'paused', stateCode: 'downloading' }))).toBe('paused');
    expect(queueTrailState(item({ trackedStatus: 'warning', stateCode: 'killSwitch' }))).toBe('stalled');
  });

  it('renders the trail with the mapped state and a mono percentage', () => {
    const { container } = render(<Trail value={42} state={trailState(queueChip(item({ trackedStatus: 'error', status: 'failed' })))} showValue />);
    expect(container.querySelector('.al-trail')!.getAttribute('data-state')).toBe('failed');
    expect(container.querySelector('.al-trail-row__pct')!.textContent).toBe('42%');
  });
});

describe('queue remove dialog', () => {
  it('defaults to removing from the client without blocklisting', () => {
    expect(initialRemoveState([item()])).toEqual({ clientAvailable: true, removeFromClient: true, blocklist: false, skipRedownload: false });
  });

  it('cannot remove from a client when nothing has been sent yet', () => {
    const s = initialRemoveState([item({ downloadClientId: null, downloadId: 'pending:7' })]);
    expect(s.clientAvailable).toBe(false);
    expect(s.removeFromClient).toBe(false);
    expect(removeReducer(s, { type: 'removeFromClient', value: true }).removeFromClient).toBe(false);
  });

  it('only allows skipping the redownload while blocklisting, and clears it when blocklist is turned off', () => {
    let s = initialRemoveState([item()]);
    s = removeReducer(s, { type: 'skipRedownload', value: true });
    expect(s.skipRedownload).toBe(false);
    s = removeReducer(s, { type: 'blocklist', value: true });
    s = removeReducer(s, { type: 'skipRedownload', value: true });
    expect(toRemoveOptions(s)).toEqual({ removeFromClient: true, blocklist: true, skipRedownload: true });
    s = removeReducer(s, { type: 'blocklist', value: false });
    expect(toRemoveOptions(s)).toEqual({ removeFromClient: true, blocklist: false, skipRedownload: false });
  });

  it('shows the three checkboxes and sends the chosen flags', () => {
    const onConfirm = vi.fn();
    render(<RemoveQueueDialog items={[item(), item({ id: 2 })]} onClose={() => {}} onConfirm={onConfirm} />);
    const dialog = screen.getByRole('dialog', { name: 'Remove 2 items?' });
    const client = within(dialog).getByRole('checkbox', { name: /^Remove from client/ }) as HTMLInputElement;
    const blocklist = within(dialog).getByRole('checkbox', { name: /^Add to blocklist/ }) as HTMLInputElement;
    const skip = within(dialog).getByRole('checkbox', { name: /^Skip redownload/ }) as HTMLInputElement;
    expect(client.checked).toBe(true);
    expect(skip.disabled).toBe(true);
    fireEvent.click(blocklist);
    expect(skip.disabled).toBe(false);
    fireEvent.click(skip);
    fireEvent.click(client);
    const confirm = within(dialog).getByRole('button', { name: 'Remove 2 items' });
    expect(confirm.className).toContain('al-btn--danger');
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith({ removeFromClient: false, blocklist: true, skipRedownload: true });
  });

  it('names a single item in the title', () => {
    render(<RemoveQueueDialog items={[item()]} onClose={() => {}} onConfirm={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Remove Show.S01E01.1080p.WEB-DL?' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove 1 item' })).toBeTruthy();
  });
});

describe('history filter', () => {
  it('builds the query string with comma-separated event types', () => {
    expect(historyQuery(DEFAULT_HISTORY_FILTER)).toEqual({ page: 1, pageSize: 25, sortKey: 'date', sortDirection: 'desc' });
    expect(historyQuery({ ...DEFAULT_HISTORY_FILTER, eventTypes: ['grabbed', 'downloadFailed'] }).eventType).toBe('grabbed,downloadFailed');
  });

  it('toggles an event type and resets to page 1', () => {
    const f: HistoryFilter = { ...DEFAULT_HISTORY_FILTER, page: 4 };
    const on = toggleEventType(f, 'downloadFolderImported');
    expect(on).toMatchObject({ page: 1, eventTypes: ['downloadFolderImported'] });
    expect(toggleEventType(on, 'downloadFolderImported').eventTypes).toEqual([]);
  });

  it('drives the filter from the filter bar and clears it', () => {
    const onChange = vi.fn();
    function Harness() {
      const [filter, setFilter] = useState<HistoryFilter>({ ...DEFAULT_HISTORY_FILTER, page: 3 });
      return (
        <HistoryFilterBar
          filter={filter}
          onChange={(f) => {
            setFilter(f);
            onChange(f);
          }}
        />
      );
    }
    render(<Harness />);
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Event type' }), { target: { value: 'downloadFailed' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, eventTypes: ['downloadFailed'] }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Order' }), { target: { value: 'asc' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ sortDirection: 'asc', eventTypes: ['downloadFailed'] }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ eventTypes: [], sortDirection: 'desc', page: 1 }));
  });
});

describe('history details drawer', () => {
  const record: HistoryRecord = {
    id: 9,
    eventType: 'grabbed',
    sourceTitle: 'Show.S01E02.1080p.WEB-DL-GRP',
    date: '2026-10-25T10:00:00.000Z',
    downloadId: 'HASH9',
    episodeId: 42,
    quality: { quality: { name: 'WEBDL-1080p' } },
  };

  const job = { id: 31, name: 'EpisodeSearch', status: 'queued', trigger: 'manual', message: null, queuedAt: '2026-10-25T10:00:00.000Z', startedAt: null, endedAt: null, durationMs: null };

  function stubHistoryFetch() {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({ url: String(input), method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (method === 'POST' && String(input).endsWith('/redownload')) return new Response(JSON.stringify(job), { status: 202 });
        if (method === 'POST' && String(input).includes('/history/failed/')) return new Response(JSON.stringify([]), { status: 200 });
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      }),
    );
    return calls;
  }

  function renderDrawer(r: HistoryRecord, onClose: () => void = () => {}) {
    const store = createToastStore();
    render(
      <QueryClientProvider client={createQueryClient(store)}>
        <ToastProvider store={store}>
          <HistoryDetails record={r} onClose={onClose} />
        </ToastProvider>
      </QueryClientProvider>,
    );
  }

  it('offers Mark failed (danger) and Redownload (secondary); Redownload posts to the history route', async () => {
    const calls = stubHistoryFetch();
    renderDrawer(record);
    const drawer = screen.getByRole('dialog', { name: 'Grabbed' });
    expect(within(drawer).getByText('HASH9')).toBeTruthy();
    const markFailed = within(drawer).getByRole('button', { name: 'Mark failed' });
    const redownload = within(drawer).getByRole('button', { name: 'Redownload' });
    expect(markFailed.className).toContain('al-btn--danger');
    expect(redownload.className).toContain('al-btn--secondary');
    fireEvent.click(redownload);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/v1/history/9/redownload')).toBe(true));
    expect(await screen.findByText('Search started')).toBeTruthy();
    fireEvent.click(markFailed);
    expect(screen.getByRole('dialog', { name: 'Mark Show.S01E02.1080p.WEB-DL-GRP as failed?' })).toBeTruthy();
  });

  it('Mark failed confirms, posts to /history/failed/:id and closes', async () => {
    const calls = stubHistoryFetch();
    const onClose = vi.fn();
    renderDrawer(record, onClose);
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Grabbed' })).getByRole('button', { name: 'Mark failed' }));
    const confirm = screen.getByRole('dialog', { name: 'Mark Show.S01E02.1080p.WEB-DL-GRP as failed?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Mark failed' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const post = calls.find((c) => c.method === 'POST' && c.url === '/api/v1/history/failed/9');
    expect(post?.body).toEqual({ skipRedownload: false });
    expect(await screen.findByText('Marked as failed')).toBeTruthy();
  });

  it('disables actions that do not apply', () => {
    expect(redownloadTarget({ ...record, episodeId: null, movieId: 5 })).toEqual({ movieId: 5 });
    expect(redownloadTarget({ ...record, episodeId: null })).toBeNull();
    render(
      <QueryClientProvider client={createQueryClient()}>
        <HistoryDetails record={{ ...record, eventType: 'downloadFolderImported', episodeId: null }} onClose={() => {}} />
      </QueryClientProvider>,
    );
    expect((screen.getByRole('button', { name: 'Mark failed' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Redownload' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('pending countdown', () => {
  const now = Date.parse('2026-10-25T10:00:00Z');

  it('formats the delay compactly', () => {
    expect(formatDelay('2026-10-28T17:30:00Z', now)).toBe('3d 7h');
    expect(formatDelay('2026-10-25T10:42:10Z', now)).toBe('00:42:10');
    expect(formatDelay('2026-10-25T09:00:00Z', now)).toBe('due');
  });

  it('renders the countdown in mono', () => {
    render(<DelayCountdown eligibleAt="2026-10-25T10:42:10Z" now={now} />);
    const el = screen.getByText('00:42:10');
    expect(el.tagName).toBe('TIME');
    expect(el.className).toContain('al-num');
  });
});

describe('formatEta', () => {
  it('formats milliseconds as h:mm:ss', () => {
    expect(formatEta(3_725_000)).toBe('1:02:05');
    expect(formatEta(undefined)).toBe('—');
  });
});

// ---------------------------------------------------------------------------------------
// List search (Queue, History, Pending) over the stubbed api
// ---------------------------------------------------------------------------------------

const searchCount = () => document.querySelector('.al-listsearch__count')?.textContent ?? undefined;
const searchBox = () => screen.findByRole('searchbox', { name: 'Search this list' }, { timeout: 5000 });

describe('queue search', () => {
  const rows = [
    item({ id: 1, title: 'Show.S01E01.1080p.WEB-DL', downloadClientName: 'qBit' }),
    item({ id: 2, title: 'Heat.1995.2160p.BluRay', downloadClientName: 'SABnzbd', protocol: 'usenet' }),
    item({ id: 3, title: 'Other.S02E05.720p', downloadClientName: 'qBit', trackedStatus: 'warning', statusMessages: msg('Import', 'Sample file detected') }),
  ];
  const queueUrls: URL[] = [];

  function stubQueue() {
    queueUrls.length = 0;
    return stubApi({
      '/api/v1/queue': (_init: RequestInit | undefined, url: URL) => {
        queueUrls.push(url);
        return { page: 1, pageSize: Number(url.searchParams.get('pageSize')), sortKey: 'added', sortDirection: 'desc', totalRecords: rows.length, records: rows };
      },
      '/api/v1/queue/status': { totalCount: 3, errors: 0, warnings: 1, unknownCount: 0 },
      '/api/v1/downloadclient': [],
      '/api/v1/series': [],
      '/api/v1/movie': [],
    });
  }

  it('filters by release name, client and status message, shows "N of M" and clears', async () => {
    stubQueue();
    renderAt('/activity/queue');
    const table = await screen.findByRole('table', { name: 'Download queue' }, { timeout: 5000 });
    await within(table).findByText('Heat.1995.2160p.BluRay');

    fireEvent.change(await searchBox(), { target: { value: 'sabnzbd' } });
    await waitFor(() => expect(within(table).queryByText('Show.S01E01.1080p.WEB-DL')).toBeNull());
    expect(within(table).getByText('Heat.1995.2160p.BluRay')).toBeTruthy();
    expect(searchCount()).toBe('1 of 3');
    // A search loads the whole queue (one large page) and pages the matches itself.
    await waitFor(() => expect(queueUrls.at(-1)?.searchParams.get('pageSize')).toBe('1000'));

    // Words match across fields; dots count as spaces; status messages are searched.
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search this list' }), { target: { value: 'other sample' } });
    await within(table).findByText('Other.S02E05.720p');
    await waitFor(() => expect(within(table).queryByText('Heat.1995.2160p.BluRay')).toBeNull());

    // Select all picks the matching rows only.
    fireEvent.click(within(table).getAllByRole('checkbox')[0]!);
    expect(await screen.findByText(/1 selected/)).toBeTruthy();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search this list' }), { target: { value: 'nothing-like-this' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Clear search' }, { timeout: 5000 }));
    await within(table).findByText('Show.S01E01.1080p.WEB-DL');
    expect(within(table).getByText('Heat.1995.2160p.BluRay')).toBeTruthy();
    expect(searchCount()).toBeUndefined();
  });
});

describe('history search', () => {
  it('sends q with the other filters, keeps them on a new search and resets to page 1', async () => {
    const urls: URL[] = [];
    stubApi({
      '/api/v1/history': (_init: RequestInit | undefined, url: URL) => {
        urls.push(url);
        const page = Number(url.searchParams.get('page'));
        return {
          page,
          pageSize: 25,
          totalRecords: 60,
          records: [{ id: page, eventType: 'grabbed', sourceTitle: `Show.S01E0${page}.1080p`, date: '2026-10-25T10:00:00.000Z' }],
        };
      },
    });
    renderAt('/activity/history?q=show');
    await screen.findByText('Show.S01E01.1080p', {}, { timeout: 5000 });
    expect(urls.at(-1)!.searchParams.get('q')).toBe('show');
    expect((await searchBox() as HTMLInputElement).value).toBe('show');
    expect(searchCount()).toBe('60 results');

    fireEvent.change(screen.getByRole('combobox', { name: 'Event type' }), { target: { value: 'grabbed' } });
    await waitFor(() => expect(urls.at(-1)!.searchParams.get('eventType')).toBe('grabbed'));
    expect(urls.at(-1)!.searchParams.get('q')).toBe('show');

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText('Show.S01E02.1080p');

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search this list' }), { target: { value: 'show s01' } });
    await waitFor(() => expect(urls.at(-1)!.searchParams.get('q')).toBe('show s01'));
    const last = urls.at(-1)!;
    expect(last.searchParams.get('page')).toBe('1');
    expect(last.searchParams.get('eventType')).toBe('grabbed');
    expect((screen.getByRole('combobox', { name: 'Event type' }) as HTMLSelectElement).value).toBe('grabbed');
  });
});

describe('pending search', () => {
  it('filters the held releases by indexer and title', async () => {
    const pendingRow = (id: number, title: string, indexerName: string) => ({
      id,
      guid: `g${id}`,
      indexerId: 1,
      indexerName,
      title,
      protocol: 'torrent',
      size: 1000,
      publishDate: '2026-10-25T10:00:00.000Z',
      mediaType: 'series',
      seriesId: 1,
      quality: { quality: { ...QUALITIES['WEBDL-1080p'], mediaTypes: [...QUALITIES['WEBDL-1080p'].mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } },
      customFormatScore: 0,
      reason: 'delay',
      added: '2026-10-25T10:00:00.000Z',
      eligibleAt: '2099-10-25T10:00:00.000Z',
      remainingMinutes: 60,
    });
    stubApi({
      '/api/v1/release/pending': [pendingRow(1, 'Show.S01E01.1080p', 'TrackerA'), pendingRow(2, 'Show.S01E02.1080p', 'TrackerB')],
      '/api/v1/series': [],
      '/api/v1/movie': [],
    });
    renderAt('/activity/pending?q=trackerb');
    await screen.findByText('Show.S01E02.1080p', {}, { timeout: 5000 });
    expect(screen.queryByText('Show.S01E01.1080p')).toBeNull();
    expect(searchCount()).toBe('1 of 2');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import type { MediaFile } from '@arclight/shared';
import { ToastProvider } from '../../components/toast.js';
import { episodeChip, movieChip } from '../../components/media/media-kit.js';
import { createToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { routeTree } from '../../router.js';
import { releaseChip } from './add-dialog.js';
import { resultMeta } from './add-form.js';
import { decisionRank, formatAge } from './interactive-search.js';
import { clampColumns } from './library-index.js';
import { groupCollections, movieRow, progressTone, rowMeta } from './library-filters.js';
import { availabilityChip, releaseDates } from './movie-details.js';
import { seasonSummary } from './series-details.js';
import { makeEpisode, makeMovie, makeSeries } from './test-fixtures.js';

configure({ asyncUtilTimeout: 4000 });

class FakeSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}

const quality = {
  quality: { id: 9, name: 'WEBDL-2160p', source: 'web', resolution: 2160, modifier: 'none', weight: 20, mediaTypes: ['series', 'movie'] },
  revision: { version: 1, real: 0, isRepack: false },
} as MediaFile['quality'];

const show = makeSeries({
  id: 1,
  title: 'Severance',
  year: 2022,
  network: 'Apple TV+',
  overview: 'Mark leads a team of office workers.',
  seasons: [
    {
      seasonNumber: 1,
      monitored: true,
      statistics: { episodeCount: 2, episodeFileCount: 1, totalEpisodeCount: 3, monitoredEpisodeCount: 3, sizeOnDisk: 25 * 1024 ** 3, percentOfEpisodes: 50 },
    },
  ],
});
const episodes = [
  makeEpisode({ id: 1, title: 'Good News About Hell', airDate: '2022-02-18', hasFile: true, episodeFileId: 10 }),
  makeEpisode({ id: 2, title: 'Half Loop', airDate: '2022-02-25' }),
  makeEpisode({ id: 3, title: 'In Perpetuity', airDate: '2099-01-01' }),
];
const files: MediaFile[] = [
  {
    id: 10,
    mediaType: 'series',
    seriesId: 1,
    seasonNumber: 1,
    episodeIds: [1],
    relativePath: 'Season 01/Severance - S01E01.mkv',
    path: '/tv/Severance/Season 01/Severance - S01E01.mkv',
    sizeBytes: 25 * 1024 ** 3,
    dateAdded: '2026-01-01T00:00:00.000Z',
    quality,
    languages: ['en'],
    releaseGroup: 'NTb',
  },
];
const film = makeMovie({
  id: 7,
  title: 'Dune: Part Two',
  year: 2024,
  inCinemas: '2024-03-01',
  digitalRelease: '2024-04-16',
  collection: { tmdbId: 726871, title: 'Dune Collection' },
  hasFile: false,
  isAvailable: true,
});

const refreshJob = { id: 77, name: 'RefreshSeriesItem', status: 'queued', trigger: 'manual', message: null, queuedAt: '2026-10-26T10:00:00.000Z', startedAt: null, endedAt: null, durationMs: null };
const historyRow = (over: Record<string, unknown>) => ({
  id: 1,
  eventType: 'grabbed',
  mediaType: 'series',
  seriesId: 1,
  episodeId: 2,
  movieId: null,
  sourceTitle: 'Severance.S01E02.2160p.WEB-DL-NTb',
  quality,
  languages: ['en'],
  customFormats: [],
  customFormatScore: 0,
  date: '2026-10-20T08:30:00.000Z',
  downloadId: 'HASH',
  data: { indexer: 'Nyaa' },
  ...over,
});
let calls: Array<{ url: string; method: string; body: unknown }> = [];
let queueSummary: unknown[] = [];
const HOUR = 3_600_000;
/** Searched 2 h ago (nothing found); the scheduled search comes back in about 5 h. */
const searchStatusOf = (mediaType: string, id: number) => ({
  mediaType,
  id,
  monitored: true,
  lastSearch: { time: new Date(Date.now() - 2 * HOUR).toISOString(), source: 'automatic', outcome: 'noResults', releases: 0, approved: 0, detail: null },
  automatic: {
    state: 'scheduled',
    job: mediaType === 'movie' ? 'MissingMovieSearch' : 'MissingEpisodeSearch',
    nextSearchAt: new Date(Date.now() + 5 * HOUR + 60_000).toISOString(),
    searchCount: 1,
    runsAhead: 0,
  },
});

beforeEach(() => {
  localStorage.clear();
  calls = [];
  queueSummary = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const path = url.split('?')[0];
      if (method === 'POST' && path === '/api/v1/command/refresh') return new Response(JSON.stringify(refreshJob), { status: 202 });
      if (path === '/api/v1/release/searchstatus') {
        const params = new URL(url, 'http://localhost').searchParams;
        const ids = (params.get('ids') ?? '').split(',').map(Number);
        return new Response(JSON.stringify(ids.map((id) => searchStatusOf(params.get('mediaType') ?? 'episode', id))), { status: 200 });
      }
      const routes: Record<string, unknown> = {
        '/api/v1/history/series': [
          historyRow({ id: 2, eventType: 'downloadFolderImported', date: '2026-10-20T09:00:00.000Z', episode: { id: 2, seriesId: 1, seasonNumber: 1, episodeNumber: 2, title: 'Half Loop', airDate: null } }),
          historyRow({ id: 1, episode: { id: 2, seriesId: 1, seasonNumber: 1, episodeNumber: 2, title: 'Half Loop', airDate: null } }),
        ],
        '/api/v1/history/movie': [],
        '/api/v1/series/1': show,
        '/api/v1/episode': episodes,
        '/api/v1/mediafile': url.includes('seriesId') ? files : [],
        '/api/v1/movie/7': film,
        '/api/v1/tag': [],
        '/api/v1/qualityprofile': [{ id: 1, name: 'UHD-2160' }],
        '/api/v1/rootfolder': [],
        '/api/v1/queue/summary': queueSummary,
      };
      const body = path ? routes[path] : undefined;
      return body === undefined
        ? new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
        : new Response(JSON.stringify(body), { status: 200 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

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

describe('series details (Page 03)', () => {
  it('renders the hero: crumb, title + mono year, meta grid and verbs', async () => {
    renderAt('/library/series/1');
    const hero = await screen.findByRole('region', { name: 'Series overview' });
    expect(within(hero).getByRole('heading', { level: 1 }).textContent).toBe('Severance2022');
    expect(within(hero).getByText('2022').className).toContain('mk-hero__year');
    expect(within(hero).getByRole('link', { name: 'Library' }).getAttribute('href')).toBe('/library/tv');
    expect(within(hero).getByText('/tv/Severance').className).toContain('al-kv__value--mono');
    expect(within(hero).getByText('10 / 10')).toBeTruthy();
    for (const name of ['Search monitored', 'Interactive search', 'Edit', 'Delete']) expect(within(hero).getByRole('button', { name })).toBeTruthy();
  });

  it('has the canonical tabs', async () => {
    renderAt('/library/series/1');
    await screen.findByRole('region', { name: 'Series overview' });
    await waitFor(() =>
      expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Seasons & episodes', 'Files1', 'History', 'Decisions', 'Search', 'Scene mapping', 'Subtitles', 'Requests']),
    );
  });

  it('season accordion shows the monitor switch, meter and kit status chips', async () => {
    renderAt('/library/series/1');
    const table = await screen.findByRole('table', { name: 'Season 1 episodes' });
    expect(screen.getByRole('switch', { name: 'Unmonitor Season 1' })).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Season 1 progress' }).getAttribute('aria-valuenow')).toBe('50');
    expect(screen.getByText('1/2 · 25.0 GB')).toBeTruthy();
    const chips = within(table).getAllByText(/^(Downloaded|Missing|Unaired)$/).map((c) => c.textContent);
    expect(chips.sort()).toEqual(['Downloaded', 'Missing', 'Unaired']);
    expect(within(table).getByText('Missing').getAttribute('data-status')).toBe('missing');
  });

  it('says when missing episodes are searched next, and shows queued ones as such', async () => {
    queueSummary = [{ id: 8, mediaType: 'series', seriesId: 1, episodeIds: [1], trackedState: 'importing', trackedStatus: 'ok', status: 'completed', progress: 1 }];
    renderAt('/library/series/1');
    const table = await screen.findByRole('table', { name: 'Season 1 episodes' });
    expect((await screen.findByTestId('season-search')).textContent).toBe('1 missing episode · Next automatic search ~in 5h');
    // Only the missing (wanted) episode is asked about.
    expect(calls.find((c) => c.url.startsWith('/api/v1/release/searchstatus?'))?.url).toMatch(/[?&]ids=2$/);
    expect(await within(table).findByText('Importing')).toBeTruthy();
    const hero = screen.getByRole('region', { name: 'Series overview' });
    expect(within(hero).getByTestId('queue-state').textContent).toBe('Importing');

    fireEvent.click(screen.getByRole('button', { name: 'Half Loop' }));
    const drawer = await screen.findByRole('dialog', { name: 'S01E02 · Half Loop' });
    expect(await within(drawer).findByText('Last searched 2h ago · nothing found')).toBeTruthy();
    expect(within(drawer).getByText('Next automatic search ~in 5h')).toBeTruthy();
  });

  it('opens the episode drawer with file info', async () => {
    renderAt('/library/series/1');
    await waitFor(() => expect(screen.getByRole('tab', { name: /^Files/ }).textContent).toBe('Files1'));
    fireEvent.click(await screen.findByRole('button', { name: 'Good News About Hell' }));
    const drawer = await screen.findByRole('dialog', { name: 'S01E01 · Good News About Hell' });
    expect(within(drawer).getByText('Season 01/Severance - S01E01.mkv')).toBeTruthy();
    expect(within(drawer).getByText('WEBDL-2160p')).toBeTruthy();
    expect(within(drawer).getByRole('button', { name: 'Search episode' })).toBeTruthy();
  });

  it('opens "Add additional…" for the series, a season and an episode', async () => {
    renderAt('/library/series/1');
    const hero = await screen.findByRole('region', { name: 'Series overview' });
    fireEvent.click(within(hero).getByRole('button', { name: 'Add additional…' }));
    let dialog = await screen.findByRole('dialog', { name: 'Add additional language · Severance' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add an additional language to Season 1' }));
    dialog = await screen.findByRole('dialog', { name: 'Add additional language · Severance Season 1' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add an additional language to S01E01' }));
    expect(await screen.findByRole('dialog', { name: 'Add additional language · Severance S01E01' })).toBeTruthy();
  });

  it('delete confirm names the series', async () => {
    renderAt('/library/series/1');
    const hero = await screen.findByRole('region', { name: 'Series overview' });
    fireEvent.click(within(hero).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Severance?' });
    expect(within(dialog).getByRole('button', { name: 'Delete series' })).toBeTruthy();
  });

  it('interactive search opens the 1100px modal', async () => {
    renderAt('/library/series/1');
    const hero = await screen.findByRole('region', { name: 'Series overview' });
    fireEvent.click(within(hero).getByRole('button', { name: 'Interactive search' }));
    const dialog = await screen.findByRole('dialog', { name: 'Interactive search · Severance' });
    expect(dialog.getAttribute('data-width')).toBe('1100');
  });
});

describe('details refresh and history', () => {
  const refreshPosts = () => calls.filter((c) => c.method === 'POST' && c.url === '/api/v1/command/refresh').map((c) => c.body);

  it('series Refresh and Refresh & scan post the refresh command and toast the job', async () => {
    renderAt('/library/series/1');
    const hero = await screen.findByRole('region', { name: 'Series overview' });
    fireEvent.click(within(hero).getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(refreshPosts()).toEqual([{ seriesId: 1, rescan: false }]));
    expect(await screen.findByText('Refresh started')).toBeTruthy();
    await waitFor(() => expect((within(hero).getByRole('button', { name: 'Refresh & scan' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(hero).getByRole('button', { name: 'Refresh & scan' }));
    await waitFor(() => expect(refreshPosts()).toEqual([{ seriesId: 1, rescan: false }, { seriesId: 1, rescan: true }]));
    expect(await screen.findByText('Refresh and scan started')).toBeTruthy();
  });

  it('movie Refresh posts the movie id', async () => {
    renderAt('/library/movie/7');
    const hero = await screen.findByRole('region', { name: 'Movie overview' });
    fireEvent.click(within(hero).getByRole('button', { name: 'Refresh & scan' }));
    await waitFor(() => expect(refreshPosts()).toEqual([{ movieId: 7, rescan: true }]));
  });

  it('series History tab lists /history/series rows with event chips and mono dates', async () => {
    renderAt('/library/series/1');
    await screen.findByRole('region', { name: 'Series overview' });
    fireEvent.click(await screen.findByRole('tab', { name: 'History' }));
    const table = await screen.findByRole('table', { name: 'History' });
    expect(await within(table).findByText('Imported')).toBeTruthy();
    expect(within(table).getByText('Grabbed')).toBeTruthy();
    expect(within(table).getAllByText('S01E02')).toHaveLength(2);
    expect(within(table).getAllByText('Nyaa')).toHaveLength(2);
    expect(within(table).getAllByText('WEBDL-2160p')[0]!.className).toContain('al-td--mono');
    const req = calls.find((c) => c.url.startsWith('/api/v1/history/series?'));
    expect(req?.url).toContain('seriesId=1');
  });

  it('movie History tab shows the empty state from /history/movie', async () => {
    renderAt('/library/movie/7');
    await screen.findByRole('region', { name: 'Movie overview' });
    fireEvent.click(await screen.findByRole('tab', { name: 'History' }));
    expect(await screen.findByText('No history yet')).toBeTruthy();
    expect(calls.some((c) => c.url.startsWith('/api/v1/history/movie?') && c.url.includes('movieId=7'))).toBe(true);
  });
});

describe('movie details', () => {
  it('shows release dates in mono, the availability chip and the collection link', async () => {
    renderAt('/library/movie/7');
    const hero = await screen.findByRole('region', { name: 'Movie overview' });
    const dates = within(hero).getByLabelText('Release dates');
    expect(within(dates).getByText('2024-03-01').className).toContain('al-num');
    expect(within(dates).getByText('2024-04-16')).toBeTruthy();
    expect(within(hero).getByTestId('availability').textContent).toBe('Available');
    expect(within(hero).getByRole('link', { name: 'Dune Collection' })).toBeTruthy();
    expect(within(hero).getByText('Missing').getAttribute('data-status')).toBe('missing');
    await waitFor(() => expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Files0', 'History', 'Decisions', 'Search', 'Subtitles', 'Requests']));
  });

  it('shows the last and next automatic search, and the download once it is queued', async () => {
    queueSummary = [{ id: 9, mediaType: 'movie', movieId: 7, trackedState: 'downloading', trackedStatus: 'ok', status: 'downloading', progress: 0.42 }];
    renderAt('/library/movie/7');
    const hero = await screen.findByRole('region', { name: 'Movie overview' });
    expect(await within(hero).findByText('Downloading 42%')).toBeTruthy();
    expect(within(hero).queryByText('Missing')).toBeNull();
    expect(await within(hero).findByText('Last searched 2h ago · nothing found')).toBeTruthy();
    expect(within(hero).getByText('Next automatic search ~in 5h')).toBeTruthy();
  });
});

describe('library helpers', () => {
  it('maps episode and movie states to the kit vocabulary', () => {
    expect(episodeChip('downloaded')).toEqual({ status: 'downloaded' });
    expect(episodeChip('downloaded', { cutoffUnmet: true })).toEqual({ status: 'cutoffUnmet' });
    expect(episodeChip('wanted')).toEqual({ status: 'missing' });
    expect(episodeChip('missing')).toEqual({ status: 'unmonitored' });
    expect(episodeChip('tba')).toEqual({ status: 'waiting' });
    expect(episodeChip('wanted', { downloading: 0.68 })).toEqual({ status: 'downloading', label: 'Downloading 68%' });
    expect(movieChip({ hasFile: false, monitored: true, isAvailable: false })).toEqual({ status: 'unaired' });
    expect(movieChip({ hasFile: false, monitored: false, isAvailable: true })).toEqual({ status: 'unmonitored' });
  });

  it('groups movies by collection with owned/total', () => {
    const rows = [
      movieRow(makeMovie({ id: 1, title: 'Dune', year: 2021, hasFile: true, collection: { tmdbId: 5, title: 'Dune Collection' } })),
      movieRow(makeMovie({ id: 2, title: 'Dune: Part Two', year: 2024, collection: { tmdbId: 5, title: 'Dune Collection' } })),
      movieRow(makeMovie({ id: 3, title: 'Heat' })),
    ];
    const groups = groupCollections(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ title: 'Dune Collection', owned: 1 });
    expect(groups[0]!.movies.map((m) => m.title)).toEqual(['Dune', 'Dune: Part Two']);
  });

  it('poster captions, progress tones and the column clamp', () => {
    expect(rowMeta({ year: 2022, subtitle: 'Apple TV+' })).toBe('2022 · Apple TV+');
    expect(progressTone({ monitored: true, have: 6, total: 10 })).toBe('warn');
    expect(progressTone({ monitored: false, have: 6, total: 10 })).toBe('muted');
    expect(progressTone({ monitored: true, have: 10, total: 10 })).toBe('default');
    expect([clampColumns(3), clampColumns(12), clampColumns(7.4)]).toEqual([5, 10, 7]);
  });

  it('season summaries, release rows and availability', () => {
    const now = new Date('2026-10-26T12:00:00Z');
    expect(seasonSummary(show.seasons[0]!, episodes, now)).toBe('Airing · 2 of 3 aired');
    expect(releaseDates({ inCinemas: '2024-03-01', digitalRelease: null, physicalRelease: undefined })).toEqual([
      ['In cinemas', '2024-03-01'],
      ['Digital', '—'],
      ['Physical', '—'],
    ]);
    expect(availabilityChip({ isAvailable: false, minimumAvailability: 'released' }).label).toBe('Not available until released');
    expect(releaseChip('2030-01-01', '2026-10-26')).toEqual({ label: 'Not released yet', tone: 'neutral' });
    expect(releaseChip('2020-01-01', '2026-10-26').label).toBe('Available');
  });

  it('release table helpers and TMDB result meta', () => {
    expect(formatAge({ age: 3, ageHours: 80, ageMinutes: 4800 })).toBe('3d');
    expect(formatAge({ age: 0, ageHours: 0.5, ageMinutes: 30 })).toBe('30m');
    expect([decisionRank({ approved: true, temporarilyRejected: false }), decisionRank({ approved: false, temporarilyRejected: true }), decisionRank({ approved: false, temporarilyRejected: false })]).toEqual([0, 1, 2]);
    expect(
      resultMeta({ mediaType: 'series', tmdbId: 1, title: 'X', originalTitle: 'X', overview: '', originalLanguage: 'en', images: {}, ratings: { tmdb: { value: 0, votes: 0 } }, firstAired: '2015-12-14' }),
    ).toBe('Series · first aired 2015-12-14 · en');
  });
});

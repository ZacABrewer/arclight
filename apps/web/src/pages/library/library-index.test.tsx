import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { ToastProvider } from '../../components/toast.js';
import { libraryKeys } from '../../hooks/library-keys.js';
import { patchQueries, withSeasonMonitored } from '../../hooks/library.js';
import { createToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { routeTree } from '../../router.js';
import { makeSeries } from './test-fixtures.js';

class FakeSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}

const initialSeries = [
  makeSeries({ id: 1, title: 'The Expanse', monitored: true, overview: 'Belters and Martians.', network: 'Prime Video' }),
  makeSeries({ id: 2, title: 'Andor', monitored: false }),
];
const series = [...initialSeries];

let puts: Array<{ url: string; body: unknown }> = [];
let failPut = false;
/** When set, PUTs wait for this promise so a test can observe the optimistic state. */
let holdPut: Promise<void> | null = null;

beforeEach(() => {
  puts = [];
  failPut = false;
  holdPut = null;
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split('?')[0];
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { monitored: boolean };
        puts.push({ url, body });
        if (holdPut) await holdPut;
        if (failPut) return new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
        const s = series.find((x) => url.endsWith(`/${x.id}`))!;
        return new Response(JSON.stringify({ ...s, ...body }), { status: 200 });
      }
      const routes: Record<string, unknown> = {
        '/api/v1/series': series,
        '/api/v1/movie': [],
        '/api/v1/tag': [],
        '/api/v1/rootfolder': [],
        '/api/v1/qualityprofile': [],
        '/api/v1/health': { status: 'ok', checks: [] },
        '/api/v1/system/status': {},
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
  return { queryClient, router };
}

const enterSelectMode = () => fireEvent.click(screen.getByRole('button', { name: 'Select' }));

describe('library index', () => {
  it('lists series as poster cards and filters as you type', async () => {
    renderAt('/library/tv');
    const grid = await screen.findByTestId('library-grid');
    expect(within(grid).getByRole('link', { name: 'The Expanse' })).toBeTruthy();
    expect(within(grid).getByRole('link', { name: 'Andor' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Filter library'), { target: { value: 'expan' } });
    expect(within(grid).queryByRole('link', { name: 'Andor' })).toBeNull();
    expect(screen.getByText((_, el) => el?.classList.contains('mk-count') === true && /^1 of 2 series/.test(el.textContent ?? ''))).toBeTruthy();
  });

  it('filters by monitored state and switches to the table view', async () => {
    renderAt('/library/tv');
    await screen.findByTestId('library-grid');
    fireEvent.change(screen.getByLabelText('Monitored filter'), { target: { value: 'unmonitored' } });
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    const table = screen.getByRole('table');
    expect(within(table).getByRole('link', { name: 'Andor' })).toBeTruthy();
    expect(within(table).queryByRole('link', { name: 'The Expanse' })).toBeNull();
    // The filter bar shows Clear once a filter is active.
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(within(screen.getByRole('table')).getByRole('link', { name: 'The Expanse' })).toBeTruthy();
  });

  it('toggles monitoring optimistically and rolls back on failure', async () => {
    const { queryClient } = renderAt('/library/tv');
    await screen.findByTestId('library-grid');
    failPut = true;
    let release!: () => void;
    holdPut = new Promise<void>((r) => (release = r));
    const toggle = screen.getByRole('switch', { name: 'Monitor Andor' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    // Optimistic: the cache flips before the server answers.
    await waitFor(() =>
      expect(queryClient.getQueryData<typeof series>(libraryKeys.series.list())?.find((s) => s.id === 2)?.monitored).toBe(true),
    );
    release();
    await waitFor(() =>
      expect(queryClient.getQueryData<typeof series>(libraryKeys.series.list())?.find((s) => s.id === 2)?.monitored).toBe(false),
    );
    expect(puts[0]).toEqual({ url: '/api/v1/series/2', body: { monitored: true } });
  });

  it('select mode shows checkboxes, outlines selected posters and opens the bulk bar', async () => {
    renderAt('/library/tv');
    await screen.findByTestId('library-grid');
    expect(screen.queryByLabelText('Select The Expanse')).toBeNull();
    enterSelectMode();
    fireEvent.click(screen.getByLabelText('Select The Expanse'));
    fireEvent.click(screen.getByLabelText('Select Andor'));
    const selected = document.querySelectorAll('.al-poster[data-selected="true"]');
    expect(selected).toHaveLength(2);
    const bar = screen.getByRole('toolbar', { name: 'Bulk actions' });
    expect(within(bar).getByText('2 selected')).toBeTruthy();
    for (const name of ['Monitor', 'Unmonitor', 'Profile', 'Root folder', 'Tags', 'Delete', 'Cancel']) {
      expect(within(bar).getByRole('button', { name })).toBeTruthy();
    }
    await act(async () => {
      fireEvent.click(within(bar).getByRole('button', { name: 'Unmonitor' }));
    });
    await waitFor(() => expect(puts[0]?.url).toBe('/api/v1/series/bulk'));
    expect(puts[0]?.body).toEqual({ ids: [1, 2], monitored: false });
  });

  it('bulk delete names the object in the confirm dialog', async () => {
    renderAt('/library/tv');
    await screen.findByTestId('library-grid');
    enterSelectMode();
    fireEvent.click(screen.getByLabelText('Select Andor'));
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Bulk actions' })).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete 1 series?' });
    expect(within(dialog).getByRole('button', { name: 'Delete series' })).toBeTruthy();
    expect(within(dialog).getByLabelText('Delete files and folder from disk')).toBeTruthy();
  });

  it('overview view renders 140px rows with the overview text', async () => {
    renderAt('/library/tv');
    await screen.findByTestId('library-grid');
    fireEvent.click(screen.getByRole('button', { name: 'Overview' }));
    const row = screen.getByRole('article', { name: 'The Expanse' });
    expect(row.classList.contains('mk-overview-row')).toBe(true);
    expect(within(row).getByText('Belters and Martians.')).toBeTruthy();
  });

  it('the size slider sets the grid column count between 5 and 10', async () => {
    renderAt('/library/tv');
    const grid = await screen.findByTestId('library-grid');
    const page = grid.closest('.lib-page') as HTMLElement;
    expect(page.style.getPropertyValue('--mk-cols')).toBe('7');
    const slider = screen.getByLabelText('Poster size') as HTMLInputElement;
    expect([slider.min, slider.max]).toEqual(['5', '10']);
    fireEvent.change(slider, { target: { value: '10' } });
    expect(page.style.getPropertyValue('--mk-cols')).toBe('5');
  });

  it('shows the empty state with Add series and Import folder', async () => {
    series.splice(0, series.length);
    try {
      renderAt('/library/tv');
      expect(await screen.findByText('No series yet')).toBeTruthy();
      expect(screen.getAllByRole('link', { name: 'Add series' }).length).toBeGreaterThan(0);
      expect(screen.getByRole('link', { name: 'Import folder' }).getAttribute('href')).toBe('/activity/manual-import');
    } finally {
      series.push(...initialSeries);
    }
  });
});

describe('optimistic helpers', () => {
  it('withSeasonMonitored flips only the given season', () => {
    const s = makeSeries({
      id: 1,
      title: 'X',
      seasons: [
        { seasonNumber: 1, monitored: true },
        { seasonNumber: 2, monitored: true },
      ],
    });
    expect(withSeasonMonitored(s, 2, false).seasons.map((x) => x.monitored)).toEqual([true, false]);
    expect(s.seasons[1]!.monitored).toBe(true);
  });

  it('patchQueries touches only the exact key by default, or a whole prefix on request', async () => {
    const qc = createQueryClient(createToastStore());
    qc.setQueryData(['series', 'detail', 1], { n: 1 });
    qc.setQueryData(['series', 'detail', 1, 'episodes'], { n: 2 });
    const snap = await patchQueries<{ n: number }>(qc, ['series', 'detail', 1], (d) => ({ n: d.n * 10 }));
    expect(qc.getQueryData(['series', 'detail', 1])).toEqual({ n: 10 });
    expect(qc.getQueryData(['series', 'detail', 1, 'episodes'])).toEqual({ n: 2 });
    expect(snap).toHaveLength(1);
    await patchQueries<{ n: number }>(qc, ['series', 'detail', 1], (d) => ({ n: d.n + 1 }), false);
    expect(qc.getQueryData(['series', 'detail', 1, 'episodes'])).toEqual({ n: 3 });
  });
});

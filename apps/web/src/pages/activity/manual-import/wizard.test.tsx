import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { QUALITIES, type ManualImportItem } from '@arclight/shared';
import { createQueryClient } from '../../../query-client.js';
import { ManualImportPage, parseManualImportSearch } from './manual-import-page.js';

// The wizard is rendered in a minimal router (not the app routeTree) so the shell does not
// matter here; getRouteApi only needs a route with the same id.

const quality = { quality: { ...QUALITIES['WEBDL-1080p'], mediaTypes: [...QUALITIES['WEBDL-1080p'].mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } };

const file: ManualImportItem = {
  path: '/dl/Show.S01E01.mkv',
  relativePath: 'Show.S01E01.mkv',
  name: 'Show.S01E01.mkv',
  sizeBytes: 1000,
  quality,
  languages: ['English'],
  releaseGroup: 'GRP',
  rejections: [],
  mediaType: 'series',
  seriesId: 1,
  seasonNumber: 1,
  episodeIds: [10],
};

let calls: Array<{ url: string; method: string; body: unknown }>;

beforeEach(() => {
  calls = [];
  scan = [file];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const path = url.split('?')[0]!;
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (path === '/api/v1/queue') return json({ page: 1, pageSize: 100, sortKey: 'added', sortDirection: 'desc', totalRecords: 0, records: [] });
      if (path === '/api/v1/manualimport' && method === 'GET') return json(scan);
      if (path === '/api/v1/manualimport' && method === 'POST') {
        return json({ imported: [{ path: file.path, mediaFileId: 5, destination: '/tv/Show/Season 01/Show - S01E01.mkv' }], failed: [] });
      }
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

let scan: ManualImportItem[] = [file];

function renderWizard(path = '/activity/manual-import') {
  const root = createRootRoute();
  const wizard = createRoute({ getParentRoute: () => root, path: '/activity/manual-import', validateSearch: parseManualImportSearch, component: ManualImportPage });
  const queue = createRoute({ getParentRoute: () => root, path: '/activity/queue', component: () => <p>Queue page</p> });
  const router = createRouter({ routeTree: root.addChildren([wizard, queue]), history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

function currentStep(): string {
  const steps = screen.getByRole('list', { name: 'Manual import steps' });
  return steps.querySelector('[aria-current="step"]')?.textContent?.replace(/\s*\(current\)$/, '') ?? '';
}

const cont = () => screen.getByRole('button', { name: /^(Continue|Import \d+ files?)$/ });

describe('manual import wizard', () => {
  it('walks Path → Files → Mapping → Mode → Results, and Back works', async () => {
    renderWizard();
    await screen.findByRole('list', { name: 'Manual import steps' }, { timeout: 5000 });
    expect(currentStep()).toBe('Path');
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    expect((cont() as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByRole('textbox', { name: 'Folder' }), { target: { value: '/dl' } });
    fireEvent.click(cont());

    // Files: the scan result with its mapping state.
    const found = await screen.findByRole('table', { name: 'Files found' }, { timeout: 5000 });
    expect(currentStep()).toBe('Files');
    expect(within(found).getByText('Show.S01E01.mkv')).toBeTruthy();
    expect(within(found).getByText('Mapped')).toBeTruthy();
    expect(calls.some((c) => c.method === 'GET' && c.url.startsWith('/api/v1/manualimport') && c.url.includes('folder=%2Fdl'))).toBe(true);

    fireEvent.click(cont());
    expect(currentStep()).toBe('Mapping');
    expect(screen.getByRole('table', { name: 'Files to import' })).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'Import Show.S01E01.mkv' }) as HTMLInputElement).checked).toBe(true);

    // Back returns to Files without losing the scan.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(currentStep()).toBe('Files');
    fireEvent.click(cont());
    expect(currentStep()).toBe('Mapping');

    fireEvent.click(cont());
    expect(currentStep()).toBe('Mode');
    const mode = screen.getByRole('group', { name: 'Import mode' });
    fireEvent.click(within(mode).getByRole('button', { name: 'Move' }));
    expect(within(mode).getByRole('button', { name: 'Move' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Import 1 file' }));
    const results = await screen.findByRole('table', { name: 'Import results' }, { timeout: 5000 });
    expect(currentStep()).toBe('Results');
    expect(within(results).getByText('Imported')).toBeTruthy();
    expect(within(results).getByText('/tv/Show/Season 01/Show - S01E01.mkv')).toBeTruthy();
    const post = calls.find((c) => c.method === 'POST' && c.url === '/api/v1/manualimport')!;
    expect(post.body).toMatchObject({ importMode: 'move', items: [{ path: file.path, seriesId: 1, seasonNumber: 1, episodeIds: [10] }] });
  });

  it('goes back to Path from Files and clears the source', async () => {
    renderWizard();
    await screen.findByRole('list', { name: 'Manual import steps' }, { timeout: 5000 });
    fireEvent.change(screen.getByRole('textbox', { name: 'Folder' }), { target: { value: '/dl' } });
    fireEvent.click(cont());
    await screen.findByRole('table', { name: 'Files found' }, { timeout: 5000 });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(currentStep()).toBe('Path'));
    expect((screen.getByRole('textbox', { name: 'Folder' }) as HTMLInputElement).value).toBe('');
  });
});

describe('manual import file search', () => {
  const second: ManualImportItem = { ...file, path: '/dl/Show.S01E02.mkv', relativePath: 'Show.S01E02.mkv', name: 'Show.S01E02.mkv', episodeIds: [11] };

  it('filters the file list, keeps the wizard source in the URL, and select all takes the matches only', async () => {
    scan = [file, second];
    const router = renderWizard('/activity/manual-import?folder=%2Fdl&q=s01e02');
    const found = await screen.findByRole('table', { name: 'Files found' }, { timeout: 5000 });
    expect(within(found).getByText('Show.S01E02.mkv')).toBeTruthy();
    expect(within(found).queryByText('Show.S01E01.mkv')).toBeNull();
    expect(document.querySelector('.al-listsearch__count')?.textContent).toBe('1 of 2');
    expect(router.state.location.search).toMatchObject({ folder: '/dl', q: 's01e02' });

    // Mapping: unselect all (the visible match only), the hidden file stays selected.
    fireEvent.click(cont());
    const table = screen.getByRole('table', { name: 'Files to import' });
    fireEvent.click(within(table).getAllByRole('checkbox')[0]!);
    expect((within(table).getByRole('checkbox', { name: 'Import Show.S01E02.mkv' }) as HTMLInputElement).checked).toBe(false);

    // Clearing the search keeps the source and the step.
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search this list' }), { target: { value: '' } });
    expect(await within(table).findByText('Show.S01E01.mkv', {}, { timeout: 5000 })).toBeTruthy();
    expect((within(table).getByRole('checkbox', { name: 'Import Show.S01E01.mkv' }) as HTMLInputElement).checked).toBe(true);
    expect(router.state.location.search).toEqual({ folder: '/dl' });
    expect(currentStep()).toBe('Mapping');
    expect(calls.filter((c) => c.method === 'GET' && c.url.startsWith('/api/v1/manualimport'))).toHaveLength(1);
  });

  it('start over drops the search with the source', async () => {
    const router = renderWizard('/activity/manual-import?folder=%2Fdl&q=show');
    await screen.findByRole('table', { name: 'Files found' }, { timeout: 5000 });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(currentStep()).toBe('Path'));
    expect(router.state.location.search).toEqual({});
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { NAMING_DEFAULTS } from '@arclight/shared';
import { MEDIA_MANAGEMENT_DEFAULTS } from '../../../api/settings.js';
import { ToastProvider } from '../../../components/toast.js';
import { createToastStore } from '../../../lib/toast.js';
import { createQueryClient } from '../../../query-client.js';
import { routeTree } from '../../../router.js';
import { previewCaption, renderPreview } from './naming-preview.js';

class FakeSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}

const naming = {
  ...NAMING_DEFAULTS,
  renameEpisodes: true,
  standardEpisodeFormat: '{Series Title} - S{season:00}E{episode:00} - {Episode Title} [{Quality Full}]',
};

const GiB = 1024 ** 3;
const folders = [
  { id: 1, path: '/media/tv', mediaType: 'series', freeSpaceBytes: 2048 * GiB, accessible: true },
  { id: 2, path: '/media/movies', mediaType: 'movie', freeSpaceBytes: 20 * GiB, accessible: true },
];

let calls: Array<{ url: string; method: string; body: unknown }>;

beforeEach(() => {
  calls = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (url === '/api/v1/settings/naming') return new Response(JSON.stringify(method === 'PUT' ? body : naming), { status: 200 });
      if (url === '/api/v1/settings/mediamanagement') return new Response(JSON.stringify(method === 'PUT' ? body : MEDIA_MANAGEMENT_DEFAULTS), { status: 200 });
      if (url === '/api/v1/rootfolder') return new Response(JSON.stringify(folders), { status: 200 });
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function renderAt(path: string) {
  const toasts = createToastStore();
  const queryClient = createQueryClient(toasts);
  const router = createRouter({ routeTree, context: { queryClient }, history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider store={toasts}>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('naming preview', () => {
  it('renders the canonical sample with padding and the file extension', () => {
    expect(renderPreview(naming.standardEpisodeFormat, 'episode')).toBe('Severance - S02E09 - The After Hours [WEBDL-2160p].mkv');
    expect(renderPreview('Season {season:00}', 'seasonFolder')).toBe('Season 02');
    expect(renderPreview('{Series.Title}.S{season:00}', 'episode')).toBe('Severance.S02.mkv');
    expect(renderPreview('{Movie Title} ({Release Year})', 'movieFolder')).toBe('Dune Part Two (2024)');
    expect(renderPreview('{Unknown Token}', 'movie')).toBe('{Unknown Token}.mkv');
    expect(previewCaption('', 'episode')).toBe('Enter a format to see a sample');
  });
});

describe('Settings -> Media management', () => {
  it('shows the live mono sample under a naming format and updates it as the user types', async () => {
    renderAt('/settings/mediamanagement');
    const sample = await screen.findByTestId('sample-standardEpisodeFormat');
    expect(sample.textContent).toBe('→ Severance - S02E09 - The After Hours [WEBDL-2160p].mkv');
    expect(sample.closest('.al-form-row__caption--mono')).toBeTruthy();
    const input = screen.getByLabelText('Standard episode format') as HTMLInputElement;
    expect(input.className).toContain('al-input--mono');
    fireEvent.change(input, { target: { value: '{Series Title} S{season:00}E{episode:00}' } });
    expect(screen.getByTestId('sample-standardEpisodeFormat').textContent).toBe('→ Severance S02E09.mkv');
  });

  it('counts edits in the save bar, discards them, and saves with PUT', async () => {
    renderAt('/settings/mediamanagement');
    const input = (await screen.findByLabelText('Season folder format')) as HTMLInputElement;
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();

    fireEvent.change(input, { target: { value: 'S{season:00}' } });
    fireEvent.click(screen.getByLabelText('Rename episodes'));
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    expect(bar.textContent).toContain('2 unsaved changes');

    fireEvent.click(within(bar).getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    expect((screen.getByLabelText('Season folder format') as HTMLInputElement).value).toBe(NAMING_DEFAULTS.seasonFolderFormat);

    fireEvent.change(screen.getByLabelText('Season folder format'), { target: { value: 'S{season:00}' } });
    fireEvent.click(within(screen.getByRole('region', { name: 'Unsaved changes' })).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts.map((c) => c.url)).toEqual(['/api/v1/settings/naming']);
    expect(puts[0]!.body).toMatchObject({ seasonFolderFormat: 'S{season:00}' });
  });

  it('hides advanced rows until Show advanced is on', async () => {
    renderAt('/settings/mediamanagement');
    await screen.findByLabelText('Standard episode format');
    expect(screen.queryByLabelText('Daily episode format')).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Show advanced' }));
    expect(screen.getByLabelText('Daily episode format')).toBeTruthy();
    expect(screen.getByLabelText('Colon replacement')).toBeTruthy();
  });

  it('lists root folders with a mono path, a free-space meter and a named remove button', async () => {
    renderAt('/settings/mediamanagement');
    const rows = await screen.findAllByTestId('root-folder-row');
    expect(rows).toHaveLength(2);
    const tv = rows[0]!;
    const path = within(tv).getByText('/media/tv');
    expect(path.className).toContain('al-num');
    expect(within(tv).getByRole('button', { name: 'Remove /media/tv' })).toBeTruthy();
    expect(within(tv).getByText('2.0 TiB free').className).toContain('al-num');
    // 20 GiB free is low: the meter turns orange.
    const movies = rows[1]!;
    expect(within(movies).getByRole('progressbar').className).toContain('al-meter--warn');
    expect(within(tv).getByRole('progressbar').className).not.toContain('al-meter--warn');

    fireEvent.click(within(movies).getByRole('button', { name: 'Remove /media/movies' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove /media/movies?' });
    expect(within(confirm).getByRole('button', { name: 'Remove root folder' })).toBeTruthy();
  });
});

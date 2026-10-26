import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import type { MetadataSearchResult } from '@arclight/shared';
import { createQueryClient } from '../../query-client.js';
import { createToastStore } from '../../lib/toast.js';
import { ToastProvider } from '../../components/toast.js';
import { AddForm } from './add-dialog.js';
import { initialAddForm, toAddMovieRequest, toAddSeriesRequest, validateAddForm } from './add-form.js';
import { profiles, rootFolders } from './test-fixtures.js';

describe('add form logic', () => {
  it('starts from the first root folder of the right media type and the first profile', () => {
    const s = initialAddForm('movie', rootFolders, profiles);
    expect(s.rootFolderPath).toBe('/data/movies');
    expect(s.qualityProfileId).toBe(1);
    expect(s.monitorOption).toBe('all');
    expect(s.minimumAvailability).toBe('released');
  });

  it('prefers remembered choices when they still exist', () => {
    const s = initialAddForm('series', rootFolders, profiles, { rootFolderPath: 'D:\\Media\\TV', qualityProfileId: 2 });
    expect(s).toMatchObject({ rootFolderPath: 'D:\\Media\\TV', qualityProfileId: 2 });
    const stale = initialAddForm('series', rootFolders, profiles, { rootFolderPath: '/gone', qualityProfileId: 99 });
    expect(stale).toMatchObject({ rootFolderPath: '/data/tv', qualityProfileId: 1 });
  });

  it('requires a root folder and a quality profile', () => {
    const empty = initialAddForm('series', [], []);
    expect(validateAddForm(empty)).toEqual({
      rootFolderPath: 'Choose a root folder',
      qualityProfileId: 'Choose a quality profile',
    });
    expect(validateAddForm(initialAddForm('series', rootFolders, profiles))).toEqual({});
  });

  it('maps series state to an AddSeriesRequest; monitor "none" unmonitors the series', () => {
    const s = { ...initialAddForm('series', rootFolders, profiles), monitorOption: 'none' as const, tags: [3], searchOnAdd: true };
    expect(toAddSeriesRequest(42, s)).toEqual({
      tmdbId: 42,
      rootFolderPath: '/data/tv',
      qualityProfileId: 1,
      monitored: false,
      monitorOption: 'none',
      monitorNewItems: 'none',
      seriesType: 'standard',
      seasonFolder: true,
      tags: [3],
      searchOnAdd: true,
    });
  });

  it('maps movie state to an AddMovieRequest', () => {
    const s = { ...initialAddForm('movie', rootFolders, profiles), minimumAvailability: 'inCinemas' as const, monitored: false };
    expect(toAddMovieRequest(7, s)).toEqual({
      tmdbId: 7,
      rootFolderPath: '/data/movies',
      qualityProfileId: 1,
      monitored: false,
      minimumAvailability: 'inCinemas',
      tags: [],
      searchOnAdd: false,
    });
  });
});

describe('AddForm', () => {
  const result: MetadataSearchResult = {
    mediaType: 'series',
    tmdbId: 63639,
    title: 'The Expanse',
    originalTitle: 'The Expanse',
    year: 2015,
    overview: 'Space.',
    originalLanguage: 'en',
    images: {},
    ratings: { tmdb: { value: 8, votes: 10 } },
  };

  let posted: unknown;
  beforeEach(() => {
    posted = undefined;
    localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/v1/tag') return new Response('[]', { status: 200 });
        if (url === '/api/v1/series' && init?.method === 'POST') {
          posted = JSON.parse(String(init.body));
          return new Response(JSON.stringify({ error: 'a series already uses the path', code: 'CONFLICT' }), { status: 409 });
        }
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  function renderForm(roots = rootFolders) {
    const qc = createQueryClient(createToastStore());
    const root = createRootRoute();
    const index = createRoute({
      getParentRoute: () => root,
      path: '/',
      component: () => <AddForm result={result} onClose={() => {}} rootFolders={roots} profiles={profiles} />,
    });
    const router = createRouter({ routeTree: root.addChildren([index]), history: createMemoryHistory({ initialEntries: ['/'] }) });
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider store={createToastStore()}>
          <RouterProvider router={router} />
        </ToastProvider>
      </QueryClientProvider>,
    );
  }

  it('previews the destination path and updates it with the root folder', async () => {
    renderForm();
    const preview = await screen.findByTestId('path-preview');
    expect(preview.textContent).toBe('/data/tv/The Expanse (2015)');
    fireEvent.change(screen.getByLabelText('Root folder'), { target: { value: 'D:\\Media\\TV' } });
    expect(screen.getByTestId('path-preview').textContent).toBe('D:\\Media\\TV\\The Expanse (2015)');
  });

  it('blocks submit and shows errors without a root folder', async () => {
    renderForm([]);
    fireEvent.click(await screen.findByRole('button', { name: /add series/i }));
    expect(await screen.findByText('Choose a root folder')).toBeTruthy();
    expect(posted).toBeUndefined();
  });

  it('posts the request and shows the api error inline', async () => {
    renderForm();
    fireEvent.change(await screen.findByLabelText('Monitor'), { target: { value: 'future' } });
    fireEvent.click(screen.getByRole('button', { name: /add series/i }));
    await waitFor(() => expect(posted).toMatchObject({ tmdbId: 63639, monitorOption: 'future', rootFolderPath: '/data/tv' }));
    expect((await screen.findByRole('alert')).textContent).toContain('already uses the path');
  });
});

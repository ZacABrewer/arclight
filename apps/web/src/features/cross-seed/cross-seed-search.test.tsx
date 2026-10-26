import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { CrossSeedSearchRequest, CrossSeedSearchResult } from '@arclight/shared';
import { ToastProvider } from '../../components/toast.js';
import { createToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { stubApi, type FakeApi } from '../../test/route-harness.js';
import { CrossSeedSearchButton, crossSeedSearchBody, crossSeedSummary } from './cross-seed-search.js';

configure({ asyncUtilTimeout: 4000 });

const auth = vi.hoisted(() => ({ isAdmin: true }));
vi.mock('../../auth/auth-context.js', () => ({ useAuth: () => ({ isAdmin: auth.isAdmin }) }));

const searchResult = CrossSeedSearchResult.parse({
  filesSearched: 2,
  candidates: 3,
  added: [
    {
      id: 11,
      mediaFileId: 5,
      indexerId: 2,
      indexerName: 'TrackerB',
      infoHash: 'a'.repeat(40),
      title: 'Show.S01E01.1080p.WEB-DL-GRP',
      size: 1_500_000_000,
      state: 'seeding',
      message: null,
      downloadClientId: 7,
      savePath: '/downloads/cross-seed',
      addedAt: '2026-10-25T10:00:00.000Z',
    },
  ],
  skipped: [
    { title: 'Show.S01.1080p.WEB-DL-GRP', indexerId: 2, reason: 'season pack' },
    { title: 'Show.S01E01.720p-OTHER', indexerId: 3, reason: 'size differs' },
  ],
});

let api: FakeApi;
let result: CrossSeedSearchResult;

beforeEach(() => {
  auth.isAdmin = true;
  result = searchResult;
  api = stubApi({ 'POST /api/v1/crossseed/search': () => result });
});
afterEach(() => vi.unstubAllGlobals());

function renderButton(target: Parameters<typeof crossSeedSearchBody>[0]) {
  const toasts = createToastStore();
  render(
    <QueryClientProvider client={createQueryClient(toasts)}>
      <ToastProvider store={toasts}>
        <CrossSeedSearchButton target={target} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('cross-seed search', () => {
  it('builds a body with exactly one target that the shared schema accepts', () => {
    for (const target of [{ mediaFileId: 5 }, { seriesId: 2 }, { movieId: 9 }] as const) {
      const body = crossSeedSearchBody(target);
      expect(Object.keys(body)).toHaveLength(1);
      expect(CrossSeedSearchRequest.safeParse(body).success).toBe(true);
    }
    expect(crossSeedSearchBody({ seriesId: 2 })).toEqual({ seriesId: 2 });
  });

  it('summarises the report with plural counts', () => {
    expect(crossSeedSummary(searchResult)).toBe('2 files searched, 3 candidates, 1 added, 2 skipped.');
    expect(crossSeedSummary({ filesSearched: 1, candidates: 1, added: [], skipped: [] })).toBe('1 file searched, 1 candidate, 0 added, 0 skipped.');
  });

  it('posts the target and shows added releases and skip reasons in a modal', async () => {
    renderButton({ seriesId: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'Search cross-seeds' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cross-seed search' });
    expect(api.calls.find((c) => c.path === '/api/v1/crossseed/search')?.body).toEqual({ seriesId: 2 });
    expect(within(dialog).getByText('Show.S01E01.1080p.WEB-DL-GRP')).toBeTruthy();
    expect(within(dialog).getByText('a'.repeat(40))).toBeTruthy();
    expect(within(dialog).getByText('season pack')).toBeTruthy();
    expect(within(dialog).getByText('size differs')).toBeTruthy();
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' }).at(-1)!);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('reports an empty search as a toast instead of a modal', async () => {
    result = { filesSearched: 1, candidates: 0, added: [], skipped: [] };
    renderButton({ mediaFileId: 5 });
    fireEvent.click(screen.getByRole('button', { name: 'Search cross-seeds' }));
    expect(await screen.findByText('No cross-seeds found')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.calls.at(-1)?.body).toEqual({ mediaFileId: 5 });
  });

  it('is hidden for non-admins', () => {
    auth.isAdmin = false;
    renderButton({ movieId: 9 });
    expect(screen.queryByRole('button', { name: 'Search cross-seeds' })).toBeNull();
  });
});

describe('file row actions', () => {
  it('offers Search cross-seeds and Transcode now for the file, posting its mediaFileId', async () => {
    const { MediaFileRowActions } = await import('../transcode/file-row-actions.js');
    result = { filesSearched: 1, candidates: 0, added: [], skipped: [] };
    const toasts = createToastStore();
    render(
      <QueryClientProvider client={createQueryClient(toasts)}>
        <ToastProvider store={toasts}>
          <MediaFileRowActions file={{ id: 77, relativePath: 'Heat (1995).mkv' }} />
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByRole('button', { name: 'Transcode Heat (1995).mkv' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Search cross-seeds for Heat (1995).mkv' }));
    await waitFor(() => expect(api.calls.find((c) => c.path === '/api/v1/crossseed/search')?.body).toEqual({ mediaFileId: 77 }));
  });
});

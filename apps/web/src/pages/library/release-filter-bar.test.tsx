import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { MediaFile, QUALITIES, ReleaseDecision, type QualityName } from '@arclight/shared';
import { ToastProvider } from '../../components/toast.js';
import { createToastStore } from '../../lib/toast.js';
import { createQueryClient } from '../../query-client.js';
import { ReleaseTable } from './interactive-search.js';
import { MediaFilesTable } from './media-files-table.js';

afterEach(() => vi.unstubAllGlobals());

const quality = (name: QualityName) => ({ quality: { ...QUALITIES[name], mediaTypes: [...QUALITIES[name].mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } });

function release(guid: string, title: string, q: QualityName, over: Record<string, unknown> = {}) {
  return ReleaseDecision.parse({
    guid,
    title,
    size: 8 * 1024 ** 3,
    publishDate: '2026-10-01T00:00:00.000Z',
    downloadUrl: `http://x/${guid}`,
    categories: [2000],
    indexerId: 1,
    indexerName: 'Idx',
    indexerPriority: 25,
    protocol: 'torrent',
    seeders: 20,
    age: 3,
    ageHours: 72,
    ageMinutes: 4320,
    rejections: [],
    approved: true,
    temporarilyRejected: false,
    downloadAllowed: true,
    source: 'interactiveSearch',
    movieId: 7,
    quality: quality(q),
    languages: ['English'],
    customFormats: [],
    customFormatScore: 0,
    fullSeason: false,
    ...over,
  });
}

function renderWith(ui: React.ReactNode, fetchImpl: (url: string, init?: RequestInit) => unknown) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = fetchImpl(String(input), init);
    return new Response(JSON.stringify(body ?? null), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  const toasts = createToastStore();
  render(
    <QueryClientProvider client={createQueryClient(toasts)}>
      <ToastProvider store={toasts}>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
  return fetchMock;
}

describe('interactive search filters', () => {
  it('narrows the fetched releases and shows how many are left', async () => {
    const releases = [
      release('a', 'Dune.Part.Two.2024.2160p.WEB-DL', 'WEBDL-2160p'),
      release('b', 'Dune.Part.Two.2024.1080p.BluRay', 'Bluray-1080p', { indexerId: 2, indexerName: 'Other' }),
      release('c', 'Dune.Part.Two.2024.720p.HDTV', 'HDTV-720p', {
        approved: false,
        rejections: [{ reason: 'qualityNotWanted', message: 'Quality not wanted', type: 'permanent' }],
      }),
    ];
    renderWith(<ReleaseTable target={{ movieId: 7 }} />, () => releases);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('3 of 3 releases'));

    fireEvent.change(screen.getByLabelText('Filter releases by title'), { target: { value: 'part two 1080p' } });
    expect(screen.getByRole('status').textContent).toBe('1 of 3 releases');
    expect(screen.getByText('Dune.Part.Two.2024.1080p.BluRay')).toBeTruthy();
    expect(screen.queryByText('Dune.Part.Two.2024.2160p.WEB-DL')).toBeNull();

    fireEvent.change(screen.getByLabelText('Filter releases by title'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Decision'), { target: { value: 'rejected' } });
    expect(screen.getByRole('status').textContent).toBe('1 of 3 releases');
    expect(screen.getByText('Dune.Part.Two.2024.720p.HDTV')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Min seeders'), { target: { value: '50' } });
    expect(screen.getByText('No releases match these filters')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]!);
    expect(screen.getByRole('status').textContent).toBe('3 of 3 releases');
  });
});

describe('kept by choice', () => {
  it('marks a "Grab anyway" file and allows upgrades again', async () => {
    const file = MediaFile.parse({
      id: 41,
      mediaType: 'movie',
      movieId: 7,
      episodeIds: [],
      relativePath: 'Dune (2024).mkv',
      path: '/movies/Dune (2024)/Dune (2024).mkv',
      sizeBytes: 1024,
      dateAdded: '2026-10-01T00:00:00.000Z',
      quality: quality('HDTV-720p'),
      languages: ['en'],
      grabOverride: { rejections: ['Quality not wanted'], grabbedAt: '2026-10-01T00:00:00.000Z' },
    });
    const calls: string[] = [];
    renderWith(<MediaFilesTable files={[file]} error={null} loading={false} mediaType="movie" ownerId={7} />, (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      return url.includes('grab-override') ? { ...file, grabOverride: null } : [];
    });
    expect(screen.getByTestId('kept-by-choice').textContent).toBe('Kept by choice');
    expect(screen.getByRole('button', { name: /Rules you overrode: Quality not wanted/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Allow upgrades again' }));
    await waitFor(() => expect(calls).toContain('DELETE /api/v1/mediafile/41/grab-override'));
  });
});

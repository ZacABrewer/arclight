import { afterEach, describe, expect, it, vi } from 'vitest';
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { MediaFile, Movie, NAMING_DEFAULTS, QUALITIES, WantedEpisode } from '@arclight/shared';
import { MEDIA_MANAGEMENT_WIRE_DEFAULTS } from '../../../api/settings.js';
import { renderAt, stubApi } from '../../../test/route-harness.js';
import { makeEpisode, makeMovie } from '../test-fixtures.js';

configure({ asyncUtilTimeout: 4000 });
afterEach(() => vi.unstubAllGlobals());

const quality = { quality: { ...QUALITIES['WEBDL-2160p'], mediaTypes: [...QUALITIES['WEBDL-2160p'].mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } };

const film = Movie.parse(
  makeMovie({
    id: 7,
    title: 'Dune Part Two',
    hasFile: true,
    movieFileId: 70,
    versions: [
      { tag: 'Standard', qualityProfileId: 1, enabled: true },
      { tag: '4K', qualityProfileId: 2, enabled: true },
    ],
  }),
);

const file = (id: number, versionTag: string | null, relativePath: string) =>
  MediaFile.parse({
    id,
    mediaType: 'movie',
    movieId: 7,
    episodeIds: [],
    relativePath,
    path: `/movies/Dune Part Two/${relativePath}`,
    sizeBytes: 10 * 1024 ** 3,
    dateAdded: '2026-01-01T00:00:00.000Z',
    quality,
    languages: ['English'],
    versionTag,
  });

describe('movie details with versions', () => {
  it('shows a version badge per file and saves edited versions through PUT /movie/:id', async () => {
    const api = stubApi({
      '/api/v1/movie/7': film,
      'PUT /api/v1/movie/7': (init: RequestInit | undefined) => ({ ...film, ...(JSON.parse(String(init?.body)) as object) }),
      '/api/v1/mediafile': [file(70, 'Standard', 'Dune Part Two.mkv'), file(71, '4K', 'Dune Part Two - 4K.mkv')],
      '/api/v1/tag': [],
      '/api/v1/rootfolder': [],
    });
    renderAt('/library/movie/7');
    // Sorted by path: "Dune Part Two - 4K.mkv" before "Dune Part Two.mkv".
    await waitFor(() => expect(screen.getAllByTestId('version-badge').map((b) => b.textContent)).toEqual(['4K', 'Standard']));
    expect(screen.getByRole('columnheader', { name: /Version/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getAllByTestId('version-row')).toHaveLength(2);
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Version 2 wanted' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = api.calls.find((c) => c.method === 'PUT')!;
    expect(put.path).toBe('/api/v1/movie/7');
    expect((put.body as { versions: unknown }).versions).toEqual([
      { tag: 'Standard', qualityProfileId: 1, enabled: true },
      { tag: '4K', qualityProfileId: 2, enabled: false },
    ]);
  });

  it('does not send versions when they were not touched, and refuses to save an invalid tag', async () => {
    const api = stubApi({
      '/api/v1/movie/7': film,
      'PUT /api/v1/movie/7': film,
      '/api/v1/mediafile': [],
      '/api/v1/tag': [],
    });
    renderAt('/library/movie/7');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Tag for version 2'), { target: { value: '4K/HDR' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(within(dialog).getByRole('alert').textContent).toMatch(/must not contain/);
    expect(api.calls.some((c) => c.method === 'PUT')).toBe(false);

    fireEvent.change(within(dialog).getByLabelText('Tag for version 2'), { target: { value: '4K' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(api.calls.find((c) => c.method === 'PUT')!.body).not.toHaveProperty('versions');
  });
});

describe('wanted versions', () => {
  it('adds a Versions column listing the missing slots', async () => {
    const record = WantedEpisode.parse({
      ...makeEpisode({ id: 3, title: 'Half Loop', airDate: '2022-02-25' }),
      seriesTitle: 'Severance',
      seriesTmdbId: 95396,
      qualityProfileId: 1,
      wantedVersions: ['4K', 'HDR'],
    });
    stubApi({ '/api/v1/wanted/missing/episodes': { page: 1, pageSize: 50, totalRecords: 1, records: [record] } });
    renderAt('/wanted/missing');
    expect(await screen.findByRole('group', { name: 'Wanted versions: 4K, HDR' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: /Versions/ })).toBeTruthy();
  });

  it('keeps the classic columns for unversioned items', async () => {
    const record = WantedEpisode.parse({ ...makeEpisode({ id: 3, title: 'Half Loop' }), seriesTitle: 'Severance', seriesTmdbId: 95396, qualityProfileId: 1 });
    stubApi({ '/api/v1/wanted/missing/episodes': { page: 1, pageSize: 50, totalRecords: 1, records: [record] } });
    renderAt('/wanted/missing');
    await screen.findByText('Half Loop');
    expect(screen.queryByRole('columnheader', { name: /Versions/ })).toBeNull();
  });
});

describe('settings: version layout', () => {
  it('previews both layouts and saves naming.versionLayout', async () => {
    const api = stubApi({
      '/api/v1/settings/naming': { ...NAMING_DEFAULTS, renameMovies: true },
      'PUT /api/v1/settings/naming': (init: RequestInit | undefined) => JSON.parse(String(init?.body)) as unknown,
      '/api/v1/settings/mediamanagement': MEDIA_MANAGEMENT_WIRE_DEFAULTS,
      '/api/v1/rootfolder': [],
    });
    renderAt('/settings/mediamanagement');
    const layout = (await screen.findByLabelText('Version layout')) as HTMLSelectElement;
    expect(layout.value).toBe('sideBySide');
    expect(screen.getByTestId('version-sample-movie').textContent).toMatch(/ - 4K\.mkv$/);
    expect(screen.getByText('{Version}')).toBeTruthy();

    fireEvent.change(layout, { target: { value: 'subfolder' } });
    expect(screen.getByTestId('version-sample-movie').textContent).toMatch(/\/4K\/[^/]+\.mkv$/);
    expect(screen.getByTestId('version-sample-movie').textContent).not.toMatch(/ - 4K/);
    fireEvent.click(within(screen.getByRole('region', { name: 'Unsaved changes' })).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(api.calls.find((c) => c.method === 'PUT')!.body).toMatchObject({ versionLayout: 'subfolder' });
  });
});

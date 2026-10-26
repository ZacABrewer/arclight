import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { MetadataCollection, Movie } from '@arclight/shared';
import { renderAt, stubApi } from '../../test/route-harness.js';
import { collectionCounts, missingParts, partAsSearchResult, partStates } from './collection-model.js';
import { makeMovie, rootFolders } from './test-fixtures.js';

const profile = (id: number, name: string) => ({
  id,
  name,
  upgradeAllowed: true,
  cutoff: 3,
  items: [{ kind: 'quality', qualityId: 3, allowed: true }],
  minFormatScore: 0,
  cutoffFormatScore: 0,
  minUpgradeFormatScore: 1,
  formatItems: [],
  languages: [],
});
const profiles = [profile(1, 'HD-1080p'), profile(2, 'Ultra-HD')];

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const dune: MetadataCollection = {
  tmdbId: 726871,
  name: 'Dune Collection',
  overview: 'The Atreides saga.',
  images: { poster: 'https://image.tmdb.org/t/p/w500/p.jpg' },
  parts: [
    { tmdbId: 438631, title: 'Dune', year: 2021, releaseDate: '2021-09-15', overview: '', images: {}, originalLanguage: 'en' },
    { tmdbId: 693134, title: 'Dune: Part Two', year: 2024, releaseDate: '2024-02-27', overview: '', images: {}, originalLanguage: 'en' },
    { tmdbId: 1170608, title: 'Dune: Part Three', overview: '', images: {}, originalLanguage: 'en' },
  ],
};

const movies: Movie[] = [
  makeMovie({ id: 1, title: 'Dune', tmdbId: 438631, year: 2021, hasFile: true, collection: { tmdbId: 726871, title: 'Dune Collection' } }),
  makeMovie({ id: 2, title: 'Alien', tmdbId: 348, year: 1979, hasFile: true, collection: { tmdbId: 8091, title: 'Alien Collection' } }),
  makeMovie({ id: 3, title: 'Aliens', tmdbId: 679, year: 1986, hasFile: false, collection: { tmdbId: 8091, title: 'Alien Collection' } }),
  makeMovie({ id: 4, title: 'Heat', tmdbId: 949, year: 1995 }),
];

describe('collection model', () => {
  it('splits TMDB parts into owned and missing (skipping undated placeholders)', () => {
    const states = partStates(dune, movies);
    expect(states.map((s) => s.movie?.id ?? null)).toEqual([1, null, null]);
    expect(collectionCounts(states)).toEqual({ owned: 1, inLibrary: 1, total: 3 });
    expect(missingParts(states).map((p) => p.title)).toEqual(['Dune: Part Two']);
    expect(partAsSearchResult(dune.parts[1]!)).toMatchObject({ mediaType: 'movie', tmdbId: 693134, year: 2024, releaseDate: '2024-02-27' });
  });
});

describe('Library → Collections', () => {
  it('shows one card per collection with an owned/total meter from TMDB', async () => {
    stubApi({
      '/api/v1/movie': movies,
      '/api/v1/metadata/collection/726871': dune,
      '/api/v1/metadata/collection/8091': { ...dune, tmdbId: 8091, name: 'Alien Collection', parts: dune.parts.slice(0, 2).map((p, i) => ({ ...p, tmdbId: [348, 679][i]!, title: ['Alien', 'Aliens'][i]! })) },
    });
    renderAt('/library/collections');
    const grid = await screen.findByTestId('collection-grid');
    expect(await within(grid).findAllByText('1/2', { selector: '.al-num' })).toHaveLength(2);
    expect(within(grid).getByText('Dune Collection')).toBeTruthy();
    expect(within(grid).getByRole('progressbar', { name: 'Dune Collection: 1 of 2 on disk' })).toBeTruthy();
    expect(within(grid).queryByText('Heat')).toBeNull();
  });

  it('opens a collection, adds a missing part and monitors the rest with the remembered defaults', async () => {
    localStorage.setItem('library.add.defaults.movie', JSON.stringify({ rootFolderPath: '/data/movies', qualityProfileId: 2 }));
    const api = stubApi({
      '/api/v1/movie': movies,
      'POST /api/v1/movie': (init: RequestInit | undefined) => {
        const body = JSON.parse(String(init?.body)) as { tmdbId: number };
        return makeMovie({ id: 10, title: 'Dune: Part Two', tmdbId: body.tmdbId });
      },
      '/api/v1/metadata/collection/726871': dune,
      '/api/v1/rootfolder': rootFolders,
      '/api/v1/qualityprofile': profiles,
      '/api/v1/tag': [],
    });
    renderAt('/library/collections/726871');
    expect(await screen.findByRole('heading', { name: 'Dune Collection' })).toBeTruthy();
    const parts = await screen.findByTestId('collection-parts');
    expect(within(parts).getByText('Downloaded')).toBeTruthy();
    expect(within(parts).getByRole('button', { name: 'Add Dune: Part Two' })).toBeTruthy();
    // Undated placeholders cannot be added yet.
    expect(within(parts).queryByRole('button', { name: 'Add Dune: Part Three' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Monitor collection (1 missing)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Monitor Dune Collection' });
    await waitFor(() => expect((within(dialog).getByLabelText('Root folder') as HTMLSelectElement).value).toBe('/data/movies'));
    expect((within(dialog).getByLabelText('Quality profile') as HTMLSelectElement).value).toBe('2');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add 1 movie' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/movie')?.body).toMatchObject({
        tmdbId: 693134,
        rootFolderPath: '/data/movies',
        qualityProfileId: 2,
        monitored: true,
        searchOnAdd: true,
      }),
    );
  });
});

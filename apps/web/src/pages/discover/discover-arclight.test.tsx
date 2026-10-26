import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { defaultSettings, makeItem, makeTitle, renderAt, season, stubApi } from '../../features/requests/test-utils.js';
import { activeFilterCount } from '../../features/discover/filters.js';
import { statusChipStyle } from './discover-kit.js';
import { sortCredits } from './person-page.js';
import { requestable, titleStatusLabel } from './title-page.js';

afterEach(() => vi.unstubAllGlobals());

const page = (results: unknown[]) => ({ page: 1, totalPages: 1, totalResults: results.length, results });

describe('discover on Arclight', () => {
  it('maps request/availability labels onto kit chip tones only', () => {
    expect(statusChipStyle('Available')).toEqual({ tone: 'accent', dot: 'fill' });
    expect(statusChipStyle('Approved')).toEqual({ tone: 'accent', dot: 'ring' });
    expect(statusChipStyle('Requested')).toEqual({ tone: 'default', dot: 'ring' });
    expect(statusChipStyle('Declined').tone).toBe('danger');
  });

  it('derives the title status chip and what is still requestable', () => {
    expect(titleStatusLabel(makeTitle({ mediaStatus: 'available' }))).toBe('Available');
    expect(titleStatusLabel(makeTitle({ requestStatus: 'pending' }))).toBe('Requested');
    expect(titleStatusLabel(makeTitle({ mediaStatus: 'processing' }))).toBe('Approved');
    expect(titleStatusLabel(makeTitle())).toBeNull();
    const owned = makeTitle({ mediaStatus: 'available', mediaStatus4k: 'unknown' });
    expect(requestable(owned, false)).toBe(false);
    expect(requestable(owned, true)).toBe(true);
  });

  it('counts active filters for the FilterBar Clear button', () => {
    expect(activeFilterCount({})).toBe(0);
    expect(activeFilterCount({ sort: 'popularity.desc', region: 'GB' })).toBe(0);
    expect(activeFilterCount({ genres: '18', from: '1990', sort: 'vote_average.desc' })).toBe(3);
  });

  it('merges crew jobs per title and sorts credits newest first', () => {
    const a = { ...makeItem({ tmdbId: 1, releaseDate: '2001-01-01' }), job: 'Writer' };
    const b = { ...makeItem({ tmdbId: 1, releaseDate: '2001-01-01' }), job: 'Director' };
    const c = { ...makeItem({ tmdbId: 2, title: 'Newer', releaseDate: '2020-01-01' }), job: 'Director' };
    const out = sortCredits([a, b, c]);
    expect(out.map((x) => x.tmdbId)).toEqual([2, 1]);
    expect(out[1]!.job).toBe('Writer, Director');
  });

  it('home sliders link "See all" to the full grid', async () => {
    stubApi({
      '/api/v1/discoverslider': [
        { id: 1, type: 'popularMovies', order: 1, isBuiltIn: true, enabled: true, title: null, data: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      ],
      '/api/v1/discover/slider/1': page([makeItem({ title: 'Big Film' })]),
    });
    renderAt('/discover');
    const section = await screen.findByRole('region', { name: 'Popular movies' });
    expect(await within(section).findByRole('article', { name: 'Big Film' })).toBeTruthy();
    expect(within(section).getByRole('link', { name: 'See all' }).getAttribute('href')).toBe('/discover/movies');
  });

  it('title page shows the Requested chip and opens the 4K request modal with a season table', async () => {
    stubApi({
      '/api/v1/discover/tv/7': makeTitle({
        mediaType: 'series',
        tmdbId: 7,
        title: 'Ships',
        requestStatus: 'pending',
        canRequest4k: true,
        seasons: [season(1, { status4k: 'available' }), season(2, { episodeCount: 8 })],
      }),
      '/api/v1/settings/requests': defaultSettings({ series4k: { enabled: true, rootFolderPath: null, qualityProfileId: null, tags: [] } }),
    });
    renderAt('/discover/tv/7');
    expect(await screen.findByText('Requested')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Request 4K' }));
    const dialog = await screen.findByRole('dialog', { name: 'Request Ships in 4K' });
    const table = within(dialog).getByRole('table');
    await waitFor(() => expect((within(table).getByLabelText('Season 1') as HTMLInputElement).disabled).toBe(true));
    expect(within(table).getByText('8')).toBeTruthy();
    expect(within(table).getByText('Available')).toBeTruthy();
  });

  it('request modal posts the picked seasons', async () => {
    const calls = stubApi(
      {
        '/api/v1/discover/tv/9': makeTitle({ mediaType: 'series', tmdbId: 9, title: 'Rivers', seasons: [season(1), season(2)] }),
        '/api/v1/settings/requests': defaultSettings(),
      },
      (url, method) => (url === '/api/v1/request' && method === 'POST' ? { status: 202, body: { message: 'Queued' } } : undefined),
    );
    renderAt('/discover/tv/9');
    fireEvent.click(await screen.findByRole('button', { name: 'Request' }));
    const dialog = await screen.findByRole('dialog', { name: 'Request Rivers' });
    fireEvent.click(within(dialog).getByLabelText('Season 2'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request 1 season' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/request' && c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.url === '/api/v1/request' && c.method === 'POST')?.body).toMatchObject({ mediaType: 'series', tmdbId: 9, seasons: [2], is4k: false });
  });

  it('person page shows the square headshot frame, facts and credits', async () => {
    stubApi({
      '/api/v1/discover/person/31': {
        tmdbId: 31,
        name: 'Ann Actor',
        biography: 'Works a lot.',
        birthday: '1970-02-03',
        cast: [{ ...makeItem({ tmdbId: 3, title: 'First Role' }), character: 'Hero' }],
        crew: [],
      },
    });
    renderAt('/discover/person/31');
    expect(await screen.findByRole('heading', { level: 1, name: 'Ann Actor' })).toBeTruthy();
    expect(screen.getByText('1970-02-03')).toBeTruthy();
    expect(screen.getByRole('article', { name: 'First Role' })).toBeTruthy();
    expect(screen.getByText('Hero')).toBeTruthy();
    expect(document.querySelector('.mk-headshot')).toBeTruthy();
  });
});

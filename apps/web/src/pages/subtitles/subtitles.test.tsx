import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { SubtitleHistoryRecord, WantedSubtitleItem } from '@arclight/shared';
import { makeMovie } from '../library/test-fixtures.js';
import { initialAddForm, toAddMovieRequest, toAddSeriesRequest } from '../library/add-form.js';
import { profiles, rootFolders } from '../library/test-fixtures.js';
import { isExtractable } from './subtitles-tab.js';
import { languageProfiles, languages, makeSubtitle, mockApi, movieFile, renderAt, type Call } from './test-harness.js';

afterEach(() => vi.unstubAllGlobals());

const base = {
  'GET /health': { status: 'ok', checks: [] },
  'GET /subtitle/languages': languages,
  'GET /languageprofile': languageProfiles,
  'GET /tag': [],
  'GET /qualityprofile': [],
  'GET /mediafile': [],
};

function wanted(over: Partial<WantedSubtitleItem> & { mediaFileId: number }): WantedSubtitleItem {
  return {
    mediaType: 'series',
    seriesId: 3,
    movieId: null,
    episodeIds: [30],
    title: 'The Expanse',
    episodeLabel: 'S01E02',
    episodeTitle: 'The Big Empty',
    path: '/tv/x.mkv',
    languageProfileId: 1,
    missing: [{ language: 'en', forced: false, hi: false }],
    lastSearch: null,
    attempts: 2,
    ...over,
  };
}

const page = <T,>(records: T[]) => ({ page: 1, pageSize: 50, totalRecords: records.length, records });

describe('wanted subtitles page', () => {
  it('lists TV and movie items in tabs and searches one file', async () => {
    const calls = mockApi({
      ...base,
      'GET /subtitle/wanted': (c: Call) =>
        c.url.includes('mediaType=movie')
          ? page([wanted({ mediaFileId: 9, mediaType: 'movie', seriesId: null, movieId: 1, episodeIds: [], title: 'Dune', episodeLabel: null, episodeTitle: null })])
          : page([wanted({ mediaFileId: 8 })]),
      'POST /command/subtitlesearch': { files: 1, searched: 1, downloaded: 1, message: 'Downloaded 1 subtitle' },
    });
    renderAt('/subtitles');
    const search = await screen.findByRole('button', { name: 'Search subtitles for The Expanse S01E02' });
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getAllByTestId('missing-chip').map((c) => c.textContent)).toEqual(['en']);
    fireEvent.click(search);
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ mediaFileId: 8 }));
    expect(calls.find((c) => c.method === 'POST')?.path).toBe('/command/subtitlesearch');

    fireEvent.click(screen.getByRole('tab', { name: 'Movies' }));
    expect(await screen.findByRole('button', { name: 'Search subtitles for Dune' })).toBeTruthy();
    expect(calls.some((c) => c.url === '/api/v1/subtitle/wanted?mediaType=movie&page=1&pageSize=50')).toBe(true);
  });
});

describe('subtitle history page', () => {
  const record: SubtitleHistoryRecord = {
    id: 1,
    action: 'downloaded',
    description: 'English subtitle downloaded',
    language: 'en',
    forced: false,
    hi: true,
    provider: 'podnapisi',
    providerSubtitleId: 'p1',
    score: 300,
    scoreOutOf: 360,
    mediaType: 'series',
    seriesId: 3,
    movieId: null,
    episodeIds: [30],
    mediaFileId: 8,
    title: 'The Expanse S01E02',
    subtitlePath: '/tv/x.en.srt',
    videoPath: '/tv/x.mkv',
    matched: [],
    notMatched: [],
    upgradedFromId: null,
    date: '2026-10-20T00:00:00.000Z',
  };

  it('shows the score as a percent and filters by action', async () => {
    const calls = mockApi({ ...base, 'GET /subtitle/history': page([record]) });
    renderAt('/subtitles/history');
    expect(await screen.findByText('83%')).toBeTruthy();
    expect(screen.getByText('en (HI)')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'upgraded' } });
    await waitFor(() => expect(calls.some((c) => c.path === '/subtitle/history' && c.url.includes('action=upgraded'))).toBe(true));
  });
});

describe('subtitle blacklist page', () => {
  it('removes one entry and clears all after confirming', async () => {
    const rec = {
      id: 5,
      provider: 'addic7ed',
      providerSubtitleId: 'a-5',
      language: 'fr',
      forced: false,
      hi: false,
      mediaType: 'movie' as const,
      seriesId: null,
      movieId: 1,
      mediaFileId: 7,
      title: 'Dune',
      date: '2026-10-20T00:00:00.000Z',
    };
    const calls = mockApi({ ...base, 'GET /subtitle/blacklist': page([rec]) });
    renderAt('/subtitles/blacklist');
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Dune fr from blacklist' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/subtitle/blacklist/5')).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    const dialog = await screen.findByRole('dialog', { name: 'Clear the subtitle blacklist?' });
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/subtitle/blacklist')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/subtitle/blacklist')).toBe(true));
  });
});

describe('movie subtitles tab', () => {
  const movie = makeMovie({ id: 1, title: 'Dune', hasFile: true, languageProfileId: 1 });
  const routes = {
    ...base,
    'GET /movie/1': movie,
    'GET /subtitle/file': [movieFile],
  };

  async function openTab() {
    renderAt('/library/movie/1');
    fireEvent.click(await screen.findByRole('tab', { name: 'Subtitles' }));
    await screen.findByRole('button', { name: 'Manual search Dune.mkv' });
  }

  it('renders present subtitles with embedded/external, forced and HI markers plus missing chips', async () => {
    const calls = mockApi(routes);
    await openTab();
    const chips = screen.getAllByTestId('subtitle-chip');
    expect(chips.map((c) => c.getAttribute('data-kind'))).toEqual(['external', 'embedded']);
    expect(within(chips[0]!).getByTitle('Forced')).toBeTruthy();
    expect(within(chips[1]!).getByTitle('Hearing impaired')).toBeTruthy();
    expect(screen.getAllByTestId('missing-chip').map((c) => c.textContent)).toEqual(['de']);
    expect(calls.some((c) => c.url === '/api/v1/subtitle/file?movieId=1')).toBe(true);

    // External: sync / blacklist / delete; embedded text track: extract.
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for French (forced) external subtitle' }));
    expect(screen.getByRole('button', { name: 'Blacklist' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sync' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/subtitle/sync/11')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Actions for English (HI) embedded subtitle' }));
    fireEvent.click(screen.getByRole('button', { name: 'Extract' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/subtitle/extract/12')).toBe(true));
  });

  it('downloads a candidate from the manual search modal', async () => {
    const calls = mockApi({
      ...routes,
      'GET /subtitle/search': {
        results: [
          {
            key: 'k1',
            provider: 'podnapisi',
            providerSubtitleId: 'p-9',
            language: 'de',
            forced: false,
            hi: false,
            releaseInfo: ['Dune.2021.1080p.WEB'],
            uploader: 'sam',
            score: 162,
            scoreWithoutHash: 162,
            scoreOutOf: 180,
            percent: 90,
            matches: ['title', 'year'],
            dontMatches: ['source'],
            url: null,
            hashVerifiable: false,
            hiVerifiable: true,
          },
        ],
        errors: [],
        throttled: [],
        allThrottled: false,
      },
      'POST /subtitle/download': makeSubtitle({ id: 20, language: 'de' }),
    });
    await openTab();
    fireEvent.click(screen.getByRole('button', { name: 'Manual search Dune.mkv' }));
    const dialog = await screen.findByRole('dialog', { name: 'Manual search · Dune.mkv' });
    expect(await within(dialog).findByText('90%')).toBeTruthy();
    expect(within(dialog).getByText('Dune.2021.1080p.WEB')).toBeTruthy();
    expect(within(dialog).getByText('title, year')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Download podnapisi de p-9' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/subtitle/download')?.body).toEqual({ mediaFileId: 7, key: 'k1' }));
  });

  it('uploads a subtitle as multipart form data', async () => {
    const calls = mockApi({ ...routes, 'POST /subtitle/upload': makeSubtitle({ id: 21, language: 'de', hi: true }) });
    await openTab();
    fireEvent.click(screen.getByRole('button', { name: 'Upload subtitle Dune.mkv' }));
    const dialog = await screen.findByRole('dialog', { name: 'Upload subtitle · Dune.mkv' });
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['1\n00:00:01,000 --> 00:00:02,000\nHallo'], 'Dune.de.srt')] } });
    expect((within(dialog).getByLabelText('Language') as HTMLSelectElement).value).toBe('de');
    fireEvent.click(within(dialog).getByLabelText('Hearing impaired'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Upload' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/subtitle/upload')).toBe(true));
    const call = calls.find((c) => c.path === '/subtitle/upload')!;
    expect(call.body).toBeInstanceOf(FormData);
    const form = call.body as FormData;
    expect(form.get('mediaFileId')).toBe('7');
    expect(form.get('language')).toBe('de');
    expect(form.get('forced')).toBe('false');
    expect(form.get('hi')).toBe('true');
    expect((form.get('file') as File).name).toBe('Dune.de.srt');
    expect(new Headers(call.init?.headers).get('content-type')).toBeNull();
  });

  it('sets the language profile from the edit dialog', async () => {
    const calls = mockApi({ ...routes, 'PUT /movie/1': (c: Call) => ({ ...movie, ...(c.body as object) }) });
    renderAt('/library/movie/1');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Dune' });
    const select = within(dialog).getByLabelText('Language profile') as HTMLSelectElement;
    await waitFor(() => expect(within(select).getByRole('option', { name: 'Euro' })).toBeTruthy());
    expect(select.value).toBe('1');
    fireEvent.change(select, { target: { value: '2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ languageProfileId: 2 }));
  });
});

describe('subtitle helpers', () => {
  it('only offers extraction for embedded text tracks', () => {
    expect(isExtractable(makeSubtitle({ id: 1, embedded: true, streamIndex: 1, codec: 'subrip', path: null }))).toBe(true);
    expect(isExtractable(makeSubtitle({ id: 2, embedded: true, streamIndex: 1, codec: 'hdmv_pgs_subtitle', path: null }))).toBe(false);
    expect(isExtractable(makeSubtitle({ id: 3 }))).toBe(false);
  });

  it('omits languageProfileId from add requests for "Default" and sends null for None', () => {
    const s = initialAddForm('series', rootFolders, profiles);
    expect(s.languageProfileId).toBe('default');
    expect(toAddSeriesRequest(1, s)).not.toHaveProperty('languageProfileId');
    expect(toAddSeriesRequest(1, { ...s, languageProfileId: null }).languageProfileId).toBeNull();
    expect(toAddMovieRequest(1, { ...initialAddForm('movie', rootFolders, profiles), languageProfileId: 2 }).languageProfileId).toBe(2);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api, page, renderBrowse, stubFetch, type Call } from '../browse/test-utils.js';
import { setVideoLauncher, type VideoLauncher } from './video-launcher.js';
import { tidyCode } from './link-page.js';
import { emptyHome, episode, movie, movieDetails, series, seriesDetails } from './test-fixtures.js';

let restore: (() => void) | null = null;
let launched: Array<{ itemKey: string; opts: Parameters<VideoLauncher>[1] }> = [];

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  launched = [];
  // Every play button goes through openVideo: record instead of navigating.
  restore = setVideoLauncher((itemKey, opts) => {
    launched.push({ itemKey, opts });
  });
});
afterEach(() => {
  restore?.();
  vi.unstubAllGlobals();
});

const lastQuery = (calls: Call[], path: string) => [...calls].reverse().find((c) => c.path === path)?.search;

describe('WatchHomePage', () => {
  it('shows continue watching and recent shelves, and resumes from a card', async () => {
    stubFetch({
      [api('/video/home')]: emptyHome({
        continueWatching: [
          {
            itemKey: 'movie:3',
            kind: 'movie',
            id: 3,
            title: 'Halfway Film',
            subtitle: null,
            year: 2020,
            posterUrl: null,
            backdropUrl: null,
            thumbUrl: null,
            progress: { positionMs: 1_800_000, durationMs: 6_000_000, played: false },
            badges: [],
          },
        ],
        recentMovies: [
          { itemKey: 'movie:4', kind: 'movie', id: 4, title: 'New Film', subtitle: null, year: 2026, posterUrl: null, backdropUrl: null, thumbUrl: null, progress: null, badges: ['4K'] },
        ],
        genres: ['Drama'],
      }),
    });
    renderBrowse('/player/watch');
    expect(await screen.findByRole('heading', { name: 'Continue watching' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Recently added movies' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Halfway Film/ }));
    expect(launched[0]).toMatchObject({ itemKey: 'movie:3', opts: { startMs: 1_800_000 } });
  });

  it('shows the empty state', async () => {
    stubFetch({ [api('/video/home')]: emptyHome() });
    renderBrowse('/player/watch');
    expect(await screen.findByText('Nothing to watch yet')).toBeTruthy();
  });
});

describe('MoviesPage', () => {
  it('lists movies with links and sends sort, genre, watched and letter filters', async () => {
    const calls = stubFetch({ [api('/movies')]: page([movie(1, { title: 'Alpha' }), movie(2, { title: 'Beta', genres: ['Sci-Fi'] })]) });
    renderBrowse('/player/watch/movies');
    const list = await screen.findByRole('list', { name: 'Movies' });
    expect(within(list).getByRole('link', { name: /Alpha/ }).getAttribute('href')).toBe('/player/watch/movies/1');
    expect(lastQuery(calls, api('/movies'))?.get('sort')).toBe('title');

    await userEvent.selectOptions(screen.getByRole('combobox', { name: /Sort/ }), 'added');
    await waitFor(() => expect(lastQuery(calls, api('/movies'))?.get('sort')).toBe('added'));
    expect(lastQuery(calls, api('/movies'))?.get('order')).toBe('desc');

    await userEvent.selectOptions(screen.getByRole('combobox', { name: /Genre/ }), 'Sci-Fi');
    await waitFor(() => expect(lastQuery(calls, api('/movies'))?.get('genre')).toBe('Sci-Fi'));

    const watched = screen.getByRole('group', { name: 'Watched filter' });
    await userEvent.click(within(watched).getByRole('button', { name: 'Unwatched' }));
    await waitFor(() => expect(lastQuery(calls, api('/movies'))?.get('watched')).toBe('unwatched'));
    expect(within(watched).getByRole('button', { name: 'Unwatched' }).getAttribute('aria-pressed')).toBe('true');

    await userEvent.click(screen.getByRole('button', { name: 'Starts with B' }));
    await waitFor(() => expect(lastQuery(calls, api('/movies'))?.get('letter')).toBe('B'));
  });

  it('plays a movie from its card through openVideo', async () => {
    stubFetch({ [api('/movies')]: page([movie(1, { title: 'Alpha' })]) });
    renderBrowse('/player/watch/movies');
    await userEvent.click(await screen.findByRole('button', { name: 'Play Alpha' }));
    expect(launched[0]?.itemKey).toBe('movie:1');
  });

  it('remembers the poster size', async () => {
    stubFetch({ [api('/movies')]: page([movie(1)]) });
    renderBrowse('/player/watch/movies');
    const list = await screen.findByRole('list', { name: 'Movies' });
    expect(list.getAttribute('data-density')).toBe('m');
    await userEvent.click(within(screen.getByRole('group', { name: 'Poster size' })).getByRole('button', { name: 'L' }));
    await waitFor(() => expect(screen.getByRole('list', { name: 'Movies' }).getAttribute('data-density')).toBe('l'));
  });

  it('says when there are no movies', async () => {
    stubFetch({ [api('/movies')]: page([]) });
    renderBrowse('/player/watch/movies');
    expect(await screen.findByText('No movies yet')).toBeTruthy();
  });
});

describe('MovieDetailsPage', () => {
  it('plays from the start when there is no saved place, and marks watched', async () => {
    const calls = stubFetch({
      [api('/movies/5')]: movieDetails(5, { title: 'Fifth Film' }),
      [`POST ${api('/watched')}`]: { updated: 1 },
    });
    renderBrowse('/player/watch/movies/5');
    expect(await screen.findByRole('heading', { name: /Fifth Film/ })).toBeTruthy();
    expect(screen.getByText('Example Studio')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(launched[0]).toMatchObject({ itemKey: 'movie:5', opts: { restart: true } });
    await userEvent.click(screen.getByRole('button', { name: 'Mark watched' }));
    await waitFor(() => expect(calls.find((c) => c.path === api('/watched'))?.body).toEqual({ itemKeys: ['movie:5'], played: true }));
  });

  it('offers resume and restart, and passes the chosen version', async () => {
    const v = movieDetails(6).versions[0]!;
    stubFetch({
      [api('/movies/6')]: movieDetails(6, {
        runtimeMinutes: 100,
        progress: { positionMs: 3_000_000, durationMs: 6_000_000, played: false },
        versions: [
          { ...v, label: '4K HDR', mediaFileId: 601 },
          { ...v, label: '1080p', mediaFileId: 602 },
        ],
      }),
    });
    renderBrowse('/player/watch/movies/6');
    const versions = await screen.findByRole('radiogroup', { name: 'Versions' });
    await userEvent.click(within(versions).getByRole('radio', { name: /^1080p/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Resume from 50:00' }));
    expect(launched[0]).toMatchObject({ itemKey: 'movie:6', opts: { startMs: 3_000_000, mediaFileId: 602 } });
    await userEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(launched[1]).toMatchObject({ opts: { restart: true, mediaFileId: 602 } });
  });
});

describe('ShowDetailsPage', () => {
  it('lists seasons and episodes, plays next up, and marks a season and an episode', async () => {
    const calls = stubFetch({
      [api('/series/9')]: seriesDetails(9, { title: 'Ninth Show' }),
      [`POST ${api('/watched')}`]: { updated: 1 },
    });
    renderBrowse('/player/watch/shows/9');
    expect(await screen.findByRole('heading', { name: /Ninth Show/ })).toBeTruthy();
    const tabs = screen.getByRole('tablist', { name: 'Seasons' });
    expect(within(tabs).getAllByRole('tab')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Play S1 · E2' })).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Play S1 · E2' }));
    expect(launched[0]).toMatchObject({ itemKey: 'episode:42', opts: { restart: true } });

    await userEvent.click(screen.getByRole('button', { name: 'Mark Episode title 42 watched' }));
    await waitFor(() => expect(calls.filter((c) => c.path === api('/watched')).at(-1)?.body).toEqual({ itemKeys: ['episode:42'], played: true }));

    await userEvent.click(screen.getByRole('button', { name: 'Mark season watched' }));
    await waitFor(() => expect(calls.filter((c) => c.path === api('/watched')).at(-1)?.body).toEqual({ seriesId: 9, seasonNumber: 1, played: true }));

    await userEvent.click(within(tabs).getByRole('tab', { name: /Season 2/ }));
    expect(await screen.findByRole('button', { name: /Play S2 · E1 · Episode title 43/ })).toBeTruthy();
  });

  it('resumes an episode in progress', async () => {
    stubFetch({
      [api('/series/9')]: seriesDetails(9, {
        seasons: [
          {
            seasonNumber: 1,
            title: 'Season 1',
            episodeCount: 1,
            playedCount: 0,
            episodes: [episode(50, 1, 1, { progress: { positionMs: 600_000, durationMs: 1_800_000, played: false } })],
          },
        ],
        nextUp: 'episode:50',
      }),
    });
    renderBrowse('/player/watch/shows/9');
    await userEvent.click(await screen.findByRole('button', { name: /Resume S1 · E1 · Episode title 50/ }));
    expect(launched[0]).toMatchObject({ itemKey: 'episode:50', opts: { startMs: 600_000 } });
  });
});

describe('SignInTvPage', () => {
  it('tidies typed codes', () => {
    expect(tidyCode('abcd')).toBe('ABCD');
    expect(tidyCode('abcdefgh')).toMatch(/^ABCD-EFGH$|^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it('prefills the code from the link and approves it', async () => {
    const calls = stubFetch({ [`POST /api/v1/app/device-codes/approve`]: { deviceName: 'Living room TV', platform: 'android-tv' } });
    renderBrowse('/player/link?code=wxyz-2345');
    const input = await screen.findByRole('textbox', { name: 'Code on the TV' });
    expect((input as HTMLInputElement).value).toBe(tidyCode('wxyz-2345'));
    await userEvent.click(screen.getByRole('button', { name: 'Sign in the TV' }));
    expect(await screen.findByText('TV signed in')).toBeTruthy();
    expect(screen.getByText('Living room TV is now signed in with your account.')).toBeTruthy();
    expect(calls.find((c) => c.path === '/api/v1/app/device-codes/approve')?.body).toEqual({ userCode: tidyCode('wxyz-2345').replace('-', '') });
  });

  it('explains an expired code', async () => {
    stubFetch({ [`POST /api/v1/app/device-codes/approve`]: () => new Response(JSON.stringify({ error: 'expired', code: 'NOT_FOUND' }), { status: 404 }) });
    renderBrowse('/player/link');
    await userEvent.type(await screen.findByRole('textbox', { name: 'Code on the TV' }), 'WXYZ2345');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in the TV' }));
    expect((await screen.findByRole('alert')).textContent).toContain('expired');
  });
});

describe('search', () => {
  it('shows movies and shows in the results', async () => {
    stubFetch({
      [api('/search')]: {
        artists: [],
        albums: [],
        tracks: [],
        audiobooks: [],
        movies: [movie(1, { title: 'Found Film' })],
        series: [series(2, { title: 'Found Show' })],
      },
    });
    renderBrowse('/player/search');
    await userEvent.type(await screen.findByRole('searchbox'), 'found');
    expect(await screen.findByRole('link', { name: /Found Film/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Found Show/ }).getAttribute('href')).toBe('/player/watch/shows/2');
  });
});

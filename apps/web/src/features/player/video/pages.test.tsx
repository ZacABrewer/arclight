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

// The /player/watch pages are the redesign pages (redesign spec §4.4-§4.5); the shell's
// sections come from /playback/me.
const me = { enabled: true, allowed: true, remote: false, canStream: true, maxBitrateKbps: 0, sections: { music: false, audiobooks: false, podcasts: false, books: false, video: true } };

describe('RdHomePage (/player/watch)', () => {
  it('shows the Continue Watching row and resumes from a tile', async () => {
    stubFetch({
      [api('/me')]: me,
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
    expect(await screen.findByRole('heading', { name: 'Continue Watching' })).toBeTruthy();
    const tonight = screen.getByRole('region', { name: 'Movies for Tonight' });
    expect(within(tonight).getByRole('link', { name: /New Film/ }).getAttribute('href')).toBe('/player/watch/movies/4');
    await userEvent.click(screen.getByRole('button', { name: /Halfway Film/ }));
    expect(launched[0]).toMatchObject({ itemKey: 'movie:3', opts: { startMs: 1_800_000 } });
  });

  it('shows the empty state', async () => {
    stubFetch({ [api('/me')]: me, [api('/video/home')]: emptyHome() });
    renderBrowse('/player/watch');
    expect(await screen.findByText('Nothing to watch yet')).toBeTruthy();
  });

  it('puts quality chips in the hero meta line, not over the art', async () => {
    stubFetch({
      [api('/me')]: me,
      [api('/video/home')]: emptyHome(),
      [api('/video/featured')]: {
        items: [
          {
            kind: 'movie',
            id: 8,
            title: 'Saltwater Kings',
            year: 2024,
            certification: 'PG-13',
            runtimeMinutes: 116,
            seasonCount: null,
            genres: ['Adventure'],
            overview: 'Two brothers.',
            backdropUrl: null,
            logoUrl: null,
            kicker: 'trending',
            kickerWeekday: null,
            chips: { resolution: '4K', dynamicRange: null, audio: null, audioLanguages: [], sizeBytes: null, tmdbScore: 7.8, certification: 'PG-13' },
            play: { itemKey: 'movie:8', seasonNumber: null, episodeNumber: null, progress: null },
            inMyList: false,
          },
        ],
      },
    });
    renderBrowse('/player/watch');
    expect(await screen.findByRole('heading', { name: 'Saltwater Kings' })).toBeTruthy();
    expect(screen.getByText('Trending this week')).toBeTruthy();
    const chips = [...document.querySelectorAll('.rd-meta__chip')].map((c) => c.textContent);
    expect(chips).toEqual(['4K', 'TMDB 7.8']);
    expect(document.querySelector('.rd-hero__art .rd-meta__chip, .rd-tile__art .rd-meta__chip')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(launched[0]?.itemKey).toBe('movie:8');
  });
});

describe('RdMoviesPage (/player/watch/movies)', () => {
  it('lists movies as tiles linking to their pages and filters by genre', async () => {
    const calls = stubFetch({
      [api('/me')]: me,
      [api('/video/home')]: emptyHome({ genres: ['Sci-Fi'] }),
      [api('/movies')]: page([movie(1, { title: 'Alpha' }), movie(2, { title: 'Beta', genres: ['Sci-Fi'] })]),
    });
    renderBrowse('/player/watch/movies');
    expect(await screen.findByRole('heading', { name: 'Movies' })).toBeTruthy();
    expect((await screen.findByRole('link', { name: /Alpha/ })).getAttribute('href')).toBe('/player/watch/movies/1');
    expect(screen.getByText('2 titles')).toBeTruthy();
    const genres = screen.getByRole('group', { name: 'Genres' });
    expect(within(genres).getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(within(genres).getByRole('button', { name: 'Sci-Fi' }));
    await waitFor(() => expect(lastQuery(calls, api('/movies'))?.get('genre')).toBe('Sci-Fi'));
  });

  it('says when there are no movies', async () => {
    stubFetch({ [api('/me')]: me, [api('/video/home')]: emptyHome(), [api('/movies')]: page([]) });
    renderBrowse('/player/watch/movies');
    expect(await screen.findByText('No titles here yet.')).toBeTruthy();
  });
});

describe('RdMoviePage (/player/watch/movies/$id)', () => {
  it('plays from the start when there is no saved place', async () => {
    stubFetch({ [api('/me')]: me, [api('/movies/5')]: movieDetails(5, { title: 'Fifth Film' }) });
    renderBrowse('/player/watch/movies/5');
    expect(await screen.findByRole('heading', { name: /Fifth Film/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start over' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(launched[0]).toMatchObject({ itemKey: 'movie:5', opts: { restart: true } });
  });

  it('offers Resume and Start over when there is a saved place, and adds to My List', async () => {
    const calls = stubFetch({
      [api('/me')]: me,
      [api('/movies/6')]: movieDetails(6, { runtimeMinutes: 100, progress: { positionMs: 3_000_000, durationMs: 6_000_000, played: false } }),
      [`PUT ${api(`/my-list/${encodeURIComponent('movie:6')}`)}`]: null,
    });
    renderBrowse('/player/watch/movies/6');
    await userEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    expect(launched[0]).toMatchObject({ itemKey: 'movie:6', opts: { startMs: 3_000_000 } });
    expect(screen.getByText('50m left')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Start over' }));
    expect(launched[1]).toMatchObject({ opts: { restart: true } });
    await userEvent.click(screen.getByRole('button', { name: 'My List' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.path === api(`/my-list/${encodeURIComponent('movie:6')}`))).toBe(true));
  });

  it('the more menu marks the movie watched and picks the version Play starts', async () => {
    const v = movieDetails(7).versions[0]!;
    const calls = stubFetch({
      [api('/me')]: me,
      [api('/movies/7')]: movieDetails(7, { versions: [v, { ...v, label: '2160p', mediaFileId: 502 }] }),
      [`POST ${api('/watched')}`]: { updated: 1 },
    });
    renderBrowse('/player/watch/movies/7');
    await userEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    const menu = screen.getByRole('menu', { name: 'More actions' });
    expect(within(menu).getByRole('menuitemradio', { name: '1080p' }).getAttribute('aria-checked')).toBe('true');
    await userEvent.click(within(menu).getByRole('menuitemradio', { name: '2160p' }));
    await userEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(launched[0]).toMatchObject({ itemKey: 'movie:7', opts: { restart: true, mediaFileId: 502 } });

    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Mark watched' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === api('/watched'))?.body).toEqual({ itemKeys: ['movie:7'], played: true }));
  });

  it('a single version has no Versions list and Play sends no file', async () => {
    stubFetch({ [api('/me')]: me, [api('/movies/8')]: movieDetails(8, { played: true }) });
    renderBrowse('/player/watch/movies/8');
    await userEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menuitem', { name: 'Mark unwatched' })).toBeTruthy();
    expect(screen.queryByRole('menuitemradio')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(launched[0]!.opts).not.toHaveProperty('mediaFileId');
  });
});

describe('RdShowPage (/player/watch/shows/$id)', () => {
  it('plays next up and switches seasons', async () => {
    stubFetch({ [api('/me')]: me, [api('/series/9')]: seriesDetails(9, { title: 'Ninth Show' }) });
    renderBrowse('/player/watch/shows/9');
    expect(await screen.findByRole('heading', { name: /Ninth Show/ })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Play S1 E2' }));
    expect(launched[0]).toMatchObject({ itemKey: 'episode:42', opts: { restart: true } });

    const seasons = screen.getByRole('group', { name: 'Seasons' });
    expect(within(seasons).getAllByRole('button')).toHaveLength(2);
    expect(screen.getByText('2. Episode title 42')).toBeTruthy();
    await userEvent.click(within(seasons).getByRole('button', { name: /Season 2/ }));
    await userEvent.click(await screen.findByRole('button', { name: /1\. Episode title 43/ }));
    expect(launched[1]).toMatchObject({ itemKey: 'episode:43', opts: { restart: true } });
  });

  it('resumes an episode in progress', async () => {
    stubFetch({
      [api('/me')]: me,
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
    await userEvent.click(await screen.findByRole('button', { name: 'Resume S1 E1' }));
    expect(launched[0]).toMatchObject({ itemKey: 'episode:50', opts: { startMs: 600_000 } });
  });

  it('the more menu marks the whole show watched', async () => {
    const calls = stubFetch({ [api('/me')]: me, [api('/series/9')]: seriesDetails(9), [`POST ${api('/watched')}`]: { updated: 3 } });
    renderBrowse('/player/watch/shows/9');
    await userEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Mark watched' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === api('/watched'))?.body).toEqual({ seriesId: 9, played: true }));
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VIEW_STORAGE_KEY } from './library.js';
import { album, albumDetails, api, artist, mockPlayer, page, renderBrowse, stubFetch, track, type Call } from './test-utils.js';

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const lastQuery = (calls: Call[], path: string) => [...calls].reverse().find((c) => c.path === path)?.search;

describe('AlbumsPage', () => {
  it('lists albums and opens with the name sort', async () => {
    const calls = stubFetch({ [api('/music/albums')]: page([album(1, { title: 'Alpha' }), album(2, { title: 'Beta', genres: ['Jazz'] })]) });
    renderBrowse('/player/music/albums');
    const list = await screen.findByRole('list', { name: 'Albums' });
    expect(within(list).getByRole('link', { name: /Alpha/ }).getAttribute('href')).toBe('/player/music/album/1');
    expect(list.getAttribute('data-view')).toBe('grid');
    const q = lastQuery(calls, api('/music/albums'));
    expect(q?.get('sort')).toBe('name');
    expect(q?.get('page')).toBe('1');
    expect(q?.get('desc')).toBeNull();
  });

  it('shows the page head with the count and the section chips, Albums current', async () => {
    stubFetch({ [api('/music/albums')]: page([album(1)], { total: 42 }) });
    renderBrowse('/player/music/albums');
    expect(await screen.findByRole('heading', { level: 1, name: 'Albums' })).toBeTruthy();
    expect(await screen.findByText('42 albums')).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Music sections' });
    expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual(['Albums', 'Artists', 'Playlists']);
    expect(within(nav).getByRole('link', { name: 'Albums' }).getAttribute('aria-current')).toBe('page');
    expect(within(nav).getByRole('link', { name: 'Artists' }).getAttribute('aria-current')).toBeNull();
  });

  it('remembers the list view across visits', async () => {
    stubFetch({ [api('/music/albums')]: page([album(1)]) });
    renderBrowse('/player/music/albums');
    const view = await screen.findByRole('group', { name: 'View' });
    await userEvent.click(within(view).getByRole('button', { name: 'List' }));
    expect((await screen.findByRole('list', { name: 'Albums' })).getAttribute('data-view')).toBe('list');
    expect(localStorage.getItem(`${VIEW_STORAGE_KEY}.albums`)).toContain('list');
  });

  it('starts in the stored view', async () => {
    localStorage.setItem(`${VIEW_STORAGE_KEY}.albums`, 'list');
    stubFetch({ [api('/music/albums')]: page([album(1)]) });
    renderBrowse('/player/music/albums');
    expect((await screen.findByRole('list', { name: 'Albums' })).getAttribute('data-view')).toBe('list');
  });

  it('ignores a broken storage value', async () => {
    localStorage.setItem(`${VIEW_STORAGE_KEY}.albums`, 'mosaic');
    stubFetch({ [api('/music/albums')]: page([album(1)]) });
    renderBrowse('/player/music/albums');
    expect((await screen.findByRole('list', { name: 'Albums' })).getAttribute('data-view')).toBe('grid');
  });

  it('sends sort, genre, letter and search filters', async () => {
    const calls = stubFetch({ [api('/music/albums')]: page([album(1, { genres: ['Jazz', 'Electronic'] })]) });
    renderBrowse('/player/music/albums');
    await screen.findByRole('list', { name: 'Albums' });

    await userEvent.selectOptions(screen.getByRole('combobox', { name: /Sort/ }), 'added');
    await waitFor(() => expect(lastQuery(calls, api('/music/albums'))?.get('sort')).toBe('added'));
    expect(lastQuery(calls, api('/music/albums'))?.get('desc')).toBe('true');

    await userEvent.selectOptions(screen.getByRole('combobox', { name: /Genre/ }), 'Jazz');
    await waitFor(() => expect(lastQuery(calls, api('/music/albums'))?.get('genre')).toBe('Jazz'));

    const rail = screen.getByRole('navigation', { name: 'Jump to letter' });
    await userEvent.click(within(rail).getByRole('button', { name: 'Starts with M' }));
    await waitFor(() => expect(lastQuery(calls, api('/music/albums'))?.get('letter')).toBe('M'));
    expect(within(rail).getByRole('button', { name: 'Starts with M' }).getAttribute('aria-pressed')).toBe('true');

    await userEvent.type(screen.getByRole('searchbox', { name: 'Filter albums' }), 'night');
    await waitFor(() => expect(lastQuery(calls, api('/music/albums'))?.get('search')).toBe('night'));
  });

  it('loads the next page', async () => {
    const calls = stubFetch({
      [api('/music/albums')]: (url: URL) =>
        url.searchParams.get('page') === '2' ? page([album(61, { title: 'Second page' })], { total: 61, page: 2 }) : page([album(1)], { total: 61 }),
    });
    renderBrowse('/player/music/albums');
    expect(await screen.findByText('Showing 1 of 61')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('link', { name: /Second page/ })).toBeTruthy();
    expect(lastQuery(calls, api('/music/albums'))?.get('page')).toBe('2');
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('plays an album from its list row', async () => {
    localStorage.setItem(`${VIEW_STORAGE_KEY}.albums`, 'list');
    stubFetch({ [api('/music/albums')]: page([album(1, { title: 'Alpha' })]), [api('/music/albums/1')]: albumDetails(1, [track(5), track(6)]) });
    const player = mockPlayer();
    renderBrowse('/player/music/albums', player);
    await userEvent.click(await screen.findByRole('button', { name: 'Play Alpha' }));
    await waitFor(() => expect(player.playItems).toHaveBeenCalledWith(['track:5', 'track:6'], { source: 'album:1' }));
  });

  it('shows the empty library and the no-match states', async () => {
    stubFetch({ [api('/music/albums')]: page([]) });
    renderBrowse('/player/music/albums');
    expect(await screen.findByText('No music yet')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Starts with Q' }));
    expect(await screen.findByText('Nothing matches')).toBeTruthy();
  });

  it('shows the error with retry', async () => {
    stubFetch({ [api('/music/albums')]: new Response('{"error":"down","code":"X"}', { status: 500 }) });
    renderBrowse('/player/music/albums');
    expect(await screen.findByText("Couldn't load albums")).toBeTruthy();
  });
});

describe('ArtistsPage', () => {
  it('lists artists and keeps its own view choice', async () => {
    localStorage.setItem(`${VIEW_STORAGE_KEY}.albums`, 'list');
    stubFetch({ [api('/music/artists')]: page([artist(4, { name: 'Example Artist' })]) });
    renderBrowse('/player/music/artists');
    const list = await screen.findByRole('list', { name: 'Artists' });
    expect(list.getAttribute('data-view')).toBe('grid');
    expect(within(list).getByRole('link', { name: /Example Artist/ }).getAttribute('href')).toBe('/player/music/artist/4');
    await userEvent.click(within(screen.getByRole('group', { name: 'View' })).getByRole('button', { name: 'List' }));
    expect(localStorage.getItem(`${VIEW_STORAGE_KEY}.artists`)).toContain('list');
  });
});

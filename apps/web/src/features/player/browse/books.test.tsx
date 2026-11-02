import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api, book, bookDetails, emptyBookHome, mockPlayer, page, progress, renderBrowse, stubFetch } from './test-utils.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const halfway = progress('audiobook:3', { positionMs: 18_000_000, durationMs: 36_000_000 });

describe('BooksHomePage', () => {
  it('shows the shelves and resumes a book in progress', async () => {
    stubFetch({
      [api('/audiobooks/home')]: {
        ...emptyBookHome,
        continueListening: [book(3, { title: 'Long Road', progress: halfway })],
        recentlyAdded: [book(4, { title: 'Fresh One' })],
        series: [{ id: 1, title: 'Star Maps', books: [book(5, { title: 'Map One', seriesTitle: 'Star Maps', seriesPosition: '1' })] }],
        finished: [book(6, { title: 'Done Deal', progress: progress('audiobook:6', { played: true }) })],
      },
      [api('/audiobooks')]: page([book(3, { title: 'Long Road' }), book(4, { title: 'Fresh One' })]),
    });
    const player = mockPlayer();
    renderBrowse('/player/books', player);

    expect(await screen.findByRole('heading', { name: 'Continue listening' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Series: Star Maps' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Finished' })).toBeTruthy();
    expect(screen.getAllByText('5 h 0 m left').length).toBeGreaterThan(0);

    const resume = screen.getAllByRole('button', { name: 'Resume Long Road' })[0]!;
    await userEvent.click(resume);
    expect(player.playItem).toHaveBeenCalledWith('audiobook:3');

    const all = await screen.findByRole('list', { name: 'All audiobooks' });
    expect(within(all).getByRole('link', { name: /Fresh One/ }).getAttribute('href')).toBe('/player/books/4');
  });

  it('searches and sorts the full list', async () => {
    const calls = stubFetch({ [api('/audiobooks/home')]: emptyBookHome, [api('/audiobooks')]: page([book(1)]) });
    renderBrowse('/player/books');
    await screen.findByRole('list', { name: 'All audiobooks' });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /Sort/ }), 'artist');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search titles, authors and narrators' }), 'writer');
    await waitFor(() => {
      const q = [...calls].reverse().find((c) => c.path === api('/audiobooks'))?.search;
      expect(q?.get('search')).toBe('writer');
      expect(q?.get('sort')).toBe('artist');
    });
  });

  it('shows the empty state when there are no books', async () => {
    stubFetch({ [api('/audiobooks/home')]: emptyBookHome, [api('/audiobooks')]: page([]) });
    renderBrowse('/player/books');
    expect(await screen.findByText('No audiobooks yet')).toBeTruthy();
  });
});

describe('BookPage', () => {
  it('shows the book and resumes it', async () => {
    stubFetch({
      [api('/audiobooks/3')]: bookDetails(3, {
        title: 'Long Road',
        description: 'A walk across a map.',
        chapters: [
          { title: 'Start', startMs: 0, durationMs: 1_000_000 },
          { title: 'Middle', startMs: 1_000_000, durationMs: 35_000_000 },
        ],
      }),
      [api('/progress')]: { items: [halfway] },
    });
    const player = mockPlayer();
    renderBrowse('/player/books/3', player);

    expect(await screen.findByRole('heading', { level: 1, name: 'Long Road' })).toBeTruthy();
    expect(screen.getByText('By A. Writer')).toBeTruthy();
    expect(screen.getByText('Read by N. Reader')).toBeTruthy();
    expect(screen.getByText('A walk across a map.')).toBeTruthy();
    expect(screen.getByText('Middle')).toBeTruthy();

    await userEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    expect(player.playItem).toHaveBeenCalledWith('audiobook:3');
  });

  it('pauses the book when it is the one playing', async () => {
    stubFetch({ [api('/audiobooks/3')]: bookDetails(3), [api('/progress')]: { items: [] } });
    const player = mockPlayer({ currentItemKey: 'audiobook:3', playing: true });
    renderBrowse('/player/books/3', player);
    await userEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    expect(player.toggle).toHaveBeenCalled();
    expect(player.playItem).not.toHaveBeenCalled();
  });

  it('marks the book finished', async () => {
    const calls = stubFetch({
      [api('/audiobooks/3')]: bookDetails(3),
      [api('/progress')]: { items: [halfway] },
      [`PATCH ${api('/progress/audiobook%3A3')}`]: null,
      [`PATCH ${api('/progress/audiobook:3')}`]: null,
    });
    renderBrowse('/player/books/3');
    await userEvent.click(await screen.findByRole('button', { name: 'Mark finished' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(decodeURIComponent(patch!.path)).toBe(api('/progress/audiobook:3'));
    expect(patch?.body).toEqual({ played: true });
  });

  it('marks a finished book unfinished', async () => {
    const calls = stubFetch({
      [api('/audiobooks/3')]: bookDetails(3),
      [api('/progress')]: { items: [progress('audiobook:3', { played: true })] },
      [`PATCH ${api('/progress/audiobook%3A3')}`]: null,
      [`PATCH ${api('/progress/audiobook:3')}`]: null,
    });
    renderBrowse('/player/books/3');
    await userEvent.click(await screen.findByRole('button', { name: 'Mark unfinished' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ played: false }));
  });

  it('says so for an unknown book', async () => {
    stubFetch({});
    renderBrowse('/player/books/9');
    expect(await screen.findByText("Couldn't load this audiobook")).toBeTruthy();
  });
});

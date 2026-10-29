import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderAt, stubApi } from '../../../test/route-harness.js';
import { navFor, sectionTabs } from '../../../nav.js';
import { isLoadingBooks, withBooksMonitored } from '../../../hooks/audiobooks.js';
import { bookLookupInput } from './add-book.js';
import {
  DEFAULT_AUTHOR_FILTERS,
  authorFolder,
  authorInitials,
  bookState,
  chapterRows,
  filterAuthors,
  formatRuntime,
  groupBooks,
  positionLabel,
  sortAuthors,
} from './audiobook-model.js';
import {
  AB_FEATURES_OFF,
  AB_FEATURES_ON,
  audiobookProfiles,
  audiobookRoots,
  makeAudiobookFile,
  makeAuthor,
  makeAuthorDetails,
  makeBook,
  makeBookDetails,
  makeSeriesDetails,
  makeSeriesSummary,
  seriesLink,
} from './audiobook-fixtures.js';

// Audiobook library pages (WP 3E). Every name, title and narrator here is invented.

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const mara = makeAuthor({ id: 1, name: 'Mara Quill', overview: 'Writes long sea fantasies.', images: [{ coverType: 'headshot', url: '/img/mara.jpg' }] });
const oswin = makeAuthor({
  id: 2,
  name: 'Oswin Hale',
  monitored: false,
  statistics: { bookCount: 1, monitoredBookCount: 0, availableBookCount: 1, missingBookCount: 0, fileCount: 1, sizeOnDisk: 1, seriesCount: 0, percentOfBooks: 100 },
});

const tides = makeSeriesSummary({ id: 30, name: 'The Tidewright Cycle', bookCount: 3 });
const books = [
  makeBook({ id: 11, title: 'Salt Crown', series: [seriesLink(30, 'The Tidewright Cycle', '1', 11)], releaseDate: '2015-02-01', hasFile: true }),
  makeBook({ id: 13, title: 'Storm Ledger', series: [seriesLink(30, 'The Tidewright Cycle', '3', 13)], releaseDate: '2019-02-01' }),
  makeBook({ id: 12, title: 'Harbor of Glass', series: [seriesLink(30, 'The Tidewright Cycle', '2', 12)], releaseDate: '2017-02-01', monitored: false }),
  makeBook({ id: 14, title: 'A Quiet Lantern', releaseDate: '2021-05-05' }),
];

function abApi(extra: Record<string, unknown> = {}, features = AB_FEATURES_ON) {
  return stubApi({
    '/api/v1/settings/features': features,
    '/api/v1/qualityprofile': audiobookProfiles,
    '/api/v1/rootfolder': audiobookRoots,
    '/api/v1/tag': [],
    ...extra,
  });
}

const job = (id: number, name: string) => ({ id, name, status: 'queued', trigger: 'manual', message: null, queuedAt: '2026-10-26T10:00:00.000Z', startedAt: null, endedAt: null, durationMs: null });

describe('audiobook model', () => {
  it('groups books by series in position order, standalone books last', () => {
    const g = groupBooks(books, [tides]);
    expect(g.series.map((s) => s.name)).toEqual(['The Tidewright Cycle']);
    expect(g.series[0]!.entries.map((e) => [e.position, e.book.title])).toEqual([
      ['1', 'Salt Crown'],
      ['2', 'Harbor of Glass'],
      ['3', 'Storm Ledger'],
    ]);
    expect(g.standalone.map((b) => b.title)).toEqual(['A Quiet Lantern']);
  });

  it('labels positions, initials, runtimes, chapters and folders', () => {
    expect(positionLabel('3')).toBe('Book 3');
    expect(positionLabel('2.5')).toBe('Book 2.5');
    expect(positionLabel('1-3')).toBe('Books 1–3');
    expect(positionLabel('Prequel')).toBe('Prequel');
    expect(positionLabel(null)).toBeNull();
    expect(authorInitials('Mara Quill')).toBe('MQ');
    expect(authorInitials('Ursa K. Le Vane')).toBe('UV');
    expect(authorInitials('Plato')).toBe('P');
    expect(authorInitials('…')).toBe('#');
    expect(formatRuntime(684)).toBe('11 h 24 min');
    expect(formatRuntime(45)).toBe('45 min');
    expect(formatRuntime(120)).toBe('2 h');
    expect(formatRuntime(null)).toBe('—');
    const rows = chapterRows([{ title: 'Two', startMs: 600_000 }, { title: 'One', startMs: 0 }], 30);
    expect(rows.map((r) => [r.index, r.title, r.durationMs])).toEqual([
      [1, 'One', 600_000],
      [2, 'Two', 1_200_000],
    ]);
    expect(authorFolder('/data/audiobooks/', 'Mara: Quill')).toBe('/data/audiobooks/Mara Quill');
  });

  it('filters, sorts and derives states', () => {
    const list = [mara, oswin, makeAuthor({ id: 3, name: 'Ilse Brandt', aliases: ['I. Brandt'] })];
    expect(filterAuthors(list, { ...DEFAULT_AUTHOR_FILTERS, search: 'i. brandt' }).map((a) => a.id)).toEqual([3]);
    expect(filterAuthors(list, { ...DEFAULT_AUTHOR_FILTERS, monitored: 'unmonitored' }).map((a) => a.id)).toEqual([2]);
    expect(filterAuthors(list, { ...DEFAULT_AUTHOR_FILTERS, missing: true }).map((a) => a.id)).toEqual([1, 3]);
    expect(sortAuthors(list, { key: 'name', direction: 'asc' }).map((a) => a.id)).toEqual([3, 1, 2]);
    const now = new Date('2026-10-15T12:00:00Z');
    expect(bookState(makeBook({ id: 1, title: 'x', releaseDate: '2027-01-01' }), now)).toBe('unaired');
    expect(bookState(makeBook({ id: 1, title: 'x', hasFile: true }), now)).toBe('downloaded');
    expect(bookState(makeBook({ id: 1, title: 'x' }), now)).toBe('wanted');
    expect(isLoadingBooks({ books: [], lastRefreshed: null })).toBe(true);
    expect(withBooksMonitored({ books }, [11], false).books[0]!.monitored).toBe(false);
  });

  it('maps the book search box to the lookup query', () => {
    expect(bookLookupInput('any', 'salt crown')).toEqual({ term: 'salt crown' });
    expect(bookLookupInput('any', '978-0-00-000000-2')).toEqual({ isbn: '9780000000002' });
    expect(bookLookupInput('any', 'b0abc12345')).toEqual({ asin: 'B0ABC12345' });
    expect(bookLookupInput('author', 'Mara')).toEqual({ author: 'Mara' });
    expect(bookLookupInput('asin', 'b0abc12345')).toEqual({ asin: 'B0ABC12345' });
    expect(bookLookupInput('title', '  ')).toEqual({});
  });
});

describe('feature flag', () => {
  it('shows Library → Audiobooks only while the flag is on', () => {
    expect(sectionTabs('/library/tv', true, navFor(AB_FEATURES_OFF)).map((t) => t.to)).not.toContain('/library/audiobooks');
    expect(sectionTabs('/library/tv', true, navFor(AB_FEATURES_ON)).map((t) => t.to)).toContain('/library/audiobooks');
  });

  it('answers 404 on the audiobook routes while the flag is off', async () => {
    abApi({ '/api/v1/author': [mara] }, AB_FEATURES_OFF);
    renderAt('/library/audiobooks/book/11');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
    const tabs = screen.getByRole('navigation', { name: 'Section' });
    expect(within(tabs).queryByRole('link', { name: 'Audiobooks' })).toBeNull();
  });

  it('lists authors with headshots or initials, and a table view', async () => {
    abApi({ '/api/v1/author': [mara, oswin] });
    renderAt('/library/audiobooks');
    const grid = await screen.findByTestId('author-grid');
    const tabs = screen.getByRole('navigation', { name: 'Section' });
    expect(within(tabs).getByRole('link', { name: 'Audiobooks' }).getAttribute('aria-current')).toBe('page');
    expect(within(grid).getByRole('link', { name: 'Mara Quill' }).getAttribute('href')).toBe('/library/audiobooks/author/1');
    expect(within(grid).getByRole('img', { name: 'Mara Quill' }).getAttribute('src')).toBe('/img/mara.jpg');
    expect(within(grid).getByRole('img', { name: 'Oswin Hale' }).textContent).toBe('OH');
    expect(within(grid).getByText('2/4')).toBeTruthy();
    expect(document.querySelector('.mk-count')?.textContent).toMatch(/^2 authors/);
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    const table = await screen.findByRole('table', { name: 'Audiobooks' });
    expect(within(table).getByRole('columnheader', { name: 'Books' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Filter authors'), { target: { value: 'oswin' } });
    await waitFor(() => expect(within(table).queryByText('Mara Quill')).toBeNull());
  });
});

describe('add author and book', () => {
  it('searches authors and adds one with an audiobook root and profile', async () => {
    const added = makeAuthor({ id: 9, name: 'Mara Quill', lastRefreshed: null });
    const api = abApi({
      '/api/v1/series': [],
      '/api/v1/movie': [],
      '/api/v1/author/lookup': [
        { asin: 'B0AUTH0001', name: 'Mara Quill', genres: ['Fantasy'], images: [], bookCount: 7, topBooks: ['Salt Crown'], source: 'audible' },
        { asin: 'B0AUTH0002', name: 'Oswin Hale', genres: [], images: [], topBooks: [], source: 'audible', authorId: 2 },
      ],
      'POST /api/v1/author': added,
      '/api/v1/author/9': makeAuthorDetails(added, []),
    });
    renderAt('/library/add?type=audiobook');
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Search the audiobook catalogue' }), { target: { value: 'mara' } });
    const list = await screen.findByRole('list', { name: 'Search results' });
    expect(within(list).getByText('7 books · Known for Salt Crown')).toBeTruthy();
    expect(within(list).getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('/library/audiobooks/author/2');
    fireEvent.click(within(list).getByRole('button', { name: 'Add Mara Quill' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add Mara Quill' });
    await waitFor(() => expect((within(dialog).getByLabelText('Root folder') as HTMLSelectElement).value).toBe('/data/audiobooks'));
    expect(within(dialog).queryByRole('option', { name: '/data/tv' })).toBeNull();
    expect(within(dialog).getByRole('option', { name: 'M4B only' })).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Monitor'), { target: { value: 'inSeries' } });
    fireEvent.change(within(dialog).getByLabelText('Monitor new books'), { target: { value: 'none' } });
    expect(within(dialog).getByTestId('path-preview').textContent).toBe('/data/audiobooks/Mara Quill');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add author' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/v1/author')).toBe(true));
    expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/author')!.body).toEqual({
      asin: 'B0AUTH0001',
      rootFolderPath: '/data/audiobooks',
      qualityProfileId: 21,
      monitored: true,
      monitorOption: 'inSeries',
      monitorNewBooks: 'none',
      tags: [],
      searchOnAdd: false,
    });
    expect(await screen.findByTestId('loading-books')).toBeTruthy();
  });

  it('finds a book by ISBN and adds it with author options when the author is new', async () => {
    const added = makeBook({ id: 40, title: 'Salt Crown', authorId: 9 });
    const api = abApi({
      '/api/v1/series': [],
      '/api/v1/movie': [],
      '/api/v1/book/lookup': [
        {
          asin: 'B0BOOK0001',
          isbn13: '9780000000002',
          region: 'us',
          title: 'Salt Crown',
          authors: [{ name: 'Mara Quill' }],
          narrators: ['Tess Arden'],
          runtimeMinutes: 684,
          year: 2015,
          formatType: 'unabridged',
          series: [{ name: 'The Tidewright Cycle', position: '1' }],
          images: [],
          source: 'audible',
        },
      ],
      'POST /api/v1/book': added,
      '/api/v1/book/40': makeBookDetails(added, { author: makeAuthor({ id: 9, name: 'Mara Quill' }) }),
    });
    renderAt('/library/add?type=audiobook');
    fireEvent.click(await screen.findByRole('button', { name: 'Books' }));
    fireEvent.change(screen.getByLabelText('Search by'), { target: { value: 'isbn' } });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search the audiobook catalogue' }), { target: { value: '978-0-00-000000-2' } });
    const list = await screen.findByRole('list', { name: 'Search results' });
    const lookup = api.calls.find((c) => c.path === '/api/v1/book/lookup');
    expect(lookup).toBeTruthy();
    expect(within(list).getByText('The Tidewright Cycle · Book 1')).toBeTruthy();
    expect(within(list).getByText(/Narrated by Tess Arden · 11 h 24 min · 2015/)).toBeTruthy();
    fireEvent.click(within(list).getByRole('button', { name: 'Add Salt Crown' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add Salt Crown' });
    expect(within(dialog).getByTestId('new-author-options')).toBeTruthy();
    await waitFor(() => expect((within(dialog).getByLabelText('Root folder') as HTMLSelectElement).value).toBe('/data/audiobooks'));
    // The button waits for the profiles to load (a new author needs one).
    const addButton = within(dialog).getByRole('button', { name: 'Add book' }) as HTMLButtonElement;
    await waitFor(() => expect(addButton.disabled).toBe(false), { timeout: 5000 });
    fireEvent.click(addButton);
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/v1/book')).toBe(true));
    expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/book')!.body).toEqual({
      asin: 'B0BOOK0001',
      region: 'us',
      monitored: true,
      searchOnAdd: false,
      author: { rootFolderPath: '/data/audiobooks', qualityProfileId: 21, monitored: true, monitorNewBooks: 'none', tags: [] },
    });
    expect(await screen.findByRole('heading', { name: /Salt Crown/, level: 1 })).toBeTruthy();
  });

  it('adds a book of a library author without author options', async () => {
    const api = abApi({
      '/api/v1/series': [],
      '/api/v1/movie': [],
      '/api/v1/book/lookup': [{ asin: 'B0BOOK0002', title: 'Storm Ledger', authors: [{ name: 'Mara Quill', authorId: 1 }], narrators: [], series: [], images: [], source: 'audible', authorId: 1 }],
      'POST /api/v1/book': makeBook({ id: 13, title: 'Storm Ledger' }),
      '/api/v1/book/13': makeBookDetails(makeBook({ id: 13, title: 'Storm Ledger' }), { author: mara }),
    });
    renderAt('/library/add?type=audiobook');
    fireEvent.click(await screen.findByRole('button', { name: 'Books' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search the audiobook catalogue' }), { target: { value: 'storm' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Add Storm Ledger' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add Storm Ledger' });
    expect(within(dialog).queryByTestId('new-author-options')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add book' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/book')?.body).toEqual({ asin: 'B0BOOK0002', monitored: true, searchOnAdd: false }));
  });

  it('offers no Audiobooks tab while the flag is off', async () => {
    abApi({ '/api/v1/series': [], '/api/v1/movie': [] }, AB_FEATURES_OFF);
    renderAt('/library/add?type=audiobook');
    expect(await screen.findByRole('searchbox', { name: 'Search TMDB' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Audiobooks' })).toBeNull();
  });
});

describe('author details', () => {
  it('groups books by series with positions, standalone last, with monitor toggles and commands', async () => {
    const api = abApi({
      '/api/v1/author/1': makeAuthorDetails(mara, books, [tides]),
      'PUT /api/v1/book/13': makeBook({ id: 13, title: 'Storm Ledger', monitored: false }),
      'PUT /api/v1/book/monitor': null,
      'POST /api/v1/command': job(70, 'RefreshAuthor'),
    });
    renderAt('/library/audiobooks/author/1');
    expect(await screen.findByRole('heading', { name: /Mara Quill/, level: 1 })).toBeTruthy();
    expect(screen.getByText('Writes long sea fantasies.')).toBeTruthy();
    const series = screen.getByTestId('series-group-30');
    expect(series.getAttribute('aria-label')).toBe('The Tidewright Cycle');
    expect(within(series).getAllByRole('article').map((a) => a.getAttribute('aria-label'))).toEqual(['Salt Crown', 'Harbor of Glass', 'Storm Ledger']);
    expect(within(series).getByText('Book 3')).toBeTruthy();
    expect(within(series).getByRole('link', { name: 'The Tidewright Cycle' }).getAttribute('href')).toBe('/library/audiobooks/series/30');
    expect(within(series).getByRole('link', { name: /Storm Ledger/ }).getAttribute('href')).toBe('/library/audiobooks/book/13');
    const standalone = screen.getByTestId('series-group-standalone');
    expect(within(standalone).getAllByRole('article').map((a) => a.getAttribute('aria-label'))).toEqual(['A Quiet Lantern']);

    fireEvent.click(within(series).getByRole('switch', { name: 'Unmonitor Storm Ledger' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'PUT' && c.path === '/api/v1/book/13')?.body).toEqual({ monitored: false }));
    fireEvent.click(within(series).getByRole('switch', { name: 'Monitor The Tidewright Cycle' }));
    await waitFor(() => expect(api.calls.find((c) => c.path === '/api/v1/book/monitor')?.body).toEqual({ bookIds: [11, 12, 13], monitored: true }));

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/command')?.body).toEqual({ name: 'RefreshAuthor', authorIds: [1] }));
    fireEvent.click(screen.getByRole('button', { name: 'Search monitored' }));
    await waitFor(() => expect(api.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/command').map((c) => c.body)).toContainEqual({ name: 'AuthorSearch', authorIds: [1] }));
  });

  it('edits the author with audiobook profiles', async () => {
    const api = abApi({ '/api/v1/author/1': makeAuthorDetails(mara, books, [tides]), 'PUT /api/v1/author/1': mara });
    renderAt('/library/audiobooks/author/1');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Quality profile'), { target: { value: '22' } });
    fireEvent.change(within(dialog).getByLabelText('Monitor new books'), { target: { value: 'inSeries' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'PUT' && c.path === '/api/v1/author/1')?.body).toEqual({ monitored: true, monitorNewBooks: 'inSeries', qualityProfileId: 22, tags: [] }),
    );
  });

  it('says books are loading for an author that was just added', async () => {
    abApi({ '/api/v1/author/1': makeAuthorDetails({ ...mara, lastRefreshed: null }, []) });
    renderAt('/library/audiobooks/author/1');
    expect(await screen.findByTestId('loading-books')).toBeTruthy();
  });
});

describe('book details', () => {
  const book = makeBook({
    id: 12,
    title: 'Harbor of Glass',
    narrators: ['Tess Arden', 'Rowan Pike'],
    publisher: 'Lantern House Audio',
    formatType: 'abridged',
    runtimeMinutes: 684,
    releaseDate: '2017-02-01',
    authorCredits: [{ name: 'Mara Quill', authorId: 1 }, { name: 'Guest Writer' }],
    series: [seriesLink(30, 'The Tidewright Cycle', '2', 12)],
    chapters: [
      { title: 'Opening Credits', startMs: 0, lengthMs: 30_000 },
      { title: 'The Glass Quay', startMs: 30_000 },
      { title: 'Low Water', startMs: 2_430_000 },
    ],
    hasFile: true,
  });
  const details = makeBookDetails(book, { author: mara, files: [makeAudiobookFile({ id: 2, bookId: 12 }), makeAudiobookFile({ id: 1, bookId: 12 })] });

  it('shows narrators, runtime, the abridged chip, series links, chapters and part-ordered files', async () => {
    const api = abApi({ '/api/v1/book/12': details, 'POST /api/v1/command': job(80, 'BookSearch') });
    renderAt('/library/audiobooks/book/12');
    expect(await screen.findByRole('heading', { name: /Harbor of Glass/, level: 1 })).toBeTruthy();
    expect(screen.getByTestId('narrators').textContent).toBe('Narrated by Tess Arden, Rowan Pike');
    expect(screen.getByTestId('format-type-chip').textContent).toBe('Abridged');
    expect(screen.getByText('Lantern House Audio')).toBeTruthy();
    expect(screen.getAllByText('11 h 24 min').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'The Tidewright Cycle · Book 2' }).getAttribute('href')).toBe('/library/audiobooks/series/30');
    expect(screen.getAllByRole('link', { name: 'Mara Quill' }).some((l) => l.getAttribute('href') === '/library/audiobooks/author/1')).toBe(true);
    expect(screen.getByText(/Guest Writer/)).toBeTruthy();

    const chapters = screen.getByRole('table', { name: 'Chapters' });
    const glass = within(chapters).getByRole('row', { name: /The Glass Quay/ });
    expect(within(glass).getByText('0:30')).toBeTruthy();
    expect(within(glass).getByText('40:00')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: /Files/ }));
    const files = await screen.findByRole('table', { name: 'Media files' });
    const rows = within(files).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[1]!.textContent)).toEqual(['01', '02']);

    fireEvent.click(within(screen.getByRole('region', { name: 'Book overview' })).getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/command')?.body).toEqual({ name: 'BookSearch', bookIds: [12] }));
  });
});

describe('series details', () => {
  it('lists the series books in position order and monitors them together', async () => {
    const api = abApi({
      '/api/v1/bookseries/30': makeSeriesDetails({ id: 30, name: 'The Tidewright Cycle', books: [books[1]!, books[0]!, books[2]!], authors: [mara] }),
      'PUT /api/v1/book/monitor': null,
    });
    renderAt('/library/audiobooks/series/30');
    expect(await screen.findByRole('heading', { name: /The Tidewright Cycle/, level: 1 })).toBeTruthy();
    const grid = screen.getByTestId('series-books');
    expect(within(grid).getAllByRole('article').map((a) => a.getAttribute('aria-label'))).toEqual(['Salt Crown', 'Harbor of Glass', 'Storm Ledger']);
    expect(screen.getAllByRole('link', { name: 'Mara Quill' }).every((l) => l.getAttribute('href') === '/library/audiobooks/author/1')).toBe(true);
    fireEvent.click(screen.getByRole('switch', { name: 'Monitor The Tidewright Cycle' }));
    await waitFor(() => expect(api.calls.find((c) => c.path === '/api/v1/book/monitor')?.body).toEqual({ bookIds: [13, 11, 12], monitored: true }));
  });
});

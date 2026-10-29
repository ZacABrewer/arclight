import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QUALITIES, type CalendarItem } from '@arclight/shared';
import { renderAt, stubApi } from '../../test/route-harness.js';
import { toEntry } from '../calendar/calendar-math.js';
import { upcomingRows } from '../dashboard-model.js';
import { AB_FEATURES_OFF, AB_FEATURES_ON, audiobookProfiles, audiobookRoots, makeAuthor, makeBook, seriesLink } from '../library/audiobooks/audiobook-fixtures.js';

// Audiobooks in the pipeline pages (WP 3E): Wanted Books, calendar and dashboard book items,
// audiobook rows in Activity and the audiobook mode of manual import. Names are made up.

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const author = makeAuthor({ id: 1, name: 'Mira Vance' });
const book = makeBook({ id: 4, title: 'The Salt Road', series: [seriesLink(9, 'Tidewater', '3', 4)], releaseDate: '2026-10-20', year: 2026 });
const second = makeBook({ id: 5, title: 'Low Lantern', releaseDate: '2021-06-01', year: 2021 });

const job = (id: number, name: string) => ({ id, name, status: 'queued', trigger: 'manual', message: null, queuedAt: '2026-10-26T10:00:00.000Z', startedAt: null, endedAt: null, durationMs: null });
const abMp3 = { quality: { ...QUALITIES['AB-MP3'], mediaTypes: [...QUALITIES['AB-MP3'].mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } };

function abStub(extra: Record<string, unknown> = {}, features = AB_FEATURES_ON) {
  return stubApi({
    '/api/v1/settings/features': features,
    '/api/v1/qualityprofile': audiobookProfiles,
    '/api/v1/rootfolder': audiobookRoots,
    '/api/v1/tag': [],
    '/api/v1/author': [author],
    '/api/v1/book': [book, second],
    ...extra,
  });
}

const calendarItem: CalendarItem = {
  type: 'book',
  date: '2026-10-20',
  authorId: 1,
  authorName: 'Mira Vance',
  book,
  author: { id: 1, asin: author.asin, name: author.name, sortName: author.sortName, monitored: true, images: [], tags: [], path: author.path, qualityProfileId: 21 },
};

describe('wanted books', () => {
  const wanted = (b: typeof book) => ({ ...b, authorName: author.name, qualityProfileId: 21 });

  it('searches the selected books, then every wanted book', async () => {
    const api = abStub({
      '/api/v1/wanted/missing/episodes': { page: 1, pageSize: 50, totalRecords: 0, records: [] },
      '/api/v1/wanted/missing/books': { page: 1, pageSize: 50, totalRecords: 2, records: [wanted(book), wanted(second)] },
      'POST /api/v1/command': job(81, 'BookSearch'),
    });
    renderAt('/wanted/missing');
    fireEvent.click(await screen.findByRole('button', { name: 'Books' }));
    const table = await screen.findByRole('table', { name: 'Wanted books' });
    expect(within(table).getByRole('link', { name: 'The Salt Road' }).getAttribute('href')).toBe('/library/audiobooks/book/4');
    expect(within(table).getByText('Tidewater · Book 3')).toBeTruthy();
    expect(table.querySelector('[data-kind="audiobook"]')).toBeTruthy();
    fireEvent.click(within(table).getByRole('checkbox', { name: 'Select Mira Vance – Low Lantern' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Search selected' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/command')?.body).toEqual({ name: 'BookSearch', bookIds: [5] }));

    fireEvent.click(screen.getAllByRole('button', { name: 'Search all' })[0]!);
    await waitFor(() =>
      expect(api.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/command').map((c) => c.body)).toContainEqual({ name: 'BookSearch', bookIds: [4, 5] }),
    );
  });

  it('has no Books kind while audiobooks are off', async () => {
    abStub({ '/api/v1/wanted/missing/episodes': { page: 1, pageSize: 50, totalRecords: 0, records: [] } }, AB_FEATURES_OFF);
    renderAt('/wanted/missing');
    expect(await screen.findByRole('button', { name: 'Movies' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Books' })).toBeNull();
  });
});

describe('calendar and dashboard books', () => {
  it('turns a book item into a calendar entry linked to the book', () => {
    const entry = toEntry(calendarItem, new Date(2026, 9, 15, 12, 0))!;
    expect(entry).toMatchObject({ kind: 'book', title: 'Mira Vance', detail: 'The Salt Road', status: 'unaired', code: 'Tidewater · Book 3', search: null });
    expect(entry.link).toEqual({ to: '/library/audiobooks/book/$id', params: { id: '4' } });
    expect(toEntry({ ...calendarItem, book: { ...book, hasFile: true } })!.status).toBe('downloaded');
  });

  it('renders book release dates with an audiobook chip in the grid, popover and agenda', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 15, 12, 0));
    abStub({ '/api/v1/calendar': [calendarItem] });
    renderAt('/calendar');
    const bar = await screen.findByRole('button', { name: /^Audiobook: Mira Vance, The Salt Road/ });
    expect(bar.getAttribute('data-kind')).toBe('book');
    fireEvent.click(bar);
    const pop = await screen.findByRole('dialog');
    expect(pop.querySelector('[data-kind="audiobook"]')?.textContent).toBe('Audiobook');
    expect(within(pop).getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('/library/audiobooks/book/4');
    fireEvent.keyDown(pop, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Agenda' }));
    const day = await screen.findByRole('region', { name: /October 20, 2026/ });
    expect(day.querySelector('[data-kind="audiobook"]')).toBeTruthy();
  });

  it('lists books in the dashboard upcoming rows', () => {
    const rows = upcomingRows([calendarItem], new Date('2026-10-19T12:00:00.000Z'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'b-4', title: 'Mira Vance', detail: 'The Salt Road · Audiobook', href: { to: '/library/audiobooks/book/$id', params: { id: '4' } } });
  });
});

describe('audiobook rows in Activity', () => {
  const queueItem = {
    id: 1,
    downloadId: 'abc123',
    downloadClientId: 1,
    downloadClientName: 'Client',
    title: 'Mira Vance - The Salt Road (Unabridged) [m4b]',
    status: 'downloading',
    trackedStatus: 'ok',
    statusMessages: [],
    protocol: 'torrent',
    sizeBytes: 1000,
    sizeLeftBytes: 500,
    progress: 0.5,
    added: '2026-10-25T10:00:00.000Z',
    trackedState: 'downloading',
    mediaType: 'audiobook',
    authorId: 1,
    bookIds: [4],
  };

  it('the queue labels audiobook downloads "Author – Title" with a chip and a book link', async () => {
    abStub({
      '/api/v1/queue': { page: 1, pageSize: 20, sortKey: 'added', sortDirection: 'desc', totalRecords: 1, records: [queueItem] },
      '/api/v1/queue/status': { totalCount: 1, errors: 0, warnings: 0, unknownCount: 0 },
      '/api/v1/downloadclient': [],
      '/api/v1/series': [],
      '/api/v1/movie': [],
    });
    renderAt('/activity/queue');
    const link = await screen.findByRole('link', { name: 'Mira Vance – The Salt Road' });
    expect(link.getAttribute('href')).toBe('/library/audiobooks/book/4');
    expect(link.closest('tr')!.querySelector('[data-kind="audiobook"]')?.textContent).toBe('Audiobook');
  });

  it('history, pending and blocklist rows name the book, with "+n" for packs', async () => {
    const record = (id: number, over: Record<string, unknown>) => ({
      id,
      eventType: 'grabbed',
      sourceTitle: `Release ${id}`,
      date: '2026-10-25T10:00:00.000Z',
      downloadId: null,
      mediaType: 'audiobook',
      seriesId: null,
      episodeId: null,
      movieId: null,
      quality: abMp3,
      languages: [],
      data: {},
      ...over,
    });
    abStub({
      '/api/v1/history': { page: 1, pageSize: 25, totalRecords: 2, records: [record(1, { authorId: 1, bookIds: [4] }), record(2, { authorId: 1, bookIds: [5, 4] })] },
      '/api/v1/release/pending': [
        {
          id: 3,
          guid: 'p1',
          indexerId: 2,
          indexerName: 'Books Idx',
          title: 'Mira Vance - Low Lantern [mp3]',
          protocol: 'torrent',
          size: 1,
          publishDate: '2026-10-25T10:00:00.000Z',
          mediaType: 'audiobook',
          authorId: 1,
          bookIds: [5],
          quality: abMp3,
          customFormatScore: 0,
          reason: 'delay',
          added: '2026-10-25T10:00:00.000Z',
          eligibleAt: '2099-01-01T00:00:00.000Z',
          remainingMinutes: 30,
        },
      ],
      '/api/v1/series': [],
      '/api/v1/movie': [],
      '/api/v1/blocklist': {
        page: 1,
        pageSize: 25,
        totalRecords: 1,
        records: [{ id: 9, sourceTitle: 'Mira Vance - The Salt Road [mp3]', date: '2026-10-25T10:00:00.000Z', protocol: 'torrent', mediaType: 'audiobook', authorId: 1, bookIds: [4] }],
      },
    });
    const router = renderAt('/activity/history');
    expect((await screen.findByRole('link', { name: 'Mira Vance – The Salt Road' })).getAttribute('href')).toBe('/library/audiobooks/book/4');
    expect((await screen.findByRole('link', { name: 'Mira Vance – Low Lantern (+1)' })).getAttribute('href')).toBe('/library/audiobooks/book/5');
    await router.navigate({ to: '/activity/pending' });
    expect((await screen.findByRole('link', { name: 'Mira Vance – Low Lantern' })).getAttribute('href')).toBe('/library/audiobooks/book/5');
    await router.navigate({ to: '/activity/blocklist' });
    expect((await screen.findByRole('link', { name: 'Mira Vance – The Salt Road' })).getAttribute('href')).toBe('/library/audiobooks/book/4');
  });
});

describe('manual import, audiobook mode', () => {
  const tags = { title: null, author: 'Mira Vance', album: 'The Salt Road', narrator: 'Ada Brook', series: null, seriesPart: null, asin: null, isbn: null, trackNo: null, discNo: null, durationMs: 3_600_000, chapterCount: null, codec: 'MP3', bitrateKbps: 64 };
  /** One AudiobookManualImportItem (packages/shared imports.ts). */
  const item = (n: number, part: number, over: Record<string, unknown> = {}) => ({
    path: `/downloads/The Salt Road/Part ${n}.mp3`,
    relativePath: `The Salt Road/Part ${n}.mp3`,
    name: `Part ${n}.mp3`,
    sizeBytes: 60 * 1024 ** 2,
    quality: abMp3,
    mediaType: 'audiobook',
    groupKey: 'g1',
    groupFolder: 'The Salt Road',
    authorId: 1,
    bookId: 4,
    bookTitle: 'The Salt Road',
    partNumber: part,
    partCount: 3,
    confidence: 0.91,
    groupDurationMs: 10_800_000,
    runtimeMs: 36_000_000,
    tags: { ...tags, trackNo: part },
    rejections: [],
    warnings: [],
    ...over,
  });
  // Listed out of order: the wizard shows them by proposed part.
  const items = [item(2, 2), item(1, 1), item(3, 3)];

  it('scans for audiobooks, shows the book and part order, lets parts be reordered and imports', async () => {
    const api = abStub({
      '/api/v1/queue': { page: 1, pageSize: 100, sortKey: 'added', sortDirection: 'desc', totalRecords: 0, records: [] },
      '/api/v1/manualimport/audio': items,
      'POST /api/v1/manualimport/audio': { imported: [{ path: items[1]!.path, audioFileId: 1, bookId: 4, partNumber: 1, destination: '/audiobooks/Mira Vance/The Salt Road/01.mp3' }], failed: [] },
    });
    renderAt('/activity/manual-import');
    fireEvent.click(await screen.findByRole('button', { name: 'Audiobooks' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Folder' }), { target: { value: '/downloads/The Salt Road' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('3 audio files in 1 book folder, 1 matched to a book.')).toBeTruthy();
    const scan = (globalThis.fetch as unknown as { mock: { calls: Array<[string]> } }).mock.calls.map(([u]) => String(u)).find((u) => u.startsWith('/api/v1/manualimport/audio?'));
    expect(scan).toMatch(/mediaType=audiobook/);
    expect(scan).toMatch(/folder=%2Fdownloads%2FThe/);
    expect(screen.getByText('91%')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const group = await screen.findByRole('region', { name: 'Book group The Salt Road' });
    expect(within(group).getByRole('button', { name: 'Author for The Salt Road' }).textContent).toContain('Mira Vance');
    const bookPick = within(group).getByRole('combobox', { name: 'Book for The Salt Road' }) as HTMLSelectElement;
    expect(bookPick.value).toBe('4');
    await waitFor(() => expect(within(bookPick).getByRole('option', { name: 'Low Lantern (2021)' })).toBeTruthy());
    // 3 h of a 10 h book: flagged.
    expect(within(group).getByText("Length differs from the book's runtime")).toBeTruthy();

    const table = within(group).getByRole('table', { name: 'Part order for The Salt Road' });
    const files = () => within(table).getAllByRole('row').slice(1).map((r) => r.textContent ?? '');
    expect(files()[0]).toContain('Part 1.mp3');
    // Part 3 moves up above part 2; part 2 is left out.
    fireEvent.click(within(table).getByRole('button', { name: 'Move The Salt Road/Part 3.mp3 up' }));
    expect(files()[1]).toContain('Part 3.mp3');
    fireEvent.click(within(table).getByRole('checkbox', { name: 'Include The Salt Road/Part 2.mp3' }));

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Import 2 files' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/manualimport/audio')?.body).toEqual({
        importMode: 'auto',
        items: [
          { path: items[1]!.path, mediaType: 'audiobook', authorId: 1, bookId: 4, partNumber: 1 },
          { path: items[2]!.path, mediaType: 'audiobook', authorId: 1, bookId: 4, partNumber: 2 },
        ],
      }),
    );
    expect(await screen.findByText('Imported 1, failed 0.')).toBeTruthy();
  });

  it('opens in audiobook mode from a queue link', async () => {
    abStub({ '/api/v1/manualimport/audio': items });
    renderAt('/activity/manual-import?downloadId=abc&mediaType=audiobook');
    expect(await screen.findByText('3 audio files in 1 book folder, 1 matched to a book.')).toBeTruthy();
    const scan = (globalThis.fetch as unknown as { mock: { calls: Array<[string]> } }).mock.calls.map(([u]) => String(u)).find((u) => u.startsWith('/api/v1/manualimport/audio?'));
    expect(scan).toMatch(/downloadId=abc/);
  });

  it('has no Audiobooks mode while the flag is off', async () => {
    abStub({ '/api/v1/queue': { page: 1, pageSize: 100, sortKey: 'added', sortDirection: 'desc', totalRecords: 0, records: [] } }, AB_FEATURES_OFF);
    renderAt('/activity/manual-import');
    expect(await screen.findByRole('textbox', { name: 'Folder' })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Audiobooks' })).toBeNull());
  });
});

import { describe, expect, it } from 'vitest';
import type { BooksFormatProfile, BooksRelease, ComicIssue, ComicSeries, Ebook, EbookAuthor, EbookAuthorDetails } from '@arclight/shared';
import {
  DEFAULT_SHELF_FILTERS,
  activeShelfFilterCount,
  booksRequestStatusOfTab,
  byPosition,
  filterAuthors,
  filterComics,
  fold,
  formatLabel,
  groupBySeries,
  issueDate,
  matchesSearch,
  moveItem,
  parseCategories,
  parseLanguages,
  parseSizeMb,
  parseTerms,
  positionValue,
  profilesOfKind,
  recentlyAdded,
  releaseAgeDays,
  requestStatusTone,
  rootsOfKind,
  shelfProgress,
  sortAuthors,
  sortComics,
  sortIssues,
  sortReleases,
  sourceStateTone,
  toggleFormat,
  wantedKey,
  wantedSearchCommands,
} from './books-model.js';

// Fixtures carry only the fields the helpers read.
function author(id: number, name: string, over: Partial<Record<string, unknown>> = {}): EbookAuthor {
  return {
    id,
    name,
    sortName: name,
    monitored: true,
    formatProfileId: 1,
    added: `2026-01-0${id}T00:00:00Z`,
    statistics: { bookCount: id, monitoredCount: 4, availableCount: 4, sizeOnDisk: id * 10, seriesCount: 0 },
    ...over,
  } as unknown as EbookAuthor;
}

function comic(id: number, title: string, over: Partial<Record<string, unknown>> = {}): ComicSeries {
  return {
    id,
    title,
    sortTitle: title,
    publisher: 'Example Press',
    startYear: 2000 + id,
    monitored: true,
    formatProfileId: 2,
    added: `2026-02-0${id}T00:00:00Z`,
    statistics: { issueCount: id * 3, monitoredCount: 2, availableCount: 1, sizeOnDisk: id },
    ...over,
  } as unknown as ComicSeries;
}

const profiles = [
  { id: 1, kind: 'ebook', name: 'Ebooks', formats: ['epub', 'azw3'] },
  { id: 2, kind: 'comic', name: 'Comics', formats: ['cbz'] },
] as unknown as BooksFormatProfile[];

describe('shelf filters', () => {
  it('counts active filters', () => {
    expect(activeShelfFilterCount(DEFAULT_SHELF_FILTERS)).toBe(0);
    expect(activeShelfFilterCount({ search: ' x ', monitored: 'monitored', missing: true, format: 'epub' })).toBe(4);
    expect(activeShelfFilterCount({ ...DEFAULT_SHELF_FILTERS, search: '   ' })).toBe(0);
  });

  it('computes progress, treating nothing monitored as complete', () => {
    expect(shelfProgress(undefined)).toEqual({ have: 0, total: 0, percent: 100 });
    expect(shelfProgress({ monitoredCount: 4, availableCount: 1 })).toEqual({ have: 1, total: 4, percent: 25 });
    expect(shelfProgress({ monitoredCount: 2, availableCount: 5 }).have).toBe(2);
  });

  it('folds accents and punctuation for search', () => {
    expect(fold('Émile  Zola!')).toBe('emile zola');
    expect(matchesSearch('zola emi', ['Émile Zola'])).toBe(true);
    expect(matchesSearch('zola hugo', ['Émile Zola'])).toBe(false);
    expect(matchesSearch('', [null])).toBe(true);
  });

  it('filters authors by monitoring, missing, format and search', () => {
    const list = [author(1, 'Ada Example'), author(2, 'Ben Sample', { monitored: false }), author(3, 'Cy Test', { statistics: { bookCount: 3, monitoredCount: 4, availableCount: 1, sizeOnDisk: 0 } })];
    expect(filterAuthors(list, { ...DEFAULT_SHELF_FILTERS, monitored: 'unmonitored' }).map((a) => a.id)).toEqual([2]);
    expect(filterAuthors(list, { ...DEFAULT_SHELF_FILTERS, missing: true }).map((a) => a.id)).toEqual([3]);
    expect(filterAuthors(list, { ...DEFAULT_SHELF_FILTERS, search: 'sample' }).map((a) => a.id)).toEqual([2]);
    expect(filterAuthors(list, { ...DEFAULT_SHELF_FILTERS, format: 'epub' }, profiles)).toHaveLength(3);
    expect(filterAuthors(list, { ...DEFAULT_SHELF_FILTERS, format: 'cbz' }, profiles)).toHaveLength(0);
    // Without profiles a format filter matches nothing.
    expect(filterAuthors(list, { ...DEFAULT_SHELF_FILTERS, format: 'epub' })).toHaveLength(0);
  });

  it('filters comics by publisher and year text', () => {
    const list = [comic(1, 'Star Saga'), comic(2, 'Moon Tales', { publisher: 'Other House' })];
    expect(filterComics(list, { ...DEFAULT_SHELF_FILTERS, search: 'other' }).map((c) => c.id)).toEqual([2]);
    expect(filterComics(list, { ...DEFAULT_SHELF_FILTERS, search: '2001' }).map((c) => c.id)).toEqual([1]);
  });
});

describe('shelf sorting', () => {
  it('sorts authors by name, count and size', () => {
    const list = [author(2, 'Bea'), author(1, 'Cal'), author(3, 'Abe')];
    expect(sortAuthors(list, { key: 'name', direction: 'asc' }).map((a) => a.name)).toEqual(['Abe', 'Bea', 'Cal']);
    expect(sortAuthors(list, { key: 'count', direction: 'desc' }).map((a) => a.id)).toEqual([3, 2, 1]);
    expect(sortAuthors(list, { key: 'size', direction: 'asc' }).map((a) => a.id)).toEqual([1, 2, 3]);
  });

  it('breaks ties by name', () => {
    const list = [author(1, 'Zed'), author(2, 'Amy')].map((a) => ({ ...a, statistics: { ...a.statistics, bookCount: 5 } }));
    expect(sortAuthors(list, { key: 'count', direction: 'desc' }).map((a) => a.name)).toEqual(['Amy', 'Zed']);
  });

  it('sorts comics by issue count and recently added', () => {
    const list = [comic(1, 'A'), comic(3, 'C'), comic(2, 'B')];
    expect(sortComics(list, { key: 'count', direction: 'asc' }).map((c) => c.id)).toEqual([1, 2, 3]);
    expect(recentlyAdded(list, 2).map((c) => c.id)).toEqual([3, 2]);
  });
});

describe('series positions', () => {
  it('reads positions as numbers', () => {
    expect(positionValue('3')).toBe(3);
    expect(positionValue('2.5')).toBe(2.5);
    expect(positionValue('1-3')).toBe(1);
    expect(positionValue('½')).toBe(0.5);
    expect(positionValue(null)).toBe(Number.POSITIVE_INFINITY);
    expect(positionValue('prequel')).toBe(Number.POSITIVE_INFINITY);
  });

  it('orders by position, unknown last, then title', () => {
    const rows = [
      { position: null, title: 'B' },
      { position: '2', title: 'X' },
      { position: null, title: 'A' },
      { position: '1', title: 'Y' },
    ];
    expect([...rows].sort(byPosition).map((r) => r.title)).toEqual(['Y', 'X', 'A', 'B']);
  });

  it('groups books into series and standalone', () => {
    const book = (id: number, title: string, year: number | null, series: Array<{ seriesId: number; name: string; position: string | null }>) =>
      ({ id, title, sortTitle: title, year, series }) as unknown as Ebook;
    const details = {
      series: [{ id: 10, name: 'Saga' }, { id: 11, name: 'Empty' }],
      books: [
        book(1, 'Two', 2002, [{ seriesId: 10, name: 'Saga', position: '2' }]),
        book(2, 'One', 2001, [{ seriesId: 10, name: 'Saga', position: '1' }, { seriesId: 12, name: 'Crossover', position: '5' }]),
        book(3, 'Later', 2010, []),
        book(4, 'Undated', null, []),
        book(5, 'Early', 1990, []),
      ],
    } as unknown as Pick<EbookAuthorDetails, 'books' | 'series'>;
    const g = groupBySeries(details);
    expect(g.series.map((s) => s.name)).toEqual(['Saga', 'Crossover']);
    expect(g.series[0]?.books.map((b) => b.title)).toEqual(['One', 'Two']);
    expect(g.series[1]?.books[0]?.position).toBe('5');
    expect(g.standalone.map((b) => b.title)).toEqual(['Early', 'Later', 'Undated']);
  });
});

describe('issues', () => {
  const issue = (issueNumber: string, issueSort: number | null = null) => ({ issueNumber, issueSort }) as unknown as ComicIssue;

  it('sorts by issueSort, then the printed number', () => {
    const list = [issue('10'), issue('2'), issue('1.5'), issue('Annual 1', 100)];
    expect(sortIssues(list).map((i) => i.issueNumber)).toEqual(['1.5', '2', '10', 'Annual 1']);
    expect(sortIssues(list, 'desc').map((i) => i.issueNumber)).toEqual(['Annual 1', '10', '2', '1.5']);
  });

  it('prefers the store date over the cover date', () => {
    expect(issueDate({ storeDate: '2026-03-01', coverDate: '2026-05-01' })).toBe('2026-03-01');
    expect(issueDate({ storeDate: null, coverDate: '2026-05-01' })).toBe('2026-05-01');
    expect(issueDate({ storeDate: null, coverDate: null })).toBeNull();
  });
});

describe('labels and tones', () => {
  it('upper-cases formats', () => {
    expect(formatLabel('epub')).toBe('EPUB');
    expect(formatLabel(null)).toBe('');
  });

  it('maps source states and request statuses to tones', () => {
    expect(sourceStateTone('ok')).toBe('accent');
    expect(sourceStateTone('failed')).toBe('danger');
    expect(requestStatusTone('pending', false)).toBe('warn');
    expect(requestStatusTone('pending', true)).toBe('accent');
    expect(requestStatusTone('failed', false)).toBe('danger');
  });
});

describe('releases', () => {
  it('orders approved first, then score, then seeders', () => {
    const r = (id: number, approved: boolean, score: number, seeders: number | null) => ({ guid: String(id), approved, score, seeders }) as unknown as BooksRelease;
    const sorted = sortReleases([r(1, false, 99, 5), r(2, true, 10, null), r(3, true, 10, 8), r(4, true, 50, 1)]);
    expect(sorted.map((x) => x.guid)).toEqual(['4', '3', '2', '1']);
  });

  it('computes age in whole days', () => {
    const now = new Date('2026-11-02T12:00:00Z');
    expect(releaseAgeDays('2026-10-30T13:00:00Z', now)).toBe(2);
    expect(releaseAgeDays('2026-12-01T00:00:00Z', now)).toBe(0);
    expect(releaseAgeDays('not a date', now)).toBeNull();
  });
});

describe('settings parsing', () => {
  it('parses terms, dropping blanks and repeats', () => {
    expect(parseTerms('retail, Retail\n  scan ,,\n')).toEqual(['retail', 'scan']);
  });

  it('parses categories as positive whole numbers', () => {
    expect(parseCategories('7020, 7000;7020 abc -1 0 1.5')).toEqual([7020, 7000]);
  });

  it('lower-cases languages', () => {
    expect(parseLanguages('EN, de, en')).toEqual(['en', 'de']);
  });

  it('moves items within bounds', () => {
    expect(moveItem(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(moveItem(['a', 'b'], 5, 1)).toEqual(['a', 'b']);
  });

  it('toggles formats and keeps the cutoff valid', () => {
    expect(toggleFormat(['epub', 'azw3'], 'epub', 'pdf')).toEqual({ formats: ['epub', 'azw3', 'pdf'], cutoff: 'epub' });
    expect(toggleFormat(['epub', 'azw3'], 'epub', 'epub')).toEqual({ formats: ['azw3'], cutoff: 'azw3' });
    expect(toggleFormat(['epub'], 'epub', 'epub')).toEqual({ formats: [], cutoff: 'epub' });
  });

  it('parses sizes', () => {
    expect(parseSizeMb('')).toBeNull();
    expect(parseSizeMb(' 12.5 ')).toBe(12.5);
    expect(parseSizeMb('0')).toBe(0);
    expect(parseSizeMb('-1')).toBeUndefined();
    expect(parseSizeMb('ten')).toBeUndefined();
  });

  it('picks roots and profiles of a kind', () => {
    const roots = [{ id: 1, mediaType: 'ebook' }, { id: 2, mediaType: 'comic' }, { id: 3, mediaType: 'movie' }];
    expect(rootsOfKind(roots, 'comic').map((r) => r.id)).toEqual([2]);
    expect(rootsOfKind(undefined, 'ebook')).toEqual([]);
    expect(profilesOfKind(profiles, 'ebook').map((p) => p.id)).toEqual([1]);
    expect(profilesOfKind(undefined, 'comic')).toEqual([]);
  });
});

describe('wanted and requests', () => {
  it('keys wanted rows by kind and id', () => {
    expect(wantedKey({ kind: 'ebook', id: 4 })).toBe('ebook-4');
    expect(wantedKey({ kind: 'comic', id: 4 })).not.toBe(wantedKey({ kind: 'ebook', id: 4 }));
  });

  it('builds one search command per kind', () => {
    expect(wantedSearchCommands([])).toEqual([]);
    expect(wantedSearchCommands([{ kind: 'ebook', id: 1 }, { kind: 'comic', id: 2 }, { kind: 'ebook', id: 3 }])).toEqual([
      { name: 'EbookSearch', ebookIds: [1, 3] },
      { name: 'ComicIssueSearch', issueIds: [2] },
    ]);
    expect(wantedSearchCommands([{ kind: 'comic', id: 9 }])).toEqual([{ name: 'ComicIssueSearch', issueIds: [9] }]);
  });

  it('maps request tabs to statuses', () => {
    expect(booksRequestStatusOfTab('pending')).toBe('pending');
    expect(booksRequestStatusOfTab('failed')).toBe('failed');
    expect(booksRequestStatusOfTab('available')).toBe('completed');
    expect(booksRequestStatusOfTab('all')).toBe('all');
    expect(booksRequestStatusOfTab('whatever')).toBe('all');
  });
});

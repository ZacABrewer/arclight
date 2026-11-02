import { describe, expect, it } from 'vitest';
import {
  bookEarliestDate,
  comicIssueNumberKey,
  filterBooksByLanguage,
  mergeAuthorRecords,
  mergeBookRecords,
  mergeComicIssues,
  mergeComicSeries,
} from './merge.js';
import { bookRecord } from './test-support.js';
import { bookTitleKey, parseSeriesString } from './util.js';
import type { BookAuthorRecord, ComicIssueRecord, ComicSeriesRecord } from './types.js';

const ISBN = '9780765311788';
const OTHER_ISBN = '9780765350381';

const fromOl = bookRecord({
  key: 'ol:OL1W',
  keys: ['ol:OL1W', `isbn:${ISBN}`],
  title: 'The Final Empire',
  authors: [{ name: 'Brandon Sanderson', key: 'ol:OL1A' }],
  isbns: [ISBN, OTHER_ISBN],
  olWorkId: 'OL1W',
  releaseDate: '2006',
  overview: 'A much longer OpenLibrary description that should only win when nothing else has one.',
  coverUrl: 'https://covers.openlibrary.org/b/id/1-L.jpg',
  series: [{ name: 'Mistborn' }],
  genres: ['Fantasy'],
  sources: ['openLibrary'],
});

const fromGoogle = bookRecord({
  key: `isbn:${OTHER_ISBN}`,
  keys: [`isbn:${OTHER_ISBN}`, 'gb:g1'],
  title: 'The Final Empire',
  subtitle: 'Mistborn Book One',
  authors: [{ name: 'Brandon Sanderson' }],
  isbn13: OTHER_ISBN,
  isbns: [OTHER_ISBN],
  googleVolumeId: 'g1',
  publisher: 'Tor Books',
  language: 'en',
  releaseDate: '2006-07-17',
  overview: '<p>Short <b>Google</b> blurb.</p>',
  coverUrl: 'https://books.google.com/g1.jpg',
  genres: ['Fiction', 'fantasy'],
  sources: ['googleBooks'],
});

const fromHardcover = bookRecord({
  key: `isbn:${OTHER_ISBN}`,
  keys: [`isbn:${OTHER_ISBN}`, 'hc:7'],
  title: 'The Final Empire',
  authors: [{ name: 'Brandon Sanderson', key: 'hc:204214' }],
  isbn13: OTHER_ISBN,
  isbns: [OTHER_ISBN],
  hardcoverId: '7',
  rating: 4.4,
  pageCount: 541,
  overview: 'Hardcover blurb, a little longer.',
  coverUrl: 'https://assets.hardcover.app/7.jpg',
  series: [{ name: 'Mistborn', position: '1' }],
  sources: ['hardcover'],
});

describe('mergeBookRecords', () => {
  it('folds records sharing an ISBN-13 and picks fields by precedence', () => {
    const [merged, ...rest] = mergeBookRecords([fromOl, fromGoogle, fromHardcover]);
    expect(rest).toEqual([]);
    expect(merged).toMatchObject({
      key: `isbn:${OTHER_ISBN}`,
      title: 'The Final Empire',
      subtitle: 'Mistborn Book One',
      isbn13: OTHER_ISBN,
      olWorkId: 'OL1W',
      googleVolumeId: 'g1',
      hardcoverId: '7',
      publisher: 'Tor Books',
      language: 'en',
      releaseDate: '2006-07-17',
      pageCount: 541,
      rating: 4.4,
      overview: 'Hardcover blurb, a little longer.',
      coverUrl: 'https://assets.hardcover.app/7.jpg',
      series: [{ name: 'Mistborn', position: '1' }],
      sources: ['openLibrary', 'googleBooks', 'hardcover'],
    });
    expect(merged!.authors).toEqual([{ name: 'Brandon Sanderson', key: 'ol:OL1A' }]);
    expect(merged!.isbns).toEqual(expect.arrayContaining([ISBN, OTHER_ISBN]));
    expect(merged!.keys).toEqual(expect.arrayContaining(['ol:OL1W', 'gb:g1', 'hc:7', `isbn:${ISBN}`]));
    expect(merged!.genres).toEqual(['Fantasy', 'Fiction']);
  });

  it('prefers the ISBN-13 several sources agree on', () => {
    const a = bookRecord({ title: 'X', isbn13: ISBN, isbns: [ISBN], sources: ['openLibrary'], olWorkId: 'OL9W' });
    const b = bookRecord({ title: 'X', isbn13: OTHER_ISBN, isbns: [OTHER_ISBN], sources: ['googleBooks'], olWorkId: 'OL9W' });
    const c = bookRecord({ title: 'X', isbn13: OTHER_ISBN, isbns: [OTHER_ISBN], sources: ['hardcover'] });
    expect(mergeBookRecords([a, b, c])[0]!.isbn13).toBe(OTHER_ISBN);
  });

  it('falls back to title + first author, ignoring subtitles and series suffixes', () => {
    const ol = bookRecord({
      title: 'The Final Empire (Mistborn, #1)',
      authors: [{ name: 'Sanderson, Brandon' }],
      olWorkId: 'OL1W',
      sources: ['openLibrary'],
    });
    const gb = bookRecord({
      title: 'The Final Empire: Mistborn Book One',
      authors: [{ name: 'Brandon Sanderson' }],
      googleVolumeId: 'g1',
      sources: ['googleBooks'],
    });
    const hc = bookRecord({
      title: 'Final Empire, Book 1',
      authors: [{ name: 'Brandon Sanderson' }],
      hardcoverId: '7',
      sources: ['hardcover'],
    });
    const other = bookRecord({
      title: 'The Final Empire',
      authors: [{ name: 'Someone Else' }],
      googleVolumeId: 'g2',
      sources: ['googleBooks'],
    });
    const merged = mergeBookRecords([ol, gb, hc, other]);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.sources).toEqual(['openLibrary', 'googleBooks', 'hardcover']);
    expect(merged[0]!.title).toBe('Final Empire, Book 1');
  });

  it('keeps different works with the same title apart', () => {
    const a = bookRecord({ title: 'Collected Stories', authors: [{ name: 'A Writer' }], olWorkId: 'OL1W', sources: ['openLibrary'] });
    const b = bookRecord({ title: 'Collected Stories', authors: [{ name: 'A Writer' }], olWorkId: 'OL2W', sources: ['openLibrary'] });
    expect(mergeBookRecords([a, b])).toHaveLength(2);
  });

  it('bridges groups when a record links them', () => {
    const a = bookRecord({ title: 'A', isbns: [ISBN], olWorkId: 'OL1W', sources: ['openLibrary'] });
    const b = bookRecord({ title: 'B', isbns: [OTHER_ISBN], hardcoverId: '7', sources: ['hardcover'] });
    const bridge = bookRecord({ title: 'C', isbns: [ISBN, OTHER_ISBN], googleVolumeId: 'g', sources: ['googleBooks'] });
    expect(mergeBookRecords([a, b, bridge])).toHaveLength(1);
  });

  it('fills a series position from another source', () => {
    const ol = bookRecord({ title: 'T', isbns: [ISBN], series: [{ name: 'Saga' }], sources: ['openLibrary'] });
    const gb = bookRecord({ title: 'T', isbns: [ISBN], series: [{ name: 'saga', position: '3' }], sources: ['googleBooks'] });
    expect(mergeBookRecords([ol, gb])[0]!.series).toEqual([{ name: 'Saga', position: '3' }]);
  });

  it('takes the OpenLibrary description only when nothing else has one', () => {
    const ol = bookRecord({ title: 'T', isbns: [ISBN], overview: 'long long long long', sources: ['openLibrary'] });
    const gb = bookRecord({ title: 'T', isbns: [ISBN], overview: '<i>short</i>', sources: ['googleBooks'] });
    expect(mergeBookRecords([ol, gb])[0]!.overview).toBe('short');
    expect(mergeBookRecords([ol])[0]!.overview).toBe('long long long long');
  });
});

describe('book helpers', () => {
  it('chooses the most precise earliest date', () => {
    expect(bookEarliestDate(['2007', '2006', '2006-07-17', '2006-08'])).toBe('2006-07-17');
    expect(bookEarliestDate(['2010-01-01', '2006'])).toBe('2006');
    expect(bookEarliestDate([undefined, 'soon'])).toBeUndefined();
  });

  it('parses series strings and title keys', () => {
    expect(parseSeriesString('Mistborn #1')).toEqual({ name: 'Mistborn', position: '1' });
    expect(parseSeriesString('Mistborn (2.5)')).toEqual({ name: 'Mistborn', position: '2.5' });
    expect(parseSeriesString('The Stormlight Archive, Book 3')).toEqual({ name: 'The Stormlight Archive', position: '3' });
    expect(parseSeriesString('Discworld')).toEqual({ name: 'Discworld' });
    expect(bookTitleKey('The Final Empire (Mistborn #1)')).toBe(bookTitleKey('Final Empire #1'));
  });

  it('filters by language and keeps unknown languages', () => {
    const books = [
      bookRecord({ title: 'en', language: 'en', sources: ['googleBooks'] }),
      bookRecord({ title: 'es', language: 'es', sources: ['googleBooks'] }),
      bookRecord({ title: 'unknown', sources: ['openLibrary'] }),
    ];
    expect(filterBooksByLanguage(books, ['english']).map((b) => b.title)).toEqual(['en', 'unknown']);
    expect(filterBooksByLanguage(books, ['eng', 'spa']).map((b) => b.title)).toEqual(['en', 'es', 'unknown']);
    expect(filterBooksByLanguage(books, [])).toHaveLength(3);
  });
});

describe('mergeAuthorRecords', () => {
  const ol: BookAuthorRecord = {
    key: 'ol:OL1A',
    keys: ['ol:OL1A'],
    name: 'Brandon Sanderson',
    overview: 'Short.',
    workCount: 120,
    olAuthorId: 'OL1A',
    sources: ['openLibrary'],
  };
  const hc: BookAuthorRecord = {
    key: 'hc:5',
    keys: ['hc:5'],
    name: 'Sanderson, Brandon',
    overview: 'A longer Hardcover bio.',
    imageUrl: 'https://assets.hardcover.app/a.jpg',
    workCount: 300,
    hardcoverId: '5',
    sources: ['hardcover'],
  };

  it('merges by normalized name and keeps every id', () => {
    const [merged, ...rest] = mergeAuthorRecords([hc, ol]);
    expect(rest).toEqual([]);
    expect(merged).toEqual({
      key: 'ol:OL1A',
      keys: ['ol:OL1A', 'hc:5'],
      name: 'Brandon Sanderson',
      overview: 'A longer Hardcover bio.',
      imageUrl: 'https://assets.hardcover.app/a.jpg',
      workCount: 300,
      olAuthorId: 'OL1A',
      hardcoverId: '5',
      sources: ['hardcover', 'openLibrary'],
    });
  });

  it('keeps namesakes with different ids apart', () => {
    const namesake = { ...ol, key: 'ol:OL2A', keys: ['ol:OL2A'], olAuthorId: 'OL2A' };
    expect(mergeAuthorRecords([ol, namesake])).toHaveLength(2);
  });
});

describe('comics', () => {
  const cvSeries: ComicSeriesRecord = {
    key: 'cv:91273',
    keys: ['cv:91273'],
    title: 'Batman',
    publisher: 'DC Comics',
    startYear: 2016,
    issueCount: 140,
    coverUrl: 'https://comicvine.example.com/b.jpg',
    comicVineId: '91273',
    sources: ['comicVine'],
  };
  const metronSeries: ComicSeriesRecord = {
    key: 'metron:2049',
    keys: ['metron:2049', 'cv:91273'],
    title: 'Batman',
    startYear: 2016,
    issueCount: 150,
    comicVineId: '91273',
    metronId: '2049',
    status: 'ended',
    sources: ['metron'],
  };

  it('merges series by ComicVine id, else title + start year', () => {
    const [merged, ...rest] = mergeComicSeries([cvSeries, metronSeries]);
    expect(rest).toEqual([]);
    expect(merged).toMatchObject({
      key: 'cv:91273',
      keys: ['cv:91273', 'metron:2049'],
      issueCount: 150,
      status: 'ended',
      coverUrl: 'https://comicvine.example.com/b.jpg',
      sources: ['comicVine', 'metron'],
    });
    const { comicVineId: _cv, ...metronOnly } = metronSeries;
    const unlinked: ComicSeriesRecord = { ...metronOnly, keys: ['metron:2049'] };
    expect(mergeComicSeries([cvSeries, unlinked])).toHaveLength(1);
    expect(mergeComicSeries([cvSeries, { ...unlinked, startYear: 2011 }])).toHaveLength(2);
  });

  it('normalizes issue numbers', () => {
    expect(comicIssueNumberKey('001')).toBe('1');
    expect(comicIssueNumberKey('1.0')).toBe('1');
    expect(comicIssueNumberKey('12.10')).toBe('12.1');
    expect(comicIssueNumberKey(' Annual  1 ')).toBe('annual 1');
  });

  it('merges issues by ComicVine id, else number; Metron store dates, ComicVine covers', () => {
    const cv: ComicIssueRecord[] = [
      { key: 'cv-issue:502', keys: ['cv-issue:502'], issueNumber: '2', coverDate: '2016-08-15', storeDate: '2016-07-07', coverUrl: 'https://cv/2.jpg', comicVineId: '502', sources: ['comicVine'] },
      { key: 'cv-issue:501', keys: ['cv-issue:501'], issueNumber: '1', title: 'I Am Gotham', coverUrl: 'https://cv/1.jpg', comicVineId: '501', sources: ['comicVine'] },
    ];
    const metron: ComicIssueRecord[] = [
      { key: 'metron-issue:1', keys: ['metron-issue:1', 'cv-issue:501'], issueNumber: '1', storeDate: '2016-06-15', coverUrl: 'https://m/1.jpg', comicVineId: '501', metronId: '1', sources: ['metron'] },
      { key: 'metron-issue:2', keys: ['metron-issue:2'], issueNumber: '002', storeDate: '2016-07-06', metronId: '2', sources: ['metron'] },
      { key: 'metron-issue:3', keys: ['metron-issue:3'], issueNumber: '3', coverUrl: 'https://m/3.jpg', metronId: '3', sources: ['metron'] },
    ];
    const merged = mergeComicIssues(cv, metron);
    expect(merged.map((i) => i.key)).toEqual(['cv-issue:501', 'cv-issue:502', 'metron-issue:3']);
    expect(merged[0]).toMatchObject({
      title: 'I Am Gotham',
      storeDate: '2016-06-15',
      coverUrl: 'https://cv/1.jpg',
      metronId: '1',
      sources: ['comicVine', 'metron'],
    });
    expect(merged[1]).toMatchObject({ storeDate: '2016-07-06', coverDate: '2016-08-15', metronId: '2' });
    expect(merged[2]!.coverUrl).toBe('https://m/3.jpg');
  });
});

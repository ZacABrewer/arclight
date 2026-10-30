import { describe, expect, it } from 'vitest';
import { ListSearchParam, filterListSearch, listSearchLikePattern, listSearchTokens, matchesListSearch } from './list-search.js';

describe('listSearchTokens', () => {
  it('splits on spaces, dots, dashes and underscores, lower case', () => {
    expect(listSearchTokens('  The.Office  S01-E02_x ')).toEqual(['the', 'office', 's01', 'e02', 'x']);
  });
  it('is empty for a blank query', () => {
    expect(listSearchTokens('')).toEqual([]);
    expect(listSearchTokens(' . - _ ')).toEqual([]);
    expect(listSearchTokens(undefined)).toEqual([]);
  });
});

describe('matchesListSearch', () => {
  it('ignores case and release-name separators', () => {
    expect(matchesListSearch('the office', ['The.Office.S01E01.1080p.WEB-DL'])).toBe(true);
    expect(matchesListSearch('web dl', ['The.Office.S01E01.1080p.WEB-DL'])).toBe(true);
    expect(matchesListSearch('WEB-DL', ['the office web dl'])).toBe(true);
  });
  it('needs every word, from any field', () => {
    expect(matchesListSearch('office nyaa', ['The.Office.S01', 'Nyaa'])).toBe(true);
    expect(matchesListSearch('office torrentleech', ['The.Office.S01', 'Nyaa'])).toBe(false);
  });
  it('does not join two fields into one word', () => {
    expect(matchesListSearch('officenyaa', ['Office', 'Nyaa'])).toBe(false);
  });
  it('a blank query matches everything, a missing field nothing', () => {
    expect(matchesListSearch('', [])).toBe(true);
    expect(matchesListSearch('x', [null, undefined, ''])).toBe(false);
  });
  it('reads numbers and arrays', () => {
    expect(matchesListSearch('2024', ['Movie', 2024])).toBe(true);
    expect(matchesListSearch('alice', [['bob', 'Alice']])).toBe(true);
  });
  it('accepts pre-split words', () => {
    expect(matchesListSearch(['off', 's01'], ['The.Office.S01'])).toBe(true);
  });
});

describe('filterListSearch', () => {
  const rows = [
    { title: 'Severance', indexer: 'Nyaa' },
    { title: 'Andor', indexer: 'TorrentLeech' },
  ];
  it('keeps matching rows and returns the same array for a blank query', () => {
    expect(filterListSearch(rows, 'torrent', (r) => [r.title, r.indexer]).map((r) => r.title)).toEqual(['Andor']);
    expect(filterListSearch(rows, '  ', (r) => [r.title])).toBe(rows);
  });
});

describe('listSearchLikePattern', () => {
  it('escapes LIKE wildcards and the escape character', () => {
    expect(listSearchLikePattern('100%')).toBe('%100\\%%');
    expect(listSearchLikePattern('a\\b')).toBe('%a\\\\b%');
    expect(listSearchLikePattern('x_y')).toBe('%x\\_y%');
  });
});

describe('ListSearchParam', () => {
  it('trims and caps the length', () => {
    expect(ListSearchParam.parse('  hi ')).toBe('hi');
    expect(ListSearchParam.parse(undefined)).toBeUndefined();
    expect(ListSearchParam.safeParse('x'.repeat(201)).success).toBe(false);
  });
});

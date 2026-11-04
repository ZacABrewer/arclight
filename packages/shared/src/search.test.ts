import { describe, expect, it } from 'vitest';
import { matchScore, normalizeSearch, rankMatches, searchWords } from './search.js';

const titles = (q: string, list: readonly string[]) => rankMatches(q, list, (t) => t).map((m) => m.item);

describe('normalizeSearch', () => {
  it('folds case and accents, drops apostrophes, splits on other punctuation', () => {
    expect(normalizeSearch("  Amélie's  Café: L'été! ")).toBe('amelies cafe lete');
    expect(normalizeSearch('Grey’s Anatomy')).toBe('greys anatomy');
    expect(normalizeSearch('Spider-Man: No Way Home')).toBe('spider man no way home');
    expect(searchWords('S.H.I.E.L.D.')).toEqual(['s', 'h', 'i', 'e', 'l', 'd']);
  });
});

describe('matchScore', () => {
  it('finds titles whatever the punctuation (the 0.24 "search returns nothing" bug)', () => {
    // Each of these returned nothing in 0.24: a query word that spans the title's punctuation
    // matched no single title word, and every query word must match.
    expect(matchScore('spiderman', 'Spider-Man: No Way Home')).toBeGreaterThan(0);
    expect(matchScore('greys anatomy', "Grey's Anatomy")).toBeGreaterThan(0);
    expect(matchScore('schindlers list', "Schindler's List")).toBeGreaterThan(0);
    expect(matchScore('walle', 'WALL·E')).toBeGreaterThan(0);
    expect(matchScore('agents of shield', "Marvel's Agents of S.H.I.E.L.D.")).toBeGreaterThan(0);
    expect(matchScore('marvels', "Marvel's Agents of S.H.I.E.L.D.")).toBeGreaterThan(0);
    // Typed with the punctuation still works.
    expect(matchScore("grey's", "Grey's Anatomy")).toBeGreaterThan(0);
    expect(matchScore('spider-man', 'Spider-Man: No Way Home')).toBeGreaterThan(0);
  });

  it('is case and accent insensitive and matches word prefixes', () => {
    expect(matchScore('AMELIE', 'Amélie')).toBeGreaterThan(0);
    expect(matchScore('star wa', 'Star Wars')).toBeGreaterThan(0);
    expect(matchScore('wars star', 'Star Wars')).toBeGreaterThan(0);
    expect(matchScore('fellowship ring', 'The Lord of the Rings: The Fellowship of the Ring')).toBeGreaterThan(0);
  });

  it('lets a linking word be missing, but not a real word', () => {
    expect(matchScore('the dune', 'Dune')).toBeGreaterThan(0);
    expect(matchScore('lord of rings', 'Lord Rings')).toBeGreaterThan(0);
    expect(matchScore('dune messiah', 'Dune')).toBe(0);
    expect(matchScore('the', 'Dune')).toBe(0);
    expect(matchScore('the', 'The Office')).toBeGreaterThan(0);
  });

  it('a run across words must start at a word', () => {
    expect(matchScore('pidermannow', 'Spider-Man: No Way Home')).toBe(0);
    expect(matchScore('mannoway', 'Spider-Man: No Way Home')).toBeGreaterThan(0);
  });

  it('matches keywords (original title, year)', () => {
    expect(matchScore('poulain', 'Amélie', ["Le Fabuleux Destin d'Amélie Poulain", '2001'])).toBeGreaterThan(0);
    expect(matchScore('amelie 2001', 'Amélie', ['2001'])).toBeGreaterThan(0);
    expect(matchScore('amelie 1999', 'Amélie', ['2001'])).toBe(0);
  });

  it('minWordScore 3 keeps only prefix-or-better words', () => {
    expect(matchScore('brkng', 'Breaking Bad')).toBeGreaterThan(0);
    expect(matchScore('brkng', 'Breaking Bad', [], { minWordScore: 3 })).toBe(0);
    expect(matchScore('break', 'Breaking Bad', [], { minWordScore: 3 })).toBeGreaterThan(0);
  });
});

describe('rankMatches', () => {
  it('ranks exact, then prefix (also past a leading article), then the rest', () => {
    expect(titles('alien', ['Aliens', 'Alien Resurrection', 'Alien', 'Cowboys & Aliens'])).toEqual(['Alien', 'Alien Resurrection', 'Aliens', 'Cowboys & Aliens']);
    expect(titles('office', ['Office Space', 'The Office (US)', 'Back Office'])[2]).toBe('Back Office');
    expect(titles('spiderman', ['Spider-Man', 'Spider-Man 2', 'The Amazing Spider-Man'])).toEqual(['Spider-Man', 'Spider-Man 2', 'The Amazing Spider-Man']);
  });
});

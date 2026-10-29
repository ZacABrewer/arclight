import { parseAudiobookRelease } from '@arclight/parser';
import { describe, expect, it } from 'vitest';
import { bookTitleKey, hasAudiobookMarker, matchBook, packBooks, personKey, samePerson, seriesKey } from './audio-matcher.js';
import { bookSnapshot, makeAuthor, makeBook, NOW } from './test-support.js';

const sanderson = makeAuthor({ name: 'Brandon Sanderson', aliases: ['B. Sanderson'] });
const tolkien = makeAuthor({ name: 'J. R. R. Tolkien', sortName: 'Tolkien, J. R. R.' });
const corey = makeAuthor({ name: 'James S. A. Corey' });
const weir = makeAuthor({ name: 'Andy Weir' });
const pratchett = makeAuthor({ name: 'Terry Pratchett' });
const gaiman = makeAuthor({ name: 'Neil Gaiman' });
const king = makeAuthor({ name: 'Stephen King' });

const wayOfKings = makeBook(sanderson.id, 'The Way of Kings', { seriesName: 'The Stormlight Archive', position: '1' });
const finalEmpire = makeBook(sanderson.id, 'The Final Empire', { seriesName: 'Mistborn', position: '1' });
const wellOfAscension = makeBook(sanderson.id, 'The Well of Ascension', { seriesName: 'Mistborn', position: '2' });
const heroOfAges = makeBook(sanderson.id, 'The Hero of Ages', { seriesName: 'Mistborn', position: '3' });
const elantris = makeBook(sanderson.id, 'Elantris', { year: 2005 });
const hobbit = makeBook(tolkien.id, 'The Hobbit', { subtitle: 'or There and Back Again' });
const leviathan = makeBook(corey.id, 'Leviathan Wakes', { seriesName: 'The Expanse', position: '1' });
const calibans = makeBook(corey.id, "Caliban's War", { seriesName: 'The Expanse', position: '2' });
const abaddon = makeBook(corey.id, "Abaddon's Gate", { seriesName: 'The Expanse', position: '3' });
const cibola = makeBook(corey.id, 'Cibola Burn', { seriesName: 'The Expanse', position: '4' });
const nemesis = makeBook(corey.id, 'Nemesis Games', { seriesName: 'The Expanse', position: '5' });
const babylon = makeBook(corey.id, "Babylon's Ashes", { seriesName: 'The Expanse', position: '6' });
const gods = makeBook(corey.id, 'Gods of Risk', { seriesName: 'The Expanse', position: '2.5' });
const hailMary = makeBook(weir.id, 'Project Hail Mary', { asin: 'B08G9PRS1K' });
const martian = makeBook(weir.id, 'The Martian');
const goodOmens = makeBook(pratchett.id, 'Good Omens', { credits: ['Terry Pratchett', 'Neil Gaiman'] });
const itBook = makeBook(king.id, 'It', { year: 1986 });
const itRemake = makeBook(king.id, 'It', { year: 2017, subtitle: 'Anniversary Edition' });

const lib = bookSnapshot(
  [sanderson, tolkien, corey, weir, pratchett, gaiman, king],
  [wayOfKings, finalEmpire, wellOfAscension, heroOfAges, elantris, hobbit, leviathan, calibans, abaddon, cibola, nemesis, babylon, gods, hailMary, martian, goodOmens, itBook, itRemake],
  { [gaiman.id]: [goodOmens.id] },
);

function match(title: string, opts: Parameters<typeof matchBook>[2] = {}) {
  return matchBook(parseAudiobookRelease(title).audiobook, lib, { now: NOW, ...opts });
}

function mapped(title: string, opts: Parameters<typeof matchBook>[2] = {}) {
  const r = match(title, opts);
  if (r.status !== 'mapped') throw new Error(`${title}: ${r.reason} ${r.message}`);
  return r;
}

describe('names and keys', () => {
  it.each([
    ['J. R. R. Tolkien', 'J.R.R. Tolkien', true],
    ['JRR Tolkien', 'J. R. R. Tolkien', true],
    ['Tolkien, J. R. R.', 'J.R.R. Tolkien', true],
    ['John Ronald Reuel Tolkien', 'J. R. R. Tolkien', true],
    ['S. King', 'Stephen King', true],
    ['Stephen King', 'Steven King', false],
    ['Sam King', 'Stephen King', false],
    ['Sanderson, Brandon', 'Brandon Sanderson', true],
    ['Brandon Sanderson', 'Brendan Sanderson', false],
  ])('samePerson(%s, %s) = %s', (a, b, expected) => {
    expect(samePerson(a, b)).toBe(expected);
  });

  it('folds accents, punctuation, articles and "&"', () => {
    expect(personKey('José  Saramago')).toBe(personKey('Jose Saramago'));
    expect(bookTitleKey('The Hobbit')).toBe(bookTitleKey('Hobbit'));
    expect(bookTitleKey("Caliban's War")).toBe(bookTitleKey('Calibans War'));
    expect(seriesKey('The Expanse')).toBe(seriesKey('Expanse Series'));
    expect(seriesKey('Mistborn Saga')).toBe(seriesKey('Mistborn'));
  });

  it.each([
    ['Brandon Sanderson - The Way of Kings (Unabridged) [m4b]', true],
    ['Andy Weir - Project Hail Mary narrated by Ray Porter', true],
    ['Project Hail Mary B08G9PRS1K', true],
    ['Stephen King - It (Abridged)', true],
    ['Some.Show.S01E01.1080p.WEB-DL-GRP', false],
    ['Radiohead - OK Computer (1997) [FLAC]', false],
  ])('hasAudiobookMarker(%s) = %s', (title, expected) => {
    expect(hasAudiobookMarker(title)).toBe(expected);
  });
});

describe('matchBook: single books', () => {
  it.each([
    ['Brandon Sanderson - The Way of Kings (Unabridged) [m4b]', wayOfKings.id, 'title'],
    ['Sanderson, Brandon - The Way of Kings [m4b]', wayOfKings.id, 'title'],
    ['B. Sanderson - Elantris [mp3]', elantris.id, 'title'],
    ['J.R.R. Tolkien - The Hobbit (Abridged) [mp3]', hobbit.id, 'title'],
    ['JRR Tolkien - The Hobbit or There and Back Again [m4b]', hobbit.id, 'title'],
    ['James S.A. Corey - [The Expanse #3] - Abaddons Gate (2013) 64kbps', abaddon.id, 'title'],
    ['Andy Weir - Project Hail Mary [m4b]', hailMary.id, 'title'],
    ['Project Hail Mary - Andy Weir - Ray Porter', hailMary.id, 'title'],
  ])('%s -> book', (title, bookId, via) => {
    const r = mapped(title);
    expect(r.books.map((b) => b.id)).toEqual([bookId]);
    expect(r.isPack).toBe(false);
    expect(r.matchType).toBe(via);
  });

  it('an ASIN wins over everything else, whatever the author is called', () => {
    const r = mapped('Somebody Else - Wrong Title [ASIN B08G9PRS1K] [m4b]');
    expect(r).toMatchObject({ author: { id: weir.id }, books: [{ id: hailMary.id }], matchType: 'asin' });
  });

  it('falls back to series + position when the title is not in the library', () => {
    const r = mapped('Brandon Sanderson - Mistborn 02 - Well of Ascension, The [m4b]');
    expect(r.books.map((b) => b.id)).toEqual([wellOfAscension.id]);
    const bySeries = mapped('James S. A. Corey - [The Expanse #2] - A Different Name [m4b]');
    expect(bySeries).toMatchObject({ books: [{ id: calibans.id }], matchType: 'series' });
  });

  it('co-authored books match through any credited library author and belong to their owner', () => {
    const r = mapped('Neil Gaiman & Terry Pratchett - Good Omens [m4b]');
    expect(r).toMatchObject({ author: { id: pratchett.id }, books: [{ id: goodOmens.id }] });
    const viaCoAuthor = mapped('Neil Gaiman - Good Omens [m4b]');
    expect(viaCoAuthor.author.id).toBe(pratchett.id);
  });

  it('several books with one title: the year decides, else the search criteria, else ambiguous', () => {
    expect(mapped('Stephen King - It (1986) [m4b]').books[0]!.id).toBe(itBook.id);
    expect(mapped('Stephen King - It [m4b]', { criteria: { mediaType: 'audiobook', bookIds: [itRemake.id] } }).books[0]!.id).toBe(itRemake.id);
    expect(match('Stephen King - It [m4b]')).toMatchObject({ status: 'ambiguous', reason: 'unknownBook' });
  });

  it('unknown authors and books are reported with what was read', () => {
    expect(match('Nobody Known - Some Book [m4b]')).toMatchObject({ status: 'unknown', reason: 'unknownAuthor' });
    expect(match('Andy Weir - Artemis [m4b]')).toMatchObject({ status: 'unknown', reason: 'unknownBook', author: { id: weir.id } });
    expect(matchBook(null, lib)).toMatchObject({ reason: 'unableToParse' });
  });
});

describe('matchBook: packs', () => {
  it('maps "Books 1-5" to the whole-numbered books of that series in range (novellas left out)', () => {
    const r = mapped('James S. A. Corey - The Expanse Books 1-5 [mp3]');
    expect(r.isPack).toBe(true);
    expect(r.books.map((b) => b.id)).toEqual([leviathan.id, calibans.id, abaddon.id, cibola.id, nemesis.id]);
  });

  it('maps an author-less pack by its series across the library', () => {
    const r = mapped('The Expanse Books 1-3 [mp3]');
    expect(r).toMatchObject({ author: { id: corey.id }, isPack: true });
    expect(r.books.map((b) => b.id)).toEqual([leviathan.id, calibans.id, abaddon.id]);
  });

  it('maps "Complete Series" to every book of the series in order', () => {
    const r = mapped('Brandon Sanderson - Mistborn - Complete Series [m4b]');
    expect(r.books.map((b) => b.id)).toEqual([finalEmpire.id, wellOfAscension.id, heroOfAges.id]);
  });

  it('packs that cover nothing in the library are empty', () => {
    expect(match('Brandon Sanderson - Skyward Books 1-4 [m4b]')).toMatchObject({ status: 'unknown', reason: 'emptyPack' });
    expect(match('Unknown Person - The Expanse Books 1-5 [mp3]')).toMatchObject({ status: 'unknown', reason: 'unknownAuthor' });
  });

  it('packBooks leaves out books not released yet', () => {
    const future = makeBook(corey.id, 'Leviathan Falls', { seriesName: 'The Expanse', position: '9', releaseDate: '2027-01-01' });
    const got = packBooks({ series: 'The Expanse', seriesPosition: null }, [leviathan, future], NOW);
    expect(got.map((b) => b.id)).toEqual([leviathan.id]);
  });
});

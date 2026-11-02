import { describe, expect, it } from 'vitest';
import {
  bookTitleKey,
  parseComicPath,
  parseComicRelease,
  parseEbookPath,
  parseEbookRelease,
  type ParsedComicRelease,
  type ParsedEbookRelease,
} from './index.js';

describe('parseEbookRelease', () => {
  it.each<[string, Partial<ParsedEbookRelease>]>([
    [
      'Brandon Sanderson - Mistborn 01 - The Final Empire (2006) [epub]',
      { author: 'Brandon Sanderson', series: 'Mistborn', seriesPosition: '1', title: 'The Final Empire', year: 2006, format: 'epub', isPack: false, isAudio: false },
    ],
    [
      'Brandon.Sanderson.-.The.Final.Empire.2006.RETAIL.EPUB.eBook-GROUP',
      { author: 'Brandon Sanderson', title: 'The Final Empire', year: 2006, retail: true, format: 'epub', releaseGroup: 'GROUP' },
    ],
    ['Andy Weir - Project Hail Mary (2021) (retail) (azw3)', { author: 'Andy Weir', title: 'Project Hail Mary', year: 2021, retail: true, format: 'azw3', formats: ['azw3'] }],
    ['Project Hail Mary by Andy Weir EPUB', { author: 'Andy Weir', title: 'Project Hail Mary', format: 'epub', orderAmbiguous: false }],
    [
      'The Final Empire (Mistborn #1) - Brandon Sanderson.epub',
      { author: 'Brandon Sanderson', title: 'The Final Empire', series: 'Mistborn', seriesPosition: '1', format: 'epub', orderAmbiguous: false },
    ],
    [
      'Terry Pratchett - Discworld 01-41 Collection (epub+mobi)',
      { author: 'Terry Pratchett', series: 'Discworld', seriesPosition: '1-41', isPack: true, formats: ['epub', 'mobi'], format: 'epub' },
    ],
    [
      'Sanderson, Brandon - The Way of Kings [Stormlight Archive 1] (epub)',
      { author: 'Brandon Sanderson', title: 'The Way of Kings', series: 'Stormlight Archive', seriesPosition: '1', format: 'epub' },
    ],
    ['9780765311788 - The Final Empire.epub', { isbn: '9780765311788', title: 'The Final Empire', format: 'epub' }],
    ['Brandon Sanderson - The Final Empire [ISBN 076531178X] (epub)', { isbn: '9780765311788', author: 'Brandon Sanderson', title: 'The Final Empire' }],
    ['Franz Kafka - Die Verwandlung (German) (epub)', { author: 'Franz Kafka', title: 'Die Verwandlung', language: 'de', format: 'epub' }],
    [
      'Cornelia Funke - Tintenherz (Tintenwelt Band 1) [DE] [epub]',
      { author: 'Cornelia Funke', title: 'Tintenherz', series: 'Tintenwelt', seriesPosition: '1', language: 'de' },
    ],
    ['Victor Hugo - Les Misérables [FR] (epub)', { author: 'Victor Hugo', title: 'Les Misérables', language: 'fr' }],
    ['Jules.Verne.-.Le.Tour.du.monde.en.quatre-vingts.jours.French.EPUB-GRP', { author: 'Jules Verne', title: 'Le Tour du monde en quatre-vingts jours', language: 'fr', releaseGroup: 'GRP' }],
    ['Thomas Mann - Der Zauberberg (ger) (mobi)', { author: 'Thomas Mann', title: 'Der Zauberberg', language: 'de', format: 'mobi' }],
    ['Andy Weir - Project Hail Mary (Unabridged) [m4b]', { author: 'Andy Weir', title: 'Project Hail Mary', isAudio: true }],
    ['Andy Weir - The Martian narrated by R. C. Bray (2014)', { title: 'The Martian', isAudio: true }],
    ['Mistborn 01 - The Final Empire - Brandon Sanderson', { author: 'Brandon Sanderson', series: 'Mistborn', seriesPosition: '1', title: 'The Final Empire' }],
    ['Brandon.Sanderson.The.Final.Empire.epub', { title: 'Brandon Sanderson The Final Empire', format: 'epub' }],
    ['Andy Weir - The Martian [Audiobook] [mp3]', { isAudio: true }],
    ['Andy Weir - The Martian.pdf', { author: 'Andy Weir', title: 'The Martian', format: 'pdf', formats: ['pdf'] }],
    ['The Martian - Andy Weir - 2014 - azw3', { author: 'Andy Weir', title: 'The Martian', year: 2014, format: 'azw3', orderAmbiguous: false }],
    ['Project Hail Mary - Andy Weir - 2021 - azw3', { author: 'Project Hail Mary', title: 'Andy Weir', year: 2021, orderAmbiguous: true }],
    ['Andy Weir - Artemis [EPUB/AZW3/PDF]', { formats: ['epub', 'azw3', 'pdf'], format: 'epub' }],
    ['Andy Weir - Artemis (pdf, mobi)', { formats: ['pdf', 'mobi'], format: 'mobi' }],
    ['George Orwell - 1984 (1949) [epub]', { author: 'George Orwell', title: '1984', year: 1949 }],
    ['George Orwell - 1984', { author: 'George Orwell', title: '1984' }],
    ['Frank Herbert - Dune', { author: 'Frank Herbert', title: 'Dune', formats: [], orderAmbiguous: false }],
    ['J. R. R. Tolkien - The Hobbit (1937) (epub)', { author: 'J. R. R. Tolkien', title: 'The Hobbit', year: 1937 }],
    ['Tolkien, J. R. R. - The Fellowship of the Ring (epub)', { author: 'J. R. R. Tolkien', title: 'The Fellowship of the Ring' }],
    ['Douglas Preston & Lincoln Child - Relic (1995) (epub)', { author: 'Douglas Preston & Lincoln Child', title: 'Relic' }],
    ['James S. A. Corey - The Expanse Books 1-9 Complete Series (epub)', { author: 'James S. A. Corey', series: 'The Expanse', seriesPosition: '1-9', isPack: true }],
    ['J. K. Rowling - Harry Potter Box Set (epub)', { author: 'J. K. Rowling', isPack: true, orderAmbiguous: false }],
    ['Brandon Sanderson - Mistborn 2.5 - The Eleventh Metal (epub)', { series: 'Mistborn', seriesPosition: '2.5', title: 'The Eleventh Metal' }],
    ['[Books] Frank Herbert - Dune (1965) (epub)', { author: 'Frank Herbert', title: 'Dune', releaseGroup: 'Books' }],
    ['Frank Herbert - Dune - The Graphic Novel (epub)', { author: 'Frank Herbert', title: 'Dune - The Graphic Novel' }],
  ])('%s', (name, expected) => {
    expect(parseEbookRelease(name)).toMatchObject(expected);
  });

  it('returns null for names without a book', () => {
    expect(parseEbookRelease('')).toBeNull();
    expect(parseEbookRelease('[epub] [retail]')).toBeNull();
  });

  it('leaves the language unset when no language is tagged', () => {
    const r = parseEbookRelease('Andy Weir - The Martian (epub)');
    expect(r?.language).toBeUndefined();
    expect(r?.retail).toBe(false);
    expect(parseEbookRelease('Stephen King - It (epub)')).toMatchObject({ title: 'It' });
  });
});

describe('parseComicRelease', () => {
  it.each<[string, Partial<ParsedComicRelease>]>([
    ['Batman 050 (2018) (Digital) (Zone-Empire)', { series: 'Batman', issueNumber: '50', year: 2018, digital: true, releaseGroup: 'Zone-Empire', isPack: false, annual: false }],
    ['Batman #50 (2018)', { series: 'Batman', issueNumber: '50', year: 2018, digital: false }],
    ['Saga 054 (2018) (Digital) (Zone-Empire)', { series: 'Saga', issueNumber: '54', year: 2018 }],
    ['Saga v01 (2012) (Digital)', { series: 'Saga', volume: 1, year: 2012, digital: true, isManga: false }],
    ['Saga Vol. 1 (2012) (TPB)', { series: 'Saga', volume: 1, year: 2012, collected: true }],
    ['Saga Volume 03 (2014)', { series: 'Saga', volume: 3 }],
    ['The Amazing Spider-Man 001 (2022) (Digital)', { series: 'The Amazing Spider-Man', issueNumber: '1', year: 2022 }],
    ["X-Men '97 001 (2024)", { series: "X-Men '97", issueNumber: '1', year: 2024 }],
    ['2000 AD 2350 (2023)', { series: '2000 AD', issueNumber: '2350', year: 2023 }],
    ['Batman Annual 002 (2018)', { series: 'Batman', issueNumber: '2', annual: true }],
    ['Batman 001-050 (2016-2018) (Complete)', { series: 'Batman', issueNumber: '1', issueEnd: '50', year: 2016, isPack: true }],
    ['Batman 001-050 + Annuals (2016-2018)', { series: 'Batman', issueEnd: '50', isPack: true }],
    ['One Piece v100 (2021) (Digital)', { series: 'One Piece', volume: 100, isManga: true }],
    ['One Piece c1100 (2023)', { series: 'One Piece', issueNumber: '1100', isManga: true }],
    ['Chainsaw Man v01-v11 (2020-2023) (Digital)', { series: 'Chainsaw Man', volume: 1, isPack: true, isManga: true, year: 2020 }],
    ['Monstress 001 (2015) (digital) (Minutemen-Slayer).cbr', { series: 'Monstress', issueNumber: '1', digital: true, releaseGroup: 'Minutemen-Slayer', format: 'cbr' }],
    ['Batman - The Long Halloween (1996) (Deluxe Edition)', { series: 'Batman - The Long Halloween', year: 1996, collected: true }],
    ['Batman.050.2018.Digital.cbz-GROUP', { series: 'Batman', issueNumber: '50', year: 2018, digital: true, format: 'cbz', releaseGroup: 'GROUP' }],
    ['The.Amazing.Spider-Man.001.2022.Digital.cbr-GROUP', { series: 'The Amazing Spider-Man', issueNumber: '1', year: 2022, format: 'cbr' }],
    ['Batman 12.1 (2018)', { series: 'Batman', issueNumber: '12.1' }],
    ['Batman.12.1.2018.Digital-GROUP', { series: 'Batman', issueNumber: '12.1', year: 2018 }],
    ['Batman 000 (2018)', { series: 'Batman', issueNumber: '0' }],
    ['Batman ½ (2018)', { series: 'Batman', issueNumber: '½' }],
    ['Batman 1.MU (2018)', { series: 'Batman', issueNumber: '1.MU' }],
    ['Batman 1989 (2023)', { series: 'Batman', issueNumber: '1989', year: 2023 }],
    ['[Scanner] Batman 050 (2018).cbz', { series: 'Batman', issueNumber: '50', releaseGroup: 'Scanner', format: 'cbz' }],
    ['Saga 001 (of 6) (2012)', { series: 'Saga', issueNumber: '1', year: 2012 }],
    ['Batman 050 - The Wedding (2018) (Digital)', { series: 'Batman', issueNumber: '50' }],
    ['Saga Compendium One (2019)', { collected: true }],
    ['Berserk Deluxe Edition v01 (2019) (Manga)', { series: 'Berserk Deluxe Edition', volume: 1, isManga: true, collected: true }],
    ['Saga 054 (2018) (pdf)', { formats: ['pdf'], format: 'pdf' }],
  ])('%s', (name, expected) => {
    expect(parseComicRelease(name)).toMatchObject(expected);
  });

  it('returns null without a series', () => {
    expect(parseComicRelease('')).toBeNull();
    expect(parseComicRelease('050 (2018)')).toBeNull();
  });
});

describe('paths', () => {
  it('reads ebook paths, filling from the folders', () => {
    expect(parseEbookPath('/books/Brandon Sanderson/The Final Empire (2006)/The Final Empire.epub')).toMatchObject({
      author: 'Brandon Sanderson',
      title: 'The Final Empire',
      year: 2006,
      format: 'epub',
    });
    expect(parseEbookPath('C:\\Books\\Andy Weir - Project Hail Mary (2021)\\01.epub')).toMatchObject({
      author: 'Andy Weir',
      title: 'Project Hail Mary',
      year: 2021,
      format: 'epub',
    });
    expect(parseEbookPath('/books/Andy Weir - The Martian (epub)/The Martian - Andy Weir.epub')).toMatchObject({ author: 'Andy Weir', title: 'The Martian' });
  });

  it('reads comic paths, filling from the folder', () => {
    expect(parseComicPath('/comics/Image/Saga (2012)/054.cbz')).toMatchObject({ series: 'Saga', issueNumber: '54', year: 2012, format: 'cbz' });
    expect(parseComicPath('/comics/DC/Batman (2016)/Batman 050 (2018).cbr')).toMatchObject({ series: 'Batman', issueNumber: '50', year: 2018, format: 'cbr' });
    expect(parseComicPath('/comics/DC/Batman (2016)/Batman 050.cbr')).toMatchObject({ year: 2016 });
    expect(parseComicPath('/054.cbz')).toBeNull();
  });
});

describe('bookTitleKey', () => {
  it.each([
    ['The Final Empire', 'final empire'],
    ['Final Empire, The', 'final empire the'],
    ['Pride & Prejudice', 'pride and prejudice'],
    ['Pride and Prejudice', 'pride and prejudice'],
    ["Ender's Game", 'enders game'],
    ['Les Misérables', 'les miserables'],
    ['A Game of Thrones', 'game of thrones'],
    ['Mistborn: The Final Empire!', 'mistborn the final empire'],
    ['The', 'the'],
  ])('%s → %s', (input, key) => {
    expect(bookTitleKey(input)).toBe(key);
  });
});

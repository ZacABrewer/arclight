import { describe, expect, it } from 'vitest';
import {
  COMIC_TOKENS,
  EBOOK_TOKENS,
  NamingFormatError,
  comicRelativePath,
  ebookRelativePath,
  validateBookFormat,
  type BookNamingFormats,
  type ComicNamingInput,
  type EbookNamingInput,
} from './index.js';

const EBOOK: BookNamingFormats = { folderFormat: '{Author Name}/{Series Title}/{Book Title} ({Release Year})', fileFormat: '{Book Title} - {Author Name}' };
const COMIC: BookNamingFormats = { folderFormat: '{Publisher}/{Series Title} ({Series Year})', fileFormat: '{Series Title} #{Issue Number:000} ({Release Year})' };

const book: EbookNamingInput = {
  authorName: 'Brandon Sanderson',
  title: 'The Final Empire',
  seriesTitle: 'Mistborn',
  seriesPosition: '1',
  year: 2006,
  format: 'epub',
};

const issue: ComicNamingInput = { seriesTitle: 'Batman', seriesYear: 2016, publisher: 'DC Comics', issueNumber: '50', year: 2018, format: 'cbz' };

describe('ebookRelativePath', () => {
  it.each<[string, Partial<EbookNamingInput>, string]>([
    ['the defaults', {}, 'Brandon Sanderson/Mistborn/The Final Empire (2006)/The Final Empire - Brandon Sanderson.epub'],
    ['no series', { seriesTitle: undefined, seriesPosition: undefined }, 'Brandon Sanderson/The Final Empire (2006)/The Final Empire - Brandon Sanderson.epub'],
    ['no year', { year: undefined }, 'Brandon Sanderson/Mistborn/The Final Empire/The Final Empire - Brandon Sanderson.epub'],
    ['an upper-case extension', { format: 'AZW3' }, 'Brandon Sanderson/Mistborn/The Final Empire (2006)/The Final Empire - Brandon Sanderson.azw3'],
    ['a colon and a question mark', { title: 'Mistborn: Secret History?', seriesTitle: undefined }, 'Brandon Sanderson/Mistborn - Secret History! (2006)/Mistborn - Secret History! - Brandon Sanderson.epub'],
    ['a trailing dot', { authorName: 'J. R. R. Tolkien', title: 'Etc.', seriesTitle: undefined, year: undefined }, 'J. R. R. Tolkien/Etc/Etc. - J. R. R. Tolkien.epub'],
    ['a reserved name', { title: 'CON', seriesTitle: undefined, year: undefined }, 'Brandon Sanderson/CON_/CON - Brandon Sanderson.epub'],
  ])('%s', (_label, over, expected) => {
    expect(ebookRelativePath(EBOOK, { ...book, ...over })).toBe(expected);
  });

  it('drops a dangling separator when the author is missing', () => {
    expect(ebookRelativePath(EBOOK, { ...book, authorName: '' })).toBe('Mistborn/The Final Empire (2006)/The Final Empire.epub');
  });

  it('pads the series position and keeps decimals', () => {
    const f: BookNamingFormats = { folderFormat: '{Author SortName}/{Series Title}', fileFormat: '{Series Title} {Series Position:00} - {Book Title}' };
    expect(ebookRelativePath(f, book)).toBe('Sanderson, Brandon/Mistborn/Mistborn 01 - The Final Empire.epub');
    expect(ebookRelativePath(f, { ...book, seriesPosition: '2.5' })).toBe('Sanderson, Brandon/Mistborn/Mistborn 02.5 - The Final Empire.epub');
    expect(ebookRelativePath(f, { ...book, authorSortName: 'Sanderson, B.' })).toMatch(/^Sanderson, B\/Mistborn\//);
  });

  it('cleans empty brackets around missing tokens', () => {
    const f: BookNamingFormats = { folderFormat: '{Publisher}/{Author Name}', fileFormat: '{Book Title} [{ISBN}] ({Format})' };
    expect(ebookRelativePath(f, book)).toBe('Brandon Sanderson/The Final Empire (EPUB).epub');
    expect(ebookRelativePath(f, { ...book, publisher: 'Tor', isbn: '978-0-7653-1178-8' })).toBe('Tor/Brandon Sanderson/The Final Empire [9780765311788] (EPUB).epub');
  });

  it('keeps long names within 255 bytes', () => {
    const path = ebookRelativePath(EBOOK, { ...book, title: 'Word '.repeat(80).trim() });
    for (const component of path.split('/')) expect(new TextEncoder().encode(component).length).toBeLessThanOrEqual(255);
    expect(path.endsWith('.epub')).toBe(true);
  });

  it('throws for an invalid format', () => {
    expect(() => ebookRelativePath({ ...EBOOK, fileFormat: '{Author Name}/{Book Title}' }, book)).toThrow(NamingFormatError);
  });
});

describe('comicRelativePath', () => {
  it.each<[string, Partial<ComicNamingInput>, string]>([
    ['the defaults', {}, 'DC Comics/Batman (2016)/Batman #050 (2018).cbz'],
    ['no publisher', { publisher: undefined }, 'Batman (2016)/Batman #050 (2018).cbz'],
    ['no years', { seriesYear: undefined, year: undefined }, 'DC Comics/Batman/Batman #050.cbz'],
    ['a decimal issue', { issueNumber: '12.1' }, 'DC Comics/Batman (2016)/Batman #012.1 (2018).cbz'],
    ['a suffixed issue', { issueNumber: '1.MU' }, 'DC Comics/Batman (2016)/Batman #001.MU (2018).cbz'],
    ['issue zero', { issueNumber: '0' }, 'DC Comics/Batman (2016)/Batman #000 (2018).cbz'],
    ['a half issue', { issueNumber: '½' }, 'DC Comics/Batman (2016)/Batman #½ (2018).cbz'],
    ['an annual', { issueNumber: 'Annual 2' }, 'DC Comics/Batman (2016)/Batman #Annual 2 (2018).cbz'],
    ['an empty issue number', { issueNumber: '' }, 'DC Comics/Batman (2016)/Batman (2018).cbz'],
    ['a colon in the series', { seriesTitle: 'Batman: Year One', seriesYear: 1987, issueNumber: '1', year: 1987, format: 'CBR' }, 'DC Comics/Batman - Year One (1987)/Batman - Year One #001 (1987).cbr'],
    ['illegal characters', { seriesTitle: 'What If? <Spider*Man> "1" | 2' }, 'DC Comics/What If! Spider-Man 1 2 (2016)/What If! Spider-Man 1 2 #050 (2018).cbz'],
  ])('%s', (_label, over, expected) => {
    expect(comicRelativePath(COMIC, { ...issue, ...over })).toBe(expected);
  });

  it('pads volumes and renders issue titles', () => {
    const f: BookNamingFormats = { folderFormat: '{Series Title}/Volume {Volume:00}', fileFormat: '{Series Title} v{Volume:00} - {Issue Title}' };
    expect(comicRelativePath(f, { ...issue, seriesTitle: 'One Piece', volume: 3, issueTitle: 'Don\'t Get Fooled Again' })).toBe(
      "One Piece/Volume 03/One Piece v03 - Don't Get Fooled Again.cbz",
    );
    expect(comicRelativePath(f, { ...issue, seriesTitle: 'One Piece', volume: 3 })).toBe('One Piece/Volume 03/One Piece v03.cbz');
  });
});

describe('validateBookFormat', () => {
  it('accepts the defaults', () => {
    expect(validateBookFormat('ebook', 'folder', EBOOK.folderFormat)).toBeNull();
    expect(validateBookFormat('ebook', 'file', EBOOK.fileFormat)).toBeNull();
    expect(validateBookFormat('comic', 'folder', COMIC.folderFormat)).toBeNull();
    expect(validateBookFormat('comic', 'file', COMIC.fileFormat)).toBeNull();
  });

  it.each<['ebook' | 'comic', 'folder' | 'file', string, RegExp]>([
    ['ebook', 'file', '', /cannot be empty/],
    ['ebook', 'file', '{Author Name}/{Book Title}', /path separators/],
    ['ebook', 'folder', '{Issue Number}', /unknown token/],
    ['comic', 'file', '{Book Title}', /unknown token/],
    ['comic', 'file', '{Series Title} {Issue Number:abc}', /zero-padding/],
    ['ebook', 'file', '{Release Year:4}', /does not take a modifier/],
    ['ebook', 'file', '{Book Title', /malformed/],
    ['ebook', 'folder', '()/ - ', /empty name/],
  ])('%s %s %j', (kind, part, format, error) => {
    expect(validateBookFormat(kind, part, format)).toMatch(error);
  });

  it('lists the tokens for the settings page', () => {
    expect(EBOOK_TOKENS).toContain('{Series Position}');
    expect(COMIC_TOKENS).toContain('{Issue Number}');
    expect(COMIC_TOKENS).not.toContain('{Book Title}');
  });
});

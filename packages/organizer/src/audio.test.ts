import { describe, expect, it } from 'vitest';
import { NAMING_DEFAULTS, NamingConfig } from '@arclight/shared';
import {
  NamingFormatError,
  buildAlbumFolder,
  buildArtistFolder,
  buildAuthorFolder,
  buildBookFileName,
  buildBookFolder,
  buildTrackFileName,
  getSamples,
  releaseYearOf,
  seriesPositionText,
  trackFormatFor,
  type NamingAlbum,
  type NamingArtist,
  type NamingBook,
  type NamingFile,
  type NamingTrack,
} from './index.js';

const cfg = (o: Partial<NamingConfig> = {}): NamingConfig => ({ ...NAMING_DEFAULTS, renameTracks: true, renameAudiobooks: true, ...o });

const artist: NamingArtist = { name: 'Radiohead' };
const album: NamingAlbum = { title: 'OK Computer', albumType: 'Album', releaseDate: '1997-05-21' };
const track: NamingTrack = { title: 'Paranoid Android', trackNumber: 2, mediumNumber: 1 };
const flac: NamingFile = {
  id: 0,
  relativePath: 'incoming/02 paranoid android.flac',
  quality: { quality: { name: 'FLAC' }, revision: { version: 1, real: 0 } },
};

describe('NamingConfig music/audiobook fields', () => {
  it('has the design defaults', () => {
    expect(NAMING_DEFAULTS).toMatchObject({
      renameTracks: false,
      artistFolderFormat: '{Artist Name}',
      albumFolderFormat: '{Album Title} ({Release Year})',
      trackFormat: '{track:00} - {Track Title}',
      multiDiscTrackFormat: '{medium:0}-{track:00} - {Track Title}',
      multiDiscStyle: 'prefix',
      renameAudiobooks: false,
      authorFolderFormat: '{Author Name}',
      seriesBookFolderFormat: '{Series Title}/Book {Series Position} - {Book Title}',
      bookFolderFormat: '{Book Title}',
      bookFileFormat: '{Book Title}',
      bookPartFormat: '{Part:00} - {Book Title}',
    });
  });

  it('validates track and part formats', () => {
    expect(NamingConfig.safeParse({ trackFormat: '{Track Title}' }).success).toBe(false);
    expect(NamingConfig.safeParse({ trackFormat: '{TRACK:000} {Track Title}' }).success).toBe(true);
    expect(NamingConfig.safeParse({ multiDiscTrackFormat: '{track:00} - {Track Title}' }).success).toBe(false);
    expect(NamingConfig.safeParse({ multiDiscStyle: 'nested' }).success).toBe(false);
    expect(NamingConfig.safeParse({ artistFolderFormat: '  ' }).success).toBe(false);
    expect(NamingConfig.safeParse({ bookPartFormat: '{Book Title}' }).success).toBe(false);
    expect(NamingConfig.safeParse({ multiDiscStyle: 'subfolder' }).success).toBe(true);
  });
});

describe('music builders', () => {
  it('builds the default layout', () => {
    const c = cfg();
    expect(buildArtistFolder(c, artist)).toBe('Radiohead');
    expect(buildAlbumFolder(c, artist, album)).toBe('OK Computer (1997)');
    expect(buildTrackFileName(c, artist, album, track, flac, { extension: '.flac' })).toBe('02 - Paranoid Android.flac');
  });

  it('multi-disc prefix and subfolder styles', () => {
    const disc2 = { ...track, mediumNumber: 2, trackNumber: 5 };
    expect(buildTrackFileName(cfg(), artist, album, disc2, flac, { mediumCount: 2, extension: '.flac' })).toBe('2-05 - Paranoid Android.flac');
    expect(buildTrackFileName(cfg({ multiDiscStyle: 'subfolder' }), artist, album, disc2, flac, { mediumCount: 2 })).toBe(
      'Disc 2/05 - Paranoid Android',
    );
    // Single-medium albums never get the disc prefix.
    expect(buildTrackFileName(cfg(), artist, album, track, flac, { mediumCount: 1 })).toBe('02 - Paranoid Android');
    expect(trackFormatFor(cfg({ multiDiscStyle: 'subfolder' }), 3)).toBe('Disc {medium}/{track:00} - {Track Title}');
  });

  it('renders every music token', () => {
    const c = cfg({
      trackFormat:
        '{Artist CleanName} - {Album Type} - {Release Year} - {medium:00}{track:000} - {Track ArtistName} - {Track Title} [{Quality Title}]',
      albumFolderFormat: '{Artist Name}/{Album Title} [{Album Type}]',
    });
    const t: NamingTrack = { ...track, artistName: 'Radiohead feat. Someone' };
    expect(buildTrackFileName(c, { name: "Guns N' Roses & Friends" }, album, t, flac)).toBe(
      'Guns N Roses and Friends - Album - 1997 - 01002 - Radiohead feat. Someone - Paranoid Android [FLAC]',
    );
    expect(buildAlbumFolder(c, artist, album)).toBe('Radiohead/OK Computer [Album]');
  });

  it('track artist falls back to the album artist', () => {
    const c = cfg({ trackFormat: '{track:00} {Track ArtistName}' });
    expect(buildTrackFileName(c, artist, album, track, flac)).toBe('02 Radiohead');
  });

  it('replaces illegal characters like video and drops empty brackets', () => {
    const odd: NamingAlbum = { title: 'Hail to the Thief: Live? / <Remix>*', year: null };
    expect(buildAlbumFolder(cfg(), { name: 'AC/DC' }, odd)).toBe('Hail to the Thief - Live! + Remix-');
    expect(buildArtistFolder(cfg(), { name: 'AC/DC' })).toBe('AC+DC');
    expect(buildArtistFolder(cfg({ replaceIllegalCharacters: false }), { name: 'AC/DC: "Live"' })).toBe('ACDC Live');
    expect(buildTrackFileName(cfg({ colonReplacement: 'dash' }), artist, album, { ...track, title: 'Part: One' }, flac)).toBe(
      '02 - Part- One',
    );
  });

  it('release year from date or year', () => {
    expect(releaseYearOf('2001-02', null)).toBe('2001');
    expect(releaseYearOf(null, 1999)).toBe('1999');
    expect(releaseYearOf('', 0)).toBe('');
    expect(buildAlbumFolder(cfg(), artist, { title: 'Kid A', year: 2000 })).toBe('Kid A (2000)');
  });

  it('keeps the original name when renaming is off', () => {
    expect(buildTrackFileName(cfg({ renameTracks: false }), artist, album, track, flac, { extension: '.flac' })).toBe(
      '02 paranoid android.flac',
    );
  });

  it('rejects formats it cannot render', () => {
    expect(() => buildTrackFileName(cfg({ trackFormat: '{Track Title}' }), artist, album, track, flac)).toThrow(NamingFormatError);
    expect(() => buildTrackFileName(cfg({ multiDiscTrackFormat: '{track} x' }), artist, album, track, flac, { mediumCount: 2 })).toThrow(
      /must contain \{medium\}/,
    );
    expect(() => buildArtistFolder(cfg({ artistFolderFormat: '' }), artist)).toThrow(/cannot be empty/);
  });
});

describe('audiobook builders', () => {
  const author = { name: 'Brandon Sanderson' };
  const book: NamingBook = {
    title: 'The Way of Kings',
    subtitle: 'Book One',
    seriesTitle: 'The Stormlight Archive',
    seriesPosition: 1,
    narrators: ['Michael Kramer', 'Kate Reading'],
  };
  const m4b: NamingFile = { id: 0, relativePath: 'wok.m4b', quality: { quality: { name: 'M4B' }, revision: { version: 1, real: 0 } } };

  it('builds the default layouts', () => {
    expect(buildAuthorFolder(cfg(), author)).toBe('Brandon Sanderson');
    expect(buildBookFolder(cfg(), author, book)).toBe('The Stormlight Archive/Book 1 - The Way of Kings');
    expect(buildBookFolder(cfg(), author, { title: 'Elantris' })).toBe('Elantris');
    expect(buildBookFileName(cfg(), author, book, m4b, { extension: '.m4b' })).toBe('The Way of Kings.m4b');
    expect(buildBookFileName(cfg(), author, book, m4b, { part: 3, partCount: 40, extension: '.mp3' })).toBe('03 - The Way of Kings.mp3');
  });

  it('renders every audiobook token', () => {
    const c = cfg({ bookFileFormat: '{Author Name} - {Series Title} {Series Position:00} - {Book Title} - {Book Subtitle} ({Narrator}) {Part:00}' });
    expect(buildBookFileName(c, author, book, m4b)).toBe(
      'Brandon Sanderson - The Stormlight Archive 01 - The Way of Kings - Book One (Michael Kramer) 01',
    );
  });

  it('series positions', () => {
    expect(seriesPositionText(3, '00')).toBe('03');
    expect(seriesPositionText('2.5', '00')).toBe('02.5');
    expect(seriesPositionText('1-2', '00')).toBe('1-2');
    expect(seriesPositionText(null, undefined)).toBe('');
  });

  it('keeps the original name when renaming is off', () => {
    expect(buildBookFileName(cfg({ renameAudiobooks: false }), author, book, m4b, { extension: '.m4b' })).toBe('wok.m4b');
  });

  it('requires {Part} in the part format', () => {
    expect(() => buildBookFileName(cfg({ bookPartFormat: '{Book Title}' }), author, book, m4b, { partCount: 2 })).toThrow(/\{part\}/);
  });
});

describe('samples', () => {
  it('include music and audiobook samples', () => {
    const s = getSamples(NAMING_DEFAULTS);
    expect(s.artistFolder.value).toBe('The Artist Name');
    expect(s.albumFolder.value).toBe('The Album Title - Deluxe (2020)');
    expect(s.track.value).toBe('03 - Track Title');
    expect(s.multiDiscTrack.value).toBe('2-03 - Track Title');
    expect(s.authorFolder.value).toBe('Author Name');
    expect(s.bookFolder.value).toBe('Book Title');
    expect(s.seriesBookFolder.value).toBe('Series Title/Book 3 - Book Title');
    expect(s.bookFile.value).toBe('Book Title');
    expect(s.bookPart.value).toBe('01 - Book Title');
    expect(getSamples({ ...NAMING_DEFAULTS, multiDiscStyle: 'subfolder' }).multiDiscTrack.value).toBe('Disc 2/03 - Track Title');
  });

  it('report a broken music format as an error', () => {
    const s = getSamples({ ...NAMING_DEFAULTS, trackFormat: '{Track Title}' });
    expect(s.track.value).toBeNull();
    expect(s.track.error).toMatch(/Track format/);
  });
});

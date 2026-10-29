import { QUALITIES, type AudioFile, type Author, type AuthorDetails, type Book, type BookDetails, type BookSeriesDetails, type BookSeriesSummary } from '@arclight/shared';

// Test fixtures for the audiobook pages (only imported by *.test.ts[x]). Names are invented.

export const ASIN = (n: number) => `B0${String(n).padStart(8, '0')}`;

export function makeAuthor(over: Partial<Author> & { id: number; name: string }): Author {
  return {
    asin: ASIN(over.id),
    olAuthorId: null,
    sortName: over.name,
    cleanName: over.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
    overview: '',
    images: [],
    genres: [],
    aliases: [],
    path: `/audiobooks/${over.name}`,
    rootFolderPath: '/audiobooks',
    qualityProfileId: 21,
    monitored: true,
    monitorNewBooks: 'all',
    languages: [],
    tags: [],
    added: '2026-01-01T00:00:00.000Z',
    lastRefreshed: '2026-01-02T00:00:00.000Z',
    nextRefreshAt: null,
    statistics: {
      bookCount: 4,
      monitoredBookCount: 4,
      availableBookCount: 2,
      missingBookCount: 2,
      fileCount: 3,
      sizeOnDisk: 900 * 1024 ** 2,
      seriesCount: 1,
      percentOfBooks: 50,
    },
    ...over,
  };
}

export function makeBook(over: Partial<Book> & { id: number; title: string }): Book {
  return {
    authorId: 1,
    asin: ASIN(1000 + over.id),
    isbn13: null,
    olWorkId: null,
    region: 'us',
    subtitle: null,
    sortTitle: over.title,
    cleanTitle: over.title.toLowerCase().replace(/[^a-z0-9]/g, ''),
    authorCredits: [{ name: 'Author', authorId: 1 }],
    narrators: [],
    publisher: null,
    language: 'english',
    releaseDate: '2020-01-01',
    year: 2020,
    runtimeMinutes: 600,
    formatType: 'unabridged',
    overview: '',
    genres: [],
    images: [],
    chapters: [],
    ratings: {},
    monitored: true,
    hasFile: false,
    path: null,
    series: [],
    added: '2026-01-01T00:00:00.000Z',
    lastRefreshed: null,
    statistics: { fileCount: 0, sizeOnDisk: 0, durationMs: null },
    ...over,
  };
}

export function seriesLink(seriesId: number, name: string, position: string | null, bookId = 0, isPrimary = true): Book['series'][number] {
  const n = position ? Number.parseFloat(position) : Number.NaN;
  return { seriesId, bookId, name, position, positionSort: Number.isFinite(n) ? n : null, isPrimary };
}

export function makeSeriesSummary(over: Partial<BookSeriesSummary> & { id: number; name: string }): BookSeriesSummary {
  return { asin: null, cleanName: over.name.toLowerCase().replace(/[^a-z0-9]/g, ''), overview: '', bookCount: 0, availableBookCount: 0, ...over };
}

export function makeAuthorDetails(author: Author, books: Book[], series: BookSeriesSummary[] = []): AuthorDetails {
  return { ...author, books, series };
}

const summary = (a: Author) => ({ id: a.id, asin: a.asin, name: a.name, sortName: a.sortName, path: a.path, images: a.images });

export function makeBookDetails(book: Book, extra: { author?: Author; files?: AudioFile[] } = {}): BookDetails {
  const author = extra.author ?? makeAuthor({ id: book.authorId, name: 'Author' });
  return { ...book, author: summary(author), contributors: [], files: extra.files ?? [] };
}

export function makeSeriesDetails(over: { id: number; name: string; books: Book[]; authors: Author[] }): BookSeriesDetails {
  return { asin: null, cleanName: over.name.toLowerCase(), overview: '', id: over.id, name: over.name, books: over.books, authors: over.authors.map(summary) };
}

export function makeAudiobookFile(over: Partial<AudioFile> & { id: number }): AudioFile {
  return {
    mediaType: 'audiobook',
    authorId: 1,
    bookId: 1,
    path: `/audiobooks/Author/Book/Part ${over.id}.mp3`,
    relativePath: `Book/Part ${over.id}.mp3`,
    sizeBytes: 60 * 1024 ** 2,
    dateAdded: '2026-01-03T00:00:00.000Z',
    quality: { quality: { ...QUALITIES['AB-MP3'] }, revision: { version: 1, real: 0, isRepack: false } },
    codec: 'MP3',
    container: 'mp3',
    bitrateKbps: 64,
    channels: 2,
    durationMs: 3_600_000,
    partNumber: over.id,
    ...over,
  } as AudioFile;
}

/** Audiobook-domain quality profiles (as the api returns them for ?mediaDomain=audiobook). */
export const audiobookProfiles = [
  { id: 21, name: 'Standard', upgradeAllowed: true, cutoff: 211, items: [{ kind: 'quality', qualityId: 211, allowed: true }], minFormatScore: 0, cutoffFormatScore: 0, minUpgradeFormatScore: 1, formatItems: [], languages: [], mediaDomain: 'audiobook' },
  { id: 22, name: 'M4B only', upgradeAllowed: true, cutoff: 211, items: [{ kind: 'quality', qualityId: 211, allowed: true }], minFormatScore: 0, cutoffFormatScore: 0, minUpgradeFormatScore: 1, formatItems: [], languages: [], mediaDomain: 'audiobook' },
];

export const audiobookRoots = [
  { id: 1, path: '/data/tv', mediaType: 'series', accessible: true, freeSpaceBytes: 1e12 },
  { id: 5, path: '/data/audiobooks', mediaType: 'audiobook', accessible: true, freeSpaceBytes: 1e12 },
];

export const AB_FEATURES_ON = { music: false, audiobooks: true };
export const AB_FEATURES_OFF = { music: false, audiobooks: false };

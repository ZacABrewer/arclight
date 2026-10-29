import type {
  AudiobookImage,
  AudiobookMonitorOption,
  Author,
  AuthorStatistics,
  Book,
  BookChapter,
  BookFormatType,
  BookSeriesSummary,
  MonitorNewBooks,
} from '@arclight/shared';
import { AudiobookMonitorOption as MonitorOptions, MonitorNewBooks as NewBookOptions } from '@arclight/shared';
import { parseDateish } from '../../../components/media/format.js';
import { t } from '../../../i18n/index.js';

// Pure helpers for the audiobook pages (exported for tests).

/** First image of the preferred types, in order. */
export function audiobookImage(images: readonly AudiobookImage[] | undefined, ...types: AudiobookImage['coverType'][]): string | undefined {
  for (const type of types) {
    const hit = images?.find((i) => i.coverType === type);
    if (hit) return hit.url || hit.remoteUrl || undefined;
  }
  return undefined;
}

export const authorImage = (a: { images: readonly AudiobookImage[] }) => audiobookImage(a.images, 'headshot', 'cover');
export const authorBackdrop = (a: { images: readonly AudiobookImage[] }) => audiobookImage(a.images, 'fanart', 'banner');
export const bookCover = (b: { images: readonly AudiobookImage[] }) => audiobookImage(b.images, 'cover');

/** Up to two initials for an author without a headshot ("Mara J. Quill" → "MQ"). */
export function authorInitials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (words.length === 0) return '#';
  const first = words[0]!.match(/[\p{L}\p{N}]/u)![0];
  const last = words.length > 1 ? words[words.length - 1]!.match(/[\p{L}\p{N}]/u)![0] : '';
  return (first + last).toLocaleUpperCase();
}

/** "11 h 24 min", "45 min"; '—' when unknown. */
export function formatRuntime(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return '—';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return t('audiobooks.runtimeMinutes', { m });
  return m === 0 ? t('audiobooks.runtimeHours', { h }) : t('audiobooks.runtimeHoursMinutes', { h, m });
}

/** Chapter start as h:mm:ss / m:ss. */
export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Chapter lengths, from `lengthMs` or the next chapter's start (the last one from the runtime). */
export function chapterRows(chapters: readonly BookChapter[], runtimeMinutes?: number | null): Array<BookChapter & { index: number; durationMs: number | null }> {
  const sorted = [...chapters].sort((a, b) => a.startMs - b.startMs);
  const end = runtimeMinutes ? runtimeMinutes * 60_000 : null;
  return sorted.map((c, i) => {
    const next = sorted[i + 1]?.startMs ?? end;
    const durationMs = c.lengthMs ?? (next != null && next > c.startMs ? next - c.startMs : null);
    return { ...c, index: i + 1, durationMs };
  });
}

export interface BookProgress {
  have: number;
  total: number;
  /** 0-100. */
  percent: number;
}

/** Available monitored books over monitored books (all books when nothing is monitored). */
export function authorProgress(stats: Pick<AuthorStatistics, 'bookCount' | 'monitoredBookCount' | 'availableBookCount'> | null | undefined): BookProgress {
  const have = stats?.availableBookCount ?? 0;
  const total = stats?.monitoredBookCount || stats?.bookCount || 0;
  return { have: Math.min(have, Math.max(total, have)), total, percent: total > 0 ? Math.min(100, (have / total) * 100) : 0 };
}

export const progressText = (p: BookProgress) => `${p.have}/${p.total}`;

export const formatTypeLabel = (type: BookFormatType) => t('audiobooks.formatType', { type });
export const monitorOptionLabel = (option: AudiobookMonitorOption) => t('audiobooks.monitorOption', { option });
export const monitorNewBooksLabel = (value: MonitorNewBooks) => t('audiobooks.monitorNewBooks', { value });

export const MONITOR_OPTIONS = MonitorOptions.options;
export const NEW_BOOK_OPTIONS = NewBookOptions.options;

/** "Book 3", "Book 2.5", "Books 1-3", or the catalogue's own word ("Prequel"). */
export function positionLabel(position: string | null | undefined): string | null {
  const p = position?.trim();
  if (!p) return null;
  if (/^\d+(?:\.\d+)?$/.test(p)) return t('audiobooks.bookPosition', { position: p });
  if (/^\d+(?:\.\d+)?\s*[-–]\s*\d+(?:\.\d+)?$/.test(p)) return t('audiobooks.bookRange', { range: p.replace(/\s*[-–]\s*/, '–') });
  return p;
}

export function bookYear(b: Pick<Book, 'year' | 'releaseDate'>): number | null {
  if (b.year) return b.year;
  const m = /^(\d{4})/.exec(b.releaseDate ?? '');
  return m ? Number(m[1]) : null;
}

/** "Book 3 · The Way of Kings" title with its primary series position, for lists. */
export function primarySeries(b: Pick<Book, 'series'>): Book['series'][number] | undefined {
  return b.series.find((s) => s.isPrimary) ?? b.series[0];
}

/** Oldest first; undated books last. */
function byRelease(a: Book, b: Book): number {
  const da = a.releaseDate ?? (a.year ? String(a.year) : '');
  const db = b.releaseDate ?? (b.year ? String(b.year) : '');
  if (da !== db) return da === '' ? 1 : db === '' ? -1 : da.localeCompare(db);
  return a.sortTitle.localeCompare(b.sortTitle);
}

export interface SeriesEntryView {
  book: Book;
  position: string | null;
  positionSort: number | null;
}

export interface SeriesGroup {
  seriesId: number;
  name: string;
  entries: SeriesEntryView[];
}

export interface BookGroups {
  series: SeriesGroup[];
  standalone: Book[];
}

/** Sort entries by numeric position, then unnumbered entries by release date. */
export function sortSeriesEntries(entries: readonly SeriesEntryView[]): SeriesEntryView[] {
  return [...entries].sort((a, b) => {
    if (a.positionSort != null && b.positionSort != null && a.positionSort !== b.positionSort) return a.positionSort - b.positionSort;
    if (a.positionSort != null && b.positionSort == null) return -1;
    if (a.positionSort == null && b.positionSort != null) return 1;
    return byRelease(a.book, b.book);
  });
}

/**
 * Books grouped by the series they are filed under (their primary series), in position order;
 * books outside any series are standalone, oldest first. Series are ordered by name.
 */
export function groupBooks(books: readonly Book[], seriesList: readonly Pick<BookSeriesSummary, 'id' | 'name'>[] = []): BookGroups {
  const names = new Map(seriesList.map((s) => [s.id, s.name]));
  const groups = new Map<number, SeriesGroup>();
  const standalone: Book[] = [];
  for (const book of books) {
    const s = primarySeries(book);
    if (!s) {
      standalone.push(book);
      continue;
    }
    const g = groups.get(s.seriesId) ?? { seriesId: s.seriesId, name: s.name || names.get(s.seriesId) || `#${s.seriesId}`, entries: [] };
    g.entries.push({ book, position: s.position ?? null, positionSort: s.positionSort ?? parsePosition(s.position) });
    groups.set(s.seriesId, g);
  }
  const series = [...groups.values()]
    .map((g) => ({ ...g, entries: sortSeriesEntries(g.entries) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { series, standalone: standalone.sort(byRelease) };
}

/** Numeric sort key of a position ("3" → 3, "2.5" → 2.5, "1-3" → 1); null without a number. */
export function parsePosition(position: string | null | undefined): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)/.exec(position ?? '');
  return m ? Number(m[1]) : null;
}

/** Book status chip on the calendar and wanted lists. */
export type BookState = 'downloaded' | 'unaired' | 'wanted' | 'missing';

export function bookState(book: Pick<Book, 'monitored' | 'releaseDate' | 'hasFile'>, now: Date = new Date()): BookState {
  if (book.hasFile) return 'downloaded';
  const released = book.releaseDate ? parseDateish(book.releaseDate) : null;
  if (released && released.getTime() > now.getTime()) return 'unaired';
  return book.monitored ? 'wanted' : 'missing';
}

/** "Mara Quill, Theo Lark" from the credits. */
export function creditNames(b: Pick<Book, 'authorCredits'>): string {
  return b.authorCredits.map((c) => c.name).join(', ');
}

// ---------------------------------------------------------------------------------------
// Author index: filters and sort
// ---------------------------------------------------------------------------------------

export type AuthorMonitoredFilter = 'all' | 'monitored' | 'unmonitored';

export interface AuthorFilters {
  search: string;
  monitored: AuthorMonitoredFilter;
  qualityProfileId: number | null;
  /** Only authors with monitored books missing. */
  missing: boolean;
}

export const DEFAULT_AUTHOR_FILTERS: AuthorFilters = { search: '', monitored: 'all', qualityProfileId: null, missing: false };

export function activeAuthorFilterCount(f: AuthorFilters): number {
  return [f.search.trim() !== '', f.monitored !== 'all', f.qualityProfileId !== null, f.missing].filter(Boolean).length;
}

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function filterAuthors(list: readonly Author[], f: AuthorFilters): Author[] {
  const q = fold(f.search.trim());
  return list.filter((a) => {
    if (q && !fold(a.name).includes(q) && !a.aliases.some((x) => fold(x).includes(q))) return false;
    if (f.monitored === 'monitored' && !a.monitored) return false;
    if (f.monitored === 'unmonitored' && a.monitored) return false;
    if (f.qualityProfileId !== null && a.qualityProfileId !== f.qualityProfileId) return false;
    if (f.missing && (a.statistics?.missingBookCount ?? 0) === 0) return false;
    return true;
  });
}

export type AuthorSortKey = 'name' | 'added' | 'books' | 'progress' | 'size';

export interface AuthorSort {
  key: AuthorSortKey;
  direction: 'asc' | 'desc';
}

export const AUTHOR_SORT_KEYS: readonly AuthorSortKey[] = ['name', 'added', 'books', 'progress', 'size'];
export const authorSortLabel = (key: AuthorSortKey) => t('audiobooks.sortKey', { key });

function sortValue(a: Author, key: AuthorSortKey): string | number {
  switch (key) {
    case 'name':
      return a.sortName.toLowerCase();
    case 'added':
      return a.added;
    case 'books':
      return a.statistics?.bookCount ?? 0;
    case 'progress':
      return authorProgress(a.statistics).percent;
    case 'size':
      return a.statistics?.sizeOnDisk ?? 0;
  }
}

export function sortAuthors(list: readonly Author[], sort: AuthorSort): Author[] {
  const dir = sort.direction === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    const va = sortValue(a, sort.key);
    const vb = sortValue(b, sort.key);
    const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
    return c !== 0 ? c * dir : a.sortName.localeCompare(b.sortName);
  });
}

/** Destination folder preview for the add dialog: `<root>/<Author Name>`. */
export function authorFolder(root: string, name: string): string {
  if (!root) return '';
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const clean = name.replace(/[<>:"/\\|?*]/g, '').trim();
  return `${root.replace(/[\\/]+$/, '')}${sep}${clean}`;
}

/** Audible store link for a book or author ASIN in a marketplace. */
export function audibleUrl(kind: 'book' | 'author', asin: string, tld = 'com'): string {
  return kind === 'book' ? `https://www.audible.${tld}/pd/${asin}` : `https://www.audible.${tld}/author/${asin}`;
}

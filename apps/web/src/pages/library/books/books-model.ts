import type {
  BooksFormat,
  BooksCommand,
  BooksFormatProfile,
  BooksKind,
  BooksRelease,
  BooksRequestStatus,
  BooksSourceState,
  BooksWantedItem,
  ComicIssue,
  ComicSeries,
  Ebook,
  EbookAuthor,
  EbookAuthorDetails,
} from '@arclight/shared';

// Pure helpers for the ebook and comic pages (filters, sorting, grouping, parsing). No React here,
// so every rule is covered by books-model.test.ts.

export type ShelfMonitoredFilter = 'all' | 'monitored' | 'unmonitored';

export interface ShelfFilters {
  search: string;
  monitored: ShelfMonitoredFilter;
  /** Only entries with wanted items (monitored, without a file). */
  missing: boolean;
  /** Only entries whose format profile accepts this format. */
  format: BooksFormat | null;
}

export const DEFAULT_SHELF_FILTERS: ShelfFilters = { search: '', monitored: 'all', missing: false, format: null };

export function activeShelfFilterCount(f: ShelfFilters): number {
  return (f.search.trim() ? 1 : 0) + (f.monitored !== 'all' ? 1 : 0) + (f.missing ? 1 : 0) + (f.format ? 1 : 0);
}

export interface Progress {
  have: number;
  total: number;
  percent: number;
}

/** Files on disk out of the monitored items (an entry with nothing monitored is complete). */
export function shelfProgress(stats: { monitoredCount: number; availableCount: number } | undefined): Progress {
  const total = stats?.monitoredCount ?? 0;
  const have = Math.min(stats?.availableCount ?? 0, total);
  return { have, total, percent: total === 0 ? 100 : Math.round((have / total) * 100) };
}

/** Normalise for search: lower case, accents dropped, punctuation folded to spaces. */
export function fold(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Every word of the query appears somewhere in the haystack fields. */
export function matchesSearch(query: string, fields: ReadonlyArray<string | null | undefined>): boolean {
  const words = fold(query).split(' ').filter(Boolean);
  if (words.length === 0) return true;
  const hay = fold(fields.filter(Boolean).join(' '));
  return words.every((w) => hay.includes(w));
}

/** The entry's profile accepts the format (unknown profiles never match a format filter). */
function profileAccepts(profileId: number, format: BooksFormat | null, profiles: readonly BooksFormatProfile[] | undefined): boolean {
  if (!format) return true;
  return profiles?.find((p) => p.id === profileId)?.formats.includes(format) ?? false;
}

interface ShelfEntry {
  monitored: boolean;
  formatProfileId: number;
  statistics: { monitoredCount: number; availableCount: number };
}

function passes(e: ShelfEntry, f: ShelfFilters, profiles: readonly BooksFormatProfile[] | undefined): boolean {
  if (f.monitored === 'monitored' && !e.monitored) return false;
  if (f.monitored === 'unmonitored' && e.monitored) return false;
  if (f.missing && e.statistics.availableCount >= e.statistics.monitoredCount) return false;
  return profileAccepts(e.formatProfileId, f.format, profiles);
}

export function filterAuthors(list: readonly EbookAuthor[], f: ShelfFilters, profiles?: readonly BooksFormatProfile[]): EbookAuthor[] {
  return list.filter((a) => passes(a, f, profiles) && matchesSearch(f.search, [a.name, a.sortName]));
}

export function filterComics(list: readonly ComicSeries[], f: ShelfFilters, profiles?: readonly BooksFormatProfile[]): ComicSeries[] {
  return list.filter((s) => passes(s, f, profiles) && matchesSearch(f.search, [s.title, s.publisher, s.startYear?.toString()]));
}

export const SHELF_SORT_KEYS = ['name', 'added', 'count', 'progress', 'size'] as const;
export type ShelfSortKey = (typeof SHELF_SORT_KEYS)[number];
export interface ShelfSort {
  key: ShelfSortKey;
  direction: 'asc' | 'desc';
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function sortBy<T>(list: readonly T[], value: (x: T) => string | number, name: (x: T) => string, direction: 'asc' | 'desc'): T[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : collator.compare(String(va), String(vb));
    return c !== 0 ? c * sign : collator.compare(name(a), name(b));
  });
}

export function sortAuthors(list: readonly EbookAuthor[], s: ShelfSort): EbookAuthor[] {
  const value = (a: EbookAuthor): string | number => {
    switch (s.key) {
      case 'name':
        return a.sortName || a.name;
      case 'added':
        return a.added;
      case 'count':
        return a.statistics.bookCount;
      case 'progress':
        return shelfProgress(a.statistics).percent;
      case 'size':
        return a.statistics.sizeOnDisk;
    }
  };
  return sortBy(list, value, (a) => a.sortName || a.name, s.direction);
}

export function sortComics(list: readonly ComicSeries[], s: ShelfSort): ComicSeries[] {
  const value = (c: ComicSeries): string | number => {
    switch (s.key) {
      case 'name':
        return c.sortTitle || c.title;
      case 'added':
        return c.added;
      case 'count':
        return c.statistics.issueCount;
      case 'progress':
        return shelfProgress(c.statistics).percent;
      case 'size':
        return c.statistics.sizeOnDisk;
    }
  };
  return sortBy(list, value, (c) => c.sortTitle || c.title, s.direction);
}

/** The newest entries first (the shelf's "Recently added" row). */
export function recentlyAdded<T extends { added: string }>(list: readonly T[], count: number): T[] {
  return [...list].sort((a, b) => (a.added < b.added ? 1 : a.added > b.added ? -1 : 0)).slice(0, count);
}

/**
 * A series position as a number for ordering: `3` → 3, `2.5` → 2.5, `1-3` → 1, `½` → 0.5.
 * Unknown positions sort last (Infinity).
 */
export function positionValue(position: string | null | undefined): number {
  if (!position) return Number.POSITIVE_INFINITY;
  const text = position.replace('½', '.5').trim();
  const m = /-?\d*\.?\d+/.exec(text);
  return m ? Number(m[0]) : Number.POSITIVE_INFINITY;
}

export function byPosition<T extends { position: string | null; title: string }>(a: T, b: T): number {
  const d = positionValue(a.position) - positionValue(b.position);
  if (d !== 0 && Number.isFinite(d)) return d;
  if (!Number.isFinite(positionValue(a.position)) !== !Number.isFinite(positionValue(b.position))) {
    return Number.isFinite(positionValue(a.position)) ? -1 : 1;
  }
  return collator.compare(a.title, b.title);
}

export interface SeriesGroup {
  id: number;
  name: string;
  books: Array<Ebook & { position: string | null }>;
}

/**
 * An author's books split into their series (reading order) and the standalone books (by year).
 * A book in two series appears in both; the series follow the order the details list them in.
 */
export function groupBySeries(author: Pick<EbookAuthorDetails, 'books' | 'series'>): { series: SeriesGroup[]; standalone: Ebook[] } {
  const groups = new Map<number, SeriesGroup>();
  for (const s of author.series) groups.set(s.id, { id: s.id, name: s.name, books: [] });
  const standalone: Ebook[] = [];
  for (const book of author.books) {
    if (book.series.length === 0) {
      standalone.push(book);
      continue;
    }
    for (const link of book.series) {
      let g = groups.get(link.seriesId);
      if (!g) {
        g = { id: link.seriesId, name: link.name, books: [] };
        groups.set(link.seriesId, g);
      }
      g.books.push({ ...book, position: link.position });
    }
  }
  const series = [...groups.values()].filter((g) => g.books.length > 0);
  for (const g of series) g.books.sort(byPosition);
  standalone.sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999) || collator.compare(a.sortTitle || a.title, b.sortTitle || b.title));
  return { series, standalone };
}

/** Issues in publication order: `issueSort` when known, else the printed number (natural order). */
export function sortIssues(issues: readonly ComicIssue[], direction: 'asc' | 'desc' = 'asc'): ComicIssue[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...issues].sort((a, b) => {
    const sa = a.issueSort ?? positionValue(a.issueNumber);
    const sb = b.issueSort ?? positionValue(b.issueNumber);
    if (sa !== sb && Number.isFinite(sa - sb)) return (sa - sb) * sign;
    return collator.compare(a.issueNumber, b.issueNumber) * sign;
  });
}

/** The day an issue counts as released: the on-sale date, else the cover date. */
export function issueDate(issue: Pick<ComicIssue, 'storeDate' | 'coverDate'>): string | null {
  return issue.storeDate ?? issue.coverDate ?? null;
}

/** `EPUB`, `CBZ` … (formats are shown upper-case, like file extensions). */
export function formatLabel(format: BooksFormat | null | undefined): string {
  return format ? format.toUpperCase() : '';
}

/** Chip tone for a catalogue source's state in the add screens. */
export function sourceStateTone(state: BooksSourceState): 'accent' | 'neutral' | 'warn' | 'danger' | 'muted' {
  switch (state) {
    case 'ok':
      return 'accent';
    case 'cached':
      return 'neutral';
    case 'stale':
      return 'warn';
    case 'failed':
      return 'danger';
    case 'disabled':
      return 'muted';
  }
}

export function requestStatusTone(status: BooksRequestStatus, available: boolean): 'accent' | 'neutral' | 'warn' | 'danger' | 'default' {
  if (available || status === 'completed') return 'accent';
  switch (status) {
    case 'pending':
      return 'warn';
    case 'approved':
      return 'default';
    case 'declined':
      return 'neutral';
    case 'failed':
      return 'danger';
  }
}

/** Approved releases first, then by score (high first), then by seeders. */
export function sortReleases(list: readonly BooksRelease[]): BooksRelease[] {
  return [...list].sort((a, b) => Number(b.approved) - Number(a.approved) || b.score - a.score || (b.seeders ?? -1) - (a.seeders ?? -1));
}

/** Whole days since a release was posted (0 for today or a date in the future, null when unreadable). */
export function releaseAgeDays(publishDate: string, now: Date = new Date()): number | null {
  const ms = Date.parse(publishDate);
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.floor((now.getTime() - ms) / 86_400_000));
}

/** Words or phrases typed one per line or comma-separated; blanks and repeats dropped. */
export function parseTerms(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[\n,]/)) {
    const term = raw.trim();
    const key = term.toLowerCase();
    if (term && !seen.has(key)) {
      seen.add(key);
      out.push(term);
    }
  }
  return out;
}

/** Newznab category ids from "7020, 7000" (anything that is not a positive whole number is dropped). */
export function parseCategories(text: string): number[] {
  const out: number[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    if (!/^\d+$/.test(raw)) continue;
    const n = Number(raw);
    if (n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

/** Languages from "en, de" (lower-cased, unique). */
export function parseLanguages(text: string): string[] {
  return parseTerms(text).map((l) => l.toLowerCase());
}

/** Move one item up (-1) or down (+1) in an ordered list; out-of-range moves return the same order. */
export function moveItem<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(to, 0, item as T);
  return next;
}

/** Toggle a format in a profile's ordered list, keeping the cutoff valid (falls back to the first format). */
export function toggleFormat(formats: readonly BooksFormat[], cutoff: BooksFormat, format: BooksFormat): { formats: BooksFormat[]; cutoff: BooksFormat } {
  const next = formats.includes(format) ? formats.filter((f) => f !== format) : [...formats, format];
  const nextCutoff = next.includes(cutoff) ? cutoff : (next[0] ?? cutoff);
  return { formats: next, cutoff: nextCutoff };
}

/** Sizes in MB from an input: blank is "no limit" (null); negatives and junk are rejected (undefined). */
export function parseSizeMb(text: string): number | null | undefined {
  const s = text.trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Root folders a kind's add form offers. */
export function rootsOfKind<T extends { mediaType: string }>(roots: readonly T[] | undefined, kind: BooksKind): T[] {
  return (roots ?? []).filter((r) => r.mediaType === kind);
}

/** Profiles a kind's forms offer. */
export function profilesOfKind(profiles: readonly BooksFormatProfile[] | undefined, kind: BooksKind): BooksFormatProfile[] {
  return (profiles ?? []).filter((p) => p.kind === kind);
}

/**
 * Naming tokens shown under the naming fields: the ones the default formats use (the server's
 * full list is in docs/books.md).
 */
export const EBOOK_NAMING_TOKENS = ['{Author Name}', '{Book Title}', '{Series Title}', '{Release Year}'] as const;
export const COMIC_NAMING_TOKENS = ['{Publisher}', '{Series Title}', '{Series Year}', '{Issue Number}', '{Issue Number:000}', '{Release Year}'] as const;

/** Row key of a wanted item: ebook and issue ids can collide, so the kind is part of it. */
export function wantedKey(item: Pick<BooksWantedItem, 'kind' | 'id'>): string {
  return `${item.kind}-${item.id}`;
}

/** The search commands for a selection of wanted rows: one per kind, nothing for an empty side. */
export function wantedSearchCommands(items: ReadonlyArray<Pick<BooksWantedItem, 'kind' | 'id'>>): BooksCommand[] {
  const ebookIds = items.filter((i) => i.kind === 'ebook').map((i) => i.id);
  const issueIds = items.filter((i) => i.kind === 'comic').map((i) => i.id);
  const out: BooksCommand[] = [];
  if (ebookIds.length) out.push({ name: 'EbookSearch', ebookIds });
  if (issueIds.length) out.push({ name: 'ComicIssueSearch', issueIds });
  return out;
}

/** The status a Requests tab (pending / approved / declined / available / all) asks /books/requests for. */
export function booksRequestStatusOfTab(tab: string): 'all' | BooksRequestStatus {
  switch (tab) {
    case 'pending':
    case 'approved':
    case 'declined':
    case 'failed':
      return tab;
    case 'available':
      return 'completed';
    default:
      return 'all';
  }
}

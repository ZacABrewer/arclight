// Pure merge functions for book and comic records from several catalogues. Records are grouped
// (ISBN-13 → catalogue ids → normalized title + first author) and each field of a group is
// taken from the source that is best at it, so one service's outage or gaps only thin the
// result instead of emptying it.

import { maybe, normalizePersonName, normalizeTitle, stripHtml, uniqueStrings } from '../audiobook-util.js';
import type {
  BookAuthorRecord,
  BookRecord,
  BookSeriesRef,
  BookSourceName,
  ComicIssueRecord,
  ComicSeriesRecord,
} from './types.js';
import { bookLanguageCode, bookMatchKey, bookRecordKey, sourceList } from './util.js';

// ---------------------------------------------------------------------------
// Precedence

type Rank = readonly BookSourceName[];

const SERIES_RANK: Rank = ['hardcover', 'openLibrary', 'googleBooks'];
const COVER_RANK: Rank = ['hardcover', 'googleBooks', 'openLibrary'];
const TITLE_RANK: Rank = ['hardcover', 'openLibrary', 'googleBooks'];
const PUBLISHER_RANK: Rank = ['googleBooks', 'openLibrary', 'hardcover'];
const LANGUAGE_RANK: Rank = ['googleBooks', 'openLibrary', 'hardcover'];
const PAGES_RANK: Rank = ['hardcover', 'googleBooks', 'openLibrary'];
const RATING_RANK: Rank = ['hardcover', 'googleBooks', 'openLibrary'];
const ISBN_RANK: Rank = ['openLibrary', 'hardcover', 'googleBooks'];
/** Descriptions from these first; OpenLibrary's crowd-edited ones only when they have none. */
const OVERVIEW_PREFERRED: ReadonlySet<BookSourceName> = new Set(['hardcover', 'googleBooks']);

function rankOf(rank: Rank, sources: readonly BookSourceName[]): number {
  const positions = sources.map((s) => rank.indexOf(s)).filter((i) => i >= 0);
  return positions.length > 0 ? Math.min(...positions) : rank.length;
}

/** Records ordered by `rank` (stable). */
function byRank<T extends { sources: BookSourceName[] }>(records: readonly T[], rank: Rank): T[] {
  return records
    .map((record, index) => ({ record, index, r: rankOf(rank, record.sources) }))
    .sort((a, b) => a.r - b.r || a.index - b.index)
    .map((x) => x.record);
}

function first<T, V>(records: readonly T[], pick: (r: T) => V | undefined): V | undefined {
  for (const record of records) {
    const value = pick(record);
    if (value !== undefined) return value;
  }
  return undefined;
}

function longestOverview<T extends { overview?: string; sources: BookSourceName[] }>(
  records: readonly T[],
  preferred?: ReadonlySet<BookSourceName>,
): string | undefined {
  const candidates = records.flatMap((r) => {
    const plain = stripHtml(r.overview);
    return plain ? [{ plain, preferred: preferred ? r.sources.some((s) => preferred.has(s)) : true }] : [];
  });
  const pool = candidates.some((c) => c.preferred) ? candidates.filter((c) => c.preferred) : candidates;
  return pool.sort((a, b) => b.plain.length - a.plain.length)[0]?.plain;
}

/** Earliest year; within it, the most precise date; then the earliest of those. */
export function bookEarliestDate(dates: Iterable<string | undefined>): string | undefined {
  const valid = [...dates].filter((d): d is string => !!d && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(d));
  if (valid.length === 0) return undefined;
  const year = valid.map((d) => d.slice(0, 4)).sort()[0]!;
  return valid
    .filter((d) => d.startsWith(year))
    .sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
}

// ---------------------------------------------------------------------------
// Books

interface BookGroup {
  records: BookRecord[];
  isbns: Set<string>;
  olWorkIds: Set<string>;
  hardcoverIds: Set<string>;
  googleIds: Set<string>;
  matchKeys: Set<string>;
}

function isbnsOf(record: BookRecord): string[] {
  return uniqueStrings([record.isbn13, ...record.isbns]);
}

function strongMatch(group: BookGroup, record: BookRecord): boolean {
  return (
    isbnsOf(record).some((i) => group.isbns.has(i)) ||
    (!!record.olWorkId && group.olWorkIds.has(record.olWorkId)) ||
    (!!record.hardcoverId && group.hardcoverIds.has(record.hardcoverId)) ||
    (!!record.googleVolumeId && group.googleIds.has(record.googleVolumeId))
  );
}

/** Two different OpenLibrary works or Hardcover books are different books, whatever the title says. */
function conflicts(group: BookGroup, record: BookRecord): boolean {
  return (
    (!!record.olWorkId && group.olWorkIds.size > 0 && !group.olWorkIds.has(record.olWorkId)) ||
    (!!record.hardcoverId && group.hardcoverIds.size > 0 && !group.hardcoverIds.has(record.hardcoverId))
  );
}

function addToGroup(group: BookGroup, record: BookRecord): void {
  group.records.push(record);
  for (const isbn of isbnsOf(record)) group.isbns.add(isbn);
  if (record.olWorkId) group.olWorkIds.add(record.olWorkId);
  if (record.hardcoverId) group.hardcoverIds.add(record.hardcoverId);
  if (record.googleVolumeId) group.googleIds.add(record.googleVolumeId);
  const key = bookMatchKey(record);
  if (key) group.matchKeys.add(key);
}

function newGroup(): BookGroup {
  return {
    records: [],
    isbns: new Set(),
    olWorkIds: new Set(),
    hardcoverIds: new Set(),
    googleIds: new Set(),
    matchKeys: new Set(),
  };
}

/** Groups records describing the same book; groups keep the order of their first record. */
export function groupBookRecords(records: readonly BookRecord[]): BookRecord[][] {
  const groups: BookGroup[] = [];
  for (const record of records) {
    const strong = groups.filter((g) => strongMatch(g, record));
    let target: BookGroup | undefined;
    if (strong.length > 0) {
      target = strong[0]!;
      // The record bridges several groups (an ISBN in one, a work id in another): fold them.
      for (const other of strong.slice(1)) {
        for (const r of other.records) addToGroup(target, r);
        groups.splice(groups.indexOf(other), 1);
      }
    } else {
      const key = bookMatchKey(record);
      target = key ? groups.find((g) => g.matchKeys.has(key) && !conflicts(g, record)) : undefined;
    }
    if (!target) {
      target = newGroup();
      groups.push(target);
    }
    addToGroup(target, record);
  }
  return groups.map((g) => g.records);
}

function mergeAuthors(ordered: readonly BookRecord[]): BookRecord['authors'] {
  const base = ordered.find((r) => r.authors.length > 0)?.authors ?? [];
  const all = ordered.flatMap((r) => r.authors);
  return base.map((author) => {
    const name = normalizePersonName(author.name);
    const keys = all.filter((a) => a.key && normalizePersonName(a.name) === name).map((a) => a.key!);
    const best = keys.find((k) => k.startsWith('ol:')) ?? keys.find((k) => k.startsWith('hc:')) ?? keys[0];
    return { name: author.name, ...maybe('key', best ?? author.key) };
  });
}

function mergeSeries(records: readonly BookRecord[]): BookSeriesRef[] {
  const ordered = byRank(records, SERIES_RANK);
  const chosen = ordered.find((r) => r.series.length > 0)?.series ?? [];
  const all = ordered.flatMap((r) => r.series);
  const seen = new Set<string>();
  return chosen.flatMap((s) => {
    const name = normalizeTitle(s.name);
    if (seen.has(name)) return [];
    seen.add(name);
    const position = s.position ?? all.find((o) => o.position && normalizeTitle(o.name) === name)?.position;
    return [{ name: s.name, ...maybe('position', position) }];
  });
}

/** The ISBN-13 most sources agree on; ties go to the best-ranked source. */
function mergeIsbn(records: readonly BookRecord[]): string | undefined {
  const counts = new Map<string, Set<BookSourceName>>();
  for (const record of records) {
    for (const isbn of isbnsOf(record)) {
      const set = counts.get(isbn) ?? new Set();
      for (const s of record.sources) set.add(s);
      counts.set(isbn, set);
    }
  }
  const candidates = byRank(records, ISBN_RANK)
    .map((r) => r.isbn13)
    .filter((i): i is string => i !== undefined);
  let best: string | undefined;
  let bestCount = 0;
  for (const isbn of candidates) {
    const count = counts.get(isbn)?.size ?? 0;
    if (count > bestCount) {
      best = isbn;
      bestCount = count;
    }
  }
  return best;
}

/** One record from a group describing the same book. */
export function mergeBookGroup(records: readonly BookRecord[]): BookRecord {
  if (records.length === 1) return records[0]!;
  const byTitle = byRank(records, TITLE_RANK);
  const head = byTitle[0]!;
  const isbn13 = mergeIsbn(records);
  const isbns = uniqueStrings([isbn13, ...records.flatMap(isbnsOf)]);
  const ids = {
    isbns,
    ...maybe('isbn13', isbn13),
    ...maybe('olWorkId', first(records, (r) => r.olWorkId)),
    ...maybe('googleVolumeId', first(byRank(records, COVER_RANK), (r) => r.googleVolumeId)),
    ...maybe('hardcoverId', first(records, (r) => r.hardcoverId)),
  };
  return {
    key: bookRecordKey(ids),
    keys: uniqueStrings([bookRecordKey(ids), ...records.flatMap((r) => r.keys)]),
    title: head.title,
    ...maybe('subtitle', first(byTitle, (r) => r.subtitle)),
    authors: mergeAuthors(byTitle),
    ...ids,
    ...maybe('publisher', first(byRank(records, PUBLISHER_RANK), (r) => r.publisher)),
    ...maybe('language', first(byRank(records, LANGUAGE_RANK), (r) => r.language)),
    ...maybe('releaseDate', bookEarliestDate(records.map((r) => r.releaseDate))),
    ...maybe('pageCount', first(byRank(records, PAGES_RANK), (r) => r.pageCount)),
    ...maybe('overview', longestOverview(records, OVERVIEW_PREFERRED)),
    genres: uniqueStrings(records.flatMap((r) => r.genres)),
    ...maybe('coverUrl', first(byRank(records, COVER_RANK), (r) => r.coverUrl)),
    ...maybe('rating', first(byRank(records, RATING_RANK), (r) => r.rating)),
    series: mergeSeries(records),
    sources: sourceList(records.flatMap((r) => r.sources)),
  };
}

/** De-duplicates book records across sources and merges each group field by field. */
export function mergeBookRecords(records: readonly BookRecord[]): BookRecord[] {
  return groupBookRecords(records).map(mergeBookGroup);
}

/**
 * Drops books whose known language is not in `languages` (`en`, `eng`, `english` all match).
 * Books with no known language are kept; an empty list keeps everything.
 */
export function filterBooksByLanguage(records: readonly BookRecord[], languages: readonly string[]): BookRecord[] {
  const wanted = new Set(languages.map(bookLanguageCode).filter((c): c is string => c !== undefined));
  if (wanted.size === 0) return [...records];
  return records.filter((r) => {
    const code = bookLanguageCode(r.language);
    return code === undefined || wanted.has(code);
  });
}

/** True when `author` is one of the book's (primary) authors, by key or by name. */
export function bookHasAuthor(record: BookRecord, author: Pick<BookAuthorRecord, 'keys' | 'name'>): boolean {
  const keys = new Set(author.keys);
  const name = normalizePersonName(author.name);
  return record.authors.some((a) => (a.key !== undefined && keys.has(a.key)) || normalizePersonName(a.name) === name);
}

// ---------------------------------------------------------------------------
// Authors

const AUTHOR_NAME_RANK: Rank = ['openLibrary', 'hardcover', 'googleBooks'];
const AUTHOR_IMAGE_RANK: Rank = ['hardcover', 'openLibrary', 'googleBooks'];

function authorConflicts(a: BookAuthorRecord, b: BookAuthorRecord): boolean {
  return (
    (!!a.olAuthorId && !!b.olAuthorId && a.olAuthorId !== b.olAuthorId) ||
    (!!a.hardcoverId && !!b.hardcoverId && a.hardcoverId !== b.hardcoverId)
  );
}

function authorsMatch(a: BookAuthorRecord, b: BookAuthorRecord): boolean {
  if ((a.olAuthorId && a.olAuthorId === b.olAuthorId) || (a.hardcoverId && a.hardcoverId === b.hardcoverId)) {
    return true;
  }
  if (a.keys.some((k) => b.keys.includes(k))) return true;
  return !authorConflicts(a, b) && normalizePersonName(a.name) === normalizePersonName(b.name);
}

function mergeAuthorGroup(records: readonly BookAuthorRecord[]): BookAuthorRecord {
  if (records.length === 1) return records[0]!;
  const byName = byRank(records, AUTHOR_NAME_RANK);
  const olAuthorId = first(records, (r) => r.olAuthorId);
  const hardcoverId = first(records, (r) => r.hardcoverId);
  const keys = uniqueStrings([
    olAuthorId ? `ol:${olAuthorId}` : undefined,
    hardcoverId ? `hc:${hardcoverId}` : undefined,
    ...byName.flatMap((r) => r.keys),
  ]);
  const workCounts = records.map((r) => r.workCount).filter((c): c is number => c !== undefined);
  return {
    key: keys[0]!,
    keys,
    name: byName[0]!.name,
    ...maybe('overview', longestOverview(records)),
    ...maybe('imageUrl', first(byRank(records, AUTHOR_IMAGE_RANK), (r) => r.imageUrl)),
    ...maybe('topWork', first(byName, (r) => r.topWork)),
    ...maybe('workCount', workCounts.length > 0 ? Math.max(...workCounts) : undefined),
    ...maybe('olAuthorId', olAuthorId),
    ...maybe('hardcoverId', hardcoverId),
    sources: sourceList(records.flatMap((r) => r.sources)),
  };
}

/** De-duplicates authors (OpenLibrary id, Hardcover id, shared key, then normalized name). */
export function mergeAuthorRecords(records: readonly BookAuthorRecord[]): BookAuthorRecord[] {
  const groups: BookAuthorRecord[][] = [];
  for (const record of records) {
    const group = groups.find((g) => g.some((r) => authorsMatch(r, record)) && !g.some((r) => authorConflicts(r, record)));
    if (group) group.push(record);
    else groups.push([record]);
  }
  return groups.map(mergeAuthorGroup);
}

// ---------------------------------------------------------------------------
// Comics

const COMIC_RANK: Rank = ['comicVine', 'metron'];

function comicSeriesKey(record: ComicSeriesRecord): string {
  return `${normalizeTitle(record.title)}|${record.startYear ?? ''}`;
}

function comicSeriesMatch(a: ComicSeriesRecord, b: ComicSeriesRecord): boolean {
  if (a.comicVineId && b.comicVineId) return a.comicVineId === b.comicVineId;
  if (a.metronId && b.metronId) return a.metronId === b.metronId;
  return a.startYear !== undefined && b.startYear !== undefined && comicSeriesKey(a) === comicSeriesKey(b);
}

function mergeComicSeriesGroup(records: readonly ComicSeriesRecord[]): ComicSeriesRecord {
  if (records.length === 1) return records[0]!;
  const ordered = byRank(records, COMIC_RANK);
  const comicVineId = first(records, (r) => r.comicVineId);
  const metronId = first(records, (r) => r.metronId);
  const keys = uniqueStrings([
    comicVineId ? `cv:${comicVineId}` : undefined,
    metronId ? `metron:${metronId}` : undefined,
    ...ordered.flatMap((r) => r.keys),
  ]);
  const counts = records.map((r) => r.issueCount).filter((c): c is number => c !== undefined);
  return {
    key: keys[0]!,
    keys,
    title: ordered[0]!.title,
    ...maybe('publisher', first(ordered, (r) => r.publisher)),
    ...maybe('startYear', first(ordered, (r) => r.startYear)),
    ...maybe('issueCount', counts.length > 0 ? Math.max(...counts) : undefined),
    ...maybe('overview', longestOverview(records)),
    ...maybe('coverUrl', first(ordered, (r) => r.coverUrl)),
    ...maybe('comicVineId', comicVineId),
    ...maybe('metronId', metronId),
    ...maybe('status', first(byRank(records, ['metron', 'comicVine']), (r) => r.status)),
    sources: sourceList(records.flatMap((r) => r.sources)),
  };
}

/** De-duplicates comic series: ComicVine id (Metron's `cv_id`), else title + start year. */
export function mergeComicSeries(records: readonly ComicSeriesRecord[]): ComicSeriesRecord[] {
  const groups: ComicSeriesRecord[][] = [];
  for (const record of records) {
    const group = groups.find((g) => g.some((r) => comicSeriesMatch(r, record)));
    if (group) group.push(record);
    else groups.push([record]);
  }
  return groups.map(mergeComicSeriesGroup);
}

/** "001" → "1", "1.0" → "1", "Annual 1" → "annual 1". */
export function comicIssueNumberKey(value: string): string {
  const raw = value.trim().toLowerCase().replace(/\s+/g, ' ');
  const numeric = /^0*(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!numeric) return raw;
  const fraction = numeric[2]?.replace(/0+$/, '');
  return fraction ? `${numeric[1]}.${fraction}` : numeric[1]!;
}

function issueSortValue(issue: ComicIssueRecord): [number, string] {
  const n = Number.parseFloat(issue.issueNumber);
  return [Number.isFinite(n) && /^\s*-?\d/.test(issue.issueNumber) ? n : Number.POSITIVE_INFINITY, issue.issueNumber];
}

function mergeIssuePair(cv: ComicIssueRecord, metron: ComicIssueRecord): ComicIssueRecord {
  const comicVineId = cv.comicVineId ?? metron.comicVineId;
  const keys = uniqueStrings([...cv.keys, ...metron.keys]);
  return {
    key: comicVineId ? `cv-issue:${comicVineId}` : cv.key,
    keys,
    issueNumber: cv.issueNumber,
    ...maybe('title', cv.title ?? metron.title),
    ...maybe('coverDate', cv.coverDate ?? metron.coverDate),
    ...maybe('storeDate', metron.storeDate ?? cv.storeDate),
    ...maybe('overview', longestOverview([cv, metron])),
    ...maybe('coverUrl', cv.coverUrl ?? metron.coverUrl),
    ...maybe('comicVineId', comicVineId),
    ...maybe('metronId', metron.metronId ?? cv.metronId),
    sources: sourceList([...cv.sources, ...metron.sources]),
  };
}

/**
 * Merges ComicVine and Metron issue lists of one series: by ComicVine issue id (Metron carries
 * `cv_id`), else by normalized issue number. Metron's store dates win; ComicVine's covers win
 * when it has one. Sorted by issue number.
 */
export function mergeComicIssues(
  cv: readonly ComicIssueRecord[],
  metron: readonly ComicIssueRecord[],
): ComicIssueRecord[] {
  const out: ComicIssueRecord[] = [];
  const byCvId = new Map<string, number>();
  const byNumber = new Map<string, number>();
  for (const issue of cv) {
    const index = out.length;
    out.push(issue);
    if (issue.comicVineId) byCvId.set(issue.comicVineId, index);
    const n = comicIssueNumberKey(issue.issueNumber);
    if (!byNumber.has(n)) byNumber.set(n, index);
  }
  const merged = new Set<number>();
  for (const issue of metron) {
    let index = issue.comicVineId ? byCvId.get(issue.comicVineId) : undefined;
    if (index === undefined) {
      const candidate = byNumber.get(comicIssueNumberKey(issue.issueNumber));
      // A number match only links issues that do not carry conflicting ComicVine ids.
      if (candidate !== undefined && !(issue.comicVineId && out[candidate]!.comicVineId)) index = candidate;
    }
    if (index !== undefined && !merged.has(index)) {
      merged.add(index);
      out[index] = mergeIssuePair(out[index]!, issue);
    } else {
      out.push(issue);
    }
  }
  return out.sort((a, b) => {
    const [na, sa] = issueSortValue(a);
    const [nb, sb] = issueSortValue(b);
    return na - nb || sa.localeCompare(sb, undefined, { numeric: true });
  });
}

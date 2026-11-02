import { bookLanguageCode, comicIssueNumberKey } from '@arclight/metadata';
import { bookTitleKey, parseComicRelease, parseEbookRelease, type ParsedComicRelease, type ParsedEbookRelease } from '@arclight/parser';
import type { BooksFormat, BooksFormatProfile } from '@arclight/shared';

// The release decision engine for ebooks and comic issues (docs/books.md "Searching"): pure
// functions from a release, the wanted item and its format profile to approved / rejected
// with reasons and a score. No I/O; search.ts and the RSS listener feed it.
//
// Ebook releases must name the book (title key equal, or one a prefix of the other at a word
// boundary; a matching ISBN passes on its own) and, when the release names an author, the
// author. Audio releases and collections are rejected: an ebook search wants one book file.
// Comic releases must name the series and the issue (normalized numbers, so "001" is "1");
// manga volumes stand in for issue numbers when the release has no issue.
//
// Score among approved releases: format rank first (best format of the profile highest), then
// preferred terms, retail, and a little for seeders.

const MB = 1024 * 1024;

/** The parts of an indexer release the engine reads. */
export interface ReleaseFacts {
  guid: string;
  title: string;
  sizeBytes: number;
  protocol: 'torrent' | 'usenet';
  seeders: number | null;
}

export type ProfileFacts = Pick<BooksFormatProfile, 'formats' | 'cutoff' | 'upgradeAllowed' | 'minSizeMb' | 'maxSizeMb' | 'ignoredTerms' | 'preferredTerms'>;

export interface EbookTargetFacts {
  title: string;
  subtitle?: string | null;
  authorName: string;
  /** ISBN-13s of the book's editions. */
  isbns: readonly string[];
  /** Format of the file on disk, or null when the book has none. */
  existingFormat: BooksFormat | null;
}

export interface ComicTargetFacts {
  seriesTitle: string;
  startYear: number | null;
  /** As stored (`1`, `12.1`, `Annual 2`). */
  issueNumber: string;
  seriesType: 'comic' | 'manga' | 'graphicNovel';
  existingFormat: BooksFormat | null;
}

export interface DecisionContext {
  profile: ProfileFacts;
  /** Guids of releases that failed before (the blocklist). */
  blockedGuids?: ReadonlySet<string>;
  /** Wanted languages (`en`, `eng`, `English`); empty accepts every language. */
  languages?: readonly string[];
}

export interface Decision {
  approved: boolean;
  rejections: string[];
  score: number;
  format: BooksFormat | null;
  releaseGroup: string | null;
}

function containsTerm(title: string, term: string): boolean {
  const t = term.trim().toLowerCase();
  return t.length > 0 && title.toLowerCase().includes(t);
}

/** Equal keys, or one key a whole-word prefix of the other ("mistborn" vs "mistborn final empire"). */
export function titleKeysMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return long.startsWith(`${short} `);
}

function formatRank(formats: readonly BooksFormat[], format: BooksFormat): number {
  const i = formats.indexOf(format);
  return i < 0 ? formats.length : i;
}

/**
 * The release format the profile likes best among those the release names; null when the
 * release names none (unknown formats are allowed, ranked last).
 */
function pickFormat(profile: ProfileFacts, formats: readonly BooksFormat[]): BooksFormat | null {
  if (formats.length === 0) return null;
  return [...formats].sort((a, b) => formatRank(profile.formats, a) - formatRank(profile.formats, b))[0]!;
}

/** Checks shared by both kinds: format, size, terms, seeders, blocklist, upgrade. */
function commonChecks(release: ReleaseFacts, formats: readonly BooksFormat[], existing: BooksFormat | null, ctx: DecisionContext, rejections: string[]): BooksFormat | null {
  const { profile } = ctx;
  const format = pickFormat(profile, formats);
  if (format && !profile.formats.includes(format)) rejections.push(`format ${format} is not in the profile`);
  if (release.sizeBytes > 0) {
    const mb = release.sizeBytes / MB;
    const min = profile.minSizeMb ?? 0;
    const max = profile.maxSizeMb ?? 0;
    if (min > 0 && mb < min) rejections.push(`size ${mb.toFixed(1)} MB is below the ${min} MB minimum`);
    if (max > 0 && mb > max) rejections.push(`size ${mb.toFixed(1)} MB is above the ${max} MB maximum`);
  }
  for (const term of profile.ignoredTerms) if (containsTerm(release.title, term)) rejections.push(`contains ignored term "${term.trim()}"`);
  if (release.protocol === 'torrent' && release.seeders === 0) rejections.push('no seeders');
  if (ctx.blockedGuids?.has(release.guid)) rejections.push('release failed before (blocklisted)');
  if (existing) {
    if (!profile.upgradeAllowed) rejections.push('a file exists and upgrades are off');
    else if (formatRank(profile.formats, existing) <= formatRank(profile.formats, profile.cutoff)) rejections.push(`existing ${existing} file meets the cutoff`);
    else if (!format || formatRank(profile.formats, format) >= formatRank(profile.formats, existing)) rejections.push(`not an upgrade over the existing ${existing} file`);
  }
  return format;
}

function score(release: ReleaseFacts, format: BooksFormat | null, profile: ProfileFacts, retail: boolean): number {
  const rank = format ? formatRank(profile.formats, format) : profile.formats.length;
  let s = (profile.formats.length - rank) * 100;
  for (const term of profile.preferredTerms) if (containsTerm(release.title, term)) s += 10;
  if (retail) s += 5;
  if (release.protocol === 'torrent' && release.seeders) s += Math.min(release.seeders, 50) / 10;
  return s;
}

/**
 * The release names the wanted book: the same key, or a shorter one the wanted title extends
 * ("The Hobbit" for "The Hobbit, or There and Back Again"). A longer release title is another
 * book ("Dune Messiah" is not "Dune").
 */
function releaseTitleMatches(release: string, wanted: string): boolean {
  if (!release || !wanted) return false;
  return release === wanted || wanted.startsWith(`${release} `);
}

function ebookTitleMatches(parsed: ParsedEbookRelease, target: EbookTargetFacts): { title: boolean; author: boolean } {
  const wanted = [bookTitleKey(target.title), ...(target.subtitle ? [bookTitleKey(`${target.title} ${target.subtitle}`)] : [])];
  const author = bookTitleKey(target.authorName);
  const check = (title: string | undefined, by: string | undefined) => ({
    title: title !== undefined && wanted.some((w) => releaseTitleMatches(bookTitleKey(title), w)),
    author: by === undefined || titleKeysMatch(bookTitleKey(by), author) || authorSurnameMatch(by, target.authorName),
  });
  const straight = check(parsed.title, parsed.author);
  if (straight.title && straight.author) return straight;
  if (parsed.orderAmbiguous) {
    const swapped = check(parsed.author, parsed.title);
    if (swapped.title && swapped.author) return swapped;
  }
  return straight;
}

/** "B. Sanderson" / "Sanderson, Brandon" against "Brandon Sanderson": same surname and initial. */
function authorSurnameMatch(release: string, wanted: string): boolean {
  const norm = (s: string) => {
    const comma = /^([^,]+),\s*(.+)$/.exec(s.trim());
    const ordered = comma ? `${comma[2]} ${comma[1]}` : s;
    return bookTitleKey(ordered).split(' ').filter(Boolean);
  };
  const a = norm(release);
  const b = norm(wanted);
  if (a.length === 0 || b.length === 0) return false;
  if (a[a.length - 1] !== b[b.length - 1]) return false;
  return a[0]![0] === b[0]![0];
}

/** Decide on one release for a wanted ebook. */
export function evaluateEbookRelease(release: ReleaseFacts, target: EbookTargetFacts, ctx: DecisionContext): Decision {
  const parsed = parseEbookRelease(release.title);
  if (!parsed) return { approved: false, rejections: ['release title could not be parsed'], score: 0, format: null, releaseGroup: null };
  const rejections: string[] = [];
  if (parsed.isAudio) rejections.push('audio release, not an ebook');
  if (parsed.isPack) rejections.push('collection or pack, not a single book');
  const isbnMatch = parsed.isbn !== undefined && target.isbns.includes(parsed.isbn);
  if (parsed.isbn !== undefined && target.isbns.length > 0 && !isbnMatch) rejections.push(`ISBN ${parsed.isbn} is another edition or book`);
  if (!isbnMatch) {
    const m = ebookTitleMatches(parsed, target);
    if (!m.title) rejections.push(`title does not match "${target.title}"`);
    if (!m.author) rejections.push(`author does not match "${target.authorName}"`);
  }
  if (parsed.language && ctx.languages && ctx.languages.length > 0) {
    const wanted = new Set(ctx.languages.map((l) => bookLanguageCode(l)).filter((l): l is string => !!l));
    const lang = bookLanguageCode(parsed.language);
    if (lang && wanted.size > 0 && !wanted.has(lang)) rejections.push(`language ${lang} is not wanted`);
  }
  const format = commonChecks(release, parsed.formats, target.existingFormat, ctx, rejections);
  return {
    approved: rejections.length === 0,
    rejections,
    score: score(release, format, ctx.profile, parsed.retail),
    format,
    releaseGroup: parsed.releaseGroup ?? null,
  };
}

function issueKeyParts(issueNumber: string): { annual: boolean; key: string } {
  const raw = issueNumber.trim().replace(/^#\s*/, '');
  const m = /^annual\s*#?\s*(.+)$/i.exec(raw);
  return m ? { annual: true, key: comicIssueNumberKey(m[1]!) } : { annual: false, key: comicIssueNumberKey(raw) };
}

/** Series names compare by title key with a trailing "(Year)" or "Vol. N" dropped. */
function seriesKey(title: string): string {
  return bookTitleKey(title.replace(/\(\s*\d{4}\s*\)\s*$/, '').replace(/\b(?:vol(?:ume)?\.?\s*\d+)\s*$/i, ''));
}

/** Decide on one release for a wanted comic issue. */
export function evaluateComicRelease(release: ReleaseFacts, target: ComicTargetFacts, ctx: DecisionContext): Decision {
  const parsed: ParsedComicRelease | null = parseComicRelease(release.title);
  if (!parsed) return { approved: false, rejections: ['release title could not be parsed'], score: 0, format: null, releaseGroup: null };
  const rejections: string[] = [];
  if (seriesKey(parsed.series) !== seriesKey(target.seriesTitle)) rejections.push(`series does not match "${target.seriesTitle}"`);
  if (parsed.isPack || parsed.issueEnd !== undefined) rejections.push('pack of several issues');
  const wanted = issueKeyParts(target.issueNumber);
  const released = parsed.issueNumber !== undefined ? comicIssueNumberKey(parsed.issueNumber) : parsed.volume !== undefined && target.seriesType === 'manga' ? String(parsed.volume) : undefined;
  if (released === undefined) rejections.push('release names no issue number');
  else if (released !== wanted.key || parsed.annual !== wanted.annual) rejections.push(`issue ${parsed.annual ? 'Annual ' : ''}${released} is not ${target.issueNumber}`);
  if (parsed.collected && target.seriesType === 'comic') rejections.push('collected edition, not a single issue');
  if (parsed.year !== undefined && target.startYear !== null && parsed.year < target.startYear - 1) rejections.push(`year ${parsed.year} is before the series started (${target.startYear})`);
  const format = commonChecks(release, parsed.formats, target.existingFormat, ctx, rejections);
  return {
    approved: rejections.length === 0,
    rejections,
    score: score(release, format, ctx.profile, parsed.digital),
    format,
    releaseGroup: parsed.releaseGroup ?? null,
  };
}

/** Approved first, by score, then newest; rejected after. */
export function rankDecisions<T extends { approved: boolean; score: number; publishDate?: string }>(items: readonly T[]): T[] {
  return [...items].sort(
    (a, b) => Number(b.approved) - Number(a.approved) || b.score - a.score || (Date.parse(b.publishDate ?? '') || 0) - (Date.parse(a.publishDate ?? '') || 0),
  );
}

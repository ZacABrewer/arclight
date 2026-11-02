// Ebook and comic paths (docs/books.md): `<folder>/<file>.<ext>` under a Books root folder,
// built from a folder format (slashes make levels) and a file format (one component).
//
// Empty tokens disappear cleanly: an empty folder level is dropped, empty brackets and
// dangling " - " / "#" are removed, so a book without a series lands in `Author/Title (Year)`
// and a comic without a publisher skips the publisher level. Every component is made
// Windows/Linux safe (illegal characters, colons, reserved names, trailing dots and spaces,
// 255-byte limit).

import { NamingFormatError } from './build.js';
import {
  byteLength,
  cleanIllegal,
  cleanupFileComponent,
  cleanupFolderComponent,
  collapseSeparators,
  finalizeComponent,
  splitPath,
  truncateBytes,
  truncateText,
  type CleanOptions,
} from './text.js';
import {
  normalizeTokenName,
  padNumber,
  parseFormat,
  protectLiteralEllipsis,
  register,
  renderParts,
  seriesPositionText,
  tokensOf,
  type TokenHandlers,
} from './tokens.js';

export interface EbookNamingInput {
  authorName: string;
  /** "Sanderson, Brandon"; derived from `authorName` when absent. */
  authorSortName?: string | undefined;
  title: string;
  subtitle?: string | undefined;
  seriesTitle?: string | undefined;
  /** "1", "2.5". */
  seriesPosition?: string | undefined;
  year?: number | undefined;
  publisher?: string | undefined;
  isbn?: string | undefined;
  /** File extension without the dot, e.g. `epub`. */
  format: string;
}

export interface ComicNamingInput {
  seriesTitle: string;
  seriesYear?: number | undefined;
  publisher?: string | undefined;
  /** "50", "12.1", "0", "½", "Annual 2". */
  issueNumber: string;
  issueTitle?: string | undefined;
  year?: number | undefined;
  volume?: number | undefined;
  /** File extension without the dot, e.g. `cbz`. */
  format: string;
}

export interface BookNamingFormats {
  folderFormat: string;
  fileFormat: string;
}

/** Tokens the ebook formats accept. */
export const EBOOK_TOKENS: readonly string[] = [
  '{Author Name}',
  '{Author SortName}',
  '{Book Title}',
  '{Book Subtitle}',
  '{Series Title}',
  '{Series Position}',
  '{Release Year}',
  '{Publisher}',
  '{ISBN}',
  '{Format}',
];

/** Tokens the comic formats accept. */
export const COMIC_TOKENS: readonly string[] = [
  '{Series Title}',
  '{Series Year}',
  '{Publisher}',
  '{Issue Number}',
  '{Issue Title}',
  '{Release Year}',
  '{Volume}',
  '{Format}',
];

/** Tokens that take a zero-padding modifier (`:00`); the rest take a length modifier. */
const PADDED = new Set(['seriesposition', 'issuenumber', 'volume']);
const NUMERIC = new Set(['releaseyear', 'seriesyear', 'isbn', 'format']);

const CLEAN: CleanOptions = { replaceIllegalCharacters: true, colonReplacement: 'smart' };
const clean = (value: string): string => cleanIllegal(value, CLEAN);
const MAX_COMPONENT_BYTES = 255;

const text = (h: TokenHandlers, name: string, value: string | undefined): void =>
  register(h, name, (t) => truncateText(value ?? '', t.modifier));
const plain = (h: TokenHandlers, name: string, value: string): void => register(h, name, () => value);
const yearText = (year: number | undefined): string => (year && year > 0 ? String(year) : '');

/** "Brandon Sanderson" → "Sanderson, Brandon"; single names and "Last, First" stay. */
function sortName(name: string): string {
  const n = name.trim();
  if (!n || n.includes(',')) return n;
  const words = n.split(/\s+/);
  if (words.length < 2) return n;
  let last = words.length - 1;
  // "Martin Luther King Jr." → "King Jr., Martin Luther"
  if (last > 1 && /^(?:jr|sr|ii|iii|iv)\.?$/i.test(words[last]!)) last -= 1;
  return `${words.slice(last).join(' ')}, ${words.slice(0, last).join(' ')}`;
}

/** Issue number with the leading integer zero-padded: `12.1` → `012.1`, `1.MU` → `001.MU`; `½`, `Annual 2` unchanged. */
function issueNumberText(issue: string, modifier: string | undefined): string {
  const raw = issue.trim().replace(/^#/, '');
  const m = /^(\d+)(.*)$/.exec(raw);
  if (!m) return raw;
  return padNumber(Number(m[1]), modifier) + m[2]!;
}

function ebookHandlers(input: EbookNamingInput): TokenHandlers {
  const h: TokenHandlers = new Map();
  text(h, 'Author Name', input.authorName);
  text(h, 'Author SortName', input.authorSortName?.trim() || sortName(input.authorName));
  text(h, 'Book Title', input.title);
  text(h, 'Book Subtitle', input.subtitle);
  text(h, 'Series Title', input.seriesTitle);
  register(h, 'Series Position', (t) => (input.seriesTitle?.trim() ? seriesPositionText(input.seriesPosition, t.modifier) : ''));
  plain(h, 'Release Year', yearText(input.year));
  text(h, 'Publisher', input.publisher);
  plain(h, 'ISBN', input.isbn?.replace(/[^0-9Xx]/g, '').toUpperCase() ?? '');
  plain(h, 'Format', input.format.replace(/^\./, '').toUpperCase());
  return h;
}

function comicHandlers(input: ComicNamingInput): TokenHandlers {
  const h: TokenHandlers = new Map();
  text(h, 'Series Title', input.seriesTitle);
  plain(h, 'Series Year', yearText(input.seriesYear));
  text(h, 'Publisher', input.publisher);
  register(h, 'Issue Number', (t) => issueNumberText(input.issueNumber, t.modifier));
  text(h, 'Issue Title', input.issueTitle);
  plain(h, 'Release Year', yearText(input.year));
  register(h, 'Volume', (t) => (input.volume !== undefined && input.volume >= 0 ? padNumber(input.volume, t.modifier) : ''));
  plain(h, 'Format', input.format.replace(/^\./, '').toUpperCase());
  return h;
}

/** Removes what empty tokens leave behind: `()`, `[]`, `{}`, dangling ` - ` and `#`. */
function tidyEmpty(value: string): string {
  let s = value;
  for (let i = 0; i < 3; i++) {
    s = s
      .replace(/\s*(?:\(\s*\)|\[\s*\]|\{\s*\})/g, '')
      .replace(/(^|\s)#+(?=\s|$|[)\]}])/g, '$1')
      .replace(/^\s*#+\s*/, '')
      .replace(/\s+[-–](?:\s+[-–])+(?=\s)/g, ' -')
      .replace(/^[\s\-–.,_]+|[\s\-–,_]+$/g, '')
      .replace(/\s{2,}/g, ' ');
  }
  return s.trim();
}

function renderComponent(format: string, h: TokenHandlers, isFile: boolean, reserveBytes: number): string {
  const parts = protectLiteralEllipsis(parseFormat(format, { escapes: true }));
  const tidy = (s: string): string => (isFile ? cleanupFileComponent(s) : cleanupFolderComponent(s.trim()));
  const out = tidy(tidyEmpty(collapseSeparators(renderParts(parts, h, clean))));
  return finalizeComponent(tidy(truncateBytes(out, MAX_COMPONENT_BYTES - reserveBytes)));
}

function relativePath(kind: 'ebook' | 'comic', formats: BookNamingFormats, h: TokenHandlers, fallback: string, ext: string): string {
  for (const part of ['folder', 'file'] as const) {
    const error = validateBookFormat(kind, part, part === 'folder' ? formats.folderFormat : formats.fileFormat);
    if (error) throw new NamingFormatError(error);
  }
  const extension = ext.replace(/^\./, '').toLowerCase();
  const suffix = extension ? `.${extension}` : '';
  const folders = splitPath(formats.folderFormat)
    .map((seg) => renderComponent(seg, h, false, 0))
    .filter(Boolean);
  let file = renderComponent(formats.fileFormat, h, true, byteLength(suffix));
  if (!file) file = finalizeComponent(cleanupFileComponent(truncateBytes(clean(fallback), MAX_COMPONENT_BYTES - byteLength(suffix)))) || 'Unknown';
  return [...folders, file + suffix].join('/');
}

/**
 * Relative path `<folder>/<file>.<ext>` of an ebook under the root folder, every component
 * folder-safe. Throws `NamingFormatError` for a format `validateBookFormat` rejects.
 */
export function ebookRelativePath(formats: BookNamingFormats, input: EbookNamingInput): string {
  return relativePath('ebook', formats, ebookHandlers(input), input.title, input.format);
}

/**
 * Relative path `<folder>/<file>.<ext>` of a comic issue under the root folder, every
 * component folder-safe. Throws `NamingFormatError` for a format `validateBookFormat` rejects.
 */
export function comicRelativePath(formats: BookNamingFormats, input: ComicNamingInput): string {
  const fallback = [input.seriesTitle, input.issueNumber].filter((s) => s.trim()).join(' ');
  return relativePath('comic', formats, comicHandlers(input), fallback, input.format);
}

const SAMPLE_EBOOK: EbookNamingInput = {
  authorName: 'Brandon Sanderson',
  title: 'The Final Empire',
  seriesTitle: 'Mistborn',
  seriesPosition: '1',
  year: 2006,
  publisher: 'Tor Books',
  isbn: '9780765311788',
  format: 'epub',
};

const SAMPLE_COMIC: ComicNamingInput = {
  seriesTitle: 'Saga',
  seriesYear: 2012,
  publisher: 'Image',
  issueNumber: '54',
  issueTitle: 'Chapter Fifty-Four',
  year: 2018,
  volume: 1,
  format: 'cbz',
};

/**
 * Validation for the settings page: malformed braces, unknown tokens, bad modifiers, path
 * separators in the file format, and a format that renders to nothing. Returns error text or null.
 */
export function validateBookFormat(kind: 'ebook' | 'comic', part: 'folder' | 'file', format: string): string | null {
  const label = `${kind === 'ebook' ? 'Ebook' : 'Comic'} ${part} format`;
  if (!format.trim()) return `${label} cannot be empty`;
  if (part === 'file' && /[\\/]/.test(format)) return `${label} cannot contain path separators`;
  const known = new Set((kind === 'ebook' ? EBOOK_TOKENS : COMIC_TOKENS).map(normalizeTokenName));
  const parts = parseFormat(format, { escapes: true });
  for (const p of parts) {
    if (p.kind === 'literal' && /[{}]/.test(p.text)) return `${label} has a malformed token near "${p.text.trim()}"`;
  }
  for (const t of tokensOf(parts)) {
    const key = normalizeTokenName(t.name);
    if (!known.has(key)) return `${label} has an unknown token {${t.name}}`;
    if (t.modifier === undefined) continue;
    if (PADDED.has(key) && !/^0+$/.test(t.modifier)) return `{${t.name}} only takes a zero-padding modifier such as :00`;
    if (NUMERIC.has(key)) return `{${t.name}} does not take a modifier`;
    if (!PADDED.has(key) && !/^-?\d+$/.test(t.modifier)) return `{${t.name}} only takes a length modifier such as :30`;
  }
  const h = kind === 'ebook' ? ebookHandlers(SAMPLE_EBOOK) : comicHandlers(SAMPLE_COMIC);
  const rendered = splitPath(format).map((seg) => renderComponent(seg, h, part === 'file', 0)).filter(Boolean);
  if (rendered.length === 0) return `${label} produces an empty name`;
  return null;
}

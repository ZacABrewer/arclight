import { COMIC_FORMATS, EBOOK_FORMATS, booksFormatOfExtension, type BooksFormat } from '@arclight/shared';
import { prepare, removeAccents } from './normalize.js';

// Ebook and comic release names (docs/books.md), as Newznab/Torznab indexers list them.
//
// Ebooks:
//   Author - Title (2006) [epub]                     fields split on " - ", tags in brackets
//   Author - Series 01 - Title                       a numbered middle field is the series
//   Title (Series #1) - Author                       a series bracket marks the title field
//   Sanderson, Brandon - Title [Series 1] (epub)     "Last, First" is turned around
//   Title by Author EPUB                             "by" splits title and author
//   Author - Series 01-41 Collection (epub+mobi)     packs: ranges, "Collection", "Box Set"
//   9780765311788 - Title                            an ISBN field (ISBN-10 converted)
//   Author.-.Title.2006.RETAIL.EPUB.eBook-GROUP      scene: dots for spaces, group last
//
// Field order: "Author - Title" is the default. A field order is taken as certain when a
// "Last, First" comma, a "by", a series bracket, or name shapes (only one of the two fields
// looks like a person's name) say so; otherwise `orderAmbiguous` is set and the caller should
// also try the fields swapped.
//
// Comics:
//   Series 050 (2018) (Digital) (Group)              issue last, brackets are metadata
//   Series #50 / Series 12.1 / Series ½ / Series 1.MU
//   Series v01 / Series Vol. 1 / Series c1100        volumes and manga chapters
//   Series Annual 002 / Series 001-050 (Complete)    annuals, range packs
//   Series - Story Title (1996) (Deluxe Edition)     collected editions without a number
//   Series.050.2018.Digital.cbz-GROUP                scene
//
// The issue number is the last number of the name, so series names may start with or contain
// numbers ("2000 AD 2350", "X-Men '97 001"). A bare four-digit number is an issue unless a
// bracketed year is absent and another number precedes it ("Batman 050 2018" → year 2018;
// "Batman 1989 (2023)" → issue 1989).

export interface ParsedEbookRelease {
  author?: string;
  title?: string;
  series?: string;
  /** "1", "2.5", or a range for packs ("1-41"); leading zeros dropped. */
  seriesPosition?: string;
  year?: number;
  /** The best format named in the title, from `formats`. */
  format?: BooksFormat;
  /** Every format named ("epub+mobi", "[EPUB/AZW3/PDF]") or given by the extension. */
  formats: BooksFormat[];
  /** ISBN-13 (an ISBN-10 is converted) when the name carries a valid one. */
  isbn?: string;
  /** "Retail" tag. */
  retail: boolean;
  /** ISO 639-1 when tagged ("German", "[DE]", "ger"). */
  language?: string;
  releaseGroup?: string;
  /** Collections: "Complete Series", "Books 1-7", "Collection", "Omnibus", "Box Set". */
  isPack: boolean;
  /** True for audio releases (m4b, mp3, "Audiobook", "Unabridged", "narrated by"); the ebook search must reject these. */
  isAudio: boolean;
  /** The author/title order was a guess between two plain fields; try `author` and `title` swapped too. */
  orderAmbiguous: boolean;
}

export interface ParsedComicRelease {
  /** "Batman", "Saga", "One Piece". */
  series: string;
  /** "50", "1", "12.1", "0", "½", "1.MU": leading zeros and "#" dropped. Chapter number for manga chapters. */
  issueNumber?: string;
  /** Last issue of a range pack ("Batman 001-050"). */
  issueEnd?: string;
  /** "v01", "Vol. 3", "Volume 03"; the first volume of a volume range. */
  volume?: number;
  /** "(2018)": the series or cover year; the first year of a range. */
  year?: number;
  format?: BooksFormat;
  formats: BooksFormat[];
  /** "(Digital)", "(webrip)". */
  digital: boolean;
  /** Scene "-GROUP", else the last unrecognised bracket ("(Zone-Empire)" style scanner tags). */
  releaseGroup?: string;
  /** "Annual 2". */
  annual: boolean;
  /** TPB / collected edition / omnibus / "Deluxe Edition" / "Compendium". */
  collected: boolean;
  /** Ranges, "Complete", "+ Annuals" packs, "v01-v10". */
  isPack: boolean;
  /** Best effort: "c001" chapter markers, volume ranges, three-digit volumes, the word "Manga". */
  isManga: boolean;
}

// ---------------------------------------------------------------------------------------
// Shared vocabulary

const FILE_EXTENSION = /\.(epub|azw3|azw|kfx|mobi|pdf|cbz|cbr|cb7|m4b|m4a|mp3|flac|zip|rar|7z|nzb|torrent|fb2|djvu|lit|txt)$/i;

const LANGUAGE_NAMES: Record<string, string> = {
  english: 'en', englisch: 'en', anglais: 'en',
  german: 'de', deutsch: 'de', allemand: 'de',
  french: 'fr', français: 'fr', francais: 'fr', französisch: 'fr',
  spanish: 'es', español: 'es', espanol: 'es', castellano: 'es',
  italian: 'it', italiano: 'it',
  dutch: 'nl', nederlands: 'nl',
  polish: 'pl', polski: 'pl',
  russian: 'ru',
  japanese: 'ja',
  portuguese: 'pt', português: 'pt', portugues: 'pt',
  swedish: 'sv', svenska: 'sv',
  danish: 'da', dansk: 'da',
  norwegian: 'no', norsk: 'no',
  finnish: 'fi', suomi: 'fi',
  czech: 'cs', hungarian: 'hu', turkish: 'tr', chinese: 'zh', korean: 'ko',
};
/** Short codes; bare in a name they only count in capitals ("GER"), in brackets any case. */
const LANGUAGE_CODES: Record<string, string> = {
  en: 'en', eng: 'en', de: 'de', ger: 'de', deu: 'de', fr: 'fr', fre: 'fr', fra: 'fr', es: 'es', spa: 'es', esp: 'es',
  it: 'it', ita: 'it', nl: 'nl', nld: 'nl', dut: 'nl', pl: 'pl', pol: 'pl', ru: 'ru', rus: 'ru', ja: 'ja', jpn: 'ja',
  pt: 'pt', por: 'pt', sv: 'sv', swe: 'sv', da: 'da', dan: 'da', no: 'no', nor: 'no', fi: 'fi', fin: 'fi',
};

const EBOOK_TAG_WORDS = new Set(['ebook', 'ebooks', 'e-book', 'retail', 'true', 'scan', 'ocr', 'converted', 'kepub', 'proper', 'repack', 'illustrated', 'calibre']);
const AUDIO_WORDS = new Set([
  'm4b', 'm4a', 'mp3', 'aac', 'flac', 'ogg', 'opus', 'audiobook', 'audiobooks', 'audio', 'hörbuch', 'hoerbuch',
  'unabridged', 'abridged', 'ungekürzt', 'gekürzt', 'narrated', 'kbps',
]);
const AUDIO_PATTERN = /(?<![\p{L}\p{N}])(?:m4b|m4a|mp3|aac|flac|audio[\s-]?books?|h(?:ö|oe)rbuch|unabridged|abridged|ungek(?:ü|ue)rzt|narrated\s+by|read\s+by|\d{2,3}\s?kbps)(?![\p{L}\p{N}])/iu;

const isYear = (w: string): boolean => /^(?:1[5-9]|20)\d{2}$/.test(w);

/** Formats named in `text` ("epub+mobi", "EPUB/AZW3/PDF"), in order of appearance. */
function formatOfWord(word: string): BooksFormat | null {
  const w = word.toLowerCase();
  if (w === 'ebook' || w === 'cbt') return null;
  return booksFormatOfExtension(w);
}

/** Best format of `formats` for one kind: that kind's own order first, then the other's. */
function bestFormat(formats: readonly BooksFormat[], kind: 'ebook' | 'comic'): BooksFormat | undefined {
  const order: readonly BooksFormat[] = kind === 'ebook' ? [...EBOOK_FORMATS, ...COMIC_FORMATS] : [...COMIC_FORMATS, ...EBOOK_FORMATS];
  return order.find((f) => formats.includes(f));
}

/** Scene names use dots or underscores for spaces; decimals ("12.1") keep their dot. */
function despace(name: string): { text: string; scene: boolean } {
  if (/\s/.test(name) || !/[._]/.test(name)) return { text: name, scene: false };
  const text = name.replace(/_/g, ' ').replace(/\.(?!(?<=\d\.)\d{1,2}(?!\d))/g, ' ').replace(/\s+/g, ' ').trim();
  return { text, scene: true };
}

interface Prepared {
  text: string;
  scene: boolean;
  extension: string | null;
  group?: string;
  /** Leading bracket contents read as tags rather than a group. */
  leadingTags: string[];
}

function prepareName(raw: string, isTag: (word: string) => boolean): Prepared {
  let name = raw.trim();
  let extension: string | null = null;
  const ext = FILE_EXTENSION.exec(name);
  if (ext && ext.index > 0) {
    extension = ext[1]!.toLowerCase();
    name = name.slice(0, ext.index);
  }
  name = prepare(name);
  let group: string | undefined;
  const leadingTags: string[] = [];
  for (let m = /^\s*\[([^\]]*)\]\s*/.exec(name); m; m = /^\s*\[([^\]]*)\]\s*/.exec(name)) {
    const content = m[1]!.trim();
    const words = content.split(/[\s,;+/|&]+/).filter(Boolean);
    if (words.length > 0 && words.every(isTag)) leadingTags.push(content);
    else if (content && group === undefined) group = content;
    name = name.slice(m[0].length);
  }
  const { text, scene } = despace(name);
  let out = text;
  // "...EPUB eBook-GROUP", "...Digital cbz-GROUP": a group after a tag word, year or number.
  const g = /(?<=^|\s)(\S+)-([A-Za-z0-9]{2,})$/.exec(out);
  if (g && (isTag(g[1]!) || /^\d+$/.test(g[1]!))) {
    group ??= g[2]!;
    out = out.slice(0, g.index) + g[1]!;
  }
  return { text: out.trim(), scene, extension, ...(group !== undefined ? { group } : {}), leadingTags };
}

const BRACKET = /[([{]([^()[\]{}]*)[)\]}]/g;

function stripLeadingZeros(n: string): string {
  return n.replace(/^0+(?=\d)/, '');
}

// ---------------------------------------------------------------------------------------
// ISBN

function isbn13Valid(d: string): boolean {
  if (!/^97[89]\d{10}$/.test(d)) return false;
  const sum = [...d].reduce((acc, ch, i) => acc + Number(ch) * (i % 2 === 0 ? 1 : 3), 0);
  return sum % 10 === 0;
}

function isbn10To13(d: string): string | null {
  if (!/^\d{9}[\dX]$/i.test(d)) return null;
  const sum = [...d.toUpperCase()].reduce((acc, ch, i) => acc + (ch === 'X' ? 10 : Number(ch)) * (10 - i), 0);
  if (sum % 11 !== 0) return null;
  const base = `978${d.slice(0, 9)}`;
  const s = [...base].reduce((acc, ch, i) => acc + Number(ch) * (i % 2 === 0 ? 1 : 3), 0);
  return base + String((10 - (s % 10)) % 10);
}

/** ISBN-13 of `text` when it is (only) an ISBN, optionally "ISBN"-prefixed and hyphenated. */
function readIsbn(text: string): string | null {
  const m = /^(?:isbn(?:-?1[03])?[\s:#=]*)?([\d][\d\s-]{8,16}[\dX])$/i.exec(text.trim());
  if (!m) return null;
  const digits = m[1]!.replace(/[\s-]/g, '').toUpperCase();
  if (digits.length === 13) return isbn13Valid(digits) ? digits : null;
  if (digits.length === 10) return isbn10To13(digits);
  return null;
}

const ISBN_ANYWHERE = /(?<![\dA-Za-z])(?:isbn(?:-?1[03])?[\s:#=]*)?(97[89][\d-]{10,14}|\d[\d-]{8,11}[\dX])(?![\dX])/gi;

// ---------------------------------------------------------------------------------------
// Ebooks

interface EbookFacts {
  formats: BooksFormat[];
  retail: boolean;
  language?: string;
  year?: number;
  isbn?: string;
}

function addFormat(facts: { formats: BooksFormat[] }, f: BooksFormat | null): void {
  if (f && !facts.formats.includes(f)) facts.formats.push(f);
}

function languageOf(word: string, bracketed: boolean): string | null {
  const w = word.toLowerCase();
  if (LANGUAGE_NAMES[w]) return LANGUAGE_NAMES[w]!;
  if (LANGUAGE_CODES[w] && (bracketed || word === word.toUpperCase())) return LANGUAGE_CODES[w]!;
  return null;
}

function isEbookTag(word: string, bracketed = true): boolean {
  const w = word.toLowerCase().replace(/^[.:!'"]+|[.:!'"]+$/g, '');
  if (!w) return false;
  return formatOfWord(w) !== null || EBOOK_TAG_WORDS.has(w) || AUDIO_WORDS.has(w) || /^\d{2,3}kbps$/.test(w) || languageOf(w === word.toLowerCase() ? word : w, bracketed) !== null;
}

function applyEbookTag(facts: EbookFacts, word: string, bracketed: boolean): void {
  const w = word.toLowerCase().replace(/^[.:!'"]+|[.:!'"]+$/g, '');
  addFormat(facts, formatOfWord(w));
  if (w === 'retail') facts.retail = true;
  const lang = languageOf(word.replace(/^[.:!'"]+|[.:!'"]+$/g, ''), bracketed);
  if (lang) facts.language ??= lang;
}

/** A bracket read as tag words ("epub", "Retail, AZW3", "EPUB/AZW3/PDF", "German"). */
function readTagList(content: string, facts: EbookFacts): boolean {
  const words = content.split(/[\s,;+/|&]+/).filter(Boolean);
  if (words.length === 0) return false;
  if (!words.every((w) => isEbookTag(w, true) || isYear(w))) return false;
  for (const w of words) {
    if (isYear(w)) facts.year ??= Number(w);
    else applyEbookTag(facts, w, true);
  }
  return true;
}

interface SeriesMarker {
  series?: string;
  position?: string;
}

const NUMBER = String.raw`(\d{1,3}(?:\.\d{1,2})?)`;
const POSITION_WORD = String.raw`(?:#|no\.?\s*|nr\.?\s*|book\s+|bk\.?\s*|vol(?:ume)?\.?\s*|band\s+|tome\s+|t\.\s*|livre\s+|teil\s+)`;

/** "Mistborn #1", "Stormlight Archive 1", "Tintenwelt-Trilogie Band 1", "Book 2", "Mistborn, Book 1". */
function readSeriesMarker(content: string): SeriesMarker | null {
  const c = content.trim();
  let m = new RegExp(String.raw`^${POSITION_WORD}${NUMBER}$`, 'i').exec(c);
  if (m) return { position: stripLeadingZeros(m[1]!) };
  m = new RegExp(String.raw`^(?:book|#)\s*${NUMBER}\s+(?:of|in)\s+(?:the\s+)?(.+?)(?:\s+series)?$`, 'i').exec(c);
  if (m && /\p{L}/u.test(m[2]!)) return { series: m[2]!.trim(), position: stripLeadingZeros(m[1]!) };
  m = new RegExp(String.raw`^(.+?)[,:]?\s+(?:series\s+)?${POSITION_WORD}?${NUMBER}$`, 'i').exec(c);
  if (m && /\p{L}/u.test(m[1]!) && !isYear(m[2]!)) {
    return { series: m[1]!.replace(/\s+series$/i, '').trim(), position: stripLeadingZeros(m[2]!) };
  }
  return null;
}

interface SeriesField {
  series: string;
  position: string;
  pack: boolean;
  rest?: string;
}

const PACK_WORDS = /(?<![\p{L}])(?:complete\s+(?:series|collection|works|set)|collection|box\s?set|boxset|omnibus|sammelband|gesamtausgabe|int[ée]grale)(?![\p{L}])/iu;

/** An unbracketed series field: "Mistborn 01", "Discworld 01-41 Collection", "Expanse Books 1-5". */
function readSeriesField(text: string): SeriesField | null {
  let m = /^(.+?)\s+(?:books?\s+|#)?(\d{1,3})\s*(?:-|to|thru)\s*(\d{1,3})(?:\s+(.*))?$/i.exec(text);
  if (m && /\p{L}/u.test(m[1]!) && (m[4] === undefined || PACK_WORDS.test(m[4]))) {
    return { series: m[1]!.trim(), position: `${stripLeadingZeros(m[2]!)}-${stripLeadingZeros(m[3]!)}`, pack: true };
  }
  m = new RegExp(String.raw`^(.+?)\s+${POSITION_WORD}?${NUMBER}$`, 'i').exec(text);
  if (m && /\p{L}/u.test(m[1]!) && !isYear(m[2]!)) return { series: m[1]!.trim(), position: stripLeadingZeros(m[2]!), pack: false };
  return null;
}

const TITLE_WORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'in', 'on', 'to', 'for', 'with', 'from', 'at', 'into', 'my', 'your', 'our', 'is', 'are', 'was',
  'der', 'die', 'das', 'ein', 'eine', 'und', 'le', 'la', 'les', 'un', 'une', 'el', 'los', 'las', 'il', 'lo',
  'book', 'books', 'box', 'set', 'series', 'collection', 'volume', 'novel', 'stories', 'guide', 'history', 'world', 'war', 'empire',
]);
const NAME_PARTICLES = new Set(['de', 'van', 'von', 'der', 'den', 'du', 'da', 'di', 'del', 'della', 'bin', 'ibn', 'al', 'y', 'st.']);

/** True when `text` reads like a person's name ("Brandon Sanderson", "J. R. R. Tolkien", "A & B"). */
function nameLike(text: string): boolean {
  const people = text.split(/\s*(?:&|\band\b|\bund\b|\bet\b|,)\s*/).filter(Boolean);
  if (people.length === 0) return false;
  return people.every((person) => {
    const words = person.split(/\s+/).filter(Boolean);
    if (words.length < 2 || words.length > 5 || /\d/.test(person)) return false;
    let cores = 0;
    for (const [i, w] of words.entries()) {
      const lower = w.toLowerCase();
      if (i > 0 && i < words.length - 1 && NAME_PARTICLES.has(lower)) continue;
      if (TITLE_WORDS.has(lower)) return false;
      if (!/^(?:\p{Lu}\.)+$|^\p{Lu}[\p{L}'’-]*\.?$/u.test(w)) return false;
      cores += 1;
    }
    return cores >= 2;
  });
}

/** "Sanderson, Brandon" → "Brandon Sanderson"; other names unchanged. */
function flipName(name: string): string {
  const m = /^([^,]+),\s*([^,]+)$/.exec(name.trim());
  if (!m || /^(?:jr|sr|ii|iii|iv)\.?$/i.test(m[2]!.trim())) return name.trim();
  return `${m[2]!.trim()} ${m[1]!.trim()}`;
}

const looksSortName = (text: string): boolean => /^\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+)?,\s*\p{Lu}[\p{L}.'’\s-]*$/u.test(text.trim());

interface EbookField {
  text: string;
  seriesMarker?: SeriesMarker;
}

/** Peel tag words (and a year once a tag has gone) off the end of a field. */
function peelEbookTags(text: string, facts: EbookFacts, scene: boolean): string {
  const words = text.split(/\s+/).filter(Boolean);
  let peeled = false;
  while (words.length > 1) {
    const last = words[words.length - 1]!;
    const lower = last.toLowerCase();
    const isLanguage = languageOf(last, false) !== null && formatOfWord(lower) === null && !EBOOK_TAG_WORDS.has(lower) && !AUDIO_WORDS.has(lower);
    if (isEbookTag(last, false) && (!isLanguage || peeled || scene)) {
      applyEbookTag(facts, last, false);
      peeled = true;
    } else if (isYear(last) && (peeled || scene) && facts.year === undefined) {
      facts.year = Number(last);
      peeled = true;
    } else {
      break;
    }
    words.pop();
  }
  return words.join(' ');
}

function cleanText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:._-]+|[\s,;:_-]+$/g, '')
    .trim();
}

/**
 * Parse an ebook release name (see the header for the shapes). Null when neither an author, a
 * title nor a series could be read.
 */
export function parseEbookRelease(title: string): ParsedEbookRelease | null {
  const raw = title.trim();
  if (!raw) return null;
  const prepared = prepareName(raw, (w) => isEbookTag(w, true));
  const facts: EbookFacts = { formats: [], retail: false };
  addFormat(facts, prepared.extension ? booksFormatOfExtension(prepared.extension) : null);
  for (const tags of prepared.leadingTags) readTagList(tags, facts);
  const isAudio = AUDIO_PATTERN.test(raw) || ['m4b', 'm4a', 'mp3', 'flac'].includes(prepared.extension ?? '');

  // ISBNs anywhere in the name (never part of a title).
  let text = prepared.text.replace(ISBN_ANYWHERE, (match) => {
    const isbn = readIsbn(match);
    if (!isbn) return match;
    facts.isbn ??= isbn;
    return ' ';
  });
  text = text.replace(/\(\s*\)|\[\s*\]/g, ' ');

  const rawFields = text.split(/\s+[-–—]\s+|^-\s+|\s+-$/).map((f) => f.trim()).filter(Boolean);
  let fields: EbookField[] = [];
  for (const rawField of rawFields) {
    let seriesMarker: SeriesMarker | undefined;
    let fieldText = rawField.replace(BRACKET, (match, content: string) => {
      const c = content.trim();
      if (!c) return ' ';
      if (readTagList(c, facts)) return ' ';
      if (isYear(c)) {
        facts.year ??= Number(c);
        return ' ';
      }
      const marker = readSeriesMarker(c);
      if (marker && !seriesMarker) {
        seriesMarker = marker;
        return ' ';
      }
      return match;
    });
    fieldText = cleanText(peelEbookTags(cleanText(fieldText), facts, prepared.scene));
    const lone = fieldText.toLowerCase();
    if (fieldText && /^\S+$/.test(fieldText) && (isEbookTag(fieldText, true) && (formatOfWord(lone) || EBOOK_TAG_WORDS.has(lone) || AUDIO_WORDS.has(lone)))) {
      applyEbookTag(facts, fieldText, true);
      fieldText = '';
    }
    if (fieldText || seriesMarker) fields.push({ text: fieldText, ...(seriesMarker ? { seriesMarker } : {}) });
  }

  // A field that is only a year is the year once two other fields remain ("Title - Author - 2019").
  const yearFields = fields.filter((f) => isYear(f.text) && !f.seriesMarker);
  if (yearFields.length > 0 && fields.length - yearFields.length >= 2) {
    facts.year ??= Number(yearFields[0]!.text);
    fields = fields.filter((f) => !yearFields.includes(f));
  }
  fields = fields.filter((f) => f.text || f.seriesMarker);

  let author: string | undefined;
  let bookTitle: string | undefined;
  let series: string | undefined;
  let seriesPosition: string | undefined;
  let orderAmbiguous = false;
  let isPack = PACK_WORDS.test(text);

  const marker = fields.find((f) => f.seriesMarker)?.seriesMarker;
  const markerIndex = fields.findIndex((f) => f.seriesMarker);
  if (marker) {
    if (marker.series) series = marker.series;
    if (marker.position) seriesPosition = marker.position;
  }
  const takeSeries = (sf: SeriesField): void => {
    series ??= sf.series;
    seriesPosition ??= sf.position;
    if (sf.pack) isPack = true;
  };

  const texts = fields.map((f) => f.text).filter(Boolean);
  if (texts.length === 1) {
    const only = texts[0]!;
    const by = /^(.+?)\s+(?:by|von|par)\s+(.+)$/i.exec(only);
    const sf = readSeriesField(only);
    if (by && nameLike(by[2]!)) {
      bookTitle = by[1]!;
      author = by[2]!;
    } else if (sf?.pack) {
      takeSeries(sf);
    } else {
      bookTitle = only;
    }
  } else if (texts.length === 2) {
    const [a, b] = texts as [string, string];
    const sfB = readSeriesField(b);
    if (looksSortName(a)) {
      author = flipName(a);
      bookTitle = b;
    } else if (looksSortName(b) && !looksSortName(a)) {
      author = flipName(b);
      bookTitle = a;
    } else if (markerIndex === 0 && fields[0]!.text) {
      bookTitle = a;
      author = b;
    } else if (markerIndex >= 1) {
      author = a;
      bookTitle = b;
    } else if (sfB?.pack) {
      author = a;
      takeSeries(sfB);
    } else if (nameLike(a) !== nameLike(b)) {
      if (nameLike(a)) {
        author = a;
        bookTitle = b;
      } else {
        bookTitle = a;
        author = b;
      }
    } else {
      author = a;
      bookTitle = b;
      orderAmbiguous = true;
    }
  } else if (texts.length >= 3) {
    const middle = readSeriesField(texts[1]!);
    const first = texts[0]!;
    const last = texts[texts.length - 1]!;
    const lead = readSeriesField(first);
    if (middle && !nameLike(texts[1]!)) {
      author = first;
      takeSeries(middle);
      bookTitle = texts.slice(2).join(' - ');
    } else if (lead && !lead.pack && nameLike(last)) {
      // "Mistborn 01 - The Final Empire - Brandon Sanderson"
      takeSeries(lead);
      bookTitle = texts.slice(1, -1).join(' - ');
      author = last;
    } else if (nameLike(last) && !nameLike(first) && !looksSortName(first)) {
      bookTitle = texts.slice(0, -1).join(' - ');
      author = last;
    } else {
      author = first;
      bookTitle = texts.slice(1).join(' - ');
    }
  }

  if (author) author = cleanText(flipName(author));
  if (bookTitle) bookTitle = cleanText(bookTitle.replace(/\s+(?:narrated|read)\s+by\s+.+$/i, ''));
  if (bookTitle && /^(?:\d+|#?\d+\s*-\s*\d+)$/.test(bookTitle) && series) bookTitle = undefined;
  if (seriesPosition?.includes('-')) isPack = true;
  if (!author && !bookTitle && !series) return null;

  const format = bestFormat(facts.formats, 'ebook');
  return {
    ...(author ? { author } : {}),
    ...(bookTitle ? { title: bookTitle } : {}),
    ...(series ? { series: cleanText(series) } : {}),
    ...(seriesPosition ? { seriesPosition } : {}),
    ...(facts.year !== undefined ? { year: facts.year } : {}),
    ...(format ? { format } : {}),
    formats: facts.formats,
    ...(facts.isbn ? { isbn: facts.isbn } : {}),
    retail: facts.retail,
    ...(facts.language ? { language: facts.language } : {}),
    ...(prepared.group ? { releaseGroup: prepared.group } : {}),
    isPack,
    isAudio,
    orderAmbiguous,
  };
}

// ---------------------------------------------------------------------------------------
// Comics

const DIGITAL_WORDS = new Set(['digital', 'webrip', 'web', 'web-dl']);
const COLLECTED_WORDS = new Set(['tpb', 'hc', 'hardcover', 'omnibus', 'compendium', 'collected', 'collection', 'deluxe', 'tp']);
const COMIC_TAG_WORDS = new Set(['c2c', 'complete', 'manga', 'scan', 'scans', 'edition', 'annuals', '+', 'trade', 'paperback', 'oversized', 'repack', 'proper', 'fixed']);

function isComicTag(word: string): boolean {
  const w = word.toLowerCase();
  return formatOfWord(w) !== null || DIGITAL_WORDS.has(w) || COLLECTED_WORDS.has(w) || COMIC_TAG_WORDS.has(w);
}

interface ComicFacts {
  formats: BooksFormat[];
  digital: boolean;
  collected: boolean;
  pack: boolean;
  manga: boolean;
  year?: number;
}

function applyComicTag(facts: ComicFacts, word: string): void {
  const w = word.toLowerCase();
  addFormat(facts, formatOfWord(w));
  if (DIGITAL_WORDS.has(w)) facts.digital = true;
  if (COLLECTED_WORDS.has(w) || w === 'trade' || w === 'paperback') facts.collected = true;
  if (w === 'complete' || w === 'annuals') facts.pack = true;
  if (w === 'manga') facts.manga = true;
}

/** A comic bracket: tags, a year or year range, "of 6"; false when it is something else. */
function readComicBracket(content: string, facts: ComicFacts): boolean {
  const c = content.trim();
  const years = /^((?:19|20)\d{2})(?:\s*-\s*((?:19|20)\d{2}|\d{2}|present|current))?$/i.exec(c);
  if (years) {
    facts.year ??= Number(years[1]);
    return true;
  }
  if (/^of\s+\d+$/i.test(c)) return true;
  const words = c.split(/[\s,;/|&]+/).filter(Boolean);
  if (words.length === 0 || !words.every(isComicTag)) return false;
  for (const w of words) applyComicTag(facts, w);
  return true;
}

const ISSUE = String.raw`(-?\d+(?:\.\d+)?(?:\.?[A-Za-z]{1,3})?|\d*½|\d+\/\d+)`;
const VOLUME = String.raw`(?:v|vol\.?\s*|volume\s+)`;

interface IssueParts {
  series: string;
  issue?: string;
  issueEnd?: string;
  volume?: number;
  annual?: boolean;
  chapter?: boolean;
  volumeRange?: boolean;
}

/** Issue/volume/chapter marker at the end of `text`; null when there is none. */
function readIssue(text: string): IssueParts | null {
  let m = new RegExp(String.raw`^(.+?)\s+annual\s+#?${ISSUE}$`, 'i').exec(text);
  if (m) return { series: m[1]!, issue: m[2]!, annual: true };
  m = new RegExp(String.raw`^(.+?)\s+${VOLUME}(\d{1,4})\s*-\s*${VOLUME}?(\d{1,4})$`, 'i').exec(text);
  if (m) return { series: m[1]!, volume: Number(m[2]), volumeRange: true };
  m = /^(.+?)\s+(?:c|ch\.?\s?|chapter\s+)(\d{1,4}(?:\.\d)?)$/i.exec(text);
  if (m) return { series: m[1]!, issue: m[2]!, chapter: true };
  m = /^(.+?)\s+#?(\d+(?:\.\d+)?)\s*-\s*#?(\d+(?:\.\d+)?)$/.exec(text);
  if (m && Number(m[3]) > Number(m[2])) return { series: m[1]!, issue: m[2]!, issueEnd: m[3]! };
  m = new RegExp(String.raw`^(.+?)\s+${VOLUME}(\d{1,4})\s+#?${ISSUE}$`, 'i').exec(text);
  if (m) return { series: m[1]!, volume: Number(m[2]), issue: m[3]! };
  m = new RegExp(String.raw`^(.+?)\s+${VOLUME}(\d{1,4})$`, 'i').exec(text);
  if (m) return { series: m[1]!, volume: Number(m[2]) };
  m = new RegExp(String.raw`^(.+?)\s+#?${ISSUE}$`).exec(text);
  if (m && /[\p{L}]/u.test(m[1]!)) return { series: m[1]!, issue: m[2]! };
  m = new RegExp(String.raw`^#?${ISSUE}$`).exec(text);
  if (m) return { series: '', issue: m[1]! };
  return null;
}

function normalizeIssue(issue: string): string {
  const s = issue.trim().replace(/^#/, '');
  return s.replace(/^(-?)0+(?=\d)/, '$1');
}

/** Peel trailing tag words and a scene year ("050 2018 Digital") off the end of the main text. */
function peelComicTags(text: string, facts: ComicFacts, hasBracketYear: boolean): string {
  const words = text.split(/\s+/).filter(Boolean);
  while (words.length > 1) {
    const last = words[words.length - 1]!;
    const before = words[words.length - 2]!;
    if (isComicTag(last) && last !== '+') {
      applyComicTag(facts, last);
      if (/^annuals$/i.test(last) && before === '+') words.pop();
    } else if (/^(?:19|20)\d{2}$/.test(last) && !hasBracketYear && facts.year === undefined && /^(?:#?\d+(?:\.\d+)?|v\d+|c\d+)$/i.test(before)) {
      facts.year = Number(last);
    } else {
      break;
    }
    words.pop();
  }
  return words.join(' ');
}

interface ComicPartial extends Omit<ParsedComicRelease, 'series'> {
  series: string;
}

function parseComicPartial(title: string): ComicPartial | null {
  const raw = title.trim();
  if (!raw) return null;
  const prepared = prepareName(raw, isComicTag);
  const facts: ComicFacts = { formats: [], digital: false, collected: false, pack: false, manga: false };
  addFormat(facts, prepared.extension ? booksFormatOfExtension(prepared.extension) : null);
  for (const tags of prepared.leadingTags) readComicBracket(tags, facts);

  let group = prepared.group;
  let bracketGroup: string | undefined;
  let text = prepared.text.replace(BRACKET, (_match, content: string) => {
    const c = content.trim();
    if (!c) return ' ';
    if (readComicBracket(c, facts)) return ' ';
    if (/^(?:deluxe|collected|absolute|library|anniversary|special|director'?s?\s+cut|complete)\b.*edition$|^trade\s+paperback$|^graphic\s+novel$/i.test(c)) {
      if (!/^(?:special|anniversary)/i.test(c)) facts.collected = true;
      return ' ';
    }
    if (/^\+?\s*annuals?$/i.test(c) || /^complete\s+series$/i.test(c)) {
      facts.pack = true;
      return ' ';
    }
    if (/^manga$/i.test(c)) {
      facts.manga = true;
      return ' ';
    }
    bracketGroup = c;
    return ' ';
  });
  group ??= bracketGroup;
  const hasBracketYear = facts.year !== undefined;

  text = text.replace(/\s+\+\s*annuals?\b/i, () => {
    facts.pack = true;
    return ' ';
  });
  text = text.replace(/\s+/g, ' ').trim();
  if (/(?<![\p{L}])(?:deluxe|collected|absolute)\s+edition(?![\p{L}])|(?<![\p{L}])(?:omnibus|compendium|tpb)(?![\p{L}])/iu.test(text)) facts.collected = true;
  if (/(?<![\p{L}])manga(?![\p{L}])/iu.test(text)) facts.manga = true;
  text = text.replace(/\s+(?:deluxe|collected)\s+edition$/i, '');
  text = cleanText(peelComicTags(text, facts, hasBracketYear));

  let parts = readIssue(text);
  if (!parts) {
    // "Batman 050 - The Wedding": the issue sits before an issue title.
    const head = text.split(/\s+[-–—]\s+/)[0]!;
    if (head !== text) {
      const p = readIssue(cleanText(peelComicTags(head, facts, hasBracketYear)));
      if (p && (p.issue !== undefined || p.volume !== undefined)) parts = p;
    }
  }
  const series = cleanText(parts ? parts.series : text);
  const issueNumber = parts?.issue !== undefined ? normalizeIssue(parts.issue) : undefined;
  const issueEnd = parts?.issueEnd !== undefined ? normalizeIssue(parts.issueEnd) : undefined;
  const volume = parts?.volume;
  const isPack = facts.pack || issueEnd !== undefined || Boolean(parts?.volumeRange);
  const isManga = facts.manga || Boolean(parts?.chapter) || Boolean(parts?.volumeRange) || (volume !== undefined && volume >= 100);
  const format = bestFormat(facts.formats, 'comic');
  if (!series && issueNumber === undefined) return null;
  return {
    series,
    ...(issueNumber !== undefined ? { issueNumber } : {}),
    ...(issueEnd !== undefined ? { issueEnd } : {}),
    ...(volume !== undefined ? { volume } : {}),
    ...(facts.year !== undefined ? { year: facts.year } : {}),
    ...(format ? { format } : {}),
    formats: facts.formats,
    digital: facts.digital,
    ...(group ? { releaseGroup: group } : {}),
    annual: Boolean(parts?.annual),
    collected: facts.collected,
    isPack,
    isManga,
  };
}

/** Parse a comic or manga release name (see the header for the shapes). Null when no series could be read. */
export function parseComicRelease(title: string): ParsedComicRelease | null {
  const r = parseComicPartial(title);
  return r && r.series ? r : null;
}

// ---------------------------------------------------------------------------------------
// Paths and keys

function pathParts(path: string): { file: string; folder: string | null; grandparent: string | null } {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return {
    file: parts[parts.length - 1] ?? path,
    folder: parts.length > 1 ? parts[parts.length - 2]! : null,
    grandparent: parts.length > 2 ? parts[parts.length - 3]! : null,
  };
}

/**
 * Parse an ebook file path: the file name first, missing fields from the parent folder, and an
 * author-shaped grandparent folder ("Author/Title (Year)/file.epub") for a missing author.
 */
export function parseEbookPath(path: string): ParsedEbookRelease | null {
  const { file, folder, grandparent } = pathParts(path);
  let fromFile = parseEbookRelease(file);
  // A bare number or track-like name ("01.epub") says nothing about the book.
  if (fromFile?.title && /^\d{1,3}$/.test(fromFile.title) && !fromFile.author) {
    const { title: _title, ...rest } = fromFile;
    fromFile = rest;
  }
  const fromFolder = folder ? parseEbookRelease(folder) : null;
  if (!fromFile) return fromFolder;
  if (!fromFolder) return fromFile;
  const merged: ParsedEbookRelease = { ...fromFolder, ...stripUndefined(fromFile) };
  merged.formats = fromFile.formats.length ? fromFile.formats : fromFolder.formats;
  const format = bestFormat(merged.formats, 'ebook');
  if (format) merged.format = format;
  merged.retail = fromFile.retail || fromFolder.retail;
  merged.isAudio = fromFile.isAudio || fromFolder.isAudio;
  merged.isPack = fromFile.isPack;
  merged.orderAmbiguous = fromFile.orderAmbiguous && !(fromFile.title && fromFolder.title === fromFile.title);
  // "Brandon Sanderson/The Final Empire (2006)/The Final Empire.epub"
  if (!merged.author && grandparent && nameLike(grandparent)) merged.author = grandparent;
  if (!merged.title && fromFolder.title) merged.title = fromFolder.title;
  return merged;
}

/**
 * Parse a comic file path: the file name first, missing fields (series, year, volume) from the
 * parent folder ("Saga (2012)/054.cbz").
 */
export function parseComicPath(path: string): ParsedComicRelease | null {
  const { file, folder } = pathParts(path);
  const fromFile = parseComicPartial(file);
  const fromFolder = folder ? parseComicPartial(folder) : null;
  if (!fromFile || !fromFile.series) {
    if (!fromFolder?.series) return fromFile?.series ? fromFile : null;
    if (!fromFile) return fromFolder;
    const merged: ParsedComicRelease = { ...fromFolder, ...stripUndefined(fromFile), series: fromFolder.series };
    if (fromFile.formats.length) merged.formats = fromFile.formats;
    if (fromFile.format) merged.format = fromFile.format;
    merged.digital = fromFile.digital || fromFolder.digital;
    merged.isManga = fromFile.isManga || fromFolder.isManga;
    merged.collected = fromFile.collected || fromFolder.collected;
    merged.isPack = fromFile.isPack;
    if (fromFile.issueEnd === undefined) delete merged.issueEnd;
    return merged;
  }
  if (fromFolder?.series) {
    if (fromFile.year === undefined && fromFolder.year !== undefined) fromFile.year = fromFolder.year;
    if (fromFile.volume === undefined && fromFolder.volume !== undefined && fromFile.issueNumber !== undefined) fromFile.volume = fromFolder.volume;
    fromFile.isManga ||= fromFolder.isManga;
  }
  return fromFile;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Normalized key for comparing book titles and author names: diacritics folded, lower case,
 * "&" read as "and", punctuation dropped, a leading "The"/"A"/"An" removed
 * ("The Final Empire" → "final empire", "Ender's Game" → "enders game").
 */
export function bookTitleKey(title: string): string {
  const words = removeAccents(title)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (words.length > 1 && (words[0] === 'the' || words[0] === 'a' || words[0] === 'an')) words.shift();
  return words.join(' ');
}

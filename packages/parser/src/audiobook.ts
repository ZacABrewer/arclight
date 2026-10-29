import { QUALITIES, type AudioCodec, type AudioFileLayout, type AudioVbrPreset, type QualityDefinition, type ReleaseAudioEvaluation, type ReleaseKind } from '@arclight/shared';
import { readAudioFacts, type ParsedAudioQuality } from './audio-quality.js';
import { parseReleaseHash } from './hash.js';
import { prepare } from './normalize.js';
import { parseRevision } from './quality.js';

// Audiobook release names (docs/design/music-audiobooks.md section 6). The usual shapes:
//
//   Author - Title (Unabridged) [m4b]               fields split on " - ", tags in brackets
//   Author - Series 03 - Title                      a numbered middle field is the series
//   Author - [Series #3] - Title (2015) 64kbps      a bracketed series marker
//   Title - Author - Narrator                       field order told apart by name shapes
//   Author - Title (read by X) / narrated by X      narrators by phrase
//   Author - Title {Narrator} [ASIN B0...]          braces hold the narrator
//   Author - Series Books 1-5 [mp3]                 packs: a range, "Complete Series", "Collection"
//   Author_Name-Title-AUDIOBOOK-WEB-EN-2019-GRP     scene: "-" between fields, group last
//
// Brackets are classified one at a time (tags, year, ids, narrator, series marker). What is
// not recognised stays in the text. Only tag words (codec, bitrate, container, format type,
// language, retail, chapters) are read as facts, so a title such as "Charlotte's Web" or
// "It" keeps its words.

export type AudiobookFormat = 'unabridged' | 'abridged' | 'dramatized' | 'unknown';
export type AudiobookContainer = 'm4b' | 'm4a' | 'mp3' | 'flac' | 'opus' | 'unknown';

export interface ParsedAudiobookInfo {
  /** As written; "Tolkien, J. R. R." is turned around to "J. R. R. Tolkien". Empty when none. */
  authors: string[];
  /** Null for packs named only by series and range ("The Expanse Books 1-5"). */
  title: string | null;
  subtitle: string | null;
  series: string | null;
  /** "3", "2.5", or a range for packs ("1-5"). Leading zeros dropped. */
  seriesPosition: string | null;
  narrators: string[];
  year: number | null;
  formatType: AudiobookFormat;
  container: AudiobookContainer;
  bitrateKbps: number | null;
  asin: string | null;
  isbn: string | null;
  isPack: boolean;
  /** ISO 639-1 code ("en", "de") when the name states a language. */
  language: string | null;
  retail: boolean;
  /** "Chapterized", "chaptered", "w/ chapters". */
  chapterized: boolean;
  /** Stated layout ("single file", "multi-file"), when the name says. */
  fileLayout: AudioFileLayout | null;
  /** Scene-style name (no spaces, "-" separated, group last). */
  scene: boolean;
  audio: ParsedAudioQuality;
}

export interface ParsedAudiobookRelease {
  /** Name after basic cleanup (extension and website tags removed). */
  releaseTitle: string;
  releaseGroup: string | null;
  releaseHash: string | null;
  /** Audio facts mapped to an audiobook quality (AB-*). */
  audio: ParsedAudioQuality;
  /** Null when neither an author, a title, a series nor a pack could be read. */
  audiobook: ParsedAudiobookInfo | null;
}

// ---------------------------------------------------------------------------------------
// Extensions and containers

const AUDIOBOOK_EXTENSION = /\.(m4b|m4a|mp3|flac|opus|ogg|oga|aac|aax|aaxc|mp4|wav|zip|rar|torrent|nzb|cue|nfo|jpg|png)$/i;

function stripAudiobookExtension(name: string): { title: string; extension: string | null } {
  const m = AUDIOBOOK_EXTENSION.exec(name);
  if (!m) return { title: name, extension: null };
  return { title: name.slice(0, m.index), extension: m[1]!.toLowerCase() };
}

const CONTAINER_OF: Record<string, AudiobookContainer> = {
  m4b: 'm4b',
  m4a: 'm4a',
  mp4: 'm4a',
  aac: 'm4a',
  aax: 'm4b',
  aaxc: 'm4b',
  mp3: 'mp3',
  flac: 'flac',
  opus: 'opus',
};

const CODEC_OF_CONTAINER: Record<Exclude<AudiobookContainer, 'unknown'>, AudioCodec> = {
  m4b: 'AAC',
  m4a: 'AAC',
  mp3: 'MP3',
  flac: 'FLAC',
  opus: 'Opus',
};

// ---------------------------------------------------------------------------------------
// Tag words

const LANGUAGE_NAMES: Record<string, string> = {
  english: 'en', englisch: 'en', anglais: 'en',
  german: 'de', deutsch: 'de', allemand: 'de',
  french: 'fr', français: 'fr', francais: 'fr', französisch: 'fr',
  spanish: 'es', español: 'es', espanol: 'es', castellano: 'es',
  italian: 'it', italiano: 'it',
  dutch: 'nl', nederlands: 'nl',
  polish: 'pl', polski: 'pl',
  russian: 'ru', russkiy: 'ru',
  japanese: 'ja',
  portuguese: 'pt', português: 'pt', portugues: 'pt',
  swedish: 'sv', svenska: 'sv',
  danish: 'da', dansk: 'da',
  norwegian: 'no', norsk: 'no',
  finnish: 'fi', suomi: 'fi',
  czech: 'cs', hungarian: 'hu', turkish: 'tr', chinese: 'zh', korean: 'ko',
};
/** Short codes; they only count written in capitals ("EN", "GER"), so "It" stays a title. */
const LANGUAGE_CODES: Record<string, string> = {
  EN: 'en', ENG: 'en', DE: 'de', GER: 'de', DEU: 'de', FR: 'fr', FRE: 'fr', FRA: 'fr', ES: 'es', SPA: 'es', ESP: 'es',
  IT: 'it', ITA: 'it', NL: 'nl', NLD: 'nl', DUT: 'nl', PL: 'pl', POL: 'pl', RU: 'ru', RUS: 'ru', JA: 'ja', JPN: 'ja',
  PT: 'pt', POR: 'pt', SV: 'sv', SWE: 'sv', DA: 'da', DAN: 'da', NO: 'no', NOR: 'no', FI: 'fi', FIN: 'fi',
};

const FORMAT_WORDS: Record<string, Exclude<AudiobookFormat, 'unknown'>> = {
  unabridged: 'unabridged', ungekürzt: 'unabridged', ungekuerzt: 'unabridged', integral: 'unabridged', intégral: 'unabridged', integrale: 'unabridged', intégrale: 'unabridged',
  abridged: 'abridged', gekürzt: 'abridged', gekuerzt: 'abridged',
  dramatized: 'dramatized', dramatised: 'dramatized', dramatization: 'dramatized', dramatisation: 'dramatized', fullcast: 'dramatized', radiodrama: 'dramatized', hörspiel: 'dramatized', hoerspiel: 'dramatized',
};

const CHAPTER_WORDS = new Set(['chapterized', 'chapterised', 'chaptered', 'chapters', 'chapter', 'chaps', 'chaptermarks']);
const SOURCE_WORDS = new Set(['web', 'webrip', 'audible', 'itunes', 'cd', 'cds', 'cdrip', 'rip', 'audiobook', 'audiobooks', 'abook', 'hörbuch', 'hoerbuch', 'hörbücher', 'librivox', 'proper', 'repack']);
const CODEC_WORDS = new Set(['cbr', 'vbr', 'abr', 'v0', 'v1', 'v2', 'aps', 'apx', 'lame', 'mono', 'stereo', 'joint', 'he-aac', 'aac-lc', 'lc']);
const FILLER_WORDS = new Set(['and', 'with', 'w', 'in', '@', '-', 'kbps']);
/** Tag words safe to peel off the end of a title (never ordinary title words). */
const PEELABLE = /^(?:m4b|m4a|mp3|flac|opus|aac|aax|\d{2,3}(?:[.,]\d+)?(?:kbps|kbit\/?s|kbs|kb\/s|k)|\d{2}(?:[.,]\d)?khz|cbr|vbr|unabridged|abridged|dramatized|dramatised|ungekürzt|gekürzt|retail|chapterized|chapterised|chaptered|audiobook|audiobooks|hörbuch|abook|webrip)$/i;

const TAG_PHRASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/full[-\s]cast/gi, ' fullcast '],
  [/radio[-\s](?:drama|play|show)/gi, ' radiodrama '],
  [/audio[-\s]book/gi, ' audiobook '],
  [/(?<![\p{L}\p{N}])(?:single|one|1)[-\s]file(?![\p{L}])/giu, ' singlefile '],
  [/(?<![\p{L}\p{N}])(?:multi(?:ple)?[-\s]?files?|\d{1,3}[-\s]files)(?![\p{L}])/giu, ' multifile '],
  [/(?<![\p{L}])web[-\s]?(?:dl|rip)(?![\p{L}])/giu, ' webrip '],
  [/w\/\s?chapters/gi, ' chapters '],
  [/chapter[-\s]marks/gi, ' chaptermarks '],
  [/(\d)\s+(kbps|kbit\/?s|kbs|kb\/s|k|khz)(?![\p{L}])/giu, '$1$2'],
  [/(?<![\p{L}])cd[-\s]?rip(?![\p{L}])/giu, ' cdrip '],
];

interface TagFacts {
  container: AudiobookContainer | null;
  formatType: AudiobookFormat | null;
  language: string | null;
  retail: boolean;
  chapterized: boolean;
  layout: AudioFileLayout | null;
  year: number | null;
  /** The tag text for codec/bitrate reading, with container words made readable. */
  tech: string;
}

/**
 * Read `text` as a list of tag words ("Unabridged, m4b, 64kbps", "MP3 VBR", "Retail EN").
 * Null when any word is not a tag word.
 */
function classifyTags(text: string, options: { bracket: boolean } = { bracket: true }): TagFacts | null {
  let t = ` ${text} `;
  for (const [pattern, replacement] of TAG_PHRASES) t = t.replace(pattern, replacement);
  const raw = t
    .split(/[\s,;+/|&()[\]{}]+/)
    .flatMap((w) => (/^(?:he-aac|aac-lc)$/i.test(w) ? [w] : w.split(/(?<=\D)-|-(?=\D)/)))
    .map((w) => w.replace(/^[.:!'"]+|[.:!'"]+$/g, ''))
    .filter(Boolean);
  if (raw.length === 0) return null;
  const facts: TagFacts = { container: null, formatType: null, language: null, retail: false, chapterized: false, layout: null, year: null, tech: '' };
  const hasCodec = raw.some((w) => /^(?:mp3|m4b|m4a|aac|opus|flac|ogg)$/i.test(w));
  const tech: string[] = [];
  for (const word of raw) {
    const w = word.toLowerCase();
    if (/^(?:19|20)\d{2}$/.test(w)) {
      facts.year ??= Number(w);
    } else if (CONTAINER_OF[w] || w === 'ogg') {
      facts.container ??= CONTAINER_OF[w] ?? null;
      tech.push(w === 'm4b' || w === 'aax' || w === 'aaxc' ? 'M4A' : word.toUpperCase());
    } else if (/^\d{2,3}(?:[.,]\d+)?(?:kbps|kbit\/?s|kbs|kb\/s|k)$/.test(w) || /^\d{2}(?:[.,]\d)?khz$/.test(w)) {
      tech.push(w);
    } else if (/^\d{2,3}$/.test(w) && hasCodec) {
      tech.push(`${w}kbps`);
    } else if (w === 'alac') {
      tech.push('ALAC');
    } else if (CODEC_WORDS.has(w)) {
      tech.push(word.toUpperCase());
    } else if (FORMAT_WORDS[w]) {
      facts.formatType ??= FORMAT_WORDS[w]!;
    } else if (CHAPTER_WORDS.has(w)) {
      facts.chapterized = true;
    } else if (w === 'retail') {
      facts.retail = true;
    } else if (w === 'singlefile' || w === 'multifile') {
      facts.layout ??= w === 'singlefile' ? 'single' : 'multi';
    } else if (SOURCE_WORDS.has(w)) {
      // Source words say nothing the profiles read; they only mark the bracket as tags.
    } else if (LANGUAGE_NAMES[w]) {
      facts.language ??= LANGUAGE_NAMES[w]!;
    } else if (LANGUAGE_CODES[word] && (word === word.toUpperCase() || (options.bracket && word.length === 3))) {
      facts.language ??= LANGUAGE_CODES[word]!;
    } else if (FILLER_WORDS.has(w)) {
      // "MP3 and M4B", "64kbps in Mono"
    } else {
      return null;
    }
  }
  facts.tech = tech.join(' ');
  return facts;
}

// ---------------------------------------------------------------------------------------
// People

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'from', 'with', 'my', 'your', 'our', 'his', 'her', 'their', 'its', 'is', 'are', 'was',
  'no', 'not', 'all', 'and', 'or', 'book', 'books', 'series', 'part', 'volume', 'collection', 'complete', 'novel', 'novels', 'edition',
  'chronicles', 'saga', 'trilogy', 'tales', 'story', 'stories', 'guide', 'history', 'how', 'why', 'what', 'who', 'when', 'where', 'unabridged',
  'abridged', 'dramatized', 'audiobook', 'cast', 'full', 'presents', 'introduction', 'world', 'war', 'night', 'dark', 'last', 'first', 'new',
]);
const INITIALS = /^(?:\p{Lu}\.){1,3}$|^\p{Lu}\.$/u;
const PARTICLES = new Set(['de', 'da', 'di', 'del', 'der', 'den', 'van', 'von', 'le', 'la', 'du', 'st.', 'bin', 'ibn']);
const NAME_WORD = /^(?:\p{Lu}[\p{Ll}'’]+(?:-\p{Lu}[\p{Ll}'’]+)*|Mc\p{Lu}\p{Ll}+|Mac\p{Lu}\p{Ll}+|\p{Lu}['’]\p{Lu}\p{Ll}+|d['’]\p{Lu}\p{Ll}+|Jr\.?|Sr\.?|II|III|IV)$/u;

/** Split a credit list: "A, B & C", "A and B", "A with B"; "Tolkien, J. R. R." stays one name. */
function splitPeople(text: string): string[] {
  const pieces = text
    .split(/\s*[,;/]\s*|\s+(?:&|and|und|et|with|\+)\s+/i)
    .map((s) => s.replace(/^[\s\-–—]+|[\s\-–—]+$/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  // "Ashby, Corin" / "Le Guin, Ursula K.": one surname, then the given names.
  const comma = /^([\p{Lu}][\p{L}'’-]+(?:\s(?:Le|De|Van|Von|Du)?\s?[\p{Lu}][\p{L}'’-]+)?),\s*([\p{Lu}][\p{L}'’-]+(?:\s(?:\p{Lu}\.|[\p{Lu}][\p{L}'’-]+))?)$/u.exec(text.trim());
  if (comma && !/\s(?:&|and|with)\s/i.test(text) && (!/\s/.test(comma[1]!) || /^(?:Le|La|De|Du|Van|Von|Del|Da)\s/.test(comma[1]!))) return [`${comma[2]} ${comma[1]}`];
  const out: string[] = [];
  for (const p of pieces) {
    // "Tolkien, J. R. R." / "King, S.": initials after a surname belong in front of it.
    if (/^(?:\p{Lu}\.\s?)+$/u.test(p) && out.length > 0 && !/\s/.test(out[out.length - 1]!)) {
      out[out.length - 1] = `${p} ${out[out.length - 1]!}`;
      continue;
    }
    out.push(p);
  }
  return out;
}

/**
 * How much a field looks like person names: 0 not a name, 1 could be ("Red Rising" could be
 * either), 2 surely ("J. R. R. Tolkien", "Ursula K. Le Guin", "A & B").
 */
function personScore(text: string): 0 | 1 | 2 {
  if (/\d|[:!?]/.test(text)) return 0;
  const names = splitPeople(text);
  if (names.length === 0) return 0;
  let strong = names.length > 1;
  for (const name of names) {
    const words = name.split(/\s+|(?<=\.)(?=\p{Lu})/u).filter(Boolean);
    const core = words.filter((w) => !/^(?:Jr\.?|Sr\.?|II|III|IV)$/.test(w));
    if (core.length < 2 || core.length > 5) return 0;
    for (const w of core) {
      if (STOP_WORDS.has(w.toLowerCase())) return 0;
      if (INITIALS.test(w)) {
        strong = true;
        continue;
      }
      if (PARTICLES.has(w.toLowerCase())) {
        strong = true;
        continue;
      }
      if (!NAME_WORD.test(w)) return 0;
    }
  }
  return strong ? 2 : 1;
}

// ---------------------------------------------------------------------------------------
// Series markers and packs

const NUM = String.raw`\d{1,3}(?:\.\d{1,2})?`;
const BOOK_WORD = String.raw`(?:Book|Bk|Volume|Vol|No|Number|Tome|Band|Teil|Folge|Livre|Libro)\.?\s*`;
const re = (src: string, flags = 'iu') => new RegExp(src, flags);

/** "Series, Book 3", "Series #3", "Series Vol. 2.5", "Series Book 3 of 9". */
const SERIES_KEYWORD = re(String.raw`^(.+?)[\s,]+(?:${BOOK_WORD}|#\s*)(${NUM})(?:\s+of\s+\d{1,3})?$`);
/** "Book 3", "#3", "Vol. 2". */
const POSITION_ONLY = re(String.raw`^(?:${BOOK_WORD}|#\s*)(${NUM})(?:\s+of\s+\d{1,3})?$`);
/** "Book 3: Title", "Book 3. Title", "#3 Title". */
const POSITION_TITLE = re(String.raw`^(?:${BOOK_WORD}|#\s*)(${NUM})\s*[:.)]\s*(.+)$`);
/** "Series 03" (only between other fields, so "Catch 22" as a last field stays a title). */
const SERIES_BARE = re(String.raw`^(.+?)[\s,]+(${NUM})$`);
/** "Series Books 1-5", "Books 1 to 3", "The Expanse 1-5". */
const PACK_RANGE = re(String.raw`^(.*?)[\s,]*(?:(?:Books|Book|Bks|Bk|Volumes|Vols|Vol|Novels|Bände|Tomes|Teile|Folgen)\.?\s*|#\s*)?(\d{1,3}(?:\.\d{1,2})?)\s*(?:-|–|to|thru|through|bis|&)\s*(\d{1,3}(?:\.\d{1,2})?)$`);
const COMPLETE_SERIES = re(String.raw`(?<![\p{L}])(?:the\s+)?complete\s+(?:(.+?)\s+)?(?:series|saga|collection|books|novels|works)(?![\p{L}])|(?<![\p{L}])(?:series|saga)\s+complete(?![\p{L}])`);
const COLLECTION = re(String.raw`(?<![\p{L}])(?:collection|omnibus|box(?:ed)?[-\s]?set|boxset|trilogy|quartet|quintet|anthology|complete\s+works|gesamtausgabe|sammelband)(?![\p{L}])`);

function normPosition(text: string): string {
  return text
    .split(/\s*[-–]\s*/)
    .map((p) => p.replace(/^0+(?=\d)/, ''))
    .join('-');
}

// ---------------------------------------------------------------------------------------
// Accumulated facts

interface Acc {
  year: number | null;
  formatType: AudiobookFormat;
  container: AudiobookContainer;
  language: string | null;
  retail: boolean;
  chapterized: boolean;
  layout: AudioFileLayout | null;
  tech: string[];
  narrators: string[];
  asin: string | null;
  isbn: string | null;
  series: string | null;
  position: string | null;
  isPack: boolean;
  group: string | null;
  /** A name in a leading bracket ("[Author] Title"). */
  authorHint: string | null;
}

const emptyAcc = (): Acc => ({
  year: null,
  formatType: 'unknown',
  container: 'unknown',
  language: null,
  retail: false,
  chapterized: false,
  layout: null,
  tech: [],
  narrators: [],
  asin: null,
  isbn: null,
  series: null,
  position: null,
  isPack: false,
  group: null,
  authorHint: null,
});

function applyTags(acc: Acc, f: TagFacts): void {
  if (f.container && acc.container === 'unknown') acc.container = f.container;
  if (f.formatType && acc.formatType === 'unknown') acc.formatType = f.formatType;
  acc.language ??= f.language;
  acc.retail ||= f.retail;
  acc.chapterized ||= f.chapterized;
  acc.layout ??= f.layout;
  acc.year ??= f.year;
  if (f.tech) acc.tech.push(f.tech);
}

const NARRATOR_PREFIX = re(String.raw`^(?:(?:read|narrated|performed|voiced|told)\s+by|narrators?|narr\.?|nar\.?|reader|read|sprecher(?:in)?|gelesen\s+von|lu\s+par|leído\s+por|letto\s+da)\s*[:\-]?\s*(.+)$`);
const NARRATOR_PHRASE = re(String.raw`(?:^|[\s,;]+)(?:read|narrated|performed|voiced)\s+by[\s:]+(.+?)(?=\s+[-–—]\s+|\s*$)`);

const ASIN = /(?<![A-Za-z0-9])(?:ASIN[\s:#=-]*)?(B0[0-9A-Z]{8})(?![A-Za-z0-9])|(?<![A-Za-z0-9])ASIN[\s:#=-]*(\d{9}[\dX])(?![A-Za-z0-9])/;
const ISBN = /(?<![A-Za-z0-9])ISBN(?:-?1[03])?[\s:#=]*((?:97[89][-\s]?)?\d{1,5}[-\s]?\d{1,7}[-\s]?\d{1,7}[-\s]?[\dX])(?![\dX])|(?<![\d-])(97[89][-\s]?\d{1,5}[-\s]?\d{1,7}[-\s]?\d{1,7}[-\s]?\d)(?![\d-])/i;

/** Pull ASIN and ISBN out of the text (anywhere; the ids never belong to a title). */
function takeIds(text: string, acc: Acc): string {
  let t = text;
  const a = ASIN.exec(t);
  if (a) {
    acc.asin = (a[1] ?? a[2])!.toUpperCase();
    t = t.slice(0, a.index) + ' ' + t.slice(a.index + a[0].length);
  }
  const i = ISBN.exec(t);
  if (i) {
    const digits = (i[1] ?? i[2])!.replace(/[-\s]/g, '').toUpperCase();
    if (digits.length === 10 || digits.length === 13) {
      acc.isbn = digits;
      t = t.slice(0, i.index) + ' ' + t.slice(i.index + i[0].length);
    }
  }
  // Brackets emptied by the ids: "[ASIN B0...]" → "[ ]".
  return t.replace(/[[({]\s*[\])}]/g, ' ');
}

/** Series marker or pack inside one bracket; returns true when it was one. */
function bracketSeries(inner: string, acc: Acc): boolean {
  const t = inner.trim();
  const range = PACK_RANGE.exec(t);
  if (range && (range[1]!.trim() || /book|vol|#/i.test(t))) {
    acc.isPack = true;
    acc.series ??= cleanField(range[1]!) || null;
    acc.position ??= normPosition(`${range[2]}-${range[3]}`);
    return true;
  }
  const keyword = SERIES_KEYWORD.exec(t);
  if (keyword && personScore(keyword[1]!) < 2) {
    acc.series ??= cleanField(keyword[1]!);
    acc.position ??= normPosition(keyword[2]!);
    return true;
  }
  const only = POSITION_ONLY.exec(t);
  if (only) {
    acc.position ??= normPosition(only[1]!);
    return true;
  }
  const bare = SERIES_BARE.exec(t);
  if (bare && !/(?:^|\s)(?:part|cd|disc|disk|track)$/i.test(bare[1]!)) {
    acc.series ??= cleanField(bare[1]!);
    acc.position ??= normPosition(bare[2]!);
    return true;
  }
  return false;
}

const BRACKET = /[[({]([^[\](){}]*)[\])}]/g;

/** Classify each bracket; recognised ones are replaced by spaces, the rest stay. */
function extractBrackets(text: string, acc: Acc): string {
  let tagSeen = false;
  let out = text.replace(BRACKET, (whole, inner: string, offset: number) => {
    const t = inner.trim();
    if (!t) return ' ';
    // "[Author Name] Title": a leading square bracket holding a name.
    if (offset === 0 && whole.startsWith('[') && personScore(t) > 0 && text.slice(whole.length).trim()) {
      acc.authorHint = t;
      return ' ';
    }
    const tags = classifyTags(t);
    if (tags) {
      applyTags(acc, tags);
      tagSeen = true;
      return '   ';
    }
    const narr = NARRATOR_PREFIX.exec(t);
    if (narr) {
      acc.narrators.push(...splitPeople(narr[1]!));
      return '   ';
    }
    // {Narrator}: braces hold the narrator in Audiobookshelf-style names.
    if (whole.startsWith('{')) {
      acc.narrators.push(...splitPeople(t));
      return '   ';
    }
    if (bracketSeries(t, acc)) return '   ';
    // "(2015, Unabridged)" mixed with a recognised phrase is handled above; a pack marker
    // ("(Complete Series)") marks the pack and is dropped.
    if ((COMPLETE_SERIES.test(t) || COLLECTION.test(t)) && t.split(/\s+/).length <= 3) {
      acc.isPack = true;
      return '   ';
    }
    return whole;
  });
  // "[m4b]-GRP": a group glued to a tag bracket.
  const glued = /[\])}]-([A-Za-z0-9_]{2,20})\s*$/.exec(text);
  if (tagSeen && glued && !/^(?:19|20)\d{2}$/.test(glued[1]!)) {
    acc.group ??= glued[1]!;
    out = out.replace(/-([A-Za-z0-9_]{2,20})\s*$/, '');
  }
  return out;
}

function cleanField(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—_.,:;]+|[\s\-–—_,:;]+$/g, '')
    .trim();
}

/** Peel tag words and a "-GROUP" off the end: "Title 2015 Unabridged MP3-GRP". */
function peelTrailing(text: string, acc: Acc): string {
  let t = text.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 16; i++) {
    const before = t;
    const glued = /(\S+)-([A-Za-z0-9]{2,20})$/.exec(t);
    if (glued && (PEELABLE.test(glued[1]!) || /^(?:19|20)\d{2}$/.test(glued[1]!)) && !PEELABLE.test(glued[2]!) && !/^(?:19|20)\d{2}$/.test(glued[2]!)) {
      acc.group ??= glued[2]!;
      t = t.slice(0, glued.index + glued[1]!.length);
    }
    const last = /(?:^|\s)(\S+)$/.exec(t);
    if (last) {
      const w = last[1]!;
      const rest = t.slice(0, last.index).trim();
      const lastField = rest.split(/\s[-–—]\s/).pop() ?? '';
      if (/^[-–—,]$/.test(w)) {
        t = rest;
      } else if (PEELABLE.test(w) && rest) {
        applyTags(acc, classifyTags(w, { bracket: false }) ?? emptyTagFacts());
        t = rest;
      } else if (/^(?:ENG|GER|FRE|SPA|ITA)$/.test(w) && rest) {
        applyTags(acc, classifyTags(w, { bracket: false }) ?? emptyTagFacts());
        t = rest;
      } else if (/^(?:19|20)\d{2}$/.test(w) && cleanField(lastField) && !/\s[-–—]$/.test(rest) && !/(?:^|\s)(?:of|in|the|to|from)$/i.test(rest)) {
        acc.year ??= Number(w);
        t = rest;
      }
    }
    if (t === before) break;
  }
  return t;
}

const emptyTagFacts = (): TagFacts => ({ container: null, formatType: null, language: null, retail: false, chapterized: false, layout: null, year: null, tech: '' });

// Field separators: dashes, and " | " (common in archive listings: "Title | Author").
const DASH_SPLIT = /\s+[-–—]+\s+|\s+[-–—](?=\S)|(?<=\S)[–—]\s+|\s+\|\s+/;

// ---------------------------------------------------------------------------------------
// Fields

interface Fields {
  authors: string[];
  title: string | null;
  subtitle: string | null;
}

/** Series markers among the fields. Returns the fields that are left. */
function takeSeriesParts(parts: string[], acc: Acc, authorFirst: boolean): { rest: string[]; firstTaken: boolean } {
  const rest: string[] = [];
  let firstTaken = false;
  const start = authorFirst ? 1 : 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const isLast = i === parts.length - 1;
    const prevMiddle = rest.length > start ? rest[rest.length - 1]! : null;
    const take = () => {
      if (i === 0) firstTaken = true;
    };
    if (i < start) {
      rest.push(p);
      continue;
    }
    // Packs: "Series Books 1-5", "The Expanse - Complete Series", "... Collection".
    const range = PACK_RANGE.exec(p);
    if (range && (range[1]!.trim() || /book|vol|#/i.test(p) || prevMiddle)) {
      acc.isPack = true;
      acc.series ??= cleanField(range[1]!) || (prevMiddle && rest.length - 1 >= start ? (rest.pop() ?? null) : null);
      acc.position ??= normPosition(`${range[2]}-${range[3]}`);
      take();
      continue;
    }
    const complete = COMPLETE_SERIES.exec(p);
    if (complete) {
      acc.isPack = true;
      const name = cleanField(p.replace(COMPLETE_SERIES, (_m, inner?: string) => ` ${inner ?? ''} `));
      if (name) acc.series ??= name;
      else if (prevMiddle && rest.length - 1 >= start) acc.series ??= rest.pop()!;
      take();
      continue;
    }
    if (COLLECTION.test(p)) {
      acc.isPack = true;
      rest.push(p);
      continue;
    }
    // "Series Book 3: Title".
    const seriesTitled = re(String.raw`^(.+?)[\s,]+(?:${BOOK_WORD}|#\s*)(${NUM})\s*[:.]\s+(.+)$`).exec(p);
    if (seriesTitled && i > 0) {
      acc.series ??= cleanField(seriesTitled[1]!);
      acc.position ??= normPosition(seriesTitled[2]!);
      rest.push(cleanField(seriesTitled[3]!));
      continue;
    }
    const titled = POSITION_TITLE.exec(p);
    if (titled) {
      acc.position ??= normPosition(titled[1]!);
      if (prevMiddle && rest.length - 1 >= start) acc.series ??= rest.pop()!;
      rest.push(cleanField(titled[2]!));
      continue;
    }
    const only = POSITION_ONLY.exec(p);
    if (only || (/^\d{1,3}(?:\.\d{1,2})?$/.test(p) && !isLast)) {
      acc.position ??= normPosition(only ? only[1]! : p);
      if (prevMiddle && rest.length - 1 >= start) acc.series ??= rest.pop()!;
      take();
      continue;
    }
    const keyword = SERIES_KEYWORD.exec(p);
    if (keyword && (i > 0 || !isLast)) {
      acc.series ??= cleanField(keyword[1]!);
      acc.position ??= normPosition(keyword[2]!);
      take();
      continue;
    }
    const bare = SERIES_BARE.exec(p);
    if (bare && !isLast && i > 0 && !/(?:^|\s)(?:part|cd|disc|disk|track)$/i.test(bare[1]!)) {
      acc.series ??= cleanField(bare[1]!);
      acc.position ??= normPosition(bare[2]!);
      continue;
    }
    rest.push(p);
  }
  return { rest, firstTaken };
}

function narratorPart(text: string): string[] | null {
  const m = NARRATOR_PREFIX.exec(text);
  if (m && /^(?:read|narrated|performed|voiced|told|narr|nar|narrator|reader|sprecher|gelesen|lu|leído|letto)/i.test(text)) return splitPeople(m[1]!);
  return null;
}

function assignFields(partsIn: string[], acc: Acc): Fields {
  // Narrator fields: "Author - Title - Read by X".
  const parts: string[] = [];
  for (const p of partsIn) {
    const n = narratorPart(p);
    if (n) acc.narrators.push(...n);
    else parts.push(p);
  }
  if (parts.length === 0) return { authors: [], title: null, subtitle: null };

  const { rest, firstTaken } = takeSeriesParts(parts, acc, parts.length >= 2);
  let author: string | null = null;
  let others: string[];
  if (parts.length >= 2 && !firstTaken) {
    author = rest[0] ?? null;
    others = rest.slice(1);
  } else {
    others = rest;
  }

  let title: string | null = null;
  let subtitle: string | null = null;
  const addNarrators = (text: string) => acc.narrators.push(...splitPeople(text));

  if (author === null && acc.authorHint) {
    author = acc.authorHint;
    title = others[0] ?? null;
    if (others.length > 1) subtitle = others.slice(1).join(' - ');
  } else if (author === null) {
    title = others[0] ?? null;
    if (others.length > 1) subtitle = others.slice(1).join(' - ');
    // "Title by Author".
    const by = title ? /^(.+?)\s+by\s+(.+)$/i.exec(title) : null;
    if (by && personScore(by[2]!) > 0) {
      title = by[1]!;
      author = by[2]!;
    }
  } else if (others.length === 0) {
    // "Author - Series 03" or a pack: nothing left for the title.
    if (!acc.series && !acc.isPack) {
      title = author;
      author = null;
    }
  } else if (others.length === 1) {
    title = others[0]!;
    // "The Hobbit - J. R. R. Tolkien": a title first, a name second.
    if (personScore(author) === 0 && personScore(title) === 2) [author, title] = [title, author];
  } else {
    const [b, c] = [others[0]!, others[others.length - 1]!];
    const sa = personScore(author);
    const sb = personScore(b);
    const sc = personScore(c);
    if (others.length === 2 && ((sa === 0 && sb > 0) || (sa < 2 && sb === 2)) && sc > 0 && acc.narrators.length === 0) {
      // "Title - Author - Narrator".
      title = author;
      author = b;
      addNarrators(c);
    } else if (sc > 0 && acc.narrators.length === 0 && /\s/.test(c)) {
      title = b;
      if (others.length > 2) subtitle = others.slice(1, -1).join(' - ');
      addNarrators(c);
    } else {
      title = b;
      subtitle = others.slice(1).join(' - ');
    }
  }

  if (title) {
    title = cleanField(title);
    // "Title: Subtitle".
    const colon = /^(.+?)\s*:\s+(.+)$/.exec(title);
    if (colon && subtitle === null) {
      title = colon[1]!;
      subtitle = colon[2]!;
    }
    // "Title, Book 3" / "Title (no bracket) Book 3" left inside the title.
    const trailing = re(String.raw`^(.+?)[\s,]+(?:${BOOK_WORD}|#\s*)(${NUM})$`).exec(title);
    if (trailing && acc.position === null) {
      title = trailing[1]!;
      acc.position = normPosition(trailing[2]!);
    }
    // A trailing narrator phrase that the field split did not catch.
    const phrase = NARRATOR_PHRASE.exec(title);
    if (phrase) {
      addNarrators(phrase[1]!);
      title = cleanField(title.slice(0, phrase.index));
    }
  }
  if (subtitle) subtitle = cleanField(subtitle) || null;
  // "Author - Ember Road (Books 1-3)": a pack range with no name of its own names the title's series.
  if (acc.isPack && acc.series === null && acc.position?.includes('-') && title) {
    acc.series = title;
    title = null;
  }
  const authors = author ? splitPeople(cleanField(author)) : [];
  return { authors, title: title || null, subtitle };
}

// ---------------------------------------------------------------------------------------
// Scene names

function sceneWords(field: string): string {
  return field.replace(/_/g, ' ').replace(/(?<!\d)\.(?!\d)|\.(?=\D)|(?<=\D)\./g, ' ').replace(/\s+/g, ' ').trim();
}

const SCENE_MARK = /^(?:AUDIOBOOK|AUDIOBOOKS|ABOOK|HOERBUCH|HÖRBUCH|MP3|M4B|M4A|AAC|FLAC|WEB|WEBRIP|UNABRIDGED|ABRIDGED|RETAIL|(?:19|20)\d{2})$/i;

function looksScene(name: string): boolean {
  if (/\s/.test(name) || /[[\]{}]/.test(name) || /\.-\.|_-_/.test(name)) return false;
  const fields = name.split('-').filter(Boolean);
  return fields.length >= 4 && fields.slice(2).some((f) => SCENE_MARK.test(f));
}

function parseScene(name: string, acc: Acc): string[] {
  const fields = name.split('-').filter(Boolean);
  acc.group = fields.pop() ?? null;
  let end = fields.length;
  for (let i = fields.length - 1; i >= 2; i--) {
    const words = sceneWords(fields[i]!);
    const tags = classifyTags(words, { bracket: false });
    if (!tags) break;
    applyTags(acc, tags);
    end = i;
  }
  return fields.slice(0, end).map(sceneWords).filter(Boolean);
}

// ---------------------------------------------------------------------------------------
// Audio → audiobook quality

/**
 * Map audio facts to an audiobook quality:
 * - MP3 by bitrate: < 64 AB-MP3-Low, 64-127 AB-MP3, ≥ 128 AB-MP3-High (a VBR preset counts
 *   as its nominal rate). No bitrate → AB-MP3, the usual audiobook rate.
 * - AAC (m4a / m4b): < 64 AB-AAC-Low, else AB-AAC. No bitrate → AB-AAC.
 * - Opus → AB-Opus. FLAC, ALAC, WAV, AIFF, APE, WavPack → AB-Lossless.
 * - Vorbis, DSD, Unknown → Unknown.
 */
export function audiobookQualityFor(facts: { codec: AudioCodec; bitrateKbps: number | null; vbrPreset?: AudioVbrPreset | null }): QualityDefinition {
  const nominal: Record<AudioVbrPreset, number> = { V0: 245, V1: 225, V2: 190, APS: 190, APX: 245 };
  const kbps = facts.bitrateKbps ?? (facts.vbrPreset ? nominal[facts.vbrPreset] : null);
  switch (facts.codec) {
    case 'MP3':
      if (kbps === null) return QUALITIES['AB-MP3'];
      if (kbps < 64) return QUALITIES['AB-MP3-Low'];
      if (kbps < 128) return QUALITIES['AB-MP3'];
      return QUALITIES['AB-MP3-High'];
    case 'AAC':
      return kbps !== null && kbps < 64 ? QUALITIES['AB-AAC-Low'] : QUALITIES['AB-AAC'];
    case 'Opus':
      return QUALITIES['AB-Opus'];
    case 'FLAC':
    case 'ALAC':
    case 'WAV':
    case 'AIFF':
    case 'APE':
    case 'WavPack':
      return QUALITIES['AB-Lossless'];
    default:
      return QUALITIES.Unknown;
  }
}

function audioOf(acc: Acc, name: string, extension: string | null): ParsedAudioQuality {
  const techText = acc.tech.join(' ');
  const facts = readAudioFacts(techText ? `[${techText}]` : '');
  const extContainer = extension ? (CONTAINER_OF[extension] ?? null) : null;
  if (extContainer) acc.container = extContainer;
  let codec: AudioCodec = facts.codec;
  if (acc.container !== 'unknown') {
    const fromContainer = CODEC_OF_CONTAINER[acc.container];
    // ".m4b" holds AAC; "ALAC" in the name settles a lossless m4a/m4b.
    codec = (acc.container === 'm4a' || acc.container === 'm4b') && facts.codec === 'ALAC' ? 'ALAC' : fromContainer;
  } else if (extension === 'ogg' || extension === 'oga') {
    codec = 'Vorbis';
  } else if (extension === 'wav') {
    codec = 'WAV';
  } else if (codec === 'MP3') {
    acc.container = 'mp3';
  } else if (codec === 'FLAC') {
    acc.container = 'flac';
  } else if (codec === 'Opus') {
    acc.container = 'opus';
  }
  const lossy = codec === 'MP3' || codec === 'AAC' || codec === 'Opus' || codec === 'Vorbis';
  const bitrateKbps = lossy ? facts.bitrateKbps : null;
  const vbrPreset = codec === 'MP3' ? facts.vbrPreset : null;
  const stated = facts.stated || acc.container !== 'unknown';
  const fromName = facts.stated || (acc.container !== 'unknown' && !extContainer);
  return {
    codec,
    bitrateKbps,
    vbrPreset,
    bitDepth: lossy ? null : facts.bitDepth,
    sampleRateHz: facts.sampleRateHz,
    quality: audiobookQualityFor({ codec, bitrateKbps, vbrPreset }),
    revision: parseRevision(name),
    detectionSource: fromName ? 'name' : stated || extContainer ? 'extension' : 'unknown',
  };
}

// ---------------------------------------------------------------------------------------
// Entry points

function normalizeSeparators(name: string): string {
  if (/\s/.test(name)) return name;
  if (/_/.test(name)) return name.replace(/_/g, ' ');
  // "Andy.Weir.-.The.Martian.2014.MP3-GRP": dots as spaces, except inside numbers ("2.5").
  if ((name.match(/\./g) ?? []).length >= 2) return name.replace(/(?<!\d)\.|\.(?!\d)/g, ' ');
  return name;
}

/**
 * Parse an audiobook release name ("Author - Title (Unabridged) [m4b]",
 * "Author - [Series #3] - Title (2015) 64kbps", "Author_Name-Title-AUDIOBOOK-WEB-EN-2019-GRP").
 */
export function parseAudiobookRelease(raw: string): ParsedAudiobookRelease {
  const { title: noExt, extension } = stripAudiobookExtension(raw.trim());
  const releaseTitle = prepare(noExt);
  const releaseHash = parseReleaseHash(releaseTitle);
  const acc = emptyAcc();
  const scene = looksScene(releaseTitle);

  let parts: string[];
  if (scene) {
    parts = parseScene(takeIds(releaseTitle, acc), acc);
  } else {
    let text = normalizeSeparators(releaseTitle);
    text = takeIds(text, acc);
    text = extractBrackets(text, acc);
    text = peelTrailing(text, acc);
    // "Title, read by X & Y" outside brackets.
    const phrase = NARRATOR_PHRASE.exec(text);
    if (phrase && phrase.index > 0) {
      acc.narrators.push(...splitPeople(phrase[1]!));
      text = text.slice(0, phrase.index) + text.slice(phrase.index + phrase[0].length);
      text = peelTrailing(text, acc);
    }
    parts = text.split(DASH_SPLIT).map(cleanField).filter(Boolean);
    // Fields that are only tags or only a year: "Author - Title - Unabridged - 2015".
    parts = parts.filter((p, i) => {
      if (i === 0) return true;
      const tags = classifyTags(p, { bracket: false });
      if (tags && !/^(?:19|20)\d{2}$/.test(p)) {
        applyTags(acc, tags);
        return false;
      }
      return true;
    });
    const yearIdx = parts.findIndex((p) => /^(?:19|20)\d{2}$/.test(p));
    if (yearIdx >= 0 && parts.length >= 3) {
      acc.year ??= Number(parts[yearIdx]);
      parts.splice(yearIdx, 1);
    }
  }

  const fields = assignFields(parts, acc);
  const audio = audioOf(acc, releaseTitle, extension);
  const narrators = [...new Set(acc.narrators.map(cleanField).filter(Boolean))];
  const info: ParsedAudiobookInfo = {
    authors: fields.authors,
    title: fields.title,
    subtitle: fields.subtitle,
    series: acc.series ? cleanField(acc.series) : null,
    seriesPosition: acc.position,
    narrators,
    year: acc.year,
    formatType: acc.formatType,
    container: acc.container,
    bitrateKbps: audio.bitrateKbps,
    asin: acc.asin,
    isbn: acc.isbn,
    isPack: acc.isPack,
    language: acc.language,
    retail: acc.retail,
    chapterized: acc.chapterized,
    fileLayout: acc.layout,
    scene,
    audio,
  };
  const empty = info.authors.length === 0 && !info.title && !info.series && !info.isPack;
  return { releaseTitle, releaseGroup: acc.group, releaseHash, audio, audiobook: empty ? null : info };
}

// ---------------------------------------------------------------------------------------
// Paths (Audiobookshelf layouts)

/** "CD1", "Disc 2", "Part 03": a folder that only splits one book. */
const PART_FOLDER = /^(?:CD|Disc|Disk|Part|Teil|Side)[-_. ]?\d{1,3}(?:\s*[-:]\s*.*)?$/i;
/** "01 - Chapter One", "Chapter 05", "Track 3", "Part 1", "001": one file of a multi-file book. */
const CHAPTER_FILE = /^(?:\d{1,4}(?:[\s._-]|$)|(?:Chapter|Chap|Ch|Track|Part|Disc|CD|Kapitel|Teil)[\s._-]*\d)/i;
/** Folders above the library: never an author. */
const ROOT_FOLDER = /^(?:audiobooks?|audio[\s_-]?books?|books|h[öo]rb[üu]cher|media|data|library|libraries|downloads?|completed?|mnt|volume\d*|volumes|share|shares|home|users?|srv|storage|nas|disk\d*|torrents?|usenet|incoming|public)$/i;

/**
 * An Audiobookshelf book folder: "Book 1 - Title", "1 - Title", "1. Title", "Vol 2.5 - Title",
 * "2015 - Book 1 - Title - Subtitle {Narrator}", "Title (2015)".
 */
function parseBookFolder(name: string): { info: ParsedAudiobookRelease; title: string | null; subtitle: string | null; position: string | null; year: number | null } {
  const acc = emptyAcc();
  let text = takeIds(normalizeSeparators(prepare(name)), acc);
  text = extractBrackets(text, acc);
  text = peelTrailing(text, acc);
  let parts = text.split(DASH_SPLIT).map(cleanField).filter(Boolean);
  if (parts.length > 1 && /^(?:19|20)\d{2}$/.test(parts[0]!)) acc.year ??= Number(parts.shift());
  // "Book 1 - Title", "1 - Title", "1. Title", "Vol 2.5 - Title".
  const lead = /^(?:(?:Book|Bk|Vol(?:ume)?|#)\.?\s*)?(\d{1,3}(?:\.\d{1,2})?)(?:\s*[-–.:)]\s*|\s+)(.+)$/i.exec(parts.join(' - '));
  if (lead && !/^(?:19|20)\d{2}$/.test(lead[1]!)) {
    acc.position ??= normPosition(lead[1]!);
    parts = lead[2]!.split(DASH_SPLIT).map(cleanField).filter(Boolean);
  }
  let title = parts[0] ? cleanField(parts[0]) : null;
  let subtitle = parts.length > 1 ? parts.slice(1).join(' - ') : null;
  const colon = title ? /^(.+?)\s*:\s+(.+)$/.exec(title) : null;
  if (colon && subtitle === null) {
    title = colon[1]!;
    subtitle = colon[2]!;
  }
  const audio = audioOf(acc, name, null);
  const info: ParsedAudiobookInfo = {
    authors: [],
    title,
    subtitle,
    series: acc.series,
    seriesPosition: acc.position,
    narrators: [...new Set(acc.narrators)],
    year: acc.year,
    formatType: acc.formatType,
    container: acc.container,
    bitrateKbps: audio.bitrateKbps,
    asin: acc.asin,
    isbn: acc.isbn,
    isPack: acc.isPack,
    language: acc.language,
    retail: acc.retail,
    chapterized: acc.chapterized,
    fileLayout: acc.layout,
    scene: false,
    audio,
  };
  return { info: { releaseTitle: name, releaseGroup: acc.group, releaseHash: null, audio, audiobook: info }, title, subtitle, position: acc.position, year: acc.year };
}

/** The name of an author folder, unless it is a library root. */
function authorFolder(name: string | undefined): string | null {
  if (!name || ROOT_FOLDER.test(name.trim())) return null;
  return cleanField(name);
}

/**
 * Parse an audiobook file path. Layouts:
 *   Author/Title/file.m4b                       Audiobookshelf, no series
 *   Author/Series/Book 3 - Title/01.mp3         Audiobookshelf, numbered book in a series
 *   Author/Title/CD 1/01 - Chapter.mp3          part folders are stepped over
 *   Downloads/Author - Title (2015) [m4b]/x.m4b  a release-named folder
 *   Author - Title.m4b                          a release-named file
 * The file's extension sets the container; the folder name fills in what the file does not say.
 */
export function parseAudiobookPath(path: string): ParsedAudiobookRelease {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const fileName = parts[parts.length - 1] ?? path;
  const folders = parts.slice(0, -1).filter((p) => !/^[a-z]:$/i.test(p));
  const { title: base, extension } = stripAudiobookExtension(fileName);

  let i = folders.length - 1;
  while (i >= 0 && PART_FOLDER.test(folders[i]!.trim())) i--;
  const bookFolder = i >= 0 ? folders[i]! : null;
  const file = parseAudiobookRelease(fileName);
  const isChapterFile = CHAPTER_FILE.test(base.trim());

  // A release-named file ("Author - Title.m4b") stands on its own.
  if (!bookFolder || (!isChapterFile && file.audiobook && file.audiobook.authors.length > 0)) {
    if (file.audiobook && bookFolder && file.audiobook.authors.length > 0) {
      const folder = parseAudiobookRelease(bookFolder).audiobook;
      if (folder) {
        const f = file.audiobook;
        f.year ??= folder.year;
        f.narrators = f.narrators.length ? f.narrators : folder.narrators;
        if (f.formatType === 'unknown') f.formatType = folder.formatType;
        f.asin ??= folder.asin;
      }
    }
    return file;
  }

  const parent = i >= 1 ? folders[i - 1] : undefined;
  const grandparent = i >= 2 ? folders[i - 2] : undefined;
  const asRelease = parseAudiobookRelease(bookFolder);
  const folderBook = parseBookFolder(bookFolder);
  const parentAuthor = authorFolder(parent);
  // "Author - Title (2015) [m4b]" as the folder: a release name, unless its first field is a
  // number ("1 - Title") or the folder above already names the author and the folder does not
  // repeat it ("Andy Weir/Project Hail Mary - A Novel").
  const firstField = bookFolder.split(DASH_SPLIT)[0]!.trim();
  const releaseShaped =
    asRelease.audiobook !== null &&
    asRelease.audiobook.authors.length > 0 &&
    folderBook.position === null &&
    (parentAuthor === null || firstField.toLowerCase() === parentAuthor.toLowerCase() || authorFolder(grandparent) === null && personScore(firstField) === 2);

  let result: ParsedAudiobookRelease;
  if (releaseShaped) {
    result = asRelease;
  } else {
    result = folderBook.info;
    const book = result.audiobook!;
    if (folderBook.position !== null && parentAuthor) {
      // Author/Series/Book N - Title
      book.series ??= parentAuthor;
      const author = authorFolder(grandparent);
      if (author) book.authors = splitPeople(author);
    } else if (parentAuthor) {
      // Author/Title, or Author/Series/Title when the grandparent is a real folder too and
      // the parent is not a person's name.
      const author = authorFolder(grandparent);
      if (author && personScore(parentAuthor) === 0 && personScore(author) > 0) {
        book.series ??= parentAuthor;
        book.authors = splitPeople(author);
      } else {
        book.authors = splitPeople(parentAuthor);
      }
    }
  }

  // Audio: the file's extension and name win, the folder fills in the bitrate.
  const book = result.audiobook;
  const container = extension ? (CONTAINER_OF[extension] ?? null) : null;
  if (book) {
    const fileInfo = file.audiobook;
    const acc = emptyAcc();
    acc.container = container ?? (fileInfo && fileInfo.container !== 'unknown' ? fileInfo.container : book.container);
    if (fileInfo?.audio.bitrateKbps ?? book.audio.bitrateKbps) acc.tech.push(`${fileInfo?.audio.bitrateKbps ?? book.audio.bitrateKbps}kbps`);
    const vbr = fileInfo?.audio.vbrPreset ?? book.audio.vbrPreset;
    if (vbr) acc.tech.push(vbr);
    const audio = audioOf(acc, fileName, extension);
    audio.detectionSource = fileInfo?.audio.detectionSource === 'name' || book.audio.detectionSource === 'name' ? 'name' : audio.detectionSource;
    book.audio = audio;
    book.container = acc.container;
    book.bitrateKbps = audio.bitrateKbps;
    if (fileInfo) {
      if (book.formatType === 'unknown') book.formatType = fileInfo.formatType;
      if (book.narrators.length === 0 && !isChapterFile) book.narrators = fileInfo.narrators;
      book.chapterized ||= fileInfo.chapterized;
    }
    return { ...result, audio, releaseGroup: result.releaseGroup ?? file.releaseGroup };
  }
  return result;
}

// ---------------------------------------------------------------------------------------
// Bridges to the profiles engine

/**
 * The file layout a release most likely has: the file count when known, else what the name
 * states ("single file"), else the container (an m4b is one file per book; mp3 and flac
 * books come as one file per chapter or part). Null when nothing tells.
 */
export function audiobookFileLayout(info: Pick<ParsedAudiobookInfo, 'container' | 'fileLayout'>, fileCount?: number): AudioFileLayout | null {
  if (fileCount !== undefined && fileCount > 0) return fileCount === 1 ? 'single' : 'multi';
  if (info.fileLayout) return info.fileLayout;
  if (info.container === 'm4b') return 'single';
  if (info.container === 'mp3' || info.container === 'flac') return 'multi';
  return null;
}

/** The `ReleaseEvaluation.audio` block for a parsed audiobook release. */
export function audiobookAudioEvaluation(info: ParsedAudiobookInfo, options: { fileCount?: number } = {}): ReleaseAudioEvaluation {
  const a = info.audio;
  const layout = audiobookFileLayout(info, options.fileCount);
  return {
    codec: a.codec,
    ...(a.bitrateKbps !== null ? { bitrateKbps: a.bitrateKbps } : {}),
    ...(a.vbrPreset !== null ? { vbrPreset: a.vbrPreset } : {}),
    ...(a.bitDepth !== null ? { bitDepth: a.bitDepth } : {}),
    ...(a.sampleRateHz !== null ? { sampleRateHz: a.sampleRateHz } : {}),
    hasLog: false,
    hasCue: false,
    ...(layout ? { fileLayout: layout } : {}),
    ...(info.formatType !== 'unknown' ? { formatType: info.formatType } : {}),
    ...(info.narrators.length > 0 ? { narrators: [...info.narrators] } : {}),
  };
}

/** The `ReleaseEvaluation.releaseKind` of a parsed audiobook release. */
export function audiobookReleaseKind(info: Pick<ParsedAudiobookInfo, 'isPack'>): ReleaseKind {
  return info.isPack ? 'bookPack' : 'single';
}

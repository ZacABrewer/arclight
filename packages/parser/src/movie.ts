import { spaced } from './normalize.js';
import type { ParsedMovieInfo } from './types.js';

// Movie titles: "Title (Year) ..." or "Title.Year.Quality..." with an optional edition.
//
// The year is the anchor: everything before it is title (minus edition words and trailing
// language tags), everything after it is edition + tags. Names with no year are accepted
// when they carry clear release tags or an edition, or when they are fansub releases
// ("[Group] Title (BD 1080p)").

const IMDB_ID = /(?<![a-z0-9])(?<imdb>tt\d{7,8})(?![a-z0-9])/i;
const TMDB_ID = /(?<![a-z0-9])(?:tmdb(?:id)?[-_. ]?(?<tmdb>\d{1,8}))(?![a-z0-9])/i;

const YEAR_TOKEN = /(?<![\d])(?<year>18[89]\d|19\d{2}|20\d{2})(?![\d])/g;

/** Words that only ever appear in the technical tail; the title stops before the first one. */
const HARD_TAG =
  /(?<![a-z0-9])(?:2160p|1080[pi]|720p|576p|480p|4k|uhd|blu-?ray|bdrip|brrip|bdremux|remux|web-?dl|web-?rip|webrip|hdtv|hdrip|dvdrip|dvdr|dvdscr|dvd|x26[45]|h\.?26[45]|hevc|avc|xvid|divx|aac|ac3d?|dts(?:-?hd)?|truehd|atmos|truefrench|vostfr|multisubs?|dl|dubbed|subbed|pal|ntsc|ts|hdcam|hdts|cam|r5|ld|md|hq|hdr|10bit)(?![a-z0-9])/i;
/** Language words that end a title when other tags follow them. */
const LANGUAGE_WORD =
  /^(?:german|french|truefrench|italian|spanish|dutch|english|swedish|danish|norwegian|finnish|polish|russian|japanese|korean|chinese|hindi|nordic|multi|vostfr|ita|eng|ger|fre|spa)$/i;
const ARTICLES: Record<string, RegExp> = {
  german: /^(?:der|die|das|des|dem|den|ein|eine|einer)$/i,
  french: /^(?:le|la|les|un|une|du|des)$/i,
};

// Words that, together, make up an edition tag.
const EDITION_WORDS = new Set([
  'director', 'directors', "director's", 'director`s', 'cut', 'extended', 'unrated', 'uncut', 'remastered', 'remaster',
  'restored', 'special', 'edition', 'theatrical', 'ultimate', 'final', 'collectors', "collector's", 'collector',
  'anniversary', 'imax', 'criterion', 'despecialized', 'fan', 'edit', 'fanedit', 'redux', 'limited', 'deluxe',
  'definitive', 'uncensored', 'open', 'matte', 'version', 'alternate', 'alternative', 'international', 'original',
  'assembly', 'recut', 're-cut', 'reconstructed', 'exclusive', 'colorized', 'colourized', 'signature', 'diamond',
  'platinum', 'gold', 'legacy', 'hunter', 'rekall', 'imperial', 'premium', 'super', 'duper', 'extreme',
]);
const STRONG_EDITION =
  /^(?:cut|edition|extended|unrated|uncut|remaster(?:ed)?|restored|theatrical|imax|criterion|despecialized|redux|version|edit|fanedit|anniversary|director'?s?|director`s|collector'?s?|ultimate|final|definitive|uncensored|matte|alternate|alternative|recut|colorized|colourized|international|\d+in1)$/i;
const ORDINAL = /^\d{1,3}(?:th|st|nd|rd)$/i;
const ABBREVIATION = /^(?:Dr|Mr|Mrs|Ms|St|Jr|Sr)$/;

/**
 * Normalise a raw IMDb id ("123", "tt1234567", "12345678") to "tt" + at least 7 digits.
 * Returns null when the input is not a plausible id.
 */
export function normalizeImdbId(raw: string): string | null {
  const m = /^\s*(?:tt)?(\d{1,8})\s*$/i.exec(raw);
  if (!m) return null;
  const digits = m[1]!;
  if (Number(digits) === 0) return null;
  return `tt${digits.padStart(7, '0')}`;
}

function words(text: string): string[] {
  return spaced(text.replace(/[()[\]]/g, ' ')).split(' ').filter(Boolean);
}

function editionFrom(ws: string[], afterYear: boolean): string | null {
  if (ws.length === 0) return null;
  // "Diamond Edition", "The Imperial Edition", "Ultimate Hunter Edition" after the year.
  if (afterYear && ws.length <= 4 && /^edition$/i.test(ws[ws.length - 1]!) && ws.length >= 2) {
    const body = /^the$/i.test(ws[0]!) ? ws.slice(1) : ws;
    if (body.length >= 2) return body.join(' ');
  }
  const ok = ws.every((w) => EDITION_WORDS.has(w.toLowerCase()) || ORDINAL.test(w) || /^\d+in1$/i.test(w));
  if (!ok) return null;
  if (!ws.some((w) => STRONG_EDITION.test(w) || ORDINAL.test(w))) return null;
  // A bare "Edition"/"Cut" is a title word ("The Christmas Edition"), not an edition.
  if (ws.length === 1 && /^(?:edition|cut|final|version|edit)$/i.test(ws[0]!)) return null;
  return ws.join(' ');
}

/** Longest edition run at the start of the text after the year. */
function leadingEdition(segment: string): string | null {
  const ws = words(segment);
  for (let end = Math.min(ws.length, 6); end >= 1; end--) {
    const e = editionFrom(ws.slice(0, end), true);
    if (e) return e;
  }
  return null;
}

/** Title with dotted acronyms kept ("R.I.P.D.", "L.A.", "Dr. Dolittle"), separators as spaces. */
function formatTitle(raw: string): string {
  const t = raw.trim();
  if (/\s/.test(t) || !t.includes('.')) return spaced(t).replace(/\s*[-–]+$/, '').trim();
  const tokens = t.split(/[._]+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (/^[A-Z]$/.test(tok) && /^[A-Z]$/.test(tokens[i + 1] ?? '')) {
      let acro = '';
      while (i < tokens.length && /^[A-Z]$/.test(tokens[i]!)) acro += `${tokens[i++]}.`;
      i--;
      out.push(acro);
    } else if (ABBREVIATION.test(tok) && i < tokens.length - 1) {
      out.push(`${tok}.`);
    } else {
      out.push(tok);
    }
  }
  return out.join(' ').replace(/\s*[-–]+$/, '').trim();
}

interface TitleSplit {
  title: string;
  edition: string | null;
}

/** Split the text before the year into title and edition, dropping trailing language tags. */
function splitTitle(part: string, cutAtTags: boolean): TitleSplit {
  let text = part.replace(/[\s._\-([]+$/, '');
  let followedByTags = false;
  if (cutAtTags) {
    const tag = HARD_TAG.exec(text);
    if (tag && text.slice(0, tag.index).replace(/[\s._\-([]+$/, '')) {
      text = text.slice(0, tag.index).replace(/[\s._\-([]+$/, '');
      followedByTags = true;
    }
  }

  // Parenthesised edition at the end: "Movie Title (Despecialized)"
  let edition: string | null = null;
  const paren = /[\s._]*\(([^)]+)\)$/.exec(text);
  if (paren) {
    const e = editionFrom(words(paren[1]!), false);
    if (e) {
      edition = e;
      text = text.slice(0, paren.index);
    }
  }

  const sep = /\s/.test(text) ? ' ' : '.';
  let ws = text.split(/[\s._]+/).filter(Boolean);
  const stripLanguage = (allow: boolean) => {
    // Uppercase language-code runs ("ENG-FRE-ITA") are always tags.
    while (ws.length > 1 && /^(?:[A-Z]{2,3}-)+[A-Z]{2,3}$/.test(ws[ws.length - 1]!)) ws = ws.slice(0, -1);
    while (ws.length > 1 && LANGUAGE_WORD.test(ws[ws.length - 1]!)) {
      const lang = ws[ws.length - 1]!.toLowerCase();
      const article = ARTICLES[lang];
      const sameLanguageTitle = article ? ws.slice(0, -1).some((w) => article.test(w)) : false;
      const alwaysTag = /^(?:truefrench|vostfr|multi)$/i.test(lang) || ws[ws.length - 1] === ws[ws.length - 1]!.toUpperCase();
      if (!(allow || sameLanguageTitle || alwaysTag)) break;
      ws = ws.slice(0, -1);
      allow = true;
    }
  };
  stripLanguage(followedByTags);

  if (!edition) {
    for (let start = 1; start < ws.length; start++) {
      const e = editionFrom(ws.slice(start), false);
      if (e) {
        edition = e;
        ws = ws.slice(0, start);
        // Language before an edition is a tag too: "My.Movie.GERMAN.Extended.Cut"
        stripLanguage(true);
        break;
      }
    }
  }
  const rebuilt = ws.join(sep) + (sep === '.' && /\.$/.test(text) ? '.' : '');
  return { title: formatTitle(sep === '.' ? rebuilt : ws.join(' ')), edition };
}

export function parseMovie(releaseTitle: string): ParsedMovieInfo | null {
  let text = releaseTitle.trim();
  const imdbId = IMDB_ID.exec(text)?.groups?.['imdb']?.toLowerCase() ?? null;
  const tmdbMatch = TMDB_ID.exec(text);
  const tmdbId = tmdbMatch?.groups?.['tmdb'] ? Number(tmdbMatch.groups['tmdb']) : null;
  text = text.replace(IMDB_ID, ' ').replace(TMDB_ID, ' ').trim();

  // Episode numbering means this is not a movie.
  if (/(?:^|[-_. (\[])S\d{1,2}[-_. ]?E\d{1,3}(?![a-z])/i.test(text)) return null;

  let fansub = false;
  const group = /^\[[^\]]*\][-_. ]*/.exec(text);
  if (group && group[0].length < text.length) {
    text = text.slice(group[0].length);
    fansub = true;
  }

  // Year first: "(1995) Movie Name"
  const yearFirst = /^\((18[89]\d|19\d{2}|20\d{2})\)[-_. ]+(.+)$/.exec(text);
  if (yearFirst) {
    const split = splitTitle(yearFirst[2]!, true);
    return { title: split.title, titleWithoutYear: split.title, year: Number(yearFirst[1]), edition: split.edition, imdbId, tmdbId };
  }

  // Candidate years: something before them, a boundary after them.
  const candidates = [...text.matchAll(YEAR_TOKEN)].filter((y) => {
    const before = text.slice(0, y.index).replace(/[\s._\-([]+$/, '');
    if (!before || /^\(?$/.test(before)) return false;
    const after = text.slice(y.index! + 4);
    return after === '' || /^[)\]]/.test(after) || /^[-_. ]/.test(after);
  });
  // Prefer the last year whose title part is clean; otherwise the last year at all.
  let yearMatch: RegExpMatchArray | null = null;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const y = candidates[i]!;
    if (!HARD_TAG.test(text.slice(0, y.index))) {
      yearMatch = y;
      break;
    }
  }
  yearMatch ??= candidates[candidates.length - 1] ?? null;

  let split: TitleSplit;
  let year = 0;
  let edition: string | null = null;

  if (yearMatch) {
    year = Number(yearMatch.groups!['year']);
    split = splitTitle(text.slice(0, yearMatch.index!), true);
    edition = split.edition;
    if (!edition) {
      let after = text.slice(yearMatch.index! + 4).replace(/^[)\]]/, '');
      const tag = HARD_TAG.exec(after);
      const lang = /(?<![a-z])(?:german|french|nordic|multi|italian|spanish)(?![a-z])/i.exec(after);
      const stop = Math.min(tag?.index ?? Infinity, lang?.index ?? Infinity);
      if (Number.isFinite(stop)) after = after.slice(0, stop);
      edition = leadingEdition(after);
    }
    // "Movie Title.2012.(Extended.Theatrical.Version.IMAX).BluRay..."
    if (!edition) {
      const p = /\(([^)]+)\)/.exec(text.slice(yearMatch.index! + 4));
      if (p) edition = editionFrom(words(p[1]!), false);
    }
  } else {
    // No year: fansub layouts end the title at the first bracket; others at the first tag.
    if (fansub) {
      const cut = /[-_. ]*(?:\[|\((?=[^)]*(?:\d{3,4}p|BD|Blu|DVD|WEB|x26|HEVC|FLAC|AAC|\d{3,4}x\d{3,4})))/i.exec(text);
      let title = cut ? text.slice(0, cut.index) : text;
      const versioned = /[-_. ]v\d$/i.test(title);
      title = title.replace(/[-_. ]v\d$/i, '');
      if (!cut && !versioned) return null;
      const t = formatTitle(title);
      if (!t) return null;
      return { title: t, titleWithoutYear: t, year: 0, edition: null, imdbId, tmdbId };
    }
    const hasTag = HARD_TAG.test(text);
    split = splitTitle(text, true);
    if (!hasTag && !split.edition) return null;
    edition = split.edition;
  }

  const title = split.title.replace(/[-–\s]+$/, '').trim();
  if (!title) return null;
  return { title, titleWithoutYear: title, year, edition, imdbId, tmdbId };
}

import type { AudioSourceKind, ReleaseAudioEvaluation, ReleaseKind } from '@arclight/shared';
import { mergeAudioQuality, parseAudioQuality, stripAudioExtension, type ParsedAudioQuality } from './audio-quality.js';
import { parseReleaseHash } from './hash.js';
import { prepare } from './normalize.js';
import { parseAudiobookPath, type ParsedAudiobookRelease } from './audiobook.js';

// Music release names. Two families:
//
//   P2P    Artist - Album (2020) [FLAC 24bit-96kHz]      spaces, " - " between fields, tags in
//          (2020) Artist - Album [V0]                    brackets anywhere, years anywhere
//          Artist - 2020 - Album [WEB FLAC]
//   scene  Artist-Album-(CAT123)-2CD-FLAC-2020-GROUP     no spaces, "-" between fields,
//          VA-Title-WEB-2020-GROUP                       underscores inside a field
//
// Brackets are classified one by one (year, tech, edition, catalog number, disc count,
// release type, featuring, pack range); whatever is not recognised stays part of the title.
// Only the recognised tags ("tech text") are scanned for codec, media, log and cue words,
// so an album called "Digital Love" or "Magnum Opus" keeps its title and is not a WEB/Opus
// release.

export type MusicMedia = 'CD' | 'WEB' | 'Vinyl' | 'SACD' | 'Cassette' | 'DVD' | 'BD' | 'Unknown';
export type MusicReleaseTypeHint = 'EP' | 'Single' | 'Live' | 'Compilation' | 'Soundtrack' | 'Bootleg';
/** `discography`: an artist's catalogue or a span of it; `multiAlbum`: a set of albums. */
export type MusicPackType = 'discography' | 'multiAlbum';

export interface ParsedMusicInfo {
  /** Album artist as written; "Various Artists" for VA releases; null when the name has none. */
  artist: string | null;
  /** Album title without edition, year and tag brackets; null for packs. */
  album: string | null;
  year: number | null;
  isVariousArtists: boolean;
  /** "Deluxe Edition", "2011 Remaster" ... as written. */
  edition: string | null;
  releaseTypeHint: MusicReleaseTypeHint | null;
  isDiscography: boolean;
  packType: MusicPackType | null;
  /** "5 Albums" → 5. */
  albumCount: number | null;
  discographyYears: { start: number; end: number } | null;
  catalogNumber: string | null;
  media: MusicMedia;
  /** Stated disc count ("2CD", "3 Discs"); null when not stated. */
  discCount: number | null;
  /** Credited guests ("feat. X") split out of the artist or album. */
  featuring: string[];
  /** Scene-style name (no spaces, "-" separated). */
  scene: boolean;
  hasLog: boolean;
  logScore: number | null;
  hasCue: boolean;
  audio: ParsedAudioQuality;
}

export interface ParsedMusicRelease {
  /** Name after basic cleanup (extension and website tags removed). */
  releaseTitle: string;
  releaseGroup: string | null;
  releaseHash: string | null;
  audio: ParsedAudioQuality;
  /** Null when neither an artist, an album nor a pack could be read. */
  music: ParsedMusicInfo | null;
}

const L = String.raw`(?<![\p{L}\p{N}])`;
const R = String.raw`(?![\p{L}\p{N}])`;
const re = (src: string, flags = 'iu') => new RegExp(src, flags);

// ---------------------------------------------------------------------------------------
// Vocabulary

const YEAR = /^(?:19|20)\d{2}$/;
const YEAR_RANGE = /(?<!\d)((?:19|20)\d{2})\s?[-–~]\s?((?:19|20)\d{2})(?!\d)/;

/** Words that only describe the files: codecs, rates, sources, rip details. */
const TECH = re(
  String.raw`${L}(?:FLAC(?:\d{2})?|ALAC|MP3|AAC|M4A|OGG|Vorbis|Opus|WAV|AIFF?|APE|WavPack|WV|DSD(?:64|128|256|512)?|DSF|DFF|ISO|PCM|LPCM|LAME|CBR|VBR|V[012]|APS|APX|`
    + String.raw`\d{2,3}[-_ ]?(?:kbps|kbit/?s|kbs|k)|\d{2,3}(?:[.,]\d)?[-_ ]?kHz|(?:16|24|32)[-_ ]?(?:bits?|b)|(?:16|24|32)[-/](?:44(?:[.,]1)?|48|88(?:[.,]2)?|96|176(?:[.,]4)?|192|352(?:[.,]8)?|384)|`
    + String.raw`96|112|128|160|192|224|256|320|Hi[-_ ]?Res|Lossless|Lossy|`
    + String.raw`WEB(?:[-_ ]?(?:DL|FLAC|Rip))?|Digital(?:[-_ ]Media)?|Bandcamp|Qobuz|Tidal|Deezer|iTunes(?:[-_ ]Plus)?|Amazon|Beatport|7digital|HDtracks|Spotify|`
    + String.raw`\d?x?CD(?:A|DA|R|M|S|-?Rip|-?DA)?|SACD(?:-?R)?|Vinyl(?:[-_ ]?Rip)?|\d?LP|VLS|Cassette|Tape|MC|DVD(?:-?A(?:udio)?)?|Blu-?ray|BDA?|SAT|DAB|FM|Cable|Line|Stream|`
    + String.raw`Log|Logs|Cue|Cues|EAC|XLD|Scans?|Artwork|Covers?|Booklet|Retail|Promo|Advance|Explicit|Clean|Tracker|Torrent|PROPER|REPACK|RERIP|iNT|READNFO|DIRFIX|NFOFIX|Scene)${R}`,
  'iu',
);
const TECH_G = new RegExp(TECH.source, 'giu');
/** Tag words safe to peel off the end of a title: never ordinary title words. */
const STRICT_TECH = re(
  String.raw`^(?:FLAC(?:\d{2})?|ALAC|MP3|AAC|M4A|OGG|WAV|AIFF|WavPack|DSD(?:64|128|256|512)?|DSF|LAME|CBR|VBR|V[012]|`
    + String.raw`\d{2,3}[-_]?(?:kbps|kbit/?s|kbs)|\d{2,3}(?:[.,]\d)?[-_]?kHz|(?:16|24|32)[-_]?bits?|(?:16|24|32)[-/](?:44(?:[.,]1)?|48|88(?:[.,]2)?|96|176(?:[.,]4)?|192|352(?:[.,]8)?|384)|`
    + String.raw`Hi[-_]?Res|Lossless|WEB(?:[-_]?(?:DL|FLAC))?|\d?x?CD(?:A|DA|R|-?Rip)?|SACD|Vinyl(?:[-_]?Rip)?|PROPER|REPACK)$`,
  'iu',
);
/** Filler that may sit between tech words: "[WEB, FLAC + Log & Cue]", "Log 100%", "Score: 100". */
const TECH_FILLER_WORDS = /(?<![\p{L}])(?:and|with|rip|ripped|release|score|tracks?|in|from|by|w)(?![\p{L}])/giu;

const EDITION = re(
  String.raw`${L}(?:Super[-_ ]Deluxe|Deluxe|Expanded|Remaster(?:ed)?|Remastering|Remix(?:ed)?|Anniversary|Edition|Ed\.?|Version|Re-?issue|Collector'?s|Special|Limited|Ltd|Bonus(?:[-_ ]Tracks?)?|Legacy|Platinum|Japan(?:ese)?|Mono|Stereo|Definitive|Ultimate|Tour|Extended|Enhanced|Box[-_ ]Set|Mfsl|Mofi|Audiophile|Half[-_ ]Speed|Mastered|Restored)${R}`,
  'iu',
);

const TYPE_WORDS: ReadonlyArray<readonly [MusicReleaseTypeHint, RegExp]> = [
  ['EP', re(String.raw`^(?:EP|E\.P\.)$`)],
  ['Single', re(String.raw`^(?:Single|CDS|CDM|Maxi(?:[-_ ]Single)?|CD[-_ ]?Single|7"|12"[-_ ]Single)$`)],
  ['Live', re(String.raw`^(?:Live|Live[-_ ]Album|Live[-_ ]Recording|Concert)$`)],
  ['Compilation', re(String.raw`^(?:Compilation|Best[-_ ]Of|Greatest[-_ ]Hits|Anthology|Hits)$`)],
  ['Soundtrack', re(String.raw`^(?:OST|O\.S\.T\.?|Soundtrack|Original[-_ ](?:Motion[-_ ]Picture[-_ ]|Game[-_ ]|Television[-_ ]|TV[-_ ]|Video[-_ ]Game[-_ ])?(?:Soundtrack|Score|Cast[-_ ]Recording)|Score|Music[-_ ]From[-_ ]The[-_ ].+|Original[-_ ]Score)$`)],
  ['Bootleg', re(String.raw`^(?:Bootleg|Boot)$`)],
];

const VARIOUS = /^(?:VA|V\.\s?A\.?|Various(?:[-_ ]Artists?)?|Various[-_ ]Performers|Diverse|Varios|Sampler)$/i;
const FEATURING = re(String.raw`\s+(?:feat\.?|ft\.?|featuring)\s+(.+)$`);
const FEATURING_BRACKET = re(String.raw`^(?:feat\.?|ft\.?|featuring)\s+(.+)$`);

const PACK_DISCOGRAPHY = re(String.raw`${L}(?:(?:the\s+)?complete\s+)?(?:discography|discografia|diskografie|discographie)${R}|${L}(?:complete\s+|all\s+)?studio\s+albums${R}|${L}complete\s+albums${R}|${L}albums\s+discography${R}`);
const PACK_MULTI = re(String.raw`${L}(?:(?:the\s+)?albums?\s+collection|(\d{1,3})\s+albums|albums\s+pack|collection\s+of\s+(\d{1,3})\s+albums)${R}`);

const CATALOG = /^(?=[A-Z0-9 .\-~]*\d{2})(?=(?:.*[A-Z]){2})[A-Z][A-Z0-9]{0,7}(?:[- .]?\d{2,7})(?:[-~]\d{1,4})?[A-Z]?$/;
const CATALOG_NUMERIC = /^\d{3,6}[- ]\d{3,6}(?:[- ]\d{1,2})?$/;

const DISC_COUNT = re(String.raw`${L}(\d{1,2})\s?[x×]?\s?(?:CD|CDs|Disc|Discs|Disk|Disks|LP|LPs|SACD)${R}|${L}(\d{1,2})[-_ ]?Disc(?:s)?${R}`);
const DISC_WORD = re(String.raw`${L}(Double|Triple)[-_ ](?:CD|Disc|Album|LP)${R}`);

// ---------------------------------------------------------------------------------------
// Segments

interface Tags {
  year: number | null;
  yearInTech: number | null;
  range: { start: number; end: number } | null;
  edition: string[];
  typeHint: MusicReleaseTypeHint | null;
  catalog: string | null;
  discCount: number | null;
  featuring: string[];
  tech: string[];
  group: string | null;
}

const emptyTags = (): Tags => ({
  year: null,
  yearInTech: null,
  range: null,
  edition: [],
  typeHint: null,
  catalog: null,
  discCount: null,
  featuring: [],
  tech: [],
  group: null,
});

function isTechOnly(text: string): boolean {
  if (!TECH.test(text)) return false;
  const rest = text.replace(TECH_G, ' ').replace(/(?<!\d)(?:19|20)\d{2}(?!\d)/g, ' ').replace(TECH_FILLER_WORDS, ' ');
  return /^[\s\-_,;:+&/|.%()\d#'"!]*$/.test(rest);
}

function hasTech(text: string): boolean {
  return TECH.test(text);
}

function typeHintOf(text: string): MusicReleaseTypeHint | null {
  const t = text.trim();
  for (const [hint, pattern] of TYPE_WORDS) if (pattern.test(t)) return hint;
  return null;
}

function discCountOf(text: string): number | null {
  const m = DISC_COUNT.exec(text);
  if (m) {
    const n = Number(m[1] ?? m[2]);
    if (n >= 1 && n <= 60) return n;
  }
  const w = DISC_WORD.exec(text);
  if (w) return w[1]!.toLowerCase() === 'double' ? 2 : 3;
  return null;
}

/**
 * Classify one bracket's content into `tags`. Returns true when it was recognised (and so is
 * not part of the title).
 */
function classify(inner: string, tags: Tags): boolean {
  const t = inner.trim().replace(/_/g, ' ');
  if (!t) return true;
  if (YEAR.test(t)) {
    tags.year ??= Number(t);
    return true;
  }
  const range = /^((?:19|20)\d{2})\s?[-–~]\s?((?:19|20)\d{2})$/.exec(t);
  if (range) {
    tags.range ??= { start: Number(range[1]), end: Number(range[2]) };
    return true;
  }
  const feat = FEATURING_BRACKET.exec(t);
  if (feat) {
    tags.featuring.push(...splitNames(feat[1]!));
    return true;
  }
  const hint = typeHintOf(t);
  if (hint) {
    tags.typeHint ??= hint;
    return true;
  }
  if (/^(?:\d{1,2}\s?[x×]?\s?(?:CD|Disc|Disk|LP)s?|\d{1,2}[-_ ]?Discs?|(?:Double|Triple)[-_ ](?:CD|Disc|Album|LP))$/i.test(t)) {
    tags.discCount ??= discCountOf(t);
    return true;
  }
  if (!hasTech(t) && (CATALOG.test(t) || CATALOG_NUMERIC.test(t)) && !YEAR.test(t)) {
    tags.catalog ??= t;
    return true;
  }
  if (isTechOnly(t)) {
    tags.tech.push(t);
    const y = /(?<!\d)((?:19|20)\d{2})(?!\d)/.exec(t);
    if (y) tags.yearInTech ??= Number(y[1]);
    tags.discCount ??= discCountOf(t);
    return true;
  }
  if (EDITION.test(t)) {
    // "Deluxe Edition", "2011 Remaster", "Remastered 2009 - FLAC": the edition words, with
    // any file words split off into the tech text.
    const techWords = t.match(TECH_G) ?? [];
    if (techWords.length > 0) tags.tech.push(techWords.join(' '));
    const edition = t.replace(TECH_G, ' ').replace(/\s*[-,;+/|]\s*$/g, '').replace(/^\s*[-,;+/|]\s*/g, '').replace(/\s+/g, ' ').trim();
    if (edition) tags.edition.push(edition);
    tags.discCount ??= discCountOf(t);
    return true;
  }
  return false;
}

/** Split a credit list: "A, B & C" → [A, B, C]. */
function splitNames(text: string): string[] {
  return text
    .split(/\s*,\s*|\s+&\s+|\s+and\s+|\s+x\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A bracket pair, without nesting: [...], (...), {...}. */
const BRACKET = /[[({]([^[\](){}]*)[\])}]/g;

/**
 * Pull recognised brackets out of `text`. Unrecognised ones stay in place. Returns the text
 * with recognised brackets replaced by a field break. With `topLevel`, a group may close the
 * name: a last single-word bracket after a tag bracket ("[FLAC] [GRP]") or "-GRP" glued to
 * one ("[FLAC]-GRP").
 */
function extractBrackets(text: string, tags: Tags, topLevel = false): string {
  const segments = [...text.matchAll(BRACKET)];
  let out = '';
  let last = 0;
  let techBefore = false;
  segments.forEach((m, i) => {
    const inner = m[1]!;
    out += text.slice(last, m.index);
    last = m.index + m[0].length;
    const techCount = tags.tech.length;
    if (classify(inner, tags)) {
      techBefore ||= tags.tech.length > techCount;
      out += '   ';
      return;
    }
    const isLast = i === segments.length - 1 && text.slice(last).trim() === '';
    if (topLevel && isLast && techBefore && /^[A-Za-z0-9][\w.]{1,30}$/.test(inner.trim())) {
      tags.group = inner.trim();
      out += '   ';
      return;
    }
    out += m[0];
  });
  const tail = text.slice(last);
  const glued = /^-([A-Za-z0-9_]{2,20})\s*$/.exec(tail);
  if (topLevel && techBefore && glued && !YEAR.test(glued[1]!) && !hasTech(glued[1]!)) {
    tags.group ??= glued[1]!;
    return out;
  }
  return out + tail;
}

/** Peel tag words and a trailing "-GROUP" off the end of the title text: "Album 2020 FLAC-GRP". */
function peelTrailing(text: string, tags: Tags): string {
  let t = text.replace(/\u0000/g, ' ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 12; i++) {
    const before = t;
    // "... [FLAC]-GRP" / "... FLAC-GRP": a group glued to a tag.
    const glued = /(\S+)-([A-Za-z0-9]{2,20})$/.exec(t);
    if (glued && (STRICT_TECH.test(glued[1]!) || /[\])}]$/.test(glued[1]!)) && !hasTech(glued[2]!) && !YEAR.test(glued[2]!)) {
      tags.group ??= glued[2]!;
      t = t.slice(0, glued.index + glued[1]!.length);
    }
    const lastWord = /(?:^|\s)([^\s]+)$/.exec(t);
    if (lastWord) {
      const w = lastWord[1]!;
      if (w === '-' || w === '–' || w === '—') {
        t = t.slice(0, lastWord.index).trim();
      } else if (STRICT_TECH.test(w) && t.slice(0, lastWord.index).trim().length > 0) {
        tags.tech.unshift(w);
        tags.discCount ??= discCountOf(w);
        t = t.slice(0, lastWord.index).trim();
      }
    }
    if (t === before) break;
  }
  return t;
}

const DASH_SPLIT = /\s+[-–—]+\s+|\s+[-–—](?=\S)|(?<=\S)[–—]\s+/;

// ---------------------------------------------------------------------------------------
// Title fields

interface Fields {
  artist: string | null;
  album: string | null;
}

function cleanField(text: string): string {
  return text
    .replace(/\u0000/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—_.,:;]+|[\s\-–—_,:;]+$/g, '')
    .trim();
}

function splitArtistAlbum(core: string, tags: Tags): Fields {
  let parts = core
    .split(/\u0000/)
    .flatMap((chunk) => chunk.split(DASH_SPLIT))
    .map(cleanField)
    .filter(Boolean);
  // Drop parts that are pure tags: "Artist - Album - WEB - FLAC".
  parts = parts.filter((p, i) => i === 0 || !p.split(/\s+/).every((w) => STRICT_TECH.test(w)));
  // Year-only parts: "Artist - 2020 - Album", "2020 - Artist - Album", "Artist - Album - 2020".
  const yearIdx = parts.findIndex((p) => YEAR.test(p));
  if (yearIdx >= 0 && parts.length >= 3) {
    tags.year ??= Number(parts[yearIdx]);
    parts.splice(yearIdx, 1);
  }
  // Type-only parts: "Artist - Album - EP".
  if (parts.length >= 3) {
    const lastPart = parts[parts.length - 1]!;
    const hint = typeHintOf(lastPart);
    if (hint) {
      tags.typeHint ??= hint;
      parts.pop();
    }
  }
  if (parts.length === 0) return { artist: null, album: null };
  if (parts.length === 1) {
    // "Artist-Album (2020)": a single unspaced hyphen splits when nothing else does.
    const only = parts[0]!;
    const m = /^([^-\s][^-]*[^-\s])-([^-\s].*)$/.exec(only);
    if (m && !/\s-|-\s/.test(only) && (only.match(/-/g) ?? []).length === 1 && /\s/.test(only)) {
      return { artist: cleanField(m[1]!), album: cleanField(m[2]!) };
    }
    return { artist: null, album: only };
  }
  return { artist: parts[0]!, album: parts.slice(1).join(' - ') };
}

function finishAlbum(album: string | null, tags: Tags): string | null {
  if (album === null) return null;
  let a = album;
  // Inner brackets the first pass did not see (scene album fields).
  a = cleanField(extractBrackets(a, tags));
  const feat = FEATURING.exec(a);
  if (feat) {
    tags.featuring.push(...splitNames(feat[1]!));
    a = a.slice(0, feat.index).trim();
  }
  // Trailing type word: "Album EP", "Album OST".
  const typed = /\s(EP|E\.P\.|OST|LP)$/.exec(a);
  if (typed && a.length > typed[0].length) {
    if (typed[1] !== 'LP') tags.typeHint ??= typed[1] === 'OST' ? 'Soundtrack' : 'EP';
    a = a.slice(0, typed.index).trim();
  }
  // Trailing edition words outside brackets: "Album Deluxe Edition", "Album Remastered".
  const ed = re(String.raw`\s((?:(?:\d{4}|\d{1,2}(?:st|nd|rd|th))\s)?(?:Super\s)?(?:Deluxe|Expanded|Remastered|Remaster|Anniversary|Collector'?s|Special|Limited|Legacy|Definitive)(?:\s(?:Edition|Version|Remaster))?(?:\s\d{4})?)$`).exec(a);
  if (ed && a.length > ed[0].length) {
    tags.edition.push(ed[1]!);
    a = a.slice(0, ed.index).trim();
  }
  // "Live at the Hall", "Live in Tokyo": a live album by its title.
  if (/^Live\s(?:at|in|from|on)\s/i.test(a)) tags.typeHint ??= 'Live';
  // A trailing bare year: "Album 2020", unless the album is only that year ("1989").
  const yr = /\s((?:19|20)\d{2})$/.exec(a);
  if (yr && tags.year === null) {
    tags.year = Number(yr[1]);
    a = a.slice(0, yr.index).trim();
  }
  return a || null;
}

function finishArtist(artist: string | null, tags: Tags): { artist: string | null; va: boolean } {
  if (artist === null) return { artist: null, va: false };
  let a = cleanField(extractBrackets(artist, tags));
  // "(2020) Artist" leftovers and leading tags: "[FLAC] Artist".
  const feat = FEATURING.exec(a);
  if (feat) {
    tags.featuring.push(...splitNames(feat[1]!));
    a = a.slice(0, feat.index).trim();
  }
  if (VARIOUS.test(a)) return { artist: 'Various Artists', va: true };
  return { artist: a || null, va: false };
}

// ---------------------------------------------------------------------------------------
// Tech text → media, log, cue

const MEDIA_TOKENS: ReadonlyArray<readonly [MusicMedia, RegExp]> = [
  ['SACD', re(String.raw`${L}SACD(?:-?R)?${R}|${L}DSD(?:64|128|256)?${R}|${L}ISO${R}`)],
  ['Vinyl', re(String.raw`${L}(?:Vinyl(?:[-_ ]?Rip)?|\d?LP|VLS|12"|7")(?![\p{L}\p{N}])`)],
  ['Cassette', re(String.raw`${L}(?:Cassette|Tape|MC)${R}`)],
  ['DVD', re(String.raw`${L}DVD(?:-?A(?:udio)?)?${R}`)],
  ['BD', re(String.raw`${L}(?:Blu-?ray|BDA?)${R}`)],
  ['WEB', re(String.raw`${L}(?:WEB(?:[-_ ]?(?:DL|FLAC|Rip))?|Digital(?:[-_ ]Media)?|Bandcamp|Qobuz|Tidal|Deezer|iTunes(?:[-_ ]Plus)?|Amazon|Beatport|7digital|HDtracks|Spotify|Stream)${R}`)],
  ['CD', re(String.raw`${L}(?:\d?x?CD(?:A|DA|R|M|S|-?Rip|-?DA)?|EAC|XLD)${R}`)],
];

function mediaOf(tech: string): MusicMedia {
  let best: { media: MusicMedia; index: number } | null = null;
  for (const [media, pattern] of MEDIA_TOKENS) {
    const m = pattern.exec(tech);
    if (m && (best === null || m.index < best.index)) best = { media, index: m.index };
  }
  return best?.media ?? 'Unknown';
}

function logOf(tech: string): { hasLog: boolean; logScore: number | null; hasCue: boolean } {
  const hasLog = /(?<![a-z])logs?(?![a-z])/i.test(tech);
  const score = /(\d{1,3})\s?%\s?logs?(?![a-z])|logs?\s?(?:score)?[\s:(]*?(\d{1,3})(?:\s?%|(?=\s*(?:$|[\])},;+&]|\s(?:log|cue))))/i.exec(tech);
  let logScore: number | null = null;
  if (hasLog && score) {
    const v = Number(score[1] ?? score[2]);
    if (v >= 0 && v <= 100) logScore = v;
  }
  return { hasLog, logScore, hasCue: /(?<![a-z])cues?(?![a-z])/i.test(tech) };
}

// ---------------------------------------------------------------------------------------
// Scene names

/** Field words of a scene name that are tags, not title words. */
const SCENE_FLAG = /^(?:PROPER|REPACK|RERIP|iNT|INT|READNFO|DIRFIX|NFOFIX|TAGFIX|PROMO|RETAIL|ADVANCE|BONUS|LIMITED|LTD|LTD_ED|Ltd_Ed|Limited_Edition|UNOFFICIAL|OFFICIAL|BOXSET|Box_Set|Reissue|REISSUE|Remastered|REMASTERED|Remaster|DELUXE|Deluxe|Deluxe_Edition|Expanded_Edition|Special_Edition|EXPANDED|Explicit|EXPLICIT|CLEAN|Clean|Censored|Bootleg|BOOTLEG|Live|LIVE|EP|SINGLE|Single|CDS|CDM|MAXI|OST|Vinyl|VINYL|VLS|WEB|CD|CDA|CDR|CDDA|SACD|DVD|DVDA|BD|BLURAY|TAPE|CASSETTE|SAT|DAB|FM|CABLE|LINE|STREAM|DAT|MD|[A-Z]{2}|\d{1,2}x?CD|\d{1,2}LP|\d{1,2}DISC)$/;

function sceneWords(field: string): string {
  return field.replace(/_/g, ' ').replace(/(?<!\d)\.(?!\d)/g, ' ').replace(/\s+/g, ' ').trim();
}

function looksScene(name: string): boolean {
  if (/\s/.test(name) || /[[\]{}]/.test(name)) return false;
  const fields = name.split('-').filter(Boolean);
  return fields.length >= 4 && fields.slice(2).some((f) => YEAR.test(f));
}

function parseScene(name: string): { fields: Fields; tags: Tags; tech: string } {
  const tags = emptyTags();
  // Protect hyphens inside parentheses: "(CAT-123)".
  const protectedName = name.replace(/\(([^()]*)\)/g, (_m, inner: string) => `(${inner.replace(/-/g, '\u0001')})`);
  const fields = protectedName.split('-').filter(Boolean).map((f) => f.replace(/\u0001/g, '-'));
  tags.group = fields.length >= 3 ? fields.pop()! : null;

  const tech: string[] = [];
  let firstTag = fields.length;
  for (let i = fields.length - 1; i >= 2; i--) {
    const f = fields[i]!;
    const words = sceneWords(f);
    const paren = /^\((.*)\)$/.exec(f);
    if (YEAR.test(f)) {
      tags.year ??= Number(f);
    } else if (paren) {
      if (!classify(paren[1]!, tags)) break;
    } else if (SCENE_FLAG.test(f) || isTechOnly(words)) {
      const hint = typeHintOf(words);
      if (hint) tags.typeHint ??= hint;
      else if (EDITION.test(words) && !isTechOnly(words)) tags.edition.push(words);
      else tech.unshift(words);
      tags.discCount ??= discCountOf(f);
    } else if (EDITION.test(words) && /Edition|Remaster|Deluxe|Anniversary|Version/i.test(words) && i > 1) {
      tags.edition.push(words);
    } else {
      break;
    }
    firstTag = i;
  }
  const artist = fields[0] ? sceneWords(fields[0]) : null;
  const albumFields = fields.slice(1, firstTag).map(sceneWords).filter(Boolean);
  const album = albumFields.length > 0 ? albumFields.join(' - ') : null;
  return { fields: { artist, album }, tags, tech: [...tech, ...tags.tech].join(' ') };
}

// ---------------------------------------------------------------------------------------
// Entry points

function packOf(text: string): { packType: MusicPackType | null; albumCount: number | null } {
  if (PACK_DISCOGRAPHY.test(text)) return { packType: 'discography', albumCount: null };
  const multi = PACK_MULTI.exec(text);
  if (multi) {
    const n = multi[1] ?? multi[2];
    return { packType: 'multiAlbum', albumCount: n ? Number(n) : null };
  }
  return { packType: null, albumCount: null };
}

function normalizeSeparators(name: string): string {
  // "Artist_-_Album_(2020)_[FLAC]", "Artist.-.Album.(2020).[FLAC]": separators as spaces.
  if (/\s/.test(name)) return name;
  if (/_/.test(name)) return name.replace(/_/g, ' ');
  if (/[.](?:-|\(|\[)|(?:-|\)|\])[.]/.test(name) || (name.match(/\./g) ?? []).length >= 2) return name.replace(/(?<!\d)\.|\.(?!\d)/g, ' ');
  return name;
}

/** Parse a music release name ("Artist - Album (2020) [FLAC]", "Artist-Album-WEB-2020-GRP"). */
export function parseMusicRelease(raw: string): ParsedMusicRelease {
  const { title: noExt, extension } = stripAudioExtension(raw.trim());
  const releaseTitle = prepare(noExt);
  const releaseHash = parseReleaseHash(releaseTitle);

  let fields: Fields;
  let tags: Tags;
  let techText: string;
  let packSource: string;
  const scene = looksScene(releaseTitle);

  if (scene) {
    const s = parseScene(releaseTitle);
    tags = s.tags;
    techText = s.tech;
    packSource = sceneWords(releaseTitle);
    const album = finishAlbum(s.fields.album, tags);
    fields = { artist: finishArtist(s.fields.artist, tags).artist, album };
  } else {
    tags = emptyTags();
    const text = normalizeSeparators(releaseTitle);
    // A year range anywhere (a pack span) is read before brackets and dashes split it.
    const range = YEAR_RANGE.exec(text);
    let core = peelTrailing(extractBrackets(text, tags, true), tags);
    if (range && !tags.range) {
      tags.range = { start: Number(range[1]), end: Number(range[2]) };
      core = core.replace(YEAR_RANGE, ' ');
    }
    packSource = core;
    const split = splitArtistAlbum(core, tags);
    const artist = finishArtist(split.artist, tags);
    fields = { artist: artist.artist, album: finishAlbum(split.album, tags) };
    techText = tags.tech.join(' ');
  }

  const pack = packOf(packSource);
  const isPack = pack.packType !== null;
  // Tags are known to be tags: wrapping them in a bracket lets word-like codecs ("Opus") count.
  const audio = parseAudioQuality(techText ? `[${techText}]` : '', extension);
  const log = logOf(techText);
  let media = mediaOf(techText);
  if (media === 'Unknown' && log.hasLog) media = 'CD';

  const music: ParsedMusicInfo = {
    artist: fields.artist,
    album: isPack ? null : fields.album,
    year: isPack ? null : (tags.year ?? tags.yearInTech),
    isVariousArtists: fields.artist === 'Various Artists',
    edition: tags.edition.length > 0 ? tags.edition.join(' ') : null,
    releaseTypeHint: tags.typeHint,
    isDiscography: isPack,
    packType: pack.packType,
    albumCount: pack.albumCount,
    discographyYears: isPack ? tags.range : null,
    catalogNumber: tags.catalog,
    media,
    discCount: tags.discCount ?? discCountOf(techText),
    featuring: [...new Set(tags.featuring)],
    scene,
    hasLog: log.hasLog,
    logScore: log.logScore,
    hasCue: log.hasCue,
    audio,
  };
  const empty = !music.artist && !music.album && !isPack;
  return { releaseTitle, releaseGroup: tags.group, releaseHash, audio, music: empty ? null : music };
}

// ---------------------------------------------------------------------------------------
// Paths

/** "CD1", "Disc 2", "CD 02 - Bonus", "Side A": a folder that only names one disc. */
const DISC_FOLDER = /^(?:CD|Disc|Disk|Disque|Side|Vinyl|LP)[-_. ]?(?:\d{1,2}|[A-D])(?:\s*[-:]\s*.*)?$/i;
/** "01 - Title", "01. Title", "1-01 Title", "A1 Title", "101 Title": a track file. */
const TRACK_FILE = /^(?:\d{1,2}[-.])?\d{1,3}(?:\s*[-.]\s*|\s+|_)|^[A-D]\d{1,2}[\s.-]/;

/**
 * Parse a music file path. Track files ("01 - Title.flac") take artist and album from the
 * folders ("Artist/Album (2020) [FLAC]/CD1/01 - Title.flac", stepping over disc folders);
 * a file named like a release ("Artist - Album.flac", a single-file rip) is parsed itself,
 * with the folder filling gaps. Audio facts merge: the file and its extension win, the
 * folder name fills in bit depth, sample rate and bitrate of the same codec.
 */
export function parseAudioPath(path: string, domain?: 'music'): ParsedMusicRelease;
/** Audiobook paths: see `parseAudiobookPath` (Author/Title, Author/Series/Book N - Title). */
export function parseAudioPath(path: string, domain: 'audiobook'): ParsedAudiobookRelease;
export function parseAudioPath(path: string, domain: 'music' | 'audiobook' = 'music'): ParsedMusicRelease | ParsedAudiobookRelease {
  if (domain === 'audiobook') return parseAudiobookPath(path);
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const fileName = parts[parts.length - 1] ?? path;
  const folders = parts.slice(0, -1).filter((p) => !/^[a-z]:$/i.test(p));

  let i = folders.length - 1;
  while (i >= 0 && DISC_FOLDER.test(folders[i]!.trim())) i--;
  const albumFolder = i >= 0 ? folders[i]! : null;
  const artistFolder = i >= 1 ? folders[i - 1]! : null;

  const file = parseMusicRelease(fileName);
  const { title: base } = stripAudioExtension(fileName);
  const isTrack = TRACK_FILE.test(base.trim()) || !file.music?.artist;
  if (!albumFolder) return file;

  const folder = parseMusicRelease(albumFolder);
  // Facts from the folder name ("[FLAC 24-96]") complete the file's.
  const audio = mergeAudioQuality(file.audio, folder.audio);

  let primary: ParsedMusicRelease = isTrack || !file.music ? folder : file;
  if (!isTrack && file.music && folder.music) {
    const m = file.music;
    m.year ??= folder.music.year;
    m.edition ??= folder.music.edition;
    m.catalogNumber ??= folder.music.catalogNumber;
    if (m.media === 'Unknown') m.media = folder.music.media;
    primary = file;
  }
  const music = primary.music ? { ...primary.music, audio } : null;
  // "Artist/Album (2020)/01.flac": the folder above names the artist.
  if (music && !music.artist && artistFolder) {
    const a = parseMusicRelease(artistFolder);
    const name = a.music?.artist ?? a.music?.album ?? null;
    if (name) {
      music.artist = name;
      music.isVariousArtists = /^(?:VA|Various Artists|Various|Compilations)$/i.test(name);
      if (music.isVariousArtists) music.artist = 'Various Artists';
    }
  }
  return { ...primary, audio, music, releaseGroup: primary.releaseGroup ?? folder.releaseGroup };
}

// ---------------------------------------------------------------------------------------
// Bridges to the profiles engine

const SOURCE_OF_MEDIA: Record<MusicMedia, AudioSourceKind | undefined> = {
  CD: 'cd',
  WEB: 'web',
  Vinyl: 'vinyl',
  SACD: 'sacd',
  Cassette: 'cassette',
  DVD: 'other',
  BD: 'other',
  Unknown: undefined,
};

/** The `ReleaseEvaluation.audio` block for a parsed music release. */
export function musicAudioEvaluation(info: ParsedMusicInfo): ReleaseAudioEvaluation {
  const a = info.audio;
  const source = SOURCE_OF_MEDIA[info.media];
  return {
    codec: a.codec,
    ...(a.bitrateKbps !== null ? { bitrateKbps: a.bitrateKbps } : {}),
    ...(a.vbrPreset !== null ? { vbrPreset: a.vbrPreset } : {}),
    ...(a.bitDepth !== null ? { bitDepth: a.bitDepth } : {}),
    ...(a.sampleRateHz !== null ? { sampleRateHz: a.sampleRateHz } : {}),
    ...(source ? { source } : {}),
    hasLog: info.hasLog,
    ...(info.logScore !== null ? { logScore: info.logScore } : {}),
    hasCue: info.hasCue,
  };
}

/** The `ReleaseEvaluation.releaseKind` of a parsed music release. */
export function musicReleaseKind(info: ParsedMusicInfo): ReleaseKind {
  if (info.packType === 'discography') return 'discography';
  if (info.packType === 'multiAlbum') return 'multiAlbum';
  return 'single';
}

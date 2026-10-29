import { normalizeTitle, type MusicPackType, type ParsedAudiobookInfo, type ParsedMusicInfo } from '@arclight/parser';
import { albumPassesTypeProfile, type AlbumPrimaryType, type AlbumSecondaryType, type AlbumTypeProfile, type BookFormatType } from '@arclight/shared';
import type { MatchCriteria } from './matcher.js';

// Maps a parsed music release onto the music library (docs/design/music-audiobooks.md 8.2).
// Pure: the library is read through `AudioLibrarySnapshot`, so it is testable without a DB.
//
//   artist   clean name or alias (accents, punctuation and a leading "The" ignored, "&" = "and").
//            "Various Artists" releases match on the album alone, across every artist.
//   album    clean title with edition words removed on both sides, year within one year. A
//            different year is still accepted when the title is unique for the artist (reissue).
//            When several albums fit equally, the album a search runs for wins.
//   packs    discographies and multi-album packs map to the artist's albums inside the stated
//            year span that pass the artist's album-type profile.
//
// Audiobooks, over `BookLibrarySnapshot`:
//
//   asin     an ASIN in the release name maps straight to the book that carries it.
//   author   any credited author, by clean name, sort name ("Last, First") or alias; initials
//            agree with full given names ("J. R. R. Tolkien" = "John Ronald Reuel Tolkien").
//   book     clean title (leading article ignored, subtitle optional), else series + position.
//   packs    "Books 1-5" / "Complete Series" map to the series' books inside the range.

export interface AudioArtist {
  id: number;
  name: string;
  aliases: readonly string[];
  monitored: boolean;
  qualityProfileId: number;
  albumTypeProfileId: number;
  tags: number[];
  path: string;
}

export interface AudioAlbum {
  id: number;
  artistId: number;
  title: string;
  year: number | null;
  /** `YYYY-MM-DD`, `YYYY-MM` or `YYYY`; null when unknown. */
  releaseDate: string | null;
  primaryType: AlbumPrimaryType;
  secondaryTypes: readonly AlbumSecondaryType[];
  monitored: boolean;
  /** Running time of the selected edition (ms); null until its tracks are loaded. */
  durationMs: number | null;
  trackCount: number;
  trackFileCount: number;
}

export type AlbumTypeFilter = Pick<AlbumTypeProfile, 'primaryTypes' | 'secondaryTypes' | 'releaseStatuses'>;

export interface AudioLibrarySnapshot {
  artists(): readonly AudioArtist[];
  albums(artistId: number): readonly AudioAlbum[];
  /** The artist's album-type profile; omitted or undefined = every album passes. */
  albumTypeProfile?(id: number): AlbumTypeFilter | undefined;
}

export type AudioMatchType = 'title' | 'alias' | 'album' | 'criteria' | 'override';

export interface AlbumMatch {
  status: 'mapped';
  mediaType: 'music';
  artist: AudioArtist;
  /** One album, or the albums a pack covers (oldest first). */
  albums: AudioAlbum[];
  pack: MusicPackType | null;
  /** How the artist was found (`album` for Various Artists releases). */
  matchType: AudioMatchType;
}

export type AudioUnmatchedReason = 'unableToParse' | 'unknownArtist' | 'unknownAlbum' | 'emptyPack';

export interface AudioUnmatched {
  status: 'unknown' | 'ambiguous';
  mediaType: 'music';
  reason: AudioUnmatchedReason;
  message: string;
  /** Set when the artist matched but the album did not. */
  artist?: AudioArtist;
  /** Set for `ambiguous`: the album (or artist) ids that fit equally well. */
  candidates?: number[];
}

export type AudioMatchResult = AlbumMatch | AudioUnmatched;

export interface AudioMatchOptions {
  criteria?: MatchCriteria;
  /** Packs only cover albums released by then (default: no date filter). */
  now?: Date;
}

// ---- keys ---------------------------------------------------------------------------

const LEADING_THE = /^\s*the\s+/i;
const TRAILING_THE = /,\s*the\s*$/i;

/** Matching key of an artist name: "The Beatles", "Beatles, The" and "beatles" agree. */
export function artistKey(name: string): string {
  const folded = name.replace(/&/g, ' and ').replace(TRAILING_THE, '').replace(LEADING_THE, '');
  return normalizeTitle(folded) || normalizeTitle(name);
}

/** Words that name an edition, not the album: removed before titles are compared. */
const EDITION_WORD =
  /(?:super\s+)?deluxe|expanded|remaster(?:ed)?|anniversary|edition|version|re-?issue|collector'?s|special|limited|bonus(?:\s+tracks?)?|legacy|definitive|ultimate|extended|enhanced|mono|stereo|\d{1,3}(?:st|nd|rd|th)/i;
const EDITION_IN = new RegExp(String.raw`(?<!\p{L})(?:${EDITION_WORD.source})(?!\p{L})`, 'iu');
const BRACKETED = /\s*[([{]([^)\]}]*)[)\]}]\s*/g;
const TRAILING_EDITION = new RegExp(
  String.raw`(?:\s*[-:,]\s*|\s+)(?:(?:19|20)\d{2}\s+)?(?:(?:${EDITION_WORD.source})(?!\p{L})\s*)+(?:(?:19|20)\d{2})?\s*$`,
  'iu',
);

/** An album title without bracketed or trailing edition words ("Abbey Road (2019 Mix)" stays). */
export function stripEdition(title: string): string {
  let t = title.replace(BRACKETED, (whole, inner: string) => (EDITION_IN.test(inner) ? ' ' : whole));
  for (let i = 0; i < 3; i++) {
    const next = t.replace(TRAILING_EDITION, '');
    if (next === t || next.trim() === '') break;
    t = next;
  }
  return t.trim() || title.trim();
}

/** Matching key of an album title. */
export function albumKey(title: string): string {
  const stripped = stripEdition(title).replace(/&/g, ' and ');
  return normalizeTitle(stripped) || normalizeTitle(title);
}

const VARIOUS_KEYS = new Set(['va', 'various', 'variousartists', 'variousartist', 'variousperformers']);

/** True for the "Various Artists" placeholder artist name. */
export function isVariousArtistsName(name: string): boolean {
  return VARIOUS_KEYS.has(name.toLowerCase().replace(/[^a-z]/g, ''));
}

// ---- matching -----------------------------------------------------------------------

function releaseMs(date: string | null): number | null {
  if (!date) return null;
  const iso = /^\d{4}$/.test(date) ? `${date}-01-01` : /^\d{4}-\d{2}$/.test(date) ? `${date}-01` : date;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function albumYear(a: AudioAlbum): number | null {
  if (a.year !== null) return a.year;
  const ms = releaseMs(a.releaseDate);
  return ms === null ? null : new Date(ms).getUTCFullYear();
}

function artistsFor(info: ParsedMusicInfo, lib: AudioLibrarySnapshot): Array<{ artist: AudioArtist; via: 'title' | 'alias' }> {
  if (!info.artist) return [];
  const key = artistKey(info.artist);
  if (!key) return [];
  const out: Array<{ artist: AudioArtist; via: 'title' | 'alias' }> = [];
  for (const a of lib.artists()) {
    if (artistKey(a.name) === key) out.push({ artist: a, via: 'title' });
    else if (a.aliases.some((alias) => artistKey(alias) === key)) out.push({ artist: a, via: 'alias' });
  }
  return out;
}

/** Narrow a candidate list with the search criteria; returns the list unchanged when they do not help. */
function preferCriteria<T>(list: T[], ids: readonly number[] | undefined, idOf: (t: T) => number): T[] {
  if (!ids?.length || list.length <= 1) return list;
  const hit = list.filter((t) => ids.includes(idOf(t)));
  return hit.length > 0 ? hit : list;
}

type AlbumPick = { album: AudioAlbum } | { ambiguous: number[] } | null;

/** The album of `albums` the parsed title and year point at. */
function pickAlbum(info: ParsedMusicInfo, albums: readonly AudioAlbum[], criteria: MatchCriteria | undefined): AlbumPick {
  if (!info.album) return null;
  const key = albumKey(info.album);
  if (!key) return null;
  const titled = albums.filter((a) => albumKey(a.title) === key);
  if (titled.length === 0) return null;
  const year = info.year;
  let fits: AudioAlbum[];
  if (year === null) {
    fits = titled;
  } else {
    const close = titled.filter((a) => {
      const y = albumYear(a);
      return y === null || Math.abs(y - year) <= 1;
    });
    // A reissue: another year, but only one album of the artist carries the title.
    fits = close.length > 0 ? close : titled.length === 1 ? titled : [];
    if (close.length > 1) {
      // Prefer the exact year over the neighbours when both are present.
      const exact = close.filter((a) => albumYear(a) === year);
      if (exact.length > 0) fits = exact;
    }
  }
  if (fits.length === 0) return null;
  fits = preferCriteria(fits, criteria?.albumIds, (a) => a.id);
  if (fits.length === 1) return { album: fits[0]! };
  return { ambiguous: fits.map((a) => a.id) };
}

/** The artist's albums a pack covers: inside the year span, passing the album-type profile, released. */
export function packAlbums(
  info: Pick<ParsedMusicInfo, 'discographyYears'>,
  artist: AudioArtist,
  lib: AudioLibrarySnapshot,
  now?: Date,
): AudioAlbum[] {
  const profile = lib.albumTypeProfile?.(artist.albumTypeProfileId);
  const span = info.discographyYears;
  const limit = now ? now.getTime() + 24 * 3_600_000 : null;
  return lib
    .albums(artist.id)
    .filter((a) => !profile || albumPassesTypeProfile(profile, { primaryType: a.primaryType, secondaryTypes: a.secondaryTypes }))
    .filter((a) => {
      if (!span) return true;
      const y = albumYear(a);
      return y !== null && y >= span.start && y <= span.end;
    })
    .filter((a) => {
      if (limit === null) return true;
      const ms = releaseMs(a.releaseDate);
      return ms !== null && ms <= limit;
    })
    .sort((a, b) => (albumYear(a) ?? 0) - (albumYear(b) ?? 0) || a.id - b.id);
}

/** Map a parsed music release to an artist and its album(s). */
export function matchAlbum(info: ParsedMusicInfo | null, lib: AudioLibrarySnapshot, opts: AudioMatchOptions = {}): AudioMatchResult {
  const criteria = opts.criteria?.mediaType === 'music' ? opts.criteria : undefined;
  if (!info || (!info.artist && !info.album && !info.packType)) {
    return { status: 'unknown', mediaType: 'music', reason: 'unableToParse', message: 'Unable to parse release' };
  }

  // Various Artists: the album alone, across the whole library.
  if (info.isVariousArtists || (info.artist !== null && isVariousArtistsName(info.artist))) {
    const hits: Array<{ artist: AudioArtist; album: AudioAlbum }> = [];
    let ambiguous: number[] = [];
    for (const artist of lib.artists()) {
      const pick = pickAlbum(info, lib.albums(artist.id), criteria);
      if (pick && 'album' in pick) hits.push({ artist, album: pick.album });
      else if (pick) ambiguous = [...ambiguous, ...pick.ambiguous];
    }
    const narrowed = preferCriteria(hits, criteria?.albumIds, (h) => h.album.id);
    if (narrowed.length === 1) {
      const { artist, album } = narrowed[0]!;
      return { status: 'mapped', mediaType: 'music', artist, albums: [album], pack: null, matchType: 'album' };
    }
    if (narrowed.length > 1 || ambiguous.length > 0) {
      return {
        status: 'ambiguous',
        mediaType: 'music',
        reason: 'unknownAlbum',
        message: 'Album title matches more than one album in the library',
        candidates: [...narrowed.map((h) => h.album.id), ...ambiguous],
      };
    }
    return { status: 'unknown', mediaType: 'music', reason: 'unknownAlbum', message: `Unknown album: ${info.album ?? '(none)'}` };
  }

  let found = artistsFor(info, lib);
  if (found.length === 0) {
    return { status: 'unknown', mediaType: 'music', reason: 'unknownArtist', message: `Unknown artist: ${info.artist ?? '(none)'}` };
  }
  found = preferCriteria(found, criteria?.artistId !== undefined ? [criteria.artistId] : undefined, (f) => f.artist.id);

  // Packs: every album of the artist the pack covers.
  if (info.packType) {
    if (found.length > 1) {
      return {
        status: 'ambiguous',
        mediaType: 'music',
        reason: 'unknownArtist',
        message: 'Artist name matches more than one artist in the library',
        candidates: found.map((f) => f.artist.id),
      };
    }
    const { artist, via } = found[0]!;
    const albums = packAlbums(info, artist, lib, opts.now);
    if (albums.length === 0) {
      return { status: 'unknown', mediaType: 'music', reason: 'emptyPack', message: 'No albums of the artist fall inside the pack', artist };
    }
    return { status: 'mapped', mediaType: 'music', artist, albums, pack: info.packType, matchType: criteriaHit(criteria, artist) ? 'criteria' : via };
  }

  const picks = found.map((f) => ({ ...f, pick: pickAlbum(info, lib.albums(f.artist.id), criteria) }));
  const mapped = picks.filter((p): p is typeof p & { pick: { album: AudioAlbum } } => p.pick !== null && 'album' in p.pick);
  if (mapped.length === 1) {
    const { artist, via, pick } = mapped[0]!;
    return { status: 'mapped', mediaType: 'music', artist, albums: [pick.album], pack: null, matchType: criteriaHit(criteria, artist) ? 'criteria' : via };
  }
  const ambiguous = picks.flatMap((p) => (p.pick && 'ambiguous' in p.pick ? p.pick.ambiguous : []));
  if (mapped.length > 1 || ambiguous.length > 0) {
    return {
      status: 'ambiguous',
      mediaType: 'music',
      reason: 'unknownAlbum',
      message: 'Release matches more than one album; search from the album to pick it',
      candidates: [...mapped.map((m) => m.pick.album.id), ...ambiguous],
    };
  }
  return {
    status: 'unknown',
    mediaType: 'music',
    reason: 'unknownAlbum',
    message: `Unknown album: ${info.album ?? '(none)'}${info.year !== null ? ` (${info.year})` : ''}`,
    artist: found[0]!.artist,
  };
}

function criteriaHit(criteria: MatchCriteria | undefined, artist: AudioArtist): boolean {
  return criteria?.artistId === artist.id;
}

/** A release title with an audio codec or container word: the gate for trying the music parser on `auto` releases. */
const AUDIO_MARKER =
  /(?<![\p{L}\p{N}])(?:FLAC(?:24)?|ALAC|MP3|AAC|M4A|OGG|Vorbis|WAV|WavPack|DSD(?:64|128|256)?|DSF|V0|V2|320(?:kbps|k)?|(?:16|24)[-_ ]?bit|Lossless|CDDA)(?![\p{L}\p{N}])/iu;
/** "Opus" and "Ape" are also words: only the all-capitals codec spelling counts. */
const CAPS_MARKER = /(?<![\p{L}\p{N}])(?:OPUS|APE)(?![\p{L}\p{N}])/u;

export function hasAudioMarker(title: string): boolean {
  return AUDIO_MARKER.test(title) || CAPS_MARKER.test(title);
}

// ---- audiobooks ---------------------------------------------------------------------

export interface AudioAuthor {
  id: number;
  name: string;
  /** "Last, First". */
  sortName: string;
  aliases: readonly string[];
  monitored: boolean;
  qualityProfileId: number;
  tags: number[];
  path: string;
  /** Book languages the author is kept in (catalogue names or ISO codes); empty = any. */
  languages: readonly string[];
}

export interface AudioBookSeries {
  seriesId: number;
  name: string;
  /** As the catalogue writes it: `3`, `2.5`, `1-3`, `Prequel`. */
  position: string | null;
  positionSort: number | null;
  isPrimary: boolean;
}

export interface AudioBook {
  id: number;
  /** The owning author (the book's folder lives under theirs). */
  authorId: number;
  asin: string | null;
  title: string;
  subtitle: string | null;
  /** Catalogue language name or ISO code; null when unknown. */
  language: string | null;
  /** `YYYY-MM-DD` or `YYYY`; null when unknown. */
  releaseDate: string | null;
  year: number | null;
  runtimeMinutes: number | null;
  formatType: BookFormatType | null;
  monitored: boolean;
  hasFile: boolean;
  /** Credited author names as the catalogue lists them. */
  credits: readonly string[];
  series: readonly AudioBookSeries[];
}

export interface BookLibrarySnapshot {
  authors(): readonly AudioAuthor[];
  /** Books the author owns or is linked to as a co-author. */
  books(authorId: number): readonly AudioBook[];
}

export type BookMatchType = 'asin' | 'title' | 'alias' | 'series' | 'criteria' | 'override';

export interface BookMatch {
  status: 'mapped';
  mediaType: 'audiobook';
  /** The owner of the books (profile, folder, tags). */
  author: AudioAuthor;
  /** One book, or the books a pack covers (series order). */
  books: AudioBook[];
  isPack: boolean;
  matchType: BookMatchType;
}

export type BookUnmatchedReason = 'unableToParse' | 'unknownAuthor' | 'unknownBook' | 'emptyPack';

export interface BookUnmatched {
  status: 'unknown' | 'ambiguous';
  mediaType: 'audiobook';
  reason: BookUnmatchedReason;
  message: string;
  /** Set when the author matched but the book did not. */
  author?: AudioAuthor;
  /** Set for `ambiguous`: the book ids that fit equally well. */
  candidates?: number[];
}

export type BookMatchResult = BookMatch | BookUnmatched;

const NAME_SUFFIX = /^(?:jr|sr|ii|iii|iv|phd|md)\.?$/i;

/** The given name(s) and surname of a person as lower-case words ("Tolkien, J.R.R." -> j r r tolkien). */
function personWords(name: string): string[] {
  const parts = name
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const ordered = parts.length === 2 && !NAME_SUFFIX.test(parts[1]!) ? `${parts[1]} ${parts[0]}` : name;
  return ordered
    .replace(/&/g, ' and ')
    .split(/[^\p{L}\p{N}]+/u)
    .map((w) => normalizeTitle(w))
    .filter(Boolean);
}

/** Matching key of a person: punctuation, spacing, accents and "Last, First" order ignored. */
export function personKey(name: string): string {
  return personWords(name).join('');
}

/** Initials of the given names plus the surname ("Stephen King" and "S. King" -> "sking"). */
function initialsKey(words: readonly string[]): string {
  if (words.length < 2) return words.join('');
  return words.slice(0, -1).map((w) => w[0]).join('') + words[words.length - 1];
}

/** Does `release` (as written) name the person `known`? Same key, else same initials when either side uses initials. */
export function samePerson(release: string, known: string): boolean {
  const a = personWords(release);
  const b = personWords(known);
  if (a.length === 0 || b.length === 0) return false;
  if (a.join('') === b.join('')) return true;
  const usesInitials = (w: readonly string[]) => w.slice(0, -1).some((x) => x.length === 1);
  if (!usesInitials(a) && !usesInitials(b)) return false;
  return a[a.length - 1] === b[b.length - 1] && initialsKey(a) === initialsKey(b);
}

const LEADING_ARTICLE = /^\s*(?:the|a|an)\s+/i;

/** Matching key of a book title: accents, punctuation and a leading article ignored, "&" = "and". */
export function bookTitleKey(title: string): string {
  const folded = title.replace(/&/g, ' and ').replace(LEADING_ARTICLE, '');
  return normalizeTitle(folded) || normalizeTitle(title);
}

/** Matching key of a series name ("The Expanse" = "Expanse Series"). */
export function seriesKey(name: string): string {
  const folded = name
    .replace(/&/g, ' and ')
    .replace(LEADING_ARTICLE, '')
    .replace(/\s+(?:series|saga|trilogy|sequence|cycle|books?)\s*$/i, '');
  return normalizeTitle(folded) || normalizeTitle(name);
}

function bookKeys(b: Pick<AudioBook, 'title' | 'subtitle'>): Set<string> {
  const keys = new Set([bookTitleKey(b.title)]);
  if (b.subtitle) keys.add(bookTitleKey(`${b.title} ${b.subtitle}`));
  const colon = b.title.indexOf(':');
  if (colon > 0) keys.add(bookTitleKey(b.title.slice(0, colon)));
  keys.delete('');
  return keys;
}

function releaseKeys(info: Pick<ParsedAudiobookInfo, 'title' | 'subtitle'>): string[] {
  if (!info.title) return [];
  const keys = [bookTitleKey(info.title)];
  if (info.subtitle) keys.push(bookTitleKey(`${info.title} ${info.subtitle}`));
  return keys.filter(Boolean);
}

function positionNumber(p: string | null | undefined): number | null {
  if (!p || !p.trim()) return null;
  const n = Number(p.trim());
  return Number.isFinite(n) ? n : null;
}

function entryPosition(e: AudioBookSeries): number | null {
  return e.positionSort ?? positionNumber(e.position);
}

/** Range of a pack position: `1-5` -> [1, 5]; one number -> [n, n]; null = the whole series. */
function packRange(position: string | null): { start: number; end: number } | null {
  if (!position) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)\s*$/i.exec(position);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return { start: Math.min(a, b), end: Math.max(a, b) };
  }
  const n = positionNumber(position);
  return n === null ? null : { start: n, end: n };
}

function bookYear(b: AudioBook): number | null {
  if (b.year !== null) return b.year;
  const ms = releaseMs(b.releaseDate);
  return ms === null ? null : new Date(ms).getUTCFullYear();
}

function authorsByName(names: readonly string[], lib: BookLibrarySnapshot): Array<{ author: AudioAuthor; via: 'title' | 'alias' }> {
  const out: Array<{ author: AudioAuthor; via: 'title' | 'alias' }> = [];
  for (const a of lib.authors()) {
    if (names.some((n) => samePerson(n, a.name) || samePerson(n, a.sortName))) out.push({ author: a, via: 'title' });
    else if (names.some((n) => a.aliases.some((alias) => samePerson(n, alias)))) out.push({ author: a, via: 'alias' });
  }
  return out;
}

function ownerOf(book: AudioBook, lib: BookLibrarySnapshot, fallback?: AudioAuthor): AudioAuthor | undefined {
  return lib.authors().find((a) => a.id === book.authorId) ?? fallback;
}

function allBooks(lib: BookLibrarySnapshot, authors?: readonly AudioAuthor[]): AudioBook[] {
  const seen = new Map<number, AudioBook>();
  for (const a of authors ?? lib.authors()) for (const b of lib.books(a.id)) if (!seen.has(b.id)) seen.set(b.id, b);
  return [...seen.values()];
}

function seriesEntry(b: AudioBook, key: string): AudioBookSeries | undefined {
  return b.series.find((e) => seriesKey(e.name) === key);
}

type BookPick = { book: AudioBook; via: 'title' | 'series' } | { ambiguous: number[] } | null;

/** The book of `books` the parsed title (or series + position) points at. */
function pickBook(info: ParsedAudiobookInfo, books: readonly AudioBook[], criteria: MatchCriteria | undefined): BookPick {
  const keys = releaseKeys(info);
  const sKey = info.series ? seriesKey(info.series) : null;
  const pos = positionNumber(info.seriesPosition);
  const placedAt = (b: AudioBook) => {
    if (!sKey || pos === null) return false;
    const e = seriesEntry(b, sKey);
    return e !== undefined && entryPosition(e) === pos;
  };
  let fits = keys.length > 0 ? books.filter((b) => keys.some((k) => bookKeys(b).has(k))) : [];
  let via: 'title' | 'series' = 'title';
  if (fits.length > 1) {
    const placed = fits.filter(placedAt);
    if (placed.length > 0) fits = placed;
  }
  if (fits.length > 1 && info.year !== null) {
    const year = info.year;
    const close = fits.filter((b) => {
      const y = bookYear(b);
      return y === null || Math.abs(y - year) <= 1;
    });
    if (close.length > 0) fits = close;
  }
  if (fits.length === 0) {
    fits = books.filter(placedAt);
    via = 'series';
  }
  if (fits.length === 0) return null;
  fits = preferCriteria(fits, criteria?.bookIds, (b) => b.id);
  if (fits.length === 1) return { book: fits[0]!, via };
  return { ambiguous: fits.map((b) => b.id) };
}

/** The books of a series pack: inside the stated range (whole positions only), released, in series order. */
export function packBooks(info: Pick<ParsedAudiobookInfo, 'series' | 'seriesPosition'>, books: readonly AudioBook[], now?: Date): AudioBook[] {
  if (!info.series) return [];
  const key = seriesKey(info.series);
  const range = packRange(info.seriesPosition);
  const limit = now ? now.getTime() + 24 * 3_600_000 : null;
  return books
    .flatMap((b) => {
      const e = seriesEntry(b, key);
      if (!e) return [];
      const p = entryPosition(e);
      if (range && (p === null || !Number.isInteger(p) || p < range.start || p > range.end)) return [];
      if (limit !== null) {
        const ms = releaseMs(b.releaseDate);
        if (ms !== null && ms > limit) return [];
      }
      return [{ b, p }];
    })
    .sort((x, y) => (x.p ?? Number.MAX_SAFE_INTEGER) - (y.p ?? Number.MAX_SAFE_INTEGER) || x.b.id - y.b.id)
    .map((x) => x.b);
}

export interface BookMatchOptions {
  criteria?: MatchCriteria;
  /** Packs only cover books released by then (default: no date filter). */
  now?: Date;
}

/** Map a parsed audiobook release to an author and their book(s). */
export function matchBook(info: ParsedAudiobookInfo | null, lib: BookLibrarySnapshot, opts: BookMatchOptions = {}): BookMatchResult {
  const criteria = opts.criteria?.mediaType === 'audiobook' ? opts.criteria : undefined;
  if (!info || (info.authors.length === 0 && !info.title && !info.series && !info.asin)) {
    return { status: 'unknown', mediaType: 'audiobook', reason: 'unableToParse', message: 'Unable to parse release' };
  }
  const isCriteria = (author: AudioAuthor) => criteria?.authorId === author.id;

  // An ASIN names exactly one edition.
  if (info.asin) {
    const asin = info.asin.toUpperCase();
    const hit = allBooks(lib).find((b) => b.asin?.toUpperCase() === asin);
    const author = hit ? ownerOf(hit, lib) : undefined;
    if (hit && author) return { status: 'mapped', mediaType: 'audiobook', author, books: [hit], isPack: false, matchType: 'asin' };
  }

  let found = authorsByName(info.authors, lib);
  let parsed = info;
  // "Title - Author - Narrator" names: the parser reads the first part as the author.
  if (found.length === 0 && info.title && info.authors.length > 0 && !info.isPack) {
    const swapped = authorsByName([info.title], lib);
    if (swapped.length > 0) {
      found = swapped;
      parsed = { ...info, authors: [info.title], title: info.authors[0]!, subtitle: null };
    }
  }
  found = preferCriteria(found, criteria?.authorId !== undefined ? [criteria.authorId] : undefined, (f) => f.author.id);

  if (info.isPack) {
    if (info.authors.length > 0 && found.length === 0) {
      return { status: 'unknown', mediaType: 'audiobook', reason: 'unknownAuthor', message: `Unknown author: ${info.authors.join(', ')}` };
    }
    // A pack without an author ("The Expanse Books 1-5") looks across the library.
    const pool = allBooks(lib, found.length > 0 ? found.map((f) => f.author) : undefined);
    const books = packBooks(info, pool, opts.now);
    if (books.length === 0) {
      const author = found[0]?.author;
      return {
        status: 'unknown',
        mediaType: 'audiobook',
        reason: 'emptyPack',
        message: info.series ? `No books of ${info.series} fall inside the pack` : 'Pack does not name a series',
        ...(author ? { author } : {}),
      };
    }
    // One owner per match: the searched author, else the one who owns most of the books.
    const owners = new Map<number, AudioBook[]>();
    for (const b of books) owners.set(b.authorId, [...(owners.get(b.authorId) ?? []), b]);
    const ownerId =
      criteria?.authorId !== undefined && owners.has(criteria.authorId)
        ? criteria.authorId
        : [...owners.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0])[0]![0];
    const owned = owners.get(ownerId)!;
    const author = ownerOf(owned[0]!, lib, found[0]?.author);
    if (!author) return { status: 'unknown', mediaType: 'audiobook', reason: 'unknownAuthor', message: 'The pack books have no author in the library' };
    const via: BookMatchType = isCriteria(author) ? 'criteria' : (found.find((f) => f.author.id === author.id)?.via ?? 'series');
    return { status: 'mapped', mediaType: 'audiobook', author, books: owned, isPack: true, matchType: via };
  }

  if (found.length === 0) {
    return {
      status: 'unknown',
      mediaType: 'audiobook',
      reason: 'unknownAuthor',
      message: `Unknown author: ${info.authors.length > 0 ? info.authors.join(', ') : '(none)'}`,
    };
  }

  const pool = allBooks(
    lib,
    found.map((f) => f.author),
  );
  const pick = pickBook(parsed, pool, criteria);
  if (pick && 'book' in pick) {
    const matched = found.find((f) => f.author.id === pick.book.authorId) ?? found[0]!;
    const author = ownerOf(pick.book, lib, matched.author)!;
    const via: BookMatchType = isCriteria(author) ? 'criteria' : pick.via === 'series' ? 'series' : matched.via;
    return { status: 'mapped', mediaType: 'audiobook', author, books: [pick.book], isPack: false, matchType: via };
  }
  if (pick) {
    return {
      status: 'ambiguous',
      mediaType: 'audiobook',
      reason: 'unknownBook',
      message: 'Release matches more than one book; search from the book to pick it',
      candidates: pick.ambiguous,
    };
  }
  const label = parsed.title ?? (parsed.series ? `${parsed.series}${parsed.seriesPosition ? ` #${parsed.seriesPosition}` : ''}` : '(none)');
  return { status: 'unknown', mediaType: 'audiobook', reason: 'unknownBook', message: `Unknown book: ${label}`, author: found[0]!.author };
}

/** Words that mark an uncategorised release as an audiobook (it then needs a library hit). */
const AUDIOBOOK_MARKER =
  /(?<![\p{L}\p{N}])(?:m4b|unabridged|abridged|audiobook|audio\s+book|h(?:ö|oe)rbuch|ungek(?:ü|ue)rzt|asin)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(?:narrated|read)\s+by(?![\p{L}\p{N}])/iu;
/** An Amazon/Audible ASIN (B0 + 8 capitals or digits). */
const ASIN_MARKER = /(?<![A-Za-z0-9])B0[0-9A-Z]{8}(?![A-Za-z0-9])/;

export function hasAudiobookMarker(title: string): boolean {
  return AUDIOBOOK_MARKER.test(title) || ASIN_MARKER.test(title);
}

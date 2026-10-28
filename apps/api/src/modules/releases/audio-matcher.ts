import { normalizeTitle, type MusicPackType, type ParsedMusicInfo } from '@arclight/parser';
import { albumPassesTypeProfile, type AlbumPrimaryType, type AlbumSecondaryType, type AlbumTypeProfile } from '@arclight/shared';
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

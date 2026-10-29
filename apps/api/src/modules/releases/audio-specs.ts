import { defaultQualitySize } from '@arclight/profiles-engine';
import { PROFILE_LANGUAGES } from '@arclight/shared';
import {
  albumMinutes,
  albumsGainedBy,
  bookMinutes,
  booksGainedBy,
  specifications,
  type Candidate,
  type DecisionContext,
  type SpecResult,
  type Specification,
} from './engine.js';

// Audio decision specs (docs/design/music-audiobooks.md 8.5). The shared specs in engine.ts run
// for music and audiobooks too (`appliesTo: 'all'`); these add what only albums or books need.

const DAY = 24 * 3_600_000;
const MB = 1024 * 1024;
/** Minutes assumed per track when an album's running time is not known yet. */
const MINUTES_PER_TRACK = 4;

function isUserInvoked(ctx: DecisionContext): boolean {
  return ctx.criteria?.userInvoked === true || ctx.source === 'userInvokedSearch' || ctx.source === 'interactiveSearch';
}

function releaseMs(date: string | null): number | null {
  if (!date) return null;
  const iso = /^\d{4}$/.test(date) ? `${date}-01-01` : /^\d{4}-\d{2}$/.test(date) ? `${date}-01` : date;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Albums a pack is wanted for: monitored ones it fills or upgrades. */
export function wantedPackAlbums(ctx: DecisionContext, c: Candidate): number[] {
  if (c.match.mediaType !== 'music') return [];
  const monitored = new Set(c.match.albums.filter((a) => a.monitored).map((a) => a.id));
  return albumsGainedBy(ctx, c).filter((id) => monitored.has(id));
}

/** Books a pack is wanted for: monitored ones it fills or upgrades. */
export function wantedPackBooks(ctx: DecisionContext, c: Candidate): number[] {
  if (c.match.mediaType !== 'audiobook') return [];
  const monitored = new Set(c.match.books.filter((b) => b.monitored).map((b) => b.id));
  return booksGainedBy(ctx, c).filter((id) => monitored.has(id));
}

const LANGUAGE_CODES = new Map(PROFILE_LANGUAGES.map((l) => [l.name.toLowerCase(), l.code]));

/** A catalogue language name ("english", "German") or ISO code ("en") as a lower-case ISO 639-1 code. */
export function languageCode(language: string): string {
  const l = language.trim().toLowerCase();
  if (/^[a-z]{2}$/.test(l)) return l;
  const base = /^([a-z]{2})[-_]/.exec(l);
  if (base) return base[1]!;
  return LANGUAGE_CODES.get(l) ?? l;
}

/** Minutes of audio the release should hold: album durations, else tracks × 4 min; book runtimes; 0 = unknown. */
export function expectedMinutes(c: Candidate): number {
  if (c.match.mediaType === 'audiobook') return bookMinutes(c.match);
  if (c.match.mediaType !== 'music') return 0;
  const known = albumMinutes(c.match);
  if (known > 0) return known;
  let minutes = 0;
  for (const a of c.match.albums) {
    if (a.durationMs && a.durationMs > 0) minutes += a.durationMs / 60_000;
    else if (a.trackCount > 0) minutes += a.trackCount * MINUTES_PER_TRACK;
    else return 0;
  }
  return minutes;
}

export const audioSpecifications: readonly Specification[] = [
  {
    // Albums with a release date more than a day away are not out yet (user searches may still grab).
    id: 'albumReleased',
    tier: 0,
    type: 'permanent',
    appliesTo: 'music',
    evaluate: (ctx, c) => {
      if (c.match.mediaType !== 'music' || isUserInvoked(ctx)) return null;
      const limit = ctx.now.getTime() + DAY;
      const unreleased = c.match.albums.filter((a) => {
        const ms = releaseMs(a.releaseDate);
        return ms !== null && ms > limit;
      });
      if (unreleased.length === 0 || (c.match.pack && unreleased.length < c.match.albums.length)) return null;
      return { reason: 'albumNotReleased', message: `Album has not been released yet (releases ${unreleased[0]!.releaseDate})` };
    },
  },
  {
    // Discography / multi-album packs: off for automatic grabs unless allowed, and then only
    // when they bring enough wanted albums. An interactive grab is the user's choice.
    id: 'discographyPack',
    tier: 0,
    type: 'permanent',
    appliesTo: 'music',
    evaluate: (ctx, c) => {
      if (c.match.mediaType !== 'music' || !c.match.pack) return null;
      if (ctx.source === 'interactiveSearch') return null;
      if (!ctx.settings.allowDiscographyPacks) {
        return { reason: 'discographyNotAllowed', message: 'Discography and multi-album packs are not grabbed automatically (Settings → Releases)' };
      }
      const wanted = wantedPackAlbums(ctx, c).length;
      const min = Math.max(1, ctx.settings.minPackWanted);
      return wanted >= min
        ? null
        : { reason: 'packTooFewWanted', message: `Pack brings ${wanted} wanted album${wanted === 1 ? '' : 's'}, at least ${min} needed` };
    },
  },
  {
    // Books with a release date more than a day away are not out yet (user searches may still grab).
    id: 'bookReleased',
    tier: 0,
    type: 'permanent',
    appliesTo: 'audiobook',
    evaluate: (ctx, c) => {
      if (c.match.mediaType !== 'audiobook' || isUserInvoked(ctx)) return null;
      const limit = ctx.now.getTime() + DAY;
      const unreleased = c.match.books.filter((b) => {
        const ms = releaseMs(b.releaseDate);
        return ms !== null && ms > limit;
      });
      if (unreleased.length === 0 || (c.match.isPack && unreleased.length < c.match.books.length)) return null;
      return { reason: 'bookNotReleased', message: `Book has not been released yet (releases ${unreleased[0]!.releaseDate})` };
    },
  },
  {
    // Series packs ("Books 1-5", "Complete Series"): off for automatic grabs unless allowed, and
    // then only when they bring enough wanted books. An interactive grab is the user's choice.
    id: 'bookPack',
    tier: 0,
    type: 'permanent',
    appliesTo: 'audiobook',
    evaluate: (ctx, c) => {
      if (c.match.mediaType !== 'audiobook' || !c.match.isPack) return null;
      if (ctx.source === 'interactiveSearch') return null;
      if (!ctx.settings.allowBookPacks) {
        return { reason: 'bookPackNotAllowed', message: 'Series packs are not grabbed automatically (Settings → Releases)' };
      }
      const wanted = wantedPackBooks(ctx, c).length;
      const min = Math.max(1, ctx.settings.minPackWanted);
      return wanted >= min
        ? null
        : { reason: 'packTooFewWanted', message: `Pack brings ${wanted} wanted book${wanted === 1 ? '' : 's'}, at least ${min} needed` };
    },
  },
  {
    // An abridged recording is not the unabridged book the catalogue lists (unless allowed).
    id: 'formatTypeMatch',
    tier: 0,
    type: 'permanent',
    appliesTo: 'audiobook',
    evaluate: (ctx, c) => {
      if (c.match.mediaType !== 'audiobook' || ctx.settings.allowAbridged) return null;
      if (c.audiobook?.formatType !== 'abridged') return null;
      const unabridged = c.match.books.filter((b) => b.formatType === 'unabridged');
      if (unabridged.length === 0) return null;
      return {
        reason: 'abridgedNotWanted',
        message: unabridged.length === 1 ? 'Release is abridged; the book is unabridged' : 'Release is abridged; the books are unabridged',
      };
    },
  },
  {
    // The language the release states must be one the author (or the book) is kept in.
    // Unknown on either side passes: most release names state no language.
    id: 'bookLanguage',
    tier: 0,
    type: 'permanent',
    appliesTo: 'audiobook',
    evaluate: (_ctx, c) => {
      if (c.match.mediaType !== 'audiobook') return null;
      const stated = c.audiobook?.language;
      if (!stated) return null;
      const wanted = new Set<string>();
      for (const l of c.match.author.languages) wanted.add(languageCode(l));
      for (const b of c.match.books) if (b.language) wanted.add(languageCode(b.language));
      if (wanted.size === 0) return null;
      const code = languageCode(stated);
      return wanted.has(code)
        ? null
        : { reason: 'wrongBookLanguage', message: `Release is in ${code}; wanted ${[...wanted].sort().join(', ')}` };
    },
  },
  {
    // A release far too small (or too large) for its codec and the running time (album
    // durations, book runtimes) is mislabelled or incomplete. Uses the built-in MB/min bands,
    // independent of the user's quality definition limits, with generous margins.
    id: 'audioSizePlausible',
    tier: 0,
    type: 'permanent',
    appliesTo: 'audio',
    evaluate: (_ctx, c): SpecResult | null => {
      if ((c.match.mediaType !== 'music' && c.match.mediaType !== 'audiobook') || c.release.size <= 0) return null;
      const band = defaultQualitySize(c.quality.quality.id);
      if (band.minSize === null || band.maxSize === null) return null;
      const minutes = expectedMinutes(c);
      if (minutes <= 0) return null;
      const min = band.minSize * 0.5 * minutes * MB;
      if (c.release.size < min) {
        return {
          reason: 'audioSizeImplausible',
          message: `${Math.round(c.release.size / MB)} MB is too small for ${Math.round(minutes)} min of ${c.quality.quality.name}`,
        };
      }
      // Packs often carry extras (scans, bonus discs, albums or books not in the library): no upper bound.
      if (c.match.mediaType === 'music' ? c.match.pack : c.match.isPack) return null;
      const max = band.maxSize * 2 * minutes * MB;
      if (c.release.size > max) {
        return {
          reason: 'audioSizeImplausible',
          message: `${Math.round(c.release.size / MB)} MB is too large for ${Math.round(minutes)} min of ${c.quality.quality.name}`,
        };
      }
      return null;
    },
  },
];

/** Every spec a music candidate goes through: the shared ones plus the album specs. */
export const musicSpecifications: readonly Specification[] = [...specifications, ...audioSpecifications];

/** Every spec an audiobook candidate goes through (the same list; `appliesTo` picks the book specs). */
export const audiobookSpecifications: readonly Specification[] = musicSpecifications;

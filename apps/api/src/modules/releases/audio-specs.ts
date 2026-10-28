import { defaultQualitySize } from '@arclight/profiles-engine';
import { albumMinutes, albumsGainedBy, specifications, type Candidate, type DecisionContext, type SpecResult, type Specification } from './engine.js';

// Music-only decision specs (docs/design/music-audiobooks.md 8.5). The shared specs in
// engine.ts run for music too (`appliesTo: 'all'`); these add what only albums need.

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

/** Minutes of audio the release should hold: album durations, else tracks × 4 min; 0 = unknown. */
export function expectedMinutes(c: Candidate): number {
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
    // A release far too small (or too large) for its codec and the album's running time is
    // mislabelled or incomplete. Uses the built-in MB/min bands, independent of the user's
    // quality definition limits, with generous margins.
    id: 'audioSizePlausible',
    tier: 0,
    type: 'permanent',
    appliesTo: 'music',
    evaluate: (_ctx, c): SpecResult | null => {
      if (c.match.mediaType !== 'music' || c.release.size <= 0) return null;
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
      // Packs often carry extras (scans, bonus discs, albums not in the library): no upper bound.
      if (c.match.pack) return null;
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

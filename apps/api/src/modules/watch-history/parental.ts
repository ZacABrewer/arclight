import { ContentRestrictions, type MovieCertification, type TvCertification } from '@arclight/shared';

// "Mirror Jellyfin parental controls" (media server setting `mirrorParentalControls`, default off).
// Jellyfin 10.11+ stores a user's limit as Policy.MaxParentalRating, a rating *score*. Its US
// ratings score as: G, TV-Y, TV-G = 0; TV-Y7 = 7; PG, TV-PG = 10; PG-13 = 13; TV-14 = 14;
// R, TV-MA = 17; NC-17 = 18. A score maps to the strictest US certification that still admits
// everything at or below it:
//
//   score   movie cap   tv cap
//   0-6     G           TV-G
//   7-9     G           TV-Y7     (PG scores 10, so 7-9 still only admits G movies)
//   10-12   PG          TV-PG
//   13      PG-13       TV-PG
//   14-16   PG-13       TV-14
//   17      R           (none: TV-MA allowed)
//   18+     (none)      (none)
//   no limit (null)     (none)  (none)
//
// Titles without a known US rating stay above any cap (Arclight's rule), whatever
// BlockUnratedItems says. `hideAdultContent` is never changed by mirroring.

/** Movie cap for a Jellyfin MaxParentalRating score (null = no cap). */
export function movieCapForScore(score: number | null): MovieCertification | null {
  if (score === null) return null;
  if (score < 10) return 'G';
  if (score < 13) return 'PG';
  if (score < 17) return 'PG-13';
  if (score < 18) return 'R';
  return null;
}

/** TV cap for a Jellyfin MaxParentalRating score (null = no cap). */
export function tvCapForScore(score: number | null): TvCertification | null {
  if (score === null) return null;
  if (score < 7) return 'TV-G';
  if (score < 10) return 'TV-Y7';
  if (score < 14) return 'TV-PG';
  if (score < 17) return 'TV-14';
  return null;
}

/** The content restrictions a linked user gets from their Jellyfin limit, keeping their own hideAdultContent. */
export function parentalRatingToCaps(score: number | null, current: unknown): ContentRestrictions {
  const parsed = ContentRestrictions.safeParse(current ?? {});
  const base = parsed.success ? parsed.data : ContentRestrictions.parse({});
  return { ...base, maxCertification: { movie: movieCapForScore(score), tv: tvCapForScore(score) } };
}

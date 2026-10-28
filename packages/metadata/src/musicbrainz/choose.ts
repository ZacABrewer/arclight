// Default edition choice for an album (release group): which of its releases to track.
// Order of preference: official status → preferred countries → preferred format →
// the most common track count among the candidates → earliest date. Ties fall back to the
// MBID so the pick is deterministic.

export interface ChoosableRelease {
  mbid: string;
  status?: string;
  country?: string;
  date?: string;
  /** Format of each medium. */
  formats: readonly string[];
  trackCount: number;
}

export interface ReleasePreferences {
  /** ISO-3166-1 codes (or "XW"/"XE"), most preferred first. Empty means no preference. */
  preferredCountries?: readonly string[];
  /** MusicBrainz medium formats, most preferred first. Defaults to Digital Media, then CD. */
  preferredFormats?: readonly string[];
}

export const DEFAULT_PREFERRED_FORMATS: readonly string[] = ['Digital Media', 'CD'];

function rankIn(list: readonly string[], value: string | undefined): number {
  if (value === undefined) return list.length;
  const index = list.findIndex((item) => item.toLowerCase() === value.toLowerCase());
  return index === -1 ? list.length : index;
}

/**
 * A release ranks by its least preferred medium, so a CD + DVD set does not pass for a
 * plain CD. Releases without media rank last.
 */
function formatRank(formats: readonly string[], preferred: readonly string[]): number {
  if (formats.length === 0) return preferred.length;
  return Math.max(...formats.map((f) => rankIn(preferred, f)));
}

/** Partial dates sort at the end of their period ("1997" after "1997-05-21"); undated last. */
function dateKey(date: string | undefined): string {
  if (!date) return '9999-99-99';
  const [year = '9999', month = '12', day = '31'] = date.split('-');
  return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/** Returns the preferred release, or undefined for an empty list. */
export function chooseRelease<T extends ChoosableRelease>(
  releases: readonly T[],
  prefs: ReleasePreferences = {},
): T | undefined {
  if (releases.length === 0) return undefined;
  const countries = prefs.preferredCountries ?? [];
  const formats = prefs.preferredFormats ?? DEFAULT_PREFERRED_FORMATS;

  const trackCountFrequency = new Map<number, number>();
  for (const r of releases) {
    trackCountFrequency.set(r.trackCount, (trackCountFrequency.get(r.trackCount) ?? 0) + 1);
  }

  const keyed = releases.map((release) => ({
    release,
    official: release.status?.toLowerCase() === 'official' ? 0 : 1,
    country: rankIn(countries, release.country),
    format: formatRank(release.formats, formats),
    commonness: -(trackCountFrequency.get(release.trackCount) ?? 0),
    date: dateKey(release.date),
  }));

  keyed.sort(
    (a, b) =>
      a.official - b.official ||
      a.country - b.country ||
      a.format - b.format ||
      a.commonness - b.commonness ||
      a.date.localeCompare(b.date) ||
      a.release.mbid.localeCompare(b.release.mbid),
  );
  return keyed[0]?.release;
}

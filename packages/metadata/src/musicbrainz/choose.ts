// Default edition choice for an album (release group): which of its releases to track.
// Order of preference: official status → edition preference (when set) → preferred countries →
// preferred format → the most common track count among the candidates → earliest date. Ties
// fall back to the MBID so the pick is deterministic.

export interface ChoosableRelease {
  mbid: string;
  status?: string;
  country?: string;
  date?: string;
  /** Format of each medium. */
  formats: readonly string[];
  trackCount: number;
  /** Release title and disambiguation: where "Deluxe Edition" or "2011 Remaster" shows up. */
  title?: string;
  disambiguation?: string;
}

/** See `EditionPreference` in @arclight/shared. */
export type ReleaseEditionPreference = 'any' | 'original' | 'standard' | 'deluxe' | 'remaster';

export interface ReleasePreferences {
  /** ISO-3166-1 codes (or "XW"/"XE"), most preferred first. Empty means no preference. */
  preferredCountries?: readonly string[];
  /** MusicBrainz medium formats, most preferred first. Defaults to Digital Media, then CD. */
  preferredFormats?: readonly string[];
  /** Which kind of edition wins before country and format are compared. Default `any`. */
  edition?: ReleaseEditionPreference;
}

const DELUXE_RE = /\b(deluxe|expanded|bonus tracks?|anniversary|collector['’]?s(?: edition)?|(?:special|extended|legacy|limited|platinum|tour) (?:edition|version))\b/i;
const REMASTER_RE = /\bre-?master(?:ed)?\b/i;

/** What kind of edition a release is, from its title and disambiguation. */
export function editionKind(release: Pick<ChoosableRelease, 'title' | 'disambiguation'>): { deluxe: boolean; remaster: boolean } {
  const text = `${release.title ?? ''} ${release.disambiguation ?? ''}`;
  return { deluxe: DELUXE_RE.test(text), remaster: REMASTER_RE.test(text) };
}

/** Lower ranks win. `original` is handled by the date ordering instead. */
function editionRank(release: ChoosableRelease, pref: ReleaseEditionPreference): number {
  if (pref === 'any' || pref === 'original') return 0;
  const { deluxe, remaster } = editionKind(release);
  if (pref === 'standard') return (deluxe ? 2 : 0) + (remaster ? 1 : 0);
  if (pref === 'deluxe') return deluxe ? 0 : 1;
  return remaster ? 0 : 1;
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
  const edition = prefs.edition ?? 'any';

  const trackCountFrequency = new Map<number, number>();
  for (const r of releases) {
    trackCountFrequency.set(r.trackCount, (trackCountFrequency.get(r.trackCount) ?? 0) + 1);
  }

  const keyed = releases.map((release) => ({
    release,
    official: release.status?.toLowerCase() === 'official' ? 0 : 1,
    edition: editionRank(release, edition),
    // Original: the first release of the group, whatever its country or format.
    originalDate: edition === 'original' ? dateKey(release.date) : '',
    // Deluxe: among deluxe editions in the preferred country and format, the most complete one.
    size: edition === 'deluxe' ? -release.trackCount : 0,
    country: rankIn(countries, release.country),
    format: formatRank(release.formats, formats),
    commonness: -(trackCountFrequency.get(release.trackCount) ?? 0),
    date: dateKey(release.date),
  }));

  keyed.sort(
    (a, b) =>
      a.official - b.official ||
      a.edition - b.edition ||
      a.originalDate.localeCompare(b.originalDate) ||
      a.country - b.country ||
      a.format - b.format ||
      a.size - b.size ||
      a.commonness - b.commonness ||
      a.date.localeCompare(b.date) ||
      a.release.mbid.localeCompare(b.release.mbid),
  );
  return keyed[0]?.release;
}

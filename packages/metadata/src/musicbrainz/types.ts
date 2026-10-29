// Clean MusicBrainz output types. The WS/2 wire format never leaks past ./map.ts.
// Deliberately independent of @arclight/shared; the music module maps these onto the
// API contract. Dates are ISO-8601 (possibly partial: "1997", "1997-05"), durations are
// milliseconds.

export type MbArtistStatus = 'continuing' | 'ended';

export interface MbSearchPage<T> {
  /** Total matches MusicBrainz reports. */
  count: number;
  offset: number;
  results: T[];
}

export interface MbArtistCredit {
  artistMbid: string;
  /** The artist's canonical name. */
  name: string;
  /** The name as printed on this credit (may differ from `name`). */
  creditedName: string;
  /** Text joining this credit to the next (" & ", " feat. "); empty for the last one. */
  joinPhrase: string;
}

export interface MbAlias {
  name: string;
  sortName: string;
  locale?: string;
  primary: boolean;
  type?: string;
}

export interface MbLink {
  /** MusicBrainz relationship type: "wikidata", "official homepage", "discogs", ... */
  type: string;
  url: string;
}

export interface MbArtistSearchResult {
  mbid: string;
  name: string;
  sortName: string;
  disambiguation?: string;
  /** "Group", "Person", "Orchestra", ... */
  type?: string;
  /** ISO-3166-1 code. */
  country?: string;
  area?: string;
  beginDate?: string;
  endDate?: string;
  status: MbArtistStatus;
  /** Search relevance 0–100. */
  score: number;
}

export interface MbArtist {
  mbid: string;
  name: string;
  sortName: string;
  disambiguation?: string;
  type?: string;
  country?: string;
  area?: string;
  beginDate?: string;
  endDate?: string;
  status: MbArtistStatus;
  /** Genre names, most-voted first. */
  genres: string[];
  aliases: MbAlias[];
  links: MbLink[];
}

export interface MbReleaseGroup {
  mbid: string;
  title: string;
  disambiguation?: string;
  /** "Album", "EP", "Single", "Broadcast", "Other". */
  primaryType?: string;
  /** "Compilation", "Live", "Remix", "Soundtrack", ... */
  secondaryTypes: string[];
  firstReleaseDate?: string;
  year?: number;
  /** Present on search results; empty for browse results. */
  artistCredits: MbArtistCredit[];
  /** Search relevance 0–100; search results only. */
  score?: number;
}

/** One release group by id (lookup with artist credits and genres). */
export interface MbReleaseGroupDetail extends MbReleaseGroup {
  /** Genre names, most-voted first. */
  genres: string[];
}

export interface MbMediumSummary {
  /** 1-based disc position. */
  position: number;
  /** "CD", "Digital Media", '12" Vinyl', ... */
  format?: string;
  title?: string;
  trackCount: number;
}

export interface MbReleaseSummary {
  mbid: string;
  releaseGroupMbid?: string;
  title: string;
  /** "Official", "Promotion", "Bootleg", "Pseudo-Release". */
  status?: string;
  /** ISO-3166-1 code, or MusicBrainz's "XW" (worldwide) / "XE" (Europe). */
  country?: string;
  date?: string;
  year?: number;
  disambiguation?: string;
  barcode?: string;
  /** Format of each medium, in disc order (duplicates kept). */
  formats: string[];
  mediumCount: number;
  trackCount: number;
  media: MbMediumSummary[];
}

export interface MbTrack {
  /** MusicBrainz track id (specific to this release). */
  mbid: string;
  recordingMbid: string;
  title: string;
  /** Number as printed ("1", "A1", ...). */
  number: string;
  /** 1-based position on its medium. */
  position: number;
  mediumNumber: number;
  /** 1-based position across the whole release. */
  absoluteNumber: number;
  durationMs?: number;
  artistCredits: MbArtistCredit[];
}

export interface MbMedium extends MbMediumSummary {
  tracks: MbTrack[];
}

export interface MbLabel {
  name: string;
  mbid?: string;
  catalogNumber?: string;
}

export interface MbRelease extends Omit<MbReleaseSummary, 'media'> {
  artistCredits: MbArtistCredit[];
  labels: MbLabel[];
  /** Sum of the known track durations. */
  durationMs?: number;
  media: MbMedium[];
}

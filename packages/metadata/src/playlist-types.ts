// Shape shared by the playlist sources (Spotify, Deezer, Last.fm, ListenBrainz): one entry as
// the source lists it, before anything is matched against MusicBrainz or the library. Every
// field past title/artist is best effort; ids are only present when the source knows them.

export interface SourcePlaylistTrack {
  title: string;
  /** The credited artist as one string ("A & B"). */
  artist: string;
  album?: string;
  /** "album", "single", "compilation" (Spotify album_type), when known. */
  albumType?: string;
  /** `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. */
  releaseDate?: string;
  durationMs?: number;
  isrc?: string;
  recordingMbid?: string;
  releaseMbid?: string;
  /** First = primary. */
  artistMbids?: string[];
  /** The source's own id of the track (Spotify / Deezer track id). */
  sourceId?: string;
}

export interface SourcePlaylist {
  /** The source's id of the playlist. */
  id: string;
  title: string;
  description?: string;
  owner?: string;
  tracks: SourcePlaylistTrack[];
}

const MBID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The MBID inside a MusicBrainz/ListenBrainz URL (or a bare MBID), lower-cased. */
export function mbidFrom(value: string | null | undefined): string | undefined {
  const match = value ? MBID_RE.exec(value) : null;
  return match ? match[0].toLowerCase() : undefined;
}

/** Trimmed non-empty string or undefined. */
export function cleanText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Upper-cased 12-character ISRC, or undefined. */
export function cleanIsrc(value: string | null | undefined): string | undefined {
  const v = value?.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return v && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(v) ? v : undefined;
}

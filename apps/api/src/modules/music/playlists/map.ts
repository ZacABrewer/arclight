import { dirname, isAbsolute, relative } from 'node:path';
import type {
  LastfmSimilarArtist,
  LbSimilarArtist,
  MbRecording,
  MbRecordingRelease,
  MbRecordingReleaseGroup,
  SourcePlaylistTrack,
} from '@arclight/metadata';
import type { PlaylistEntryStatus, SimilarArtistSource } from '@arclight/shared';

// Pure playlist matching: comparing source tracks with MusicBrainz recordings, picking the
// release group a track should come from, the entry status, the .m3u8 text, matching library
// files to a media server's items, and merging similar-artist lists. No I/O here.

// ---------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------

/** Version notes that do not make a different song: "(Remastered 2011)", "- Radio Edit", "[Mono]". */
const VERSION_NOTE = /\b(remaster(ed)?|re-?master|mono|stereo|single version|album version|radio edit|edit|deluxe|bonus track|explicit|clean|original mix)\b/i;

/** "Song (feat. X)", "Song - Remastered 2011" → "Song". Keeps notes that do change the song (live, remix, acoustic). */
export function baseTitle(title: string): string {
  let t = title.replace(/\s*[([](feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/gi, '');
  t = t.replace(/\s*[([]([^)\]]*)[)\]]/g, (whole, inner: string) => (VERSION_NOTE.test(inner) ? '' : whole));
  t = t.replace(/\s+-\s+([^-]*)$/, (whole, tail: string) => (VERSION_NOTE.test(tail) ? '' : whole));
  return t.trim() || title.trim();
}

/** Lower case, no accents, "&" as "and", punctuation removed, single spaces. */
export function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’'`´]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  const t = s.replace(/ /g, '');
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** 0-1 likeness of two strings (Dice coefficient over character pairs of the normalized text). */
export function similarity(a: string, b: string): number {
  const x = normalize(a);
  const y = normalize(b);
  if (x === y) return x.length > 0 ? 1 : 0;
  if (x.length < 2 || y.length < 2) return 0;
  const gx = bigrams(x);
  const gy = bigrams(y);
  let overlap = 0;
  let total = 0;
  for (const n of gx.values()) total += n;
  for (const n of gy.values()) total += n;
  for (const [g, n] of gx) overlap += Math.min(n, gy.get(g) ?? 0);
  return total === 0 ? 0 : (2 * overlap) / total;
}

/** The artists named in a credit line: "A feat. B", "A, B & C", "A x B". */
export function creditedArtists(credit: string): string[] {
  return credit
    .split(/\s*(?:,|&|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\s[x×]\s|\/|;)\s*/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The best likeness between any artist in the source credit and any credited on the recording. */
export function artistSimilarity(sourceCredit: string, names: readonly string[]): number {
  if (names.length === 0) return 0;
  const joined = names.join(' ');
  let best = similarity(sourceCredit, joined);
  for (const a of creditedArtists(sourceCredit)) for (const n of names) best = Math.max(best, similarity(a, n));
  return best;
}

// ---------------------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------------------

export const RECORDING_MATCH_THRESHOLD = 0.75;

/** 0-1: how well a recording fits a source track (title 55 %, artist 30 %, length 15 %). */
export function scoreRecording(track: SourcePlaylistTrack, rec: MbRecording): number {
  const title = Math.max(similarity(track.title, rec.title), similarity(baseTitle(track.title), baseTitle(rec.title)));
  const names = rec.artistCredits.flatMap((c) => [c.name, c.creditedName]);
  const artist = artistSimilarity(track.artist, names);
  let length = 0.5;
  if (track.durationMs !== undefined && rec.durationMs !== undefined) {
    const diff = Math.abs(track.durationMs - rec.durationMs);
    length = diff <= 3000 ? 1 : diff <= 10_000 ? 0.6 : diff <= 30_000 ? 0.2 : 0;
  }
  let score = title * 0.55 + artist * 0.3 + length * 0.15;
  if (track.isrc && rec.isrcs.includes(track.isrc)) score = Math.min(1, score + 0.1);
  return Math.round(score * 1000) / 1000;
}

/** The best-fitting recording at or above the threshold. */
export function pickRecording(track: SourcePlaylistTrack, candidates: readonly MbRecording[], threshold = RECORDING_MATCH_THRESHOLD): MbRecording | undefined {
  let best: { rec: MbRecording; score: number } | undefined;
  for (const rec of candidates) {
    const score = scoreRecording(track, rec);
    if (score >= threshold && (!best || score > best.score)) best = { rec, score };
  }
  return best?.rec;
}

const TYPE_RANK: Record<string, number> = { album: 3, ep: 2, single: 1 };

function dateKey(date: string | undefined): string {
  return date && /^\d{4}/.test(date) ? date : '9999';
}

export interface ReleaseChoice {
  release: MbRecordingRelease;
  releaseGroup: MbRecordingReleaseGroup;
}

/**
 * The release group a playlist track should be wanted from: the one named like the source's
 * album when that fits, else an official studio album over EPs and singles, without
 * compilation/live/soundtrack types, earliest first.
 */
export function chooseReleaseGroup(track: Pick<SourcePlaylistTrack, 'album' | 'releaseMbid'>, rec: MbRecording): ReleaseChoice | undefined {
  const options = rec.releases.filter((r): r is MbRecordingRelease & { releaseGroup: MbRecordingReleaseGroup } => r.releaseGroup !== undefined);
  if (options.length === 0) return undefined;
  if (track.releaseMbid) {
    const exact = options.find((r) => r.mbid === track.releaseMbid);
    if (exact) return { release: exact, releaseGroup: exact.releaseGroup };
  }
  // Stores label singles and EPs "Title - Single" / "Title - EP".
  const album = track.album?.replace(/\s+-\s+(single|ep)$/i, '');
  const score = (r: MbRecordingRelease & { releaseGroup: MbRecordingReleaseGroup }): number => {
    const g = r.releaseGroup;
    let s = 0;
    if (album) {
      const sim = Math.max(similarity(album, g.title), similarity(baseTitle(album), baseTitle(g.title)));
      if (sim >= 0.85) s += 100;
    }
    if (!r.status || r.status.toLowerCase() === 'official') s += 20;
    s += (TYPE_RANK[(g.primaryType ?? '').toLowerCase()] ?? 0) * 5;
    if (g.secondaryTypes.length === 0) s += 10;
    return s;
  };
  const sorted = [...options].sort(
    (a, b) =>
      score(b) - score(a) ||
      dateKey(a.releaseGroup.firstReleaseDate ?? a.date).localeCompare(dateKey(b.releaseGroup.firstReleaseDate ?? b.date)) ||
      a.releaseGroup.mbid.localeCompare(b.releaseGroup.mbid),
  );
  const pick = sorted[0]!;
  return { release: pick, releaseGroup: pick.releaseGroup };
}

/** The first credited artist's MBID (the one the library files the album under). */
export function primaryArtistMbid(rec: MbRecording): string | undefined {
  return rec.artistCredits[0]?.artistMbid;
}

// ---------------------------------------------------------------------------------------
// Library state
// ---------------------------------------------------------------------------------------

export interface LibraryHit {
  artistId?: number | undefined;
  albumId?: number | undefined;
  trackId?: number | undefined;
  hasFile?: boolean | undefined;
  albumMonitored?: boolean | undefined;
  /** Undefined while the track has no own monitored flag. */
  trackMonitored?: boolean | undefined;
}

export function entryStatus(matched: boolean, hit: LibraryHit, artistAdded: boolean): PlaylistEntryStatus {
  if (hit.hasFile) return 'available';
  if (hit.albumId !== undefined) {
    if (hit.albumMonitored && hit.trackMonitored !== false) return 'wanted';
    return 'notMonitored';
  }
  if (hit.artistId !== undefined) return artistAdded ? 'artistAdded' : 'notMonitored';
  if (artistAdded) return 'artistAdded';
  return matched ? 'matched' : 'unmatched';
}

/**
 * `tracks` mode on an album the playlist owns: exactly the listed tracks are monitored.
 * Returns the ids whose flag must change.
 */
export function trackMonitoringChanges(
  albumTracks: ReadonlyArray<{ id: number; monitored: boolean }>,
  listed: ReadonlySet<number>,
): { monitor: number[]; unmonitor: number[] } {
  const monitor: number[] = [];
  const unmonitor: number[] = [];
  for (const t of albumTracks) {
    const want = listed.has(t.id);
    if (want && !t.monitored) monitor.push(t.id);
    if (!want && t.monitored) unmonitor.push(t.id);
  }
  return { monitor, unmonitor };
}

/** Whether a scheduled sync is due. Interval 0 = manual only. */
export function isSyncDue(p: { enabled: boolean; syncIntervalHours: number; lastSyncAt: string | null; lastSyncStatus: string }, now: Date): boolean {
  if (!p.enabled || p.syncIntervalHours <= 0 || p.lastSyncStatus === 'running') return false;
  if (!p.lastSyncAt) return true;
  const last = Date.parse(p.lastSyncAt);
  return Number.isNaN(last) || now.getTime() - last >= p.syncIntervalHours * 3_600_000 - 60_000;
}

// ---------------------------------------------------------------------------------------
// .m3u8
// ---------------------------------------------------------------------------------------

export interface M3uItem {
  path: string;
  title: string;
  artist: string;
  durationMs?: number | null | undefined;
}

/** A file name from a playlist name: no path separators or characters Windows refuses. */
export function playlistFileName(name: string): string {
  const base = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return `${base || 'playlist'}.m3u8`;
}

/** The path as written into the playlist: relative to the playlist's folder (with `/`) or absolute. */
export function m3uEntryPath(filePath: string, playlistPath: string, mode: 'relative' | 'absolute'): string {
  if (mode === 'absolute' || !isAbsolute(filePath)) return filePath;
  const rel = relative(dirname(playlistPath), filePath);
  if (rel === '' || isAbsolute(rel)) return filePath;
  return rel.replace(/\\/g, '/');
}

/** Extended M3U, UTF-8 (.m3u8). Lines are single-line: breaks in titles become spaces. */
export function renderM3u8(title: string, items: readonly M3uItem[], playlistPath: string, mode: 'relative' | 'absolute'): string {
  const line = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
  const out = ['#EXTM3U', `#PLAYLIST:${line(title)}`];
  for (const item of items) {
    const secs = item.durationMs ? Math.round(item.durationMs / 1000) : -1;
    out.push(`#EXTINF:${secs},${line(item.artist)} - ${line(item.title)}`);
    out.push(m3uEntryPath(item.path, playlistPath, mode));
  }
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------
// Media server items
// ---------------------------------------------------------------------------------------

export interface RemoteTrack {
  id: string;
  path?: string | undefined;
  recordingMbid?: string | undefined;
  title?: string | undefined;
  artist?: string | undefined;
  durationMs?: number | undefined;
}

export interface LocalTrack {
  path: string;
  recordingMbid?: string | undefined;
  title: string;
  artist: string;
  durationMs?: number | null | undefined;
}

/** The last `n` path segments, lower case with `/`: survives different mount points. */
export function pathTail(path: string, n = 3): string {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s.length > 0)
    .slice(-n)
    .join('/')
    .toLowerCase();
}

/** Lookup tables over a media server's tracks, built once per push. */
export function indexRemoteTracks(items: readonly RemoteTrack[]): (local: LocalTrack) => RemoteTrack | undefined {
  const byMbid = new Map<string, RemoteTrack>();
  const byTail3 = new Map<string, RemoteTrack>();
  const byTail2 = new Map<string, RemoteTrack>();
  const byTitle = new Map<string, RemoteTrack[]>();
  for (const item of items) {
    if (item.recordingMbid) byMbid.set(item.recordingMbid.toLowerCase(), item);
    if (item.path) {
      byTail3.set(pathTail(item.path, 3), item);
      byTail2.set(pathTail(item.path, 2), item);
    }
    if (item.title) {
      const key = normalize(baseTitle(item.title));
      byTitle.set(key, [...(byTitle.get(key) ?? []), item]);
    }
  }
  return (local) => {
    const mbid = local.recordingMbid?.toLowerCase();
    const viaMbid = mbid ? byMbid.get(mbid) : undefined;
    if (viaMbid) return viaMbid;
    const viaPath = byTail3.get(pathTail(local.path, 3)) ?? byTail2.get(pathTail(local.path, 2));
    if (viaPath) return viaPath;
    const same = byTitle.get(normalize(baseTitle(local.title))) ?? [];
    return same.find((r) => {
      if (!r.artist || artistSimilarity(local.artist, [r.artist]) < 0.9) return false;
      if (local.durationMs && r.durationMs) return Math.abs(local.durationMs - r.durationMs) <= 3000;
      return true;
    });
  };
}

// ---------------------------------------------------------------------------------------
// Similar artists
// ---------------------------------------------------------------------------------------

export interface MergedSimilarArtist {
  mbid: string;
  name: string;
  score: number;
  source: SimilarArtistSource;
}

/**
 * ListenBrainz scores are raw counts (scaled here to 0-1 by the top one); Last.fm's match is
 * already 0-1. Artists both list get the higher score plus a small bonus. Last.fm artists
 * without an MBID are dropped (they cannot be added or linked).
 */
export function mergeSimilarArtists(lb: readonly LbSimilarArtist[], lf: readonly LastfmSimilarArtist[], selfMbid: string, limit: number): MergedSimilarArtist[] {
  const self = selfMbid.toLowerCase();
  const top = Math.max(0, ...lb.map((a) => a.score));
  const out = new Map<string, MergedSimilarArtist>();
  for (const a of lb) {
    const mbid = a.mbid.toLowerCase();
    if (mbid === self || out.has(mbid)) continue;
    out.set(mbid, { mbid, name: a.name, score: top > 0 ? a.score / top : 0, source: 'listenbrainz' });
  }
  for (const a of lf) {
    const mbid = a.mbid?.toLowerCase();
    if (!mbid || mbid === self) continue;
    const match = Math.max(0, Math.min(1, a.match));
    const known = out.get(mbid);
    if (known && known.source === 'listenbrainz') {
      out.set(mbid, { ...known, score: Math.min(1, Math.max(known.score, match) + 0.1), source: 'both' });
    } else if (!known) {
      out.set(mbid, { mbid, name: a.name, score: match, source: 'lastfm' });
    }
  }
  return [...out.values()]
    .map((a) => ({ ...a, score: Math.round(a.score * 1000) / 1000 }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, Math.max(0, limit));
}

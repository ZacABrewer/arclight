import { basename } from 'node:path';
import { normalizeTitle } from '@arclight/parser';

// Matching an album group's files to a release's tracks (design 9.2). Pure: no I/O.
//
// Per (file, track) pair a score in 0..1 blends title similarity, duration fit (±7 s, or ±3%
// for tracks over 4 min), disc/track numbers and, when both sides carry one, the artist; an
// equal MusicBrainz recording id lifts the pair to near-certain. The files are assigned to
// tracks one-to-one by maximum total score (Hungarian method). The release's confidence is the
// mean pair score over the files (unmatched files count 0) scaled by track coverage, plus a
// recording-id bonus. The best release at or above the threshold (default 0.8) is accepted.
//
// The input shapes are matcher-specific on purpose (media nested, positions per medium, opaque
// `ref`s) rather than the API's `AlbumRelease` / `Track`: the music service builds them from the
// `album_releases` and `tracks` rows (`knownAlbumsFor`), with `ref` carrying the row ids through.

export interface TrackCandidate {
  /** Position on its medium, 1-based (MusicBrainz `position`). */
  position: number;
  /** Display number ("3", "A3"); informational. */
  number?: string | null;
  title: string;
  durationMs: number | null;
  recordingId: string | null;
  /** MusicBrainz track id (release-specific). */
  trackId?: string | null;
  /** Track artist credit; used for compilations. */
  artist?: string | null;
  /** Opaque passthrough (e.g. the `tracks.id` row). */
  ref?: unknown;
}

export interface MediumCandidate {
  /** Disc number, 1-based. */
  position: number;
  format?: string | null;
  tracks: TrackCandidate[];
}

export interface ReleaseCandidate {
  id: string;
  title?: string | null;
  media: MediumCandidate[];
  /** The album's currently selected release; wins exact ties. */
  preferred?: boolean;
  /** Opaque passthrough (e.g. the `album_releases.id` row). */
  ref?: unknown;
}

export interface MatchFile {
  path: string;
  title: string | null;
  artist: string | null;
  trackNo: number | null;
  discNo: number | null;
  durationMs: number | null;
  mbRecordingId: string | null;
  mbReleaseId: string | null;
}

export interface FileTrackMatch {
  path: string;
  mediumNumber: number;
  trackPosition: number;
  /** 1-based position across the whole release. */
  absolutePosition: number;
  trackNumber: string | null;
  title: string;
  recordingId: string | null;
  trackId: string | null;
  ref: unknown;
  score: number;
  recordingIdMatch: boolean;
}

export interface MissingTrack {
  mediumNumber: number;
  trackPosition: number;
  title: string;
  recordingId: string | null;
  ref: unknown;
}

export interface ReleaseMatch {
  releaseId: string;
  ref: unknown;
  confidence: number;
  accepted: boolean;
  mapping: FileTrackMatch[];
  unmatchedFiles: string[];
  missingTracks: MissingTrack[];
  stats: {
    fileCount: number;
    trackCount: number;
    matchedCount: number;
    recordingIdMatches: number;
    /** Mean pair score over the files. */
    quality: number;
    /** Matched tracks / release tracks. */
    coverage: number;
  };
}

export interface TrackMatchResult {
  threshold: number;
  accepted: boolean;
  /** Highest-confidence release (accepted or not); null without candidates or files. */
  best: ReleaseMatch | null;
  /** Every release, best first. */
  candidates: ReleaseMatch[];
}

export interface TrackMatchOptions {
  /** `audio.trackMatchThreshold`. Default 0.8. */
  threshold?: number;
  /** Pairs scoring below this stay unmatched. Default 0.5. */
  minPairScore?: number;
}

export const DEFAULT_TRACK_MATCH_THRESHOLD = 0.8;

// ---------------------------------------------------------------------------------------
// Title handling
// ---------------------------------------------------------------------------------------

// Decorations that do not change which track it is. Live/demo/mono/remix/acoustic stay: they
// name different recordings that can sit side by side on deluxe editions.
const TITLE_NOISE = [
  /\s*[([](?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/gi,
  /\s+(?:feat\.?|ft\.?|featuring)\s.*$/i,
  /\s*[([][^)\]]*\b(?:remaster(?:ed)?|bonus(?: track)?|explicit|album version|lp version|single edit)\b[^)\]]*[)\]]/gi,
  /\s+-\s+(?:\d{4}\s+)?(?:digital(?:ly)?\s+)?remaster(?:ed)?(?:\s+\d{4})?(?:\s+version)?\s*$/i,
];

/** Compact comparison key: noise stripped, then `@arclight/parser`'s `normalizeTitle`. */
export function trackTitleKey(title: string): string {
  let t = title;
  for (const re of TITLE_NOISE) t = t.replace(re, '');
  return normalizeTitle(t.trim() || title) || normalizeTitle(title) || title.toLowerCase();
}

function bigrams(s: string): Map<string, number> {
  const chars = Array.from(s);
  const out = new Map<string, number>();
  if (chars.length === 1) out.set(chars[0]!, 1);
  for (let i = 0; i < chars.length - 1; i++) {
    const g = chars[i]! + chars[i + 1]!;
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

function dice(a: Map<string, number>, b: Map<string, number>): number {
  let inter = 0;
  let total = 0;
  for (const n of a.values()) total += n;
  for (const n of b.values()) total += n;
  for (const [g, n] of a) inter += Math.min(n, b.get(g) ?? 0);
  return total === 0 ? 0 : (2 * inter) / total;
}

interface PreparedText {
  key: string;
  grams: Map<string, number>;
}

function prepare(text: string): PreparedText {
  const key = trackTitleKey(text);
  return { key, grams: bigrams(key) };
}

function similarity(a: PreparedText, b: PreparedText): number {
  if (!a.key || !b.key) return 0;
  if (a.key === b.key) return 1;
  // One title inside the other ("Song" vs "Song Part I") is close but not equal.
  const contained = a.key.includes(b.key) || b.key.includes(a.key) ? 0.85 * (Math.min(a.key.length, b.key.length) / Math.max(a.key.length, b.key.length)) ** 0.25 : 0;
  return Math.max(dice(a.grams, b.grams), contained);
}

/** Public helper for title similarity (0..1) after normalisation. */
export function titleSimilarity(a: string, b: string): number {
  return similarity(prepare(a), prepare(b));
}

// ---------------------------------------------------------------------------------------
// File-name fallbacks
// ---------------------------------------------------------------------------------------

/** "1-05 - Artist - Title.flac" -> {disc: 1, track: 5, title: "Title"}. */
export function parseTrackFileName(fileName: string): { discNo: number | null; trackNo: number | null; title: string | null } {
  const name = basename(fileName).replace(/\.[a-z0-9]{2,4}$/i, '');
  let rest = name.trim();
  let discNo: number | null = null;
  let trackNo: number | null = null;
  const discTrack = /^(\d{1,2})[-.](\d{1,3})(?=[\s._-]|$)/.exec(rest);
  const plain = /^(\d{1,3})(?=[\s._-]|$)/.exec(rest);
  if (discTrack) {
    discNo = Number(discTrack[1]);
    trackNo = Number(discTrack[2]);
    rest = rest.slice(discTrack[0].length);
  } else if (plain) {
    const digits = plain[1]!;
    if (digits.length === 3 && Number(digits.slice(1)) > 0) {
      discNo = Number(digits[0]);
      trackNo = Number(digits.slice(1));
    } else trackNo = Number(digits);
    rest = rest.slice(plain[0].length);
  }
  rest = rest.replace(/^[\s._-]+/, '').replace(/_/g, ' ');
  const parts = rest.split(/\s+-\s+/);
  const title = (parts[parts.length - 1] ?? '').trim() || null;
  return { discNo: discNo && discNo > 0 ? discNo : null, trackNo: trackNo && trackNo > 0 ? trackNo : null, title };
}

/** Build a MatchFile from scan output, falling back to the file name for missing tags. */
export function matchFileFrom(file: {
  path: string;
  tags: {
    title: string | null;
    artist: string | null;
    trackNo: number | null;
    discNo: number | null;
    durationMs: number | null;
    mbRecordingId: string | null;
    mbReleaseId: string | null;
  } | null;
  discFromFolder?: number | null;
}): MatchFile {
  const parsed = parseTrackFileName(file.path);
  const t = file.tags;
  return {
    path: file.path,
    title: t?.title ?? parsed.title,
    artist: t?.artist ?? null,
    trackNo: t?.trackNo ?? parsed.trackNo,
    discNo: t?.discNo ?? file.discFromFolder ?? parsed.discNo,
    durationMs: t?.durationMs ?? null,
    mbRecordingId: t?.mbRecordingId ?? null,
    mbReleaseId: t?.mbReleaseId ?? null,
  };
}

// ---------------------------------------------------------------------------------------
// Pair scoring
// ---------------------------------------------------------------------------------------

/** Duration tolerance for a track: ±7 s, or ±3% for tracks over 4 minutes. */
export function durationToleranceMs(trackMs: number): number {
  return trackMs > 240_000 ? trackMs * 0.03 : 7_000;
}

/** 1 for an exact fit, 0.7 at the tolerance, 0 at three times the tolerance. */
export function durationScore(fileMs: number, trackMs: number): number {
  const tol = durationToleranceMs(trackMs);
  const delta = Math.abs(fileMs - trackMs);
  if (delta <= tol) return 1 - 0.3 * (delta / tol);
  if (delta <= 3 * tol) return 0.7 * (1 - (delta - tol) / (2 * tol));
  return 0;
}

interface FlatTrack {
  track: TrackCandidate;
  medium: number;
  absolute: number;
  mediumCount: number;
  title: PreparedText;
  artist: PreparedText | null;
}

interface PreparedFile {
  file: MatchFile;
  title: PreparedText | null;
  artist: PreparedText | null;
}

const WEIGHTS = { title: 0.45, duration: 0.3, position: 0.25, artist: 0.1 };

function positionScore(f: MatchFile, t: FlatTrack): number | null {
  if (f.trackNo == null) return null;
  const sameTrack = f.trackNo === t.track.position;
  if (sameTrack && (f.discNo === t.medium || (f.discNo == null && t.mediumCount === 1))) return 1;
  if (sameTrack && f.discNo == null) return 0.6; // multi-disc without disc tags: ambiguous
  if (f.trackNo === t.absolute && t.mediumCount > 1 && (f.discNo == null || f.discNo === 1)) return 0.85; // numbered across discs
  if (sameTrack) return 0.3; // right number, wrong disc
  return 0;
}

function pairScore(pf: PreparedFile, t: FlatTrack): { score: number; recordingIdMatch: boolean } {
  const f = pf.file;
  let sum = 0;
  let weight = 0;
  if (pf.title) {
    sum += WEIGHTS.title * similarity(pf.title, t.title);
    weight += WEIGHTS.title;
  }
  if (f.durationMs != null && t.track.durationMs != null && t.track.durationMs > 0) {
    sum += WEIGHTS.duration * durationScore(f.durationMs, t.track.durationMs);
    weight += WEIGHTS.duration;
  }
  const pos = positionScore(f, t);
  if (pos != null) {
    sum += WEIGHTS.position * pos;
    weight += WEIGHTS.position;
  }
  if (pf.artist && t.artist) {
    sum += WEIGHTS.artist * similarity(pf.artist, t.artist);
    weight += WEIGHTS.artist;
  }
  let score = weight > 0 ? sum / weight : 0;
  let recordingIdMatch = false;
  if (f.mbRecordingId && t.track.recordingId) {
    if (f.mbRecordingId.toLowerCase() === t.track.recordingId.toLowerCase()) {
      recordingIdMatch = true;
      score = Math.max(score, 0.97);
    } else score *= 0.85;
  }
  return { score, recordingIdMatch };
}

// ---------------------------------------------------------------------------------------
// Assignment (Hungarian method, minimising cost = 1 - score)
// ---------------------------------------------------------------------------------------

/** Rows <= columns. Returns for each row the assigned column. */
function hungarian(cost: number[][]): number[] {
  const n = cost.length;
  const m = cost[0]?.length ?? 0;
  const INF = Number.POSITIVE_INFINITY;
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(m + 1).fill(0);
  const p = new Array<number>(m + 1).fill(0);
  const way = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(INF);
    const used = new Array<boolean>(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0]!;
      let delta = INF;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1]![j - 1]! - u[i0]! - v[j]!;
        if (cur < minv[j]!) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]!] = u[p[j]!]! + delta;
          v[j] = v[j]! - delta;
        } else minv[j] = minv[j]! - delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0 !== 0);
  }
  const assignment = new Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]! > 0) assignment[p[j]! - 1] = j - 1;
  return assignment;
}

/** Maximum-score one-to-one pairs between rows and columns of `score`. */
export function assignMaxScore(score: number[][]): Array<[number, number]> {
  const rows = score.length;
  const cols = score[0]?.length ?? 0;
  if (rows === 0 || cols === 0) return [];
  const transpose = rows > cols;
  const cost = transpose
    ? Array.from({ length: cols }, (_, j) => Array.from({ length: rows }, (_, i) => 1 - score[i]![j]!))
    : score.map((r) => r.map((s) => 1 - s));
  const a = hungarian(cost);
  return a.map((col, row) => (transpose ? [col, row] : [row, col]) as [number, number]).filter(([r, c]) => r >= 0 && c >= 0);
}

// ---------------------------------------------------------------------------------------
// Release scoring
// ---------------------------------------------------------------------------------------

function flatten(release: ReleaseCandidate): FlatTrack[] {
  const media = [...release.media].sort((a, b) => a.position - b.position);
  const out: FlatTrack[] = [];
  let absolute = 0;
  for (const medium of media) {
    const tracks = [...medium.tracks].sort((a, b) => a.position - b.position);
    for (const track of tracks) {
      out.push({
        track,
        medium: medium.position,
        absolute: ++absolute,
        mediumCount: media.length,
        title: prepare(track.title),
        artist: track.artist ? prepare(track.artist) : null,
      });
    }
  }
  return out;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Score one release against the files. */
export function scoreRelease(files: readonly MatchFile[], release: ReleaseCandidate, options: TrackMatchOptions = {}): ReleaseMatch {
  const threshold = options.threshold ?? DEFAULT_TRACK_MATCH_THRESHOLD;
  const minPair = options.minPairScore ?? 0.5;
  const prepared: PreparedFile[] = files.map((file) => ({
    file,
    title: file.title ? prepare(file.title) : null,
    artist: file.artist ? prepare(file.artist) : null,
  }));
  const tracks = flatten(release);
  const pairs = prepared.map((pf) => tracks.map((t) => pairScore(pf, t)));
  const assigned = assignMaxScore(pairs.map((row) => row.map((p) => p.score)));

  const mapping: FileTrackMatch[] = [];
  const matchedFiles = new Set<number>();
  const matchedTracks = new Set<number>();
  let total = 0;
  let recMatches = 0;
  for (const [fi, ti] of assigned) {
    const pair = pairs[fi]![ti]!;
    if (pair.score < minPair) continue;
    const t = tracks[ti]!;
    matchedFiles.add(fi);
    matchedTracks.add(ti);
    total += pair.score;
    if (pair.recordingIdMatch) recMatches++;
    mapping.push({
      path: files[fi]!.path,
      mediumNumber: t.medium,
      trackPosition: t.track.position,
      absolutePosition: t.absolute,
      trackNumber: t.track.number ?? null,
      title: t.track.title,
      recordingId: t.track.recordingId,
      trackId: t.track.trackId ?? null,
      ref: t.track.ref,
      score: round3(pair.score),
      recordingIdMatch: pair.recordingIdMatch,
    });
  }
  mapping.sort((a, b) => a.absolutePosition - b.absolutePosition);

  const n = files.length;
  const m = tracks.length;
  const quality = n > 0 ? total / n : 0;
  const coverage = m > 0 ? matchedTracks.size / m : 0;
  const releaseTagged = n > 0 && files.filter((f) => f.mbReleaseId && f.mbReleaseId.toLowerCase() === release.id.toLowerCase()).length / n > 0.5;
  const bonus = (n > 0 ? 0.05 * (recMatches / n) : 0) + (releaseTagged ? 0.02 : 0);
  const confidence = round3(Math.min(1, Math.max(0, quality * (0.85 + 0.15 * coverage) + bonus)));

  return {
    releaseId: release.id,
    ref: release.ref,
    confidence,
    accepted: confidence >= threshold && mapping.length > 0,
    mapping,
    unmatchedFiles: files.filter((_, i) => !matchedFiles.has(i)).map((f) => f.path),
    missingTracks: tracks
      .filter((_, i) => !matchedTracks.has(i))
      .map((t) => ({ mediumNumber: t.medium, trackPosition: t.track.position, title: t.track.title, recordingId: t.track.recordingId, ref: t.track.ref })),
    stats: { fileCount: n, trackCount: m, matchedCount: mapping.length, recordingIdMatches: recMatches, quality: round3(quality), coverage: round3(coverage) },
  };
}

/** Score every release and pick the best; accepted when its confidence >= threshold. */
export function matchTracks(files: readonly MatchFile[], releases: readonly ReleaseCandidate[], options: TrackMatchOptions = {}): TrackMatchResult {
  const threshold = options.threshold ?? DEFAULT_TRACK_MATCH_THRESHOLD;
  if (files.length === 0 || releases.length === 0) return { threshold, accepted: false, best: null, candidates: [] };
  const scored = releases.map((r, i) => ({ match: scoreRelease(files, r, options), preferred: !!r.preferred, i }));
  scored.sort((a, b) => b.match.confidence - a.match.confidence || Number(b.preferred) - Number(a.preferred) || a.i - b.i);
  const candidates = scored.map((s) => s.match);
  const best = candidates[0] ?? null;
  return { threshold, accepted: !!best?.accepted, best, candidates };
}

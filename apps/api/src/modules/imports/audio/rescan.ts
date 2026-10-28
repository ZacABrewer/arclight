import { basename } from 'node:path';
import { scanAudioPath, type AudioExtraFile, type AudioGroup, type AudioScanFile, type AudioScanResult, type AudioScanSkip } from './scan-audio.js';
import type { AudioTags, TagReader } from './tags.js';
import {
  DEFAULT_TRACK_MATCH_THRESHOLD,
  matchFileFrom,
  matchTracks,
  titleSimilarity,
  type MissingTrack,
  type ReleaseCandidate,
  type ReleaseMatch,
} from './track-match.js';

// Rescanning an artist folder (design 9.2 steps 1-3): scan, group, match each group to one of
// the artist's known albums/releases. Inputs and outputs only; the caller (music module, 1C)
// writes `audio_files`, links `tracks.audio_file_id` and switches `selected_release_id`.

export interface KnownAlbum {
  /** Opaque album id (e.g. `albums.id`), returned untouched. */
  albumId: string | number;
  title: string;
  mbReleaseGroupId: string | null;
  selectedReleaseId: string | null;
  /** `albums.any_release_ok`: a better-fitting release may replace the selected one. */
  anyReleaseOk: boolean;
  /** Candidate releases with media and tracks (at least the selected one). */
  releases: ReleaseCandidate[];
}

export interface TrackAssignment {
  path: string;
  relativePath: string;
  sizeBytes: number;
  mtimeMs: number;
  tags: AudioTags;
  albumId: string | number;
  releaseId: string;
  releaseRef: unknown;
  mediumNumber: number;
  trackPosition: number;
  absolutePosition: number;
  recordingId: string | null;
  trackId: string | null;
  trackRef: unknown;
  score: number;
}

export interface AlbumMatchSummary {
  albumId: string | number;
  releaseId: string;
  releaseRef: unknown;
  /** True when the best release is not the album's selected one (only with anyReleaseOk). */
  releaseChanged: boolean;
  confidence: number;
  groupKeys: string[];
  folders: string[];
  fileCount: number;
  matchedCount: number;
  missingTracks: MissingTrack[];
  /** Some release tracks have no file (the album stays wanted). */
  incomplete: boolean;
  extras: AudioExtraFile[];
}

export type UnmatchedReason =
  | 'noCandidateAlbum'
  | 'belowThreshold'
  | 'albumAlreadyMatched'
  | 'cueImage'
  | 'unreadable';

export interface UnmatchedGroup {
  group: AudioGroup;
  reason: UnmatchedReason;
  /** The best attempt, for manual import. */
  best: { albumId: string | number; releaseId: string; confidence: number } | null;
}

export interface RescanArtistResult {
  artistFolder: string;
  assignments: TrackAssignment[];
  albums: AlbumMatchSummary[];
  unmatchedGroups: UnmatchedGroup[];
  /** Files of matched groups that did not map to any track. */
  unmatchedFiles: AudioScanFile[];
  unreadable: AudioScanFile[];
  skipped: AudioScanSkip[];
  stats: { groupCount: number; fileCount: number; matchedFileCount: number; tagReadMs: number; matchMs: number };
}

export interface MatchArtistOptions {
  threshold?: number;
}

export interface RescanArtistInput extends MatchArtistOptions {
  artistFolder: string;
  albums: readonly KnownAlbum[];
  tagReader?: TagReader;
  concurrency?: number;
  /** A scan already made (skips the filesystem walk). */
  scan?: AudioScanResult;
}

/** Scan `artistFolder` and match its album groups to `albums`. Filesystem reads only. */
export async function rescanArtist(input: RescanArtistInput): Promise<RescanArtistResult> {
  const scan =
    input.scan ??
    (await scanAudioPath(input.artistFolder, {
      ...(input.tagReader ? { tagReader: input.tagReader } : {}),
      ...(input.concurrency ? { concurrency: input.concurrency } : {}),
    }));
  return matchArtistScan(scan, input.albums, input);
}

// ---------------------------------------------------------------------------------------
// Pure part
// ---------------------------------------------------------------------------------------

/** "Album Title (2001) [FLAC]" -> "Album Title". */
export function albumTitleFromFolder(folder: string): string {
  return basename(folder)
    .replace(/\s*[[(][^\])]*[\])]\s*/g, ' ')
    .replace(/^\d{4}\s*-\s*/, '')
    .replace(/\s+-\s+\d{4}$/, '')
    .trim();
}

interface Attempt {
  album: KnownAlbum;
  match: ReleaseMatch;
  titleFit: number;
}

function candidateAlbums(group: AudioGroup, albums: readonly KnownAlbum[]): KnownAlbum[] {
  const rg = group.mbReleaseGroupId?.toLowerCase();
  if (rg) {
    const byRg = albums.filter((a) => a.mbReleaseGroupId?.toLowerCase() === rg);
    if (byRg.length > 0) return byRg;
  }
  const rels = new Set(group.releaseIds.map((r) => r.toLowerCase()));
  if (rels.size > 0) {
    const byRelease = albums.filter((a) => a.releases.some((r) => rels.has(r.id.toLowerCase())));
    if (byRelease.length > 0) return byRelease;
  }
  const title = group.album ?? albumTitleFromFolder(group.folder);
  const byTitle = albums.filter((a) => titleSimilarity(title, a.title) >= 0.6);
  // Nothing resembles the folder: try them all; the threshold guards against false matches.
  return byTitle.length > 0 ? byTitle : [...albums];
}

function releasesFor(album: KnownAlbum): ReleaseCandidate[] {
  const selected = album.selectedReleaseId;
  if (!album.anyReleaseOk && selected) {
    const only = album.releases.filter((r) => r.id === selected);
    if (only.length > 0) return only.map((r) => ({ ...r, preferred: true }));
  }
  return album.releases.map((r) => ({ ...r, preferred: r.id === selected }));
}

function bestAttempt(group: AudioGroup, albums: readonly KnownAlbum[], threshold: number): Attempt | null {
  const files = group.files.map(matchFileFrom);
  const title = group.album ?? albumTitleFromFolder(group.folder);
  let best: Attempt | null = null;
  for (const album of candidateAlbums(group, albums)) {
    const result = matchTracks(files, releasesFor(album), { threshold });
    if (!result.best) continue;
    const attempt: Attempt = { album, match: result.best, titleFit: titleSimilarity(title, album.title) };
    if (
      !best ||
      attempt.match.confidence > best.match.confidence ||
      (attempt.match.confidence === best.match.confidence && attempt.titleFit > best.titleFit)
    ) {
      best = attempt;
    }
  }
  return best;
}

function trackKey(mediumNumber: number, trackPosition: number): string {
  return `${mediumNumber}:${trackPosition}`;
}

/** Match an existing scan to the artist's albums. Pure (no I/O). */
export function matchArtistScan(scan: AudioScanResult, albums: readonly KnownAlbum[], options: MatchArtistOptions = {}): RescanArtistResult {
  const threshold = options.threshold ?? DEFAULT_TRACK_MATCH_THRESHOLD;
  const started = performance.now();
  const byPath = new Map(scan.files.map((f) => [f.path, f]));
  const unmatchedGroups: UnmatchedGroup[] = [];

  const attempts: Array<{ group: AudioGroup; attempt: Attempt | null }> = [];
  for (const group of scan.groups) {
    if (group.files.every((f) => f.tags === null)) {
      unmatchedGroups.push({ group, reason: 'unreadable', best: null });
      continue;
    }
    attempts.push({ group, attempt: albums.length > 0 ? bestAttempt(group, albums, threshold) : null });
  }
  // Most confident first, so a weaker duplicate of an album cannot claim it.
  attempts.sort((a, b) => (b.attempt?.match.confidence ?? 0) - (a.attempt?.match.confidence ?? 0));

  const summaries = new Map<string | number, AlbumMatchSummary & { claimed: Set<string> }>();
  const assignments: TrackAssignment[] = [];
  const unmatchedFiles: AudioScanFile[] = [];

  for (const { group, attempt } of attempts) {
    const bestInfo = attempt ? { albumId: attempt.album.albumId, releaseId: attempt.match.releaseId, confidence: attempt.match.confidence } : null;
    if (!attempt) {
      unmatchedGroups.push({ group, reason: 'noCandidateAlbum', best: null });
      continue;
    }
    const { album, match } = attempt;
    if (!match.accepted) {
      // One big file next to a cue sheet is a disc image: manual import (or a later CUE split).
      const cueImage = group.hasCue && group.files.length < Math.max(2, match.stats.trackCount / 2);
      unmatchedGroups.push({ group, reason: cueImage ? 'cueImage' : 'belowThreshold', best: bestInfo });
      continue;
    }

    const existing = summaries.get(album.albumId);
    const keys = match.mapping.map((m) => trackKey(m.mediumNumber, m.trackPosition));
    if (existing) {
      // A second group for the same album: fine when it fills other tracks of the same release
      // (discs in sibling folders), otherwise it is a duplicate copy.
      if (existing.releaseId !== match.releaseId || keys.some((k) => existing.claimed.has(k))) {
        unmatchedGroups.push({ group, reason: 'albumAlreadyMatched', best: bestInfo });
        continue;
      }
      for (const k of keys) existing.claimed.add(k);
      existing.groupKeys.push(group.key);
      if (!existing.folders.includes(group.folder)) existing.folders.push(group.folder);
      existing.fileCount += group.files.length;
      existing.matchedCount += match.mapping.length;
      existing.missingTracks = existing.missingTracks.filter((t) => !existing.claimed.has(trackKey(t.mediumNumber, t.trackPosition)));
      existing.incomplete = existing.missingTracks.length > 0;
      existing.confidence = Math.min(existing.confidence, match.confidence);
      for (const e of group.extras) if (!existing.extras.includes(e)) existing.extras.push(e);
    } else {
      summaries.set(album.albumId, {
        albumId: album.albumId,
        releaseId: match.releaseId,
        releaseRef: match.ref,
        releaseChanged: album.selectedReleaseId != null && album.selectedReleaseId !== match.releaseId,
        confidence: match.confidence,
        groupKeys: [group.key],
        folders: [group.folder],
        fileCount: group.files.length,
        matchedCount: match.mapping.length,
        missingTracks: match.missingTracks,
        incomplete: match.missingTracks.length > 0,
        extras: [...group.extras],
        claimed: new Set(keys),
      });
    }

    for (const m of match.mapping) {
      const file = byPath.get(m.path);
      if (!file?.tags) continue;
      assignments.push({
        path: file.path,
        relativePath: file.relativePath,
        sizeBytes: file.sizeBytes,
        mtimeMs: file.mtimeMs,
        tags: file.tags,
        albumId: album.albumId,
        releaseId: match.releaseId,
        releaseRef: match.ref,
        mediumNumber: m.mediumNumber,
        trackPosition: m.trackPosition,
        absolutePosition: m.absolutePosition,
        recordingId: m.recordingId,
        trackId: m.trackId,
        trackRef: m.ref,
        score: m.score,
      });
    }
    for (const p of match.unmatchedFiles) {
      const file = byPath.get(p);
      if (file) unmatchedFiles.push(file);
    }
  }

  const albumsOut = [...summaries.values()].map(({ claimed: _claimed, ...rest }) => rest);
  assignments.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  unmatchedGroups.sort((a, b) => a.group.folder.localeCompare(b.group.folder, undefined, { numeric: true }));
  return {
    artistFolder: scan.root,
    assignments,
    albums: albumsOut,
    unmatchedGroups,
    unmatchedFiles,
    unreadable: scan.unreadable,
    skipped: scan.skipped,
    stats: {
      groupCount: scan.groups.length,
      fileCount: scan.files.length,
      matchedFileCount: assignments.length,
      tagReadMs: scan.tagReadMs,
      matchMs: Math.round(performance.now() - started),
    },
  };
}

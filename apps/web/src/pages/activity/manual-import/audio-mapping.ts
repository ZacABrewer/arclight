import type { AudioManualImportItem, AudioManualImportRequestInput, ImportMode, Track } from '@arclight/shared';
import type { ChipTone } from '../../../arclight/index.js';
import { t } from '../../../i18n/index.js';

// Pure state for the audio mode of manual import (GET/POST /manualimport/audio). The scan
// answers one item per file; files of one album folder share a `groupKey`. Each group gets the
// proposed artist and album; each file its proposed track (disc/track position plus the
// track id of the album's selected edition). A file without a track is unmatched and is left
// out of the import until one is chosen.

/** Below this the proposal is shown as a weak match (the server's default track-match threshold). */
export const CONFIDENT = 0.8;

export interface AudioFileRow {
  path: string;
  relativePath: string;
  sizeBytes: number;
  qualityName: string | null;
  durationMs: number | null;
  /** This file's fit to its proposed track (0..1), null when the server gave none. */
  confidence: number | null;
  discNumber: number | null;
  trackNumber: number | null;
  /** A track of the album's selected edition (what the import needs). */
  trackId: number | null;
  /** The file's own title tag (helps when choosing a track by hand). */
  tagTitle: string | null;
  rejections: string[];
  warnings: string[];
  downloadId: string | null;
}

export interface AudioGroupState {
  key: string;
  folder: string;
  artistId: number | null;
  albumId: number | null;
  /** The group's edition match (0..1). */
  confidence: number | null;
  files: AudioFileRow[];
}

export interface AudioImportState {
  groups: AudioGroupState[];
}

/** Groups from the scan, in the order the server listed their first files. */
export function initAudioState(items: readonly AudioManualImportItem[]): AudioImportState {
  const groups = new Map<string, AudioGroupState>();
  for (const it of items) {
    let g = groups.get(it.groupKey);
    if (!g) {
      g = { key: it.groupKey, folder: it.groupFolder, artistId: it.artistId ?? null, albumId: it.albumId ?? null, confidence: it.confidence, files: [] };
      groups.set(it.groupKey, g);
    }
    // A group's proposal is shared; fill it from any file that has one.
    if (g.artistId === null && it.artistId !== undefined) g.artistId = it.artistId;
    if (g.albumId === null && it.albumId !== undefined) g.albumId = it.albumId;
    const trackId = it.trackIds?.[0] ?? null;
    const disc = it.mediumNumber ?? (trackId !== null ? 1 : null);
    const track = it.trackNumber ?? null;
    g.files.push({
      path: it.path,
      relativePath: it.relativePath,
      sizeBytes: it.sizeBytes,
      qualityName: it.quality.quality.name,
      durationMs: it.tags.durationMs,
      confidence: it.trackScore ?? null,
      discNumber: track !== null ? disc : null,
      trackNumber: track,
      trackId,
      tagTitle: it.tags.title,
      rejections: it.rejections.map((r) => r.message),
      warnings: it.warnings,
      downloadId: it.downloadId ?? null,
    });
  }
  return { groups: [...groups.values()] };
}

export type AudioAction =
  | { type: 'reset'; state: AudioImportState }
  | { type: 'artist'; key: string; artistId: number | null }
  | { type: 'album'; key: string; albumId: number | null }
  /** The album's edition changed: its tracks are new, so every track id goes (positions stay). */
  | { type: 'edition'; key: string }
  | { type: 'track'; key: string; path: string; discNumber: number | null; trackNumber: number | null; trackId: number | null }
  /** Fill missing track ids from the album's tracks by disc/track position. */
  | { type: 'resolve'; key: string; tracks: readonly TrackOption[] };

const clearTrackIds = (files: AudioFileRow[]) => files.map((f) => (f.trackId === null ? f : { ...f, trackId: null }));

export function audioReducer(state: AudioImportState, action: AudioAction): AudioImportState {
  if (action.type === 'reset') return action.state;
  let changed = false;
  const groups = state.groups.map((g) => {
    if (g.key !== action.key) return g;
    let next = g;
    switch (action.type) {
      case 'artist':
        // Another artist: the album no longer applies; positions are kept for the next album.
        if (g.artistId !== action.artistId) next = { ...g, artistId: action.artistId, albumId: null, files: clearTrackIds(g.files) };
        break;
      case 'album':
        if (g.albumId !== action.albumId) next = { ...g, albumId: action.albumId, files: clearTrackIds(g.files) };
        break;
      case 'edition':
        next = { ...g, files: clearTrackIds(g.files) };
        break;
      case 'track':
        next = {
          ...g,
          files: g.files.map((f) => (f.path === action.path ? { ...f, discNumber: action.discNumber, trackNumber: action.trackNumber, trackId: action.trackId } : f)),
        };
        break;
      case 'resolve': {
        const byPos = new Map(action.tracks.map((o) => [trackKey(o.discNumber, o.trackNumber), o.trackId]));
        let filled = false;
        const files = g.files.map((f) => {
          if (f.trackId !== null || f.discNumber === null || f.trackNumber === null) return f;
          const id = byPos.get(trackKey(f.discNumber, f.trackNumber));
          if (id === undefined) return f;
          filled = true;
          return { ...f, trackId: id };
        });
        if (filled) next = { ...g, files };
        break;
      }
    }
    if (next !== g) changed = true;
    return next;
  });
  return changed ? { groups } : state;
}

export const trackKey = (disc: number, track: number) => `${disc}-${track}`;

/** A file the import will take: it has a track of the album. */
export function isMapped(f: Pick<AudioFileRow, 'trackId'>): boolean {
  return f.trackId !== null;
}

/** Track ids more than one file of the group maps to. */
export function duplicateTracks(g: Pick<AudioGroupState, 'files'>): Set<number> {
  const seen = new Set<number>();
  const dup = new Set<number>();
  for (const f of g.files) {
    if (f.trackId === null) continue;
    if (seen.has(f.trackId)) dup.add(f.trackId);
    seen.add(f.trackId);
  }
  return dup;
}

/** Why a group cannot be imported yet; empty when it can. */
export function groupProblems(g: AudioGroupState): string[] {
  const out: string[] = [];
  if (g.artistId === null) out.push(t('activity.manualImport.audio.chooseArtist'));
  else if (g.albumId === null) out.push(t('activity.manualImport.audio.chooseAlbum'));
  if (!g.files.some(isMapped)) out.push(t('activity.manualImport.audio.noTracksMapped'));
  if (duplicateTracks(g).size > 0) out.push(t('activity.manualImport.audio.duplicateTracks'));
  return out;
}

export function unmatchedFiles(g: Pick<AudioGroupState, 'files'>): AudioFileRow[] {
  return g.files.filter((f) => !isMapped(f));
}

/** Files that would be imported: mapped files of groups without problems. */
export function importableCount(state: AudioImportState): number {
  return state.groups.filter((g) => groupProblems(g).length === 0).reduce((n, g) => n + g.files.filter(isMapped).length, 0);
}

/** POST /manualimport/audio: one item per mapped file of every group that can be imported. */
export function toAudioImportRequest(state: AudioImportState, importMode: ImportMode): AudioManualImportRequestInput {
  return {
    importMode,
    items: state.groups
      .filter((g) => groupProblems(g).length === 0)
      .flatMap((g) =>
        g.files
          .filter(isMapped)
          .map((f) => ({ path: f.path, artistId: g.artistId!, albumId: g.albumId!, trackIds: [f.trackId!], ...(f.downloadId ? { downloadId: f.downloadId } : {}) })),
      ),
  };
}

export function confidenceTone(c: number | null): ChipTone {
  if (c === null) return 'neutral';
  if (c >= CONFIDENT) return 'accent';
  return c >= 0.5 ? 'warn' : 'danger';
}

export function confidenceText(c: number | null): string {
  return c === null ? '—' : `${Math.round(c * 100)}%`;
}

export interface TrackOption {
  value: string;
  label: string;
  discNumber: number;
  trackNumber: number;
  trackId: number;
}

/** "1-03 · Title" options from the album's stored tracks (its selected edition). */
export function trackOptions(tracks: readonly Pick<Track, 'id' | 'mediumNumber' | 'trackNumber' | 'title'>[]): TrackOption[] {
  return [...tracks]
    .sort((a, b) => a.mediumNumber - b.mediumNumber || a.trackNumber - b.trackNumber)
    .map((tr) => ({
      value: String(tr.id),
      label: `${tr.mediumNumber}-${String(tr.trackNumber).padStart(2, '0')} · ${tr.title}`,
      discNumber: tr.mediumNumber,
      trackNumber: tr.trackNumber,
      trackId: tr.id,
    }));
}

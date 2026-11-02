import { isQualityAllowed } from '@arclight/profiles-engine';
import type { QualityModel, QualityProfile, SoulseekCandidate, SoulseekFile, SoulseekRejection } from '@arclight/shared';
import { remoteBaseName, remoteDirName, type SlskdResponse } from '@arclight/download-clients';
import { compareQ } from '../../imports/decisions.js';
import { parseTrackFileName, scoreRelease, type MatchFile, type ReleaseCandidate } from '../../imports/audio/track-match.js';
import { musicQualityFor } from '../quality.js';

// Turns slskd search responses into ranked album candidates: one per peer folder, its files
// matched against the album's tracks with the importer's track matcher, its quality read from
// the extension / bitrate / bit depth peers report, and the album's quality profile deciding
// what is acceptable. Pure: no database, no network.

const AUDIO_EXTENSIONS = new Set(['flac', 'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'aif', 'aiff', 'ape', 'wv', 'dsf', 'dff', 'alac']);

/** Disc sub-folders ("CD1", "Disc 2") fold into their album folder. */
const DISC_FOLDER = /^(?:cd|disc|disk|dvd)\s*[-_ ]?(\d{1,2})$/i;

export interface ChooseAlbum {
  /** The album's selected release with its tracks (`ref` = tracks.id). */
  release: ReleaseCandidate;
  /** Track ids the user does not want (per-track wanted). Empty: every track is wanted. */
  unwantedTrackIds?: ReadonlySet<number>;
}

export interface ChooseOptions {
  /** The artist's quality profile; null accepts every quality. */
  profile: QualityProfile | null;
  /** The lowest quality among the album's existing files; candidates must beat it. */
  currentQuality?: QualityModel | null;
  /** `audio.trackMatchThreshold`. */
  threshold: number;
  /** Peers with a longer queue (and no free slot) are rejected. */
  maxPeerQueue: number;
}

function extensionOf(path: string): string {
  const base = remoteBaseName(path);
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/** Quality of one shared file from what the peer reports. `.m4a` with a bit depth is ALAC. */
export function sharedFileQuality(file: { filename: string; bitRate?: number | null; bitDepth?: number | null }): QualityModel {
  const ext = extensionOf(file.filename);
  const codec =
    ext === 'm4a' ? (file.bitDepth ? 'alac' : 'aac') : ext === 'ogg' || ext === 'oga' ? 'vorbis' : ext === 'wv' ? 'wavpack' : ext;
  return musicQualityFor({ codec, bitrateKbps: file.bitRate ?? null, bitDepth: file.bitDepth ?? null });
}

interface Folder {
  username: string;
  directory: string;
  response: SlskdResponse;
  files: Array<{ file: SoulseekFile; disc: number | null }>;
}

function groupFolders(responses: readonly SlskdResponse[]): Folder[] {
  const folders = new Map<string, Folder>();
  for (const response of responses) {
    for (const f of response.files) {
      if (f.isLocked || !AUDIO_EXTENSIONS.has(extensionOf(f.filename))) continue;
      let directory = remoteDirName(f.filename);
      let disc: number | null = null;
      const disc_ = DISC_FOLDER.exec(remoteBaseName(directory));
      if (disc_) {
        disc = Number(disc_[1]);
        directory = remoteDirName(directory);
      }
      const key = `${response.username}\u0000${directory}`;
      const folder = folders.get(key) ?? { username: response.username, directory, response, files: [] };
      folder.files.push({
        disc,
        file: {
          filename: f.filename,
          size: Math.max(0, Math.round(f.size)),
          bitRate: f.bitRate ?? null,
          bitDepth: f.bitDepth ?? null,
          sampleRate: f.sampleRate ?? null,
          lengthSeconds: f.length ?? null,
        },
      });
      folders.set(key, folder);
    }
  }
  return [...folders.values()];
}

function matchFileOf(entry: Folder['files'][number]): MatchFile {
  const parsed = parseTrackFileName(remoteBaseName(entry.file.filename));
  return {
    path: entry.file.filename,
    title: parsed.title,
    artist: null,
    trackNo: parsed.trackNo,
    discNo: entry.disc ?? parsed.discNo,
    durationMs: entry.file.lengthSeconds !== null ? Math.round(entry.file.lengthSeconds * 1000) : null,
    mbRecordingId: null,
    mbReleaseId: null,
  };
}

/** The folder's quality: the lowest of its files (a folder is only as good as its worst track). */
function folderQuality(profile: QualityProfile | null, files: Folder['files']): { quality: QualityModel; mixedLossless: boolean } {
  const qualities = files.map((f) => sharedFileQuality(f.file));
  const lowest = qualities.reduce((low, q) => (compareQ(profile, q, low) < 0 ? q : low));
  const kinds = new Set(qualities.map((q) => q.quality.audio?.lossless ?? false));
  return { quality: lowest, mixedLossless: kinds.size > 1 };
}

/** Accepted first, then quality, track coverage, a free slot, a short queue and speed. */
function compareCandidates(profile: QualityProfile | null, a: Ranked, b: Ranked): number {
  if (a.candidate.accepted !== b.candidate.accepted) return a.candidate.accepted ? -1 : 1;
  const q = compareQ(profile, b.quality, a.quality);
  if (q !== 0) return q;
  if (a.candidate.matchedTracks !== b.candidate.matchedTracks) return b.candidate.matchedTracks - a.candidate.matchedTracks;
  if (a.candidate.confidence !== b.candidate.confidence) return b.candidate.confidence - a.candidate.confidence;
  if (a.candidate.freeSlot !== b.candidate.freeSlot) return a.candidate.freeSlot ? -1 : 1;
  if (a.candidate.queueLength !== b.candidate.queueLength) return a.candidate.queueLength - b.candidate.queueLength;
  return b.candidate.uploadSpeed - a.candidate.uploadSpeed;
}

interface Ranked {
  candidate: SoulseekCandidate;
  quality: QualityModel;
}

/**
 * Ranked candidates, best first. `score` is the rank turned into a number (higher is better)
 * so clients can sort without knowing the profile.
 */
export function chooseCandidates(responses: readonly SlskdResponse[], album: ChooseAlbum, options: ChooseOptions): SoulseekCandidate[] {
  const unwanted = album.unwantedTrackIds ?? new Set<number>();
  const totalTracks = album.release.media.reduce((n, m) => n + m.tracks.length, 0);
  const wantedRefs = new Set(
    album.release.media.flatMap((m) => m.tracks.map((t) => t.ref)).filter((ref) => !(typeof ref === 'number' && unwanted.has(ref))),
  );
  const ranked: Ranked[] = [];
  for (const folder of groupFolders(responses)) {
    const match = scoreRelease(folder.files.map(matchFileOf), album.release, { threshold: options.threshold });
    // Keep the folder's files in the order they map to tracks; unmatched ones are not grabbed.
    const byPath = new Map(folder.files.map((f) => [f.file.filename, f]));
    const mapped = [...match.mapping].sort((a, b) => a.absolutePosition - b.absolutePosition);
    const files = mapped.map((m) => byPath.get(m.path)!).filter(Boolean);
    if (files.length === 0) continue;

    const { quality, mixedLossless } = folderQuality(options.profile, files);
    const wantedMissing = match.missingTracks.filter((t) => wantedRefs.has(t.ref)).length;
    const rejections: SoulseekRejection[] = [];
    if (options.profile && !isQualityAllowed(options.profile, quality)) rejections.push('qualityNotAllowed');
    if (options.currentQuality && compareQ(options.profile, quality, options.currentQuality) <= 0) rejections.push('notAnUpgrade');
    if (mixedLossless) rejections.push('mixedQuality');
    // Whole album wanted: the match must pass the importer's threshold and cover that share of
    // the tracks too (the importer takes incomplete albums; a grab should not). Some tracks
    // unwanted: a partial folder is fine as long as it has every wanted track.
    if (unwanted.size === 0) {
      if (!match.accepted || match.stats.coverage < options.threshold) rejections.push('tooFewTracks');
    } else if (wantedMissing > 0) {
      rejections.push('missingWantedTracks');
    }
    const freeSlot = folder.response.hasFreeUploadSlot ?? false;
    const queueLength = Math.max(0, Math.round(folder.response.queueLength ?? 0));
    if (!freeSlot && queueLength > options.maxPeerQueue) rejections.push('peerQueueTooLong');

    ranked.push({
      quality,
      candidate: {
        username: folder.username,
        directory: folder.directory,
        files: files.map((f) => f.file),
        totalSize: files.reduce((n, f) => n + f.file.size, 0),
        qualityId: quality.quality.id,
        qualityName: quality.quality.name,
        matchedTracks: match.stats.matchedCount,
        wantedTracks: wantedRefs.size,
        totalTracks,
        confidence: Math.round(match.confidence * 1000) / 1000,
        freeSlot,
        queueLength,
        uploadSpeed: Math.max(0, folder.response.uploadSpeed ?? 0),
        score: 0,
        accepted: rejections.length === 0,
        rejections,
      },
    });
  }
  ranked.sort((a, b) => compareCandidates(options.profile, a, b));
  return ranked.map((r, i) => ({ ...r.candidate, score: ranked.length - i }));
}

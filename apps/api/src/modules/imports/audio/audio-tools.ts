import { execFile } from 'node:child_process';
import { rename, rm } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { locateFfmpeg, type FileExists } from '../../transcode/runner.js';
import { fileInput } from '../../transcode/input-protocols.js';

// ffmpeg for the music importer: cutting cue images into tracks, writing tags (and a cover) into
// imported files, and measuring ReplayGain. The argument builders are pure and exported for
// tests; `FfmpegAudioTools` runs them through an injectable exec so tests need no ffmpeg.
//
// Tags are written by remuxing (`-c copy`) into a hidden temporary file next to the target,
// which then replaces it with a rename: a failed or interrupted write leaves the file as it was.

export type AudioExecFn = (file: string, args: readonly string[], opts: { timeoutMs: number }) => Promise<{ stdout: string; stderr: string }>;

const nodeExec: AudioExecFn = (file, args, opts) =>
  new Promise((resolvePromise, reject) => {
    execFile(file, [...args], { timeout: opts.timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr ?? '').trim().split(/\r?\n/).slice(-1)[0];
        reject(new Error(detail || err.message, { cause: err }));
      } else resolvePromise({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** The tags the importer writes; null fields are left out. */
export interface TrackTagValues {
  title?: string | null;
  artist?: string | null;
  albumArtist?: string | null;
  album?: string | null;
  date?: string | null;
  trackNumber?: number | null;
  trackTotal?: number | null;
  discNumber?: number | null;
  discTotal?: number | null;
  genre?: string | null;
  isrc?: string | null;
  mbRecordingId?: string | null;
  mbReleaseTrackId?: string | null;
  mbReleaseId?: string | null;
  mbReleaseGroupId?: string | null;
  mbArtistId?: string | null;
  mbAlbumArtistId?: string | null;
  replayGainTrackGain?: number | null;
  replayGainTrackPeak?: number | null;
}

export interface ReplayGainResult {
  gainDb: number;
  peak: number;
}

export interface AudioTools {
  /** ffmpeg was found. */
  available(): Promise<boolean>;
  /** Cuts `[startMs, endMs)` of `source` into `destination` (FLAC for lossless, else stream copy). */
  split(input: { source: string; destination: string; startMs: number; endMs: number | null; lossless: boolean; tags: TrackTagValues }): Promise<void>;
  /** Rewrites the tags (and optionally the cover) of `path` in place. */
  writeTags(path: string, input: { tags: TrackTagValues; coverPath?: string | null }): Promise<void>;
  /** Track gain and peak of `path` (or of a span of it). */
  measureReplayGain(path: string, span?: { startMs: number; endMs: number | null }): Promise<ReplayGainResult | null>;
}

// ---------------------------------------------------------------------------------------
// Argument builders
// ---------------------------------------------------------------------------------------

export type TagFamily = 'vorbis' | 'id3' | 'mp4' | 'other';

/** The tag dialect of a file, by extension. */
export function tagFamilyOf(path: string): TagFamily {
  const ext = extname(path).toLowerCase();
  if (ext === '.flac' || ext === '.ogg' || ext === '.oga' || ext === '.opus') return 'vorbis';
  if (ext === '.mp3') return 'id3';
  if (ext === '.m4a' || ext === '.m4b' || ext === '.mp4' || ext === '.alac' || ext === '.aac') return 'mp4';
  return 'other';
}

/** Containers ffmpeg can attach a cover picture to. */
export function canEmbedCover(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return ext === '.flac' || ext === '.mp3' || ext === '.m4a' || ext === '.m4b';
}

const formatNumber = (n: number) => String(Math.round(n * 100) / 100);
const gainText = (db: number) => `${db >= 0 ? '+' : ''}${(Math.round(db * 100) / 100).toFixed(2)} dB`;
const peakText = (p: number) => (Math.round(p * 1e6) / 1e6).toFixed(6);

/**
 * `-metadata key=value` pairs for a file. Vorbis comments take the MusicBrainz Picard names
 * (`MUSICBRAINZ_TRACKID` is the recording, `MUSICBRAINZ_RELEASETRACKID` the release track); ID3
 * gets them as TXXX frames with Picard's descriptions (ffmpeg cannot write UFID, so the
 * recording id goes to TXXX `MusicBrainz Track Id` as well). MP4 gets the standard atoms only:
 * ffmpeg writes no iTunes freeform atoms, so its MusicBrainz ids would not be read back.
 */
export function metadataArgs(path: string, tags: TrackTagValues): string[] {
  const family = tagFamilyOf(path);
  const pairs: Array<[string, string | number | null | undefined]> = [
    ['title', tags.title],
    ['artist', tags.artist],
    ['album_artist', tags.albumArtist],
    ['album', tags.album],
    ['date', tags.date],
    ['genre', tags.genre],
  ];
  if (family === 'vorbis') {
    pairs.push(
      ['TRACKNUMBER', tags.trackNumber],
      ['TRACKTOTAL', tags.trackTotal],
      ['DISCNUMBER', tags.discNumber],
      ['DISCTOTAL', tags.discTotal],
      ['ISRC', tags.isrc],
      ['MUSICBRAINZ_TRACKID', tags.mbRecordingId],
      ['MUSICBRAINZ_RELEASETRACKID', tags.mbReleaseTrackId],
      ['MUSICBRAINZ_ALBUMID', tags.mbReleaseId],
      ['MUSICBRAINZ_RELEASEGROUPID', tags.mbReleaseGroupId],
      ['MUSICBRAINZ_ARTISTID', tags.mbArtistId],
      ['MUSICBRAINZ_ALBUMARTISTID', tags.mbAlbumArtistId],
    );
  } else {
    const of = (n: number | null | undefined, total: number | null | undefined) => (n == null ? null : total ? `${n}/${total}` : String(n));
    pairs.push(['track', of(tags.trackNumber, tags.trackTotal)], ['disc', of(tags.discNumber, tags.discTotal)]);
    if (family === 'id3') {
      pairs.push(
        ['TSRC', tags.isrc],
        ['MusicBrainz Track Id', tags.mbRecordingId],
        ['MusicBrainz Release Track Id', tags.mbReleaseTrackId],
        ['MusicBrainz Album Id', tags.mbReleaseId],
        ['MusicBrainz Release Group Id', tags.mbReleaseGroupId],
        ['MusicBrainz Artist Id', tags.mbArtistId],
        ['MusicBrainz Album Artist Id', tags.mbAlbumArtistId],
      );
    }
  }
  if (family === 'vorbis' || family === 'id3') {
    pairs.push(
      ['REPLAYGAIN_TRACK_GAIN', tags.replayGainTrackGain != null ? gainText(tags.replayGainTrackGain) : null],
      ['REPLAYGAIN_TRACK_PEAK', tags.replayGainTrackPeak != null ? peakText(tags.replayGainTrackPeak) : null],
    );
  }
  const out: string[] = [];
  for (const [key, value] of pairs) {
    if (value === null || value === undefined || value === '') continue;
    out.push('-metadata', `${key}=${String(value)}`);
  }
  return out;
}

const seconds = (ms: number) => (ms / 1000).toFixed(3);

/** ffmpeg arguments that cut one track out of an image. */
export function splitArgs(input: { source: string; destination: string; startMs: number; endMs: number | null; lossless: boolean; tags: TrackTagValues }): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-v',
    'error',
    '-y',
    // Input seeking decodes from the nearest point and is sample-accurate for re-encodes.
    ...(input.startMs > 0 ? ['-ss', seconds(input.startMs)] : []),
    ...fileInput(input.source),
    ...(input.endMs !== null ? ['-t', seconds(input.endMs - input.startMs)] : []),
    '-map',
    '0:a:0',
    // The image's own tags (album title as title, an embedded cue sheet) do not belong on a track.
    '-map_metadata',
    '-1',
    ...(input.lossless ? ['-c:a', 'flac', '-compression_level', '5'] : ['-c:a', 'copy']),
    ...metadataArgs(input.destination, input.tags),
    input.destination,
  ];
}

/** The hidden temporary file a tag write goes through. */
export function tagTempPath(path: string): string {
  const ext = extname(path);
  return join(dirname(path), `.${basename(path, ext)}.arclight-tagging${ext}`);
}

/** ffmpeg arguments that remux `path` into `temp` with new tags (and a cover). */
export function tagWriteArgs(path: string, temp: string, input: { tags: TrackTagValues; coverPath?: string | null }): string[] {
  const cover = input.coverPath && canEmbedCover(path) ? input.coverPath : null;
  return [
    '-hide_banner',
    '-nostdin',
    '-v',
    'error',
    '-y',
    ...fileInput(path),
    ...(cover ? fileInput(cover) : []),
    '-map',
    '0:a',
    // Keep an existing picture unless a new cover replaces it.
    ...(cover ? ['-map', '1:v:0', '-disposition:v:0', 'attached_pic', '-metadata:s:v:0', 'comment=Cover (front)'] : ['-map', '0:v?']),
    '-c',
    'copy',
    '-map_metadata',
    '0',
    ...(tagFamilyOf(path) === 'id3' ? ['-id3v2_version', '4'] : []),
    ...metadataArgs(path, input.tags),
    temp,
  ];
}

/** ffmpeg arguments that measure the track gain (the result is logged to stderr). */
export function replayGainArgs(path: string, span?: { startMs: number; endMs: number | null }): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-nostats',
    '-v',
    'info',
    ...(span && span.startMs > 0 ? ['-ss', seconds(span.startMs)] : []),
    ...fileInput(path),
    ...(span && span.endMs !== null ? ['-t', seconds(span.endMs - span.startMs)] : []),
    '-map',
    '0:a:0',
    '-af',
    'replaygain',
    '-f',
    'null',
    '-',
  ];
}

/** `track_gain = -6.50 dB` / `track_peak = 0.987654` from the replaygain filter's log. */
export function parseReplayGain(output: string): ReplayGainResult | null {
  const gain = /track_gain\s*=\s*([+-]?\d+(?:\.\d+)?)\s*dB/i.exec(output);
  const peak = /track_peak\s*=\s*(\d+(?:\.\d+)?)/i.exec(output);
  if (!gain || !peak) return null;
  return { gainDb: Number(formatNumber(Number(gain[1]))), peak: Number(peak[1]) };
}

// ---------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------

export interface FfmpegAudioToolsOptions {
  binary?: string | null;
  env?: NodeJS.ProcessEnv;
  exists?: FileExists;
  exec?: AudioExecFn;
  /** Per command. Default 30 min (a long image decodes slowly on a small NAS). */
  timeoutMs?: number;
}

export class FfmpegAudioTools implements AudioTools {
  private located: Promise<string | null> | null = null;
  private readonly exec: AudioExecFn;

  constructor(private readonly opts: FfmpegAudioToolsOptions = {}) {
    this.exec = opts.exec ?? nodeExec;
  }

  private locate(): Promise<string | null> {
    if (this.opts.binary !== undefined) return Promise.resolve(this.opts.binary);
    this.located ??= locateFfmpeg(this.opts.env, this.opts.exists);
    return this.located;
  }

  private async binary(): Promise<string> {
    const bin = await this.locate();
    if (!bin) throw new Error('ffmpeg was not found (set ARCLIGHT_FFMPEG or put ffmpeg on PATH)');
    return bin;
  }

  private get timeoutMs(): number {
    return this.opts.timeoutMs ?? 30 * 60_000;
  }

  async available(): Promise<boolean> {
    return (await this.locate()) !== null;
  }

  async split(input: Parameters<AudioTools['split']>[0]): Promise<void> {
    await this.exec(await this.binary(), splitArgs(input), { timeoutMs: this.timeoutMs });
  }

  async writeTags(path: string, input: { tags: TrackTagValues; coverPath?: string | null }): Promise<void> {
    const bin = await this.binary();
    const temp = tagTempPath(path);
    try {
      await this.exec(bin, tagWriteArgs(path, temp, input), { timeoutMs: this.timeoutMs });
      await rename(temp, path);
    } catch (err) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  async measureReplayGain(path: string, span?: { startMs: number; endMs: number | null }): Promise<ReplayGainResult | null> {
    const { stdout, stderr } = await this.exec(await this.binary(), replayGainArgs(path, span), { timeoutMs: this.timeoutMs });
    return parseReplayGain(`${stderr}\n${stdout}`);
  }
}

import { execFile } from 'node:child_process';
import { rename, rm, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { locateFfmpeg } from '../transcode/runner.js';

// Writes tags, artwork and chapters into a downloaded episode with ffmpeg (stream copy, so the
// audio is never re-encoded): ID3v2.3 for MP3, MP4 atoms for M4A/MP4, Vorbis comments for
// Ogg/Opus/FLAC. A failure leaves the untouched download in place; tagging is best effort.

export interface EpisodeTags {
  title: string;
  podcast: string;
  author: string | null;
  /** ISO date. */
  date: string | null;
  description: string;
  episodeNumber: number | null;
  season: number | null;
  link: string | null;
}

export interface Chapter {
  startSeconds: number;
  endSeconds: number | null;
  title: string;
}

export interface TagRequest {
  file: string;
  tags: EpisodeTags;
  /** A JPEG/PNG to embed (audio files only). */
  coverFile: string | null;
  chapters: Chapter[];
  durationSeconds: number | null;
}

export interface Tagger {
  /** Returns false when tagging was skipped (no ffmpeg, unsupported container). */
  tag(req: TagRequest): Promise<boolean>;
}

const TAGGABLE = new Set(['.mp3', '.m4a', '.m4b', '.mp4', '.m4v', '.mov', '.ogg', '.oga', '.opus', '.flac']);
const COVER_OK = new Set(['.mp3', '.m4a', '.m4b', '.flac']);
const CHAPTERS_OK = new Set(['.mp3', '.m4a', '.m4b', '.mp4', '.m4v', '.mov', '.ogg', '.oga', '.opus', '.flac']);

function escMeta(value: string): string {
  return value.replace(/([=;#\\\n])/g, '\\$1');
}

/** FFMETADATA1 text for a chapter list (times in milliseconds). */
export function ffmetadataChapters(chapters: readonly Chapter[], durationSeconds: number | null): string {
  const sorted = [...chapters].filter((c) => Number.isFinite(c.startSeconds) && c.startSeconds >= 0).sort((a, b) => a.startSeconds - b.startSeconds);
  const lines = [';FFMETADATA1'];
  sorted.forEach((c, i) => {
    const start = Math.round(c.startSeconds * 1000);
    const nextStart = sorted[i + 1]?.startSeconds;
    const endS = c.endSeconds ?? nextStart ?? durationSeconds ?? c.startSeconds + 1;
    const end = Math.max(start + 1, Math.round(endS * 1000));
    lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${start}`, `END=${end}`, `title=${escMeta(c.title)}`);
  });
  return `${lines.join('\n')}\n`;
}

/** ffmpeg arguments for one tagging pass (exported for tests). */
export function tagArgs(req: TagRequest, out: string, chaptersFile: string | null): string[] {
  const ext = extname(req.file).toLowerCase();
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', req.file];
  const cover = req.coverFile && COVER_OK.has(ext) ? req.coverFile : null;
  let next = 1;
  let coverIndex = -1;
  let chaptersIndex = -1;
  if (cover) {
    args.push('-i', cover);
    coverIndex = next++;
  }
  if (chaptersFile && CHAPTERS_OK.has(ext)) {
    args.push('-f', 'ffmetadata', '-i', chaptersFile);
    chaptersIndex = next++;
  }
  if (cover) args.push('-map', '0:a', '-map', `${coverIndex}:v`, '-disposition:v:0', 'attached_pic');
  else args.push('-map', '0');
  if (chaptersIndex >= 0) args.push('-map_chapters', String(chaptersIndex));
  args.push('-c', 'copy');
  const t = req.tags;
  const meta: [string, string | null][] = [
    ['title', t.title],
    ['album', t.podcast],
    ['artist', t.author ?? t.podcast],
    ['album_artist', t.author ?? t.podcast],
    ['genre', 'Podcast'],
    ['date', t.date ? t.date.slice(0, 10) : null],
    ['track', t.episodeNumber !== null ? String(t.episodeNumber) : null],
    ['disc', t.season !== null ? String(t.season) : null],
    ['comment', t.description ? t.description.slice(0, 2000) : null],
    ['description', t.description ? t.description.slice(0, 2000) : null],
    ['website', t.link],
  ];
  for (const [k, v] of meta) if (v) args.push('-metadata', `${k}=${v}`);
  if (ext === '.mp3') args.push('-id3v2_version', '3', '-write_id3v1', '1');
  if (ext === '.m4a' || ext === '.m4b' || ext === '.mp4' || ext === '.m4v' || ext === '.mov') args.push('-movflags', '+faststart');
  args.push(out);
  return args;
}

type Exec = (file: string, args: readonly string[], timeoutMs: number) => Promise<void>;

const nodeExec: Exec = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) reject(new Error(String(stderr ?? '').trim().split(/\r?\n/).slice(-1)[0] || err.message));
      else resolve();
    });
  });

export class FfmpegTagger implements Tagger {
  private ffmpeg: Promise<string | null> | null = null;

  constructor(private readonly opts: { ffmpegPath?: string | null; exec?: Exec } = {}) {}

  private locate(): Promise<string | null> {
    if (this.opts.ffmpegPath !== undefined) return Promise.resolve(this.opts.ffmpegPath);
    this.ffmpeg ??= locateFfmpeg();
    return this.ffmpeg;
  }

  async tag(req: TagRequest): Promise<boolean> {
    const ext = extname(req.file).toLowerCase();
    if (!TAGGABLE.has(ext)) return false;
    const ffmpeg = await this.locate();
    if (!ffmpeg) return false;
    const tmp = `${req.file}.tagging${ext}`;
    const chaptersFile = req.chapters.length > 0 ? `${req.file}.chapters.ffmeta` : null;
    try {
      if (chaptersFile) await writeFile(chaptersFile, ffmetadataChapters(req.chapters, req.durationSeconds), 'utf8');
      await (this.opts.exec ?? nodeExec)(ffmpeg, tagArgs(req, tmp, chaptersFile), 10 * 60_000);
      await rename(tmp, req.file);
      return true;
    } finally {
      await rm(tmp, { force: true }).catch(() => undefined);
      if (chaptersFile) await rm(chaptersFile, { force: true }).catch(() => undefined);
    }
  }
}

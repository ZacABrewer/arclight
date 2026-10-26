import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { QUALITIES, type QualityDefinition, type QualityName } from '@media-tron/shared';
import type { Probe, ProbeResult } from './deps.js';

// Enumerating candidate files in a completed download or a library folder (spec 4.4-4.8),
// sample detection (spec 8) and unpack detection. Filesystem reads only; no database.

export class ScanError extends Error {
  constructor(
    readonly code: 'NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'ScanError';
  }
}

// ---------------------------------------------------------------------------------------
// Extensions (spec 4.8)
// ---------------------------------------------------------------------------------------

const MEDIA_EXTENSION_QUALITY: ReadonlyArray<[QualityName, string[]]> = [
  ['Unknown', ['.webm']],
  [
    'SDTV',
    [
      '.m4v', '.3gp', '.nsv', '.ty', '.strm', '.rm', '.rmvb', '.m3u', '.ifo', '.mov', '.qt', '.divx', '.xvid',
      '.bivx', '.nrg', '.pva', '.wmv', '.asf', '.asx', '.ogm', '.ogv', '.m2v', '.avi', '.bin', '.dat', '.dvr-ms',
      '.mpg', '.mpeg', '.mp4', '.avc', '.vp3', '.svq3', '.nuv', '.viv', '.dv', '.fli', '.flv', '.wpl',
    ],
  ],
  ['DVD', ['.img', '.iso', '.vob']],
  ['HDTV-720p', ['.mkv', '.ts', '.wtv']],
  ['Bluray-720p', ['.m2ts']],
];

const MEDIA_EXTENSIONS = new Map<string, QualityName>(
  MEDIA_EXTENSION_QUALITY.flatMap(([q, exts]) => exts.map((e) => [e, q] as [string, QualityName])),
);

export const DANGEROUS_EXTENSIONS: ReadonlySet<string> = new Set(['.arj', '.lnk', '.lzh', '.ps1', '.scr', '.vbs', '.zipx']);
export const EXECUTABLE_EXTENSIONS: ReadonlySet<string> = new Set(['.bat', '.cmd', '.exe', '.sh']);
const ARCHIVE_EXTENSIONS = ['.tar.bz2', '.tar.gz', '.7z', '.bz2', '.gz', '.r00', '.rar', '.tar', '.tb2', '.tbz2', '.tgz', '.zip'];
/** Split-RAR volumes (.r01, .r02 ...) count as archives too. */
const RAR_VOLUME = /\.r\d{2}$/i;

export const SUBTITLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.aqt', '.ass', '.idx', '.jss', '.psb', '.rt', '.smi', '.srt', '.ssa', '.sub', '.txt', '.utf', '.utf8', '.utf-8', '.vtt',
]);

/** Lower-case extension including the dot; `''` when none. */
export function extensionOf(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

export function isMediaExtension(ext: string): boolean {
  return MEDIA_EXTENSIONS.has(ext.toLowerCase());
}

export function isArchive(path: string): boolean {
  const lower = basename(path).toLowerCase();
  return ARCHIVE_EXTENSIONS.some((e) => lower.endsWith(e)) || RAR_VOLUME.test(lower);
}

/** The quality a bare extension implies when nothing else is known (spec 4.8). */
export function qualityForExtension(ext: string): QualityDefinition {
  const name = MEDIA_EXTENSIONS.get(ext.toLowerCase());
  return name ? QUALITIES[name] : QUALITIES.Unknown;
}

// ---------------------------------------------------------------------------------------
// Filters (spec 4.7)
// ---------------------------------------------------------------------------------------

const EXCLUDED_FOLDERS = new Set(['@eadir', '.@__thumb', 'plex versions']);
const EXCLUDED_FILES = new Set(['.ds_store', 'thumbs.db']);
const EXTRAS_FOLDERS = new Set([
  'extras', 'extrafanart', 'behind the scenes', 'deleted scenes', 'featurettes', 'interviews', 'other', 'scenes',
  'samples', 'shorts', 'trailers', 'theme music', 'backdrops',
]);
const EXTRAS_SUFFIXES = ['-trailer', '-other', '-behindthescenes', '-deleted', '-featurette', '-interview', '-scene', '-short'];

function excludedFolder(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('.') || EXCLUDED_FOLDERS.has(lower);
}

function excludedFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('._') || lower.startsWith('.unmanic') || EXCLUDED_FILES.has(lower);
}

function isExtraFileName(name: string): boolean {
  const ext = extensionOf(name);
  const stem = (ext ? name.slice(0, -ext.length) : name).toLowerCase();
  return EXTRAS_SUFFIXES.some((s) => stem.endsWith(s));
}

// ---------------------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------------------

export interface ScannedFile {
  path: string;
  /** Relative to the scan root (the file name when the root is a file). */
  relativePath: string;
  name: string;
  extension: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface ScanResult {
  root: string;
  isFile: boolean;
  videos: ScannedFile[];
  archives: ScannedFile[];
  dangerous: ScannedFile[];
  executables: ScannedFile[];
  /** Everything else that passed the filters (subtitles, nfo, images ...). */
  others: ScannedFile[];
  /** True when a download client is still extracting (working folder present). */
  unpacking: boolean;
}

export interface ScanOptions {
  /** Skip extras folders and `-trailer`-style files (imports of downloads). Default true. */
  filterExtras?: boolean;
  /** Prefixes of download-client working folders. Default `_UNPACK_`, `_FAILED_`. */
  workingFolders?: readonly string[];
}

const DEFAULT_WORKING_FOLDERS = ['_UNPACK_', '_FAILED_'];

async function statOrNull(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

/** Enumerates a folder (recursively) or a single file. Throws ScanError when neither exists. */
export async function scanPath(path: string, options: ScanOptions = {}): Promise<ScanResult> {
  const filterExtras = options.filterExtras ?? true;
  const working = options.workingFolders ?? DEFAULT_WORKING_FOLDERS;
  const info = await statOrNull(path);
  if (!info) {
    throw new ScanError(
      'NOT_FOUND',
      `${path} does not exist or is not accessible. Make sure the Media-Tron service user can read it` +
        (process.platform === 'win32' ? ' (mapped network drives are not visible to services; use a UNC path).' : '.'),
    );
  }
  const result: ScanResult = {
    root: path,
    isFile: info.isFile(),
    videos: [],
    archives: [],
    dangerous: [],
    executables: [],
    others: [],
    unpacking: false,
  };

  const classify = (file: ScannedFile) => {
    if (isMediaExtension(file.extension)) result.videos.push(file);
    else if (DANGEROUS_EXTENSIONS.has(file.extension)) result.dangerous.push(file);
    else if (EXECUTABLE_EXTENSIONS.has(file.extension)) result.executables.push(file);
    else if (isArchive(file.path)) result.archives.push(file);
    else result.others.push(file);
  };

  if (info.isFile()) {
    const name = basename(path);
    classify({ path, relativePath: name, name, extension: extensionOf(name), sizeBytes: info.size, mtimeMs: info.mtimeMs });
    result.unpacking = isInWorkingFolder(path, working);
    return result;
  }

  result.unpacking = startsWithAny(basename(path), working);

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (excludedFolder(entry.name)) continue;
        if (startsWithAny(entry.name, working)) result.unpacking = true;
        if (filterExtras && EXTRAS_FOLDERS.has(entry.name.toLowerCase())) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile() || excludedFile(entry.name)) continue;
      if (filterExtras && isExtraFileName(entry.name)) continue;
      const s = await statOrNull(full);
      if (!s) continue;
      classify({
        path: full,
        relativePath: relative(path, full),
        name: entry.name,
        extension: extensionOf(entry.name),
        sizeBytes: s.size,
        mtimeMs: s.mtimeMs,
      });
    }
  };
  await walk(path);
  for (const list of [result.videos, result.archives, result.others]) list.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}

function startsWithAny(name: string, prefixes: readonly string[]): boolean {
  const lower = name.toLowerCase();
  return prefixes.some((p) => p && lower.startsWith(p.toLowerCase()));
}

/** True when any parent folder of `path` starts with a working-folder prefix. */
export function isInWorkingFolder(path: string, workingFolders: readonly string[]): boolean {
  let dir = dirname(path);
  for (let i = 0; i < 64; i++) {
    if (startsWithAny(basename(dir), workingFolders)) return true;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

/**
 * NotUnpacking (spec 7.1): inside a working folder means still unpacking; on Windows only
 * while the file was written within the last 5 minutes.
 */
export function isUnpacking(
  file: { path: string; mtimeMs: number },
  workingFolders: readonly string[],
  platform: NodeJS.Platform = process.platform,
  nowMs: number = Date.now(),
): boolean {
  if (!isInWorkingFolder(file.path, workingFolders)) return false;
  if (platform !== 'win32') return true;
  return nowMs - file.mtimeMs < 5 * 60 * 1000;
}

// ---------------------------------------------------------------------------------------
// Samples (spec 8)
// ---------------------------------------------------------------------------------------

const SAMPLE_WORD = /(?:^|[-_. [(])sample(?:[-_. \])]|$)/i;

/** Name rule: "sample" as a word in the file name, or a `Sample`/`Samples` parent folder. */
export function isSampleByName(path: string): boolean {
  const name = basename(path);
  const ext = extensionOf(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  if (SAMPLE_WORD.test(stem)) return true;
  const parent = basename(dirname(path)).toLowerCase();
  return parent === 'sample' || parent === 'samples';
}

/** Minimum runtime (seconds) for a file whose content is expected to run `expectedMinutes`. */
export function minimumRuntimeSeconds(expectedMinutes: number): number {
  if (expectedMinutes <= 3) return 15;
  if (expectedMinutes <= 10) return 90;
  if (expectedMinutes <= 30) return 300;
  return 600;
}

export type SampleVerdict = 'sample' | 'notSample' | 'indeterminate';

export interface SampleInput {
  path: string;
  mediaType: 'series' | 'movie';
  seasonNumber?: number | undefined;
  /** Inside the library already (ExistingFile): never a sample. */
  existingFile: boolean;
  /** Expected runtime in minutes; 0/undefined uses the default (45 for series). */
  expectedRuntimeMinutes?: number | undefined;
  /**
   * Probed runtime. `undefined` = no probe available (name rule only);
   * `null` = probe failed (indeterminate).
   */
  runtimeSeconds: number | null | undefined;
}

export function detectSample(input: SampleInput): SampleVerdict {
  const ext = extensionOf(input.path);
  if (input.existingFile) return 'notSample';
  if (ext === '.flv' || ext === '.strm') return 'notSample';
  if (input.mediaType === 'series' && input.seasonNumber === 0) return 'notSample';
  if (input.mediaType === 'movie' && (ext === '.iso' || ext === '.img' || ext === '.m2ts')) return 'notSample';
  if (isSampleByName(input.path)) return 'sample';
  if (input.runtimeSeconds === undefined) return 'notSample';
  if (input.runtimeSeconds === null) return 'indeterminate';
  if (input.runtimeSeconds <= 0) return 'sample';
  const expected = input.expectedRuntimeMinutes && input.expectedRuntimeMinutes > 0 ? input.expectedRuntimeMinutes : 45;
  return input.runtimeSeconds < minimumRuntimeSeconds(expected) ? 'sample' : 'notSample';
}

/**
 * ShouldDeleteFolder (spec 4.5): after a move import, the source folder may go only when every
 * remaining video is a sample and no `.rar` larger than 10 MB remains.
 */
export function shouldDeleteFolder(remaining: ScanResult, isSample: (file: ScannedFile) => boolean): boolean {
  try {
    if (remaining.isFile) return false;
    if (!remaining.videos.every(isSample)) return false;
    return !remaining.archives.some((a) => a.extension === '.rar' && a.sizeBytes > 10 * 1024 * 1024);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------------------

/** The default probe: nothing is known. Runtime-based sample detection is skipped. */
export const noProbe: Probe = async () => null;

/**
 * A probe backed by an `ffprobe` binary. Resolves null when the binary is missing or the file
 * cannot be read. Use `ffprobeAvailable()` first to decide whether to inject it at all.
 */
export function createFfprobeProbe(binary = 'ffprobe', timeoutMs = 15_000): Probe {
  return (path) =>
    new Promise<ProbeResult | null>((resolvePromise) => {
      execFile(
        binary,
        ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
        { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          if (err) return resolvePromise(null);
          try {
            resolvePromise(parseFfprobeJson(stdout));
          } catch {
            resolvePromise(null);
          }
        },
      );
    });
}

export function ffprobeAvailable(binary = 'ffprobe'): Promise<boolean> {
  return new Promise((resolvePromise) => {
    execFile(binary, ['-version'], { timeout: 5000 }, (err) => resolvePromise(!err));
  });
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  channels?: number;
}

export function parseFfprobeJson(json: string): ProbeResult {
  const data = JSON.parse(json) as { format?: { duration?: string }; streams?: FfprobeStream[] };
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.filter((s) => s.codec_type === 'audio');
  const duration = Number(data.format?.duration);
  const result: ProbeResult = {
    runtimeSeconds: Number.isFinite(duration) ? Math.round(duration) : null,
    audioStreams: audio.length,
  };
  if (video?.width !== undefined) result.width = video.width;
  if (video?.height !== undefined) result.height = video.height;
  if (video?.codec_name) result.videoCodec = video.codec_name;
  if (audio[0]?.codec_name) result.audioCodec = audio[0].codec_name;
  if (audio[0]?.channels !== undefined) result.audioChannels = audio[0].channels;
  return result;
}

/** Path separator-agnostic "is `child` inside (or equal to) `parent`". */
export function isUnder(child: string, parent: string): boolean {
  const norm = (p: string) => {
    const r = p.replace(/[\\/]+/g, sep).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p + sep);
}

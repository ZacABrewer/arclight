import { basename, extname } from 'node:path';
import { eq } from 'drizzle-orm';
import type { AnyMediaType } from '@arclight/shared';
import type { Db } from '../../db/index.js';
import { episodes, movies, series } from '../library/schema.js';
import { DANGEROUS_EXTENSIONS, EXECUTABLE_EXTENSIONS, isArchive, isMediaExtension, isSampleByName } from '../imports/scan.js';

// Fake-release and malware filter, the decisions only. A release is checked as soon as its file
// list is known (torrent metadata, the client's file list) and again before import, on the
// files on disk and on whatever came out of its archives. A rejected release is removed with
// its data, blocklisted with the reason and searched for again (the service carries that out).
//
// What gets a release rejected:
// * a file with a blocked extension (programs, scripts, shortcuts, .zipx ...): media releases
//   never need them, fake ones use them to get something run;
// * no media file at all (and no archive that could hold one);
// * a main video far too small for its resolution and runtime (a "1080p movie" of 40 MB);
// * a password-protected archive (reported by the unpacker, see imports/unpack).

export interface SafetyFile {
  /** Relative to the download, `/` or the platform separator. */
  path: string;
  sizeBytes: number;
}

export interface SafetyContext {
  mediaType?: AnyMediaType | null | undefined;
  /** Release title, for its resolution. */
  title: string;
  /** Expected runtime of one movie / episode in minutes, when the library knows it. */
  runtimeMinutes?: number | null | undefined;
}

export interface SafetyOptions {
  /** Extensions without dots (Settings > Media Management); the import caution list always applies. */
  blockedExtensions: readonly string[];
  rejectImplausibleSize: boolean;
}

export type SafetyRule = 'blockedExtension' | 'noMedia' | 'tooSmall' | 'encrypted';

export type SafetyVerdict = { ok: true } | { ok: false; rule: SafetyRule; reason: string; file?: string };

export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  '.aac', '.aif', '.aiff', '.alac', '.ape', '.dsf', '.dff', '.flac', '.m4a', '.m4b', '.mka', '.mp2', '.mp3', '.mpc', '.oga', '.ogg',
  '.opus', '.wav', '.wma', '.wv', '.cue',
]);

/**
 * Smallest plausible size per minute of runtime, by resolution (MiB/min). Deliberately far
 * below even efficient encodes (a 1080p HEVC movie is ~10 MiB/min): only fakes fall under it.
 */
export const MIN_MIB_PER_MINUTE: Readonly<Record<'sd' | '720p' | '1080p' | '2160p', number>> = {
  sd: 0.7,
  '720p': 1.5,
  '1080p': 2.5,
  '2160p': 5,
};

/** Runtime assumed when the library does not know it (short on purpose: fewer false alarms). */
export const FALLBACK_RUNTIME_MINUTES: Readonly<Record<'movie' | 'series', number>> = { movie: 80, series: 20 };

const MIB = 1024 * 1024;

/** The release's resolution from its title; SD when nothing says otherwise. */
export function resolutionOf(title: string): keyof typeof MIN_MIB_PER_MINUTE {
  const t = title.toLowerCase();
  if (/(?:^|[^a-z0-9])(?:2160p|4k|uhd)(?:[^a-z0-9]|$)/.test(t)) return '2160p';
  if (/(?:^|[^a-z0-9])1080[pi](?:[^a-z0-9]|$)/.test(t)) return '1080p';
  if (/(?:^|[^a-z0-9])720p(?:[^a-z0-9]|$)/.test(t)) return '720p';
  return 'sd';
}

/** The effective blocked set: the configured extensions plus the import's caution lists. */
export function blockedExtensionSet(configured: readonly string[]): Set<string> {
  const set = new Set<string>([...DANGEROUS_EXTENSIONS, ...EXECUTABLE_EXTENSIONS]);
  for (const raw of configured) {
    const ext = raw.trim().toLowerCase().replace(/^\*?\.?/, '');
    if (ext) set.add(`.${ext}`);
  }
  return set;
}

/** Archives, including numbered split volumes (`.7z.001`, `.zip.001`, `.001`). */
function isArchiveFile(path: string): boolean {
  return isArchive(path) || /\.\d{3}$/.test(path);
}

function extOf(path: string): string {
  return extname(basename(path.replaceAll('\\', '/'))).toLowerCase();
}

function isVideoKind(kind: AnyMediaType | null | undefined): kind is 'movie' | 'series' {
  return kind === 'movie' || kind === 'series';
}

/** Checks a release's file list. `files` empty means nothing is known yet: always ok. */
export function checkReleaseFiles(files: readonly SafetyFile[], ctx: SafetyContext, options: SafetyOptions): SafetyVerdict {
  if (files.length === 0) return { ok: true };
  const blocked = blockedExtensionSet(options.blockedExtensions);
  for (const f of files) {
    const ext = extOf(f.path);
    if (ext && blocked.has(ext)) {
      const name = basename(f.path.replaceAll('\\', '/'));
      return { ok: false, rule: 'blockedExtension', file: f.path, reason: `Unsafe release: contains ${name} (${ext} files are blocked)` };
    }
  }

  const kind = ctx.mediaType ?? null;
  const archives = files.filter((f) => isArchiveFile(f.path));
  const videos = files.filter((f) => isMediaExtension(extOf(f.path)));
  if (isVideoKind(kind)) {
    if (videos.length === 0 && archives.length === 0) {
      return { ok: false, rule: 'noMedia', reason: 'Fake release: it contains no video file' };
    }
  } else if (kind === 'music' || kind === 'audiobook') {
    const audio = files.some((f) => AUDIO_EXTENSIONS.has(extOf(f.path)));
    if (!audio && archives.length === 0) return { ok: false, rule: 'noMedia', reason: 'Fake release: it contains no audio file' };
    return { ok: true };
  } else {
    // Unknown or other media kinds: only the extension rule applies.
    return { ok: true };
  }

  if (!options.rejectImplausibleSize) return { ok: true };
  const main = videos.filter((v) => !isSampleByName(v.path));
  // A release made only of archives is measured by its archives; one with only samples by them.
  const pool = main.length > 0 ? main : videos.length > 0 ? videos : null;
  const measured = pool ? Math.max(...pool.map((v) => v.sizeBytes)) : archives.reduce((sum, a) => sum + a.sizeBytes, 0);
  const resolution = resolutionOf(ctx.title);
  const runtime = ctx.runtimeMinutes && ctx.runtimeMinutes > 0 ? ctx.runtimeMinutes : FALLBACK_RUNTIME_MINUTES[kind];
  const floor = MIN_MIB_PER_MINUTE[resolution] * runtime * MIB;
  if (measured < floor) {
    const label = resolution === 'sd' ? 'SD' : resolution;
    const what = pool ? 'the main video' : 'its archives';
    return {
      ok: false,
      rule: 'tooSmall',
      reason: `Fake release: ${what} is only ${mib(measured)} MiB, implausibly small for ${label} with ${runtime} min runtime (at least ${mib(floor)} MiB expected)`,
    };
  }
  return { ok: true };
}

function mib(bytes: number): string {
  const v = bytes / MIB;
  return v >= 10 ? String(Math.round(v)) : v.toFixed(1);
}

/** Where the filter caught a release (timeline / notification data). */
export type SafetyTrigger = 'metadata' | 'import' | 'unpack';

/**
 * Expected runtime of one movie / episode of a tracked download from the library, or null:
 * the first grabbed episode's runtime, else the series' typical runtime; the movie's runtime.
 */
export function expectedRuntimeMinutes(
  db: Db,
  row: {
    mediaType?: AnyMediaType | null | undefined;
    movieId?: number | null | undefined;
    seriesId?: number | null | undefined;
    episodeIds?: readonly number[] | null | undefined;
  },
): number | null {
  try {
    if (row.mediaType === 'movie' && row.movieId != null) {
      return db.select({ m: movies.runtimeMinutes }).from(movies).where(eq(movies.id, row.movieId)).get()?.m ?? null;
    }
    if (row.mediaType === 'series') {
      const episodeId = row.episodeIds?.[0];
      if (episodeId !== undefined) {
        const minutes = db.select({ m: episodes.runtimeMinutes }).from(episodes).where(eq(episodes.id, episodeId)).get()?.m;
        if (minutes) return minutes;
      }
      if (row.seriesId != null) return db.select({ m: series.runtimeMinutes }).from(series).where(eq(series.id, row.seriesId)).get()?.m ?? null;
    }
  } catch {
    // Library tables missing (a test database without them): no runtime known.
  }
  return null;
}

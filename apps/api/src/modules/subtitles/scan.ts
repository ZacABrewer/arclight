import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { MediaInfo } from '@arclight/shared';
import { parseLanguageTag, parseSubtitleFileName, type ProbeResult } from '@arclight/subtitles';
import type { ProcessRunner } from './runner.js';

// Disk side of indexing (spec R7, R9.8): external subtitle files next to the video (and in the
// configured subtitle folder) plus embedded subtitle streams from ffprobe or stored media info.

export interface ScannedExternal {
  path: string;
  language: string;
  forced: boolean;
  hi: boolean;
  format: string;
  size: number;
  mtime: string;
}

export interface ScannedEmbedded {
  language: string;
  forced: boolean;
  hi: boolean;
  streamIndex: number | null;
  codec: string | null;
}

export const BITMAP_CODECS: ReadonlySet<string> = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub', 'dvb_teletext']);
export const TEXT_CODECS: ReadonlySet<string> = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);

/** Subtitle extensions the delete route may remove (R9.7). */
export const SUBTITLE_EXTENSIONS: ReadonlySet<string> = new Set(['srt', 'sub', 'smi', 'txt', 'ssa', 'ass', 'mpl', 'vtt']);

/** External subtitles belonging to `videoPath` in its folder and any extra folders. */
export async function scanExternal(videoPath: string, extraDirs: readonly string[] = []): Promise<ScannedExternal[]> {
  const dirs = [...new Set([dirname(videoPath), ...extraDirs])];
  const out: ScannedExternal[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name === basename(videoPath)) continue;
      const path = join(dir, name);
      // Name parsing works on base names, so the folder of the subtitle does not matter.
      const parsed = parseSubtitleFileName(join(dir, basename(videoPath)), path);
      if (!parsed?.language) continue;
      try {
        const s = await stat(path);
        if (!s.isFile()) continue;
        out.push({
          path,
          language: parsed.language,
          forced: parsed.forced,
          hi: parsed.hi,
          format: parsed.format,
          size: s.size,
          mtime: s.mtime.toISOString(),
        });
      } catch {
        // Vanished between readdir and stat.
      }
    }
  }
  return out;
}

export interface EmbeddedOptions {
  ignorePgs: boolean;
  ignoreVobsub: boolean;
  ignoreAss: boolean;
  /** Language assumed for "und" tracks; null skips them. */
  undefinedLanguage: string | null;
}

function ignoredCodec(codec: string, o: EmbeddedOptions): boolean {
  if (o.ignorePgs && codec === 'hdmv_pgs_subtitle') return true;
  if (o.ignoreVobsub && codec === 'dvd_subtitle') return true;
  if (o.ignoreAss && (codec === 'ass' || codec === 'ssa')) return true;
  return false;
}

const truthy = (v: number | boolean | undefined) => v === true || v === 1;

/** Embedded subtitle tracks from an ffprobe stream list (R7.2-R7.4). */
export function embeddedFromProbe(probe: ProbeResult, o: EmbeddedOptions): ScannedEmbedded[] {
  const out: ScannedEmbedded[] = [];
  for (const s of probe.streams ?? []) {
    if (s.codec_type !== 'subtitle') continue;
    const codec = s.codec_name ?? null;
    if (codec && ignoredCodec(codec, o)) continue;
    const raw = s.tags?.['language'] ?? '';
    const title = s.tags?.['title'] ?? '';
    const language = raw && raw !== 'und' ? parseLanguageTag(raw) : o.undefinedLanguage ? parseLanguageTag(o.undefinedLanguage) : undefined;
    if (!language) continue;
    const forced = truthy(s.disposition?.forced) || /forced/i.test(title);
    const hi = !forced && (truthy(s.disposition?.hearing_impaired) || /\b(sdh|cc|hi)\b/i.test(title));
    out.push({ language, forced, hi, streamIndex: s.index, codec });
  }
  return out;
}

/** Fallback when no probe is available: the subtitle languages recorded at import. */
export function embeddedFromMediaInfo(info: MediaInfo | null | undefined, o: EmbeddedOptions): ScannedEmbedded[] {
  const out: ScannedEmbedded[] = [];
  for (const raw of info?.subtitles ?? []) {
    const language = raw && raw !== 'und' ? parseLanguageTag(raw) : o.undefinedLanguage ? parseLanguageTag(o.undefinedLanguage) : undefined;
    if (!language) continue;
    out.push({ language, forced: false, hi: false, streamIndex: null, codec: null });
  }
  return out;
}

export type SubtitleProbe = (path: string) => Promise<ProbeResult | null>;

/** ffprobe through the runner; null when the binary is missing or the file unreadable. */
export function createFfprobe(runner: ProcessRunner, ffprobePath: () => string, timeoutMs = 60_000): SubtitleProbe {
  return async (path) => {
    const r = await runner(ffprobePath(), ['-v', 'error', '-print_format', 'json', '-show_streams', path], { timeoutMs });
    if (!r.ok) return null;
    try {
      const parsed = JSON.parse(r.stdout.toString('utf8')) as ProbeResult;
      return Array.isArray(parsed.streams) ? parsed : null;
    } catch {
      return null;
    }
  };
}

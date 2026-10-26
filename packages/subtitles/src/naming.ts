import { parseLanguageTag } from './languages.js';
import type { LanguageTag, SubtitleFormat } from './types.js';

// Subtitle file naming (spec section 9.1/9.2).

export type HiExtension = 'hi' | 'cc' | 'sdh';

export interface NamingStyle {
  /** Tag used for HI subtitles; default "hi". */
  hiExtension?: HiExtension | undefined;
  /** Omit the language component entirely (R9.2). */
  singleLanguage?: boolean | undefined;
  /** Output format/extension; default srt. */
  format?: SubtitleFormat | undefined;
  /** Target folder (R9.3): next to the video (default), a fixed folder, or a subfolder. */
  folder?: { mode: 'current' } | { mode: 'absolute'; path: string } | { mode: 'relative'; name: string } | undefined;
}

function splitPath(p: string): { dir: string; sep: string; base: string } {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  const sep = p.includes('\\') && !p.includes('/') ? '\\' : '/';
  if (idx < 0) return { dir: '', sep, base: p };
  return { dir: p.slice(0, idx), sep: p[idx] === '\\' ? '\\' : '/', base: p.slice(idx + 1) };
}

/** Normalise the language component for file names: pob -> pt-BR, zht -> zh-Hant, eng -> en. */
export function fileLanguageCode(tag: LanguageTag): string {
  return parseLanguageTag(tag) ?? tag;
}

/**
 * Path for a subtitle: `<video base>.<lang>[.<forced|hi tag>].<ext>`. Forced wins over HI.
 * Examples: Movie.en.srt, Movie.en.forced.srt, Movie.en.hi.srt, Movie.pt-BR.srt, Movie.srt.
 */
export function nameSubtitleFile(
  mediaPath: string,
  languageTag: LanguageTag,
  flags: { forced?: boolean | undefined; hi?: boolean | undefined } = {},
  style: NamingStyle = {},
): string {
  const { dir, sep, base } = splitPath(mediaPath);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const parts = [stem];
  if (!style.singleLanguage) {
    parts.push(fileLanguageCode(languageTag));
    if (flags.forced) parts.push('forced');
    else if (flags.hi) parts.push(style.hiExtension ?? 'hi');
  }
  const format = style.format && style.format !== 'unknown' ? style.format : 'srt';
  const fileName = `${parts.join('.')}.${format}`;
  const folder = style.folder ?? { mode: 'current' as const };
  let targetDir = dir;
  if (folder.mode === 'absolute') targetDir = folder.path.replace(/[\\/]+$/, '');
  else if (folder.mode === 'relative') targetDir = dir ? `${dir}${sep}${folder.name}` : folder.name;
  return targetDir ? `${targetDir}${sep}${fileName}` : fileName;
}

const SUB_EXTS = ['srt', 'sub', 'smi', 'txt', 'ssa', 'ass', 'mpl', 'vtt'];

/**
 * Parse an external subtitle file name against its video (R9.8): language, forced and HI
 * from the tokens between the video stem and the extension. Undefined when it does not belong.
 */
export function parseSubtitleFileName(
  videoPath: string,
  subtitlePath: string,
): { language: LanguageTag | undefined; forced: boolean; hi: boolean; format: string } | undefined {
  const video = splitPath(videoPath).base;
  const stem = video.includes('.') ? video.slice(0, video.lastIndexOf('.')) : video;
  const sub = splitPath(subtitlePath).base;
  const ext = sub.slice(sub.lastIndexOf('.') + 1).toLowerCase();
  if (!SUB_EXTS.includes(ext)) return undefined;
  if (!sub.toLowerCase().startsWith(stem.toLowerCase())) return undefined;
  const middle = sub.slice(stem.length, sub.length - ext.length - 1);
  if (middle && !middle.startsWith('.')) return undefined;
  const tokens = middle.split('.').filter(Boolean).map((t) => t.toLowerCase());
  let language: LanguageTag | undefined;
  let forced = false;
  let hi = false;
  for (const t of tokens) {
    if (t === 'forced' || t === 'embedded-forced') forced = true;
    else if (t === 'hi' || t === 'cc' || t === 'sdh') hi = true;
    else if (['normal', 'default', 'embedded', 'custom'].includes(t)) continue;
    else language ??= parseLanguageTag(t);
  }
  return { language, forced, hi: hi && !forced, format: ext };
}

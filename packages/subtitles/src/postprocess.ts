import { languageName, toAlpha2, toAlpha3 } from './languages.js';
import type { LanguageTag, ProviderKind } from './types.js';

// Post-processing descriptors (spec section 11). Nothing here runs a process: the api module
// takes the argv/env these builders return and spawns them (without a shell, with a timeout).

export interface CommandDescriptor {
  command: string;
  args: string[];
  env?: Record<string, string> | undefined;
  timeoutMs: number;
}

// ---------------------------------------------------------------------------------------
// Sync engines
// ---------------------------------------------------------------------------------------

export interface FfsubsyncOptions {
  binary?: string | undefined;
  /** Video file (or extracted reference audio). */
  reference: string;
  subtitle: string;
  output: string;
  /** e.g. "a:0" (force_audio) or "a:1" (original-language track). */
  referenceStream?: string | undefined;
  maxOffsetSeconds?: number | undefined;
  noFixFramerate?: boolean | undefined;
  gss?: boolean | undefined;
  vad?: 'webrtc' | 'auditok' | 'silero' | undefined;
  timeoutMs?: number | undefined;
}

/** ffsubsync argv (R11.11 defaults: max offset 60, no-fix-framerate on, gss on). */
export function buildFfsubsyncCommand(o: FfsubsyncOptions): CommandDescriptor {
  const args = [o.reference, '-i', o.subtitle, '-o', o.output, '--max-offset-seconds', String(o.maxOffsetSeconds ?? 60)];
  if (o.noFixFramerate ?? true) args.push('--no-fix-framerate');
  if (o.gss ?? true) args.push('--gss');
  if (o.referenceStream) args.push('--reference-stream', o.referenceStream);
  if (o.vad) args.push('--vad', o.vad);
  return { command: o.binary ?? 'ffsubsync', args, timeoutMs: o.timeoutMs ?? 600_000 };
}

export interface AlassOptions {
  binary?: string | undefined;
  /** Reference: the video, or a correctly timed subtitle. */
  reference: string;
  subtitle: string;
  output: string;
  /** Disable split detection (pure offset). */
  noSplit?: boolean | undefined;
  /** Disable framerate guessing (mirrors no_fix_framerate). */
  disableFpsGuessing?: boolean | undefined;
  splitPenalty?: number | undefined;
  timeoutMs?: number | undefined;
}

/** alass argv: `alass <reference> <subtitle> <output> [options]`. */
export function buildAlassCommand(o: AlassOptions): CommandDescriptor {
  const args = [o.reference, o.subtitle, o.output];
  if (o.noSplit) args.push('--no-split');
  if (o.disableFpsGuessing ?? true) args.push('--disable-fps-guessing');
  if (o.splitPenalty !== undefined) args.push('--split-penalty', String(o.splitPenalty));
  return { command: o.binary ?? 'alass', args, timeoutMs: o.timeoutMs ?? 600_000 };
}

/** Temporary output path for sync: `<name>.synced.<ext>` (R11.13). */
export function syncedOutputPath(subtitlePath: string): string {
  const dot = subtitlePath.lastIndexOf('.');
  return dot > 0 ? `${subtitlePath.slice(0, dot)}.synced${subtitlePath.slice(dot)}` : `${subtitlePath}.synced`;
}

export interface SyncSettings {
  enabled: boolean;
  useThreshold: boolean;
  /** Percent (series threshold or movie threshold, by media type). */
  threshold: number;
  blacklistedProviders?: readonly string[] | undefined;
}

/** R11.12: enabled, not forced, provider not blacklisted, threshold off or percent <= threshold. */
export function shouldSync(s: SyncSettings, sub: { forced: boolean; provider: string; percent: number }, manual = false): boolean {
  if (manual) return true;
  if (!s.enabled || sub.forced) return false;
  if (s.blacklistedProviders?.includes(sub.provider)) return false;
  return !s.useThreshold || sub.percent <= s.threshold;
}

// ---------------------------------------------------------------------------------------
// Custom post-processing command
// ---------------------------------------------------------------------------------------

export interface PostProcessContext {
  videoPath: string;
  subtitlePath: string;
  language: LanguageTag;
  forced: boolean;
  hi: boolean;
  /** Audio language of the video. */
  audioLanguage?: LanguageTag | undefined;
  percent: number;
  subtitleId: string;
  provider: ProviderKind | string;
  uploader?: string | undefined;
  releaseInfo?: string | undefined;
  seriesId?: number | undefined;
  /** Episode id, or movie id for movies. */
  episodeId?: number | undefined;
}

function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i < 0 ? '' : p.slice(0, i);
}
function stem(p: string): string {
  const base = p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Placeholder values (R11.4). */
export function postProcessVariables(c: PostProcessContext): Record<string, string> {
  const suffix = c.forced ? ':forced' : c.hi ? ':hi' : '';
  const code2 = `${toAlpha2(c.language) ?? c.language}${suffix}`;
  const code3 = `${toAlpha3(c.language) ?? c.language}${suffix}`;
  const audio = c.audioLanguage;
  return {
    directory: dirname(c.videoPath),
    episode: c.videoPath,
    episode_name: stem(c.videoPath),
    subtitles: c.subtitlePath,
    subtitles_language: languageName(c.language),
    subtitles_language_code2: code2,
    subtitles_language_code3: code3,
    subtitles_language_code2_dot: code2.replace(':', '.'),
    subtitles_language_code3_dot: code3.replace(':', '.'),
    episode_language: audio ? languageName(audio) : '',
    episode_language_code2: audio ? toAlpha2(audio) ?? '' : '',
    episode_language_code3: audio ? toAlpha3(audio) ?? '' : '',
    score: String(c.percent),
    subtitle_id: c.subtitleId,
    provider: String(c.provider),
    uploader: c.uploader ?? '',
    release_info: c.releaseInfo ?? '',
    series_id: c.seriesId !== undefined ? String(c.seriesId) : '',
    episode_id: c.episodeId !== undefined ? String(c.episodeId) : '',
  };
}

/** Split a command line like a POSIX shell would (quotes and backslash escapes), no expansion. */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inArg = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && (line[i + 1] === '"' || line[i + 1] === '\\')) cur += line[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inArg = true;
    } else if (ch === '\\' && i + 1 < line.length) {
      cur += line[++i];
      inArg = true;
    } else if (/\s/.test(ch)) {
      if (inArg) out.push(cur);
      cur = '';
      inArg = false;
    } else {
      cur += ch;
      inArg = true;
    }
  }
  if (quote) throw new Error('unterminated quote in command line');
  if (inArg) out.push(cur);
  return out;
}

/** Environment variables exposed to custom scripts: ARCLIGHT_<PLACEHOLDER>. */
export function postProcessEnv(vars: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) env[`ARCLIGHT_${k.toUpperCase()}`] = v;
  return env;
}

/**
 * Build the post-processing command (R11.3): split, substitute placeholders per argument,
 * drop arguments that are a lone placeholder with an empty value. Env vars carry the same data.
 */
export function buildPostProcessCommand(template: string, ctx: PostProcessContext, timeoutMs = 60_000): CommandDescriptor {
  const vars = postProcessVariables(ctx);
  const parts = splitCommandLine(template);
  if (parts.length === 0) throw new Error('empty post-processing command');
  const args: string[] = [];
  for (const part of parts) {
    const lone = /^\{\{(\w+)\}\}$/.exec(part);
    if (lone && (vars[lone[1]!] ?? '') === '') continue;
    args.push(part.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m));
  }
  const [command, ...rest] = args;
  return { command: command!, args: rest, env: postProcessEnv(vars), timeoutMs };
}

/** R11.2: run when the threshold toggle is off, or the percent is strictly below it. */
export function shouldPostProcess(enabled: boolean, useThreshold: boolean, threshold: number, percent: number): boolean {
  return enabled && (!useThreshold || percent < threshold);
}

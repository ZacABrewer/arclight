import { basename } from 'node:path';
import type { HealthFindingData, HealthFindingType, HealthScanMode, HealthSeverity } from '@arclight/shared';
import { baseLanguages, missingLanguages } from '../additional-languages/audio.js';

// Pure health checks: given what was learnt about a file (stat, ffprobe, ffmpeg decode) and
// what the library expects of it, the problems found. No I/O here; service.ts gathers the
// facts and tools.ts runs the processes.

export type FileKind = 'video' | 'track' | 'audiobook';

export type StatOutcome =
  | { kind: 'missing' }
  | { kind: 'unreadable'; message: string }
  | { kind: 'ok'; sizeBytes: number; mtimeMs: number };

export interface ProbeInfo {
  durationSeconds: number | null;
  hasVideo: boolean;
  audioStreamCount: number;
  /** Raw stream language tags (any spelling; untagged streams omitted). */
  audioLanguages: string[];
}

/** null: ffprobe is not available (probe-based checks are skipped). */
export type ProbeOutcome = { ok: true; info: ProbeInfo } | { ok: false; message: string } | null;

/** null: ffmpeg is not available or decoding was skipped. */
export type DecodeOutcome = { exitCode: number | null; errors: string[] } | null;

export interface LanguageRequirement {
  /** Any one of these must be present (profile languages, base tags). Empty: anything goes. */
  wanted: string[];
  /** Every one of these must be present ("Add additional…" audio languages, base tags). */
  required: string[];
}

export interface FileFacts {
  kind: FileKind;
  path: string;
  stat: StatOutcome;
  probe?: ProbeOutcome | undefined;
  decode?: DecodeOutcome | undefined;
  decodeMode?: HealthScanMode | undefined;
  /** Runtime the metadata gives (seconds); null when unknown. */
  expectedSeconds?: number | null | undefined;
  /** Music: the track number read from the file's tags. */
  trackNumber?: number | null | undefined;
  language?: LanguageRequirement | null | undefined;
  /** Share of the expected runtime below which a file counts as truncated. */
  truncatedPercent: number;
}

export interface Detected {
  type: HealthFindingType;
  severity: HealthSeverity;
  details: string;
  data: HealthFindingData;
}

/** A video this short while its item runs this long is a sample rather than a broken copy. */
export const SAMPLE_MAX_SECONDS = 300;
export const SAMPLE_MIN_EXPECTED_SECONDS = 1200;
/** Tracks must also be this many seconds short (metadata lengths are exact, encoders pad). */
export const TRACK_MIN_SHORTFALL_SECONDS = 10;
/** Decode error lines from which a decode problem is an error rather than a warning. */
export const DECODE_ERROR_LINES = 10;
/** Error lines kept on a finding. */
export const KEPT_ERROR_LINES = 5;

const SAMPLE_NAME = /(^|[\W_])sample([\W_]|$)/i;

export function isSampleName(path: string): boolean {
  return SAMPLE_NAME.test(basename(path.replace(/\\/g, '/')));
}

function mmss(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/** Plain-language English for a finding (API clients; the web app has its own strings). */
export function describe(type: HealthFindingType, data: HealthFindingData = {}): string {
  switch (type) {
    case 'missing':
      return 'The file is missing: it is in the library but no longer on disk.';
    case 'empty':
      return 'The file is empty (0 bytes). The download or copy probably failed.';
    case 'unreadable':
      return `The file cannot be read${data.message ? ` (${data.message})` : ''}. Check permissions and the disk.`;
    case 'unparseable':
      return `ffprobe cannot read the file${data.message ? ` (${data.message})` : ''}. The container is probably corrupt.`;
    case 'decodeErrors':
      return `ffmpeg reported ${data.errorCount ?? 0} decode error${data.errorCount === 1 ? '' : 's'} (${data.mode === 'deep' ? 'whole file' : 'quick check'}). Playback may stutter, freeze or stop.`;
    case 'truncated':
      return `The file plays for ${mmss(data.actualSeconds ?? 0)}, but the runtime should be about ${mmss(data.expectedSeconds ?? 0)}. It is probably cut short.`;
    case 'sample':
      return 'This looks like a sample, not the full item.';
    case 'noAudio':
      return 'The file has no audio track.';
    case 'noVideo':
      return 'The file has no video track.';
    case 'wrongLanguage':
      return data.missing?.length
        ? `Audio is missing ${data.missing.join(', ')} (file has ${data.have?.join(', ') || 'none'}).`
        : `Audio is ${data.have?.join(', ') || 'unknown'}, but the profile wants ${data.wanted?.join(' or ') ?? ''}.`;
    case 'trackNumberMissing':
      return 'The track has no track number in its tags.';
    case 'trackGaps':
      return `The album's track numbers skip ${data.missingNumbers?.join(', ') ?? ''}${data.disc && data.disc > 1 ? ` on disc ${data.disc}` : ''}.`;
    case 'bookParts': {
      const parts: string[] = [];
      if (data.missingNumbers?.length) parts.push(`part${data.missingNumbers.length === 1 ? '' : 's'} ${data.missingNumbers.join(', ')} missing`);
      if (data.duplicateNumbers?.length) parts.push(`part${data.duplicateNumbers.length === 1 ? '' : 's'} ${data.duplicateNumbers.join(', ')} twice`);
      if (data.outOfOrder) parts.push('file names are out of part order');
      return `The book's parts are not in order: ${parts.join('; ')}.`;
    }
  }
}

function found(type: HealthFindingType, severity: HealthSeverity, data: HealthFindingData = {}): Detected {
  return { type, severity, details: describe(type, data), data };
}

/** Every problem of one file. Missing / empty / unreadable / unparseable stop further checks. */
export function checkFile(f: FileFacts): Detected[] {
  if (f.stat.kind === 'missing') return [found('missing', 'error')];
  if (f.stat.kind === 'unreadable') return [found('unreadable', 'error', { message: f.stat.message })];
  if (f.stat.sizeBytes === 0) return [found('empty', 'error')];

  const out: Detected[] = [];
  if (f.kind === 'track' && (f.trackNumber === null || f.trackNumber === undefined)) out.push(found('trackNumberMissing', 'info'));

  const probe = f.probe;
  if (probe && !probe.ok) return [...out, found('unparseable', 'error', { message: probe.message })];
  const info = probe?.ok ? probe.info : null;

  const sampleByName = f.kind === 'video' && isSampleName(f.path);
  if (info) {
    if (f.kind === 'video' && !info.hasVideo) out.push(found('noVideo', 'error'));
    if (info.audioStreamCount === 0) out.push(found('noAudio', 'error'));
    const truncated = truncation(f.kind, info.durationSeconds, f.expectedSeconds ?? null, f.truncatedPercent);
    if (truncated) {
      const data = { actualSeconds: info.durationSeconds, expectedSeconds: f.expectedSeconds ?? null };
      if (f.kind === 'video' && info.durationSeconds !== null && info.durationSeconds < SAMPLE_MAX_SECONDS && (f.expectedSeconds ?? 0) >= SAMPLE_MIN_EXPECTED_SECONDS) {
        if (!sampleByName) out.push(found('sample', 'warning', data));
      } else if (!sampleByName) {
        out.push(found('truncated', 'warning', data));
      }
    }
    if (f.kind === 'video' && f.language) {
      const wrong = languageProblem(info.audioLanguages, f.language);
      if (wrong) out.push(found('wrongLanguage', 'warning', wrong));
    }
  }
  if (sampleByName) out.unshift(found('sample', 'warning', info ? { actualSeconds: info.durationSeconds, expectedSeconds: f.expectedSeconds ?? null } : {}));

  const decode = f.decode;
  if (decode && (decode.errors.length > 0 || (decode.exitCode !== null && decode.exitCode !== 0))) {
    const errorCount = Math.max(decode.errors.length, 1);
    const severe = (decode.exitCode !== null && decode.exitCode !== 0) || decode.errors.length >= DECODE_ERROR_LINES;
    out.push(
      found('decodeErrors', severe ? 'error' : 'warning', {
        mode: f.decodeMode ?? 'quick',
        errorCount,
        errors: decode.errors.slice(0, KEPT_ERROR_LINES).map((l) => l.slice(0, 300)),
      }),
    );
  }
  return out;
}

/** Whether a duration is "much shorter" than expected. */
export function truncation(kind: FileKind, actual: number | null, expected: number | null, percent: number): boolean {
  if (actual === null || expected === null || expected <= 0) return false;
  if (actual >= (expected * percent) / 100) return false;
  if (kind === 'track' && expected - actual < TRACK_MIN_SHORTFALL_SECONDS) return false;
  return true;
}

/** wrongLanguage data when the file's audio fails the requirement; null when fine or unknown. */
export function languageProblem(raw: readonly string[], req: LanguageRequirement): HealthFindingData | null {
  const have = baseLanguages(raw);
  // Untagged audio says nothing about its language.
  if (have.length === 0) return null;
  const missing = req.required.length ? missingLanguages(req.required, have) : [];
  if (missing.length > 0) return { have, wanted: req.wanted, missing };
  if (req.wanted.length > 0 && missingLanguages(req.wanted, have).length === req.wanted.length) return { have, wanted: req.wanted };
  return null;
}

/**
 * What an item wants: the profile's languages (`original` resolved to the item's original
 * language; a profile listing `unknown`, or none, accepts anything) plus "Add additional…"
 * audio languages, which are all required.
 */
export function languageRequirement(profileLanguages: readonly string[], originalLanguage: string | null | undefined, additional: readonly string[] = []): LanguageRequirement | null {
  const anything = profileLanguages.length === 0 || profileLanguages.some((l) => l === 'unknown' || l === 'any');
  const wanted = anything ? [] : baseLanguages(profileLanguages.map((l) => (l === 'original' ? (originalLanguage ?? null) : l)));
  const required = baseLanguages(additional);
  if (wanted.length === 0 && required.length === 0) return null;
  return { wanted, required };
}

// ---- album / book structure -----------------------------------------------------------------

export interface TrackGap {
  disc: number;
  missing: number[];
}

/** Gaps in the track numbers of an album's files, per disc (from 1 to the highest number). */
export function trackGaps(files: ReadonlyArray<{ discNumber: number | null; trackNumber: number | null }>): TrackGap[] {
  const byDisc = new Map<number, Set<number>>();
  for (const f of files) {
    if (f.trackNumber === null || f.trackNumber < 1) continue;
    const disc = f.discNumber ?? 1;
    let set = byDisc.get(disc);
    if (!set) byDisc.set(disc, (set = new Set()));
    set.add(f.trackNumber);
  }
  const out: TrackGap[] = [];
  for (const [disc, set] of [...byDisc].sort((a, b) => a[0] - b[0])) {
    if (set.size < 2) continue;
    const max = Math.max(...set);
    const missing: number[] = [];
    for (let n = 1; n <= max; n++) if (!set.has(n)) missing.push(n);
    if (missing.length > 0) out.push({ disc, missing });
  }
  return out;
}

export interface BookPartProblem {
  missingNumbers: number[];
  duplicateNumbers: number[];
  outOfOrder: boolean;
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * Part problems of a multi-file book: numbers missing between 1 and the highest part, numbers
 * used twice, and file names whose natural order disagrees with the part numbers. Null when the
 * book has one file, its files carry no part numbers, or nothing is wrong.
 */
export function bookPartProblems(files: ReadonlyArray<{ path: string; partNumber: number | null }>): BookPartProblem | null {
  const numbered = files.filter((f): f is { path: string; partNumber: number } => f.partNumber !== null && f.partNumber > 0);
  if (files.length < 2 || numbered.length < 2) return null;
  const counts = new Map<number, number>();
  for (const f of numbered) counts.set(f.partNumber, (counts.get(f.partNumber) ?? 0) + 1);
  const max = Math.max(...counts.keys());
  const missingNumbers: number[] = [];
  for (let n = 1; n <= max; n++) if (!counts.has(n)) missingNumbers.push(n);
  const duplicateNumbers = [...counts].filter(([, c]) => c > 1).map(([n]) => n).sort((a, b) => a - b);
  const byName = [...numbered].sort((a, b) => collator.compare(basename(a.path.replace(/\\/g, '/')), basename(b.path.replace(/\\/g, '/'))));
  let outOfOrder = false;
  for (let i = 1; i < byName.length; i++) if (byName[i]!.partNumber < byName[i - 1]!.partNumber) outOfOrder = true;
  if (missingNumbers.length === 0 && duplicateNumbers.length === 0 && !outOfOrder) return null;
  return { missingNumbers, duplicateNumbers, outOfOrder };
}

// ---- ffmpeg decode plan ---------------------------------------------------------------------

export interface DecodeSlice {
  /** Seconds from the start. */
  start: number;
  /** Seconds to decode; null = to the end. */
  length: number | null;
}

/** Seconds decoded per quick slice. */
export const QUICK_SLICE_SECONDS = 10;

/**
 * Quick mode: a slice at the start, the middle and the end (a short file is decoded whole);
 * unknown duration: the first 30 s. Deep mode: everything.
 */
export function decodeSlices(mode: HealthScanMode, durationSeconds: number | null, slice = QUICK_SLICE_SECONDS): DecodeSlice[] {
  if (mode === 'deep') return [{ start: 0, length: null }];
  if (durationSeconds === null || !(durationSeconds > 0)) return [{ start: 0, length: slice * 3 }];
  if (durationSeconds <= slice * 4) return [{ start: 0, length: null }];
  const mid = Math.max(0, Math.floor(durationSeconds / 2 - slice / 2));
  const end = Math.max(0, Math.floor(durationSeconds - slice - 1));
  return [
    { start: 0, length: slice },
    { start: mid, length: slice },
    { start: end, length: slice },
  ];
}

/** ffmpeg arguments decoding one slice to nowhere, errors only on stderr. */
export function decodeArgs(path: string, s: DecodeSlice, kind: FileKind): string[] {
  const args = ['-hide_banner', '-nostdin', '-nostats', '-v', 'error'];
  if (s.start > 0) args.push('-ss', String(s.start));
  if (s.length !== null) args.push('-t', String(s.length));
  args.push('-i', path);
  if (kind === 'video') args.push('-map', '0:v:0?', '-map', '0:a?');
  else args.push('-map', '0:a?');
  args.push('-f', 'null', '-');
  return args;
}

export interface PriorityTools {
  nice: string | null;
  ionice: string | null;
}

/** Wraps a command in `nice -n 19` and `ionice -c 3` when they exist (Linux). */
export function withLowPriority(binary: string, args: readonly string[], tools: PriorityTools): { file: string; args: string[] } {
  let file = binary;
  let argv = [...args];
  if (tools.ionice) {
    argv = ['-c', '3', file, ...argv];
    file = tools.ionice;
  }
  if (tools.nice) {
    argv = ['-n', '19', file, ...argv];
    file = tools.nice;
  }
  return { file, args: argv };
}

/** Whether `now` is inside a daily HH:MM window (a window may cross midnight). */
export function insideWindow(now: Date, window: { enabled: boolean; start: string; end: string }): boolean {
  if (!window.enabled) return true;
  const minutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const start = minutes(window.start);
  const end = minutes(window.end);
  const at = now.getHours() * 60 + now.getMinutes();
  if (start === end) return true;
  return start < end ? at >= start && at < end : at >= start || at < end;
}

/** The HealthScan cron for the settings; null when the schedule is off. */
export function scheduleCron(settings: { schedule: 'off' | 'daily' | 'weekly'; window: { enabled: boolean; start: string } }): string | null {
  if (settings.schedule === 'off') return null;
  const [h, m] = settings.window.enabled ? [Number(settings.window.start.slice(0, 2)), Number(settings.window.start.slice(3, 5))] : [3, 0];
  return settings.schedule === 'daily' ? `${m} ${h} * * *` : `${m} ${h} * * 0`;
}

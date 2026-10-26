import type { SubtitleFormat } from './types.js';

// Subtitle text formats: detection, validation and conversion to SubRip.

const SRT_TIMING = /^\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}/m;
const MICRODVD_LINE = /^\{\d+\}\{\d*\}/m;

/** Detect the format of decoded subtitle text. */
export function detectFormat(text: string, fileName?: string): SubtitleFormat {
  const head = text.replace(/^﻿/, '').trimStart().slice(0, 4096);
  if (/^WEBVTT/.test(head)) return 'vtt';
  if (/^\[Script Info\]/im.test(head)) {
    return /ScriptType:\s*v4\.00\+/i.test(head) || /\[V4\+ Styles\]/i.test(text) ? 'ass' : 'ssa';
  }
  if (SRT_TIMING.test(head)) return 'srt';
  if (MICRODVD_LINE.test(head)) return 'sub';
  const ext = fileName?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext === 'srt' || ext === 'ass' || ext === 'ssa' || ext === 'vtt' || ext === 'sub') return ext;
  return 'unknown';
}

/** Format detection on raw bytes (ASCII-compatible sniff; archives give 'unknown'). */
export function detectFormatFromBytes(bytes: Uint8Array, fileName?: string): SubtitleFormat {
  const head = bytes.subarray(0, 4096);
  // UTF-16 BOMs: decode accordingly for the sniff.
  let text: string;
  if (head[0] === 0xff && head[1] === 0xfe) text = new TextDecoder('utf-16le').decode(head);
  else if (head[0] === 0xfe && head[1] === 0xff) text = new TextDecoder('utf-16be').decode(head);
  else text = new TextDecoder('latin1').decode(head);
  return detectFormat(text, fileName);
}

export interface Cue {
  startMs: number;
  endMs: number;
  text: string;
}

function parseTime(h: string, m: string, s: string, frac: string): number {
  const ms = Number(frac.padEnd(3, '0').slice(0, 3));
  return Number(h) * 3600000 + Number(m) * 60000 + Number(s) * 1000 + ms;
}

export function formatSrtTime(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000);
  const m = Math.floor((t % 3600000) / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const f = t % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(f, 3)}`;
}

/** Parse SubRip (tolerant: missing indices, dots as separators, extra blank lines). */
export function parseSrt(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  const timing = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;
  for (const block of blocks) {
    const lines = block.split('\n');
    const idx = lines.findIndex((l) => timing.test(l));
    if (idx < 0) continue;
    const m = timing.exec(lines[idx]!)!;
    const body = lines.slice(idx + 1).join('\n').trim();
    cues.push({
      startMs: parseTime(m[1]!, m[2]!, m[3]!, m[4]!),
      endMs: parseTime(m[5]!, m[6]!, m[7]!, m[8]!),
      text: body,
    });
  }
  return cues;
}

export function serializeSrt(cues: readonly Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${formatSrtTime(c.startMs)} --> ${formatSrtTime(c.endMs)}\n${c.text}\n`).join('\n');
}

/** Parse WebVTT cues (settings and NOTE/STYLE blocks dropped, tags stripped). */
export function parseVtt(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  const timing = /(?:(\d{1,2}):)?(\d{2}):(\d{2})\.(\d{1,3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})\.(\d{1,3})/;
  for (const block of blocks) {
    const lines = block.split('\n');
    const idx = lines.findIndex((l) => timing.test(l));
    if (idx < 0) continue;
    const m = timing.exec(lines[idx]!)!;
    const body = lines
      .slice(idx + 1)
      .join('\n')
      .replace(/<\/?(?:c|v|lang|ruby|rt)(?:[.\s][^>]*)?>/g, '')
      .replace(/<\d{2}:[\d:.]+>/g, '')
      .trim();
    cues.push({
      startMs: parseTime(m[1] ?? '0', m[2]!, m[3]!, m[4]!),
      endMs: parseTime(m[5] ?? '0', m[6]!, m[7]!, m[8]!),
      text: body,
    });
  }
  return cues;
}

/** Parse ASS/SSA Dialogue lines. Override tags are removed; \N becomes a line break. */
export function parseAss(text: string): Cue[] {
  const cues: Cue[] = [];
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  let inEvents = false;
  let format: string[] = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
  for (const raw of lines) {
    const line = raw.trim();
    if (/^\[.*\]$/.test(line)) {
      inEvents = /^\[Events\]$/i.test(line);
      continue;
    }
    if (!inEvents) continue;
    const fm = /^Format:\s*(.*)$/i.exec(line);
    if (fm) {
      format = fm[1]!.split(',').map((f) => f.trim().toLowerCase());
      continue;
    }
    const dm = /^Dialogue:\s*(.*)$/i.exec(line);
    if (!dm) continue;
    const parts = dm[1]!.split(',');
    const textIdx = format.indexOf('text');
    const fields = parts.slice(0, textIdx);
    const body = parts.slice(textIdx).join(',');
    const start = fields[format.indexOf('start')] ?? '';
    const end = fields[format.indexOf('end')] ?? '';
    const t = /(\d+):(\d{2}):(\d{2})[.:](\d{1,3})/;
    const sm = t.exec(start);
    const em = t.exec(end);
    if (!sm || !em) continue;
    // ASS centiseconds: "0:00:01.50" is 1500 ms.
    const cs = (f: string) => (f.length === 2 ? f + '0' : f);
    const cleaned = body
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\[Nn]/g, '\n')
      .replace(/\\h/g, ' ')
      .trim();
    if (!cleaned) continue;
    cues.push({
      startMs: parseTime(sm[1]!, sm[2]!, sm[3]!, cs(sm[4]!)),
      endMs: parseTime(em[1]!, em[2]!, em[3]!, cs(em[4]!)),
      text: cleaned,
    });
  }
  return cues.sort((a, b) => a.startMs - b.startMs);
}

/** Parse MicroDVD ({start}{end}text) with a frame rate. "|" separates lines. */
export function parseMicroDvd(text: string, fps: number): Cue[] {
  const cues: Cue[] = [];
  let rate = fps;
  for (const line of text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')) {
    const m = /^\{(\d+)\}\{(\d*)\}(.*)$/.exec(line.trim());
    if (!m) continue;
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : start + Math.round(rate * 3);
    // A {1}{1}23.976 first line declares the frame rate.
    if (start === 1 && end === 1 && /^\d+(?:\.\d+)?$/.test(m[3]!.trim())) {
      rate = Number(m[3]!.trim());
      continue;
    }
    const body = m[3]!.replace(/\{[^}]*\}/g, '').split('|').join('\n').trim();
    cues.push({ startMs: (start / rate) * 1000, endMs: (end / rate) * 1000, text: body });
  }
  return cues;
}

/** Valid SubRip: at least one cue with non-negative duration. */
export function isValidSrt(text: string): boolean {
  const cues = parseSrt(text);
  return cues.length > 0 && cues.every((c) => c.endMs >= c.startMs);
}

/**
 * Convert any supported text format to SubRip. Returns undefined when the content is not a
 * recognisable subtitle. MicroDVD needs a frame rate (defaults to 23.976).
 */
export function convertToSrt(text: string, format?: SubtitleFormat, fps = 23.976): string | undefined {
  const f = format && format !== 'unknown' ? format : detectFormat(text);
  let cues: Cue[];
  switch (f) {
    case 'srt':
      cues = parseSrt(text);
      break;
    case 'vtt':
      cues = parseVtt(text);
      break;
    case 'ass':
    case 'ssa':
      cues = parseAss(text);
      break;
    case 'sub':
      cues = parseMicroDvd(text, fps);
      break;
    default:
      return undefined;
  }
  if (cues.length === 0) return undefined;
  return serializeSrt(cues);
}

/** Normalise line endings to LF and strip a leading BOM. */
export function normalizeLineEndings(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/**
 * HI heuristic on subtitle text (spec R9.5 step 2): bracketed cues, music symbols, and
 * parentheses (except Arabic/Persian, where parentheses are ordinary punctuation).
 */
export function looksHearingImpaired(text: string, languageTag?: string): boolean {
  const body = parseSrt(text).map((c) => c.text).join('\n') || text;
  if (/\[[^\]\n]{2,}\]/.test(body) || /\{[^}\n]{2,}\}/.test(body) || /[♪♫]/.test(body)) return true;
  const base = languageTag?.split('-')[0];
  if (base !== 'ar' && base !== 'fa' && /(^|\n)\s*\([^)\n]{2,}\)\s*($|\n)/.test(body)) return true;
  return false;
}

export function extensionFor(format: SubtitleFormat): string {
  return format === 'unknown' ? '.srt' : `.${format}`;
}

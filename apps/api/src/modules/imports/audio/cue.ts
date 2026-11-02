import { basename, extname } from 'node:path';
import type { MatchFile } from './track-match.js';

// Cue sheets (single-file album images, design 9.2). Pure: no I/O. A cue sheet lists the tracks
// of one or more audio files with their start times as `mm:ss:ff` (75 frames per second). The
// parser keeps what the importer and the splitter use: the disc's REM fields, the FILE entries
// and per track its title, performer, songwriter, ISRC, flags, gaps and indexes. Unknown
// commands are skipped with a warning, so a sheet from an odd ripper still yields its tracks.
//
// For matching, every cue track becomes a virtual `MatchFile` (`<image>#cue<n>`) whose duration
// is the distance to the next track's INDEX 01 in the same file (the last one runs to the end of
// the image). The existing release matcher then maps the cue tracks like real files.

export const CUE_FRAMES_PER_SECOND = 75;

export interface CueIndex {
  number: number;
  /** Offset into the track's FILE in frames (1/75 s). */
  frames: number;
}

export interface CueTrack {
  number: number;
  /** AUDIO, MODE1/2352, ... */
  type: string;
  /** The FILE entry the track belongs to (as written in the sheet). */
  file: string;
  title: string | null;
  performer: string | null;
  songwriter: string | null;
  isrc: string | null;
  flags: string[];
  pregapFrames: number | null;
  postgapFrames: number | null;
  indexes: CueIndex[];
  /** REM fields of the track (upper-case keys). */
  rem: Record<string, string>;
}

export interface CueFileEntry {
  name: string;
  /** WAVE, MP3, AIFF, BINARY, ... */
  type: string;
  tracks: CueTrack[];
}

export interface CueSheet {
  title: string | null;
  performer: string | null;
  songwriter: string | null;
  catalog: string | null;
  genre: string | null;
  date: string | null;
  discId: string | null;
  comment: string | null;
  discNumber: number | null;
  totalDiscs: number | null;
  replayGainAlbumGain: number | null;
  replayGainAlbumPeak: number | null;
  /** Disc-level REM fields (upper-case keys), including the ones above. */
  rem: Record<string, string>;
  files: CueFileEntry[];
  /** Every track in sheet order. */
  tracks: CueTrack[];
  warnings: string[];
}

export class CueParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CueParseError';
  }
}

// ---------------------------------------------------------------------------------------
// Text decoding
// ---------------------------------------------------------------------------------------

/**
 * Cue sheet bytes -> text. UTF-8 (BOM stripped) when the bytes are valid UTF-8; UTF-16 with a
 * BOM; otherwise Windows-1252, the code page most older rippers wrote (a superset of Latin-1
 * for the printable range).
 */
export function decodeCueText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const body = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return decodeWindows1252(body);
  }
}

// 0x80-0x9F of Windows-1252 (Node's TextDecoder treats the label as Latin-1); 0 = undefined.
const CP1252_HIGH = [
  0x20ac, 0, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017d, 0,
  0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0, 0x017e, 0x0178,
];

function decodeWindows1252(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b >= 0x80 && b < 0xa0 ? CP1252_HIGH[b - 0x80] || b : b);
  return out;
}

// ---------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------

/** `mm:ss:ff` -> frames. Minutes may exceed 99 (long images); null when malformed. */
export function parseCueTime(value: string): number | null {
  const m = /^(\d{1,4}):(\d{1,2}):(\d{1,2})$/.exec(value.trim());
  if (!m) return null;
  const [mm, ss, ff] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (ss > 59 || ff >= CUE_FRAMES_PER_SECOND) return null;
  return (mm * 60 + ss) * CUE_FRAMES_PER_SECOND + ff;
}

export function framesToMs(frames: number): number {
  return Math.round((frames * 1000) / CUE_FRAMES_PER_SECOND);
}

/** Splits a line into words; double-quoted runs are one word (quotes removed). */
function tokenize(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i]!)) i++;
    if (i >= line.length) break;
    if (line[i] === '"') {
      const end = line.indexOf('"', i + 1);
      // An unterminated quote runs to the end of the line.
      out.push(end < 0 ? line.slice(i + 1) : line.slice(i + 1, end));
      i = end < 0 ? line.length : end + 1;
    } else {
      let j = i;
      while (j < line.length && !/\s/.test(line[j]!)) j++;
      out.push(line.slice(i, j));
      i = j;
    }
  }
  return out;
}

/** The value after the command: one quoted string, or the rest of the line unquoted. */
function restValue(line: string, command: string): string | null {
  const rest = line.slice(line.toUpperCase().indexOf(command) + command.length).trim();
  if (!rest) return null;
  if (rest.startsWith('"')) {
    const end = rest.lastIndexOf('"');
    return (end > 0 ? rest.slice(1, end) : rest.slice(1)).trim() || null;
  }
  return rest;
}

function number(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : null;
}

/** "-7.89 dB" -> -7.89. */
function decibels(value: string | undefined): number | null {
  if (value === undefined) return null;
  const m = /^\s*([+-]?\d+(?:\.\d+)?)/.exec(value);
  return m ? Number(m[1]) : null;
}

/** Parse a cue sheet (text or raw bytes). Throws `CueParseError` when it lists no tracks. */
export function parseCueSheet(input: string | Uint8Array): CueSheet {
  const text = typeof input === 'string' ? input.replace(/^﻿/, '') : decodeCueText(input);
  const sheet: CueSheet = {
    title: null,
    performer: null,
    songwriter: null,
    catalog: null,
    genre: null,
    date: null,
    discId: null,
    comment: null,
    discNumber: null,
    totalDiscs: null,
    replayGainAlbumGain: null,
    replayGainAlbumPeak: null,
    rem: {},
    files: [],
    tracks: [],
    warnings: [],
  };
  let file: CueFileEntry | null = null;
  let track: CueTrack | null = null;

  const lines = text.split(/\r\n|\r|\n/);
  for (const [n, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line) continue;
    const words = tokenize(line);
    const command = words[0]!.toUpperCase();
    const where = `line ${n + 1}`;
    switch (command) {
      case 'REM': {
        const key = words[1]?.toUpperCase();
        if (!key) break;
        const value = restValue(line.slice(line.toUpperCase().indexOf('REM') + 3), words[1]!.toUpperCase()) ?? '';
        if (track) track.rem[key] = value;
        else sheet.rem[key] = value;
        break;
      }
      case 'FILE': {
        // FILE "name" TYPE: the type is the last word, the name everything before it.
        const name = words.length > 2 ? words.slice(1, -1).join(' ') : (words[1] ?? '');
        if (!name) {
          sheet.warnings.push(`${where}: FILE without a name`);
          break;
        }
        file = { name, type: words.length > 2 ? words[words.length - 1]!.toUpperCase() : 'WAVE', tracks: [] };
        sheet.files.push(file);
        track = null;
        break;
      }
      case 'TRACK': {
        const num = number(words[1]);
        if (!file) {
          sheet.warnings.push(`${where}: TRACK before any FILE`);
          break;
        }
        if (num === null || num < 1) {
          sheet.warnings.push(`${where}: bad track number`);
          break;
        }
        track = {
          number: num,
          type: (words[2] ?? 'AUDIO').toUpperCase(),
          file: file.name,
          title: null,
          performer: null,
          songwriter: null,
          isrc: null,
          flags: [],
          pregapFrames: null,
          postgapFrames: null,
          indexes: [],
          rem: {},
        };
        file.tracks.push(track);
        sheet.tracks.push(track);
        break;
      }
      case 'INDEX': {
        const num = number(words[1]);
        const frames = words[2] !== undefined ? parseCueTime(words[2]) : null;
        if (!track || num === null || frames === null) {
          sheet.warnings.push(`${where}: bad INDEX`);
          break;
        }
        track.indexes.push({ number: num, frames });
        break;
      }
      case 'TITLE':
      case 'PERFORMER':
      case 'SONGWRITER': {
        const value = restValue(line, command);
        const field = command === 'TITLE' ? 'title' : command === 'PERFORMER' ? 'performer' : 'songwriter';
        if (track) track[field] = value;
        else sheet[field] = value;
        break;
      }
      case 'ISRC':
        if (track) track.isrc = words[1] ?? null;
        break;
      case 'CATALOG':
        sheet.catalog = words[1] ?? null;
        break;
      case 'FLAGS':
        if (track) track.flags = words.slice(1).map((w) => w.toUpperCase());
        break;
      case 'PREGAP':
      case 'POSTGAP': {
        const frames = words[1] !== undefined ? parseCueTime(words[1]) : null;
        if (!track || frames === null) {
          sheet.warnings.push(`${where}: bad ${command}`);
          break;
        }
        if (command === 'PREGAP') track.pregapFrames = frames;
        else track.postgapFrames = frames;
        break;
      }
      case 'CDTEXTFILE':
        break;
      default:
        sheet.warnings.push(`${where}: unknown command ${words[0]}`);
    }
  }

  if (sheet.tracks.length === 0) throw new CueParseError('The cue sheet lists no tracks');
  const rem = sheet.rem;
  sheet.genre = rem['GENRE'] || null;
  sheet.date = rem['DATE'] || null;
  sheet.discId = rem['DISCID'] || null;
  sheet.comment = rem['COMMENT'] || null;
  sheet.discNumber = number(rem['DISCNUMBER']);
  sheet.totalDiscs = number(rem['TOTALDISCS']);
  sheet.replayGainAlbumGain = decibels(rem['REPLAYGAIN_ALBUM_GAIN']);
  sheet.replayGainAlbumPeak = number(rem['REPLAYGAIN_ALBUM_PEAK']);
  for (const t of sheet.tracks) {
    if (!t.indexes.some((i) => i.number === 1) && !t.indexes.some((i) => i.number === 0)) sheet.warnings.push(`track ${t.number}: no INDEX`);
    t.indexes.sort((a, b) => a.number - b.number);
  }
  return sheet;
}

// ---------------------------------------------------------------------------------------
// Track spans and virtual files
// ---------------------------------------------------------------------------------------

/** Where a track starts: INDEX 01, else INDEX 00; null without either. */
export function trackStartFrames(track: CueTrack): number | null {
  return track.indexes.find((i) => i.number === 1)?.frames ?? track.indexes.find((i) => i.number === 0)?.frames ?? null;
}

export interface CueTrackSpan {
  track: CueTrack;
  /** The resolved audio file path the track lives in. */
  imagePath: string;
  startMs: number;
  /** Null for the last track of its file (runs to the end). */
  endMs: number | null;
  /** Null when the end is open and the image duration unknown. */
  durationMs: number | null;
}

export interface CueImage {
  path: string;
  durationMs: number | null;
  /** Disc number from a `CD2/` folder, when the sheet has no REM DISCNUMBER. */
  discFromFolder?: number | null;
}

const stemOf = (name: string) => basename(name.replace(/\\/g, '/'), extname(name)).toLowerCase();

/**
 * The image a FILE entry names: same file name (any case), else the same stem with another
 * extension (sheets written for the `.wav` that was later compressed to `.flac`); a sheet with
 * one FILE and one image matches it regardless.
 */
export function resolveCueFile(entry: string, images: readonly CueImage[], fileCount = 2): CueImage | null {
  const name = basename(entry.replace(/\\/g, '/')).toLowerCase();
  return (
    images.find((i) => basename(i.path).toLowerCase() === name) ??
    images.find((i) => stemOf(i.path) === stemOf(name)) ??
    (fileCount === 1 && images.length === 1 ? images[0]! : null)
  );
}

/**
 * Start/end of every audio track. A track ends where the next track of the same file has its
 * INDEX 01 (a gap belongs to the track before it, like the disc plays); the last track of a
 * file ends with the image. Returns null when a FILE cannot be resolved or a track has no
 * index (the sheet does not describe these images).
 */
export function cueTrackSpans(sheet: CueSheet, images: readonly CueImage[]): CueTrackSpan[] | null {
  const out: CueTrackSpan[] = [];
  const audioFiles = sheet.files.filter((f) => f.tracks.some((t) => t.type === 'AUDIO'));
  for (const entry of audioFiles) {
    const image = resolveCueFile(entry.name, images, audioFiles.length);
    if (!image) return null;
    const audio = entry.tracks.filter((t) => t.type === 'AUDIO');
    for (const [i, track] of audio.entries()) {
      const start = trackStartFrames(track);
      if (start === null) return null;
      const next = audio[i + 1];
      const nextStart = next ? trackStartFrames(next) : null;
      if (next && (nextStart === null || nextStart <= start)) return null;
      const startMs = framesToMs(start);
      const endMs = nextStart !== null ? framesToMs(nextStart) : null;
      const durationMs = endMs !== null ? endMs - startMs : image.durationMs !== null && image.durationMs > startMs ? image.durationMs - startMs : null;
      out.push({ track, imagePath: image.path, startMs, endMs, durationMs });
    }
  }
  return out.length > 0 ? out : null;
}

const VIRTUAL = '#cue';

/** The virtual file path of one cue track. */
export function cueVirtualPath(imagePath: string, trackNumber: number): string {
  return `${imagePath}${VIRTUAL}${trackNumber}`;
}

/** `<image>#cue<n>` -> {imagePath, trackNumber}; null for a real path. */
export function parseCueVirtualPath(path: string): { imagePath: string; trackNumber: number } | null {
  const at = path.lastIndexOf(VIRTUAL);
  if (at < 0) return null;
  const n = Number(path.slice(at + VIRTUAL.length));
  return Number.isInteger(n) && n > 0 ? { imagePath: path.slice(0, at), trackNumber: n } : null;
}

/** Cue tracks as files for `scoreRelease` / `matchTracks`. */
export function cueMatchFiles(sheet: CueSheet, spans: readonly CueTrackSpan[], images: readonly CueImage[] = []): MatchFile[] {
  return spans.map((s) => {
    const folderDisc = images.find((i) => i.path === s.imagePath)?.discFromFolder ?? null;
    return {
      path: cueVirtualPath(s.imagePath, s.track.number),
      title: s.track.title,
      artist: s.track.performer ?? sheet.performer,
      trackNo: s.track.number,
      discNo: sheet.discNumber ?? folderDisc,
      durationMs: s.durationMs,
      mbRecordingId: null,
      mbReleaseId: null,
    };
  });
}

import { extname, join, posix } from 'node:path';

// Podcast folder and episode naming. Formats use `{Token}` placeholders and `/` for
// subfolders (default `{Podcast Title}` / `{Episode Year}/{Episode Date} - {Episode Title}`).

export interface NamingInput {
  podcastTitle: string;
  podcastAuthor: string | null;
  episodeTitle?: string;
  publishedAt?: string | null;
  season?: number | null;
  episodeNumber?: number | null;
}

/** One path segment safe on every filesystem Arclight runs on (Windows rules included). */
export function safeSegment(raw: string, max = 180): string {
  let s = raw
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, (c) => (c === ':' ? ' -' : c === '"' ? "'" : c === '/' || c === '\\' ? '-' : ''))
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = `${s}_`;
  if (s.length > max) s = s.slice(0, max).trim().replace(/[. ]+$/, '');
  return s || '_';
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function tokens(input: NamingInput): Record<string, string> {
  const date = input.publishedAt ? new Date(input.publishedAt) : null;
  const valid = date && !Number.isNaN(date.getTime()) ? date : null;
  return {
    'podcast title': input.podcastTitle,
    'podcast author': input.podcastAuthor ?? '',
    'episode title': input.episodeTitle ?? '',
    'episode date': valid ? `${valid.getUTCFullYear()}-${pad(valid.getUTCMonth() + 1)}-${pad(valid.getUTCDate())}` : 'Undated',
    'episode year': valid ? String(valid.getUTCFullYear()) : 'Undated',
    'episode month': valid ? pad(valid.getUTCMonth() + 1) : '',
    'episode day': valid ? pad(valid.getUTCDate()) : '',
    season: input.season != null ? pad(input.season) : '',
    'episode number': input.episodeNumber != null ? pad(input.episodeNumber, 3) : '',
  };
}

/** Render a format to relative path segments (empty segments dropped). */
export function renderFormat(format: string, input: NamingInput): string[] {
  const values = tokens(input);
  // A slash inside a value (an episode called "Part 1/2") must not open a subfolder.
  const rendered = format.replace(/\{([^{}]+)\}/g, (m, name: string) => values[name.trim().toLowerCase()]?.replace(/[\\/]/g, '-') ?? m);
  return rendered
    .split(/[\\/]/)
    .map((seg) => seg.replace(/\s*-\s*$/, '').replace(/^\s*-\s*/, ''))
    .filter((seg) => seg.trim() !== '')
    .map((seg) => safeSegment(seg));
}

export function podcastFolder(root: string, format: string, input: NamingInput): string {
  const segs = renderFormat(format, input);
  return join(root, ...(segs.length > 0 ? segs : [safeSegment(input.podcastTitle)]));
}

const TYPE_EXT: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/x-m4a': '.m4a',
  'audio/mp4': '.m4a',
  'audio/m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/x-aac': '.aac',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'video/mp4': '.mp4',
  'video/x-m4v': '.m4v',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
};

const KNOWN_EXT = new Set([...Object.values(TYPE_EXT), '.m4b', '.oga', '.mkv']);

/** File extension for an enclosure: from its URL path when known, else its MIME type, else `.mp3`. */
export function enclosureExtension(url: string, type: string | null): string {
  try {
    const ext = posix.extname(new URL(url).pathname).toLowerCase();
    if (KNOWN_EXT.has(ext)) return ext;
  } catch {
    // fall through
  }
  const mime = type?.split(';')[0]?.trim().toLowerCase();
  return (mime && TYPE_EXT[mime]) ?? '.mp3';
}

/** Episode file path (absolute) inside the podcast folder. */
export function episodePath(podcastPath: string, format: string, input: NamingInput, ext: string): string {
  const segs = renderFormat(format, input);
  const parts = segs.length > 0 ? segs : [safeSegment(input.episodeTitle ?? 'Episode')];
  const last = parts.pop()!;
  return join(podcastPath, ...parts, `${last}${ext}`);
}

/** The path without its extension (sidecars hang off it). */
export function stem(file: string): string {
  const ext = extname(file);
  return ext ? file.slice(0, -ext.length) : file;
}

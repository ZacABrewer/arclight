import { extname } from 'node:path';
import { audioCodecOf } from '../music/quality.js';

// Labels and MIME types for audio files, from the indexed columns of `audio_files`.

const MIME_BY_EXT: Record<string, string> = {
  '.flac': 'audio/flac',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.wma': 'audio/x-ms-wma',
  '.ape': 'audio/x-ape',
  '.wv': 'audio/x-wavpack',
  '.dsf': 'audio/x-dsf',
  '.mka': 'audio/x-matroska',
  '.webm': 'audio/webm',
};

/** MIME type of an original file, by extension. */
export function mimeOf(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

const LOSSLESS = new Set(['FLAC', 'ALAC', 'WAV', 'AIFF', 'APE', 'WavPack', 'DSD']);

export interface FormatFields {
  codec: string | null;
  container: string | null;
  bitrateKbps: number | null;
  sampleRateHz: number | null;
  bitDepth: number | null;
}

export function isLossless(f: Pick<FormatFields, 'codec' | 'container'>): boolean {
  return LOSSLESS.has(audioCodecOf(f.codec, f.container));
}

/** "FLAC 24/96", "FLAC 16/44.1", "MP3 320", "AAC 256"; null when the codec is unknown. */
export function formatLabel(f: FormatFields): string | null {
  const codec = audioCodecOf(f.codec, f.container);
  if (codec === 'Unknown') return null;
  if (LOSSLESS.has(codec)) {
    if (!f.bitDepth || !f.sampleRateHz) return codec;
    const khz = Math.round(f.sampleRateHz / 100) / 10;
    return `${codec} ${f.bitDepth}/${Number.isInteger(khz) ? khz : khz.toFixed(1)}`;
  }
  return f.bitrateKbps ? `${codec} ${Math.round(f.bitrateKbps)}` : codec;
}

/** The most common label (ties: the first seen), for an album of several files. */
export function commonLabel(labels: readonly (string | null)[]): string | null {
  const counts = new Map<string, number>();
  let best: string | null = null;
  for (const l of labels) {
    if (!l) continue;
    const n = (counts.get(l) ?? 0) + 1;
    counts.set(l, n);
    if (best === null || n > (counts.get(best) ?? 0)) best = l;
  }
  return best;
}

const TRANSCODE_EXT: Record<string, string> = { aac: '.aac', opus: '.opus', mp3: '.mp3' };

/**
 * `Content-Disposition: attachment` for a download of `path` (a transcode swaps the extension).
 * An ASCII fallback name for old clients plus the UTF-8 name (RFC 6266 / 5987).
 */
export function downloadDisposition(path: string, transcodeFormat: string | null): string {
  const base = path.split(/[\\/]/).pop() || 'audio';
  const ext = extname(base);
  const stem = (ext ? base.slice(0, -ext.length) : base) || 'audio';
  const name = `${stem}${transcodeFormat ? (TRANSCODE_EXT[transcodeFormat] ?? ext) : ext}`.replace(/[\u0000-\u001f\u007f]/g, '');
  const ascii = name.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\;%]/g, '_').replace(/\s+/g, ' ').trim() || 'audio';
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

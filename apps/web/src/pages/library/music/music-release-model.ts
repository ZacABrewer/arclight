import type { ReleaseDecision } from '@arclight/shared';
import type { MusicFacts } from '../../../api/music-acquisition.js';
import { t } from '../../../i18n/index.js';

// Pure helpers for the music interactive search table.

const LOSSLESS = new Set(['FLAC', 'ALAC', 'WAV', 'AIFF', 'APE', 'WavPack', 'DSD']);

/** "24-bit / 96 kHz" for lossless, "320 kbps" for lossy, null when nothing is known. */
export function audioSpecText(f: Pick<MusicFacts, 'codec' | 'bitrateKbps' | 'bitDepth' | 'sampleRateHz'>): string | null {
  const lossless = f.codec !== null && LOSSLESS.has(f.codec);
  if (lossless || f.bitDepth !== null) {
    const parts = [
      f.bitDepth !== null ? t('music.search.bitDepthValue', { bits: f.bitDepth }) : null,
      f.sampleRateHz !== null ? t('music.search.sampleRateValue', { khz: Number((f.sampleRateHz / 1000).toFixed(1)) }) : null,
    ].filter(Boolean);
    if (parts.length) return parts.join(' / ');
  }
  if (f.bitrateKbps !== null) return t('music.search.kbpsValue', { kbps: f.bitrateKbps });
  return null;
}

/** Sort value for the audio column: bit depth and sample rate beat any bitrate. */
export function audioSortValue(f: MusicFacts): number {
  if (f.bitDepth !== null || f.sampleRateHz !== null) return 100_000 + (f.bitDepth ?? 16) * 1000 + (f.sampleRateHz ?? 44_100) / 1000;
  return f.bitrateKbps ?? 0;
}

/** "Log 100% · Cue", "Log", "Cue" or null. */
export function logCueText(f: Pick<MusicFacts, 'hasLog' | 'logScore' | 'hasCue'>): string | null {
  const parts: string[] = [];
  if (f.hasLog) parts.push(f.logScore !== null ? t('music.search.logScore', { score: f.logScore }) : t('music.search.log'));
  if (f.hasCue) parts.push(t('music.search.cue'));
  return parts.length ? parts.join(' · ') : null;
}

/** "Discography 1990–2020", "Discography" or "Multi-album pack" (null for one album). */
export function discographyText(f: Pick<MusicFacts, 'pack' | 'years'>): string | null {
  if (f.pack === null) return null;
  if (f.pack === 'multiAlbum') return t('music.search.multiAlbum');
  if (f.years) return t('music.search.discographyYears', { start: f.years.start, end: f.years.end });
  return t('music.search.discography');
}

/** Titles of the albums a release covers: the matched summaries, else the ids resolved through `titles`. */
export function matchedAlbumTitles(r: Pick<ReleaseDecision, 'albums' | 'albumIds'>, titles: ReadonlyMap<number, string>): string[] {
  if (r.albums?.length) return r.albums.map((a) => a.title);
  return (r.albumIds ?? []).map((id) => titles.get(id) ?? `#${id}`);
}

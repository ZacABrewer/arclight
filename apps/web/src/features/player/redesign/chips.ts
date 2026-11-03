import type { MediaChips } from '@arclight/shared';
import { formatBytes } from '../../../i18n/format.js';

// The info-line chips (redesign spec §3.1, §9 Q26): drawn in the meta line after the genres,
// never over artwork. Certification is not a chip; MetaLine boxes it right after the year.

type Translate = (key: string, params?: Record<string, string | number>) => string;

const MAX_LANGUAGES = 3;

/** Chip labels in display order: resolution, dynamic range, audio, languages, size, TMDB score. */
export function chipLabels(chips: MediaChips | null | undefined, t: Translate): string[] {
  if (!chips) return [];
  const out: string[] = [];
  if (chips.resolution) out.push(chips.resolution);
  if (chips.dynamicRange) out.push(chips.dynamicRange === 'DV' ? t('player.chips.dolbyVision') : t('player.chips.hdr'));
  if (chips.audio) {
    if (chips.audio === 'Stereo') out.push(t('player.chips.stereo'));
    else if (chips.audio === 'Mono') out.push(t('player.chips.mono'));
    else out.push(chips.audio);
  }
  const langs = chips.audioLanguages.filter((l) => l && l !== 'und');
  if (langs.length > 0) {
    const shown = langs.slice(0, MAX_LANGUAGES).map((l) => l.toUpperCase());
    if (langs.length > MAX_LANGUAGES) shown.push(t('player.chips.moreLanguages', { count: langs.length - MAX_LANGUAGES }));
    out.push(shown.join(' · '));
  }
  if (chips.sizeBytes !== null && chips.sizeBytes > 0) out.push(formatBytes(chips.sizeBytes, { binary: false }));
  if (chips.tmdbScore !== null && chips.tmdbScore > 0) out.push(t('player.chips.tmdb', { score: formatScore(chips.tmdbScore) }));
  return out;
}

/** 7.8 -> "7.8", 8 -> "8.0" (always one decimal, as TMDB shows it). */
export function formatScore(score: number): string {
  return (Math.round(score * 10) / 10).toFixed(1);
}

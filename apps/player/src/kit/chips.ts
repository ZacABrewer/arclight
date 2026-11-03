import type { MediaChips } from '@arclight/shared';
import { formatSize } from '@web/lib/format';

// Labels for the media chips in the meta line (spec §3.1). Stand-in for C's
// `@web/features/player/redesign/chips` until the branches merge; same name and signature, so
// the merge swaps this file for a re-export.

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** In order: resolution, dynamic range, audio, languages (3, then "+N"), size, TMDB score. */
export function chipLabels(chips: MediaChips | null | undefined, t: Translate): string[] {
  if (!chips) return [];
  const out: string[] = [];
  if (chips.resolution) out.push(chips.resolution);
  if (chips.dynamicRange) out.push(chips.dynamicRange === 'DV' ? t('app.chips.dolbyVision') : t('app.chips.hdr'));
  if (chips.audio) out.push(chips.audio === 'Stereo' ? t('app.chips.stereo') : chips.audio === 'Mono' ? t('app.chips.mono') : chips.audio);
  const langs = chips.audioLanguages.map((l) => l.toUpperCase());
  if (langs.length) out.push(langs.length > 3 ? `${langs.slice(0, 3).join(' ')} +${langs.length - 3}` : langs.join(' '));
  if (chips.sizeBytes != null && chips.sizeBytes > 0) out.push(formatSize(chips.sizeBytes));
  if (chips.tmdbScore != null) out.push(t('app.chips.tmdb', { score: chips.tmdbScore.toFixed(1) }));
  return out;
}

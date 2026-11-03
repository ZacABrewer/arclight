import type { z } from 'zod';
import type { ChipAudio as ChipAudioSchema, ChipDynamicRange as ChipDynamicRangeSchema, ChipResolution as ChipResolutionSchema, MediaChips, MediaInfo } from '@arclight/shared';
import { friendlyAudioCodec } from '../media-analysis/parse.js';
import { dynamicRangeOf, resolutionLabel } from './video-info.js';

type ChipResolution = z.infer<typeof ChipResolutionSchema>;
type ChipDynamicRange = z.infer<typeof ChipDynamicRangeSchema>;
type ChipAudio = z.infer<typeof ChipAudioSchema>;

// Media chips: the short facts drawn on the info line of details pages, the hero and the pause
// screen (resolution, dynamic range, audio, languages, size, TMDB score). Computed from the
// default version's media info; never on cards.

type Ratings = Record<string, { value: number; votes?: number }> | null | undefined;

/** 4K / 1080p / 720p / SD from the frame size; 1440p counts as 1080p. Width counts for scope and cropped files. */
export function chipResolution(width: number | null | undefined, height: number | null | undefined): ChipResolution | null {
  const w = width ?? 0;
  const label = resolutionLabel(width ?? null, height ?? null);
  if (label === null && w <= 0) return null;
  if (label === '4K' || w >= 3200) return '4K';
  if (label === '1440p' || label === '1080p' || w >= 1800) return '1080p';
  if (label === '720p' || w >= 1200) return '720p';
  return 'SD';
}

export function chipDynamicRange(info: MediaInfo | null): ChipDynamicRange | null {
  switch (dynamicRangeOf(info)) {
    case 'dv':
      return 'DV';
    case 'hdr10plus':
      return 'HDR10+';
    case 'hdr10':
      return 'HDR10';
    case 'hlg':
      return 'HLG';
    default:
      return null;
  }
}

/** Atmos when any stream is TrueHD/EAC3 Atmos; else the default track's channel layout. */
export function chipAudio(info: MediaInfo | null): ChipAudio | null {
  const streams = info?.audioStreams ?? [];
  if (streams.length === 0) return null;
  if (streams.some((s) => (friendlyAudioCodec(s.codec, s.profile) ?? '').endsWith('Atmos'))) return 'Atmos';
  const main = streams.find((s) => s.default) ?? streams[0]!;
  const ch = main.channels ?? 0;
  if (ch >= 8) return '7.1';
  if (ch >= 6) return '5.1';
  if (ch >= 2) return 'Stereo';
  if (ch === 1) return 'Mono';
  return null;
}

/** Distinct audio languages in track order, lower-case; `und` and unknown dropped. */
export function chipLanguages(info: MediaInfo | null): string[] {
  const out: string[] = [];
  for (const s of info?.audioStreams ?? []) {
    const l = (s.language ?? '').trim().toLowerCase();
    if (!l || l === 'und' || out.includes(l)) continue;
    out.push(l);
  }
  return out;
}

/** TMDB vote average to one decimal; null when unrated or under 10 votes. */
export function tmdbScoreOf(ratings: Ratings): number | null {
  const r = ratings?.['tmdb'];
  if (!r || !(r.value > 0) || (typeof r.votes === 'number' && r.votes < 10)) return null;
  return Math.round(Math.min(10, r.value) * 10) / 10;
}

export interface ChipSource {
  /** The default version's file; null when the title has none (score and certification still show). */
  file: { sizeBytes: number | null; mediaInfo: MediaInfo | null } | null;
  ratings: Ratings;
  certification: string | null;
}

export function mediaChipsOf(src: ChipSource): MediaChips {
  const info = src.file?.mediaInfo ?? null;
  return {
    resolution: info ? chipResolution(info.width, info.height) : null,
    dynamicRange: info ? chipDynamicRange(info) : null,
    audio: chipAudio(info),
    audioLanguages: chipLanguages(info),
    sizeBytes: src.file?.sizeBytes ?? null,
    tmdbScore: tmdbScoreOf(src.ratings),
    certification: src.certification ?? null,
  };
}

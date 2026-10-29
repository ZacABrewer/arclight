import { audiobookQualityFor } from '@arclight/parser';
import type { QualityModel } from '@arclight/shared';
import { audioCodecOf } from '../music/quality.js';

// The audiobook quality (AB-*) of a file on disk, from what the tag reader measured.

export function audiobookFileQuality(measured: { codec: string | null; container?: string | null; bitrateKbps: number | null }): QualityModel {
  const codec = audioCodecOf(measured.codec, measured.container);
  // Measured bitrates sit a little under the nominal one (64 → 63): round up 2%, like music.
  const kbps = measured.bitrateKbps !== null && measured.bitrateKbps > 0 ? Math.round(measured.bitrateKbps * 1.02) : null;
  const q = audiobookQualityFor({ codec, bitrateKbps: kbps });
  return { quality: { ...q, mediaTypes: [...q.mediaTypes] }, revision: { version: 1, real: 0, isRepack: false } };
}

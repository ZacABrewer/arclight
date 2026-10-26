import type { HealthCheckDef } from '../health/index.js';
import { finding } from '../health/index.js';
import type { MediaProber } from './runner.js';

/** FfprobeMissing (warning): media info and runtime-based sample detection need ffprobe. */
export function ffprobeMissingCheck(prober: Pick<MediaProber, 'locate'>): HealthCheckDef {
  return {
    id: 'FfprobeMissing',
    run: async () =>
      (await prober.locate())
        ? []
        : [
            finding(
              'FfprobeMissing',
              'warning',
              'ffprobe was not found. Media info (codecs, HDR, audio/subtitle tracks) and runtime-based sample detection are unavailable. Install ffmpeg or set ARCLIGHT_FFPROBE.',
              'ffprobe-missing',
            ),
          ],
  };
}

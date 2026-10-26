import type { SubtitleWhisperStatus } from '@arclight/shared';
import { finding, type HealthCheckDef, type HealthDeps } from '../health/types.js';

// Bundled Whisper (docker compose profile "whisper"): WhisperAutoDetect registers the whisperai
// provider when ARCLIGHT_WHISPER_URL answers, and the WhisperUnreachable health check warns while a
// configured, enabled Whisper provider does not answer.

export const WHISPER_AUTODETECT_JOB = 'WhisperAutoDetect';
/** Hourly; the subtitles module also runs it once when the server is ready. */
export const WHISPER_AUTODETECT_CRON = '7 * * * *';
export const WHISPER_HEALTH_SOURCE = 'WhisperUnreachable';

/** Optional health dependency: `whisper: () => subtitlesServiceFor(ctx).whisperStatus()`. */
export interface WhisperHealthDeps {
  whisper?(): Promise<SubtitleWhisperStatus>;
}

export const whisperUnreachableCheck: HealthCheckDef = {
  id: WHISPER_HEALTH_SOURCE,
  async run(deps: HealthDeps) {
    const status = (deps as HealthDeps & WhisperHealthDeps).whisper;
    if (!status) return [];
    const st = await status();
    if (!st.registered || !st.enabled || st.reachable !== false) return [];
    return [finding(WHISPER_HEALTH_SOURCE, 'warning', `The Whisper ASR provider is enabled but unreachable at ${st.endpoint ?? st.envUrl ?? '?'}: ${st.message}`, 'whisper-unreachable')];
  },
};

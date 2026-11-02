import type { StreamInfo } from './engine/audio-engine.js';
import { t } from '../../i18n/index.js';

/** 3:07, 1:02:09. Negative values are shown as 0:00. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Wall-clock time left at `speed` (an hour at 2x is 30 minutes of listening). */
export function timeLeftAtSpeed(remainingMs: number, speed: number): number {
  return Math.max(0, remainingMs) / (speed > 0 ? speed : 1);
}

/** "2 h 14 min", "14 min", "under a minute". */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return t('player.time.underMinute');
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return t('player.time.minutes', { m });
  return m === 0 ? t('player.time.hours', { h }) : t('player.time.hoursMinutes', { h, m });
}

/** Format badge: "FLAC · DIRECT", "OPUS 160 · TRANSCODE", and "· VIA JELLYFIN" when Jellyfin serves it. */
export function streamBadge(stream: StreamInfo | null, backend: 'arclight' | 'jellyfin' | null = null): string | null {
  if (!stream) return null;
  const codec = stream.format.toUpperCase();
  const label = stream.transcoded
    ? t('player.format.transcode', { codec: stream.bitrateKbps ? `${codec} ${stream.bitrateKbps}` : codec })
    : t('player.format.direct', { codec: stream.sourceLabel });
  return backend === 'jellyfin' ? t('player.format.viaJellyfin', { label }) : label;
}

/** 1x, 1.25x. */
export function formatSpeed(speed: number): string {
  return `${Number(speed.toFixed(2))}×`;
}

export const SPEED_STEPS = [0.5, 0.75, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5] as const;

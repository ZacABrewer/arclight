import type { TrackerRatioStatus, TrackerStatsResource } from '@arclight/shared';
import type { ChipTone } from '../../arclight/index.js';
import { formatSize } from '../../lib/format.js';
import { t } from '../../i18n/index.js';

// Pure helpers for Indexers -> Tracker stats.

const RATIO_TONES: Record<TrackerRatioStatus, ChipTone> = { ok: 'accent', warning: 'warn', low: 'danger', unknown: 'muted' };

/** Ratio status as a chip: OK (accent) · Near the limit (warn) · Below required (danger) · Unknown (muted). */
export function ratioStatusChip(status: TrackerRatioStatus): { tone: ChipTone; label: string } {
  const labels: Record<TrackerRatioStatus, string> = {
    ok: t('indexers.trackerStats.ratioOk'),
    warning: t('indexers.trackerStats.ratioWarning'),
    low: t('indexers.trackerStats.ratioLow'),
    unknown: t('indexers.trackerStats.ratioUnknown'),
  };
  return { tone: RATIO_TONES[status], label: labels[status] };
}

export function formatRatio(ratio: number | null): string {
  return ratio === null ? '—' : ratio.toFixed(2);
}

/** Buffer in binary units; negative when the account owes upload ("-12 GiB"). */
export function formatBuffer(bytes: number | null): string {
  if (bytes === null) return '—';
  return bytes < 0 ? `-${formatSize(-bytes)}` : formatSize(bytes);
}

/** "3d 4h", "5h 12m", "40m". */
export function formatSeedTime(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

/** "72 h seeding · ratio 1" (either one satisfies the rule), or a dash when no rule is set. */
export function hnrRuleText(rule: TrackerStatsResource['account']['hnrRule']): string {
  const parts: string[] = [];
  if (rule.minSeedHours !== undefined) parts.push(t('indexers.trackerStats.hnrHours', { hours: rule.minSeedHours }));
  if (rule.minRatio !== undefined) parts.push(t('indexers.trackerStats.hnrRatio', { ratio: rule.minRatio }));
  return parts.length ? parts.join(' · ') : '—';
}

/**
 * Plain-language warnings for one tracker, worst first. The stats resource has no warnings
 * list of its own, so these mirror the TrackerRatioLow health check: ratio below / near the
 * requirement, buffer below the minimum, hit-and-runs on the account page, and an account page
 * that could not be read.
 */
export function trackerWarnings(s: TrackerStatsResource): string[] {
  const out: string[] = [];
  const required = s.account.ratioRequired;
  if (s.ratioStatus === 'low')
    out.push(
      required !== undefined
        ? t('indexers.trackerStats.warnRatioLow', { ratio: formatRatio(s.ratio), required: formatRatio(required) })
        : t('indexers.trackerStats.warnRatioLowNoRequirement', { ratio: formatRatio(s.ratio) }),
    );
  if (s.ratioStatus === 'warning')
    out.push(t('indexers.trackerStats.warnRatioNear', { ratio: formatRatio(s.ratio), required: formatRatio(required ?? null) }));
  if (s.account.minBufferBytes !== undefined && s.buffer !== null && s.buffer < s.account.minBufferBytes)
    out.push(t('indexers.trackerStats.warnBufferLow', { buffer: formatBuffer(s.buffer), min: formatSize(s.account.minBufferBytes) }));
  if (s.accountHnrCount !== null && s.accountHnrCount > 0) out.push(t('indexers.trackerStats.warnHnr', { count: s.accountHnrCount }));
  if (s.accountError) out.push(t('indexers.trackerStats.warnAccountError', { error: s.accountError }));
  return out;
}

/** Trackers with warnings first, then by name. */
export function sortTrackers(stats: readonly TrackerStatsResource[]): TrackerStatsResource[] {
  const rank: Record<TrackerRatioStatus, number> = { low: 0, warning: 1, unknown: 2, ok: 3 };
  return [...stats].sort((a, b) => rank[a.ratioStatus] - rank[b.ratioStatus] || a.indexerName.localeCompare(b.indexerName));
}

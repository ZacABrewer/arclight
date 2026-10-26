import type { SubtitleState } from '@arclight/shared';
import { Button, Chip, KeyValue, Tooltip, type ChipTone } from '../../arclight/index.js';
import { useToast } from '../../components/toast.js';
import { useCheckSubtitleSync } from '../../hooks/subtitles.js';
import { formatDateTime } from '../../lib/format.js';
import { t } from '../../i18n/index.js';

// Sync-quality pieces (docs/API.md "subtitles": syncScore 0-100, offsetMs, driftPpm): the score
// badge with a details tooltip, used by the per-item Subtitles tab and Subtitles -> History, and
// the per-row "Check sync" action.

/** The sync fields a subtitle row or history record carries. */
export interface SyncFields {
  syncScore?: number | null | undefined;
  syncOffsetMs?: number | null | undefined;
  syncDriftPpm?: number | null | undefined;
  syncCheckedAt?: string | null | undefined;
  syncMethod?: string | null | undefined;
}

/** Score at or above this reads as in sync. */
export const SYNC_GOOD = 80;
/** Score at or above this (and below SYNC_GOOD) reads as drifting; below it, out of sync. */
export const SYNC_FAIR = 50;

export type SyncGrade = 'good' | 'fair' | 'poor' | 'unknown';

export function syncGrade(score: number | null | undefined): SyncGrade {
  if (score === null || score === undefined) return 'unknown';
  if (score >= SYNC_GOOD) return 'good';
  if (score >= SYNC_FAIR) return 'fair';
  return 'poor';
}

const GRADE_TONE: Record<SyncGrade, ChipTone> = { good: 'accent', fair: 'warn', poor: 'danger', unknown: 'muted' };

export function syncTone(score: number | null | undefined): ChipTone {
  return GRADE_TONE[syncGrade(score)];
}

const sign = (n: number) => (n > 0 ? '+' : n < 0 ? '-' : '');

/** "+320 ms", "-1.25 s", "0 ms"; '—' when unknown. */
export function formatSyncOffset(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const abs = Math.abs(ms);
  if (abs < 1000) return `${sign(ms)}${abs} ms`;
  return `${sign(ms)}${(abs / 1000).toFixed(2).replace(/\.?0+$/, '')} s`;
}

/** "+42700 ppm", "0 ppm"; '—' when unknown. */
export function formatSyncDrift(ppm: number | null | undefined): string {
  if (ppm === null || ppm === undefined) return '—';
  return `${sign(ppm)}${Math.abs(ppm)} ppm`;
}

function gradeLabel(grade: SyncGrade): string {
  switch (grade) {
    case 'good':
      return t('subtitles.sync.inSync');
    case 'fair':
      return t('subtitles.sync.slightlyOff');
    case 'poor':
      return t('subtitles.sync.outOfSync');
    default:
      return t('subtitles.sync.notMeasurable');
  }
}

/** Tooltip body: grade, score, offset, drift, method and when it was checked. */
function SyncDetails({ sync }: { sync: SyncFields }) {
  const grade = syncGrade(sync.syncScore);
  const items = [
    { key: 'score', label: t('common.score'), value: sync.syncScore ?? '—' },
    { key: 'offset', label: t('subtitles.sync.offset'), value: formatSyncOffset(sync.syncOffsetMs) },
    { key: 'drift', label: t('subtitles.sync.drift'), value: formatSyncDrift(sync.syncDriftPpm) },
  ];
  if (sync.syncMethod) items.push({ key: 'method', label: t('subtitles.sync.method'), value: sync.syncMethod });
  if (sync.syncCheckedAt) items.push({ key: 'checked', label: t('subtitles.sync.checked'), value: formatDateTime(sync.syncCheckedAt) });
  return (
    <span className="sub-sync-details">
      <span className="sub-sync-details__head">{gradeLabel(grade)}</span>
      <KeyValue items={items} />
    </span>
  );
}

/**
 * Sync score chip (tone by score) with the details in a tooltip. Renders '—' when the
 * subtitle was never checked; a muted "?" when it was checked but could not be measured.
 */
export function SyncBadge({ sync, label }: { sync: SyncFields; label?: string | undefined }) {
  const checked = sync.syncScore !== null && sync.syncScore !== undefined ? true : Boolean(sync.syncCheckedAt);
  if (!checked) return <span className="sub-none" title={t('subtitles.sync.notChecked')}>—</span>;
  const score = sync.syncScore ?? null;
  const aria =
    score === null
      ? t('subtitles.sync.syncNotMeasurableFor', { label: label ?? '' })
      : t('subtitles.sync.syncScoreFor', { score, label: label ?? '' });
  return (
    <Tooltip content={<SyncDetails sync={sync} />}>
      <Chip tone={syncTone(score)} tabIndex={0} aria-label={aria.trim()} data-testid="sync-badge" className="sub-sync-badge">
        {score === null ? '?' : score}
      </Chip>
    </Tooltip>
  );
}

/** Offset and drift as one muted mono cell ("+320 ms · +0 ppm"). */
export function syncShiftText(sync: SyncFields): string {
  if ((sync.syncOffsetMs ?? null) === null && (sync.syncDriftPpm ?? null) === null) return '—';
  return `${formatSyncOffset(sync.syncOffsetMs)} · ${formatSyncDrift(sync.syncDriftPpm)}`;
}

/** Row action: POST /subtitle/:id/synccheck, then the files query refreshes the badge. */
export function CheckSyncButton({ subtitle, label }: { subtitle: SubtitleState; label: string }) {
  const check = useCheckSubtitleSync();
  const toast = useToast();
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={t('subtitles.sync.checkSyncOfLabel', { label })}
      loading={check.isPending}
      onClick={() =>
        check.mutate(subtitle.id, {
          onSuccess: (r) => {
            const score = r.check?.syncScore ?? null;
            const reliable = r.check?.reliable ?? false;
            toast.push({
              tone: r.ok && reliable ? (syncGrade(score) === 'good' ? 'ok' : 'warning') : 'warning',
              title:
                r.ok && reliable && score !== null
                  ? t('subtitles.sync.syncScoreResult', { score, offset: formatSyncOffset(r.check?.offsetMs) })
                  : t('subtitles.sync.syncCouldNotBeMeasured'),
              message: r.check?.message || r.message,
            });
          },
        })
      }
    >
      {t('subtitles.sync.checkSync')}
    </Button>
  );
}


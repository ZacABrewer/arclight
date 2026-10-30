import { useState } from 'react';
import type { HealthScanRequestInput } from '@arclight/shared';
import { Button, ErrorBlock, Skeleton, Toggle } from '../../arclight/index.js';
import { useToast } from '../../components/toast.js';
import { useHealthFindings, useHealthScan } from '../../hooks/health-scan.js';
import { relativeTime } from '../../lib/format.js';
import { t } from '../../i18n/index.js';
import { useAuth } from '../../auth/auth-context.js';
import { FindingsTable, useHealthActions } from './hygiene/health-findings.js';
import './hygiene/health.css';

/** Which item's findings: exactly one id. */
export type ItemHealthScope = { movieId: number } | { seriesId: number } | { albumId: number } | { bookId: number };

function scanRequest(scope: ItemHealthScope): HealthScanRequestInput {
  if ('movieId' in scope) return { movieIds: [scope.movieId] };
  if ('seriesId' in scope) return { seriesIds: [scope.seriesId] };
  if ('albumId' in scope) return { albumIds: [scope.albumId] };
  return { bookIds: [scope.bookId] };
}

/** The Health tab of a movie, series, album or book page: its findings and "Check now". */
export function ItemHealthPanel({ scope }: { scope: ItemHealthScope }) {
  const [showAll, setShowAll] = useState(false);
  const findings = useHealthFindings({ ...scope, status: showAll ? 'all' : 'open' });
  const scan = useHealthScan();
  const toast = useToast();
  const { run, dialog } = useHealthActions();
  const rows = findings.data?.records ?? [];
  const checked = rows.reduce<string | null>((max, r) => (max === null || r.lastChecked > max ? r.lastChecked : max), null);

  return (
    <div className="hl-item">
      <div className="hl-item__head">
        <p>
          {findings.data?.running ? t('library.health.scanning') : checked ? (
            <>
              {t('library.health.lastChecked')} <time dateTime={checked}>{relativeTime(checked)}</time>
            </>
          ) : (
            t('library.health.itemHint')
          )}
        </p>
        <Toggle size="sm" label={t('library.health.showIgnoredFixed')} checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
        <Button
          variant="secondary"
          loading={scan.isPending}
          onClick={() => scan.mutate(scanRequest(scope), { onSuccess: () => toast.push({ tone: 'info', title: t('library.health.checkStarted') }) })}
        >
          {t('library.health.checkNow')}
        </Button>
      </div>
      {findings.isError ? (
        <ErrorBlock title={t('library.health.couldNotLoad')} onRetry={() => void findings.refetch()} />
      ) : findings.isPending ? (
        <Skeleton lines={3} />
      ) : (
        <FindingsTable compact rows={rows} run={run} />
      )}
      {dialog}
    </div>
  );
}

/** The health API is admin-only, so the item Health tab is too. */
export function useCanSeeHealth(): boolean {
  return useAuth().access.admin;
}

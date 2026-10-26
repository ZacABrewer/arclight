import { useEffect, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Button, buttonClass, PageHeader, Paginator, Tabs, Trail, type TrailState } from '../../arclight/index.js';
import { useQueueStatus } from '../../hooks/activity.js';
import { usePendingReleases } from '../../hooks/releases.js';
import { useTorrentStatus } from '../../hooks/torrent.js';
import { formatRate } from '../../lib/format.js';
import './activity.css';
import { t } from '../../i18n/index.js';

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i >= 3 ? 1 : 0)} ${units[i]}`;
}

/** Milliseconds as h:mm:ss (or d hh:mm when longer than a day). */
export function formatEta(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return '—';
  const total = Math.round(ms / 1000);
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return d ? `${d}d ${pad(h)}:${pad(m)}` : `${h}:${pad(m)}:${pad(s)}`;
}

/** Sets `<title>` the way the old Page wrapper did. */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = t('activity.shared.titleArclight', { title });
  }, [title]);
}

/** Paged-list footer: Arclight paginator plus a mono total. Same props as before. */
export function Pager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="al-activity-pager">
      <span className="al-activity-muted">
        <span className="al-num">{total}</span> {t('activity.shared.total')}
      </span>
      <Paginator page={page} pageCount={pages} onPageChange={onPage} />
    </div>
  );
}

/** 0..1 progress as a light trail with a mono percentage. */
export function ProgressBar({ value, state = 'active' }: { value: number; state?: TrailState }) {
  return <Trail value={value * 100} state={state} showValue />;
}

export type ActivityTab = 'queue' | 'history' | 'blocklist' | 'pending';

const TAB_ROUTES: Record<ActivityTab, '/activity/queue' | '/activity/history' | '/activity/blocklist' | '/activity/pending'> = {
  queue: '/activity/queue',
  history: '/activity/history',
  blocklist: '/activity/blocklist',
  pending: '/activity/pending',
};

const TAB_LABELS: Record<ActivityTab, string> = { get queue() { return t('common.queue'); }, get history() { return t('common.history'); }, get blocklist() { return t('common.blocklist'); }, get pending() { return t('common.pending'); } };

/**
 * Shared Page 04 header: index 06, "Activity", route-driven compact tabs with mono counts,
 * live transfer speeds on the queue, Manual import + Refresh.
 */
export function ActivityHeader({ active, actions }: { active: ActivityTab; actions?: ReactNode }) {
  useDocumentTitle(TAB_LABELS[active]);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const status = useQueueStatus();
  const pending = usePendingReleases();
  const engine = useTorrentStatus({ enabled: active === 'queue' });
  const speeds = active === 'queue' && engine.data ? engine.data : null;
  return (
    <PageHeader
      index="06"
      title={t('common.activity')}
      actions={
        <>
          {speeds ? (
            <span className="al-activity-speeds">
              {t('common.down')} <span className="al-num">{formatRate(speeds.downloadRate)}</span> {t('activity.shared.up')} <span className="al-num">{formatRate(speeds.uploadRate)}</span>
            </span>
          ) : null}
          {actions}
          <Link className={buttonClass({ variant: 'secondary', size: 'md' })} to="/activity/manual-import">
            {t('common.manualImport')}
          </Link>
          <Button
            variant="secondary"
            onClick={() => {
              void qc.invalidateQueries({ queryKey: ['queue'] });
              void qc.invalidateQueries({ queryKey: ['history'] });
              void qc.invalidateQueries({ queryKey: ['torrent'] });
            }}
          >
            {t('common.refresh')}
          </Button>
        </>
      }
    >
      <Tabs
        compact
        aria-label={t('common.activity')}
        value={active}
        onChange={(id) => void navigate({ to: TAB_ROUTES[id as ActivityTab] })}
        tabs={[
          { id: 'queue', label: t('common.queue'), count: status.data?.totalCount },
          { id: 'history', label: t('common.history') },
          { id: 'blocklist', label: t('common.blocklist') },
          { id: 'pending', label: t('common.pending'), count: pending.data?.length },
        ]}
      />
    </PageHeader>
  );
}

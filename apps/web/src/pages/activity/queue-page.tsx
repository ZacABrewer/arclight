import { useReducer, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { QueueItem, QueueRemoveOptions, QueueSortKey } from '@arclight/shared';
import {
  Button,
  buttonClass,
  Checkbox,
  EmptyState,
  ErrorBlock,
  Modal,
  Pane,
  Paginator,
  ProtocolBadge,
  StatusChip,
  Table,
  Toggle,
  Tooltip,
  Trail,
  type Column,
  type RowKey,
  type SortState,
} from '../../arclight/index.js';
import { errorMessage } from '../../api/client.js';
import { useGrabQueueItem, useQueue, useQueueStatus, useRemoveQueueItems } from '../../hooks/activity.js';
import { useDownloadClientList } from '../../hooks/download-clients.js';
import { useTorrentStatus } from '../../hooks/torrent.js';
import { useVpnStatus } from '../../hooks/vpn.js';
import { useRunJob } from '../../hooks/jobs.js';
import { useMovieList, useSeriesList } from '../../hooks/library.js';
import { formatDateTime, relativeTime } from '../../lib/format.js';
import { ActivityHeader, formatBytes, formatEta } from './activity-shared.js';
import { needsManualImport } from './manual-import/mapping.js';
import { QueueRowControls, SlowModeControl } from './queue-controls.js';
import { EngineBanner, engineBannerKind, formatPeers, QueueItemDetail, QueueStateChip, SpeedCell } from './queue-diagnostics.js';
import { DiskGuardBanner, QueueRecoveryActions } from './queue-recovery.js';
import { initialRemoveState, isPendingItem, removeReducer, toRemoveOptions } from './queue-remove.js';
import { qualityFromTitle, queueChip, trailState } from './queue-status.js';
import { TorrentDrawer } from './torrent-drawer.js';
import { EngineTransferSection } from './transfer-history.js';
import { t } from '../../i18n/index.js';

/** Server job that retries imports blocked only by temporary rejections. */
export const RETRY_IMPORT_JOB = 'ProcessPendingImports';

/** Status chip for a queue row; the full status messages sit in a tooltip. */
export function QueueChipCell({ item }: { item: QueueItem }) {
  // Servers that explain why a download is (not) moving get the state-reason chip.
  if (item.stateCode) return <QueueStateChip item={item} />;
  const chip = queueChip(item);
  const focusable = chip.detail ? 0 : undefined;
  const el =
    chip.status === 'failed' || chip.status === 'stalled' ? (
      <StatusChip status={chip.status} cause={chip.cause ?? ''} tabIndex={focusable} />
    ) : (
      <StatusChip status={chip.status} cause={chip.cause} tabIndex={focusable} />
    );
  if (!chip.detail) return el;
  return (
    <Tooltip content={<span className="al-activity-prewrap">{chip.detail}</span>} placement="top">
      {el}
    </Tooltip>
  );
}

export function RemoveQueueDialog({
  items,
  onClose,
  onConfirm,
  busy,
}: {
  items: QueueItem[];
  onClose: () => void;
  onConfirm: (options: QueueRemoveOptions) => void;
  busy?: boolean;
}) {
  const [state, dispatch] = useReducer(removeReducer, items, initialRemoveState);
  const single = items.length === 1;
  const title = single ? t('activity.queue.removeTitle', { title: items[0]!.title }) : t('activity.queue.removeItemscountItems', { itemsCount: items.length });
  return (
    <Modal
      open
      size={440}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger-solid" loading={busy ?? false} onClick={() => onConfirm(toRemoveOptions(state))}>
            {single ? t('activity.queue.remove1Item') : t('activity.queue.removeItemscountItems2', { itemsCount: items.length })}
          </Button>
        </>
      }
    >
      <div className="al-activity-stack">
        <Checkbox
          label={t('activity.queue.removeFromClient')}
          hint={state.clientAvailable ? t('activity.queue.deletesTheDownloadAndIts') : t('activity.queue.notSentToADownload')}
          checked={state.removeFromClient}
          disabled={!state.clientAvailable}
          onChange={(e) => dispatch({ type: 'removeFromClient', value: e.currentTarget.checked })}
        />
        <Checkbox
          label={t('activity.queue.addToBlocklist')}
          hint={t('activity.queue.stopsThisReleaseFromBeing')}
          checked={state.blocklist}
          onChange={(e) => dispatch({ type: 'blocklist', value: e.currentTarget.checked })}
        />
        <Checkbox
          label={t('activity.queue.skipRedownload')}
          hint={t('activity.queue.blocklistWithoutSearchingForA')}
          checked={state.skipRedownload}
          disabled={!state.blocklist}
          onChange={(e) => dispatch({ type: 'skipRedownload', value: e.currentTarget.checked })}
        />
      </div>
    </Modal>
  );
}

/** Id of a row's expanded detail panel (the Info button's aria-controls). */
const detailId = (id: number) => `queue-detail-${id}`;

function EngineBannerSlot(props: Parameters<typeof EngineBanner>[0]) {
  if (!engineBannerKind(props.engine, props.vpn)) return null;
  return (
    <div className="al-queue-banner">
      <EngineBanner {...props} />
    </div>
  );
}

export function QueuePage() {
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [sort, setSort] = useState<SortState>({ key: 'added', direction: 'desc' });
  const [includeUnknown, setIncludeUnknown] = useState(false);
  const [selected, setSelected] = useState<Set<RowKey>>(new Set());
  const [removing, setRemoving] = useState<QueueItem[] | null>(null);
  const [inspecting, setInspecting] = useState<QueueItem | null>(null);
  const [expanded, setExpanded] = useState<Set<RowKey>>(new Set());
  const toggleExpanded = (id: number) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const engine = useTorrentStatus();
  const vpn = useVpnStatus();
  const query = { page, pageSize, sortKey: sort.key as QueueSortKey, sortDirection: sort.direction, includeUnknownMediaItems: includeUnknown };
  const queue = useQueue(query);
  const status = useQueueStatus();
  const remove = useRemoveQueueItems();
  const grab = useGrabQueueItem();
  const runJob = useRunJob();
  const clients = useDownloadClientList();
  const series = useSeriesList();
  const movies = useMovieList();
  const seriesTitles = new Map((series.data ?? []).map((s) => [s.id, s.title]));
  const movieTitles = new Map((movies.data ?? []).map((m) => [m.id, m.title]));
  const builtinIds = new Set((clients.data ?? []).filter((c) => c.implementation === 'builtin').map((c) => c.id));
  /** Rows downloaded by the built-in engine get a detail drawer. */
  const isBuiltin = (r: QueueItem) => r.downloadClientId !== null && builtinIds.has(r.downloadClientId) && !isPendingItem(r);

  const records = queue.data?.records ?? [];
  const pageCount = queue.data ? Math.max(1, Math.ceil(queue.data.totalRecords / pageSize)) : 1;

  const mediaTitle = (r: QueueItem) =>
    r.seriesId !== undefined ? seriesTitles.get(r.seriesId) : r.movieId !== undefined ? movieTitles.get(r.movieId) : undefined;

  const columns: Column<QueueItem>[] = [
    {
      key: 'title',
      header: t('common.title'),
      sortValue: (r) => r.title,
      cell: (r) => {
        const media = mediaTitle(r);
        return (
          <div className="al-activity-title">
            <span className="al-activity-title__main" title={r.title}>
              {r.title}
            </span>
            <span className="al-activity-title__sub">
              {media ? `${media} · ` : ''}
              <time dateTime={r.added} title={formatDateTime(r.added)}>
                {t('activity.queue.addedRelativetime', { relativeTime: relativeTime(r.added) })}
              </time>
            </span>
          </div>
        );
      },
    },
    { key: 'quality', header: t('common.quality'), mono: true, width: '130px', cell: (r) => qualityFromTitle(r.title) ?? '—' },
    { key: 'protocol', header: t('common.prot'), width: '64px', sortValue: (r) => r.protocol, cell: (r) => <ProtocolBadge protocol={r.protocol} /> },
    { key: 'downloadClientName', header: t('activity.queue.client'), muted: true, sortValue: (r) => r.downloadClientName, cell: (r) => r.downloadClientName ?? '—' },
    {
      key: 'progress',
      header: t('common.progress'),
      width: '180px',
      sortValue: (r) => r.progress,
      cell: (r) => <Trail value={r.progress * 100} state={trailState(queueChip(r))} showValue label={t('activity.queue.progressOfTitle', { title: r.title })} />,
    },
    { key: 'sizeBytes', header: t('common.size'), mono: true, align: 'right', sortValue: (r) => r.sizeBytes, cell: (r) => formatBytes(r.sizeBytes) },
    { key: 'speed', header: t('activity.queue.speed'), mono: true, align: 'right', cell: (r) => <SpeedCell item={r} /> },
    {
      key: 'peers',
      header: <span title={t('activity.queue.peersSeedsHint')}>{t('activity.queue.peers')}</span>,
      mono: true,
      align: 'right',
      cell: (r) => formatPeers(r.live),
    },
    { key: 'eta', header: t('activity.queue.eta'), mono: true, align: 'right', sortValue: (r) => r.eta, cell: (r) => formatEta(r.eta) },
    { key: 'status', header: t('common.status'), sortValue: (r) => r.status, cell: (r) => <QueueChipCell item={r} /> },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      align: 'right',
      cell: (r) => (
        <span className="al-activity-actions">
          {/* Pending rows only when held for disk space: their timeline and "Try another release". */}
          {isPendingItem(r) && r.stateCode !== 'diskHeld' ? null : (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={expanded.has(r.id)}
              aria-controls={detailId(r.id)}
              aria-label={t(expanded.has(r.id) ? 'activity.queue.hideInfoTitle' : 'activity.queue.showInfoTitle', { title: r.title })}
              onClick={() => toggleExpanded(r.id)}
            >
              {expanded.has(r.id) ? t('activity.queue.hideInfo') : t('activity.queue.info')}
            </Button>
          )}
          {isBuiltin(r) ? (
            <Button size="sm" variant="ghost" onClick={() => setInspecting(r)} aria-label={t('activity.queue.detailsTitle', { title: r.title })}>
              {t('common.details')}
            </Button>
          ) : null}
          {isPendingItem(r) ? (
            <Button size="sm" variant="ghost" loading={grab.isPending && grab.variables === r.id} onClick={() => grab.mutate(r.id)}>
              {t('activity.queue.sendNow')}
            </Button>
          ) : null}
          {needsManualImport(r) ? (
            <Link
              className={buttonClass({ variant: 'ghost', size: 'sm' })}
              to="/activity/manual-import"
              search={{ downloadId: r.downloadId }}
              aria-label={t('activity.queue.manualImportTitle', { title: r.title })}
            >
              {t('common.import')}
            </Link>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => setRemoving([r])} aria-label={t('activity.queue.removeTitle2', { title: r.title })}>
            {t('common.remove')}
          </Button>
        </span>
      ),
    },
  ];

  const s = status.data;
  const summary = s
    ? [s.errors ? `${s.errors} failed` : null, s.warnings ? `${s.warnings} stalled` : null, s.unknownCount ? `${s.unknownCount} unknown` : null].filter(Boolean)
    : [];

  return (
    <div className="al-activity">
      <ActivityHeader active="queue" actions={<SlowModeControl />} />
      <EngineBannerSlot engine={engine.data ?? undefined} vpn={vpn.data ?? undefined} />
      <EngineTransferSection engine={engine.data ?? undefined} />
      <DiskGuardBanner guard={status.data?.diskGuard} />
      <Pane chamfer="tl" flush bare className="al-activity-pane">
        {queue.isError ? (
          <div className="al-activity-pad">
            <ErrorBlock title={t('activity.queue.couldntLoadTheQueue')} onRetry={() => void queue.refetch()}>
              {errorMessage(queue.error)}
            </ErrorBlock>
          </div>
        ) : (
          <Table
            caption={t('activity.queue.downloadQueue')}
            density="rich"
            columns={columns}
            rows={queue.data?.records}
            rowKey={(r) => r.id}
            rowLabel={(r) => t('activity.queue.selectTitle', { title: r.title })}
            loading={queue.isPending}
            manualSort
            sort={sort}
            onSortChange={(next) => {
              setSort(next);
              setPage(1);
            }}
            selectable
            selected={selected}
            onSelectionChange={setSelected}
            expandedRows={expanded}
            renderExpanded={(r) => (
              <>
                <QueueItemDetail item={r} builtin={isBuiltin(r)} id={detailId(r.id)} actions={<QueueRecoveryActions item={r} />} />
                <QueueRowControls item={r} />
              </>
            )}
            bulkActions={(keys) => {
              const items = records.filter((r) => keys.has(r.id));
              const pendingItems = items.filter(isPendingItem);
              return (
                <>
                  <Button variant="danger" onClick={() => setRemoving(items)}>
                    {t('activity.queue.remove')}
                  </Button>
                  <Button variant="secondary" loading={runJob.isPending} onClick={() => runJob.mutate(RETRY_IMPORT_JOB)}>
                    {t('activity.queue.retryImport')}
                  </Button>
                  {pendingItems.length ? (
                    <Button variant="secondary" onClick={() => pendingItems.forEach((r) => grab.mutate(r.id))}>
                      {t('activity.queue.sendNow')}
                    </Button>
                  ) : null}
                </>
              );
            }}
            empty={<EmptyState title={t('activity.queue.queueIsEmpty')}>{t('activity.queue.grabbedReleasesShowUpHere')}</EmptyState>}
          />
        )}
        <footer className="al-activity-foot">
          <Toggle size="sm" label={t('activity.queue.showUnknown')} checked={includeUnknown} onChange={(e) => setIncludeUnknown(e.currentTarget.checked)} />
          {summary.length ? <span className="al-activity-muted al-num">{summary.join(' · ')}</span> : null}
          <span className="al-activity-spacer" />
          <Paginator page={page} pageCount={pageCount} onPageChange={setPage} />
        </footer>
      </Pane>
      {inspecting ? <TorrentDrawer downloadId={inspecting.downloadId} title={inspecting.title} onClose={() => setInspecting(null)} /> : null}
      {removing ? (
        <RemoveQueueDialog
          items={removing}
          busy={remove.isPending}
          onClose={() => setRemoving(null)}
          onConfirm={(options) =>
            remove.mutate(
              { ids: removing.map((r) => r.id), options },
              {
                onSuccess: () => {
                  setSelected((cur) => new Set([...cur].filter((id) => !removing.some((r) => r.id === id))));
                  setRemoving(null);
                },
              },
            )
          }
        />
      ) : null}
    </div>
  );
}

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
import { useRunJob } from '../../hooks/jobs.js';
import { useMovieList, useSeriesList } from '../../hooks/library.js';
import { formatDateTime, relativeTime } from '../../lib/format.js';
import { ActivityHeader, formatBytes, formatEta } from './activity-shared.js';
import { needsManualImport } from './manual-import/mapping.js';
import { initialRemoveState, isPendingItem, removeReducer, toRemoveOptions } from './queue-remove.js';
import { qualityFromTitle, queueChip, trailState } from './queue-status.js';
import { TorrentDrawer } from './torrent-drawer.js';

/** Server job that retries imports blocked only by temporary rejections. */
export const RETRY_IMPORT_JOB = 'ProcessPendingImports';

/** Status chip for a queue row; the full status messages sit in a tooltip. */
export function QueueChipCell({ item }: { item: QueueItem }) {
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
  const title = single ? `Remove ${items[0]!.title}?` : `Remove ${items.length} items?`;
  return (
    <Modal
      open
      size={440}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger-solid" loading={busy ?? false} onClick={() => onConfirm(toRemoveOptions(state))}>
            {single ? 'Remove 1 item' : `Remove ${items.length} items`}
          </Button>
        </>
      }
    >
      <div className="al-activity-stack">
        <Checkbox
          label="Remove from client"
          hint={state.clientAvailable ? 'Deletes the download and its data from the download client.' : 'Not sent to a download client yet.'}
          checked={state.removeFromClient}
          disabled={!state.clientAvailable}
          onChange={(e) => dispatch({ type: 'removeFromClient', value: e.currentTarget.checked })}
        />
        <Checkbox
          label="Add to blocklist"
          hint="Stops this release from being grabbed again and searches for a replacement."
          checked={state.blocklist}
          onChange={(e) => dispatch({ type: 'blocklist', value: e.currentTarget.checked })}
        />
        <Checkbox
          label="Skip redownload"
          hint="Blocklist without searching for a replacement."
          checked={state.skipRedownload}
          disabled={!state.blocklist}
          onChange={(e) => dispatch({ type: 'skipRedownload', value: e.currentTarget.checked })}
        />
      </div>
    </Modal>
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
      header: 'Title',
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
                added {relativeTime(r.added)}
              </time>
            </span>
          </div>
        );
      },
    },
    { key: 'quality', header: 'Quality', mono: true, width: '130px', cell: (r) => qualityFromTitle(r.title) ?? '—' },
    { key: 'protocol', header: 'Prot', width: '64px', sortValue: (r) => r.protocol, cell: (r) => <ProtocolBadge protocol={r.protocol} /> },
    { key: 'downloadClientName', header: 'Client', muted: true, sortValue: (r) => r.downloadClientName, cell: (r) => r.downloadClientName ?? '—' },
    {
      key: 'progress',
      header: 'Progress',
      width: '180px',
      sortValue: (r) => r.progress,
      cell: (r) => <Trail value={r.progress * 100} state={trailState(queueChip(r))} showValue label={`Progress of ${r.title}`} />,
    },
    { key: 'sizeBytes', header: 'Size', mono: true, align: 'right', sortValue: (r) => r.sizeBytes, cell: (r) => formatBytes(r.sizeBytes) },
    { key: 'eta', header: 'ETA', mono: true, align: 'right', sortValue: (r) => r.eta, cell: (r) => formatEta(r.eta) },
    { key: 'status', header: 'Status', sortValue: (r) => r.status, cell: (r) => <QueueChipCell item={r} /> },
    {
      key: 'actions',
      header: <span className="al-sr-only">Actions</span>,
      align: 'right',
      cell: (r) => (
        <span className="al-activity-actions">
          {isBuiltin(r) ? (
            <Button size="sm" variant="ghost" onClick={() => setInspecting(r)} aria-label={`Details ${r.title}`}>
              Details
            </Button>
          ) : null}
          {isPendingItem(r) ? (
            <Button size="sm" variant="ghost" loading={grab.isPending && grab.variables === r.id} onClick={() => grab.mutate(r.id)}>
              Send now
            </Button>
          ) : null}
          {needsManualImport(r) ? (
            <Link
              className={buttonClass({ variant: 'ghost', size: 'sm' })}
              to="/activity/manual-import"
              search={{ downloadId: r.downloadId }}
              aria-label={`Manual import ${r.title}`}
            >
              Import
            </Link>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => setRemoving([r])} aria-label={`Remove ${r.title}`}>
            Remove
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
      <ActivityHeader active="queue" />
      <Pane chamfer="tl" flush bare className="al-activity-pane">
        {queue.isError ? (
          <div className="al-activity-pad">
            <ErrorBlock title="Couldn't load the queue" onRetry={() => void queue.refetch()}>
              {errorMessage(queue.error)}
            </ErrorBlock>
          </div>
        ) : (
          <Table
            caption="Download queue"
            density="rich"
            columns={columns}
            rows={queue.data?.records}
            rowKey={(r) => r.id}
            rowLabel={(r) => `Select ${r.title}`}
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
            bulkActions={(keys) => {
              const items = records.filter((r) => keys.has(r.id));
              const pendingItems = items.filter(isPendingItem);
              return (
                <>
                  <Button variant="danger" onClick={() => setRemoving(items)}>
                    Remove…
                  </Button>
                  <Button variant="secondary" loading={runJob.isPending} onClick={() => runJob.mutate(RETRY_IMPORT_JOB)}>
                    Retry import
                  </Button>
                  {pendingItems.length ? (
                    <Button variant="secondary" onClick={() => pendingItems.forEach((r) => grab.mutate(r.id))}>
                      Send now
                    </Button>
                  ) : null}
                </>
              );
            }}
            empty={<EmptyState title="Queue is empty">Grabbed releases show up here while they download and import.</EmptyState>}
          />
        )}
        <footer className="al-activity-foot">
          <Toggle size="sm" label="Show unknown" checked={includeUnknown} onChange={(e) => setIncludeUnknown(e.currentTarget.checked)} />
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

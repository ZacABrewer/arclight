import { useReducer, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { QueueItem, QueueSortKey, TrackedDownloadState } from '@media-tron/shared';
import { Badge, type BadgeTone } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { Card } from '../../components/card.js';
import { EmptyState } from '../../components/empty-state.js';
import { ErrorView } from '../../components/error-boundary.js';
import { Toggle } from '../../components/form.js';
import { Modal } from '../../components/modal.js';
import { Page } from '../../components/page.js';
import { ProtocolBadge } from '../../components/protocol-badge.js';
import { Table, type Column, type SortState } from '../../components/table.js';
import { useGrabQueueItem, useQueue, useQueueStatus, useRemoveQueueItems } from '../../hooks/activity.js';
import { useDownloadClientList } from '../../hooks/download-clients.js';
import { formatDateTime, relativeTime } from '../../lib/format.js';
import { Pager, ProgressBar, formatBytes, formatEta } from './activity-shared.js';
import { needsManualImport } from './manual-import/mapping.js';
import { initialRemoveState, isPendingItem, removeReducer, toRemoveOptions } from './queue-remove.js';
import { TorrentDrawer } from './torrent-drawer.js';

const STATE_TONES: Record<TrackedDownloadState, BadgeTone> = {
  pending: 'neutral',
  downloading: 'info',
  importPending: 'warning',
  importing: 'info',
  imported: 'ok',
  failedPending: 'error',
  failed: 'error',
  ignored: 'neutral',
};

const STATUS_TONES: Record<QueueItem['trackedStatus'], BadgeTone> = { ok: 'ok', warning: 'warning', error: 'error' };

function StatusMessages({ item }: { item: QueueItem }) {
  if (item.statusMessages.length === 0) return null;
  return (
    <details className="popover">
      <summary aria-label={`Status messages for ${item.title}`}>
        <Badge tone={STATUS_TONES[item.trackedStatus]}>{item.statusMessages.length} message{item.statusMessages.length === 1 ? '' : 's'}</Badge>
      </summary>
      <div className="popover-body">
        {item.statusMessages.map((m, i) => (
          <div key={i} className="popover-section">
            <strong>{m.title}</strong>
            <ul>
              {m.messages.map((text, j) => (
                <li key={j}>{text}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </details>
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
  onConfirm: (options: ReturnType<typeof toRemoveOptions>) => void;
  busy?: boolean;
}) {
  const [state, dispatch] = useReducer(removeReducer, items, initialRemoveState);
  const title = items.length === 1 ? `Remove ${items[0]!.title}?` : `Remove ${items.length} items?`;
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy ?? false} onClick={() => onConfirm(toRemoveOptions(state))}>
            Remove
          </Button>
        </>
      }
    >
      <div className="stack-sm">
        <Toggle
          label="Remove from download client"
          checked={state.removeFromClient}
          disabled={!state.clientAvailable}
          onChange={(e) => dispatch({ type: 'removeFromClient', value: e.currentTarget.checked })}
        />
        {!state.clientAvailable ? <p className="field-hint">Not sent to a download client yet.</p> : null}
        <Toggle
          label="Add release to blocklist"
          checked={state.blocklist}
          onChange={(e) => dispatch({ type: 'blocklist', value: e.currentTarget.checked })}
        />
        <Toggle
          label="Skip redownload"
          checked={state.skipRedownload}
          disabled={!state.blocklist}
          onChange={(e) => dispatch({ type: 'skipRedownload', value: e.currentTarget.checked })}
        />
        <p className="field-hint">
          Blocklisting stops this release from being grabbed again and normally searches for a replacement; skip the redownload to not search.
        </p>
      </div>
    </Modal>
  );
}

export function QueuePage() {
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [sort, setSort] = useState<SortState>({ key: 'added', direction: 'desc' });
  const [includeUnknown, setIncludeUnknown] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [removing, setRemoving] = useState<QueueItem[] | null>(null);
  const [inspecting, setInspecting] = useState<QueueItem | null>(null);
  const query = { page, pageSize, sortKey: sort.key as QueueSortKey, sortDirection: sort.direction, includeUnknownMediaItems: includeUnknown };
  const queue = useQueue(query);
  const status = useQueueStatus();
  const remove = useRemoveQueueItems();
  const grab = useGrabQueueItem();
  const clients = useDownloadClientList();
  const builtinIds = new Set((clients.data ?? []).filter((c) => c.implementation === 'builtin').map((c) => c.id));
  /** Rows downloaded by the built-in engine get a detail drawer. */
  const isBuiltin = (r: QueueItem) => r.downloadClientId !== null && builtinIds.has(r.downloadClientId) && !isPendingItem(r);

  const records = queue.data?.records ?? [];
  const allSelected = records.length > 0 && records.every((r) => selected.includes(r.id));
  const selectedItems = records.filter((r) => selected.includes(r.id));

  const columns: Column<QueueItem>[] = [
    {
      key: 'select',
      header: (
        <input
          type="checkbox"
          aria-label="Select all"
          checked={allSelected}
          onChange={(e) => setSelected(e.currentTarget.checked ? records.map((r) => r.id) : [])}
        />
      ),
      width: '32px',
      cell: (r) => (
        <input
          type="checkbox"
          aria-label={`Select ${r.title}`}
          checked={selected.includes(r.id)}
          onChange={(e) => {
            const on = e.currentTarget.checked;
            setSelected((s) => (on ? [...s, r.id] : s.filter((id) => id !== r.id)));
          }}
        />
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (r) => r.status,
      cell: (r) => (
        <span className="chip-stack">
          <Badge tone={STATE_TONES[r.trackedState]}>{r.trackedState}</Badge>
          <Badge>{r.status}</Badge>
        </span>
      ),
    },
    {
      key: 'title',
      header: 'Title',
      sortValue: (r) => r.title,
      cell: (r) => (
        <div className="queue-title">
          <span className="break">{r.title}</span>
          <StatusMessages item={r} />
        </div>
      ),
    },
    { key: 'protocol', header: 'Protocol', sortValue: (r) => r.protocol, cell: (r) => <ProtocolBadge protocol={r.protocol} /> },
    { key: 'downloadClientName', header: 'Client', sortValue: (r) => r.downloadClientName, cell: (r) => r.downloadClientName ?? '—' },
    {
      key: 'progress',
      header: 'Progress',
      sortValue: (r) => r.progress,
      cell: (r) => <ProgressBar value={r.progress} tone={r.trackedStatus === 'ok' ? 'info' : r.trackedStatus} />,
    },
    { key: 'sizeBytes', header: 'Size', align: 'right', sortValue: (r) => r.sizeBytes, cell: (r) => formatBytes(r.sizeBytes) },
    { key: 'eta', header: 'Time left', align: 'right', sortValue: (r) => r.eta, cell: (r) => formatEta(r.eta) },
    {
      key: 'added',
      header: 'Added',
      sortValue: (r) => r.added,
      cell: (r) => (
        <time dateTime={r.added} title={formatDateTime(r.added)}>
          {relativeTime(r.added)}
        </time>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (r) => (
        <span className="nowrap">
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
            <Link className="btn btn-ghost btn-sm" to="/activity/manual-import" search={{ downloadId: r.downloadId }} aria-label={`Manual import ${r.title}`}>
              Manual import
            </Link>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => setRemoving([r])} aria-label={`Remove ${r.title}`}>
            Remove
          </Button>
        </span>
      ),
    },
  ];

  return (
    <Page
      title="Queue"
      subtitle={
        status.data ? (
          <>
            {status.data.totalCount} items
            {status.data.errors ? ` · ${status.data.errors} errors` : ''}
            {status.data.warnings ? ` · ${status.data.warnings} warnings` : ''}
            {status.data.unknownCount ? ` · ${status.data.unknownCount} unknown` : ''}
          </>
        ) : null
      }
      actions={
        <>
          <Link className="btn btn-secondary btn-md" to="/activity/manual-import">
            Manual import
          </Link>
          <Toggle label="Show unknown" checked={includeUnknown} onChange={(e) => setIncludeUnknown(e.currentTarget.checked)} />
          <Button
            disabled={!selectedItems.some(isPendingItem)}
            onClick={() => selectedItems.filter(isPendingItem).forEach((r) => grab.mutate(r.id))}
          >
            Send selected
          </Button>
          <Button variant="danger" disabled={selectedItems.length === 0} onClick={() => setRemoving(selectedItems)}>
            Remove selected{selectedItems.length ? ` (${selectedItems.length})` : ''}
          </Button>
        </>
      }
    >
      <Card flush>
        {queue.isError ? (
          <ErrorView error={queue.error} onRetry={() => void queue.refetch()} />
        ) : (
          <>
            <Table
              caption="Download queue"
              columns={columns}
              rows={queue.data?.records}
              rowKey={(r) => r.id}
              loading={queue.isPending}
              manualSort
              sort={sort}
              onSortChange={(s) => {
                setSort(s);
                setPage(1);
              }}
              empty={<EmptyState title="Queue is empty">Grabbed releases show up here while they download and import.</EmptyState>}
            />
            {queue.data && queue.data.totalRecords > pageSize ? (
              <Pager page={page} pageSize={pageSize} total={queue.data.totalRecords} onPage={setPage} />
            ) : null}
          </>
        )}
      </Card>
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
                  setSelected((s) => s.filter((id) => !removing.some((r) => r.id === id)));
                  setRemoving(null);
                },
              },
            )
          }
        />
      ) : null}
    </Page>
  );
}

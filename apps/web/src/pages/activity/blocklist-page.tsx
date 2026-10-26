import { useState } from 'react';
import { ApiError, errorMessage } from '../../api/client.js';
import type { BlocklistItem } from '../../api/blocklist.js';
import { Button, EmptyState, ErrorBlock, Pane, ProtocolBadge, Table, type Column, type RowKey } from '../../arclight/index.js';
import { useBlocklist, useRemoveBlocklist } from '../../hooks/activity.js';
import { formatDateTime, relativeTime } from '../../lib/format.js';
import { PendingApiNotice } from '../settings/shared.js';
import { ActivityHeader, Pager } from './activity-shared.js';

export function BlocklistPage() {
  const [page, setPage] = useState(1);
  const pageSize = 25;
  const [selected, setSelected] = useState<Set<RowKey>>(new Set());
  const list = useBlocklist(page, pageSize);
  const remove = useRemoveBlocklist();
  const pending = list.error instanceof ApiError && list.error.status === 404;

  const columns: Column<BlocklistItem>[] = [
    { key: 'sourceTitle', header: 'Source title', cell: (r) => <span className="al-activity-break">{r.sourceTitle}</span> },
    { key: 'quality', header: 'Quality', mono: true, cell: (r) => r.quality?.quality?.name ?? '—' },
    {
      key: 'protocol',
      header: 'Prot',
      width: '64px',
      cell: (r) => (r.protocol === 'torrent' || r.protocol === 'usenet' ? <ProtocolBadge protocol={r.protocol} /> : (r.protocol ?? '—')),
    },
    { key: 'indexer', header: 'Indexer', muted: true, cell: (r) => r.indexer ?? '—' },
    { key: 'message', header: 'Reason', muted: true, cell: (r) => r.message ?? '' },
    {
      key: 'date',
      header: 'Date',
      mono: true,
      align: 'right',
      cell: (r) => (
        <time dateTime={r.date} title={formatDateTime(r.date)}>
          {relativeTime(r.date)}
        </time>
      ),
    },
    {
      key: 'actions',
      header: <span className="al-sr-only">Actions</span>,
      align: 'right',
      cell: (r) => (
        <Button size="sm" variant="ghost" aria-label={`Remove ${r.sourceTitle} from blocklist`} onClick={() => remove.mutate([r.id])}>
          Remove
        </Button>
      ),
    },
  ];

  return (
    <div className="al-activity">
      <ActivityHeader active="blocklist" />
      <Pane flush bare className="al-activity-pane">
        {pending ? (
          <div className="al-activity-pad">
            <PendingApiNotice what="blocklist" />
          </div>
        ) : list.isError ? (
          <div className="al-activity-pad">
            <ErrorBlock title="Couldn't load the blocklist" onRetry={() => void list.refetch()}>
              {errorMessage(list.error)}
            </ErrorBlock>
          </div>
        ) : (
          <>
            <Table
              caption="Blocklist"
              columns={columns}
              rows={list.data?.records}
              rowKey={(r) => r.id}
              rowLabel={(r) => `Select ${r.sourceTitle}`}
              loading={list.isPending}
              sortable={false}
              selectable
              selected={selected}
              onSelectionChange={setSelected}
              bulkActions={(keys, clear) => (
                <Button
                  variant="danger"
                  loading={remove.isPending}
                  onClick={() => remove.mutate([...keys].map(Number), { onSuccess: clear })}
                >
                  {keys.size === 1 ? 'Remove 1 release' : `Remove ${keys.size} releases`}
                </Button>
              )}
              empty={<EmptyState title="Blocklist is empty">Releases that failed or were rejected manually are listed here.</EmptyState>}
            />
            {list.data && list.data.totalRecords > pageSize ? (
              <footer className="al-activity-foot">
                <span className="al-activity-spacer" />
                <Pager page={page} pageSize={pageSize} total={list.data.totalRecords} onPage={setPage} />
              </footer>
            ) : null}
          </>
        )}
      </Pane>
    </div>
  );
}

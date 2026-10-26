import { useState } from 'react';
import { ApiError } from '../../api/client.js';
import type { BlocklistItem } from '../../api/blocklist.js';
import { Button } from '../../components/button.js';
import { Card } from '../../components/card.js';
import { EmptyState } from '../../components/empty-state.js';
import { ErrorView } from '../../components/error-boundary.js';
import { Page } from '../../components/page.js';
import { Table, type Column } from '../../components/table.js';
import { useBlocklist, useRemoveBlocklist } from '../../hooks/activity.js';
import { formatDateTime, relativeTime } from '../../lib/format.js';
import { PendingApiNotice } from '../settings/shared.js';
import { Pager } from './activity-shared.js';

export function BlocklistPage() {
  const [page, setPage] = useState(1);
  const pageSize = 25;
  const [selected, setSelected] = useState<number[]>([]);
  const list = useBlocklist(page, pageSize);
  const remove = useRemoveBlocklist();
  const pending = list.error instanceof ApiError && list.error.status === 404;
  const records = list.data?.records ?? [];

  const columns: Column<BlocklistItem>[] = [
    {
      key: 'select',
      width: '32px',
      header: (
        <input
          type="checkbox"
          aria-label="Select all"
          checked={records.length > 0 && records.every((r) => selected.includes(r.id))}
          onChange={(e) => setSelected(e.currentTarget.checked ? records.map((r) => r.id) : [])}
        />
      ),
      cell: (r) => (
        <input
          type="checkbox"
          aria-label={`Select ${r.sourceTitle}`}
          checked={selected.includes(r.id)}
          onChange={(e) => {
            const on = e.currentTarget.checked;
            setSelected((s) => (on ? [...s, r.id] : s.filter((id) => id !== r.id)));
          }}
        />
      ),
    },
    { key: 'sourceTitle', header: 'Source title', cell: (r) => <span className="break">{r.sourceTitle}</span> },
    { key: 'quality', header: 'Quality', cell: (r) => r.quality?.quality?.name ?? '—' },
    { key: 'protocol', header: 'Protocol', cell: (r) => r.protocol ?? '—' },
    { key: 'indexer', header: 'Indexer', cell: (r) => r.indexer ?? '—' },
    { key: 'message', header: 'Reason', cell: (r) => <span className="muted">{r.message ?? ''}</span> },
    {
      key: 'date',
      header: 'Date',
      cell: (r) => (
        <time dateTime={r.date} title={formatDateTime(r.date)}>
          {relativeTime(r.date)}
        </time>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (r) => (
        <Button size="sm" variant="ghost" aria-label={`Remove ${r.sourceTitle} from blocklist`} onClick={() => remove.mutate([r.id])}>
          Remove
        </Button>
      ),
    },
  ];

  return (
    <Page
      title="Blocklist"
      actions={
        <Button
          variant="danger"
          disabled={selected.length === 0}
          loading={remove.isPending}
          onClick={() => remove.mutate(selected, { onSuccess: () => setSelected([]) })}
        >
          Remove selected{selected.length ? ` (${selected.length})` : ''}
        </Button>
      }
    >
      <Card flush>
        {pending ? (
          <div className="card-body">
            <PendingApiNotice what="blocklist" />
          </div>
        ) : list.isError ? (
          <ErrorView error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <>
            <Table
              caption="Blocklist"
              columns={columns}
              rows={list.data?.records}
              rowKey={(r) => r.id}
              loading={list.isPending}
              sortable={false}
              empty={<EmptyState title="Blocklist is empty">Releases that failed or were rejected manually are listed here.</EmptyState>}
            />
            {list.data && list.data.totalRecords > pageSize ? (
              <Pager page={page} pageSize={pageSize} total={list.data.totalRecords} onPage={setPage} />
            ) : null}
          </>
        )}
      </Card>
    </Page>
  );
}

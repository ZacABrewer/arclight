import { useState } from 'react';
import type { SubtitleBlacklistRecord } from '@arclight/shared';
import { ApiError } from '../../api/client.js';
import { Button } from '../../components/button.js';
import { Card } from '../../components/card.js';
import { EmptyState } from '../../components/empty-state.js';
import { ErrorView } from '../../components/error-boundary.js';
import { ConfirmDialog } from '../../components/forms/confirm-dialog.js';
import { Page } from '../../components/page.js';
import { Table, type Column } from '../../components/table.js';
import { useClearSubtitleBlacklist, useRemoveFromSubtitleBlacklist, useSubtitleBlacklist } from '../../hooks/subtitles.js';
import { formatDateTime, relativeTime } from '../../lib/format.js';
import { Pager } from '../activity/activity-shared.js';
import { PendingApiNotice } from '../settings/shared.js';
import { refLabel } from './subtitle-ui.js';

const PAGE_SIZE = 25;

export function SubtitleBlacklistPage() {
  const [page, setPage] = useState(1);
  const [confirmClear, setConfirmClear] = useState(false);
  const list = useSubtitleBlacklist(page, PAGE_SIZE);
  const remove = useRemoveFromSubtitleBlacklist();
  const clear = useClearSubtitleBlacklist();
  const pending = list.error instanceof ApiError && list.error.status === 404;

  const columns: Column<SubtitleBlacklistRecord>[] = [
    { key: 'title', header: 'Item', cell: (r) => <span className="break">{r.title}</span> },
    { key: 'language', header: 'Language', cell: (r) => refLabel(r) },
    { key: 'provider', header: 'Provider', cell: (r) => r.provider },
    { key: 'providerSubtitleId', header: 'Subtitle id', cell: (r) => <code className="break">{r.providerSubtitleId}</code> },
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
        <Button size="sm" variant="ghost" aria-label={`Remove ${r.title} ${r.language} from blacklist`} onClick={() => remove.mutate(r.id)}>
          Remove
        </Button>
      ),
    },
  ];

  return (
    <Page
      title="Subtitle blacklist"
      actions={
        <Button variant="danger" disabled={!list.data || list.data.totalRecords === 0} onClick={() => setConfirmClear(true)}>
          Clear all
        </Button>
      }
    >
      <Card flush>
        {pending ? (
          <div className="card-body">
            <PendingApiNotice what="subtitle blacklist" />
          </div>
        ) : list.isError ? (
          <ErrorView error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <>
            <Table
              caption="Subtitle blacklist"
              columns={columns}
              rows={list.data?.records}
              rowKey={(r) => r.id}
              loading={list.isPending}
              sortable={false}
              empty={<EmptyState title="Blacklist is empty">Subtitles you blacklist are never downloaded again.</EmptyState>}
            />
            {list.data && list.data.totalRecords > PAGE_SIZE ? <Pager page={page} pageSize={PAGE_SIZE} total={list.data.totalRecords} onPage={setPage} /> : null}
          </>
        )}
      </Card>
      <ConfirmDialog
        open={confirmClear}
        title="Clear the subtitle blacklist?"
        confirmLabel="Clear all"
        onCancel={() => setConfirmClear(false)}
        onConfirm={async () => {
          await clear.mutateAsync();
          setConfirmClear(false);
          setPage(1);
        }}
      >
        <p>Every blacklisted subtitle becomes eligible for download again.</p>
      </ConfirmDialog>
    </Page>
  );
}

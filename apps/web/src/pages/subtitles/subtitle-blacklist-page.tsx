import { useState } from 'react';
import type { SubtitleBlacklistRecord } from '@arclight/shared';
import { ApiError, errorMessage } from '../../api/client.js';
import { Button, EmptyState, ErrorBlock, Icon, Paginator, Pane, Table, type Column } from '../../arclight/index.js';
import { ConfirmDialog } from '../../components/forms/confirm-dialog.js';
import { useClearSubtitleBlacklist, useRemoveFromSubtitleBlacklist, useSubtitleBlacklist } from '../../hooks/subtitles.js';
import { formatDateTime, relativeTime } from '../../lib/format.js';
import { PendingApiNotice } from '../settings/shared.js';
import { SubtitlesHeader } from './subtitles-header.js';
import { refLabel } from './subtitle-ui.js';

const PAGE_SIZE = 25;

/** Subtitles → Blacklist: subtitles that are never downloaded again. */
export function SubtitleBlacklistPage() {
  const [page, setPage] = useState(1);
  const [confirmClear, setConfirmClear] = useState(false);
  const list = useSubtitleBlacklist(page, PAGE_SIZE);
  const remove = useRemoveFromSubtitleBlacklist();
  const clear = useClearSubtitleBlacklist();
  const pending = list.error instanceof ApiError && list.error.status === 404;

  const columns: Column<SubtitleBlacklistRecord>[] = [
    { key: 'title', header: 'Item', cell: (r) => <span className="mt-break">{r.title}</span> },
    { key: 'language', header: 'Language', cell: (r) => refLabel(r) },
    { key: 'provider', header: 'Provider', muted: true, cell: (r) => r.provider },
    { key: 'providerSubtitleId', header: 'Subtitle id', mono: true, cell: (r) => <span className="mt-break">{r.providerSubtitleId}</span> },
    {
      key: 'date',
      header: 'Date',
      mono: true,
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
        <Button
          size="sm"
          variant="secondary"
          loading={remove.isPending && remove.variables === r.id}
          aria-label={`Remove ${r.title} ${r.language} from blacklist`}
          onClick={() => remove.mutate(r.id)}
        >
          Remove
        </Button>
      ),
    },
  ];

  const total = list.data?.totalRecords ?? 0;
  const pageCount = Math.ceil(total / PAGE_SIZE);

  return (
    <>
      <SubtitlesHeader
        active="blacklist"
        actions={
          <Button variant="danger" icon={<Icon name="trash" />} disabled={!list.data || total === 0} onClick={() => setConfirmClear(true)}>
            Clear all
          </Button>
        }
      />
      {pending ? (
        <PendingApiNotice what="subtitle blacklist" />
      ) : list.isError ? (
        <ErrorBlock title="Subtitle blacklist did not load" onRetry={() => void list.refetch()}>
          {errorMessage(list.error)}
        </ErrorBlock>
      ) : (
        <Pane flush bare>
          <Table
            caption="Subtitle blacklist"
            columns={columns}
            rows={list.data?.records}
            rowKey={(r) => r.id}
            loading={list.isPending}
            sortable={false}
            empty={<EmptyState title="Blacklist is empty">Subtitles you blacklist are never downloaded again.</EmptyState>}
          />
          {pageCount > 1 ? (
            <div className="sub-pager">
              <Paginator page={page} pageCount={pageCount} onPageChange={setPage} />
            </div>
          ) : null}
        </Pane>
      )}
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
        <p>
          All <span className="al-num">{total}</span> blacklisted {total === 1 ? 'subtitle becomes' : 'subtitles become'} eligible for download again.
        </p>
      </ConfirmDialog>
    </>
  );
}

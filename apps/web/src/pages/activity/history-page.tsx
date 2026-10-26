import { useState } from 'react';
import { ApiError } from '../../api/client.js';
import {
  DEFAULT_HISTORY_FILTER,
  HISTORY_EVENT_LABELS,
  HISTORY_EVENT_TYPES,
  type HistoryEventType,
  type HistoryFilter,
  type HistoryRecord,
} from '../../api/history.js';
import { Badge, type BadgeTone } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { Card } from '../../components/card.js';
import { EmptyState } from '../../components/empty-state.js';
import { ErrorView } from '../../components/error-boundary.js';
import { ConfirmDialog } from '../../components/forms/confirm-dialog.js';
import { Modal } from '../../components/modal.js';
import { Page } from '../../components/page.js';
import { Table, type Column } from '../../components/table.js';
import { useHistory, useMarkHistoryFailed } from '../../hooks/activity.js';
import { formatDateTime, relativeTime } from '../../lib/format.js';
import { PendingApiNotice } from '../settings/shared.js';
import { Pager } from './activity-shared.js';

const EVENT_TONES: Record<string, BadgeTone> = {
  grabbed: 'info',
  imported: 'ok',
  failed: 'error',
  fileDeleted: 'warning',
  fileRenamed: 'neutral',
  ignored: 'neutral',
};

export const eventLabel = (t: string) => HISTORY_EVENT_LABELS[t as HistoryEventType] ?? t;

/** Toggle one event type in the filter; any filter change goes back to page 1. */
export function toggleEventType(filter: HistoryFilter, type: HistoryEventType): HistoryFilter {
  const has = filter.eventTypes.includes(type);
  return { ...filter, page: 1, eventTypes: has ? filter.eventTypes.filter((t) => t !== type) : [...filter.eventTypes, type] };
}

export function HistoryFilterBar({ filter, onChange }: { filter: HistoryFilter; onChange: (f: HistoryFilter) => void }) {
  return (
    <div className="chip-group" role="group" aria-label="Event types">
      <button
        type="button"
        className={`chip ${filter.eventTypes.length === 0 ? 'chip-on' : ''}`}
        aria-pressed={filter.eventTypes.length === 0}
        onClick={() => onChange({ ...filter, page: 1, eventTypes: [] })}
      >
        All
      </button>
      {HISTORY_EVENT_TYPES.map((t) => {
        const on = filter.eventTypes.includes(t);
        return (
          <button key={t} type="button" className={`chip ${on ? 'chip-on' : ''}`} aria-pressed={on} onClick={() => onChange(toggleEventType(filter, t))}>
            {HISTORY_EVENT_LABELS[t]}
          </button>
        );
      })}
    </div>
  );
}

function HistoryDetails({ record, onClose }: { record: HistoryRecord; onClose: () => void }) {
  const markFailed = useMarkHistoryFailed();
  const [confirm, setConfirm] = useState(false);
  const data = Object.entries(record.data ?? {});
  return (
    <>
      <Modal
        open
        onClose={onClose}
        size="lg"
        title={eventLabel(record.eventType)}
        footer={
          <>
            {record.eventType === 'grabbed' ? (
              <Button variant="danger" onClick={() => setConfirm(true)}>
                Mark as failed
              </Button>
            ) : null}
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </>
        }
      >
        <dl className="fields">
          <div className="fields-row">
            <dt>Source title</dt>
            <dd className="break">{record.sourceTitle}</dd>
          </div>
          <div className="fields-row">
            <dt>Date</dt>
            <dd>{formatDateTime(record.date)}</dd>
          </div>
          {record.quality?.quality?.name ? (
            <div className="fields-row">
              <dt>Quality</dt>
              <dd>{record.quality.quality.name}</dd>
            </div>
          ) : null}
          {record.languages?.length ? (
            <div className="fields-row">
              <dt>Languages</dt>
              <dd>{record.languages.join(', ')}</dd>
            </div>
          ) : null}
          {record.downloadId ? (
            <div className="fields-row">
              <dt>Download id</dt>
              <dd>
                <code>{record.downloadId}</code>
              </dd>
            </div>
          ) : null}
          {data.map(([k, v]) => (
            <div key={k} className="fields-row">
              <dt>{k}</dt>
              <dd className="break">{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
            </div>
          ))}
        </dl>
      </Modal>
      <ConfirmDialog
        open={confirm}
        title="Mark as failed?"
        confirmLabel="Mark as failed"
        onCancel={() => setConfirm(false)}
        onConfirm={async () => {
          await markFailed.mutateAsync(record.id);
          setConfirm(false);
          onClose();
        }}
      >
        <p>The release is blocklisted and, unless disabled, a replacement is searched for.</p>
      </ConfirmDialog>
    </>
  );
}

const columns: Column<HistoryRecord>[] = [
  { key: 'eventType', header: 'Event', cell: (r) => <Badge tone={EVENT_TONES[r.eventType] ?? 'neutral'}>{eventLabel(r.eventType)}</Badge> },
  { key: 'sourceTitle', header: 'Source title', cell: (r) => <span className="break">{r.sourceTitle}</span> },
  { key: 'quality', header: 'Quality', cell: (r) => r.quality?.quality?.name ?? '—' },
  {
    key: 'date',
    header: 'Date',
    cell: (r) => (
      <time dateTime={r.date} title={formatDateTime(r.date)}>
        {relativeTime(r.date)}
      </time>
    ),
  },
];

export function HistoryPage() {
  const [filter, setFilter] = useState<HistoryFilter>(DEFAULT_HISTORY_FILTER);
  const [open, setOpen] = useState<HistoryRecord | null>(null);
  const history = useHistory(filter);
  const pending = history.error instanceof ApiError && history.error.status === 404;

  return (
    <Page title="History" actions={<HistoryFilterBar filter={filter} onChange={setFilter} />}>
      <Card flush>
        {pending ? (
          <div className="card-body">
            <PendingApiNotice what="history" />
          </div>
        ) : history.isError ? (
          <ErrorView error={history.error} onRetry={() => void history.refetch()} />
        ) : (
          <>
            <Table
              caption="History"
              columns={columns}
              rows={history.data?.records}
              rowKey={(r) => r.id}
              loading={history.isPending}
              sortable={false}
              onRowClick={setOpen}
              empty={<EmptyState title="No history yet" />}
            />
            {history.data && history.data.totalRecords > filter.pageSize ? (
              <Pager page={filter.page} pageSize={filter.pageSize} total={history.data.totalRecords} onPage={(page) => setFilter({ ...filter, page })} />
            ) : null}
          </>
        )}
      </Card>
      {open ? <HistoryDetails record={open} onClose={() => setOpen(null)} /> : null}
    </Page>
  );
}

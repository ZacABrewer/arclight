import { useState } from 'react';
import { ApiError, errorMessage } from '../../api/client.js';
import {
  DEFAULT_HISTORY_FILTER,
  HISTORY_EVENT_LABELS,
  HISTORY_EVENT_TYPES,
  historyEventLabel,
  type HistoryEventType,
  type HistoryFilter,
  type HistoryRecord,
} from '../../api/history.js';
import { Button, Chip, Drawer, EmptyState, ErrorBlock, FilterBar, KeyValue, Pane, Select, Table, type ChipTone, type Column, type KeyValueItem } from '../../arclight/index.js';
import { ConfirmDialog } from '../../components/forms/confirm-dialog.js';
import { useToast } from '../../components/toast.js';
import { useHistory, useMarkHistoryFailed, useRedownloadHistory } from '../../hooks/activity.js';
import { formatDateTime, relativeTime } from '../../lib/format.js';
import { PendingApiNotice } from '../settings/shared.js';
import { ActivityHeader, Pager } from './activity-shared.js';

const EVENT_TONES: Record<string, ChipTone> = {
  grabbed: 'default',
  downloadFolderImported: 'accent',
  downloadFailed: 'danger',
  fileDeleted: 'warn',
  fileRenamed: 'neutral',
  downloadIgnored: 'neutral',
};

export const eventLabel = historyEventLabel;

/** Toggle one event type in the filter; any filter change goes back to page 1. */
export function toggleEventType(filter: HistoryFilter, type: HistoryEventType): HistoryFilter {
  const has = filter.eventTypes.includes(type);
  return { ...filter, page: 1, eventTypes: has ? filter.eventTypes.filter((t) => t !== type) : [...filter.eventTypes, type] };
}

/** Number of filters that differ from the default (drives the Clear button). */
export function activeHistoryFilters(filter: HistoryFilter): number {
  return (filter.eventTypes.length > 0 ? 1 : 0) + (filter.sortDirection !== DEFAULT_HISTORY_FILTER.sortDirection ? 1 : 0);
}

export function HistoryFilterBar({ filter, onChange }: { filter: HistoryFilter; onChange: (f: HistoryFilter) => void }) {
  // One event type at a time from the select; a multi-type filter (set elsewhere) shows as "Several".
  const eventValue = filter.eventTypes.length === 0 ? '' : filter.eventTypes.length === 1 ? filter.eventTypes[0]! : '__many';
  return (
    <FilterBar
      activeCount={activeHistoryFilters(filter)}
      onClear={() => onChange({ ...DEFAULT_HISTORY_FILTER, pageSize: filter.pageSize })}
    >
      <Select
        aria-label="Event type"
        value={eventValue}
        onChange={(e) => {
          const v = e.currentTarget.value;
          if (v === '__many') return;
          onChange({ ...filter, page: 1, eventTypes: v ? [v as HistoryEventType] : [] });
        }}
      >
        <option value="">All events</option>
        {HISTORY_EVENT_TYPES.map((t) => (
          <option key={t} value={t}>
            {HISTORY_EVENT_LABELS[t]}
          </option>
        ))}
        {eventValue === '__many' ? <option value="__many">Several</option> : null}
      </Select>
      <Select
        aria-label="Order"
        value={filter.sortDirection}
        onChange={(e) => onChange({ ...filter, page: 1, sortDirection: e.currentTarget.value as 'asc' | 'desc' })}
        options={[
          { value: 'desc', label: 'Newest first' },
          { value: 'asc', label: 'Oldest first' },
        ]}
      />
    </FilterBar>
  );
}

/**
 * What "Redownload" (POST /history/:id/redownload) searches for, or null when the record names
 * no episode or movie (the api answers 400 for those).
 */
export function redownloadTarget(record: HistoryRecord): { episodeIds: number[] } | { movieId: number } | null {
  if (record.episodeId != null) return { episodeIds: [record.episodeId] };
  if (record.movieId != null) return { movieId: record.movieId };
  return null;
}

export function HistoryDetails({ record, onClose }: { record: HistoryRecord; onClose: () => void }) {
  const markFailed = useMarkHistoryFailed();
  const redownload = useRedownloadHistory();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const target = redownloadTarget(record);
  const canMarkFailed = record.eventType === 'grabbed';
  const items: KeyValueItem[] = [
    { label: 'Event', value: <Chip tone={EVENT_TONES[record.eventType] ?? 'neutral'}>{eventLabel(record.eventType)}</Chip>, mono: false },
    { label: 'Source title', value: <span className="al-activity-break">{record.sourceTitle}</span> },
    { label: 'Date', value: formatDateTime(record.date) },
  ];
  if (record.quality?.quality?.name) items.push({ label: 'Quality', value: record.quality.quality.name });
  if (record.languages?.length) items.push({ label: 'Languages', value: record.languages.join(', '), mono: false });
  if (record.downloadId) items.push({ label: 'Download id', value: <span className="al-activity-break">{record.downloadId}</span> });
  for (const [k, v] of Object.entries(record.data ?? {})) {
    items.push({ key: `data-${k}`, label: k, value: <span className="al-activity-break">{typeof v === 'string' ? v : JSON.stringify(v)}</span> });
  }
  return (
    <>
      <Drawer
        open={!confirm}
        onClose={onClose}
        title={eventLabel(record.eventType)}
        footer={
          <>
            <Button
              variant="danger"
              disabled={!canMarkFailed}
              title={canMarkFailed ? undefined : 'Only grabbed releases can be marked failed'}
              onClick={() => setConfirm(true)}
            >
              Mark failed
            </Button>
            <Button
              variant="secondary"
              disabled={!target}
              loading={redownload.isPending}
              title={target ? undefined : 'This event is not linked to an episode or movie'}
              onClick={() => target && redownload.mutate(record.id)}
            >
              Redownload
            </Button>
            <span className="al-activity-spacer" />
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </>
        }
      >
        <KeyValue items={items} />
      </Drawer>
      <ConfirmDialog
        open={confirm}
        title={`Mark ${record.sourceTitle} as failed?`}
        confirmLabel="Mark failed"
        onCancel={() => setConfirm(false)}
        onConfirm={async () => {
          await markFailed.mutateAsync(record.id);
          toast.push({ tone: 'ok', title: 'Marked as failed', message: record.sourceTitle });
          setConfirm(false);
          onClose();
        }}
      >
        <p>The release is blocklisted and, unless disabled, a replacement is searched for.</p>
      </ConfirmDialog>
    </>
  );
}

const historyColumns = (onOpen: (r: HistoryRecord) => void): Column<HistoryRecord>[] => [
  { key: 'eventType', header: 'Event', width: '140px', cell: (r) => <Chip tone={EVENT_TONES[r.eventType] ?? 'neutral'}>{eventLabel(r.eventType)}</Chip> },
  {
    key: 'sourceTitle',
    header: 'Source title',
    cell: (r) => (
      <button
        type="button"
        className="al-activity-rowlink"
        onClick={(e) => {
          e.stopPropagation();
          onOpen(r);
        }}
      >
        {r.sourceTitle}
      </button>
    ),
  },
  { key: 'quality', header: 'Quality', mono: true, cell: (r) => r.quality?.quality?.name ?? '—' },
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
];

export function HistoryPage() {
  const [filter, setFilter] = useState<HistoryFilter>(DEFAULT_HISTORY_FILTER);
  const [open, setOpen] = useState<HistoryRecord | null>(null);
  const history = useHistory(filter);
  const pending = history.error instanceof ApiError && history.error.status === 404;

  return (
    <div className="al-activity">
      <ActivityHeader active="history" />
      <Pane flush bare className="al-activity-pane">
        <div className="al-activity-filters">
          <HistoryFilterBar filter={filter} onChange={setFilter} />
        </div>
        {pending ? (
          <div className="al-activity-pad">
            <PendingApiNotice what="history" />
          </div>
        ) : history.isError ? (
          <div className="al-activity-pad">
            <ErrorBlock title="Couldn't load history" onRetry={() => void history.refetch()}>
              {errorMessage(history.error)}
            </ErrorBlock>
          </div>
        ) : (
          <>
            <Table
              caption="History"
              columns={historyColumns(setOpen)}
              rows={history.data?.records}
              rowKey={(r) => r.id}
              loading={history.isPending}
              sortable={false}
              onRowClick={setOpen}
              empty={<EmptyState title="No history yet">Grabs, imports and failures are recorded here.</EmptyState>}
            />
            {history.data && history.data.totalRecords > filter.pageSize ? (
              <footer className="al-activity-foot">
                <span className="al-activity-spacer" />
                <Pager page={filter.page} pageSize={filter.pageSize} total={history.data.totalRecords} onPage={(page) => setFilter({ ...filter, page })} />
              </footer>
            ) : null}
          </>
        )}
      </Pane>
      {open ? <HistoryDetails record={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

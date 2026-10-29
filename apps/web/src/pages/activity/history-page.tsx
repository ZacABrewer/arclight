import { useState } from 'react';
import { getRouteApi } from '@tanstack/react-router';
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
import { formatDateTime, languageNames, relativeTime } from '../../lib/format.js';
import { PendingApiNotice } from '../settings/shared.js';
import { DecisionBatchModal } from '../library/decisions/decisions-panel.js';
import { ActivityHeader, Pager } from './activity-shared.js';
import { historyFilterFromSearch } from './history-search.js';
import { AudioMediaLabel, audioImportMode, isAudioRecord } from './audiobook-media.js';

const historyRoute = getRouteApi('/activity/history');
import { t } from '../../i18n/index.js';

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
  return { ...filter, page: 1, eventTypes: has ? filter.eventTypes.filter((item) => item !== type) : [...filter.eventTypes, type] };
}

/** Number of filters that differ from the default (drives the Clear button). */
export function activeHistoryFilters(filter: HistoryFilter): number {
  return (
    (filter.eventTypes.length > 0 ? 1 : 0) +
    (filter.sortDirection !== DEFAULT_HISTORY_FILTER.sortDirection ? 1 : 0) +
    (filter.seriesId !== undefined || filter.episodeId !== undefined || filter.movieId !== undefined ? 1 : 0)
  );
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
        aria-label={t('activity.history.eventType')}
        value={eventValue}
        onChange={(e) => {
          const v = e.currentTarget.value;
          if (v === '__many') return;
          onChange({ ...filter, page: 1, eventTypes: v ? [v as HistoryEventType] : [] });
        }}
      >
        <option value="">{t('activity.history.allEvents')}</option>
        {HISTORY_EVENT_TYPES.map((entry) => (
          <option key={entry} value={entry}>
            {HISTORY_EVENT_LABELS[entry]}
          </option>
        ))}
        {eventValue === '__many' ? <option value="__many">{t('activity.history.several')}</option> : null}
      </Select>
      {filter.seriesId !== undefined || filter.episodeId !== undefined || filter.movieId !== undefined ? (
        <Chip tone="default">{t('activity.history.oneItemOnly')}</Chip>
      ) : null}
      <Select
        aria-label={t('activity.history.order')}
        value={filter.sortDirection}
        onChange={(e) => onChange({ ...filter, page: 1, sortDirection: e.currentTarget.value as 'asc' | 'desc' })}
        options={[
          { value: 'desc', label: t('activity.history.newestFirst') },
          { value: 'asc', label: t('activity.history.oldestFirst') },
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

/** The decision-log batch a grab came from (history data `decisionBatchId`), if recorded. */
export function decisionBatchIdOf(record: Pick<HistoryRecord, 'data'>): string | null {
  const v = record.data?.['decisionBatchId'];
  return typeof v === 'string' && v !== '' ? v : null;
}

export function HistoryDetails({ record, onClose }: { record: HistoryRecord; onClose: () => void }) {
  const markFailed = useMarkHistoryFailed();
  const redownload = useRedownloadHistory();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [why, setWhy] = useState<string | null>(null);
  const batchId = decisionBatchIdOf(record);
  const target = redownloadTarget(record);
  const canMarkFailed = record.eventType === 'grabbed';
  const items: KeyValueItem[] = [
    { label: t('activity.history.event'), value: <Chip tone={EVENT_TONES[record.eventType] ?? 'neutral'}>{eventLabel(record.eventType)}</Chip>, mono: false },
    { label: t('common.sourceTitle'), value: <span className="al-activity-break">{record.sourceTitle}</span> },
    { label: t('common.date'), value: formatDateTime(record.date) },
  ];
  if (isAudioRecord(record)) items.splice(2, 0, { label: audioImportMode(record) === 'audiobook' ? t('audiobooks.audiobook') : t('common.music'), value: <AudioMediaLabel record={record} />, mono: false });
  if (record.quality?.quality?.name) items.push({ label: t('common.quality'), value: record.quality.quality.name });
  if (record.languages?.length) {
    const assumed = record.data?.languageAssumed === 'true';
    const names = languageNames(record.languages);
    items.push({ label: t('common.languages'), value: assumed ? t('activity.history.languageAssumed', { names }) : names, mono: false });
  }
  if (record.downloadId) items.push({ label: t('activity.history.downloadId'), value: <span className="al-activity-break">{record.downloadId}</span> });
  for (const [k, v] of Object.entries(record.data ?? {})) {
    if (k === 'languageAssumed') continue;
    items.push({ key: `data-${k}`, label: k, value: <span className="al-activity-break">{typeof v === 'string' ? v : JSON.stringify(v)}</span> });
  }
  return (
    <>
      <Drawer
        open={!confirm && why === null}
        onClose={onClose}
        title={eventLabel(record.eventType)}
        footer={
          <>
            <Button
              variant="danger"
              disabled={!canMarkFailed}
              title={canMarkFailed ? undefined : t('activity.history.onlyGrabbedReleasesCanBe')}
              onClick={() => setConfirm(true)}
            >
              {t('activity.history.markFailed')}
            </Button>
            <Button
              variant="secondary"
              disabled={!target}
              loading={redownload.isPending}
              title={target ? undefined : t('activity.history.thisEventIsNotLinked')}
              onClick={() => target && redownload.mutate(record.id)}
            >
              {t('activity.history.redownload')}
            </Button>
            <span className="al-activity-spacer" />
            <Button variant="ghost" onClick={onClose}>
              {t('common.close')}
            </Button>
          </>
        }
      >
        {batchId ? (
          <p style={{ margin: '0 0 12px' }}>
            <Button variant="secondary" size="sm" onClick={() => setWhy(batchId)}>
              {t('activity.history.whyThisRelease')}
            </Button>
          </p>
        ) : null}
        <KeyValue items={items} />
      </Drawer>
      <DecisionBatchModal batchId={why} onClose={() => setWhy(null)} />
      <ConfirmDialog
        open={confirm}
        title={t('activity.history.markSourcetitleAsFailed', { sourceTitle: record.sourceTitle })}
        confirmLabel={t('activity.history.markFailed')}
        onCancel={() => setConfirm(false)}
        onConfirm={async () => {
          await markFailed.mutateAsync(record.id);
          toast.push({ tone: 'ok', title: t('activity.history.markedAsFailed'), message: record.sourceTitle });
          setConfirm(false);
          onClose();
        }}
      >
        <p>{t('activity.history.theReleaseIsBlocklistedAnd')}</p>
      </ConfirmDialog>
    </>
  );
}

const historyColumns = (onOpen: (r: HistoryRecord) => void): Column<HistoryRecord>[] => [
  { key: 'eventType', header: t('activity.history.event'), width: '140px', cell: (r) => <Chip tone={EVENT_TONES[r.eventType] ?? 'neutral'}>{eventLabel(r.eventType)}</Chip> },
  {
    key: 'sourceTitle',
    header: t('common.sourceTitle'),
    cell: (r) => {
      const open = (
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
      );
      if (!isAudioRecord(r)) return open;
      return (
        <div className="al-activity-title">
          {open}
          <span className="al-activity-title__sub" onClick={(e) => e.stopPropagation()}>
            <AudioMediaLabel record={r} />
          </span>
        </div>
      );
    },
  },
  { key: 'quality', header: t('common.quality'), mono: true, cell: (r) => r.quality?.quality?.name ?? '—' },
  {
    key: 'date',
    header: t('common.date'),
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
  const search = historyRoute.useSearch();
  const searchKey = JSON.stringify(search);
  const [filter, setFilter] = useState<HistoryFilter>(() => historyFilterFromSearch(search));
  // A new deep link while the page is open replaces the filter.
  const [seenSearch, setSeenSearch] = useState(searchKey);
  if (seenSearch !== searchKey) {
    setSeenSearch(searchKey);
    setFilter(historyFilterFromSearch(search));
  }
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
            <PendingApiNotice what={t('activity.history.history')} />
          </div>
        ) : history.isError ? (
          <div className="al-activity-pad">
            <ErrorBlock title={t('activity.history.couldntLoadHistory')} onRetry={() => void history.refetch()}>
              {errorMessage(history.error)}
            </ErrorBlock>
          </div>
        ) : (
          <>
            <Table
              caption={t('common.history')}
              columns={historyColumns(setOpen)}
              rows={history.data?.records}
              rowKey={(r) => r.id}
              loading={history.isPending}
              sortable={false}
              onRowClick={setOpen}
              empty={<EmptyState title={t('activity.history.noHistoryYet')}>{t('activity.history.grabsImportsAndFailuresAre')}</EmptyState>}
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

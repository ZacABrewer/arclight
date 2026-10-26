import { useState } from 'react';
import { SubtitleHistoryAction, SUBTITLE_PROVIDER_IDS, type SubtitleHistoryRecord, type SubtitleMediaType } from '@arclight/shared';
import { ApiError, errorMessage } from '../../api/client.js';
import type { SubtitleHistoryFilter } from '../../api/subtitles.js';
import { Chip, EmptyState, ErrorBlock, FilterBar, Paginator, Pane, Select, Table, type ChipTone, type Column } from '../../arclight/index.js';
import { useSubtitleHistory } from '../../hooks/subtitles.js';
import { formatDateTime, relativeTime } from '../../lib/format.js';
import { PendingApiNotice } from '../settings/shared.js';
import { SubtitlesHeader } from './subtitles-header.js';
import { HISTORY_ACTION_LABELS, formatPercent, refLabel } from './subtitle-ui.js';

const ACTION_TONES: Partial<Record<SubtitleHistoryAction, ChipTone>> = {
  downloaded: 'accent',
  manualDownload: 'accent',
  upgraded: 'default',
  uploaded: 'default',
  deleted: 'warn',
};

export const DEFAULT_SUBTITLE_HISTORY_FILTER: SubtitleHistoryFilter = { page: 1, pageSize: 25 };

/** Subtitles → History: downloads, upgrades, uploads and deletions. */
export function SubtitleHistoryPage() {
  const [filter, setFilter] = useState<SubtitleHistoryFilter>(DEFAULT_SUBTITLE_HISTORY_FILTER);
  const list = useSubtitleHistory(filter);
  const pending = list.error instanceof ApiError && list.error.status === 404;

  const columns: Column<SubtitleHistoryRecord>[] = [
    {
      key: 'action',
      header: 'Action',
      cell: (r) => <Chip tone={ACTION_TONES[r.action] ?? 'neutral'}>{HISTORY_ACTION_LABELS[r.action]}</Chip>,
    },
    { key: 'title', header: 'Item', cell: (r) => <span className="mt-break">{r.title}</span> },
    { key: 'language', header: 'Language', cell: (r) => refLabel(r) },
    { key: 'provider', header: 'Provider', muted: true, cell: (r) => r.provider ?? '—' },
    { key: 'score', header: 'Score', align: 'right', mono: true, cell: (r) => formatPercent(r.score, r.scoreOutOf) },
    { key: 'description', header: 'Description', muted: true, cell: (r) => r.description },
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
  ];

  const set = (patch: Partial<SubtitleHistoryFilter>) => setFilter((f) => ({ ...f, ...patch, page: patch.page ?? 1 }));
  const active = (filter.mediaType ? 1 : 0) + (filter.action ? 1 : 0) + (filter.provider ? 1 : 0);
  const pageCount = list.data ? Math.ceil(list.data.totalRecords / filter.pageSize) : 1;

  return (
    <>
      <SubtitlesHeader active="history" />
      <div className="sub-page">
        <FilterBar activeCount={active} onClear={() => setFilter(DEFAULT_SUBTITLE_HISTORY_FILTER)}>
          <Select aria-label="Media" value={filter.mediaType ?? ''} onChange={(e) => set({ mediaType: (e.currentTarget.value || undefined) as SubtitleMediaType | undefined })}>
            <option value="">All media</option>
            <option value="series">TV</option>
            <option value="movie">Movies</option>
          </Select>
          <Select aria-label="Action" value={filter.action ?? ''} onChange={(e) => set({ action: (e.currentTarget.value || undefined) as SubtitleHistoryAction | undefined })}>
            <option value="">All actions</option>
            {SubtitleHistoryAction.options.map((a) => (
              <option key={a} value={a}>
                {HISTORY_ACTION_LABELS[a]}
              </option>
            ))}
          </Select>
          <Select aria-label="Provider" value={filter.provider ?? ''} onChange={(e) => set({ provider: e.currentTarget.value || undefined })}>
            <option value="">All providers</option>
            {SUBTITLE_PROVIDER_IDS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </FilterBar>
        {pending ? (
          <PendingApiNotice what="subtitle history" />
        ) : list.isError ? (
          <ErrorBlock title="Subtitle history did not load" onRetry={() => void list.refetch()}>
            {errorMessage(list.error)}
          </ErrorBlock>
        ) : (
          <Pane flush bare>
            <Table
              caption="Subtitle history"
              columns={columns}
              rows={list.data?.records}
              rowKey={(r) => r.id}
              loading={list.isPending}
              sortable={false}
              empty={<EmptyState title="No subtitle history">Downloads, upgrades, uploads and deletions are listed here.</EmptyState>}
            />
            {pageCount > 1 ? (
              <div className="sub-pager">
                <Paginator page={filter.page} pageCount={pageCount} onPageChange={(page) => set({ page })} />
              </div>
            ) : null}
          </Pane>
        )}
      </div>
    </>
  );
}

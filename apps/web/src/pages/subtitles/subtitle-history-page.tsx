import { useState } from 'react';
import { SubtitleHistoryAction, SUBTITLE_PROVIDER_IDS, type SubtitleHistoryRecord, type SubtitleMediaType } from '@media-tron/shared';
import { ApiError } from '../../api/client.js';
import type { SubtitleHistoryFilter } from '../../api/subtitles.js';
import { Badge, type BadgeTone } from '../../components/badge.js';
import { Card } from '../../components/card.js';
import { EmptyState } from '../../components/empty-state.js';
import { ErrorView } from '../../components/error-boundary.js';
import { FormField, Select } from '../../components/form.js';
import { Page } from '../../components/page.js';
import { Table, type Column } from '../../components/table.js';
import { useSubtitleHistory } from '../../hooks/subtitles.js';
import { formatDateTime, relativeTime } from '../../lib/format.js';
import { Pager } from '../activity/activity-shared.js';
import { PendingApiNotice } from '../settings/shared.js';
import { HISTORY_ACTION_LABELS, formatPercent, refLabel } from './subtitle-ui.js';

const ACTION_TONES: Partial<Record<SubtitleHistoryAction, BadgeTone>> = {
  downloaded: 'ok',
  manualDownload: 'ok',
  upgraded: 'info',
  uploaded: 'info',
  deleted: 'warning',
};

export const DEFAULT_SUBTITLE_HISTORY_FILTER: SubtitleHistoryFilter = { page: 1, pageSize: 25 };

export function SubtitleHistoryPage() {
  const [filter, setFilter] = useState<SubtitleHistoryFilter>(DEFAULT_SUBTITLE_HISTORY_FILTER);
  const list = useSubtitleHistory(filter);
  const pending = list.error instanceof ApiError && list.error.status === 404;

  const columns: Column<SubtitleHistoryRecord>[] = [
    {
      key: 'action',
      header: 'Action',
      cell: (r) => <Badge tone={ACTION_TONES[r.action] ?? 'neutral'}>{HISTORY_ACTION_LABELS[r.action]}</Badge>,
    },
    { key: 'title', header: 'Item', cell: (r) => <span className="break">{r.title}</span> },
    { key: 'language', header: 'Language', cell: (r) => refLabel(r) },
    { key: 'provider', header: 'Provider', cell: (r) => r.provider ?? '—' },
    { key: 'score', header: 'Score', align: 'right', cell: (r) => formatPercent(r.score, r.scoreOutOf) },
    { key: 'description', header: 'Description', cell: (r) => <span className="muted">{r.description}</span> },
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

  const set = (patch: Partial<SubtitleHistoryFilter>) => setFilter((f) => ({ ...f, ...patch, page: patch.page ?? 1 }));

  return (
    <Page title="Subtitle history">
      <div className="toolbar">
        <FormField label="Media">
          <Select value={filter.mediaType ?? ''} onChange={(e) => set({ mediaType: (e.currentTarget.value || undefined) as SubtitleMediaType | undefined })}>
            <option value="">All</option>
            <option value="series">TV</option>
            <option value="movie">Movies</option>
          </Select>
        </FormField>
        <FormField label="Action">
          <Select value={filter.action ?? ''} onChange={(e) => set({ action: (e.currentTarget.value || undefined) as SubtitleHistoryAction | undefined })}>
            <option value="">All</option>
            {SubtitleHistoryAction.options.map((a) => (
              <option key={a} value={a}>
                {HISTORY_ACTION_LABELS[a]}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Provider">
          <Select value={filter.provider ?? ''} onChange={(e) => set({ provider: e.currentTarget.value || undefined })}>
            <option value="">All</option>
            {SUBTITLE_PROVIDER_IDS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </FormField>
      </div>
      <Card flush>
        {pending ? (
          <div className="card-body">
            <PendingApiNotice what="subtitle history" />
          </div>
        ) : list.isError ? (
          <ErrorView error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <>
            <Table
              caption="Subtitle history"
              columns={columns}
              rows={list.data?.records}
              rowKey={(r) => r.id}
              loading={list.isPending}
              sortable={false}
              empty={<EmptyState title="No subtitle history">Downloads, upgrades, uploads and deletions are listed here.</EmptyState>}
            />
            {list.data && list.data.totalRecords > filter.pageSize ? (
              <Pager page={filter.page} pageSize={filter.pageSize} total={list.data.totalRecords} onPage={(page) => set({ page })} />
            ) : null}
          </>
        )}
      </Card>
    </Page>
  );
}

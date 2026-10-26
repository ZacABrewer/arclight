import { useState } from 'react';
import { SubtitleHistoryAction, SUBTITLE_PROVIDER_IDS, type SubtitleHistoryRecord, type SubtitleMediaType } from '@arclight/shared';
import { ApiError, errorMessage } from '../../api/client.js';
import type { SubtitleHistoryFilter } from '../../api/subtitles.js';
import { Chip, EmptyState, ErrorBlock, FilterBar, Paginator, Pane, Select, Table, type ChipTone, type Column } from '../../arclight/index.js';
import { useSubtitleHistory } from '../../hooks/subtitles.js';
import { formatDateTime, relativeTime } from '../../lib/format.js';
import { PendingApiNotice } from '../settings/shared.js';
import { SubtitlesHeader } from './subtitles-header.js';
import { SyncBadge, syncShiftText } from './sync-ui.js';
import { HISTORY_ACTION_LABELS, formatPercent, refLabel } from './subtitle-ui.js';
import { t } from '../../i18n/index.js';

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
      header: t('common.action'),
      cell: (r) => <Chip tone={ACTION_TONES[r.action] ?? 'neutral'}>{HISTORY_ACTION_LABELS[r.action]}</Chip>,
    },
    { key: 'title', header: t('subtitles.subtitleHistory.item'), cell: (r) => <span className="mt-break">{r.title}</span> },
    { key: 'language', header: t('common.language'), cell: (r) => refLabel(r) },
    { key: 'provider', header: t('common.provider'), muted: true, cell: (r) => r.provider ?? '—' },
    { key: 'score', header: t('common.score'), align: 'right', mono: true, cell: (r) => formatPercent(r.score, r.scoreOutOf) },
    { key: 'sync', header: t('subtitles.sync.syncColumn'), align: 'right', cell: (r) => <SyncBadge sync={r} label={r.title} /> },
    { key: 'syncShift', header: t('subtitles.sync.offsetAndDrift'), mono: true, muted: true, cell: (r) => syncShiftText(r) },
    { key: 'description', header: t('subtitles.subtitleHistory.description'), muted: true, cell: (r) => r.description },
    {
      key: 'date',
      header: t('common.date'),
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
          <Select aria-label={t('subtitles.subtitleHistory.media')} value={filter.mediaType ?? ''} onChange={(e) => set({ mediaType: (e.currentTarget.value || undefined) as SubtitleMediaType | undefined })}>
            <option value="">{t('subtitles.subtitleHistory.allMedia')}</option>
            <option value="series">{t('common.tv')}</option>
            <option value="movie">{t('common.movies')}</option>
          </Select>
          <Select aria-label={t('common.action')} value={filter.action ?? ''} onChange={(e) => set({ action: (e.currentTarget.value || undefined) as SubtitleHistoryAction | undefined })}>
            <option value="">{t('subtitles.subtitleHistory.allActions')}</option>
            {SubtitleHistoryAction.options.map((a) => (
              <option key={a} value={a}>
                {HISTORY_ACTION_LABELS[a]}
              </option>
            ))}
          </Select>
          <Select aria-label={t('common.provider')} value={filter.provider ?? ''} onChange={(e) => set({ provider: e.currentTarget.value || undefined })}>
            <option value="">{t('subtitles.subtitleHistory.allProviders')}</option>
            {SUBTITLE_PROVIDER_IDS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </FilterBar>
        {pending ? (
          <PendingApiNotice what={t('subtitles.subtitleHistory.subtitleHistory')} />
        ) : list.isError ? (
          <ErrorBlock title={t('subtitles.subtitleHistory.subtitleHistoryDidNotLoad')} onRetry={() => void list.refetch()}>
            {errorMessage(list.error)}
          </ErrorBlock>
        ) : (
          <Pane flush bare>
            <Table
              caption={t('subtitles.subtitleHistory.subtitleHistory2')}
              columns={columns}
              rows={list.data?.records}
              rowKey={(r) => r.id}
              loading={list.isPending}
              sortable={false}
              empty={<EmptyState title={t('subtitles.subtitleHistory.noSubtitleHistory')}>{t('subtitles.subtitleHistory.downloadsUpgradesUploadsAndDeletions')}</EmptyState>}
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

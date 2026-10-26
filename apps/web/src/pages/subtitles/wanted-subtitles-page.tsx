import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { SubtitleMediaType, WantedSubtitleItem } from '@arclight/shared';
import { ApiError, errorMessage } from '../../api/client.js';
import { Button, EmptyState, ErrorBlock, Icon, Paginator, Pane, Table, Tabs, type Column, type RowKey } from '../../arclight/index.js';
import { useToast } from '../../components/toast.js';
import { useSubtitleSearchCommand, useWantedSubtitles } from '../../hooks/subtitles.js';
import { formatDateTime, relativeTime } from '../../lib/format.js';
import { PendingApiNotice } from '../settings/shared.js';
import { SubtitlesHeader } from './subtitles-header.js';
import { MissingChips } from './subtitle-ui.js';
import { t } from '../../i18n/index.js';

const PAGE_SIZE = 50;

/** Subtitles → Wanted: files whose language profile still wants subtitles, TV and Movies tabs. */
export function WantedSubtitlesPage() {
  return (
    <>
      <SubtitlesHeader active="wanted" />
      <Tabs
        aria-label={t('common.mediaType')}
        tabs={[
          { id: 'series', label: t('common.tv'), content: <WantedTab mediaType="series" /> },
          { id: 'movie', label: t('common.movies'), content: <WantedTab mediaType="movie" /> },
        ]}
      />
    </>
  );
}

function itemLabel(r: WantedSubtitleItem): string {
  return r.episodeLabel ? `${r.title} ${r.episodeLabel}` : r.title;
}

function WantedTab({ mediaType }: { mediaType: SubtitleMediaType }) {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<RowKey>>(new Set());
  const [bulkRunning, setBulkRunning] = useState(false);
  const list = useWantedSubtitles(mediaType, page, PAGE_SIZE);
  const search = useSubtitleSearchCommand();
  const toast = useToast();
  const pending = list.error instanceof ApiError && list.error.status === 404;

  const searchSelected = async (keys: Set<RowKey>, clear: () => void) => {
    setBulkRunning(true);
    let downloaded = 0;
    let searched = 0;
    try {
      for (const key of keys) {
        const res = await search.mutateAsync({ mediaFileId: Number(key) });
        downloaded += res.downloaded;
        searched += res.searched;
      }
      toast.push({
        tone: downloaded > 0 ? 'ok' : 'info',
        title: t('subtitles.wantedSubtitles.subtitleSearchFinished'),
        message: t('subtitles.wantedSubtitles.searchedFilesDownloadedSubtitles', { searched, downloaded }),
      });
      clear();
    } catch {
      // The mutation's own error toast explains the failure.
    } finally {
      setBulkRunning(false);
    }
  };

  const columns: Column<WantedSubtitleItem>[] = [
    {
      key: 'item',
      header: mediaType === 'series' ? t('common.episode') : t('common.movie'),
      cell: (r) => (
        <span className="sub-item__title">
          <span>
            {r.seriesId !== null ? (
              <Link to="/library/series/$id" params={{ id: String(r.seriesId) }}>
                {r.title}
              </Link>
            ) : r.movieId !== null ? (
              <Link to="/library/movie/$id" params={{ id: String(r.movieId) }}>
                {r.title}
              </Link>
            ) : (
              r.title
            )}
            {r.episodeLabel ? (
              <>
                {' '}
                <span className="al-num">{r.episodeLabel}</span>
              </>
            ) : null}
          </span>
          {r.episodeTitle ? <span className="sub-item__meta">{r.episodeTitle}</span> : null}
        </span>
      ),
    },
    { key: 'missing', header: t('status.missing'), cell: (r) => <MissingChips missing={r.missing} /> },
    {
      key: 'lastSearch',
      header: t('subtitles.wantedSubtitles.lastSearch'),
      mono: true,
      cell: (r) =>
        r.lastSearch ? (
          <time dateTime={r.lastSearch} title={formatDateTime(r.lastSearch)}>
            {relativeTime(r.lastSearch)}
          </time>
        ) : (
          <span className="sub-none">{t('common.never')}</span>
        ),
    },
    { key: 'attempts', header: t('subtitles.wantedSubtitles.attempts'), align: 'right', mono: true, cell: (r) => r.attempts },
    {
      key: 'actions',
      header: <span className="al-sr-only">{t('common.actions')}</span>,
      align: 'right',
      cell: (r) => (
        <Button
          size="sm"
          variant="secondary"
          icon={<Icon name="search" />}
          aria-label={t('subtitles.wantedSubtitles.searchSubtitlesForItemlabel', { itemLabel: itemLabel(r) })}
          loading={search.isPending && search.variables.mediaFileId === r.mediaFileId}
          onClick={() =>
            search.mutate(
              { mediaFileId: r.mediaFileId },
              { onSuccess: (res) => toast.push({ tone: res.downloaded > 0 ? 'ok' : 'info', title: t('subtitles.wantedSubtitles.subtitleSearchFinished'), message: res.message }) },
            )
          }
        >
          {t('common.search')}
        </Button>
      ),
    },
  ];

  if (pending) return <PendingApiNotice what={t('subtitles.wantedSubtitles.subtitles')} />;
  if (list.isError)
    return (
      <ErrorBlock title={t('subtitles.wantedSubtitles.wantedSubtitlesDidNotLoad')} onRetry={() => void list.refetch()}>
        {errorMessage(list.error)}
      </ErrorBlock>
    );

  const pageCount = list.data ? Math.ceil(list.data.totalRecords / PAGE_SIZE) : 1;

  return (
    <Pane flush bare>
      <Table
        caption={mediaType === 'series' ? t('subtitles.wantedSubtitles.wantedEpisodeSubtitles') : t('subtitles.wantedSubtitles.wantedMovieSubtitles')}
        columns={columns}
        rows={list.data?.records}
        rowKey={(r) => r.mediaFileId}
        density="rich"
        loading={list.isPending}
        sortable={false}
        selectable
        selected={selected}
        onSelectionChange={setSelected}
        rowLabel={(r) => t('subtitles.wantedSubtitles.selectItemlabel', { itemLabel: itemLabel(r) })}
        bulkActions={(keys, clear) => (
          <Button variant="secondary" size="sm" icon={<Icon name="search" />} loading={bulkRunning} onClick={() => void searchSelected(keys, clear)}>
            {t('subtitles.wantedSubtitles.searchSelected')}
          </Button>
        )}
        empty={<EmptyState title={t('subtitles.wantedSubtitles.nothingWanted')}>{t('subtitles.wantedSubtitles.everyFileHasTheSubtitles')}</EmptyState>}
      />
      {pageCount > 1 ? (
        <div className="sub-pager">
          <Paginator page={page} pageCount={pageCount} onPageChange={setPage} />
        </div>
      ) : null}
    </Pane>
  );
}

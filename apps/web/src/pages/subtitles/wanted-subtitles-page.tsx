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

const PAGE_SIZE = 50;

/** Subtitles → Wanted: files whose language profile still wants subtitles, TV and Movies tabs. */
export function WantedSubtitlesPage() {
  return (
    <>
      <SubtitlesHeader active="wanted" />
      <Tabs
        aria-label="Media type"
        tabs={[
          { id: 'series', label: 'TV', content: <WantedTab mediaType="series" /> },
          { id: 'movie', label: 'Movies', content: <WantedTab mediaType="movie" /> },
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
        title: 'Subtitle search finished',
        message: `Searched ${searched} ${searched === 1 ? 'file' : 'files'}, downloaded ${downloaded} ${downloaded === 1 ? 'subtitle' : 'subtitles'}.`,
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
      header: mediaType === 'series' ? 'Episode' : 'Movie',
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
    { key: 'missing', header: 'Missing', cell: (r) => <MissingChips missing={r.missing} /> },
    {
      key: 'lastSearch',
      header: 'Last search',
      mono: true,
      cell: (r) =>
        r.lastSearch ? (
          <time dateTime={r.lastSearch} title={formatDateTime(r.lastSearch)}>
            {relativeTime(r.lastSearch)}
          </time>
        ) : (
          <span className="sub-none">Never</span>
        ),
    },
    { key: 'attempts', header: 'Attempts', align: 'right', mono: true, cell: (r) => r.attempts },
    {
      key: 'actions',
      header: <span className="al-sr-only">Actions</span>,
      align: 'right',
      cell: (r) => (
        <Button
          size="sm"
          variant="secondary"
          icon={<Icon name="search" />}
          aria-label={`Search subtitles for ${itemLabel(r)}`}
          loading={search.isPending && search.variables.mediaFileId === r.mediaFileId}
          onClick={() =>
            search.mutate(
              { mediaFileId: r.mediaFileId },
              { onSuccess: (res) => toast.push({ tone: res.downloaded > 0 ? 'ok' : 'info', title: 'Subtitle search finished', message: res.message }) },
            )
          }
        >
          Search
        </Button>
      ),
    },
  ];

  if (pending) return <PendingApiNotice what="subtitles" />;
  if (list.isError)
    return (
      <ErrorBlock title="Wanted subtitles did not load" onRetry={() => void list.refetch()}>
        {errorMessage(list.error)}
      </ErrorBlock>
    );

  const pageCount = list.data ? Math.ceil(list.data.totalRecords / PAGE_SIZE) : 1;

  return (
    <Pane flush bare>
      <Table
        caption={mediaType === 'series' ? 'Wanted episode subtitles' : 'Wanted movie subtitles'}
        columns={columns}
        rows={list.data?.records}
        rowKey={(r) => r.mediaFileId}
        density="rich"
        loading={list.isPending}
        sortable={false}
        selectable
        selected={selected}
        onSelectionChange={setSelected}
        rowLabel={(r) => `Select ${itemLabel(r)}`}
        bulkActions={(keys, clear) => (
          <Button variant="secondary" size="sm" icon={<Icon name="search" />} loading={bulkRunning} onClick={() => void searchSelected(keys, clear)}>
            Search selected
          </Button>
        )}
        empty={<EmptyState title="Nothing wanted">Every file has the subtitles its language profile asks for.</EmptyState>}
      />
      {pageCount > 1 ? (
        <div className="sub-pager">
          <Paginator page={page} pageCount={pageCount} onPageChange={setPage} />
        </div>
      ) : null}
    </Pane>
  );
}

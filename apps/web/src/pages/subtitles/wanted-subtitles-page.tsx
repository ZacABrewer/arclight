import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { SubtitleMediaType, WantedSubtitleItem } from '@media-tron/shared';
import { ApiError } from '../../api/client.js';
import { Button } from '../../components/button.js';
import { Card } from '../../components/card.js';
import { EmptyState } from '../../components/empty-state.js';
import { ErrorView } from '../../components/error-boundary.js';
import { Page } from '../../components/page.js';
import { Table, type Column } from '../../components/table.js';
import { Tabs } from '../../components/tabs.js';
import { useToast } from '../../components/toast.js';
import { useSubtitleSearchCommand, useWantedSubtitles } from '../../hooks/subtitles.js';
import { formatDateTime, relativeTime } from '../../lib/format.js';
import { Pager } from '../activity/activity-shared.js';
import { PendingApiNotice } from '../settings/shared.js';
import { MissingChips } from './subtitle-ui.js';

const PAGE_SIZE = 50;

export function WantedSubtitlesPage() {
  return (
    <Page title="Wanted subtitles" subtitle="Files whose language profile still wants subtitles.">
      <Tabs
        tabs={[
          { id: 'series', label: 'TV', content: <WantedTab mediaType="series" /> },
          { id: 'movie', label: 'Movies', content: <WantedTab mediaType="movie" /> },
        ]}
      />
    </Page>
  );
}

function itemLabel(r: WantedSubtitleItem): string {
  return r.episodeLabel ? `${r.title} ${r.episodeLabel}` : r.title;
}

function WantedTab({ mediaType }: { mediaType: SubtitleMediaType }) {
  const [page, setPage] = useState(1);
  const list = useWantedSubtitles(mediaType, page, PAGE_SIZE);
  const search = useSubtitleSearchCommand();
  const toast = useToast();
  const pending = list.error instanceof ApiError && list.error.status === 404;

  const columns: Column<WantedSubtitleItem>[] = [
    {
      key: 'item',
      header: mediaType === 'series' ? 'Episode' : 'Movie',
      cell: (r) => (
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
          {r.episodeLabel ? <> {r.episodeLabel}</> : null}
          {r.episodeTitle ? <span className="muted"> · {r.episodeTitle}</span> : null}
        </span>
      ),
    },
    { key: 'missing', header: 'Missing', cell: (r) => <MissingChips missing={r.missing} /> },
    {
      key: 'lastSearch',
      header: 'Last search',
      cell: (r) =>
        r.lastSearch ? (
          <time dateTime={r.lastSearch} title={formatDateTime(r.lastSearch)}>
            {relativeTime(r.lastSearch)}
          </time>
        ) : (
          <span className="muted">Never</span>
        ),
    },
    { key: 'attempts', header: 'Attempts', align: 'right', cell: (r) => r.attempts },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (r) => (
        <Button
          size="sm"
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
  if (list.isError) return <ErrorView error={list.error} onRetry={() => void list.refetch()} />;

  return (
    <Card flush>
      <Table
        caption={mediaType === 'series' ? 'Wanted episode subtitles' : 'Wanted movie subtitles'}
        columns={columns}
        rows={list.data?.records}
        rowKey={(r) => r.mediaFileId}
        loading={list.isPending}
        sortable={false}
        empty={<EmptyState title="Nothing wanted">Every file has the subtitles its language profile asks for.</EmptyState>}
      />
      {list.data && list.data.totalRecords > PAGE_SIZE ? (
        <Pager page={page} pageSize={PAGE_SIZE} total={list.data.totalRecords} onPage={setPage} />
      ) : null}
    </Card>
  );
}

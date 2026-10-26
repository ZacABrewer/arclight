import type { ReleaseDecision } from '@arclight/shared';
import { Badge } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { EmptyState } from '../../components/empty-state.js';
import { ErrorView } from '../../components/error-boundary.js';
import { formatBytes } from '../../components/media/format.js';
import { QualityBadge } from '../../components/media/media-ui.js';
import { Modal } from '../../components/modal.js';
import { LoadingBlock } from '../../components/spinner.js';
import { Table, type Column } from '../../components/table.js';
import { useGrabRelease, useInteractiveSearch, type ReleaseSearchTarget } from '../../hooks/library.js';

export function formatAge(r: Pick<ReleaseDecision, 'age' | 'ageHours' | 'ageMinutes'>): string {
  if (r.age >= 1) return `${r.age}d`;
  if (r.ageHours >= 1) return `${Math.floor(r.ageHours)}h`;
  return `${Math.floor(r.ageMinutes)}m`;
}

/** Interactive search over GET /release: every decision with its rejections; grab any allowed one. */
export function InteractiveSearchModal({
  target,
  title,
  onClose,
}: {
  target: ReleaseSearchTarget | null;
  title: string;
  onClose: () => void;
}) {
  const releases = useInteractiveSearch(target);
  const grab = useGrabRelease();

  const columns: Column<ReleaseDecision>[] = [
    { key: 'protocol', header: 'Source', sortValue: (r) => r.protocol, cell: (r) => <Badge tone="neutral">{r.protocol}</Badge> },
    { key: 'age', header: 'Age', sortValue: (r) => r.ageMinutes, cell: formatAge },
    {
      key: 'title',
      header: 'Title',
      sortValue: (r) => r.title,
      cell: (r) => (r.infoUrl ? <a href={r.infoUrl} target="_blank" rel="noreferrer noopener">{r.title}</a> : r.title),
    },
    { key: 'indexer', header: 'Indexer', sortValue: (r) => r.indexerName, cell: (r) => r.indexerName },
    { key: 'size', header: 'Size', sortValue: (r) => r.size, cell: (r) => formatBytes(r.size), align: 'right' },
    {
      key: 'peers',
      header: 'Peers',
      sortValue: (r) => r.seeders,
      cell: (r) => (r.protocol === 'torrent' ? `${r.seeders ?? '?'} / ${r.leechers ?? '?'}` : '—'),
    },
    { key: 'languages', header: 'Languages', cell: (r) => r.languages.join(', ') || '—' },
    { key: 'quality', header: 'Quality', sortValue: (r) => r.quality.quality.weight, cell: (r) => <QualityBadge quality={r.quality} /> },
    {
      key: 'score',
      header: 'Score',
      sortValue: (r) => r.customFormatScore,
      cell: (r) => <span title={r.customFormats.map((c) => c.name).join(', ')}>{r.customFormatScore}</span>,
      align: 'right',
    },
    {
      key: 'decision',
      header: 'Decision',
      sortValue: (r) => (r.approved ? 0 : r.temporarilyRejected ? 1 : 2),
      cell: (r) =>
        r.approved ? (
          <Badge tone="ok">Approved</Badge>
        ) : (
          <span title={r.rejections.map((x) => x.message).join('\n')}>
            <Badge tone={r.temporarilyRejected ? 'warning' : 'error'}>
              {r.rejections.length} rejection{r.rejections.length === 1 ? '' : 's'}
            </Badge>
          </span>
        ),
    },
    {
      key: 'grab',
      header: <span className="sr-only">Grab</span>,
      cell: (r) => (
        <Button
          size="sm"
          variant={r.approved ? 'primary' : 'secondary'}
          disabled={!r.downloadAllowed}
          loading={grab.isPending && grab.variables?.guid === r.guid}
          onClick={() =>
            grab.mutate({
              guid: r.guid,
              indexerId: r.indexerId,
              ...(r.seriesId !== undefined ? { seriesId: r.seriesId } : {}),
              ...(r.episodeIds !== undefined ? { episodeIds: r.episodeIds } : {}),
              ...(r.movieId !== undefined ? { movieId: r.movieId } : {}),
            })
          }
        >
          Grab
        </Button>
      ),
    },
  ];

  return (
    <Modal open={target !== null} onClose={onClose} title={`Interactive search: ${title}`} size="lg">
      {releases.isPending && releases.fetchStatus !== 'idle' ? (
        <LoadingBlock label="Searching indexers" />
      ) : releases.isError ? (
        <ErrorView error={releases.error} onRetry={() => void releases.refetch()} />
      ) : (
        <Table
          columns={columns}
          rows={releases.data}
          rowKey={(r) => `${r.indexerId}-${r.guid}`}
          defaultSort={{ key: 'decision', direction: 'asc' }}
          empty={<EmptyState title="No releases found" />}
          caption="Releases"
        />
      )}
    </Modal>
  );
}

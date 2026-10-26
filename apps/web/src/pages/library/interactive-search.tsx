import type { ReleaseDecision } from '@arclight/shared';
import {
  Button,
  Chip,
  EmptyState,
  Modal,
  ProtocolBadge,
  RejectionList,
  ScoreTag,
  StatusChip,
  Table,
  Tag,
  Tooltip,
  type Column,
} from '../../arclight/index.js';
import { formatBytes } from '../../components/media/format.js';
import { Loading, QualityLabel, QueryError } from '../../components/media/media-kit.js';
import { useGrabRelease, useInteractiveSearch, type ReleaseSearchTarget } from '../../hooks/library.js';
import './library.css';

export function formatAge(r: Pick<ReleaseDecision, 'age' | 'ageHours' | 'ageMinutes'>): string {
  if (r.age >= 1) return `${r.age}d`;
  if (r.ageHours >= 1) return `${Math.floor(r.ageHours)}h`;
  return `${Math.floor(r.ageMinutes)}m`;
}

/** Sort rank: approved first, then temporarily rejected, then rejected. */
export function decisionRank(r: Pick<ReleaseDecision, 'approved' | 'temporarilyRejected'>): number {
  return r.approved ? 0 : r.temporarilyRejected ? 1 : 2;
}

/** Release table (interactive search modal and the details "Search" tab). */
export function ReleaseTable({ target }: { target: ReleaseSearchTarget | null }) {
  const releases = useInteractiveSearch(target);
  const grab = useGrabRelease();

  const columns: Column<ReleaseDecision>[] = [
    { key: 'protocol', header: 'Source', sortValue: (r) => r.protocol, cell: (r) => <ProtocolBadge protocol={r.protocol} />, width: '64px' },
    {
      key: 'title',
      header: 'Title',
      sortValue: (r) => r.title,
      cell: (r) =>
        r.infoUrl ? (
          <a className="mk-release-title" href={r.infoUrl} target="_blank" rel="noreferrer noopener" title={r.title}>
            {r.title}
          </a>
        ) : (
          <span className="mk-release-title" title={r.title}>
            {r.title}
          </span>
        ),
    },
    { key: 'indexer', header: 'Indexer', sortValue: (r) => r.indexerName, cell: (r) => r.indexerName, muted: true },
    { key: 'age', header: 'Age', sortValue: (r) => r.ageMinutes, cell: formatAge, mono: true, align: 'right' },
    { key: 'size', header: 'Size', sortValue: (r) => r.size, cell: (r) => formatBytes(r.size), mono: true, align: 'right' },
    {
      key: 'peers',
      header: 'Peers',
      sortValue: (r) => r.seeders,
      cell: (r) => (r.protocol === 'torrent' ? `${r.seeders ?? '?'} / ${r.leechers ?? '?'}` : '—'),
      mono: true,
      align: 'right',
    },
    { key: 'quality', header: 'Quality', sortValue: (r) => r.quality.quality.weight, cell: (r) => <QualityLabel quality={r.quality} /> },
    {
      key: 'score',
      header: 'Formats',
      sortValue: (r) => r.customFormatScore,
      cell: (r) => (
        <span className="mk-scores">
          {r.customFormats.map((c) => (
            <Tag key={c.id}>{c.name}</Tag>
          ))}
          <ScoreTag name="Score" score={r.customFormatScore} />
        </span>
      ),
    },
    {
      key: 'decision',
      header: 'Decision',
      sortValue: decisionRank,
      cell: (r) =>
        r.approved ? (
          <Chip tone="accent">Approved</Chip>
        ) : (
          <Tooltip content={<RejectionList reasons={r.rejections.map((x) => x.message)} />}>
            <button type="button" className="mk-action-link" aria-label={`${r.rejections.length} rejections: ${r.rejections.map((x) => x.message).join('; ')}`}>
              <StatusChip
                status={r.temporarilyRejected ? 'queued' : 'missing'}
                label={`${r.rejections.length} ${r.rejections.length === 1 ? 'rejection' : 'rejections'}`}
              />
            </button>
          </Tooltip>
        ),
    },
    {
      key: 'grab',
      header: <span className="al-sr-only">Grab</span>,
      align: 'right',
      cell: (r) => (
        <Button
          size="sm"
          variant="secondary"
          aria-label={`Grab ${r.title}`}
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

  if (target === null) return null;
  if (releases.isPending && releases.fetchStatus !== 'idle') return <Loading label="Searching indexers" />;
  if (releases.isError) return <QueryError error={releases.error} onRetry={() => void releases.refetch()} title="Search failed" />;
  return (
    <Table
      columns={columns}
      rows={releases.data}
      rowKey={(r) => `${r.indexerId}-${r.guid}`}
      density="dense"
      defaultSort={{ key: 'decision', direction: 'asc' }}
      maxHeight="62vh"
      empty={<EmptyState title="No releases found">Every enabled indexer was searched.</EmptyState>}
      caption="Releases"
    />
  );
}

/** Interactive search over GET /release: Modal 1100 with every decision and its rejections. */
export function InteractiveSearchModal({ target, title, onClose }: { target: ReleaseSearchTarget | null; title: string; onClose: () => void }) {
  return (
    <Modal open={target !== null} onClose={onClose} title={`Interactive search · ${title}`} size={1100}>
      <ReleaseTable target={target} />
    </Modal>
  );
}

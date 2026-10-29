import type { ReleaseDecision } from '@arclight/shared';
import {
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
import { versionColumn } from './versions/versions-editor.js';
import { GrabButton } from './grab-button.js';
import { useReleaseFilters } from './release-filter-bar.js';
import { t } from '../../i18n/index.js';

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
  const filters = useReleaseFilters(releases.data, target);

  const columns: Column<ReleaseDecision>[] = [
    { key: 'protocol', header: t('common.source'), sortValue: (r) => r.protocol, cell: (r) => <ProtocolBadge protocol={r.protocol} />, width: '64px' },
    {
      key: 'title',
      header: t('common.title'),
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
    { key: 'indexer', header: t('common.indexer'), sortValue: (r) => r.indexerName, cell: (r) => r.indexerName, muted: true },
    { key: 'age', header: t('library.interactiveSearch.age'), sortValue: (r) => r.ageMinutes, cell: formatAge, mono: true, align: 'right' },
    { key: 'size', header: t('common.size'), sortValue: (r) => r.size, cell: (r) => formatBytes(r.size), mono: true, align: 'right' },
    {
      key: 'peers',
      header: t('common.peers'),
      sortValue: (r) => r.seeders,
      cell: (r) => (r.protocol === 'torrent' ? `${r.seeders ?? '?'} / ${r.leechers ?? '?'}` : '—'),
      mono: true,
      align: 'right',
    },
    { key: 'quality', header: t('common.quality'), sortValue: (r) => r.quality.quality.weight, cell: (r) => <QualityLabel quality={r.quality} /> },
    ...versionColumn(releases.data, (r) => r.versionTag, t('common.version')),
    {
      key: 'score',
      header: t('common.formats'),
      sortValue: (r) => r.customFormatScore,
      cell: (r) => (
        <span className="mk-scores">
          {r.customFormats.map((c) => (
            <Tag key={c.id}>{c.name}</Tag>
          ))}
          <ScoreTag name={t('common.score')} score={r.customFormatScore} />
        </span>
      ),
    },
    {
      key: 'decision',
      header: t('library.interactiveSearch.decision'),
      sortValue: decisionRank,
      cell: (r) =>
        r.approved ? (
          <Chip tone="accent">{t('common.approved')}</Chip>
        ) : (
          <Tooltip content={<RejectionList reasons={r.rejections.map((x) => x.message)} />}>
            <button type="button" className="mk-action-link" aria-label={`${r.rejections.length} rejections: ${r.rejections.map((x) => x.message).join('; ')}`}>
              <StatusChip
                status={r.temporarilyRejected ? 'queued' : 'missing'}
                label={t('library.interactiveSearch.rejections', { rejectionsCount: r.rejections.length })}
              />
            </button>
          </Tooltip>
        ),
    },
    {
      key: 'grab',
      header: <span className="al-sr-only">{t('library.interactiveSearch.grab')}</span>,
      align: 'right',
      cell: (r) => (
        <GrabButton
          release={r}
          loading={grab.isPending && grab.variables?.guid === r.guid}
          onGrab={() =>
            grab.mutateAsync({
              guid: r.guid,
              indexerId: r.indexerId,
              ...(r.seriesId !== undefined ? { seriesId: r.seriesId } : {}),
              ...(r.episodeIds !== undefined ? { episodeIds: r.episodeIds } : {}),
              ...(r.movieId !== undefined ? { movieId: r.movieId } : {}),
            })
          }
        />
      ),
    },
  ];

  if (target === null) return null;
  if (releases.isPending && releases.fetchStatus !== 'idle') return <Loading label={t('library.interactiveSearch.searchingIndexers')} />;
  if (releases.isError) return <QueryError error={releases.error} onRetry={() => void releases.refetch()} title={t('common.searchFailed')} />;
  return (
    <>
      {filters.bar}
      <Table
        columns={columns}
        rows={filters.rows}
        rowKey={(r) => `${r.indexerId}-${r.guid}`}
        density="dense"
        defaultSort={{ key: 'decision', direction: 'asc' }}
        maxHeight="62vh"
        empty={
          filters.empty ?? <EmptyState title={t('library.interactiveSearch.noReleasesFound')}>{t('library.interactiveSearch.everyEnabledIndexerWasSearched')}</EmptyState>
        }
        caption={t('library.interactiveSearch.releases')}
      />
    </>
  );
}

/** Interactive search over GET /release: Modal 1100 with every decision and its rejections. */
export function InteractiveSearchModal({ target, title, onClose }: { target: ReleaseSearchTarget | null; title: string; onClose: () => void }) {
  return (
    <Modal open={target !== null} onClose={onClose} title={t('library.interactiveSearch.interactiveSearchTitle', { title })} size={1100}>
      <ReleaseTable target={target} />
    </Modal>
  );
}

import { useMemo } from 'react';
import type { ReleaseDecision } from '@arclight/shared';
import { Chip, EmptyState, Modal, ProtocolBadge, RejectionList, ScoreTag, StatusChip, Table, Tag, Tooltip, type Column } from '../../../arclight/index.js';
import { audiobookFacts, audiobookGrabRequest, type AudiobookReleaseTarget } from '../../../api/audiobook-acquisition.js';
import { formatBytes } from '../../../components/media/format.js';
import { Loading, QualityLabel, QueryError } from '../../../components/media/media-kit.js';
import { useAudiobookInteractiveSearch, useGrabAudiobookRelease } from '../../../hooks/audiobook-acquisition.js';
import { decisionRank, formatAge } from '../interactive-search.js';
import { FormatTypeChip } from './audiobook-kit.js';
import { bitrateText, matchedBookTitles, narratorsText, seriesText } from './audiobook-release-model.js';
import '../library.css';
import { GrabButton } from '../grab-button.js';
import { useReleaseFilters } from '../release-filter-bar.js';
import { UnreleasedSearchNotice, type ReleaseState } from '../../../components/media/release-state.js';
import { t } from '../../../i18n/index.js';

const dash = <span className="mk-dim">—</span>;

/**
 * Interactive search results for a book (or an author's packs): the decision columns of the
 * video table plus what the parser read from the name (narrators, abridged or not, container,
 * bitrate, series and position, packs) and the books each release maps to.
 */
export function AudiobookReleaseTable({ target, bookTitles }: { target: AudiobookReleaseTarget | null; bookTitles?: ReadonlyMap<number, string> | undefined }) {
  const releases = useAudiobookInteractiveSearch(target);
  const grab = useGrabAudiobookRelease();
  const filters = useReleaseFilters(releases.data, target);
  const titles = useMemo(() => bookTitles ?? new Map<number, string>(), [bookTitles]);

  const columns: Column<ReleaseDecision>[] = [
    { key: 'protocol', header: t('common.source'), sortValue: (r) => r.protocol, cell: (r) => <ProtocolBadge protocol={r.protocol} />, width: '64px' },
    {
      key: 'title',
      header: t('common.title'),
      sortValue: (r) => r.title,
      cell: (r) => {
        const f = audiobookFacts(r);
        const covers = matchedBookTitles(r, titles);
        return (
          <div className="music-release">
            {r.infoUrl ? (
              <a className="mk-release-title" href={r.infoUrl} target="_blank" rel="noreferrer noopener" title={r.title}>
                {r.title}
              </a>
            ) : (
              <span className="mk-release-title" title={r.title}>
                {r.title}
              </span>
            )}
            {f.isPack || covers.length > 1 ? (
              <span className="music-release__covers">
                {f.isPack ? (
                  <Chip tone="warn" dot="none" data-testid="pack-badge">
                    {t('audiobooks.search.pack')}
                  </Chip>
                ) : null}
                {covers.length > 1 ? <span className="mk-muted">{t('audiobooks.search.coversBooks', { count: covers.length, titles: covers.join(', ') })}</span> : null}
              </span>
            ) : null}
          </div>
        );
      },
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
    { key: 'narrators', header: t('audiobooks.narrators'), sortValue: (r) => narratorsText(audiobookFacts(r)), cell: (r) => narratorsText(audiobookFacts(r)) ?? dash, muted: true },
    {
      key: 'format',
      header: t('audiobooks.search.format'),
      sortValue: (r) => audiobookFacts(r).formatType,
      cell: (r) => {
        const type = audiobookFacts(r).formatType;
        return type ? <FormatTypeChip type={type} /> : dash;
      },
    },
    { key: 'container', header: t('audiobooks.search.container'), sortValue: (r) => audiobookFacts(r).container, cell: (r) => audiobookFacts(r).container ?? dash, mono: true },
    { key: 'bitrate', header: t('audiobooks.search.bitrate'), sortValue: (r) => audiobookFacts(r).bitrateKbps ?? -1, cell: (r) => bitrateText(audiobookFacts(r)) ?? dash, mono: true, align: 'right' },
    { key: 'series', header: t('common.series'), sortValue: (r) => seriesText(audiobookFacts(r)), cell: (r) => seriesText(audiobookFacts(r)) ?? dash, muted: true },
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
              <StatusChip status={r.temporarilyRejected ? 'queued' : 'missing'} label={t('library.interactiveSearch.rejections', { rejectionsCount: r.rejections.length })} />
            </button>
          </Tooltip>
        ),
    },
    {
      key: 'grab',
      header: <span className="al-sr-only">{t('library.interactiveSearch.grab')}</span>,
      align: 'right',
      cell: (r) => (
        <GrabButton release={r} loading={grab.isPending && grab.variables?.guid === r.guid} onGrab={() => grab.mutateAsync(audiobookGrabRequest(r))} />
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

/** The interactive search modal for a book or an author (same frame as the video one). */
export function AudiobookInteractiveSearchModal({
  target,
  title,
  bookTitles,
  release,
  onClose,
}: {
  target: AudiobookReleaseTarget | null;
  title: string;
  bookTitles?: ReadonlyMap<number, string> | undefined;
  /** A book that is not released yet: searched anyway, under a warning. */
  release?: ReleaseState | null | undefined;
  onClose: () => void;
}) {
  return (
    <Modal open={target !== null} onClose={onClose} title={t('library.interactiveSearch.interactiveSearchTitle', { title })} size={1100}>
      <UnreleasedSearchNotice state={release} />
      <AudiobookReleaseTable target={target} bookTitles={bookTitles} />
    </Modal>
  );
}

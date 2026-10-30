import { useMemo } from 'react';
import type { ReleaseDecision } from '@arclight/shared';
import {
  Chip,
  EmptyState,
  Modal,
  ProtocolBadge,
  QualityTag,
  RejectionList,
  ScoreTag,
  StatusChip,
  Table,
  Tag,
  Tooltip,
  type Column,
} from '../../../arclight/index.js';
import { musicFacts, musicGrabRequest, type MusicReleaseTarget } from '../../../api/music-acquisition.js';
import { formatBytes } from '../../../components/media/format.js';
import { Loading, QualityLabel, QueryError } from '../../../components/media/media-kit.js';
import { useGrabMusicRelease, useMusicInteractiveSearch } from '../../../hooks/music-acquisition.js';
import { decisionRank, formatAge } from '../interactive-search.js';
import { audioSortValue, audioSpecText, discographyText, logCueText, matchedAlbumTitles } from './music-release-model.js';
import '../library.css';
import './music.css';
import { GrabButton } from '../grab-button.js';
import { useReleaseFilters } from '../release-filter-bar.js';
import { UnreleasedSearchNotice, type ReleaseState } from '../../../components/media/release-state.js';
import { t } from '../../../i18n/index.js';

/**
 * Interactive search results for an album (or an artist's packs): the decision columns of the
 * video table plus what the parser read from the name (codec, bitrate or bit depth / sample
 * rate, media, log and cue, discography packs) and the albums each release maps to.
 */
export function MusicReleaseTable({ target, albumTitles }: { target: MusicReleaseTarget | null; albumTitles?: ReadonlyMap<number, string> | undefined }) {
  const releases = useMusicInteractiveSearch(target);
  const grab = useGrabMusicRelease();
  const filters = useReleaseFilters(releases.data, target);
  const titles = useMemo(() => albumTitles ?? new Map<number, string>(), [albumTitles]);

  const columns: Column<ReleaseDecision>[] = [
    { key: 'protocol', header: t('common.source'), sortValue: (r) => r.protocol, cell: (r) => <ProtocolBadge protocol={r.protocol} />, width: '64px' },
    {
      key: 'title',
      header: t('common.title'),
      sortValue: (r) => r.title,
      cell: (r) => {
        const f = musicFacts(r);
        const pack = discographyText(f);
        const covers = matchedAlbumTitles(r, titles);
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
            {pack || covers.length > 1 ? (
              <span className="music-release__covers">
                {pack ? (
                  <Chip tone="warn" dot="none" data-testid="discography-badge">
                    {pack}
                  </Chip>
                ) : null}
                {covers.length > 1 ? <span className="mk-muted">{t('music.search.coversAlbums', { count: covers.length, titles: covers.join(', ') })}</span> : null}
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
    {
      key: 'quality',
      header: t('common.quality'),
      sortValue: (r) => r.quality.quality.weight,
      cell: (r) => {
        const codec = musicFacts(r).codec;
        const name = r.quality.quality.name;
        return codec && codec !== 'Unknown' && name === 'Unknown' ? <QualityTag>{codec}</QualityTag> : <QualityLabel quality={r.quality} />;
      },
    },
    {
      key: 'audio',
      header: t('music.search.audio'),
      sortValue: (r) => audioSortValue(musicFacts(r)),
      mono: true,
      cell: (r) => audioSpecText(musicFacts(r)) ?? <span className="mk-dim">—</span>,
    },
    { key: 'media', header: t('music.search.media'), sortValue: (r) => musicFacts(r).media, cell: (r) => musicFacts(r).media ?? <span className="mk-dim">—</span>, muted: true },
    {
      key: 'logcue',
      header: t('music.search.logCue'),
      sortValue: (r) => musicFacts(r).logScore ?? (musicFacts(r).hasLog ? 0 : -1),
      cell: (r) => {
        const text = logCueText(musicFacts(r));
        return text ? (
          <Chip tone="accent" dot="ring" data-testid="logcue-badge">
            {text}
          </Chip>
        ) : (
          <span className="mk-dim">—</span>
        );
      },
    },
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
        <GrabButton release={r} loading={grab.isPending && grab.variables?.guid === r.guid} onGrab={() => grab.mutateAsync(musicGrabRequest(r))} />
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

/** The interactive search modal for an album or an artist (same frame as the video one). */
export function MusicInteractiveSearchModal({
  target,
  title,
  albumTitles,
  release,
  onClose,
}: {
  target: MusicReleaseTarget | null;
  title: string;
  albumTitles?: ReadonlyMap<number, string> | undefined;
  /** An album that is not released yet: searched anyway, under a warning. */
  release?: ReleaseState | null | undefined;
  onClose: () => void;
}) {
  return (
    <Modal open={target !== null} onClose={onClose} title={t('library.interactiveSearch.interactiveSearchTitle', { title })} size={1100}>
      <UnreleasedSearchNotice state={release} />
      <MusicReleaseTable target={target} albumTitles={albumTitles} />
    </Modal>
  );
}

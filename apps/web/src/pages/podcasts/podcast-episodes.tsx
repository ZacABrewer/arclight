import { useState } from 'react';
import type { PodcastEpisodeQuery, PodcastEpisodeSortKey, PodcastEpisodeStatus } from '@arclight/shared';
import { FilterBar, Input, PageHeader, Paginator, Select } from '../../arclight/index.js';
import { useAuth } from '../../auth/auth-context.js';
import { Num, QueryError } from '../../components/media/media-kit.js';
import { usePodcastEpisodes } from '../../hooks/podcasts.js';
import { EPISODE_STATUSES, EpisodeBulkBar, EpisodeTable, PodcastGate, episodeStatusLabel } from './podcast-kit.js';
import { t } from '../../i18n/index.js';

// Podcasts → Episodes (/podcasts/episodes): every podcast's episodes, newest first, with status,
// played and title filters, paging and bulk actions.

const PAGE_SIZE = 50;

type PlayedFilter = 'all' | 'played' | 'unplayed';

/** The api query for the page's filters (exported for tests). */
export function episodeQuery(f: { status: PodcastEpisodeStatus | ''; played: PlayedFilter; term: string; sortKey: PodcastEpisodeSortKey; page: number }): PodcastEpisodeQuery {
  return {
    page: f.page,
    pageSize: PAGE_SIZE,
    sortKey: f.sortKey,
    sortDirection: f.sortKey === 'title' ? 'asc' : 'desc',
    ...(f.status ? { status: f.status } : {}),
    ...(f.played !== 'all' ? { played: f.played === 'played' } : {}),
    ...(f.term.trim() ? { term: f.term.trim() } : {}),
  };
}

export function PodcastEpisodesPage() {
  return (
    <PodcastGate>
      <PodcastEpisodes />
    </PodcastGate>
  );
}

function PodcastEpisodes() {
  const { isAdmin } = useAuth();
  const [status, setStatus] = useState<PodcastEpisodeStatus | ''>('');
  const [played, setPlayed] = useState<PlayedFilter>('all');
  const [term, setTerm] = useState('');
  const [sortKey, setSortKey] = useState<PodcastEpisodeSortKey>('publishedAt');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const episodes = usePodcastEpisodes(episodeQuery({ status, played, term, sortKey, page }));
  const total = episodes.data?.totalRecords ?? 0;
  const records = episodes.data?.records;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Any filter change starts again from page 1 with nothing selected.
  const reset = () => {
    setPage(1);
    setSelected(new Set());
  };
  const active = (status ? 1 : 0) + (played !== 'all' ? 1 : 0) + (term ? 1 : 0);

  return (
    <div className="lib-page">
      <PageHeader index="02" title={t('nav.podcastEpisodes')}>
        {episodes.data ? (
          <span className="mk-count">
            <Num>{total}</Num> {t('podcasts.episodeNoun', { count: total })}
          </span>
        ) : null}
      </PageHeader>

      <FilterBar
        activeCount={active}
        onClear={() => {
          setStatus('');
          setPlayed('all');
          setTerm('');
          reset();
        }}
      >
        <Input
          type="search"
          aria-label={t('podcasts.searchEpisodes')}
          placeholder={t('podcasts.searchEpisodes')}
          value={term}
          onChange={(e) => {
            setTerm(e.currentTarget.value);
            reset();
          }}
        />
        <Select
          aria-label={t('common.status')}
          value={status}
          onChange={(e) => {
            setStatus(e.currentTarget.value as PodcastEpisodeStatus | '');
            reset();
          }}
          options={[{ value: '', label: t('podcasts.anyStatus') }, ...EPISODE_STATUSES.map((s) => ({ value: s, label: episodeStatusLabel(s) }))]}
        />
        <Select
          aria-label={t('podcasts.played')}
          value={played}
          onChange={(e) => {
            setPlayed(e.currentTarget.value as PlayedFilter);
            reset();
          }}
          options={[
            { value: 'all', label: t('podcasts.playedAny') },
            { value: 'played', label: t('podcasts.played') },
            { value: 'unplayed', label: t('podcasts.unplayed') },
          ]}
        />
        <Select
          aria-label={t('library.sortBy')}
          value={sortKey}
          onChange={(e) => {
            setSortKey(e.currentTarget.value as PodcastEpisodeSortKey);
            reset();
          }}
          options={[
            { value: 'publishedAt', label: t('podcasts.sort.published') },
            { value: 'downloadedAt', label: t('podcasts.sort.downloaded') },
            { value: 'title', label: t('podcasts.sort.title') },
            { value: 'status', label: t('podcasts.sort.status') },
          ]}
        />
      </FilterBar>

      {episodes.isError ? (
        <QueryError error={episodes.error} onRetry={() => void episodes.refetch()} title={t('podcasts.couldNotLoadEpisodes')} />
      ) : (
        <EpisodeTable
          rows={records}
          loading={episodes.isPending}
          showPodcast
          selected={selected}
          onSelectionChange={setSelected}
          readOnly={!isAdmin}
          empty={active ? t('library.nothingMatchesTheseFilters') : t('podcasts.noEpisodes')}
        />
      )}
      {pageCount > 1 ? (
        <Paginator
          page={page}
          pageCount={pageCount}
          onPageChange={(n) => {
            setPage(n);
            setSelected(new Set());
          }}
        />
      ) : null}
      <EpisodeBulkBar ids={[...selected]} total={records?.length ?? 0} onSelectAll={() => setSelected(new Set((records ?? []).map((e) => e.id)))} onClear={() => setSelected(new Set())} />
    </div>
  );
}

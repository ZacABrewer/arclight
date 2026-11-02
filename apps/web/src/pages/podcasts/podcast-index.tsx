import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { Podcast, PodcastEpisodeRow } from '@arclight/shared';
import { Button, EmptyState, FilterBar, Input, PageHeader, Segmented, Select, Table, buttonClass, type Column } from '../../arclight/index.js';
import { podcastsApi } from '../../api/podcasts.js';
import { useAuth } from '../../auth/auth-context.js';
import { formatBytes, formatDate } from '../../components/media/format.js';
import { Num, PosterSkeletons, QueryError } from '../../components/media/media-kit.js';
import { useToast } from '../../components/toast.js';
import { usePodcastEpisodes, usePodcastList, useRefreshAllPodcasts } from '../../hooks/podcasts.js';
import { PodcastArt, PodcastGate, PodcastStatusChip, episodeDuration, podcastLink } from './podcast-kit.js';
import { t } from '../../i18n/index.js';

// Podcasts → Podcasts (/podcasts): "Jump back in" (the newest downloaded episodes not played yet),
// then every subscription as a cover grid or a list with episode counts, the offline marker, the
// feed's error badge, Refresh all and the OPML export.

export type PodcastStatusFilter = 'all' | 'active' | 'error' | 'unmonitored' | 'wanted';
export type PodcastLibraryView = 'grid' | 'list';

const VIEW_KEY = 'arclight.podcasts.view';
const JUMP_BACK_SIZE = 6;

/** Text and status filters, sorted by title (exported for tests). */
export function filterPodcasts(list: readonly Podcast[], q: string, status: PodcastStatusFilter): Podcast[] {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return list
    .filter((p) => {
      const hay = `${p.title} ${p.author ?? ''}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
      if (status === 'active') return p.status === 'active' && p.monitored;
      if (status === 'error') return p.status !== 'active';
      if (status === 'unmonitored') return !p.monitored;
      if (status === 'wanted') return p.statistics.wantedCount > 0;
      return true;
    })
    .sort((a, b) => a.sortTitle.localeCompare(b.sortTitle));
}

/** The remembered grid / list choice (per viewer; storage may be unavailable). */
function readView(): PodcastLibraryView {
  try {
    return globalThis.localStorage?.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

function saveView(v: PodcastLibraryView) {
  try {
    globalThis.localStorage?.setItem(VIEW_KEY, v);
  } catch {
    // Private windows and blocked storage: the choice just isn't remembered.
  }
}

export function PodcastIndexPage() {
  return (
    <PodcastGate>
      <PodcastIndex />
    </PodcastGate>
  );
}

function PodcastIndex() {
  const podcasts = usePodcastList();
  const refreshAll = useRefreshAllPodcasts();
  const toast = useToast();
  const { isAdmin } = useAuth();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<PodcastStatusFilter>('all');
  const [view, setView] = useState<PodcastLibraryView>(readView);
  const all = podcasts.data ?? [];
  const rows = useMemo(() => filterPodcasts(podcasts.data ?? [], q, status), [podcasts.data, q, status]);
  const totalSize = all.reduce((n, p) => n + p.statistics.sizeOnDisk, 0);
  const addLink = (
    <Link to="/podcasts/add" className={buttonClass({ variant: 'primary' })}>
      {t('nav.addPodcast')}
    </Link>
  );

  return (
    <div className="lib-page">
      <PageHeader
        index="01"
        title={t('common.podcasts')}
        actions={
          isAdmin ? (
            <>
              <Button loading={refreshAll.isPending} onClick={() => refreshAll.mutate(undefined, { onSuccess: () => toast.push({ tone: 'ok', title: t('podcasts.refreshQueued') }) })}>
                {t('podcasts.refreshAll')}
              </Button>
              <a href={podcastsApi.opmlUrl()} className={buttonClass({ variant: 'secondary' })} download>
                {t('podcasts.exportOpml')}
              </a>
              {addLink}
            </>
          ) : null
        }
      >
        {podcasts.data ? (
          <span className="mk-count">
            <Num>{rows.length !== all.length ? `${rows.length} / ${all.length}` : all.length}</Num> {t('podcasts.podcastNoun', { count: all.length })} · <Num>{formatBytes(totalSize)}</Num>
          </span>
        ) : null}
      </PageHeader>

      {all.length > 0 ? <JumpBackIn /> : null}

      <div className="pod-lib-head">
        <h2 className="mk-section-title">{t('podcasts.yourLibrary')}</h2>
        <Segmented<PodcastLibraryView>
          aria-label={t('podcasts.libraryView')}
          variant="soft"
          value={view}
          onChange={(v) => {
            setView(v);
            saveView(v);
          }}
          options={[
            { value: 'grid', label: t('podcasts.viewGrid') },
            { value: 'list', label: t('podcasts.viewList') },
          ]}
        />
      </div>

      <FilterBar activeCount={(q ? 1 : 0) + (status !== 'all' ? 1 : 0)} onClear={() => { setQ(''); setStatus('all'); }}>
        <Input type="search" aria-label={t('podcasts.filterPodcasts')} placeholder={t('podcasts.filterPodcasts')} value={q} onChange={(e) => setQ(e.currentTarget.value)} />
        <Select
          aria-label={t('common.status')}
          value={status}
          onChange={(e) => setStatus(e.currentTarget.value as PodcastStatusFilter)}
          options={[
            { value: 'all', label: t('podcasts.filter.all') },
            { value: 'active', label: t('podcasts.filter.active') },
            { value: 'wanted', label: t('podcasts.filter.wanted') },
            { value: 'error', label: t('podcasts.filter.error') },
            { value: 'unmonitored', label: t('podcasts.filter.unmonitored') },
          ]}
        />
      </FilterBar>

      {podcasts.isPending ? (
        <PosterSkeletons />
      ) : podcasts.isError ? (
        <QueryError error={podcasts.error} onRetry={() => void podcasts.refetch()} title={t('podcasts.couldNotLoad')} />
      ) : all.length === 0 ? (
        <EmptyState size="lg" title={t('podcasts.noPodcastsYet')} action={isAdmin ? addLink : undefined}>
          {t('podcasts.noPodcastsHelp')}
        </EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState title={t('library.nothingMatchesTheseFilters')} action={<Button onClick={() => { setQ(''); setStatus('all'); }}>{t('library.clearFilters')}</Button>} />
      ) : view === 'list' ? (
        <PodcastList rows={rows} />
      ) : (
        <div className="pod-grid" data-testid="podcast-grid">
          {rows.map((p) => (
            <PodcastCard key={p.id} podcast={p} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The design's small rotated square: episodes of this podcast are on disk to play offline. */
function OfflineMark() {
  return (
    <span className="pod-offline" data-testid="offline-marker">
      <span className="pod-offline__dot" aria-hidden="true" />
      {t('podcasts.saved')}
    </span>
  );
}

function PodcastCard({ podcast: p }: { podcast: Podcast }) {
  const s = p.statistics;
  return (
    <div className="pod-card" data-unmonitored={!p.monitored || undefined}>
      <Link {...podcastLink(p)} className="music-card" aria-label={p.title}>
        <PodcastArt podcast={p} />
        <div className="al-poster-card__title-row">
          <span className="al-poster-card__title">{p.title}</span>
        </div>
        <div className="pod-card__meta">
          <span>{t('podcasts.episodeCount', { count: s.episodeCount })}</span>
          <span className="al-num">{t('podcasts.downloadedCount', { count: s.downloadedCount })}</span>
          {s.wantedCount > 0 ? <span className="al-num">{t('podcasts.wantedCount', { count: s.wantedCount })}</span> : null}
          {s.lastEpisodeAt ? <span className="al-num">{formatDate(s.lastEpisodeAt)}</span> : null}
        </div>
        {s.downloadedCount > 0 ? <OfflineMark /> : null}
      </Link>
      <span className="pod-card__badge">
        <PodcastStatusChip podcast={p} />
      </span>
    </div>
  );
}

/** List view: cover, title, author and episode count, wanted, then the offline marker. */
function PodcastList({ rows }: { rows: readonly Podcast[] }) {
  const columns: Column<Podcast>[] = [
    { key: 'art', header: <span className="al-sr-only">{t('podcasts.cover')}</span>, label: t('podcasts.cover'), cell: (p) => <PodcastArt podcast={p} width={48} />, mobile: 'hide' },
    {
      key: 'title',
      header: t('podcasts.listTitle'),
      mobile: 'primary',
      cell: (p) => (
        <span className="pod-list-title">
          <Link {...podcastLink(p)} className="mk-link" aria-label={p.title}>
            {p.title}
          </Link>
          <PodcastStatusChip podcast={p} />
        </span>
      ),
    },
    { key: 'detail', header: t('podcasts.listDetail'), cell: (p) => [p.author, t('podcasts.episodeCount', { count: p.statistics.episodeCount })].filter(Boolean).join(' · ') },
    { key: 'wanted', header: t('podcasts.filter.wanted'), mono: true, align: 'right', cell: (p) => (p.statistics.wantedCount > 0 ? t('podcasts.wantedCount', { count: p.statistics.wantedCount }) : '—') },
    { key: 'offline', header: t('podcasts.offline'), cell: (p) => (p.statistics.downloadedCount > 0 ? <OfflineMark /> : <span className="al-caption">—</span>) },
  ];
  return (
    <div data-testid="podcast-list">
      <Table columns={columns} rows={rows} rowKey={(p) => p.id} sortable={false} caption={t('podcasts.yourLibrary')} />
    </div>
  );
}

/** The newest downloaded episodes nobody has played yet; hidden when there are none (or it fails). */
function JumpBackIn() {
  const episodes = usePodcastEpisodes({ status: 'downloaded', played: false, sortKey: 'publishedAt', sortDirection: 'desc', pageSize: JUMP_BACK_SIZE });
  const records = episodes.data?.records ?? [];
  if (records.length === 0) return null;
  return (
    <section className="pod-jump" aria-labelledby="pod-jump-title">
      <h2 id="pod-jump-title" className="mk-section-title">
        {t('podcasts.jumpBackIn')}
      </h2>
      <ul className="pod-jump__grid" data-testid="jump-back-in">
        {records.map((e) => (
          <li key={e.id}>
            <JumpTile episode={e} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function JumpTile({ episode: e }: { episode: PodcastEpisodeRow }) {
  const sub = [e.podcastTitle, e.publishedAt ? formatDate(e.publishedAt) : null, e.durationSeconds != null ? episodeDuration(e.durationSeconds) : null].filter(Boolean).join(' · ');
  return (
    <Link {...podcastLink({ id: e.podcastId })} className="pod-jump__tile" aria-label={t('podcasts.jumpTo', { title: e.title, podcast: e.podcastTitle })}>
      <PodcastArt podcast={{ title: e.podcastTitle, imageUrl: e.imageUrl ?? e.podcastImageUrl }} width={64} />
      <span className="pod-jump__text">
        <span className="pod-jump__title">{e.title}</span>
        <span className="pod-jump__sub al-num">{sub}</span>
      </span>
    </Link>
  );
}

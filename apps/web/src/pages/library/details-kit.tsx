import { useMemo, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { MediaRequest } from '@arclight/shared';
import { request } from '../../api/client.js';
import { HistoryPage, historyEventLabel as eventLabel, type HistoryEventType, type HistoryRecord } from '../../api/history.js';
import { BackdropFrame, Button, Chip, EmptyState, Poster, Table, type ChipTone, type Column } from '../../arclight/index.js';
import { episodeCode, formatDate } from '../../components/media/format.js';
import { QueryError } from '../../components/media/media-kit.js';
import { REQUEST_STATUS_META, seasonsLabel } from '../../features/requests/status.js';
import { useItemHistory, useQueue } from '../../hooks/activity.js';
import { useRefreshMedia, type RefreshTarget } from '../../hooks/library.js';
import { useTitle } from '../../hooks/requests.js';
import './library.css';
import { t } from '../../i18n/index.js';

// Pieces shared by the series and movie details pages (Page 03).

export interface DetailsHeroProps {
  backdrop?: string | undefined;
  poster?: string | undefined;
  title: string;
  year?: number | null | undefined;
  crumb: ReactNode;
  /** "Apple TV+ · Drama, Sci-Fi · 3 seasons · 55 min · Continuing". */
  meta?: ReactNode;
  chips?: ReactNode;
  /** Usually a KeyValue grid with mono values. */
  facts?: ReactNode;
  overview?: string | null | undefined;
  actions?: ReactNode;
  children?: ReactNode;
  label: string;
}

/** Backdrop (fade left 92%→20% and bottom), 208px poster, title-xl + mono year, meta, chips, facts, verbs. */
export function DetailsHero({ backdrop, poster, title, year, crumb, meta, chips, facts, overview, actions, children, label }: DetailsHeroProps) {
  return (
    <section className="mk-hero" aria-label={label}>
      <BackdropFrame src={backdrop} title="" fade bleed loading="eager" />
      <div className="mk-hero__grid">
        <Poster src={poster} title={title} className="mk-hero__poster" loading="eager" />
        <div className="mk-hero__body">
          <nav className="mk-crumb" aria-label={t('library.detailsKit.breadcrumb')}>
            {crumb}
          </nav>
          <h1 className="mk-hero__title">
            <span className="al-title-xl">{title}</span>
            {year ? <span className="mk-hero__year">{year}</span> : null}
          </h1>
          {meta ? <div className="mk-hero__meta">{meta}</div> : null}
          {chips ? <div className="mk-hero__chips">{chips}</div> : null}
          {facts}
          {overview ? <p className="mk-hero__overview">{overview}</p> : null}
          {children}
          {actions ? <div className="mk-hero__actions">{actions}</div> : null}
        </div>
      </div>
    </section>
  );
}

/** "Library / Series" crumb. */
export function LibraryCrumb({ kind }: { kind: 'series' | 'movie' }) {
  return (
    <>
      <Link to={kind === 'series' ? '/library/tv' : '/library/movies'}>{t('common.library')}</Link> / {kind === 'series' ? t('common.series') : t('common.movie')}
    </>
  );
}

/* ------------------------------------------------------------------ refresh */

/** Secondary "Refresh" (metadata) and "Refresh & scan" (metadata, then re-read the folder). */
export function RefreshButtons({ target }: { target: RefreshTarget }) {
  const refresh = useRefreshMedia();
  const running = refresh.isPending ? (refresh.variables?.rescan ? 'scan' : 'refresh') : null;
  return (
    <>
      <Button loading={running === 'refresh'} disabled={running === 'scan'} onClick={() => refresh.mutate({ target, rescan: false })}>
        {t('common.refresh')}
      </Button>
      <Button loading={running === 'scan'} disabled={running === 'refresh'} onClick={() => refresh.mutate({ target, rescan: true })}>
        {t('library.detailsKit.refreshScan')}
      </Button>
    </>
  );
}

/* ------------------------------------------------------------------ queue progress */

/** Live queue progress (0–1) keyed by episode id, plus the movie's own progress. */
export function useQueueProgress(scope: { seriesId: number } | { movieId: number }) {
  const queue = useQueue('seriesId' in scope ? { seriesId: scope.seriesId, pageSize: 200 } : { mediaType: 'movie', pageSize: 200 });
  return useMemo(() => {
    const episodes = new Map<number, number>();
    let movie: number | null = null;
    for (const item of queue.data?.records ?? []) {
      if ('seriesId' in scope && item.seriesId === scope.seriesId) for (const id of item.episodeIds ?? []) episodes.set(id, item.progress);
      if ('movieId' in scope && item.movieId === scope.movieId) movie = item.progress;
    }
    return { episodes, movie };
  }, [queue.data, scope]);
}

/* ------------------------------------------------------------------ history tab */

const EVENT_TONE: Partial<Record<HistoryEventType, ChipTone>> = {
  grabbed: 'default',
  downloadFolderImported: 'accent',
  downloadFailed: 'danger',
  fileDeleted: 'muted',
  fileRenamed: 'neutral',
  downloadIgnored: 'muted',
};

export const historyEventLabel = eventLabel;

export function useMediaHistory(scope: { seriesId: number } | { movieId: number } | { episodeId: number }, enabled = true) {
  return useQuery({
    queryKey: ['history', 'media', scope],
    queryFn: () => request('/history', HistoryPage, { query: { page: 1, pageSize: 100, sortKey: 'date', sortDirection: 'desc', includeEpisode: true, ...scope } }),
    enabled,
    retry: false,
  });
}

export function HistoryEventChip({ type }: { type: string }) {
  return <Chip tone={EVENT_TONE[type as HistoryEventType] ?? 'neutral'}>{historyEventLabel(type)}</Chip>;
}

/** Indexer or download client named in the record's data, for the "Via" column. */
export function historyVia(r: Pick<HistoryRecord, 'data'>): string {
  const d = r.data ?? {};
  const pick = (k: string) => (typeof d[k] === 'string' && d[k] ? (d[k] as string) : null);
  return pick('indexer') ?? pick('downloadClientName') ?? pick('downloadClient') ?? '—';
}

/** History tab of the details pages: GET /history/series or /history/movie. */
export function HistoryTable({ scope }: { scope: { seriesId: number } | { movieId: number } }) {
  const history = useItemHistory(scope);
  const isSeries = 'seriesId' in scope;
  const columns: Column<HistoryRecord>[] = [
    { key: 'date', header: t('common.date'), sortValue: (r) => r.date, cell: (r) => formatDate(r.date, { dateStyle: 'medium', timeStyle: 'short' }), mono: true, width: '190px' },
    { key: 'event', header: t('library.detailsKit.event'), sortValue: (r) => historyEventLabel(r.eventType), cell: (r) => <HistoryEventChip type={r.eventType} />, width: '140px' },
    ...(isSeries
      ? [
          {
            key: 'episode',
            header: t('common.episode'),
            mono: true,
            width: '96px',
            sortValue: (r: HistoryRecord) => (r.episode ? r.episode.seasonNumber * 10_000 + r.episode.episodeNumber : -1),
            cell: (r: HistoryRecord) => (r.episode ? episodeCode(r.episode.seasonNumber, r.episode.episodeNumber) : '—'),
          } satisfies Column<HistoryRecord>,
        ]
      : []),
    { key: 'source', header: t('common.sourceTitle'), sortValue: (r) => r.sourceTitle, cell: (r) => <span className="mk-release-title">{r.sourceTitle}</span> },
    { key: 'quality', header: t('common.quality'), sortValue: (r) => r.quality?.quality?.name ?? '', cell: (r) => r.quality?.quality?.name ?? '—', mono: true },
    { key: 'via', header: t('library.detailsKit.via'), muted: true, cell: (r) => historyVia(r) },
  ];
  if (history.isError) return <QueryError error={history.error} title={t('library.detailsKit.couldNotLoadHistory')} onRetry={() => void history.refetch()} />;
  return (
    <Table
      columns={columns}
      rows={history.data}
      loading={history.isPending}
      rowKey={(r) => r.id}
      empty={<EmptyState title={t('library.detailsKit.noHistoryYet')}>{t('library.detailsKit.grabsImportsAndFailuresShow')}</EmptyState>}
      caption={t('common.history')}
    />
  );
}

/* ------------------------------------------------------------------ requests tab */

const REQUEST_TONE: Record<MediaRequest['status'], ChipTone> = {
  pending: 'warn',
  approved: 'accent',
  declined: 'danger',
  failed: 'danger',
  completed: 'accent',
};

export function RequestStatusChip({ status }: { status: MediaRequest['status'] }) {
  return <Chip tone={REQUEST_TONE[status]}>{REQUEST_STATUS_META[status].label}</Chip>;
}

/** Requests for this title (from the Discover title detail). */
export function RequestsTable({ kind, tmdbId }: { kind: 'movie' | 'tv'; tmdbId: number }) {
  const title = useTitle(kind, tmdbId);
  const columns: Column<MediaRequest>[] = [
    { key: 'by', header: t('common.requestedBy'), cell: (r) => r.requestedBy.displayName ?? r.requestedBy.username },
    { key: 'track', header: t('common.track'), cell: (r) => (r.is4k ? '4K' : t('common.standard')), mono: true },
    { key: 'seasons', header: t('common.seasons'), cell: (r) => seasonsLabel(r.seasons) || '—', mono: true },
    { key: 'status', header: t('common.status'), cell: (r) => <RequestStatusChip status={r.status} /> },
    { key: 'created', header: t('common.requested'), sortValue: (r) => r.createdAt, cell: (r) => formatDate(r.createdAt, { dateStyle: 'medium', timeStyle: 'short' }), mono: true },
  ];
  if (title.isError) return <QueryError error={title.error} title={t('library.detailsKit.couldNotLoadRequests')} onRetry={() => void title.refetch()} />;
  return (
    <Table
      columns={columns}
      rows={title.data?.requests}
      loading={title.isPending}
      rowKey={(r) => r.id}
      empty={<EmptyState title={t('library.detailsKit.noRequests')}>{t('library.detailsKit.nobodyHasRequestedThisTitle')}</EmptyState>}
      caption={t('common.requests')}
    />
  );
}

import { useState } from 'react';
import { getRouteApi, Link } from '@tanstack/react-router';
import { Permission, type MediaRequest, type TitleDetail } from '@arclight/shared';
import type { DiscoverKind } from '../../api/requests.js';
import {
  BackdropFrame,
  Button,
  KeyValue,
  LinkButton,
  Pane,
  Poster,
  SectionHead,
  Skeleton,
  Table,
  Tag,
  type Column,
  type KeyValueItem,
} from '../../arclight/index.js';
import { QueryError } from '../../components/media/media-kit.js';
import { ReportIssueDialog } from '../../features/requests/issue-dialog.js';
import { show4kToggle } from '../../features/requests/request-rules.js';
import { MEDIA_STATUS_META, REQUEST_STATUS_META, formatDateTime, seasonsLabel, usePermissions } from '../../features/requests/status.js';
import { useAddToWatchlist, useRemoveFromWatchlist, useRequestsSettings, useTitle, useWatchlist } from '../../hooks/requests.js';
import { DiscoverRow, StatusLabelChip } from './discover-kit.js';
import { RequestModal } from './request-modal.js';
import { t } from '../../i18n/index.js';

const movieRoute = getRouteApi('/discover/movie/$tmdbId');
const tvRoute = getRouteApi('/discover/tv/$tmdbId');

export function MovieTitlePage() {
  const { tmdbId } = movieRoute.useParams();
  return <TitlePage kind="movie" tmdbId={Number(tmdbId)} />;
}

export function TvTitlePage() {
  const { tmdbId } = tvRoute.useParams();
  return <TitlePage kind="tv" tmdbId={Number(tmdbId)} />;
}

function TitlePage({ kind, tmdbId }: { kind: DiscoverKind; tmdbId: number }) {
  const title = useTitle(kind, tmdbId);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) return <QueryError error={new Error(t('discover.title.theTmdbIdInThe'))} title={t('discover.title.invalidTitle')} />;
  if (title.isPending) return <Skeleton lines={8} />;
  if (title.isError) return <QueryError error={title.error} title={t('discover.title.couldNotLoadThisTitle')} onRetry={() => void title.refetch()} />;
  return <TitleView t={title.data} />;
}

/** Whether there is anything left to request on a track. */
export function requestable(entry: TitleDetail, fourK: boolean): boolean {
  if (!entry.canRequest) return false;
  if (entry.mediaType === 'series') return true;
  return fourK ? entry.mediaStatus4k === 'unknown' : entry.mediaStatus === 'unknown';
}

/** The title's headline status: Available / Partially available / Requested / Approved, or null. */
export function titleStatusLabel(pick: Pick<TitleDetail, 'mediaStatus' | 'requestStatus'>): string | null {
  if (pick.mediaStatus === 'available' || pick.mediaStatus === 'partiallyAvailable') return MEDIA_STATUS_META[pick.mediaStatus].label;
  if (pick.mediaStatus === 'processing' || pick.requestStatus === 'approved') return t('common.approved');
  if (pick.mediaStatus === 'pending' || pick.requestStatus === 'pending') return t('common.requested');
  return null;
}

function TitleView({ t: row }: { t: TitleDetail }) {
  const { can } = usePermissions();
  const settings = useRequestsSettings();
  const [requesting, setRequesting] = useState<null | 'standard' | '4k'>(null);
  const [reporting, setReporting] = useState(false);
  const fourK = show4kToggle(row, settings.data);
  const trailers = row.videos.filter((v) => v.url);
  const directors = row.crew.filter((c) => c.job === 'Director' || c.job === 'Creator').slice(0, 3);
  const status = titleStatusLabel(row);
  const status4k = row.mediaStatus4k !== 'unknown' ? MEDIA_STATUS_META[row.mediaStatus4k].label : null;
  const meta = [row.mediaType === 'movie' ? t('common.movie') : t('common.series'), row.genres.map((g) => g.name).join(', '), row.status].filter(Boolean).join(' · ');
  const facts: KeyValueItem[] = [
    { label: t('common.release'), value: row.releaseDate ?? '—' },
    { label: t('common.runtime'), value: row.runtimeMinutes ? `${row.runtimeMinutes} min` : '—' },
    { label: t('discover.title.rating'), value: row.rating ? `${row.rating.toFixed(1)} / 10` : '—' },
    { label: row.mediaType === 'movie' ? t('discover.title.director') : t('discover.title.createdBy'), value: directors.map((d) => d.name).join(', ') || '—', mono: false },
  ];

  return (
    <>
      <section className="mk-hero" aria-label={t('discover.title.titleOverview')}>
        <BackdropFrame src={row.backdropUrl} title="" fade bleed />
        <div className="mk-hero__grid">
          <Poster src={row.posterUrl} title={row.title} className="mk-hero__poster" loading="eager" />
          <div className="mk-hero__body">
            <div className="mk-crumb">
              <Link to="/discover">{t('common.discover')}</Link> / {row.mediaType === 'movie' ? t('common.movies') : t('common.series')}
            </div>
            <h1 className="mk-hero__title">
              <span className="al-title-xl">{row.title}</span>
              {row.year ? <span className="mk-hero__year">{row.year}</span> : null}
            </h1>
            {meta ? <div className="mk-hero__meta">{meta}</div> : null}
            <div className="mk-hero__chips">
              {status ? <StatusLabelChip label={status} large /> : null}
              {status4k ? <StatusLabelChip label={t('discover.title.n4kStatus4k', { status4k: status4k.toLowerCase() })} large /> : null}
              {row.genres.map((g) => (
                <Link key={g.id} to="/discover/genre/$id" params={{ id: String(g.id) }} search={{ mediaType: row.mediaType === 'movie' ? 'movie' : 'tv' }}>
                  <Tag>{g.name}</Tag>
                </Link>
              ))}
            </div>
            {row.tagline ? <p className="mk-hero__tagline">{row.tagline}</p> : null}
            <KeyValue layout="grid" columns={4} items={facts} />
            {row.overview ? <p className="mk-hero__overview">{row.overview}</p> : null}
            <div className="mk-hero__actions">
              {row.canRequest ? (
                <Button variant="primary" disabled={!requestable(row, false)} onClick={() => setRequesting('standard')}>
                  {t('common.request')}
                </Button>
              ) : null}
              {row.canRequest && fourK ? (
                <Button disabled={!requestable(row, true)} onClick={() => setRequesting('4k')}>
                  {t('discover.title.request4k')}
                </Button>
              ) : null}
              <WatchlistToggle t={row} />
              {row.libraryId ? (
                <Link
                  className="al-btn al-btn--secondary"
                  {...(row.mediaType === 'series'
                    ? { to: '/library/series/$id' as const, params: { id: String(row.libraryId) } }
                    : { to: '/library/movie/$id' as const, params: { id: String(row.libraryId) } })}
                >
                  {t('discover.title.openInLibrary')}
                </Link>
              ) : null}
              {can(Permission.CREATE_ISSUES, Permission.MANAGE_ISSUES) ? <Button onClick={() => setReporting(true)}>{t('discover.title.reportIssue')}</Button> : null}
              {trailers.slice(0, 1).map((v) => (
                <LinkButton key={v.key} variant="ghost" href={v.url} target="_blank" rel="noreferrer noopener">
                  {t('discover.title.watchTrailer')}
                </LinkButton>
              ))}
            </div>
            {row.openIssues > 0 ? (
              <Link to="/issues" style={{ color: 'var(--al-warn-text)', fontSize: 13 }}>
                <span className="al-num">{row.openIssues}</span> {t('discover.title.openIssuesReview', { openIssues: row.openIssues })}
              </Link>
            ) : null}
          </div>
        </div>
      </section>

      <div className="mk-stack" style={{ gap: 40 }}>
        {row.requests.length > 0 ? <RequestsPane requests={row.requests} /> : null}

        {row.cast.length > 0 ? (
          <section className="mk-slider" aria-label={t('discover.title.cast')}>
            <SectionHead label={<h2 className="al-title-m mk-section-title">{t('discover.title.cast')}</h2>} />
            <div className="mk-cast">
              {row.cast.slice(0, 20).map((c) => (
                <Link key={`${c.tmdbId}-${c.character ?? ''}`} className="mk-cast__card" to="/discover/person/$id" params={{ id: String(c.tmdbId) }}>
                  <Poster src={c.profileUrl} title={c.name} />
                  <span className="mk-cast__name">{c.name}</span>
                  <span className="mk-cast__role">{c.character ?? ''}</span>
                </Link>
              ))}
            </div>
          </section>
        ) : null}

        {row.recommendations.length > 0 ? <DiscoverRow title={t('discover.title.recommendations')} items={row.recommendations} /> : null}
        {row.similar.length > 0 ? <DiscoverRow title={t('discover.title.similar')} items={row.similar} /> : null}
      </div>

      <RequestModal title={row} open={requesting !== null} is4k={requesting === '4k'} onClose={() => setRequesting(null)} />
      <ReportIssueDialog target={{ mediaType: row.mediaType, tmdbId: row.tmdbId, title: row.title, seasons: row.seasons }} open={reporting} onClose={() => setReporting(false)} />
    </>
  );
}

const requestColumns: Column<MediaRequest>[] = [
  { key: 'by', get header() { return t('common.requestedBy'); }, cell: (r) => r.requestedBy.displayName ?? r.requestedBy.username },
  { key: 'track', get header() { return t('common.track'); }, cell: (r) => (r.is4k ? '4K' : t('common.standard')) },
  { key: 'seasons', get header() { return t('common.seasons'); }, mono: true, cell: (r) => seasonsLabel(r.seasons) || '—' },
  { key: 'status', get header() { return t('common.status'); }, cell: (r) => <StatusLabelChip label={REQUEST_STATUS_META[r.status].label} /> },
  { key: 'created', get header() { return t('common.requested'); }, mono: true, muted: true, cell: (r) => formatDateTime(r.createdAt) },
];

function RequestsPane({ requests }: { requests: readonly MediaRequest[] }) {
  return (
    <Pane title={t('common.requests')} flush bare>
      <Table columns={requestColumns} rows={requests} rowKey={(r) => r.id} sortable={false} caption={t('common.requests')} />
    </Pane>
  );
}

function WatchlistToggle({ t: el }: { t: TitleDetail }) {
  // The title only says whether it is listed; the item id (for DELETE) comes from the list.
  const list = useWatchlist(undefined, el.onWatchlist);
  const add = useAddToWatchlist();
  const remove = useRemoveFromWatchlist();
  const item = list.data?.find((w) => w.tmdbId === el.tmdbId && w.mediaType === el.mediaType);
  if (el.onWatchlist) {
    return (
      <Button loading={remove.isPending} disabled={!item} onClick={() => item && remove.mutate(item.id)}>
        {t('discover.title.removeFromWatchlist')}
      </Button>
    );
  }
  return (
    <Button loading={add.isPending} onClick={() => add.mutate({ mediaType: el.mediaType, tmdbId: el.tmdbId })}>
      {t('discover.title.addToWatchlist')}
    </Button>
  );
}

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
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) return <QueryError error={new Error('The TMDB id in the address is not a number.')} title="Invalid title" />;
  if (title.isPending) return <Skeleton lines={8} />;
  if (title.isError) return <QueryError error={title.error} title="Could not load this title" onRetry={() => void title.refetch()} />;
  return <TitleView t={title.data} />;
}

/** Whether there is anything left to request on a track. */
export function requestable(t: TitleDetail, fourK: boolean): boolean {
  if (!t.canRequest) return false;
  if (t.mediaType === 'series') return true;
  return fourK ? t.mediaStatus4k === 'unknown' : t.mediaStatus === 'unknown';
}

/** The title's headline status: Available / Partially available / Requested / Approved, or null. */
export function titleStatusLabel(t: Pick<TitleDetail, 'mediaStatus' | 'requestStatus'>): string | null {
  if (t.mediaStatus === 'available' || t.mediaStatus === 'partiallyAvailable') return MEDIA_STATUS_META[t.mediaStatus].label;
  if (t.mediaStatus === 'processing' || t.requestStatus === 'approved') return 'Approved';
  if (t.mediaStatus === 'pending' || t.requestStatus === 'pending') return 'Requested';
  return null;
}

function TitleView({ t }: { t: TitleDetail }) {
  const { can } = usePermissions();
  const settings = useRequestsSettings();
  const [requesting, setRequesting] = useState<null | 'standard' | '4k'>(null);
  const [reporting, setReporting] = useState(false);
  const fourK = show4kToggle(t, settings.data);
  const trailers = t.videos.filter((v) => v.url);
  const directors = t.crew.filter((c) => c.job === 'Director' || c.job === 'Creator').slice(0, 3);
  const status = titleStatusLabel(t);
  const status4k = t.mediaStatus4k !== 'unknown' ? MEDIA_STATUS_META[t.mediaStatus4k].label : null;
  const meta = [t.mediaType === 'movie' ? 'Movie' : 'Series', t.genres.map((g) => g.name).join(', '), t.status].filter(Boolean).join(' · ');
  const facts: KeyValueItem[] = [
    { label: 'Release', value: t.releaseDate ?? '—' },
    { label: 'Runtime', value: t.runtimeMinutes ? `${t.runtimeMinutes} min` : '—' },
    { label: 'Rating', value: t.rating ? `${t.rating.toFixed(1)} / 10` : '—' },
    { label: t.mediaType === 'movie' ? 'Director' : 'Created by', value: directors.map((d) => d.name).join(', ') || '—', mono: false },
  ];

  return (
    <>
      <section className="mk-hero" aria-label="Title overview">
        <BackdropFrame src={t.backdropUrl} title="" fade bleed />
        <div className="mk-hero__grid">
          <Poster src={t.posterUrl} title={t.title} className="mk-hero__poster" loading="eager" />
          <div className="mk-hero__body">
            <div className="mk-crumb">
              <Link to="/discover">Discover</Link> / {t.mediaType === 'movie' ? 'Movies' : 'Series'}
            </div>
            <h1 className="mk-hero__title">
              <span className="al-title-xl">{t.title}</span>
              {t.year ? <span className="mk-hero__year">{t.year}</span> : null}
            </h1>
            {meta ? <div className="mk-hero__meta">{meta}</div> : null}
            <div className="mk-hero__chips">
              {status ? <StatusLabelChip label={status} large /> : null}
              {status4k ? <StatusLabelChip label={`4K ${status4k.toLowerCase()}`} large /> : null}
              {t.genres.map((g) => (
                <Link key={g.id} to="/discover/genre/$id" params={{ id: String(g.id) }} search={{ mediaType: t.mediaType === 'movie' ? 'movie' : 'tv' }}>
                  <Tag>{g.name}</Tag>
                </Link>
              ))}
            </div>
            {t.tagline ? <p className="mk-hero__tagline">{t.tagline}</p> : null}
            <KeyValue layout="grid" columns={4} items={facts} />
            {t.overview ? <p className="mk-hero__overview">{t.overview}</p> : null}
            <div className="mk-hero__actions">
              {t.canRequest ? (
                <Button variant="primary" disabled={!requestable(t, false)} onClick={() => setRequesting('standard')}>
                  Request
                </Button>
              ) : null}
              {t.canRequest && fourK ? (
                <Button disabled={!requestable(t, true)} onClick={() => setRequesting('4k')}>
                  Request 4K
                </Button>
              ) : null}
              <WatchlistToggle t={t} />
              {t.libraryId ? (
                <Link
                  className="al-btn al-btn--secondary"
                  {...(t.mediaType === 'series'
                    ? { to: '/library/series/$id' as const, params: { id: String(t.libraryId) } }
                    : { to: '/library/movie/$id' as const, params: { id: String(t.libraryId) } })}
                >
                  Open in library
                </Link>
              ) : null}
              {can(Permission.CREATE_ISSUES, Permission.MANAGE_ISSUES) ? <Button onClick={() => setReporting(true)}>Report issue</Button> : null}
              {trailers.slice(0, 1).map((v) => (
                <LinkButton key={v.key} variant="ghost" href={v.url} target="_blank" rel="noreferrer noopener">
                  Watch trailer
                </LinkButton>
              ))}
            </div>
            {t.openIssues > 0 ? (
              <Link to="/issues" style={{ color: 'var(--al-warn-text)', fontSize: 13 }}>
                <span className="al-num">{t.openIssues}</span> open issue{t.openIssues === 1 ? '' : 's'}. Review
              </Link>
            ) : null}
          </div>
        </div>
      </section>

      <div className="mk-stack" style={{ gap: 40 }}>
        {t.requests.length > 0 ? <RequestsPane requests={t.requests} /> : null}

        {t.cast.length > 0 ? (
          <section className="mk-slider" aria-label="Cast">
            <SectionHead label={<h2 className="al-title-m mk-section-title">Cast</h2>} />
            <div className="mk-cast">
              {t.cast.slice(0, 20).map((c) => (
                <Link key={`${c.tmdbId}-${c.character ?? ''}`} className="mk-cast__card" to="/discover/person/$id" params={{ id: String(c.tmdbId) }}>
                  <Poster src={c.profileUrl} title={c.name} />
                  <span className="mk-cast__name">{c.name}</span>
                  <span className="mk-cast__role">{c.character ?? ''}</span>
                </Link>
              ))}
            </div>
          </section>
        ) : null}

        {t.recommendations.length > 0 ? <DiscoverRow title="Recommendations" items={t.recommendations} /> : null}
        {t.similar.length > 0 ? <DiscoverRow title="Similar" items={t.similar} /> : null}
      </div>

      <RequestModal title={t} open={requesting !== null} is4k={requesting === '4k'} onClose={() => setRequesting(null)} />
      <ReportIssueDialog target={{ mediaType: t.mediaType, tmdbId: t.tmdbId, title: t.title, seasons: t.seasons }} open={reporting} onClose={() => setReporting(false)} />
    </>
  );
}

const requestColumns: Column<MediaRequest>[] = [
  { key: 'by', header: 'Requested by', cell: (r) => r.requestedBy.displayName ?? r.requestedBy.username },
  { key: 'track', header: 'Track', cell: (r) => (r.is4k ? '4K' : 'Standard') },
  { key: 'seasons', header: 'Seasons', mono: true, cell: (r) => seasonsLabel(r.seasons) || '—' },
  { key: 'status', header: 'Status', cell: (r) => <StatusLabelChip label={REQUEST_STATUS_META[r.status].label} /> },
  { key: 'created', header: 'Requested', mono: true, muted: true, cell: (r) => formatDateTime(r.createdAt) },
];

function RequestsPane({ requests }: { requests: readonly MediaRequest[] }) {
  return (
    <Pane title="Requests" flush bare>
      <Table columns={requestColumns} rows={requests} rowKey={(r) => r.id} sortable={false} caption="Requests" />
    </Pane>
  );
}

function WatchlistToggle({ t }: { t: TitleDetail }) {
  // The title only says whether it is listed; the item id (for DELETE) comes from the list.
  const list = useWatchlist(undefined, t.onWatchlist);
  const add = useAddToWatchlist();
  const remove = useRemoveFromWatchlist();
  const item = list.data?.find((w) => w.tmdbId === t.tmdbId && w.mediaType === t.mediaType);
  if (t.onWatchlist) {
    return (
      <Button loading={remove.isPending} disabled={!item} onClick={() => item && remove.mutate(item.id)}>
        Remove from watchlist
      </Button>
    );
  }
  return (
    <Button loading={add.isPending} onClick={() => add.mutate({ mediaType: t.mediaType, tmdbId: t.tmdbId })}>
      Add to watchlist
    </Button>
  );
}

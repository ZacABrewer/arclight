import { useState } from 'react';
import { getRouteApi, Link } from '@tanstack/react-router';
import { Permission, type MediaRequest, type TitleDetail } from '@media-tron/shared';
import type { DiscoverKind } from '../../api/requests.js';
import { Badge } from '../../components/badge.js';
import { Button } from '../../components/button.js';
import { Card } from '../../components/card.js';
import { ErrorView } from '../../components/error-boundary.js';
import { Facts, Poster } from '../../components/media/media-ui.js';
import { Page } from '../../components/page.js';
import { LoadingBlock } from '../../components/spinner.js';
import { DiscoverRow } from '../../features/requests/discover-ui.js';
import { ReportIssueDialog } from '../../features/requests/issue-dialog.js';
import { RequestDialog, show4kToggle } from '../../features/requests/request-dialog.js';
import { MEDIA_STATUS_META, REQUEST_STATUS_META, formatDateTime, seasonsLabel, usePermissions } from '../../features/requests/status.js';
import { useAddToWatchlist, useRemoveFromWatchlist, useRequestsSettings, useTitle, useWatchlist } from '../../hooks/requests.js';
import '../../features/requests/requests.css';

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
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) return <ErrorView error={new Error('Invalid TMDB id')} />;
  if (title.isPending) return <LoadingBlock />;
  if (title.isError) return <ErrorView error={title.error} onRetry={() => void title.refetch()} />;
  return <TitleView t={title.data} />;
}

/** Whether there is anything left to request on either track. */
export function requestable(t: TitleDetail, fourK: boolean): boolean {
  if (!t.canRequest) return false;
  if (t.mediaType === 'series') return true;
  return t.mediaStatus === 'unknown' || (fourK && t.mediaStatus4k === 'unknown');
}

function TitleView({ t }: { t: TitleDetail }) {
  const { can } = usePermissions();
  const settings = useRequestsSettings();
  const [requesting, setRequesting] = useState(false);
  const [reporting, setReporting] = useState(false);
  const fourK = show4kToggle(t, settings.data);
  const trailers = t.videos.filter((v) => v.url);
  const directors = t.crew.filter((c) => c.job === 'Director' || c.job === 'Creator').slice(0, 3);

  return (
    <Page title={t.title} subtitle={[t.year, t.mediaType === 'movie' ? 'Movie' : 'Series'].filter(Boolean).join(' · ')}>
      <section className="media-hero" aria-label="Title overview">
        {t.backdropUrl ? <div className="media-hero-fanart" style={{ backgroundImage: `url("${t.backdropUrl}")` }} aria-hidden="true" /> : null}
        <Poster url={t.posterUrl ?? undefined} title={t.title} size="lg" />
        <div className="media-hero-body">
          <h2 className="media-hero-title">
            {t.title}
            {t.year ? <span className="muted">({t.year})</span> : null}
            <Badge tone={MEDIA_STATUS_META[t.mediaStatus].tone}>{MEDIA_STATUS_META[t.mediaStatus].label}</Badge>
            {t.mediaStatus4k !== 'unknown' ? <Badge tone={MEDIA_STATUS_META[t.mediaStatus4k].tone}>4K: {MEDIA_STATUS_META[t.mediaStatus4k].label}</Badge> : null}
          </h2>
          {t.tagline ? <em className="muted">{t.tagline}</em> : null}
          <Facts
            items={[
              ['Status', t.status ?? '—'],
              ['Release', t.releaseDate ?? '—'],
              ['Runtime', t.runtimeMinutes ? `${t.runtimeMinutes} min` : '—'],
              ['Rating', t.rating ? `★ ${t.rating.toFixed(1)}` : '—'],
              [
                'Genres',
                t.genres.length ? (
                  <span key="g" className="row">
                    {t.genres.map((g) => (
                      <Link key={g.id} className="link-subtle" to="/discover/genre/$id" params={{ id: String(g.id) }} search={{ mediaType: t.mediaType === 'movie' ? 'movie' : 'tv' }}>
                        {g.name}
                      </Link>
                    ))}
                  </span>
                ) : (
                  '—'
                ),
              ],
              [t.mediaType === 'movie' ? 'Director' : 'Created by', directors.map((d) => d.name).join(', ') || '—'],
            ]}
          />
          {t.overview ? <p className="media-hero-overview">{t.overview}</p> : null}
          <div className="media-hero-actions">
            {t.canRequest ? (
              <Button variant="primary" disabled={!requestable(t, fourK)} onClick={() => setRequesting(true)}>
                Request
              </Button>
            ) : null}
            {can(Permission.CREATE_ISSUES, Permission.MANAGE_ISSUES) ? <Button onClick={() => setReporting(true)}>Report issue</Button> : null}
            <WatchlistToggle t={t} />
            {t.libraryId ? (
              <Link
                className="btn btn-secondary btn-md"
                {...(t.mediaType === 'series'
                  ? { to: '/library/series/$id' as const, params: { id: String(t.libraryId) } }
                  : { to: '/library/movie/$id' as const, params: { id: String(t.libraryId) } })}
              >
                Open in library
              </Link>
            ) : null}
            {trailers.slice(0, 2).map((v) => (
              <a key={v.key} className="btn btn-ghost btn-md" href={v.url} target="_blank" rel="noreferrer noopener">
                ▶ {v.type === 'Trailer' ? 'Trailer' : v.name}
              </a>
            ))}
          </div>
          {t.openIssues > 0 ? (
            <Link className="link-subtle" to="/issues">
              {t.openIssues} open issue{t.openIssues === 1 ? '' : 's'}
            </Link>
          ) : null}
        </div>
      </section>

      {t.requests.length > 0 ? <RequestsCard requests={t.requests} /> : null}

      {t.cast.length > 0 ? (
        <section className="discover-section">
          <div className="discover-section-head">
            <h2 className="discover-section-title">Cast</h2>
          </div>
          <div className="discover-row cast-row">
            {t.cast.slice(0, 20).map((c) => (
              <Link key={`${c.tmdbId}-${c.character ?? ''}`} className="cast-card" to="/discover/person/$id" params={{ id: String(c.tmdbId) }}>
                <Poster url={c.profileUrl ?? undefined} title={c.name} />
                <strong>{c.name}</strong>
                <span className="muted">{c.character ?? ''}</span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <DiscoverRow title="Recommendations" items={t.recommendations} />
      <DiscoverRow title="Similar" items={t.similar} />

      <RequestDialog title={t} open={requesting} onClose={() => setRequesting(false)} />
      <ReportIssueDialog target={{ mediaType: t.mediaType, tmdbId: t.tmdbId, title: t.title, seasons: t.seasons }} open={reporting} onClose={() => setReporting(false)} />
    </Page>
  );
}

function RequestsCard({ requests }: { requests: readonly MediaRequest[] }) {
  return (
    <Card title="Requests" flush className="discover-section">
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Requested by</th>
              <th>Track</th>
              <th>Seasons</th>
              <th>Status</th>
              <th>Requested</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((r) => (
              <tr key={r.id}>
                <td>{r.requestedBy.displayName ?? r.requestedBy.username}</td>
                <td>{r.is4k ? '4K' : 'Standard'}</td>
                <td>{seasonsLabel(r.seasons) || '—'}</td>
                <td>
                  <Badge tone={REQUEST_STATUS_META[r.status].tone}>{REQUEST_STATUS_META[r.status].label}</Badge>
                </td>
                <td>{formatDateTime(r.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
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
        ★ On watchlist — remove
      </Button>
    );
  }
  return (
    <Button loading={add.isPending} onClick={() => add.mutate({ mediaType: t.mediaType, tmdbId: t.tmdbId })}>
      ☆ Add to watchlist
    </Button>
  );
}

import { useState } from 'react';
import { Link, useParams, useRouterState } from '@tanstack/react-router';
import { Permission, type MediaRequest, type TitleDetail, type TitleSeason } from '@arclight/shared';
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
  buttonClass,
  type Column,
  type KeyValueItem,
} from '../../arclight/index.js';
import { useAuth } from '../../auth/auth-context.js';
import { QueryError } from '../../components/media/media-kit.js';
import { DLink, useInPortal } from '../../features/discover/base.js';
import { tmdbImage } from '../../features/discover/images.js';
import { ReportIssueDialog } from '../../features/requests/issue-dialog.js';
import { seasonBlocker, show4kToggle } from '../../features/requests/request-rules.js';
import { MEDIA_STATUS_META, REQUEST_STATUS_META, formatDateTime, seasonsLabel, usePermissions } from '../../features/requests/status.js';
import { useAddToWatchlist, useRemoveFromWatchlist, useRequestsSettings, useTitle, useWatchlist } from '../../hooks/requests.js';
import { DiscoverRow, StatusLabelChip, Track } from './discover-kit.js';
import { RequestModal, seasonName } from './request-modal.js';
import { LanguageRequestModal } from './language-request-modal.js';
import { t } from '../../i18n/index.js';

// Title page (Details layout without file data): hero with backdrop, poster, facts, status and
// the request actions; then requests, seasons with per-season status and requesting, the
// collection, cast and crew, recommendations and similar titles.

function useTmdbIdParam(): number {
  const params = useParams({ strict: false }) as { tmdbId?: string };
  return Number(params.tmdbId);
}

export function MovieTitlePage() {
  const tmdbId = useTmdbIdParam();
  return <TitlePage key={tmdbId} kind="movie" tmdbId={tmdbId} />;
}

export function TvTitlePage() {
  const tmdbId = useTmdbIdParam();
  return <TitlePage key={tmdbId} kind="tv" tmdbId={tmdbId} />;
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

/** Subtitles or an extra audio language can be asked for: the title is in the library with files. */
export function languageRequestable(entry: Pick<TitleDetail, 'libraryId' | 'mediaStatus'>): boolean {
  return entry.libraryId != null && (entry.mediaStatus === 'available' || entry.mediaStatus === 'partiallyAvailable');
}

/** The title's headline status: Available / Partially available / Requested / Approved / Declined, or null. */
export function titleStatusLabel(pick: Pick<TitleDetail, 'mediaStatus' | 'requestStatus'>): string | null {
  if (pick.mediaStatus === 'available' || pick.mediaStatus === 'partiallyAvailable') return MEDIA_STATUS_META[pick.mediaStatus].label;
  if (pick.mediaStatus === 'processing' || pick.requestStatus === 'approved') return t('common.approved');
  if (pick.mediaStatus === 'pending' || pick.requestStatus === 'pending') return t('common.requested');
  if (pick.requestStatus === 'declined') return t('common.declined');
  return null;
}

/** Signed in, or auth unavailable (the api then decides every call). */
function useSignedIn(): boolean {
  const { status } = useAuth();
  return status ? status.authenticated : true;
}

/** "Sign in to request" for portal visitors: /login, coming back to this page. */
function SignInToRequest() {
  const href = useRouterState({ select: (s) => s.location.href });
  return (
    <Link to="/login" search={{ redirect: href }} className={buttonClass({ variant: 'primary' })}>
      {t('discover.title.signInToRequest')}
    </Link>
  );
}

function TitleView({ t: row }: { t: TitleDetail }) {
  const { can } = usePermissions();
  const { isAdmin } = useAuth();
  const signedIn = useSignedIn();
  const inPortal = useInPortal();
  const settings = useRequestsSettings(signedIn);
  const [requesting, setRequesting] = useState<null | { is4k: boolean; seasons?: number[] }>(null);
  const [reporting, setReporting] = useState(false);
  const [requestingLanguage, setRequestingLanguage] = useState(false);
  const fourK = show4kToggle(row, settings.data);
  const trailers = row.videos.filter((v) => v.url && (v.type === 'Trailer' || v.type === 'Teaser'));
  const videos = trailers.length ? trailers : row.videos.filter((v) => v.url);
  const directors = row.crew.filter((c) => c.job === 'Director' || c.job === 'Creator').slice(0, 3);
  const status = titleStatusLabel(row);
  const status4k = row.mediaStatus4k !== 'unknown' ? MEDIA_STATUS_META[row.mediaStatus4k].label : null;
  const isMovie = row.mediaType === 'movie';
  const meta = [isMovie ? t('common.movie') : t('common.series'), row.status, row.originalLanguage ? row.originalLanguage.toUpperCase() : null].filter(Boolean).join(' · ');
  const facts: KeyValueItem[] = [
    { label: isMovie ? t('common.release') : t('discover.title.firstAired'), value: (isMovie ? row.releaseDate : (row.firstAirDate ?? row.releaseDate)) ?? '—' },
    ...(!isMovie && row.lastAirDate ? [{ label: t('discover.title.lastAired'), value: row.lastAirDate }] : []),
    { label: t('common.runtime'), value: row.runtimeMinutes ? `${row.runtimeMinutes} min` : '—' },
    { label: t('discover.title.rating'), value: row.rating ? `${row.rating.toFixed(1)} / 10${row.voteCount ? ` · ${row.voteCount}` : ''}` : '—' },
    { label: isMovie ? t('discover.title.director') : t('discover.title.createdBy'), value: directors.map((d) => d.name).join(', ') || '—', mono: false },
  ];
  const releases = row.releaseDates;
  const keyCrew = row.crew.filter((c) => ['Director', 'Creator', 'Screenplay', 'Writer', 'Novel', 'Original Music Composer', 'Director of Photography', 'Producer', 'Executive Producer'].includes(c.job));

  return (
    <>
      <section className="mk-hero" aria-label={t('discover.title.titleOverview')}>
        <BackdropFrame src={tmdbImage(row.backdropUrl, 'backdrop')} title="" fade bleed loading="eager" />
        <div className="mk-hero__grid">
          <Poster src={tmdbImage(row.posterUrl, 'posterLarge')} title={row.title} className="mk-hero__poster" loading="eager" />
          <div className="mk-hero__body">
            <div className="mk-crumb">
              <DLink to="">{t('common.discover')}</DLink> / <DLink to={isMovie ? '/movies' : '/tv'}>{isMovie ? t('common.movies') : t('common.series')}</DLink>
            </div>
            <h1 className="mk-hero__title">
              <span className="al-title-xl">{row.title}</span>
              {row.year ? <span className="mk-hero__year">{row.year}</span> : null}
            </h1>
            {meta ? <div className="mk-hero__meta">{meta}</div> : null}
            <div className="mk-hero__chips">
              {status ? <StatusLabelChip label={status} large /> : null}
              {status4k ? <StatusLabelChip label={t('discover.title.n4kStatus4k', { status4k: status4k.toLowerCase() })} large /> : null}
              {row.certification ? <Tag>{row.certification}</Tag> : null}
              {row.genres.map((g) => (
                <DLink key={g.id} to="/genre/$id" params={{ id: String(g.id) }} search={{ mediaType: isMovie ? 'movie' : 'tv' }}>
                  <Tag>{g.name}</Tag>
                </DLink>
              ))}
            </div>
            {row.tagline ? <p className="mk-hero__tagline">{row.tagline}</p> : null}
            <KeyValue layout="grid" columns={facts.length} items={facts} />
            {isMovie && releases && (releases.inCinemas || releases.digital || releases.physical) ? (
              <dl className="dk-facts" aria-label={t('discover.title.releaseDates')}>
                {releases.inCinemas ? (
                  <div>
                    <dt>{t('discover.title.inCinemas')}</dt>
                    <dd>{releases.inCinemas}</dd>
                  </div>
                ) : null}
                {releases.digital ? (
                  <div>
                    <dt>{t('discover.title.digital')}</dt>
                    <dd>{releases.digital}</dd>
                  </div>
                ) : null}
                {releases.physical ? (
                  <div>
                    <dt>{t('discover.title.physical')}</dt>
                    <dd>{releases.physical}</dd>
                  </div>
                ) : null}
              </dl>
            ) : null}
            {row.overview ? <p className="mk-hero__overview">{row.overview}</p> : null}
            <div className="mk-hero__actions">
              {!signedIn ? <SignInToRequest /> : null}
              {row.canRequest ? (
                <Button variant="primary" disabled={!requestable(row, false)} onClick={() => setRequesting({ is4k: false })}>
                  {t('common.request')}
                </Button>
              ) : null}
              {row.canRequest && fourK ? (
                <Button disabled={!requestable(row, true)} onClick={() => setRequesting({ is4k: true })}>
                  {t('discover.title.request4k')}
                </Button>
              ) : null}
              {signedIn ? <WatchlistToggle t={row} /> : null}
              {signedIn && languageRequestable(row) && can(Permission.REQUEST_LANGUAGE, Permission.REQUEST) ? (
                <Button onClick={() => setRequestingLanguage(true)}>{t('discover.languageRequest.button')}</Button>
              ) : null}
              {row.libraryId && !inPortal ? (
                <Link
                  className="al-btn al-btn--secondary"
                  {...(row.mediaType === 'series'
                    ? { to: '/library/series/$id' as const, params: { id: String(row.libraryId) } }
                    : { to: '/library/movie/$id' as const, params: { id: String(row.libraryId) } })}
                >
                  {isAdmin ? t('discover.title.manage') : t('discover.title.openInLibrary')}
                </Link>
              ) : null}
              {signedIn && can(Permission.CREATE_ISSUES, Permission.MANAGE_ISSUES) ? <Button onClick={() => setReporting(true)}>{t('discover.title.reportIssue')}</Button> : null}
              {videos.slice(0, 1).map((v) => (
                <LinkButton key={v.key} variant="ghost" href={v.url} target="_blank" rel="noreferrer noopener">
                  {t('discover.title.watchTrailer')}
                </LinkButton>
              ))}
            </div>
            {row.openIssues > 0 && !inPortal ? (
              <Link to="/issues" style={{ color: 'var(--al-warn-text)', fontSize: 13 }}>
                <span className="al-num">{row.openIssues}</span> {t('discover.title.openIssuesReview', { openIssues: row.openIssues })}
              </Link>
            ) : null}
          </div>
        </div>
      </section>

      <div className="mk-stack" style={{ gap: 40 }}>
        {row.requests.length > 0 ? <RequestsPane requests={row.requests} /> : null}

        {row.mediaType === 'series' && row.seasons.length > 0 ? (
          <SeasonsSection row={row} specials={settings.data?.enableSpecialEpisodes ?? false} onRequest={(seasonNumber) => setRequesting({ is4k: false, seasons: [seasonNumber] })} />
        ) : null}

        {row.collection ? (
          <section className="dk-collection" aria-label={t('discover.title.collection')}>
            <span className="al-label">{t('discover.title.partOf')}</span>
            <div>
              <div className="al-title-m">{row.collection.name}</div>
              <p className="al-caption" style={{ margin: '4px 0 0' }}>
                {t('discover.title.collectionHelp')}
              </p>
            </div>
            <DLink to="/collection/$id" params={{ id: String(row.collection.id) }} className={buttonClass({ variant: 'secondary' })}>
              {t('discover.title.viewCollection')}
            </DLink>
          </section>
        ) : null}

        {row.cast.length > 0 ? (
          <section className="mk-slider" aria-label={t('discover.title.cast')}>
            <SectionHead label={<h2 className="al-title-m mk-section-title">{t('discover.title.cast')}</h2>} />
            <Track label={t('discover.title.cast')} className="mk-cast">
              {row.cast.slice(0, 30).map((c) => (
                <DLink key={`${c.tmdbId}-${c.character ?? ''}`} className="mk-cast__card" to="/person/$id" params={{ id: String(c.tmdbId) }}>
                  <Poster src={tmdbImage(c.profileUrl, 'profile')} title={c.name} />
                  <span className="mk-cast__name">{c.name}</span>
                  <span className="mk-cast__role">{c.character ?? ''}</span>
                </DLink>
              ))}
            </Track>
          </section>
        ) : null}

        {keyCrew.length > 0 ? (
          <section className="mk-slider" aria-label={t('discover.title.crew')}>
            <SectionHead label={<h2 className="al-title-m mk-section-title">{t('discover.title.crew')}</h2>} />
            <Track label={t('discover.title.crew')} className="mk-cast">
              {keyCrew.slice(0, 20).map((c) => (
                <DLink key={`${c.tmdbId}-${c.job}`} className="mk-cast__card" to="/person/$id" params={{ id: String(c.tmdbId) }}>
                  <Poster src={tmdbImage(c.profileUrl, 'profile')} title={c.name} />
                  <span className="mk-cast__name">{c.name}</span>
                  <span className="mk-cast__role">{c.job}</span>
                </DLink>
              ))}
            </Track>
          </section>
        ) : null}

        {videos.length > 1 ? (
          <section className="mk-slider" aria-label={t('discover.title.videos')}>
            <SectionHead label={<h2 className="al-title-m mk-section-title">{t('discover.title.videos')}</h2>} />
            <div className="dk-links">
              {videos.slice(0, 6).map((v) => (
                <LinkButton key={v.key} variant="ghost" size="sm" href={v.url} target="_blank" rel="noreferrer noopener">
                  {v.name}
                </LinkButton>
              ))}
            </div>
          </section>
        ) : null}

        {row.recommendations.length > 0 ? <DiscoverRow title={t('discover.title.recommendations')} items={row.recommendations} /> : null}
        {row.similar.length > 0 ? <DiscoverRow title={t('discover.title.similar')} items={row.similar} /> : null}

        {row.companies.length > 0 || row.keywords.length > 0 ? (
          <section className="mk-stack-sm" aria-label={t('discover.title.moreLikeThis')}>
            {row.companies.length > 0 ? (
              <div className="dk-links">
                <span className="al-label">{isMovie ? t('discover.title.studios') : t('discover.title.networks')}</span>
                {row.companies.slice(0, 8).map((c) => (
                  <DLink key={c.id} className="mk-chip-link" to={isMovie ? '/studio/$id' : '/network/$id'} params={{ id: String(c.id) }}>
                    {c.name}
                  </DLink>
                ))}
              </div>
            ) : null}
            {row.keywords.length > 0 ? (
              <div className="dk-links">
                <span className="al-label">{t('discover.browse.keywords')}</span>
                {row.keywords.slice(0, 16).map((k) => (
                  <DLink key={k.id} className="mk-chip-link" to="/keyword/$id" params={{ id: String(k.id) }} search={{ mediaType: isMovie ? 'movie' : 'tv' }}>
                    {k.name}
                  </DLink>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}
      </div>

      <RequestModal title={row} open={requesting !== null} is4k={requesting?.is4k ?? false} allow4k={fourK} initialSeasons={requesting?.seasons} onClose={() => setRequesting(null)} />
      {signedIn ? (
        <LanguageRequestModal open={requestingLanguage} onClose={() => setRequestingLanguage(false)} mediaType={row.mediaType} tmdbId={row.tmdbId} title={row.title} />
      ) : null}
      {signedIn ? (
        <ReportIssueDialog target={{ mediaType: row.mediaType, tmdbId: row.tmdbId, title: row.title, seasons: row.seasons }} open={reporting} onClose={() => setReporting(false)} />
      ) : null}
    </>
  );
}

/** Seasons with their status per track and a Request button per season. */
function SeasonsSection({ row, specials, onRequest }: { row: TitleDetail; specials: boolean; onRequest: (seasonNumber: number) => void }) {
  const seasons = row.seasons.filter((s) => specials || s.seasonNumber > 0).sort((a, b) => a.seasonNumber - b.seasonNumber);
  const chips = (s: TitleSeason) => {
    const out: string[] = [];
    const normal = seasonBlocker(s, false);
    if (normal) out.push(normal);
    const uhd = seasonBlocker(s, true);
    if (uhd) out.push(t('discover.title.n4kStatus4k', { status4k: uhd.toLowerCase() }));
    return out;
  };
  return (
    <section className="mk-slider" aria-label={t('common.seasons')}>
      <SectionHead
        label={
          <h2 className="al-title-m mk-section-title">
            {t('common.seasons')} <span className="al-num al-caption">{seasons.length}</span>
          </h2>
        }
      />
      <div className="dk-seasons">
        {seasons.map((s) => {
          const labels = chips(s);
          const open = row.canRequest && seasonBlocker(s, false) === null && s.episodeCount > 0;
          return (
            <div className="dk-season" key={s.seasonNumber}>
              <Poster src={tmdbImage(s.posterUrl ?? row.posterUrl, 'profile')} title={seasonName(s)} />
              <div>
                <div className="dk-season__name">{seasonName(s)}</div>
                <div className="dk-season__meta">{t('discover.title.episodeCount', { count: s.episodeCount })}</div>
              </div>
              <div className="dk-season__chips">
                {labels.length ? labels.map((l) => <StatusLabelChip key={l} label={l} />) : <StatusLabelChip label={MEDIA_STATUS_META.unknown.label} />}
              </div>
              {open ? (
                <Button size="sm" onClick={() => onRequest(s.seasonNumber)} aria-label={t('discover.title.requestSeason', { season: seasonName(s) })}>
                  {t('common.request')}
                </Button>
              ) : (
                <span />
              )}
            </div>
          );
        })}
      </div>
    </section>
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

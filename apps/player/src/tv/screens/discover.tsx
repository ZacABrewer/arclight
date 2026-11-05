import { useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { Link, Navigate, useParams } from '@tanstack/react-router';
import type { DiscoverItem, TitleDetail } from '@arclight/shared';
import { useT } from '@web/i18n/index';
import { artBackground } from '@web/features/player/redesign/placeholder';
import { useVideoActions } from '../actions';
import { metaItems, type Translate } from '../format';
import { HeroTitle, Kicker, MetaLine, Row, SkeletonRow, WideTile } from '../tiles';
import { HOME_PATH } from '../tv-runtime';
import {
  DISCOVER_ROW_MAX,
  DISCOVER_ROWS,
  REQUESTS_PATH,
  STATE_KEYS,
  discoverState,
  libraryTarget,
  requestErrorText,
  requestable,
  stateTone,
  useCanRequest,
  useCreateRequest,
  discoverRowQuery,
  useDiscoverTitle,
  useOpenDiscover,
  type DiscoverRowId,
} from '../requests';
import { tvRuntime } from '../tv-runtime';

// Discover (the request portal's discover page at stage size): a headline with My requests, then
// rows of 2:3 posters (Trending, Popular movies, Popular TV, Upcoming), each badged with what the
// server knows about it (in the library, on its way, requested, declined). OK opens the title
// page: backdrop, title, meta, blurb and Request (a show: every season the library lacks), or Open
// in library when it is there. Only for accounts that may request; the header hides the tab too.

const ROW_KEYS: Record<DiscoverRowId, string> = {
  trending: 'app.tv.discover.row.trending',
  popularMovies: 'app.tv.discover.row.popularMovies',
  popularTv: 'app.tv.discover.row.popularTv',
  upcomingMovies: 'app.tv.discover.row.upcomingMovies',
  upcomingTv: 'app.tv.discover.row.upcomingTv',
};

/** A discover tile's sub: "Movie · 2026" / "Series". */
export function discoverSub(item: Pick<DiscoverItem, 'mediaType' | 'year'>, t: Translate): string {
  return [t(item.mediaType === 'movie' ? 'app.tv.movie' : 'app.tv.series'), item.year ? String(item.year) : null].filter(Boolean).join(' · ');
}

/** One discover result as a poster tile, its status as the badge. */
export function DiscoverTile({ item, prefix, onOpen }: { item: DiscoverItem; prefix: string; onOpen: (item: DiscoverItem) => void }) {
  const t = useT();
  const state = discoverState(item);
  return (
    <WideTile
      id={`${prefix}-${item.mediaType}:${item.tmdbId}`}
      title={item.title}
      sub={discoverSub(item, t)}
      art={item.posterUrl ?? item.backdropUrl}
      poster
      badge={state ? t(STATE_KEYS[state]).toUpperCase() : null}
      badgeTone={stateTone(state)}
      label={[item.title, discoverSub(item, t), state ? t(STATE_KEYS[state]) : null].filter(Boolean).join(', ')}
      onOpen={() => onOpen(item)}
    />
  );
}

export function TvDiscoverScreen() {
  const t = useT();
  const allowed = useCanRequest();
  const open = useOpenDiscover();
  const rows = useQueries({ queries: DISCOVER_ROWS.map((row) => ({ ...discoverRowQuery(row), enabled: allowed })) });
  if (!allowed) return <Navigate to={HOME_PATH} replace />;
  // Every row failing (TMDB not set up, the server down) is one message, not a blank page.
  const allFailed = rows.every((q) => q.isError);
  const firstError = allFailed ? rows[0]?.error : null;
  return (
    <div className="tv-scroll-y" data-tv-scroll="y">
      <div className="tv-rows-page tv-dsc">
        <div className="tv-dsc__head" data-tv-row="">
          <div className="tv-dsc__titles">
            <h1 className="tv-h1">{t('app.tv.tab.discover')}</h1>
            <p className="tv-dsc__intro">{t('app.tv.discover.intro')}</p>
          </div>
          <Link to={REQUESTS_PATH} className="tv-btn tv-btn--secondary" data-tv-key="dsc-requests" data-tv-r="8">
            {t('app.tv.requests.title')}
          </Link>
        </div>
        <div className="tv-rows">
          {allFailed ? (
            <div className="tv-state" data-tv-row="" role="alert">
              <div className="tv-state__title">{t('app.tv.discover.failed')}</div>
              <div className="tv-state__text">{firstError instanceof Error && firstError.message ? firstError.message : t('app.tv.discover.failedText')}</div>
              <div className="tv-btns">
                <button type="button" className="tv-btn tv-btn--secondary" data-tv-key="dsc-retry" data-tv-r="8" onClick={() => void Promise.all(rows.map((q) => q.refetch()))}>
                  {t('app.tv.tryAgain')}
                </button>
              </div>
            </div>
          ) : (
            DISCOVER_ROWS.map((row, i) => {
              const q = rows[i];
              if (!q || q.isPending) return <SkeletonRow key={row} count={7} />;
              const items = q.data?.results.slice(0, DISCOVER_ROW_MAX) ?? [];
              // A row that failed on its own, or has nothing, is left out (as on Home).
              if (!items.length) return null;
              return (
                <div key={row} className="tv-dsc__row">
                  <Row title={t(ROW_KEYS[row])}>
                    {items.map((it) => (
                      <DiscoverTile key={`${it.mediaType}:${it.tmdbId}`} item={it} prefix={`dsc-${row}`} onOpen={open} />
                    ))}
                  </Row>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

/** The title page's buttons and status line for a discover result. */
export function TitleActions({ title, t }: { title: TitleDetail; t: Translate }) {
  const create = useCreateRequest();
  const { openTitle } = useVideoActions();
  const [sent, setSent] = useState<string | null>(null);
  const state = discoverState(title);
  const lib = libraryTarget(title);
  const canAsk = title.canRequest && requestable(title) && !sent;
  const series = title.mediaType === 'series';
  const request = () => {
    if (create.isPending) return;
    setSent(null);
    create.mutate(
      { mediaType: title.mediaType, tmdbId: title.tmdbId },
      {
        onSuccess: (out) => {
          setSent(out.kind === 'accepted' ? out.message : t('app.tv.request.sent'));
          // The Request button goes away with the request made: hand focus to My requests.
          const my = document.querySelector<HTMLElement>('[data-tv-key="dsc-my"]');
          const rt = tvRuntime();
          if (my && rt) rt.focus.focus(my);
          else my?.focus();
        },
      },
    );
  };
  // What there is to say besides the buttons: the title's state, or why there is no Request.
  const note = sent ?? (state && state !== 'partial' && state !== 'available' ? t(STATE_KEYS[state]) : !title.canRequest && requestable(title) ? t('app.tv.request.notAllowed') : null);
  return (
    <>
      <div className="tv-btns" data-tv-row="" data-tv-ytop="">
        {lib ? (
          <button type="button" className="tv-btn tv-btn--primary" data-tv-key="dsc-open" data-tv-autofocus="" onClick={() => openTitle(lib.kind, lib.id)}>
            {t('app.tv.discover.openInLibrary')}
          </button>
        ) : null}
        {canAsk ? (
          <button
            type="button"
            className={`tv-btn ${lib ? 'tv-btn--secondary' : 'tv-btn--primary'}`}
            data-tv-key="dsc-request"
            data-tv-autofocus={lib ? undefined : ''}
            aria-disabled={create.isPending || undefined}
            onClick={request}
          >
            <span className="tv-btn__icon" aria-hidden="true">
              +
            </span>
            {create.isPending ? t('app.tv.request.sending') : t(state === 'partial' ? 'app.tv.request.missing' : series ? 'app.tv.request.allSeasons' : 'app.tv.request.button')}
          </button>
        ) : null}
        <Link to={REQUESTS_PATH} className="tv-btn tv-btn--secondary tv-btn--tight" data-tv-key="dsc-my" data-tv-autofocus={!lib && !canAsk ? '' : undefined}>
          {t('app.tv.requests.title')}
        </Link>
      </div>
      {note ? (
        <div className={`tv-dsc__note${stateTone(sent ? 'requested' : state) ? ` tv-dsc__note--${stateTone(sent ? 'requested' : state)}` : ''}`} role="status">
          <span className="tv-dsc__dot" aria-hidden="true" />
          {note}
        </div>
      ) : null}
      {create.isError ? (
        <p className="tv-dsc__error" role="alert">
          {requestErrorText(create.error, t)}
        </p>
      ) : null}
    </>
  );
}

export function TvDiscoverTitleScreen() {
  const t = useT();
  const allowed = useCanRequest();
  const { kind, tmdbId } = useParams({ strict: false }) as { kind?: string; tmdbId?: string };
  const k = kind === 'tv' ? 'tv' : 'movie';
  const q = useDiscoverTitle(k, Number(tmdbId));
  if (!allowed) return <Navigate to={HOME_PATH} replace />;
  if (q.isError) {
    return (
      <div className="tv-browse">
        <div className="tv-state" data-tv-row="" role="alert">
          <div className="tv-state__title">{t('app.tv.discover.titleFailed')}</div>
          {q.error instanceof Error && q.error.message ? <div className="tv-state__text">{q.error.message}</div> : null}
          <div className="tv-btns">
            <button type="button" className="tv-btn tv-btn--secondary" data-tv-key="dsc-retry" data-tv-autofocus="" data-tv-r="8" onClick={() => void q.refetch()}>
              {t('app.tv.tryAgain')}
            </button>
          </div>
        </div>
      </div>
    );
  }
  const d = q.data;
  if (!d) return null;
  const genres = d.genres.map((g) => g.name);
  const seasonCount = d.mediaType === 'series' ? d.seasons.filter((s) => s.seasonNumber > 0).length : null;
  return (
    <div className="tv-scroll-y" data-tv-scroll="y">
      <div className="tv-detail tv-dsc-title">
        <div className="tv-detail__bg" style={{ background: artBackground(d.backdropUrl ?? d.posterUrl, d.title) }} aria-hidden="true">
          <div className="tv-detail__shade" />
        </div>
        <div className="tv-detail__content">
          <Kicker>{[t(d.mediaType === 'series' ? 'app.tv.series' : 'app.tv.movie'), genres.slice(0, 3).join(', ')].filter(Boolean).join(' · ')}</Kicker>
          <HeroTitle title={d.title} logoUrl={null} />
          <MetaLine items={metaItems({ year: d.year ?? null, certification: d.certification ?? null, runtimeMinutes: d.runtimeMinutes ?? null, seasonCount, genres: [] }, t)} />
          {d.overview ? <p className="tv-blurb">{d.overview}</p> : null}
          <TitleActions title={d} t={t} />
        </div>
      </div>
    </div>
  );
}

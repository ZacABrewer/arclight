import { useEffect, useRef, useState } from 'react';
import type { PlayerEpisode, PlayerMovieDetails, PlayerSeriesDetails, PlayerVideoVersion, VideoWatchedRequest } from '@arclight/shared';
import { cx } from '../../../../arclight/cx.js';
import { useT } from '../../../../i18n/index.js';
import { useNumericParam } from '../../browse/kit.js';
import { useMarkWatched, useMovie, useShow } from '../../video/api.js';
import { resumePoint } from '../../video/format.js';
import { seasonTitle } from '../../video/show-page.js';
import { useOpenVideo } from '../../video/video-launcher.js';
import { RdIcon } from '../icons.js';
import { useLayout } from '../layout.js';
import { MetaLine, useRuntimeLabel } from '../meta-line.js';
import { MyListButton } from '../my-list-button.js';
import { artBackground } from '../placeholder.js';
import { Row } from '../row.js';
import { BottomSheet } from '../sheet.js';
import { Art, ProgressBar, WideTile } from '../tiles.js';
import { RdError, RdLoading, RdPage, minutesLeft, shareOf, useCardActions, useCardSubs } from './common.js';

// Movie and series detail (the template's Detail screen; spec §4.4 portrait, §4.5 wide).
// Wide: the backdrop under the header, kicker "Series · genres", title, meta line with chips,
// blurb, Play / Start over / My List, then Episodes (season chips and 300 px cards) or More
// like this. Portrait: 16:9 backdrop, full-width Play, three icon actions, a 4-line blurb with
// More, season chips and 128x72 episode rows. Both have a small "more" menu with Mark watched /
// unwatched and, when the title has more than one file, Versions (which file Play starts).

interface PlayTarget {
  itemKey: string;
  resumeMs: number | null;
  share: number;
  leftMin: number;
  season: number | null;
  episode: number | null;
}

function findEpisode(show: PlayerSeriesDetails, itemKey: string | null): PlayerEpisode | null {
  if (!itemKey) return null;
  for (const s of show.seasons) for (const e of s.episodes) if (e.itemKey === itemKey) return e;
  return null;
}

function seriesTarget(show: PlayerSeriesDetails): PlayTarget | null {
  const first = show.seasons.find((s) => s.seasonNumber > 0 && s.episodes.length)?.episodes[0] ?? show.seasons[0]?.episodes[0] ?? null;
  const e = findEpisode(show, show.nextUp) ?? first;
  if (!e) return null;
  const durMs = (e.runtimeMinutes ?? 0) * 60_000;
  const resumeMs = e.played ? null : resumePoint(e.progress, durMs);
  return { itemKey: e.itemKey, resumeMs, share: resumeMs !== null ? shareOf(e.progress) : 0, leftMin: minutesLeft(e.progress), season: e.seasonNumber, episode: e.episodeNumber };
}

function movieTarget(movie: PlayerMovieDetails): PlayTarget {
  const resumeMs = movie.played ? null : resumePoint(movie.progress, (movie.runtimeMinutes ?? 0) * 60_000);
  return { itemKey: movie.itemKey, resumeMs, share: resumeMs !== null ? shareOf(movie.progress) : 0, leftMin: minutesLeft(movie.progress), season: null, episode: null };
}

function usePlayText() {
  const t = useT();
  return (target: PlayTarget) => {
    const resume = target.resumeMs !== null;
    if (target.season !== null && target.episode !== null) return t(resume ? 'player.redesign.resumeEpisode' : 'player.redesign.playEpisode', { season: target.season, episode: target.episode });
    return t(resume ? 'player.redesign.resume' : 'player.redesign.play');
  };
}

/** /player/watch/movies/$id */
export function RdMoviePage() {
  const t = useT();
  const id = useNumericParam('id');
  const q = useMovie(id);
  if (Number.isNaN(id)) return <NotFound />;
  if (q.isPending) return <RdPage><RdLoading /></RdPage>;
  if (q.isError) return <RdPage><RdError title={t('player.video.movieFailed')} error={q.error} onRetry={() => void q.refetch()} /></RdPage>;
  return <MovieDetail movie={q.data} />;
}

/** /player/watch/shows/$id */
export function RdShowPage() {
  const t = useT();
  const id = useNumericParam('id');
  const q = useShow(Number.isNaN(id) ? null : id);
  if (Number.isNaN(id)) return <NotFound />;
  if (q.isPending) return <RdPage><RdLoading /></RdPage>;
  if (q.isError) return <RdPage><RdError title={t('player.video.showFailed')} error={q.error} onRetry={() => void q.refetch()} /></RdPage>;
  return <SeriesDetail show={q.data} />;
}

function NotFound() {
  const t = useT();
  return (
    <RdPage>
      <div className="rd-empty">
        <p className="rd-empty__title">{t('player.video.notFound')}</p>
      </div>
    </RdPage>
  );
}

function useDocTitle(title: string) {
  const t = useT();
  useEffect(() => {
    document.title = `${title} · ${t('player.documentTitle')}`;
  }, [title, t]);
}

interface DetailFrameProps {
  kind: 'movie' | 'series';
  id: number;
  title: string;
  logoUrl: string | null;
  backdropUrl: string | null;
  posterUrl: string | null;
  genres: readonly string[];
  meta: React.ReactNode;
  overview: string | null;
  target: PlayTarget | null;
  inMyList: boolean;
  /** Whether the title counts as watched (series: every episode), for Mark watched / unwatched. */
  played: boolean;
  /** What Mark watched / unwatched sends (`played` is filled in). */
  markTarget: Omit<VideoWatchedRequest, 'played'>;
  /** Every file version, best first (movies); the menu offers a choice when there are two or more. */
  versions?: readonly PlayerVideoVersion[] | undefined;
  /** Portrait: the Episodes action scrolls here. */
  episodesRef?: React.RefObject<HTMLElement | null> | undefined;
  children?: React.ReactNode;
}

function DetailTitle({ title, logoUrl, className }: { title: string; logoUrl: string | null; className: string }) {
  const [failed, setFailed] = useState(false);
  if (logoUrl && !failed) {
    return (
      <h1 className={cx(className, 'rd-detail__logo')}>
        <img src={logoUrl} alt={title} onError={() => setFailed(true)} />
      </h1>
    );
  }
  return <h1 className={className}>{title}</h1>;
}

function DetailFrame(p: DetailFrameProps) {
  const t = useT();
  const layout = useLayout();
  const open = useOpenVideo();
  const playText = usePlayText();
  const runtime = useRuntimeLabel();
  const [more, setMore] = useState(false);
  const versions = p.versions ?? [];
  const [versionId, setVersionId] = useState<number | null>(versions[0]?.mediaFileId ?? null);
  useDocTitle(p.title);
  // A version is only passed on when there is a choice; otherwise the server plays its best file.
  const fileOpt = versions.length > 1 && versionId !== null ? { mediaFileId: versionId } : {};
  const play = () => p.target && open(p.target.itemKey, p.target.resumeMs !== null ? { startMs: p.target.resumeMs, ...fileOpt } : { restart: true, ...fileOpt });
  const restart = () => p.target && open(p.target.itemKey, { restart: true, ...fileOpt });
  const moreMenu = <DetailMore layout={layout === 'portrait' ? 'portrait' : 'wide'} title={p.title} played={p.played} markTarget={p.markTarget} versions={versions} versionId={versionId} onVersion={setVersionId} />;
  const kicker = [p.kind === 'series' ? t('player.redesign.detail.series') : t('player.redesign.detail.movie'), p.genres.join(', ')].filter(Boolean).join(' · ');
  const art = artBackground(p.backdropUrl ?? p.posterUrl, p.title);
  const hasProgress = Boolean(p.target && p.target.resumeMs !== null);

  if (layout === 'portrait') {
    return (
      <RdPage className="rd-detail rd-detail--portrait">
        <div className="rd-detail__art" style={{ background: art }} aria-hidden="true">
          <span className="rd-detail__fade" />
        </div>
        <div className="rd-detail__body">
          <DetailTitle title={p.title} logoUrl={p.logoUrl} className="rd-detail__title" />
          {p.meta}
          {p.target ? (
            <button type="button" className="rd-btn rd-btn--primary rd-btn--block" onClick={play}>
              <RdIcon name="play" size={18} />
              {playText(p.target)}
            </button>
          ) : null}
          {hasProgress && p.target ? (
            <div className="rd-resume">
              <ProgressBar value={p.target.share} className="rd-resume__bar" />
              <span>{t('player.redesign.timeLeft', { time: runtime(p.target.leftMin) })}</span>
            </div>
          ) : null}
          <div className="rd-actions">
            {hasProgress ? (
              <button type="button" className="rd-action" onClick={restart}>
                <RdIcon name="restart" />
                <span>{t('player.redesign.startOver')}</span>
              </button>
            ) : null}
            <MyListButton kind={p.kind} id={p.id} inList={p.inMyList} variant="stacked" />
            {p.kind === 'series' && p.episodesRef ? (
              <button type="button" className="rd-action" onClick={() => p.episodesRef?.current?.scrollIntoView({ block: 'start' })}>
                <RdIcon name="episodes" />
                <span>{t('player.redesign.detail.episodes')}</span>
              </button>
            ) : null}
            {moreMenu}
          </div>
          {p.overview ? (
            <div className="rd-detail__about">
              <p className={cx('rd-detail__blurb', !more && 'is-clamped')}>{p.overview}</p>
              {!more && p.overview.length > 180 ? (
                <button type="button" className="rd-linkbtn" aria-expanded={false} onClick={() => setMore(true)}>
                  {t('player.redesign.detail.more')}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        {p.children}
      </RdPage>
    );
  }

  return (
    <RdPage className="rd-detail rd-detail--wide">
      <div className="rd-detail__art" style={{ background: art }} aria-hidden="true">
        <span className="rd-detail__fade" />
      </div>
      <div className="rd-detail__body">
        <div className="rd-kicker">
          <span className="rd-kicker__dot" aria-hidden="true" />
          {kicker}
        </div>
        <DetailTitle title={p.title} logoUrl={p.logoUrl} className="rd-detail__title" />
        {p.meta}
        {p.overview ? <p className="rd-detail__blurb">{p.overview}</p> : null}
        <div className="rd-detail__buttons">
          {p.target ? (
            <button type="button" className="rd-btn rd-btn--primary" onClick={play}>
              <RdIcon name="play" size={18} />
              {playText(p.target)}
            </button>
          ) : null}
          {hasProgress ? (
            <button type="button" className="rd-btn rd-btn--secondary" onClick={restart}>
              {t('player.redesign.startOver')}
            </button>
          ) : null}
          <MyListButton kind={p.kind} id={p.id} inList={p.inMyList} />
          {moreMenu}
        </div>
        {hasProgress && p.target ? (
          <div className="rd-resume">
            <ProgressBar value={p.target.share} className="rd-resume__bar" />
            <span>{t('player.redesign.timeLeft', { time: runtime(p.target.leftMin) })}</span>
          </div>
        ) : null}
      </div>
      {p.children}
    </RdPage>
  );
}

interface DetailMoreProps {
  layout: 'wide' | 'portrait';
  title: string;
  played: boolean;
  markTarget: Omit<VideoWatchedRequest, 'played'>;
  versions: readonly PlayerVideoVersion[];
  versionId: number | null;
  onVersion: (id: number) => void;
}

/** The "more" menu next to the main actions: Mark watched / unwatched, then Versions (2+ files). */
function DetailMore({ layout, title, played, markTarget, versions, versionId, onVersion }: DetailMoreProps) {
  const t = useT();
  const mark = useMarkWatched();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const label = t('player.redesign.detail.moreActions');

  useEffect(() => {
    if (!open || layout !== 'wide') return undefined;
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        wrap.current?.querySelector<HTMLElement>('[aria-haspopup]')?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, layout]);

  const toggleWatched = () => {
    setOpen(false);
    mark.mutate({ ...markTarget, played: !played });
  };
  const pick = (id: number) => {
    onVersion(id);
    setOpen(false);
  };
  const wide = layout === 'wide';
  const item = wide ? 'rd-menu__item' : 'rd-sheet__item';
  const body = (
    <div className={wide ? 'rd-menu__list' : 'rd-sheet__list'}>
      <button type="button" className={item} role={wide ? 'menuitem' : undefined} disabled={mark.isPending} onClick={toggleWatched}>
        {wide ? <RdIcon name={played ? 'restart' : 'check'} /> : null}
        <span>{played ? t('player.video.markUnwatched') : t('player.video.markWatched')}</span>
      </button>
      {versions.length > 1 ? (
        <div className={wide ? 'rd-menu__group rd-menu__group--top' : 'rd-sheet__list'} role="group" aria-label={t('player.video.versions')}>
          <p className="rd-menu__heading">{t('player.video.versions')}</p>
          {versions.map((v) => {
            const on = v.mediaFileId === versionId;
            return (
              <button key={v.mediaFileId} type="button" className={cx(item, on && 'is-on')} role={wide ? 'menuitemradio' : 'radio'} aria-checked={on} onClick={() => pick(v.mediaFileId)}>
                <span>{v.label}</span>
                {on ? <RdIcon name="check" size={18} className="rd-menu__trail" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );

  if (!wide) {
    return (
      <>
        <button type="button" className="rd-action" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
          <RdIcon name="more" />
          <span>{t('player.redesign.detail.more')}</span>
        </button>
        <BottomSheet open={open} onClose={() => setOpen(false)} title={title}>
          {body}
        </BottomSheet>
      </>
    );
  }
  return (
    <div className="rd-avatarmenu" ref={wrap}>
      <button type="button" className="rd-btn rd-btn--secondary rd-btn--square" aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label} onClick={() => setOpen((v) => !v)}>
        <RdIcon name="more" />
      </button>
      {open ? (
        <div className="rd-menu rd-menu--start" role="menu" aria-label={label}>
          {body}
        </div>
      ) : null}
    </div>
  );
}

function MovieDetail({ movie }: { movie: PlayerMovieDetails }) {
  const t = useT();
  const subs = useCardSubs();
  const act = useCardActions();
  const similar = movie.similar ?? [];
  return (
    <DetailFrame
      kind="movie"
      id={movie.id}
      title={movie.title}
      logoUrl={movie.logoUrl}
      backdropUrl={movie.backdropUrl}
      posterUrl={movie.posterUrl}
      genres={movie.genres}
      meta={<MetaLine year={movie.year} cert={movie.certification} runtimeMinutes={movie.runtimeMinutes} genres={movie.genres} chips={movie.chips} />}
      overview={movie.overview}
      target={movieTarget(movie)}
      inMyList={movie.inMyList ?? false}
      played={movie.played}
      markTarget={{ itemKeys: [movie.itemKey] }}
      versions={movie.versions}
    >
      {similar.length ? (
        <div className="rd-detail__more">
          <Row title={t('player.redesign.detail.moreLikeThis')}>
            {similar.map((c) => {
              const sub = subs.plainSub(c);
              return <WideTile key={`${c.kind}:${c.id}`} title={c.title} sub={sub} image={c.backdropUrl ?? c.posterUrl} seed={c.title} href={act.href(c)} label={sub ? `${c.title}, ${sub}` : c.title} />;
            })}
          </Row>
        </div>
      ) : null}
    </DetailFrame>
  );
}

function SeriesDetail({ show }: { show: PlayerSeriesDetails }) {
  const target = seriesTarget(show);
  const episodesRef = useRef<HTMLElement | null>(null);
  const seasons = show.seasons.filter((s) => s.seasonNumber > 0).length;
  return (
    <DetailFrame
      kind="series"
      id={show.id}
      title={show.title}
      logoUrl={show.logoUrl}
      backdropUrl={show.backdropUrl}
      posterUrl={show.posterUrl}
      genres={show.genres}
      meta={<MetaLine year={show.year} cert={show.certification} seasons={seasons || show.seasons.length} genres={show.genres} chips={show.chips} />}
      overview={show.overview}
      target={target}
      inMyList={show.inMyList ?? false}
      played={show.episodeCount > 0 && show.playedCount >= show.episodeCount}
      markTarget={{ seriesId: show.id }}
      episodesRef={episodesRef}
    >
      <Episodes show={show} startSeason={target?.season ?? null} sectionRef={episodesRef} />
    </DetailFrame>
  );
}

function Episodes({ show, startSeason, sectionRef }: { show: PlayerSeriesDetails; startSeason: number | null; sectionRef: React.RefObject<HTMLElement | null> }) {
  const t = useT();
  const layout = useLayout();
  const open = useOpenVideo();
  const runtime = useRuntimeLabel();
  const [season, setSeason] = useState<number>(() => startSeason ?? show.seasons.find((s) => s.seasonNumber > 0)?.seasonNumber ?? show.seasons[0]?.seasonNumber ?? 1);
  const current = show.seasons.find((s) => s.seasonNumber === season) ?? show.seasons[0];
  if (!current) return null;
  const playEp = (e: PlayerEpisode) => {
    const at = e.played ? null : resumePoint(e.progress, (e.runtimeMinutes ?? 0) * 60_000);
    open(e.itemKey, at !== null ? { startMs: at } : { restart: true });
  };
  const epTitle = (e: PlayerEpisode) => t('player.redesign.detail.episodeTitle', { n: e.episodeNumber, title: e.title ?? t('player.redesign.detail.episodeN', { n: e.episodeNumber }) });
  const progress = (e: PlayerEpisode) => (e.played ? 1 : shareOf(e.progress));
  const portrait = layout === 'portrait';

  return (
    <section className="rd-episodes" ref={sectionRef} aria-labelledby="rd-episodes-title">
      <div className="rd-episodes__head">
        <h2 className="rd-episodes__title" id="rd-episodes-title">
          {t('player.redesign.detail.episodes')}
        </h2>
        {show.seasons.length > 1 ? (
          <div className="rd-chips rd-chips--small" role="group" aria-label={t('player.redesign.detail.seasons')}>
            {show.seasons.map((s) => (
              <button key={s.seasonNumber} type="button" className={cx('rd-chip', s.seasonNumber === season && 'is-on')} aria-pressed={s.seasonNumber === season} onClick={() => setSeason(s.seasonNumber)}>
                {seasonTitle(s)}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {portrait ? (
        <ol className="rd-eplist">
          {current.episodes.map((e) => (
            <li key={e.itemKey}>
              <button type="button" className="rd-eprow" onClick={() => playEp(e)}>
                <Art image={e.thumbUrl} seed={show.title} shift={e.episodeNumber * 14 + e.seasonNumber * 30} className="rd-eprow__art">
                  <span className="rd-ep__badge">{t('player.redesign.detail.badge', { n: e.episodeNumber })}</span>
                  <ProgressBar value={progress(e)} className="rd-tile__progress" />
                </Art>
                <span className="rd-eprow__text">
                  <span className="rd-ep__line">
                    <span className="rd-ep__title">{epTitle(e)}</span>
                    {e.runtimeMinutes ? <span className="rd-ep__mins">{runtime(e.runtimeMinutes)}</span> : null}
                  </span>
                  {e.overview ? <span className="rd-ep__desc">{e.overview}</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <Row title={seasonTitle(current)} className="rd-row--episodes">
          {current.episodes.map((e) => (
            <button key={e.itemKey} type="button" className="rd-ep" onClick={() => playEp(e)}>
              <Art image={e.thumbUrl} seed={show.title} shift={e.episodeNumber * 14 + e.seasonNumber * 30} className="rd-ep__art">
                <span className="rd-ep__badge">{t('player.redesign.detail.badge', { n: e.episodeNumber })}</span>
                <ProgressBar value={progress(e)} className="rd-tile__progress" />
              </Art>
              <span className="rd-ep__line">
                <span className="rd-ep__title">{epTitle(e)}</span>
                {e.runtimeMinutes ? <span className="rd-ep__mins">{runtime(e.runtimeMinutes)}</span> : null}
              </span>
              {e.overview ? <span className="rd-ep__desc">{e.overview}</span> : null}
            </button>
          ))}
        </Row>
      )}
    </section>
  );
}

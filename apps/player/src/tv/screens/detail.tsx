import { useEffect, useState, type ReactNode } from 'react';
import { useParams } from '@tanstack/react-router';
import type { MyListKey, PlayerEpisode, PlayerSeriesDetails, PlayerVideoVersion, VideoProgress, VideoWatchedRequest } from '@arclight/shared';
import { useT } from '@web/i18n/index';
import { useMarkWatched, useMovie, useShow } from '@web/features/player/video/api';
import { artBackground } from '@web/features/player/redesign/placeholder';
import { useToggleMyList } from '@web/features/player/redesign/api';
import { cardArt, useVideoActions } from '../actions';
import { fraction, left, leftLabel, metaItems, pct, playLabel, type Translate } from '../format';
import { TvPanel } from '../profile-parts';
import { HeroTitle, Kicker, MetaLine, PlayIcon, ProgressLine, WideTile } from '../tiles';

// Title detail (template "detail"): 560 px backdrop, kicker "Series · Drama, Thriller", title (or
// logo), meta line, blurb, Play / Resume, Start over (with progress), the My List toggle and the
// progress line. Series: the season chips (focusing one selects it) and the episode cards. Movie:
// More like this. A small "⋯" button opens Mark watched / unwatched and, with 2+ files, Versions.

/** The episode Play starts (series nextUp) and where it stands. */
export function nextUpOf(show: PlayerSeriesDetails): PlayerEpisode | null {
  if (!show.nextUp) return null;
  for (const s of show.seasons) for (const e of s.episodes) if (e.itemKey === show.nextUp) return e;
  return null;
}

function MyListButton({ inList, myKey, t }: { inList: boolean; myKey: MyListKey; t: Translate }) {
  const toggle = useToggleMyList();
  const [on, setOn] = useState(inList);
  useEffect(() => setOn(inList), [inList]);
  return (
    <button
      type="button"
      className="tv-btn tv-btn--secondary tv-btn--tight"
      data-tv-key="det-list"
      onClick={() => {
        const add = !on;
        setOn(add);
        toggle.mutate({ key: myKey, add }, { onError: () => setOn(!add) });
      }}
    >
      <span className={`tv-btn__icon${on ? ' tv-list-on' : ''}`} aria-hidden="true">
        {on ? '✓' : '+'}
      </span>
      {t(on ? 'app.tv.inMyList' : 'app.tv.myList')}
    </button>
  );
}

/** The "⋯" button and its panel: Mark watched / unwatched, then Versions when there are 2+ files. */
function MoreButton({
  title,
  played,
  markTarget,
  versions,
  versionId,
  onVersion,
  t,
}: {
  title: string;
  played: boolean;
  markTarget: Omit<VideoWatchedRequest, 'played'>;
  versions: readonly PlayerVideoVersion[];
  versionId: number | null;
  onVersion: (id: number) => void;
  t: Translate;
}) {
  const mark = useMarkWatched();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="tv-btn tv-btn--secondary tv-btn--tight" data-tv-key="det-more" aria-label={t('player.redesign.detail.moreActions')} onClick={() => setOpen(true)}>
        <span className="tv-btn__icon" aria-hidden="true">
          ⋯
        </span>
      </button>
      {open ? (
        <TvPanel label={title} onClose={() => setOpen(false)}>
          <div className="tv-more-menu">
            <h2 className="tv-profiles__title">{title}</h2>
            <div className="tv-more-menu__list">
              <button
                type="button"
                className="tv-opt"
                data-tv-key="more-watched"
                data-tv-autofocus=""
                disabled={mark.isPending}
                onClick={() => {
                  setOpen(false);
                  mark.mutate({ ...markTarget, played: !played });
                }}
              >
                <span className="tv-opt__text">
                  <span className="tv-opt__label">{played ? t('player.video.markUnwatched') : t('player.video.markWatched')}</span>
                </span>
              </button>
              {versions.length > 1 ? (
                <>
                  <p className="tv-more-menu__heading">{t('player.video.versions')}</p>
                  {versions.map((v) => {
                    const on = v.mediaFileId === versionId;
                    return (
                      <button
                        key={v.mediaFileId}
                        type="button"
                        className="tv-opt"
                        data-tv-key={`more-version-${v.mediaFileId}`}
                        role="radio"
                        aria-checked={on}
                        onClick={() => {
                          onVersion(v.mediaFileId);
                          setOpen(false);
                        }}
                      >
                        <span className="tv-opt__text">
                          <span className="tv-opt__label">{v.label}</span>
                          {v.description ? <span className="tv-opt__desc">{v.description}</span> : null}
                        </span>
                        {on ? (
                          <span className="tv-opt__choice" aria-hidden="true">
                            ✓
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </>
              ) : null}
            </div>
          </div>
        </TvPanel>
      ) : null}
    </>
  );
}

function Top({
  title,
  kind,
  genres,
  logoUrl,
  backdropUrl,
  meta,
  overview,
  playText,
  onPlay,
  onRestart,
  progress,
  inList,
  myKey,
  more,
  t,
}: {
  title: string;
  kind: 'movie' | 'series';
  genres: string[];
  logoUrl: string | null;
  backdropUrl: string | null;
  meta: ReturnType<typeof metaItems>;
  overview: string | null;
  playText: string;
  onPlay: () => void;
  onRestart: (() => void) | null;
  progress: VideoProgress | null;
  inList: boolean;
  myKey: MyListKey;
  more: ReactNode;
  t: Translate;
}) {
  const f = fraction(progress);
  const resumable = f !== null && f < 1 && !progress?.played;
  return (
    <>
      <div className="tv-detail__bg" style={{ background: artBackground(backdropUrl, title) }} aria-hidden="true">
        <div className="tv-detail__shade" />
      </div>
      <div className="tv-detail__content">
        <Kicker>{[t(kind === 'series' ? 'app.tv.series' : 'app.tv.movie'), genres.join(', ')].filter(Boolean).join(' · ')}</Kicker>
        <HeroTitle title={title} logoUrl={logoUrl} />
        <MetaLine items={meta} />
        {overview ? <p className="tv-blurb">{overview}</p> : null}
        <div className="tv-btns" data-tv-row="" data-tv-ytop="">
          <button type="button" className="tv-btn tv-btn--primary" data-tv-key="det-play" data-tv-autofocus="" onClick={onPlay}>
            <PlayIcon />
            {playText}
          </button>
          {resumable && onRestart ? (
            <button type="button" className="tv-btn tv-btn--secondary tv-btn--tight" data-tv-key="det-restart" onClick={onRestart}>
              {t('app.tv.startOver')}
            </button>
          ) : null}
          <MyListButton inList={inList} myKey={myKey} t={t} />
          {more}
        </div>
        <ProgressLine fraction={resumable ? f : null} label={leftLabel(progress, t)} />
      </div>
    </>
  );
}

export function TvMovieScreen() {
  const t = useT();
  const { id } = useParams({ strict: false }) as { id?: string };
  const movie = useMovie(Number(id));
  const { play, restart, openCard } = useVideoActions();
  const [versionId, setVersionId] = useState<number | null>(null);
  const m = movie.data;
  if (!m) return null;
  // A version is only passed on when there is a choice; otherwise the server plays its best file.
  const file = m.versions.length > 1 ? (versionId ?? m.versions[0]?.mediaFileId) : undefined;
  return (
    <div className="tv-scroll-y" data-tv-scroll="y">
      <div className="tv-detail">
        <Top
          title={m.title}
          kind="movie"
          genres={m.genres}
          logoUrl={m.logoUrl}
          backdropUrl={m.backdropUrl ?? m.posterUrl}
          meta={metaItems({ ...m, chips: m.chips ?? null }, t)}
          overview={m.overview}
          playText={playLabel('movie', { seasonNumber: null, episodeNumber: null, progress: m.progress }, t)}
          onPlay={() => play(m.itemKey, m.progress, file)}
          onRestart={() => restart(m.itemKey, file)}
          progress={m.progress}
          inList={Boolean(m.inMyList)}
          myKey={`movie:${m.id}`}
          more={<MoreButton title={m.title} played={m.played} markTarget={{ itemKeys: [m.itemKey] }} versions={m.versions} versionId={file ?? null} onVersion={setVersionId} t={t} />}
          t={t}
        />
        {m.similar?.length ? (
          <section className="tv-more" data-tv-row="">
            <h2 className="tv-row__title">{t('app.tv.row.moreLikeThis')}</h2>
            <div className="tv-scroll-x" data-tv-scroll="x">
              <div className="tv-row__track">
                {m.similar.map((c) => (
                  <WideTile key={`${c.kind}:${c.id}`} id={`mlt-${c.kind}:${c.id}`} title={c.title} art={cardArt(c)} onOpen={() => openCard(c)} />
                ))}
              </div>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

export function TvShowScreen() {
  const t = useT();
  const { id } = useParams({ strict: false }) as { id?: string };
  const show = useShow(Number(id));
  const { play, restart } = useVideoActions();
  const s = show.data;
  const next = s ? nextUpOf(s) : null;
  const seasons = s?.seasons.filter((x) => x.episodes.length) ?? [];
  const [season, setSeason] = useState<number | null>(null);
  // The template opens on the season of the place you are at.
  useEffect(() => {
    if (season === null && s) setSeason(next?.seasonNumber ?? seasons.find((x) => x.seasonNumber > 0)?.seasonNumber ?? seasons[0]?.seasonNumber ?? null);
  }, [s, next, season, seasons]);
  if (!s) return null;
  const current = seasons.find((x) => x.seasonNumber === season) ?? seasons[0];
  const first = seasons.find((x) => x.seasonNumber > 0)?.episodes[0] ?? seasons[0]?.episodes[0] ?? null;
  const target = next ?? first;
  const seasonCount = seasons.filter((x) => x.seasonNumber > 0).length;
  return (
    <div className="tv-scroll-y" data-tv-scroll="y">
      <div className="tv-detail">
        <Top
          title={s.title}
          kind="series"
          genres={s.genres}
          logoUrl={s.logoUrl}
          backdropUrl={s.backdropUrl ?? s.posterUrl}
          meta={metaItems({ year: s.year, certification: s.certification, seasonCount, genres: s.genres, chips: s.chips ?? null }, t)}
          overview={s.overview}
          playText={playLabel('series', target ? { seasonNumber: target.seasonNumber, episodeNumber: target.episodeNumber, progress: target.progress } : null, t)}
          onPlay={() => target && play(target.itemKey, target.progress)}
          onRestart={target ? () => restart(target.itemKey) : null}
          progress={target?.progress ?? null}
          inList={Boolean(s.inMyList)}
          myKey={`series:${s.id}`}
          more={<MoreButton title={s.title} played={s.episodeCount > 0 && s.playedCount >= s.episodeCount} markTarget={{ seriesId: s.id }} versions={[]} versionId={null} onVersion={() => undefined} t={t} />}
          t={t}
        />
        {current ? (
          <div className="tv-series">
            <div className="tv-seasons" data-tv-row="">
              <h2 className="tv-seasons__title">{t('app.tv.episodes')}</h2>
              {seasons.map((x) => (
                <button
                  key={x.seasonNumber}
                  type="button"
                  className="tv-chip"
                  data-tv-key={`season-${x.seasonNumber}`}
                  aria-pressed={x.seasonNumber === current.seasonNumber}
                  onFocus={() => setSeason(x.seasonNumber)}
                  onClick={() => setSeason(x.seasonNumber)}
                >
                  {x.seasonNumber === 0 ? t('app.video.specials') : t('app.video.season', { n: x.seasonNumber })}
                </button>
              ))}
            </div>
            <div data-tv-row="">
              <div className="tv-scroll-x" data-tv-scroll="x">
                <div className="tv-eps">
                  {current.episodes.map((e) => {
                    const f = e.played ? 1 : fraction(e.progress);
                    return (
                      <div key={e.itemKey} className="tv-ep">
                        <button
                          type="button"
                          className="tv-art"
                          data-tv-key={`ep-${e.itemKey}`}
                          style={{ background: artBackground(e.thumbUrl, `${s.title} ${e.seasonNumber} ${e.episodeNumber}`) }}
                          onClick={() => play(e.itemKey, e.progress)}
                          aria-label={`${e.episodeNumber}. ${e.title ?? ''}`}
                        >
                          <span className="tv-ep__badge">E{e.episodeNumber}</span>
                          {f ? (
                            <span className="tv-art__bar">
                              <span style={{ width: pct(f) }} />
                            </span>
                          ) : null}
                        </button>
                        <div className="tv-ep__head">
                          <span className="tv-ep__title">
                            {e.episodeNumber}. {e.title ?? t('app.video.episode', { n: e.episodeNumber })}
                          </span>
                          {e.runtimeMinutes ? <span className="tv-ep__mins">{left(e.runtimeMinutes * 60)}</span> : null}
                        </div>
                        {e.overview ? <div className="tv-ep__desc">{e.overview}</div> : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

import { useState } from 'react';
import type { PlayerEpisode, PlayerSeason, PlayerSeriesDetails } from '@arclight/shared';
import { Button, Icon, Tabs } from '../../../arclight/index.js';
import { t as translate, useT } from '../../../i18n/index.js';
import { formatDate } from '../../../i18n/format.js';
import { DetailsSkeleton, Empty, LoadError, PlayerLink, useNumericParam } from '../browse/kit.js';
import { useMarkWatched, useShow } from './api.js';
import { VideoArt } from './cards.js';
import { episodeCode, resumePoint, runtimeLabel, watchedShare } from './format.js';
import { VideoHero } from './movie-page.js';
import { useOpenVideo } from './video-launcher.js';
import { watchPaths } from './paths.js';
import './watch.css';

/** "Season 2" / "Specials", translated by number. */
export function seasonTitle(s: Pick<PlayerSeason, 'seasonNumber'>): string {
  return s.seasonNumber === 0 ? translate('player.video.specials') : translate('player.video.season', { n: s.seasonNumber });
}

/** /player/watch/shows/$id */
export function ShowDetailsPage() {
  const t = useT();
  const id = useNumericParam('id');
  const q = useShow(Number.isNaN(id) ? null : id);
  if (Number.isNaN(id)) return <div className="pb-page"><Empty title={t('player.video.notFound')} /></div>;
  if (q.isPending) return <DetailsSkeleton label={t('player.browse.loading')} />;
  if (q.isError)
    return (
      <div className="pb-page">
        <LoadError title={t('player.video.showFailed')} error={q.error} onRetry={() => void q.refetch()} />
      </div>
    );
  return <ShowDetails show={q.data} />;
}

function findEpisode(show: PlayerSeriesDetails, itemKey: string | null): PlayerEpisode | null {
  if (!itemKey) return null;
  for (const s of show.seasons) for (const e of s.episodes) if (e.itemKey === itemKey) return e;
  return null;
}

export function ShowDetails({ show }: { show: PlayerSeriesDetails }) {
  const t = useT();
  const open = useOpenVideo();
  const mark = useMarkWatched();
  const next = findEpisode(show, show.nextUp);
  const [season, setSeason] = useState<number>(() => next?.seasonNumber ?? show.seasons.find((s) => s.seasonNumber > 0)?.seasonNumber ?? show.seasons[0]?.seasonNumber ?? 1);
  const current = show.seasons.find((s) => s.seasonNumber === season) ?? show.seasons[0];
  const allPlayed = show.episodeCount > 0 && show.playedCount >= show.episodeCount;
  const meta = [show.year, show.network, show.certification, show.rating !== null ? `★ ${show.rating.toFixed(1)}` : null].filter(Boolean);
  const nextResume = next ? resumePoint(next.progress, (next.runtimeMinutes ?? 0) * 60_000) : null;

  return (
    <div className="pb-page vw-details">
      <p className="vw-back">
        <PlayerLink to={watchPaths.shows} className="al-link">
          <Icon name="chevronLeft" size={16} /> {t('player.video.nav.shows')}
        </PlayerLink>
      </p>
      <VideoHero backdropUrl={show.backdropUrl} posterUrl={show.posterUrl} logoUrl={show.logoUrl} title={show.title}>
        <p className="vw-meta">
          {meta.map((m, i) => (
            <span key={i}>{m}</span>
          ))}
          <span>{t('player.video.episodesWatched', { played: show.playedCount, count: show.episodeCount })}</span>
          {show.badges.map((b) => (
            <span key={b} className="vw-badge">
              {b}
            </span>
          ))}
        </p>
        {show.genres.length ? <p className="vw-genre-line">{show.genres.join(' · ')}</p> : null}
        <div className="vw-actions">
          {next ? (
            <Button
              variant="primary"
              size="lg"
              icon={<Icon name="play" />}
              autoFocus
              onClick={() => open(next.itemKey, nextResume !== null ? { startMs: nextResume } : { restart: true })}
            >
              {t(nextResume !== null ? 'player.video.resumeEpisode' : 'player.video.playEpisode', { code: episodeCode(next.seasonNumber, next.episodeNumber) })}
            </Button>
          ) : null}
          <Button size="lg" icon={<Icon name={allPlayed ? 'eye' : 'check'} />} aria-pressed={allPlayed} loading={mark.isPending} onClick={() => mark.mutate({ seriesId: show.id, played: !allPlayed })}>
            {allPlayed ? t('player.video.markShowUnwatched') : t('player.video.markShowWatched')}
          </Button>
        </div>
        {show.overview ? <p className="vw-overview">{show.overview}</p> : null}
      </VideoHero>

      {show.seasons.length === 0 ? (
        <Empty title={t('player.video.noEpisodes')} />
      ) : (
        <section className="vw-section" aria-label={t('player.video.episodes')}>
          {show.seasons.length > 1 ? (
            <Tabs
              aria-label={t('player.video.seasons')}
              value={String(season)}
              onChange={(v) => setSeason(Number(v))}
              tabs={show.seasons.map((s) => ({ id: String(s.seasonNumber), label: seasonTitle(s), count: s.episodeCount }))}
            />
          ) : null}
          {current ? <SeasonEpisodes show={show} season={current} nextUp={show.nextUp} /> : null}
        </section>
      )}
    </div>
  );
}

function SeasonEpisodes({ show, season, nextUp }: { show: PlayerSeriesDetails; season: PlayerSeason; nextUp: string | null }) {
  const t = useT();
  const mark = useMarkWatched();
  const seasonDone = season.episodeCount > 0 && season.playedCount >= season.episodeCount;
  return (
    <>
      <div className="vw-season-head">
        <h2 className="pb-shelf__title">{seasonTitle(season)}</h2>
        <span className="vw-count">{t('player.video.episodesWatched', { played: season.playedCount, count: season.episodeCount })}</span>
        <Button size="sm" variant="ghost" icon={<Icon name="check" />} aria-pressed={seasonDone} onClick={() => mark.mutate({ seriesId: show.id, seasonNumber: season.seasonNumber, played: !seasonDone })}>
          {seasonDone ? t('player.video.markSeasonUnwatched') : t('player.video.markSeasonWatched')}
        </Button>
      </div>
      <ol className="vw-episodes">
        {season.episodes.map((e) => (
          <EpisodeRow key={e.itemKey} episode={e} isNext={e.itemKey === nextUp} />
        ))}
      </ol>
    </>
  );
}

export function EpisodeRow({ episode: e, isNext }: { episode: PlayerEpisode; isNext: boolean }) {
  const t = useT();
  const open = useOpenVideo();
  const mark = useMarkWatched();
  const resumeAt = resumePoint(e.progress, (e.runtimeMinutes ?? 0) * 60_000);
  const title = e.title ?? t('player.video.episodeN', { n: e.episodeNumber });
  const code = episodeCode(e.seasonNumber, e.episodeNumber);
  const meta = [code, runtimeLabel(e.runtimeMinutes), e.airDate ? formatDate(e.airDate) : null].filter(Boolean).join(' · ');
  return (
    <li className="vw-episode" data-next={isNext || undefined}>
      <button
        type="button"
        className="vw-episode__play"
        aria-label={t(resumeAt !== null ? 'player.video.resumeNamed' : 'player.video.playNamed', { title: `${code} · ${title}` })}
        onClick={() => open(e.itemKey, resumeAt !== null ? { startMs: resumeAt } : { restart: true })}
      >
        <VideoArt src={e.thumbUrl} shape="wide" progress={watchedShare(e.progress, e.played)} />
        <span className="vw-episode__glyph" aria-hidden="true">
          <Icon name="play" size={20} />
        </span>
      </button>
      <div className="vw-episode__body">
        <p className="vw-episode__title">
          <span className="vw-episode__num">{e.episodeNumber}.</span> {title}
          {isNext ? <span className="vw-badge vw-badge--next">{t('player.video.upNextTag')}</span> : null}
        </p>
        <p className="vw-episode__meta">{meta}</p>
        {e.overview ? <p className="vw-episode__overview">{e.overview}</p> : null}
      </div>
      <button
        type="button"
        className="vw-episode__mark al-btn al-btn--ghost al-btn--icon"
        aria-pressed={e.played}
        aria-label={e.played ? t('player.video.markUnwatchedNamed', { title }) : t('player.video.markWatchedNamed', { title })}
        onClick={() => mark.mutate({ itemKeys: [e.itemKey], played: !e.played })}
      >
        <Icon name="check" />
      </button>
    </li>
  );
}

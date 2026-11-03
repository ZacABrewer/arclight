import { useState } from 'react';
import type { PlayerMovieDetails, PlayerVideoVersion } from '@arclight/shared';
import { Button, Icon } from '../../../arclight/index.js';
import { useT } from '../../../i18n/index.js';
import { formatBytes } from '../../../i18n/format.js';
import { DetailsSkeleton, Empty, LoadError, PlayerLink, useNumericParam } from '../browse/kit.js';
import { useMarkWatched, useMovie } from './api.js';
import { VideoArt } from './cards.js';
import { clock, languageName, resumePoint, runtimeLabel, watchedShare } from './format.js';
import { useOpenVideo } from './video-launcher.js';
import { watchPaths } from './paths.js';
import './watch.css';

/** Backdrop hero shared by the movie and show pages. */
export function VideoHero({
  backdropUrl,
  posterUrl,
  logoUrl,
  title,
  children,
}: {
  backdropUrl: string | null;
  posterUrl: string | null;
  logoUrl: string | null;
  title: string;
  children: React.ReactNode;
}) {
  const [logoFailed, setLogoFailed] = useState(false);
  return (
    <section className="vw-hero">
      {backdropUrl ? <img className="vw-hero__backdrop" src={backdropUrl} alt="" aria-hidden="true" /> : null}
      <div className="vw-hero__scrim" aria-hidden="true" />
      <div className="vw-hero__inner">
        <div className="vw-hero__poster">
          <VideoArt src={posterUrl} shape="poster" />
        </div>
        <div className="vw-hero__body">
          <h1 className="vw-hero__title">
            {logoUrl && !logoFailed ? <img className="vw-hero__logo" src={logoUrl} alt={title} onError={() => setLogoFailed(true)} /> : title}
          </h1>
          {children}
        </div>
      </div>
    </section>
  );
}

function languagesLine(codes: readonly string[]): string {
  return [...new Set(codes.map((c) => languageName(c) ?? c))].join(', ');
}

/** /player/watch/movies/$movieId */
export function MovieDetailsPage() {
  const t = useT();
  const id = useNumericParam('id');
  const q = useMovie(id);
  if (Number.isNaN(id)) return <div className="pb-page"><Empty title={t('player.video.notFound')} /></div>;
  if (q.isPending) return <DetailsSkeleton label={t('player.browse.loading')} />;
  if (q.isError)
    return (
      <div className="pb-page">
        <LoadError title={t('player.video.movieFailed')} error={q.error} onRetry={() => void q.refetch()} />
      </div>
    );
  return <MovieDetails movie={q.data} />;
}

export function MovieDetails({ movie }: { movie: PlayerMovieDetails }) {
  const t = useT();
  const open = useOpenVideo();
  const mark = useMarkWatched();
  const [versionId, setVersionId] = useState<number | null>(movie.versions[0]?.mediaFileId ?? null);
  const version: PlayerVideoVersion | undefined = movie.versions.find((v) => v.mediaFileId === versionId) ?? movie.versions[0];
  const resumeAt = resumePoint(movie.progress, (movie.runtimeMinutes ?? 0) * 60_000);
  const fileOpt = version && movie.versions.length > 1 ? { mediaFileId: version.mediaFileId } : {};
  const meta = [movie.year, runtimeLabel(movie.runtimeMinutes), movie.certification, movie.rating !== null ? `★ ${movie.rating.toFixed(1)}` : null].filter(Boolean);

  return (
    <div className="pb-page vw-details">
      <p className="vw-back">
        <PlayerLink to={watchPaths.movies} className="al-link">
          <Icon name="chevronLeft" size={16} /> {t('player.video.nav.movies')}
        </PlayerLink>
      </p>
      <VideoHero backdropUrl={movie.backdropUrl} posterUrl={movie.posterUrl} logoUrl={movie.logoUrl} title={movie.title}>
        <p className="vw-meta">
          {meta.map((m, i) => (
            <span key={i}>{m}</span>
          ))}
          {movie.badges.map((b) => (
            <span key={b} className="vw-badge">
              {b}
            </span>
          ))}
        </p>
        {movie.genres.length ? <p className="vw-genre-line">{movie.genres.join(' · ')}</p> : null}
        {resumeAt !== null ? (
          <div className="vw-resume-bar" aria-label={t('player.video.progressLabel', { percent: Math.round(watchedShare(movie.progress) * 100) })} role="img">
            <span style={{ width: `${Math.round(watchedShare(movie.progress) * 100)}%` }} />
          </div>
        ) : null}
        <div className="vw-actions">
          {resumeAt !== null ? (
            <>
              <Button variant="primary" size="lg" icon={<Icon name="play" />} onClick={() => open(movie.itemKey, { startMs: resumeAt, ...fileOpt })} autoFocus>
                {t('player.video.resumeAt', { time: clock(resumeAt) })}
              </Button>
              <Button size="lg" icon={<Icon name="refresh" />} onClick={() => open(movie.itemKey, { restart: true, ...fileOpt })}>
                {t('player.video.restart')}
              </Button>
            </>
          ) : (
            <Button variant="primary" size="lg" icon={<Icon name="play" />} onClick={() => open(movie.itemKey, { restart: true, ...fileOpt })} autoFocus>
              {t('player.video.play')}
            </Button>
          )}
          <Button
            size="lg"
            icon={<Icon name={movie.played ? 'eye' : 'check'} />}
            aria-pressed={movie.played}
            loading={mark.isPending}
            onClick={() => mark.mutate({ itemKeys: [movie.itemKey], played: !movie.played })}
          >
            {movie.played ? t('player.video.markUnwatched') : t('player.video.markWatched')}
          </Button>
        </div>
        {movie.overview ? <p className="vw-overview">{movie.overview}</p> : null}
      </VideoHero>

      {movie.versions.length > 1 ? (
        <section className="vw-section" aria-labelledby="vw-versions">
          <h2 className="pb-shelf__title" id="vw-versions">
            {t('player.video.versions')}
          </h2>
          <div className="vw-versions" role="radiogroup" aria-labelledby="vw-versions">
            {movie.versions.map((v) => (
              <button
                key={v.mediaFileId}
                type="button"
                role="radio"
                aria-checked={v.mediaFileId === version?.mediaFileId}
                className="vw-version"
                onClick={() => setVersionId(v.mediaFileId)}
              >
                <span className="vw-version__label">{v.label}</span>
                <span className="vw-version__detail">{[v.description, formatBytes(v.sizeBytes)].filter(Boolean).join(' · ')}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {version ? (
        <dl className="vw-facts">
          {version.audioLanguages.length ? (
            <div>
              <dt>{t('player.video.audio')}</dt>
              <dd>{languagesLine(version.audioLanguages)}</dd>
            </div>
          ) : null}
          {version.subtitleLanguages.length ? (
            <div>
              <dt>{t('player.video.subtitles')}</dt>
              <dd>{languagesLine(version.subtitleLanguages)}</dd>
            </div>
          ) : null}
          {movie.versions.length <= 1 && version.description ? (
            <div>
              <dt>{t('player.video.file')}</dt>
              <dd>{[version.label, version.description].join(' · ')}</dd>
            </div>
          ) : null}
          {movie.studio ? (
            <div>
              <dt>{t('player.video.studio')}</dt>
              <dd>{movie.studio}</dd>
            </div>
          ) : null}
          {movie.collection ? (
            <div>
              <dt>{t('player.video.collection')}</dt>
              <dd>{movie.collection}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}

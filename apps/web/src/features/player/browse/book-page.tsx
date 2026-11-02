import { Button, ButtonGroup, Icon, Meter } from '../../../arclight/index.js';
import { useT } from '../../../i18n/index.js';
import { useAudiobook, useMarkPlayed, useProgress } from './api.js';
import { clockTime, isInProgress, lengthLabel, names, progressShare, timeLeftLabel } from './format.js';
import { Artwork, DetailsSkeleton, Empty, LoadError, PlayerLink, playerPaths, useNumericParam } from './kit.js';
import { usePlayerActions } from './player-hooks.js';

/** /player/books/$bookId */
export function BookPage() {
  const t = useT();
  const id = useNumericParam('bookId');
  const q = useAudiobook(id);
  const live = useProgress(q.data ? [q.data.itemKey] : []);
  const mark = useMarkPlayed();
  const player = usePlayerActions();

  if (!Number.isFinite(id)) return <Empty title={t('player.browse.book.notFound')} />;
  if (q.isPending) return <DetailsSkeleton label={t('player.browse.loading')} />;
  if (q.isError) {
    return (
      <div className="pb-page">
        <LoadError title={t('player.browse.book.loadFailed')} error={q.error} onRetry={() => void q.refetch()} />
      </div>
    );
  }

  const book = q.data;
  // The progress endpoint is the freshest source (another device may have moved on).
  const progress = live.data?.get(book.itemKey) ?? book.progress;
  const share = progressShare(progress, book.durationMs);
  const resumable = isInProgress(progress);
  const finished = !!progress?.played;
  const current = player.currentItemKey === book.itemKey;
  const authors = names(book.authors);
  const narrators = names(book.narrators);

  return (
    <div className="pb-page">
      <section className="pb-hero" aria-labelledby="pb-book-title">
        <Artwork src={book.artworkUrl} alt={t('player.browse.book.cover', { title: book.title })} className="pb-hero__art" loading="eager" />
        <div className="pb-hero__body">
          <p className="pb-eyebrow">
            {book.seriesTitle
              ? book.seriesPosition
                ? t('player.browse.book.seriesPosition', { series: book.seriesTitle, position: book.seriesPosition })
                : book.seriesTitle
              : t('player.browse.book.kind')}
          </p>
          <h1 className="pb-title" id="pb-book-title">
            {book.title}
          </h1>
          <p className="pb-hero__line">{authors ? t('player.browse.book.by', { authors }) : t('player.browse.book.unknownAuthor')}</p>
          {narrators ? <p className="pb-muted">{t('player.browse.book.readBy', { narrators })}</p> : null}
          <p className="pb-hero__meta">
            <span>{lengthLabel(book.durationMs)}</span>
            {book.chapters.length ? <span>{t('player.browse.book.chapterCount', { count: book.chapters.length })}</span> : null}
          </p>
          {resumable || finished ? (
            <div className="pb-book-progress">
              <Meter value={Math.round(share * 100)} label={t('player.browse.book.progressLabel', { title: book.title })} />
              <span className="pb-muted al-num">{finished ? t('player.browse.book.finished') : timeLeftLabel(progress, book.durationMs)}</span>
            </div>
          ) : null}
          <ButtonGroup className="pb-hero__actions">
            <Button
              variant="primary"
              icon={<Icon name={current && player.playing ? 'pause' : 'play'} />}
              onClick={() => (current ? player.toggle() : player.playItem(book.itemKey))}
            >
              {current && player.playing ? t('player.browse.pause') : resumable ? t('player.browse.book.resume') : t('player.browse.play')}
            </Button>
            <Button
              variant="ghost"
              icon={<Icon name={finished ? 'refresh' : 'check'} />}
              loading={mark.isPending}
              onClick={() => mark.mutate({ itemKey: book.itemKey, played: !finished })}
            >
              {finished ? t('player.browse.book.markUnfinished') : t('player.browse.book.markFinished')}
            </Button>
          </ButtonGroup>
        </div>
      </section>

      {book.description ? (
        <section className="pb-section" aria-labelledby="pb-about">
          <h2 className="pb-section__title" id="pb-about">
            {t('player.browse.book.about')}
          </h2>
          <p className="pb-overview">{book.description}</p>
        </section>
      ) : null}

      {book.series.length > 1 && book.seriesTitle ? (
        <section className="pb-section" aria-labelledby="pb-series">
          <h2 className="pb-section__title" id="pb-series">
            {t('player.browse.book.inSeries', { series: book.seriesTitle })}
          </h2>
          <ol className="pb-series">
            {book.series.map((b) => (
              <li key={b.id} className="pb-series__item">
                <span className="pb-series__pos al-num">{b.seriesPosition ?? '·'}</span>
                {b.id === book.id ? (
                  <span aria-current="page" className="pb-series__here">
                    {b.title}
                  </span>
                ) : (
                  <PlayerLink to={playerPaths.book(b.id)}>{b.title}</PlayerLink>
                )}
                {b.progress?.played ? <span className="pb-muted">{t('player.browse.book.finished')}</span> : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <section className="pb-section" aria-labelledby="pb-chapters">
        <h2 className="pb-section__title" id="pb-chapters">
          {t('player.browse.book.chapters')}
        </h2>
        {book.chapters.length ? (
          <ol className="pb-chapters">
            {book.chapters.map((c, i) => {
              const pos = progress?.positionMs ?? -1;
              const here = !finished && pos >= c.startMs && pos < c.startMs + c.durationMs;
              return (
                <li key={`${c.startMs}-${i}`} className="pb-chapter" aria-current={here ? 'true' : undefined}>
                  <span className="pb-chapter__num al-num">{i + 1}</span>
                  <span className="pb-chapter__title">{c.title}</span>
                  <span className="pb-chapter__time al-num">{clockTime(c.durationMs)}</span>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="pb-muted">{t('player.browse.book.noChapters')}</p>
        )}
      </section>
    </div>
  );
}

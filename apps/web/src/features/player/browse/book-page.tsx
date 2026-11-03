import { useT } from '../../../i18n/index.js';
import { ProgressBar } from '../redesign/tiles.js';
import { RdError, RdLoading } from '../redesign/pages/common.js';
import { useAudiobook, useMarkPlayed, useProgress } from './api.js';
import { DownloadButton } from './download.js';
import { clockTime, isInProgress, lengthLabel, names, progressShare, timeLeftLabel } from './format.js';
import { PlayerLink, playerPaths, useNumericParam } from './kit.js';
import { usePlayerActions } from './player-hooks.js';
import { AudioDetail, AudioNotice, AudioPage, AudioSection, DetailAction, PrimaryAction } from './rd-audio.js';

/** /player/books/$bookId: the title page (progress under the buttons), about, the series and the chapters. */
export function BookPage() {
  const t = useT();
  const id = useNumericParam('bookId');
  const q = useAudiobook(id);
  const live = useProgress(q.data ? [q.data.itemKey] : []);
  const mark = useMarkPlayed();
  const player = usePlayerActions();

  if (!Number.isFinite(id)) {
    return (
      <AudioPage>
        <AudioNotice title={t('player.browse.book.notFound')} />
      </AudioPage>
    );
  }
  if (q.isPending) return <RdLoading />;
  if (q.isError) {
    return (
      <AudioPage>
        <RdError title={t('player.browse.book.loadFailed')} error={q.error} onRetry={() => void q.refetch()} />
      </AudioPage>
    );
  }

  const book = q.data;
  // The progress endpoint is the freshest source (another device may have moved on).
  const progress = live.data?.get(book.itemKey) ?? book.progress;
  const share = progressShare(progress, book.durationMs);
  const resumable = isInProgress(progress);
  const finished = !!progress?.played;
  const current = player.currentItemKey === book.itemKey;
  const playing = current && player.playing;
  const authors = names(book.authors);
  const narrators = names(book.narrators);
  const kicker = book.seriesTitle
    ? book.seriesPosition
      ? t('player.browse.book.seriesPosition', { series: book.seriesTitle, position: book.seriesPosition })
      : book.seriesTitle
    : t('player.browse.book.kind');

  return (
    <AudioDetail
      kicker={kicker}
      title={book.title}
      image={book.artworkUrl}
      lines={
        <>
          <p className="rd-music-detail__line">{authors ? t('player.browse.book.by', { authors }) : t('player.browse.book.unknownAuthor')}</p>
          {narrators ? <p className="rd-music-detail__meta">{t('player.browse.book.readBy', { narrators })}</p> : null}
          <p className="rd-music-detail__meta">
            <span>{lengthLabel(book.durationMs)}</span>
            {book.chapters.length ? <span>{t('player.browse.book.chapterCount', { count: book.chapters.length })}</span> : null}
          </p>
        </>
      }
      primary={
        <PrimaryAction
          label={playing ? t('player.browse.pause') : resumable ? t('player.browse.book.resume') : t('player.browse.play')}
          playing={playing}
          onClick={() => (current ? player.toggle() : player.playItem(book.itemKey))}
        />
      }
      actions={
        <>
          <DetailAction
            icon={finished ? 'restart' : 'check'}
            label={finished ? t('player.browse.book.markUnfinished') : t('player.browse.book.markFinished')}
            busy={mark.isPending}
            onClick={() => mark.mutate({ itemKey: book.itemKey, played: !finished })}
          />
          <DownloadButton itemKeys={[book.itemKey]} />
        </>
      }
      extra={
        resumable || finished ? (
          <div className="rd-book-progress">
            <span
              className="rd-book-progress__bar"
              role="meter"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(share * 100)}
              aria-label={t('player.browse.book.progressLabel', { title: book.title })}
            >
              <ProgressBar value={finished ? 1 : share} className="rd-book-progress__fill" />
            </span>
            <span className="rd-book-progress__text al-num">{finished ? t('player.browse.book.finished') : timeLeftLabel(progress, book.durationMs)}</span>
          </div>
        ) : null
      }
    >
      {book.description ? (
        <AudioSection title={t('player.browse.book.about')}>
          <p className="rd-book-about">{book.description}</p>
        </AudioSection>
      ) : null}

      {book.series.length > 1 && book.seriesTitle ? (
        <AudioSection title={t('player.browse.book.inSeries', { series: book.seriesTitle })}>
          <ol className="pb-series rd-book-series">
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
        </AudioSection>
      ) : null}

      <AudioSection title={t('player.browse.book.chapters')}>
        {book.chapters.length ? (
          <ol className="pb-chapters rd-book-chapters">
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
      </AudioSection>
    </AudioDetail>
  );
}

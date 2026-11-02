import { Link } from '@tanstack/react-router';
import type { ContinueResponse } from '@arclight/shared';
import { EmptyState, ErrorBlock, Pane, Skeleton, buttonClass, cx } from '../../../arclight/index.js';
import { errorMessage } from '../../../api/client.js';
import { t } from '../../../i18n/index.js';
import { useContinueListening } from '../api.js';
import { formatDuration } from '../format.js';
import { usePlayer } from '../player-context.js';
import { Artwork } from './parts.js';
import { PlayerIcon } from './player-icons.js';

/** /player: "Continue listening", then the way into each section. */
export function PlayerHome() {
  const cont = useContinueListening();
  return (
    <div className="pl-home">
      <section aria-labelledby="pl-continue-title">
        <h1 id="pl-continue-title" className="al-title-m pl-home__title">
          {t('player.home.continue')}
        </h1>
        {cont.isPending ? (
          <Skeleton lines={3} />
        ) : cont.isError ? (
          <ErrorBlock title={t('player.home.couldNotLoad')} onRetry={() => void cont.refetch()}>
            {errorMessage(cont.error)}
          </ErrorBlock>
        ) : cont.data.items.length === 0 ? (
          <Pane chamfer="tl" className="pl-card">
            <EmptyState title={t('player.home.emptyTitle')}>{t('player.home.emptyHelp')}</EmptyState>
          </Pane>
        ) : (
          <ul className="pl-continue">
            {cont.data.items.map((entry) => (
              <ContinueCard key={entry.item.itemKey} entry={entry} />
            ))}
          </ul>
        )}
      </section>
      <div className="pl-home__sections">
        <Link to={'/player/music' as '/player'} className={buttonClass({ variant: 'secondary', size: 'lg' })}>
          {t('player.nav.music')}
        </Link>
        <Link to={'/player/books' as '/player'} className={buttonClass({ variant: 'secondary', size: 'lg' })}>
          {t('player.nav.books')}
        </Link>
      </div>
    </div>
  );
}

function ContinueCard({ entry }: { entry: ContinueResponse['items'][number] }) {
  const { state, playItem, toggle } = usePlayer();
  const { item, progress } = entry;
  const current = state.current?.itemKey === item.itemKey;
  const duration = progress.durationMs > 0 ? progress.durationMs : item.durationMs;
  const pct = duration > 0 ? Math.min(100, Math.round((progress.positionMs / duration) * 100)) : 0;
  const playing = current && state.playing;
  return (
    <li className={cx('pl-continue__card', current && 'is-current')}>
      <Artwork url={item.artworkUrl} className="pl-continue__art" />
      <div className="pl-continue__text">
        <span className="pl-continue__title">{item.title}</span>
        {item.subtitle ? <span className="pl-continue__sub">{item.subtitle}</span> : null}
        <span className="pl-continue__left">{t('player.home.left', { time: formatDuration(Math.max(0, duration - progress.positionMs)) })}</span>
        <span className="pl-continue__bar" aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </span>
      </div>
      <button
        type="button"
        className="pl-btn pl-btn--primary"
        onClick={() => (current ? toggle() : void playItem(item.itemKey, { source: item.itemKey }))}
        aria-label={playing ? t('player.controls.pauseTitle', { title: item.title }) : t('player.home.resume', { title: item.title })}
      >
        <PlayerIcon name={playing ? 'pause' : 'play'} />
      </button>
    </li>
  );
}

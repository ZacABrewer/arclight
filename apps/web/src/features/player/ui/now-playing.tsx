import { useState, type DragEvent } from 'react';
import { Link } from '@tanstack/react-router';
import type { PlayableItem } from '@arclight/shared';
import { Button, EmptyState, Icon, Input, Pane, Select, Slider, SwitchButton, buttonClass, cx } from '../../../arclight/index.js';
import { t } from '../../../i18n/index.js';
import { useAddBookmark, useBookmarks, usePlayableItem, useRemoveBookmark } from '../api.js';
import { BOOK_SKIP_MS } from '../engine/media-session.js';
import { REPLAY_GAIN_MODES, type ReplayGainMode } from '../engine/gain.js';
import { SLEEP_PRESETS_MIN } from '../engine/sleep-timer.js';
import { chapterBounds } from '../engine/timeline.js';
import { SPEED_STEPS, formatClock, formatDuration, formatSpeed, streamBadge, timeLeftAtSpeed } from '../format.js';
import { usePlayer, type PlayerApi, type QueueEntry } from '../player-context.js';
import { Artwork, SeekBar } from './parts.js';
import { PlayerIcon } from './player-icons.js';

/** /player/now-playing: the full player, in music or audiobook mode. */
export function NowPlayingPage() {
  const player = usePlayer();
  const item = player.state.current;
  if (!item) {
    return (
      <Pane chamfer="tl" strong className="pl-card">
        <EmptyState
          title={t('player.nowPlaying.emptyTitle')}
          action={
            <Link to="/player" className={buttonClass({ variant: 'primary' })}>
              {t('player.nowPlaying.browse')}
            </Link>
          }
        >
          {player.state.loading ? t('player.nowPlaying.loading') : t('player.nowPlaying.emptyHelp')}
        </EmptyState>
      </Pane>
    );
  }
  return item.kind === 'audiobook' ? <BookView player={player} item={item} /> : <MusicView player={player} item={item} />;
}

function ErrorLine({ code }: { code: PlayerApi['state']['error'] }) {
  if (!code) return null;
  return (
    <p className="pl-error" role="alert">
      {t(`player.error.${code}`)}
    </p>
  );
}

function FormatBadge({ player }: { player: PlayerApi }) {
  const badge = streamBadge(player.state.stream);
  if (!badge) return null;
  return (
    <span className={cx('pl-badge', player.state.stream?.transcoded && 'pl-badge--transcode')} title={t('player.format.title')}>
      {badge}
    </span>
  );
}

// ------------------------------------------------------------------ music

function MusicView({ player, item }: { player: PlayerApi; item: PlayableItem }) {
  const { state } = player;
  const [panel, setPanel] = useState<'queue' | null>('queue');
  return (
    <div className="pl-np pl-np--music">
      <div className="pl-np__tint" aria-hidden="true" style={item.artworkUrl ? { backgroundImage: `url("${item.artworkUrl}")` } : undefined} />
      <section className="pl-np__main" aria-label={t('player.nowPlaying.title')}>
        <Artwork url={item.artworkUrl} className="pl-np__art" />
        <div className="pl-np__meta">
          <h1 className="pl-np__title">{item.title}</h1>
          {item.subtitle ? <p className="pl-np__sub">{item.subtitle}</p> : null}
          {item.context ? <p className="pl-np__context">{item.context}</p> : null}
          <FormatBadge player={player} />
        </div>
        <ErrorLine code={state.error} />
        <SeekBar
          endMs={state.durationMs}
          positionMs={state.positionMs}
          onSeek={player.seek}
          label={t('player.seek.label')}
          waveform={item.itemKey}
          className="pl-np__seek"
        />
        <div className="pl-np__times">
          <span>{formatClock(state.positionMs)}</span>
          <span>{formatClock(state.durationMs)}</span>
        </div>
        <div className="pl-transport">
          <button
            type="button"
            className={cx('pl-btn', state.shuffle && 'is-on')}
            aria-pressed={state.shuffle}
            onClick={player.toggleShuffle}
            aria-label={t('player.controls.shuffle')}
          >
            <PlayerIcon name="shuffle" />
          </button>
          <button type="button" className="pl-btn" onClick={player.previous} aria-label={t('player.controls.previous')}>
            <PlayerIcon name="previous" />
          </button>
          <PlayButton player={player} />
          <button type="button" className="pl-btn" onClick={player.next} aria-label={t('player.controls.next')}>
            <PlayerIcon name="next" />
          </button>
          <button
            type="button"
            className={cx('pl-btn', state.repeat !== 'off' && 'is-on')}
            onClick={player.cycleRepeat}
            aria-label={t(`player.controls.repeat.${state.repeat}`)}
            title={t(`player.controls.repeat.${state.repeat}`)}
          >
            <PlayerIcon name={state.repeat === 'one' ? 'repeatOne' : 'repeat'} />
          </button>
        </div>
        <div className="pl-np__tools">
          <VolumeControl player={player} />
          <label className="pl-inline-field">
            <span className="al-label">{t('player.replayGain.label')}</span>
            <Select
              value={state.replayGain}
              onChange={(e) => player.setReplayGain(e.currentTarget.value as ReplayGainMode)}
              options={REPLAY_GAIN_MODES.map((m) => ({ value: m, label: t(`player.replayGain.${m}`) }))}
            />
          </label>
          <button
            type="button"
            className={cx('pl-btn', panel === 'queue' && 'is-on')}
            aria-pressed={panel === 'queue'}
            aria-controls="pl-queue"
            onClick={() => setPanel(panel === 'queue' ? null : 'queue')}
            aria-label={t('player.queue.toggle')}
          >
            <PlayerIcon name="queue" />
          </button>
        </div>
      </section>
      {panel === 'queue' ? <QueuePanel player={player} /> : null}
    </div>
  );
}

function PlayButton({ player, large }: { player: PlayerApi; large?: boolean }) {
  const { state } = player;
  return (
    <button
      type="button"
      className={cx('pl-btn', 'pl-btn--primary', large && 'pl-btn--xl')}
      onClick={player.toggle}
      aria-label={state.playing ? t('player.controls.pause') : t('player.controls.play')}
      aria-busy={state.buffering || state.loading || undefined}
    >
      <PlayerIcon name={state.playing ? 'pause' : 'play'} size={large ? 28 : 24} />
    </button>
  );
}

function VolumeControl({ player }: { player: PlayerApi }) {
  const { state } = player;
  const shown = state.muted ? 0 : Math.round(state.volume * 100);
  return (
    <div className="pl-volume">
      <button
        type="button"
        className="pl-btn"
        aria-pressed={state.muted}
        onClick={player.toggleMute}
        aria-label={state.muted ? t('player.controls.unmute') : t('player.controls.mute')}
      >
        <PlayerIcon name={state.muted || state.volume === 0 ? 'mute' : 'volume'} />
      </button>
      <Slider
        value={shown}
        min={0}
        max={100}
        step={5}
        showValue={false}
        onChange={(v) => player.setVolume(v / 100)}
        aria-label={t('player.controls.volume')}
        className="pl-volume__slider"
      />
    </div>
  );
}

/** "Playing from": a readable name for the queue's source. */
function sourceLabel(source: string | null, item: PlayableItem | null): string | null {
  if (!source) return null;
  const [kind, id] = source.split(':');
  const n = Number(id);
  if (kind === 'album' && item?.albumId === n && item.context) return t('player.queue.fromNamed', { name: item.context });
  if (kind === 'audiobook' && item?.kind === 'audiobook') return t('player.queue.fromNamed', { name: item.title });
  switch (kind) {
    case 'album':
      return t('player.queue.fromAlbum');
    case 'artist':
      return t('player.queue.fromArtist');
    case 'playlist':
      return t('player.queue.fromPlaylist');
    case 'search':
      return t('player.queue.fromSearch');
    default:
      return null;
  }
}

/** The queue in play order: tap to play, drag (or the arrow buttons) to reorder, remove. */
export function QueuePanel({ player }: { player: PlayerApi }) {
  const { state } = player;
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const from = sourceLabel(state.source, state.current);
  const upcoming = state.queue.length - state.queueIndex - 1;
  const onDrop = (to: number) => (e: DragEvent) => {
    e.preventDefault();
    if (dragFrom !== null && dragFrom !== to) player.moveInQueue(dragFrom, to);
    setDragFrom(null);
  };
  return (
    <aside id="pl-queue" className="pl-queue" aria-label={t('player.queue.title')}>
      <header className="pl-queue__head">
        <div>
          <h2 className="al-label pl-queue__title">{t('player.queue.title')}</h2>
          {from ? <p className="pl-queue__from">{from}</p> : null}
        </div>
        <Button variant="ghost" size="sm" onClick={player.clearQueue} disabled={upcoming <= 0}>
          {t('player.queue.clear')}
        </Button>
      </header>
      <ol className="pl-queue__list">
        {state.queue.map((entry) => (
          <QueueRow
            key={`${entry.position}:${entry.itemKey}`}
            entry={entry}
            player={player}
            last={entry.position === state.queue.length - 1}
            dragging={dragFrom === entry.position}
            onDragStart={() => setDragFrom(entry.position)}
            onDragEnd={() => setDragFrom(null)}
            onDrop={onDrop(entry.position)}
          />
        ))}
      </ol>
      {state.queue.length === 0 ? <p className="pl-muted">{t('player.queue.empty')}</p> : null}
    </aside>
  );
}

function QueueRow({
  entry,
  player,
  last,
  dragging,
  onDragStart,
  onDragEnd,
  onDrop,
}: {
  entry: QueueEntry;
  player: PlayerApi;
  last: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDrop: (e: DragEvent) => void;
}) {
  // One request per row for now (see the report: a batch item endpoint would replace this).
  const item = usePlayableItem(entry.itemKey).data;
  const current = entry.position === player.state.queueIndex;
  const title = item?.title ?? t('player.queue.loadingItem');
  return (
    <li
      className={cx('pl-queue__row', current && 'is-current', dragging && 'is-dragging')}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      aria-current={current ? 'true' : undefined}
    >
      <span className="pl-queue__grip" aria-hidden="true">
        <Icon name="grip" size={16} />
      </span>
      <button type="button" className="pl-queue__play" onClick={() => player.playQueueIndex(entry.position)} aria-label={t('player.queue.playEntry', { title })}>
        <span className="pl-queue__name">{title}</span>
        {item?.subtitle ? <span className="pl-queue__sub">{item.subtitle}</span> : null}
      </button>
      <span className="pl-queue__actions">
        <button type="button" className="pl-btn pl-btn--sm" disabled={entry.position === 0} onClick={() => player.moveInQueue(entry.position, entry.position - 1)} aria-label={t('player.queue.moveUp', { title })}>
          <Icon name="arrowUp" size={16} />
        </button>
        <button type="button" className="pl-btn pl-btn--sm" disabled={last} onClick={() => player.moveInQueue(entry.position, entry.position + 1)} aria-label={t('player.queue.moveDown', { title })}>
          <Icon name="arrowDown" size={16} />
        </button>
        <button type="button" className="pl-btn pl-btn--sm" onClick={() => player.removeFromQueue(entry.position)} aria-label={t('player.queue.remove', { title })}>
          <Icon name="close" size={16} />
        </button>
      </span>
    </li>
  );
}

// ------------------------------------------------------------------ audiobook

function BookView({ player, item }: { player: PlayerApi; item: PlayableItem }) {
  const { state } = player;
  const [wholeBook, setWholeBook] = useState(false);
  const [drawer, setDrawer] = useState<'chapters' | 'bookmarks'>('chapters');
  const bookmarks = useBookmarks(item.itemKey).data ?? [];
  const chapter = state.chapterIndex >= 0 ? item.chapters[state.chapterIndex] : undefined;
  const bounds = chapterBounds(item.chapters, state.chapterIndex, item.durationMs);
  const scoped = !wholeBook && bounds !== null;
  const start = scoped ? bounds.startMs : 0;
  const end = scoped ? bounds.endMs : state.durationMs;
  const chapterLeft = timeLeftAtSpeed((bounds?.endMs ?? state.durationMs) - state.positionMs, state.speed);
  const bookLeft = timeLeftAtSpeed(state.durationMs - state.positionMs, state.speed);
  const pct = state.durationMs > 0 ? Math.floor((state.positionMs / state.durationMs) * 100) : 0;
  return (
    <div className="pl-np pl-np--book">
      <section className="pl-np__main pl-book" aria-label={t('player.nowPlaying.title')}>
        <div className="pl-book__head">
          <Artwork url={item.artworkUrl} className="pl-book__art" />
          <div className="pl-np__meta">
            <h1 className="pl-book__title">{item.title}</h1>
            {item.subtitle ? <p className="pl-np__sub">{item.subtitle}</p> : null}
            {item.context ? <p className="pl-np__context">{item.context}</p> : null}
            <FormatBadge player={player} />
          </div>
        </div>
        {chapter ? (
          <p className="pl-book__chapter">
            <span className="al-label">{t('player.book.chapterNumber', { n: state.chapterIndex + 1, total: item.chapters.length })}</span>
            <span className="pl-book__chapter-title">{chapter.title}</span>
          </p>
        ) : null}
        <ErrorLine code={state.error} />
        <SeekBar
          startMs={start}
          endMs={end}
          positionMs={state.positionMs}
          onSeek={player.seek}
          label={scoped ? t('player.seek.chapterLabel') : t('player.seek.bookLabel')}
          marks={bookmarks.map((b) => b.positionMs)}
          className="pl-book__seek"
        />
        <div className="pl-np__times">
          <span>{formatClock(state.positionMs - start)}</span>
          <span>{t('player.book.timeLeftShort', { time: formatClock(timeLeftAtSpeed(end - state.positionMs, state.speed)) })}</span>
        </div>
        <label className="pl-switch-row">
          <SwitchButton checked={wholeBook} onChange={setWholeBook} size="sm" aria-label={t('player.book.wholeBook')} />
          <span>{t('player.book.wholeBook')}</span>
        </label>
        <div className="pl-transport pl-transport--book">
          <button type="button" className="pl-btn" onClick={player.previousChapter} aria-label={t('player.controls.previousChapter')} disabled={item.chapters.length === 0}>
            <PlayerIcon name="previous" />
          </button>
          <button type="button" className="pl-btn pl-btn--lg" onClick={() => player.skip(-BOOK_SKIP_MS)} aria-label={t('player.controls.back30')}>
            <PlayerIcon name="back30" size={28} />
          </button>
          <PlayButton player={player} large />
          <button type="button" className="pl-btn pl-btn--lg" onClick={() => player.skip(BOOK_SKIP_MS)} aria-label={t('player.controls.forward30')}>
            <PlayerIcon name="forward30" size={28} />
          </button>
          <button type="button" className="pl-btn" onClick={player.nextChapter} aria-label={t('player.controls.nextChapter')} disabled={item.chapters.length === 0}>
            <PlayerIcon name="next" />
          </button>
        </div>
        <dl className="pl-book__stats">
          {chapter ? (
            <div>
              <dt className="al-label">{t('player.book.chapterLeft')}</dt>
              <dd>{formatDuration(chapterLeft)}</dd>
            </div>
          ) : null}
          <div>
            <dt className="al-label">{t('player.book.bookLeft')}</dt>
            <dd>{formatDuration(bookLeft)}</dd>
          </div>
          <div>
            <dt className="al-label">{t('player.book.progress')}</dt>
            <dd>{t('player.book.percent', { pct })}</dd>
          </div>
        </dl>
        <div className="pl-book__tools">
          <label className="pl-inline-field">
            <span className="al-label">{t('player.speed.label')}</span>
            <Select
              value={String(state.speed)}
              onChange={(e) => player.setSpeed(Number(e.currentTarget.value))}
              options={speedOptions(state.speed)}
            />
          </label>
          <SleepSelect player={player} />
          <VolumeControl player={player} />
        </div>
      </section>
      <aside className="pl-drawer" aria-label={t('player.book.drawer')}>
        <div className="pl-drawer__tabs" role="tablist" aria-label={t('player.book.drawer')}>
          <button type="button" role="tab" aria-selected={drawer === 'chapters'} className="pl-drawer__tab" onClick={() => setDrawer('chapters')}>
            {t('player.book.chapters')}
          </button>
          <button type="button" role="tab" aria-selected={drawer === 'bookmarks'} className="pl-drawer__tab" onClick={() => setDrawer('bookmarks')}>
            {t('player.book.bookmarks', { count: bookmarks.length })}
          </button>
        </div>
        {drawer === 'chapters' ? <ChapterList player={player} item={item} /> : <BookmarkList player={player} item={item} />}
      </aside>
    </div>
  );
}

function speedOptions(current: number) {
  const steps: number[] = [...SPEED_STEPS];
  if (!steps.includes(current)) steps.push(current);
  return steps.sort((a, b) => a - b).map((s) => ({ value: String(s), label: formatSpeed(s) }));
}

function SleepSelect({ player }: { player: PlayerApi }) {
  const timer = player.state.sleepTimer;
  const value = !timer ? 'off' : timer.kind === 'chapter' ? 'chapter' : String(timer.minutes);
  const options = [
    { value: 'off', label: t('player.sleep.off') },
    ...SLEEP_PRESETS_MIN.map((m) => ({ value: String(m), label: t('player.sleep.minutes', { m }) })),
    { value: 'chapter', label: t('player.sleep.endOfChapter') },
  ];
  return (
    <label className="pl-inline-field">
      <span className="al-label">
        {t('player.sleep.label')}
        {timer ? <span className="pl-sleep__left"> · {formatClock(timer.remainingMs)}</span> : null}
      </span>
      <Select
        value={value}
        options={options}
        onChange={(e) => {
          const v = e.currentTarget.value;
          player.setSleepTimer(v === 'off' ? null : v === 'chapter' ? { kind: 'chapter' } : { kind: 'minutes', minutes: Number(v) });
        }}
      />
    </label>
  );
}

function ChapterList({ player, item }: { player: PlayerApi; item: PlayableItem }) {
  if (item.chapters.length === 0) return <p className="pl-muted">{t('player.book.noChapters')}</p>;
  return (
    <ol className="pl-list">
      {item.chapters.map((c, i) => (
        <li key={`${i}:${c.startMs}`}>
          <button
            type="button"
            className={cx('pl-list__row', i === player.state.chapterIndex && 'is-current')}
            aria-current={i === player.state.chapterIndex ? 'true' : undefined}
            onClick={() => player.seek(c.startMs)}
          >
            <span className="pl-list__name">{c.title}</span>
            <span className="pl-list__time">{formatClock(c.durationMs)}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function BookmarkList({ player, item }: { player: PlayerApi; item: PlayableItem }) {
  const bookmarks = useBookmarks(item.itemKey);
  const add = useAddBookmark(item.itemKey);
  const remove = useRemoveBookmark(item.itemKey);
  const [note, setNote] = useState('');
  const list = [...(bookmarks.data ?? [])].sort((a, b) => a.positionMs - b.positionMs);
  return (
    <div className="pl-bookmarks">
      <form
        className="pl-bookmarks__add"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate({ itemKey: item.itemKey, positionMs: Math.floor(player.state.positionMs), note: note.trim() }, { onSuccess: () => setNote('') });
        }}
      >
        <Input value={note} onChange={(e) => setNote(e.currentTarget.value)} placeholder={t('player.bookmarks.notePlaceholder')} aria-label={t('player.bookmarks.note')} maxLength={2000} />
        <Button type="submit" icon={<PlayerIcon name="bookmark" size={16} />} loading={add.isPending}>
          {t('player.bookmarks.add', { time: formatClock(player.state.positionMs) })}
        </Button>
      </form>
      {list.length === 0 ? <p className="pl-muted">{t('player.bookmarks.empty')}</p> : null}
      <ol className="pl-list">
        {list.map((b) => (
          <li key={b.id} className="pl-list__item">
            <button type="button" className="pl-list__row" onClick={() => player.seek(b.positionMs)} aria-label={t('player.bookmarks.jump', { time: formatClock(b.positionMs) })}>
              <span className="pl-list__time">{formatClock(b.positionMs)}</span>
              <span className="pl-list__name">{b.note || t('player.bookmarks.untitled')}</span>
            </button>
            <button type="button" className="pl-btn pl-btn--sm" onClick={() => remove.mutate(b.id)} aria-label={t('player.bookmarks.remove', { time: formatClock(b.positionMs) })}>
              <Icon name="trash" size={16} />
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

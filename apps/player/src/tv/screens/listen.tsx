import { useQuery } from '@tanstack/react-query';
import type { PlayableChapter, PlayableItem, PlayerTrack } from '@arclight/shared';
import { useT } from '@web/i18n/index';
import { usePlayableItem } from '@web/features/player/api';
import { browseKeys, playerBrowseApi } from '@web/features/player/browse/api';
import { usePlayer, type PlayerApi } from '@web/features/player/player-context';
import { artBackground } from '../../kit/placeholder';
import { clock, left, pct, type Translate } from '../format';
import { PlayIcon } from '../tiles';

// Listen (template "listen"): the music and audiobook player on TV. Left: the art, ALBUM or
// AUDIOBOOK, the title, "artist · year" or "by … · Narrated by …", the current track or chapter
// with its bar and times, and the controls (previous / play-pause / next for music; −30 / +30
// and the time left in the book for audiobooks). Right: the tracks or chapters, the playing one in
// the accent colour. OK on a row plays it.

export const SKIP_MS = 30_000;
/** Music "previous": restart the track when more than this has played (the design's a()). */
export const RESTART_AFTER_MS = 3_000;

export interface ListenRow {
  key: string;
  n: number;
  title: string;
  durationMs: number;
  current: boolean;
  play: () => void;
}

/** Chapter rows for an audiobook on its whole-book timeline. */
export function chapterRows(chapters: readonly PlayableChapter[], chapterIndex: number, seek: (ms: number) => void): ListenRow[] {
  return chapters.map((c, i) => ({ key: `ch-${i}`, n: i + 1, title: c.title, durationMs: c.durationMs, current: i === chapterIndex, play: () => seek(c.startMs) }));
}

/** Where the bar stands: inside the chapter for books, inside the track for music. */
export function listenProgress(item: PlayableItem, positionMs: number, durationMs: number, chapterIndex: number): { pos: number; dur: number; title: string } {
  if (item.kind === 'audiobook') {
    const ch = item.chapters[chapterIndex];
    if (ch) {
      const next = item.chapters[chapterIndex + 1];
      const dur = (next ? next.startMs : ch.startMs + ch.durationMs) - ch.startMs;
      return { pos: Math.max(0, positionMs - ch.startMs), dur: Math.max(1, dur), title: ch.title };
    }
    return { pos: positionMs, dur: durationMs || item.durationMs, title: item.title };
  }
  return { pos: positionMs, dur: durationMs || item.durationMs, title: item.title };
}

function PauseIcon() {
  return (
    <span className="tv-pause" aria-hidden="true">
      <span />
      <span />
    </span>
  );
}

function PrevIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 2h2v12H2zM14 2L5 8l9 6z" fill="currentColor" />
    </svg>
  );
}

function NextIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M12 2h2v12h-2zM2 2l9 6-9 6z" fill="currentColor" />
    </svg>
  );
}

function Row({ r }: { r: ListenRow }) {
  return (
    <button type="button" className={`tv-li${r.current ? ' tv-li--current' : ''}`} data-tv-key={`li-${r.key}`} onClick={r.play}>
      <span className="tv-li__n">{r.n}</span>
      <span className="tv-li__title">{r.title}</span>
      <span className="tv-li__dur">{r.durationMs > 0 ? clock(r.durationMs) : ''}</span>
    </button>
  );
}

/** One queue entry; the title comes from the cached item (album tracks fill most of these). */
function QueueRow({ itemKey, n, current, play, known }: { itemKey: string; n: number; current: boolean; play: () => void; known: PlayerTrack | undefined }) {
  const q = usePlayableItem(known ? null : itemKey);
  const title = known?.title ?? q.data?.title ?? '';
  const durationMs = known?.durationMs ?? q.data?.durationMs ?? 0;
  return <Row r={{ key: `q-${n}`, n, title, durationMs, current, play }} />;
}

function MusicList({ player, tracks }: { player: PlayerApi; tracks: PlayerTrack[] }) {
  const byKey = new Map(tracks.map((tr) => [tr.itemKey, tr]));
  return (
    <>
      {player.state.queue.map((e, i) => (
        <QueueRow key={`${e.position}:${e.itemKey}`} itemKey={e.itemKey} n={i + 1} current={i === player.state.queueIndex} known={byKey.get(e.itemKey)} play={() => player.playQueueIndex(i)} />
      ))}
    </>
  );
}

function subLine(item: PlayableItem, t: Translate, extra: { year?: number | null | undefined; authors?: string[] | undefined; narrators?: string[] | undefined }): string {
  if (item.kind === 'audiobook') {
    const by = extra.authors?.length ? t('app.tv.listen.by', { names: extra.authors.join(', ') }) : item.subtitle ? t('app.tv.listen.by', { names: item.subtitle }) : null;
    const narr = extra.narrators?.length ? t('app.tv.listen.narratedBy', { names: extra.narrators.join(', ') }) : null;
    return [by, narr].filter(Boolean).join(' · ');
  }
  return [item.subtitle, extra.year ? String(extra.year) : null].filter(Boolean).join(' · ');
}

export function TvListenScreen() {
  const t = useT();
  const player = usePlayer();
  const { state } = player;
  const item = state.current;
  const albumId = item?.kind === 'track' ? item.albumId : null;
  const bookId = item?.kind === 'audiobook' ? item.bookId : null;
  const album = useQuery({ queryKey: browseKeys.album(albumId ?? 0), queryFn: () => playerBrowseApi.album(albumId ?? 0), enabled: albumId != null, staleTime: 5 * 60_000 });
  const book = useQuery({ queryKey: browseKeys.audiobook(bookId ?? 0), queryFn: () => playerBrowseApi.audiobook(bookId ?? 0), enabled: bookId != null, staleTime: 5 * 60_000 });

  if (!item || (item.kind !== 'track' && item.kind !== 'audiobook')) {
    return (
      <div className="tv-listen">
        <div className="tv-empty">{t('app.tv.listen.nothing')}</div>
      </div>
    );
  }

  const isBook = item.kind === 'audiobook';
  const art = item.artworkUrl;
  const title = isBook ? item.title : (album.data?.title ?? item.context ?? item.title);
  const sub = subLine(item, t, { year: album.data?.year, authors: book.data?.authors, narrators: book.data?.narrators });
  const prog = listenProgress(item, state.positionMs, state.durationMs, state.chapterIndex);
  const bookLeftMs = Math.max(0, (state.durationMs || item.durationMs) - state.positionMs);

  const onA = () => {
    if (isBook) player.skip(-SKIP_MS);
    else if (state.positionMs > RESTART_AFTER_MS || state.queueIndex <= 0) player.seek(0);
    else player.previous();
  };
  const onB = () => {
    if (isBook) player.skip(SKIP_MS);
    else if (state.queueIndex + 1 < state.queue.length) player.next();
  };

  return (
    <>
      <div className="tv-listen__bg" style={{ background: artBackground(art, title) }} aria-hidden="true" />
      <div className="tv-listen">
        <div className="tv-listen__left">
          <div className="tv-listen__art" style={{ background: artBackground(art, title) }} aria-hidden="true" />
          <div className="tv-listen__kind">{t(isBook ? 'app.tv.listen.audiobook' : 'app.tv.listen.album')}</div>
          <h1 className="tv-listen__title">{title}</h1>
          {sub ? <div className="tv-listen__sub">{sub}</div> : null}
          <div className="tv-listen__prog">
            <div className="tv-listen__cur">{prog.title}</div>
            <div className="tv-listen__bar">
              <span style={{ width: pct(prog.pos / prog.dur) }} />
            </div>
            <div className="tv-listen__times">
              <span>{clock(prog.pos)}</span>
              <span>{clock(prog.dur)}</span>
            </div>
          </div>
          <div className="tv-listen__ctrls" data-tv-row="">
            <button type="button" className="tv-round" data-tv-key="ls-a" data-tv-r="25" onClick={onA} aria-label={t(isBook ? 'app.tv.listen.back30' : 'app.tv.listen.previous')}>
              {isBook ? '−30' : <PrevIcon />}
            </button>
            <button type="button" className="tv-round tv-round--main" data-tv-key="ls-toggle" data-tv-autofocus="" data-tv-r="31" onClick={() => player.toggle()} aria-label={t(state.playing ? 'app.tv.listen.pause' : 'app.tv.listen.play')}>
              {state.playing ? <PauseIcon /> : <PlayIcon />}
            </button>
            <button type="button" className="tv-round" data-tv-key="ls-b" data-tv-r="25" onClick={onB} aria-label={t(isBook ? 'app.tv.listen.forward30' : 'app.tv.listen.next')}>
              {isBook ? '+30' : <NextIcon />}
            </button>
            {isBook ? <div className="tv-listen__left-in-book">{t('app.tv.listen.leftInBook', { time: left(bookLeftMs / 1000) })}</div> : null}
          </div>
        </div>
        <div className="tv-listen__right">
          <h2 className="tv-search__heading">{t(isBook ? 'app.tv.listen.chapters' : 'app.tv.listen.tracks')}</h2>
          <div className="tv-listen__scroll" data-tv-scroll="y" data-tv-mtop="6">
            <div className="tv-listen__list">
              {isBook ? (
                chapterRows(item.chapters, state.chapterIndex, (ms) => {
                  player.seek(ms);
                  if (!state.playing) player.toggle();
                }).map((r) => <Row key={r.key} r={r} />)
              ) : (
                <MusicList player={player} tracks={album.data?.tracks ?? []} />
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

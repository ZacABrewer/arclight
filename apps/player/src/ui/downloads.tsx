import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { useToast } from '@web/components/toast';
import { Banner, Button, EmptyState, Icon, Meter, Pane, cx } from '@web/arclight/index';
import { formatBytes, useT } from '@web/i18n/index';
import { usePlayer } from '@web/features/player/player-context';
import { Artwork } from '@web/features/player/ui/parts';
import { PlayerIcon } from '@web/features/player/ui/player-icons';
import { useDownloads, useServices, useSession } from '../app/context';
import { entryBytes, entryProgress, entryStatus, type DownloadEntry } from '../offline/download-index';
import { DownloadError } from '../offline/downloads';

// Downloads: what is on this phone for the active account, its progress, and ways to add more
// (what's playing, the whole queue). Browse pages start playback; downloading starts here.

const toWebUrl = (u: string) => (Capacitor.isNativePlatform() ? Capacitor.convertFileSrc(u) : u);

function artworkOf(e: DownloadEntry): string | null {
  if (e.artwork?.status === 'completed') {
    const local = e.artwork.uri ?? e.artwork.path;
    if (local) return toWebUrl(local);
  }
  return e.item.artworkUrl ?? null;
}

/** Starts downloads and reports the outcome as a toast. */
export function useStartDownload() {
  const t = useT();
  const toasts = useToast();
  const { downloads } = useServices();
  const session = useSession();
  return async (itemKeys: string[]) => {
    if (!session || itemKeys.length === 0) return;
    try {
      const added = await downloads.download(session.accountId, itemKeys);
      toasts.push(added.length ? { tone: 'ok', title: t('app.downloads.added', { count: added.length }) } : { tone: 'info', title: t('app.downloads.already') });
    } catch (err) {
      const title =
        err instanceof DownloadError && err.code !== 'not-signed-in'
          ? t(`app.downloads.error.${err.code}`)
          : t('app.downloads.error.failed', { message: err instanceof Error ? err.message : String(err) });
      toasts.push({ tone: 'error', title });
    }
  };
}

function statusText(t: ReturnType<typeof useT>, e: DownloadEntry): string {
  const s = entryStatus(e);
  return s === 'downloading' ? t('app.downloads.status.downloading', { percent: Math.round(entryProgress(e) * 100) }) : t(`app.downloads.status.${s}`);
}

/** The downloaded items of the active account; `onlyReady` hides those not finished yet. */
export function DownloadList({ onlyReady = false }: { onlyReady?: boolean }) {
  const t = useT();
  const { downloads } = useServices();
  const session = useSession();
  const player = usePlayer();
  const all = useDownloads();
  const entries = (onlyReady ? all.filter((e) => entryStatus(e) === 'completed') : all).slice().sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  const ready = entries.filter((e) => entryStatus(e) === 'completed').map((e) => e.itemKey);
  if (!session) return null;
  if (entries.length === 0) {
    return (
      <EmptyState title={t('app.downloads.empty')} icon={<Icon name="download" size={24} />}>
        {t('app.downloads.emptyHelp')}
      </EmptyState>
    );
  }
  return (
    <ul className="app-list" aria-label={t('app.downloads.title')}>
      {entries.map((e) => {
        const status = entryStatus(e);
        const current = player.state.current?.itemKey === e.itemKey;
        return (
          <li key={e.itemKey} className={cx('app-list__row', current && 'is-current')}>
            <button
              type="button"
              className="app-list__main"
              disabled={status !== 'completed'}
              aria-label={`${t('app.downloads.play')}: ${e.item.title}`}
              onClick={() => player.playItems(ready, { startIndex: Math.max(0, ready.indexOf(e.itemKey)), source: 'downloads' })}
            >
              <Artwork url={artworkOf(e)} size={48} />
              <span className="app-list__text">
                <span className="app-list__title">{e.item.title}</span>
                <span className="app-list__sub">{[e.item.subtitle, e.item.context].filter(Boolean).join(' · ')}</span>
                <span className="app-list__meta">
                  {statusText(t, e)} · {formatBytes(entryBytes(e))}
                </span>
                {status !== 'completed' && status !== 'failed' ? <Meter value={entryProgress(e) * 100} label={statusText(t, e)} /> : null}
              </span>
              {status === 'completed' ? <PlayerIcon name={current && player.state.playing ? 'pause' : 'play'} size={20} /> : null}
            </button>
            <span className="app-list__actions">
              {status === 'failed' ? (
                <Button variant="ghost" className="app-touch" icon={<Icon name="refresh" size={20} />} aria-label={t('app.downloads.retry')} onClick={() => void downloads.retry(session.accountId, e.itemKey)} />
              ) : null}
              {status === 'downloading' || status === 'queued' || status === 'waiting' ? (
                <Button variant="ghost" className="app-touch" icon={<PlayerIcon name="pause" size={18} />} aria-label={t('app.downloads.pause')} onClick={() => void downloads.pause(session.accountId, e.itemKey)} />
              ) : null}
              {status === 'paused' ? (
                <Button variant="ghost" className="app-touch" icon={<PlayerIcon name="play" size={18} />} aria-label={t('app.downloads.resume')} onClick={() => void downloads.resume(session.accountId, e.itemKey)} />
              ) : null}
              <Button variant="ghost" className="app-touch" icon={<Icon name="trash" size={20} />} aria-label={t('app.downloads.remove')} onClick={() => void downloads.remove(session.accountId, e.itemKey)} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function DownloadsPage() {
  const t = useT();
  const { downloads, index } = useServices();
  const session = useSession();
  const player = usePlayer();
  const start = useStartDownload();
  const entries = useDownloads();
  const [storage, setStorage] = useState<{ usedBytes: number; freeBytes: number } | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  useEffect(() => {
    let live = true;
    void downloads.storageInfo().then((s) => live && setStorage(s));
    return () => {
      live = false;
    };
  }, [downloads, entries.length]);

  const currentKey = player.state.current?.itemKey;
  const queueKeys = player.state.queue.map((q) => q.itemKey);

  return (
    <div className="app-page">
      <h1 className="app-page__title">{t('app.downloads.title')}</h1>
      {!downloads.available ? <Banner tone="warn">{t('app.downloads.unavailable')}</Banner> : null}
      {downloads.available ? (
        <div className="app-row app-row--wrap">
          <Button variant="secondary" icon={<Icon name="download" size={20} />} disabled={!currentKey} onClick={() => currentKey && void start([currentKey])}>
            {t('app.downloads.current')}
          </Button>
          <Button variant="secondary" icon={<Icon name="download" size={20} />} disabled={queueKeys.length === 0} onClick={() => void start(queueKeys)}>
            {t('app.downloads.queue')}
          </Button>
        </div>
      ) : null}
      <Pane className="app-section">
        <DownloadList />
      </Pane>
      <p className="app-hint">
        {t('app.downloads.used', {
          used: formatBytes(storage?.usedBytes ?? index.usedBytes(session?.accountId)),
          free: storage ? formatBytes(storage.freeBytes) : '—',
        })}
      </p>
      {session && entries.length > 0 ? (
        confirmAll ? (
          <Banner
            tone="danger"
            action={
              <div className="app-row">
                <Button variant="ghost" onClick={() => setConfirmAll(false)}>
                  {t('app.common.cancel')}
                </Button>
                <Button
                  variant="danger-solid"
                  onClick={() => {
                    setConfirmAll(false);
                    void downloads.removeAll(session.accountId);
                  }}
                >
                  {t('app.downloads.removeAll')}
                </Button>
              </div>
            }
          >
            {t('app.downloads.removeAllConfirm')}
          </Banner>
        ) : (
          <Button variant="danger" icon={<Icon name="trash" size={20} />} onClick={() => setConfirmAll(true)}>
            {t('app.downloads.removeAll')}
          </Button>
        )
      ) : null}
    </div>
  );
}

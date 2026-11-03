import { useT } from '../../../i18n/index.js';
import { useDownloadState, usePlayerActions, type DownloadState } from './player-hooks.js';
import { DetailAction } from './rd-audio.js';

const LABEL: Record<DownloadState, string> = {
  none: 'player.browse.download.action',
  queued: 'player.browse.download.queued',
  waiting: 'player.browse.download.waiting',
  downloading: 'player.browse.download.downloading',
  done: 'player.browse.download.done',
};

/** The message key for a download state ("Download", "Queued", "Waiting for Wi-Fi", "Downloading…", "Downloaded"). */
export function downloadLabelKey(state: DownloadState): string {
  return LABEL[state];
}

/**
 * Download action for an album, playlist or book page (one of the title page's secondary
 * buttons). Renders nothing when the player has no downloads (the web player); the mobile app
 * provides them through BrowsePlayerContext.
 */
export function DownloadButton({ itemKeys }: { itemKeys: readonly string[] }) {
  const t = useT();
  const player = usePlayerActions();
  const state = useDownloadState(itemKeys);
  if (state === null || !player.download) return null;
  const busy = state === 'queued' || state === 'downloading';
  return (
    <DetailAction
      icon={state === 'done' ? 'check' : 'download'}
      label={t(LABEL[state])}
      busy={busy}
      disabled={itemKeys.length === 0 || state !== 'none'}
      data-download-state={state}
      onClick={() => player.download?.([...itemKeys])}
    />
  );
}

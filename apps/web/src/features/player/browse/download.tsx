import { Button, Icon } from '../../../arclight/index.js';
import { useT } from '../../../i18n/index.js';
import { useDownloadState, usePlayerActions, type DownloadState } from './player-hooks.js';

const LABEL: Record<DownloadState, string> = {
  none: 'player.browse.download.action',
  queued: 'player.browse.download.queued',
  downloading: 'player.browse.download.downloading',
  done: 'player.browse.download.done',
};

/** The message key for a download state ("Download", "Queued", "Downloading…", "Downloaded"). */
export function downloadLabelKey(state: DownloadState): string {
  return LABEL[state];
}

/**
 * Download button for an album, playlist or book page. Renders nothing when the player has no
 * downloads (the web player); the mobile app provides them through BrowsePlayerContext.
 */
export function DownloadButton({ itemKeys }: { itemKeys: readonly string[] }) {
  const t = useT();
  const player = usePlayerActions();
  const state = useDownloadState(itemKeys);
  if (state === null || !player.download) return null;
  const busy = state === 'queued' || state === 'downloading';
  return (
    <Button
      variant="ghost"
      icon={<Icon name={state === 'done' ? 'check' : 'download'} />}
      loading={busy}
      disabled={itemKeys.length === 0 || state !== 'none'}
      data-download-state={state}
      onClick={() => player.download?.([...itemKeys])}
    >
      {t(LABEL[state])}
    </Button>
  );
}

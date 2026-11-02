import { useState } from 'react';
import type { QueueItem, QueueReplaceRequestInput, QueueStatus } from '@arclight/shared';
import { Banner, Button, Checkbox, Modal } from '../../arclight/index.js';
import { useToast } from '../../components/toast.js';
import { useReannounceQueueItem, useReplaceQueueItem } from '../../hooks/activity.js';
import { formatSize } from '../../lib/format.js';
import { isPendingItem } from './queue-remove.js';
import { t } from '../../i18n/index.js';

// Self-healing downloads in the Activity queue: the "Try another release" and "Re-announce"
// actions of an expanded row, the banner while the disk-space guard holds or pauses things, and
// the banner for releases the safety filter rejected (they left the queue; History keeps them).

/** Re-announce applies to torrents that reached a client and are still downloading. */
export function canReannounce(item: QueueItem): boolean {
  return item.protocol === 'torrent' && !isPendingItem(item) && item.trackedState === 'downloading';
}

/** Replacing needs a series/movie to search for, and is pointless once the import started. */
export function canReplace(item: QueueItem): boolean {
  const linked = item.movieId !== undefined || (item.seriesId !== undefined && (item.episodeIds?.length ?? 0) > 0);
  return linked && item.trackedState !== 'importing';
}

/** Confirm dialog of "Try another release": blocklist and delete-data options, both on by default. */
export function ReplaceReleaseDialog({
  item,
  busy,
  onClose,
  onConfirm,
}: {
  item: QueueItem;
  busy?: boolean;
  onClose: () => void;
  onConfirm: (options: QueueReplaceRequestInput) => void;
}) {
  const sent = !isPendingItem(item);
  const [blocklist, setBlocklist] = useState(true);
  const [removeData, setRemoveData] = useState(sent);
  return (
    <Modal
      open
      size={440}
      onClose={onClose}
      title={t('activity.queueRecovery.replaceTitle', { title: item.title })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger-solid" loading={busy ?? false} onClick={() => onConfirm({ blocklist, removeData: sent && removeData })}>
            {t('activity.queueRecovery.replaceConfirm')}
          </Button>
        </>
      }
    >
      <div className="al-activity-stack">
        <p className="al-activity-muted">{t('activity.queueRecovery.replaceBody')}</p>
        <Checkbox
          label={t('activity.queueRecovery.blocklist')}
          hint={t('activity.queueRecovery.blocklistHint')}
          checked={blocklist}
          onChange={(e) => setBlocklist(e.currentTarget.checked)}
        />
        <Checkbox
          label={t('activity.queueRecovery.removeData')}
          hint={sent ? t('activity.queueRecovery.removeDataHint') : t('activity.queue.notSentToADownload')}
          checked={sent && removeData}
          disabled={!sent}
          onChange={(e) => setRemoveData(e.currentTarget.checked)}
        />
      </div>
    </Modal>
  );
}

/** Buttons in the expanded queue row: Re-announce (lighter) and Try another release (confirmed). */
export function QueueRecoveryActions({ item }: { item: QueueItem }) {
  const [confirming, setConfirming] = useState(false);
  const replace = useReplaceQueueItem();
  const reannounce = useReannounceQueueItem();
  const toast = useToast();
  const showReannounce = canReannounce(item);
  const showReplace = canReplace(item);
  if (!showReannounce && !showReplace) return null;
  return (
    <div className="al-activity-actions al-queue-detail__actions">
      {showReannounce ? (
        <Button
          size="sm"
          variant="secondary"
          loading={reannounce.isPending}
          aria-label={t('activity.queueRecovery.reannounceTitle', { title: item.title })}
          onClick={() =>
            reannounce.mutate(item.id, {
              onSuccess: (res) => toast.push({ tone: 'ok', title: t('activity.queueRecovery.reannounced'), message: res.message, durationMs: 4_000 }),
            })
          }
        >
          {t('activity.queueRecovery.reannounce')}
        </Button>
      ) : null}
      {showReplace ? (
        <Button size="sm" variant="danger" onClick={() => setConfirming(true)} aria-label={t('activity.queueRecovery.replaceTitle', { title: item.title })}>
          {t('activity.queueRecovery.replace')}
        </Button>
      ) : null}
      {confirming ? (
        <ReplaceReleaseDialog
          item={item}
          busy={replace.isPending}
          onClose={() => setConfirming(false)}
          onConfirm={(options) =>
            replace.mutate(
              { id: item.id, options },
              {
                onSuccess: (res) => {
                  setConfirming(false);
                  toast.push({ tone: 'ok', title: t('activity.queueRecovery.replaced'), message: res.message, durationMs: 6_000 });
                },
              },
            )
          }
        />
      ) : null}
    </div>
  );
}

/** Banner text while the disk-space guard holds grabs or paused downloads; null when it does neither. */
export function diskGuardBannerText(guard: QueueStatus['diskGuard']): string | null {
  if (!guard || (guard.paused === 0 && guard.held === 0)) return null;
  const minimum = formatSize(guard.minimumFreeBytes);
  const where = guard.volumes.map((v) => t('activity.queueRecovery.volumeFree', { path: v.path, free: formatSize(v.freeBytes) })).join(', ');
  const parts: string[] = [];
  if (guard.paused > 0) {
    parts.push(
      where
        ? t('activity.queueRecovery.bannerPausedAt', { count: guard.paused, minimum, where })
        : t('activity.queueRecovery.bannerPaused', { count: guard.paused, minimum }),
    );
  }
  if (guard.held > 0) parts.push(t('activity.queueRecovery.bannerHeld', { count: guard.held, minimum }));
  return parts.join(' ');
}

/** Downloads the fake-release / malware filter rejected in the last day, newest first. */
export function RejectionsBanner({ rejections }: { rejections: QueueStatus['recentRejections'] }) {
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  const shown = (rejections ?? []).filter((r) => dismissedAt === null || r.time > dismissedAt);
  if (shown.length === 0) return null;
  const visible = shown.slice(0, 3);
  return (
    <div className="al-queue-banner" data-testid="queue-rejections">
      <Banner tone="danger">
        <strong>{t('activity.queueRecovery.rejectedTitle', { count: shown.length })}</strong>
        <ul className="al-queue-rejections">
          {visible.map((r) => (
            <li key={`${r.trackedDownloadId}-${r.time}`}>
              <span className="al-queue-rejections__title">{r.title}</span>: {r.reason}
            </li>
          ))}
        </ul>
        {shown.length > visible.length ? <span>{t('activity.queueRecovery.rejectedMore', { count: shown.length - visible.length })} </span> : null}
        <Button size="sm" variant="ghost" onClick={() => setDismissedAt(shown[0]!.time)}>
          {t('activity.queueRecovery.rejectedDismiss')}
        </Button>
      </Banner>
    </div>
  );
}

export function DiskGuardBanner({ guard }: { guard: QueueStatus['diskGuard'] }) {
  const text = diskGuardBannerText(guard);
  if (!text) return null;
  return (
    <div className="al-queue-banner">
      <Banner tone={guard && guard.paused > 0 ? 'danger' : 'warn'}>
        <strong>{t('activity.queueRecovery.bannerTitle')}</strong> {text}
      </Banner>
    </div>
  );
}

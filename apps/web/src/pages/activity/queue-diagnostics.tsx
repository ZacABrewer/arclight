import type { DownloadEvent, QueueItem, QueueSeverity, TorrentPeer, TorrentSessionStatus, VpnStatus } from '@arclight/shared';
import {
  Banner,
  Chip,
  EmptyState,
  ErrorBlock,
  KeyValue,
  SectionLabel,
  Skeleton,
  Table,
  Timeline,
  Tooltip,
  Trail,
  type ChipTone,
  type Column,
  type KeyValueItem,
  type TimelineItem,
} from '../../arclight/index.js';
import { errorMessage } from '../../api/client.js';
import { useQueueTimeline } from '../../hooks/activity.js';
import { useTorrentDetail } from '../../hooks/torrent.js';
import { formatDateTime, formatRate, formatSize, relativeTime } from '../../lib/format.js';
import { formatEta } from './activity-shared.js';
import { trailState, queueChip } from './queue-status.js';
import { PeerConnectionBadges } from './torrent-extras.js';
import { DownloadTransferHistory } from './transfer-history.js';
import { t } from '../../i18n/index.js';

// "Why is it not moving": the engine/VPN banner above the queue, the per-row state chip and
// live numbers, and the expandable detail panel (live stats, pieces, peers, timeline).

/** Lockdowns per hour from which the banner calls the kill switch unstable (matches the health check). */
export const FLAPPING_THRESHOLD = 3;

const SEVERITY_TONE: Record<QueueSeverity, ChipTone> = { ok: 'accent', info: 'neutral', warning: 'warn', error: 'danger' };

export function severityTone(severity: QueueSeverity | undefined): ChipTone {
  return SEVERITY_TONE[severity ?? 'info'];
}

/** Localised label of a state code (the server's sentence is the tooltip). */
export function stateLabel(code: NonNullable<QueueItem['stateCode']>): string {
  return t(`activity.queueState.${code}`);
}

/** State-reason chip coloured by severity; the full reason and status messages sit in a tooltip. */
export function QueueStateChip({ item }: { item: QueueItem }) {
  if (!item.stateCode) return null;
  const messages = item.statusMessages.flatMap((m) => m.messages).filter((m) => m.trim() && m !== item.stateReason);
  const detail = [item.stateReason, ...messages].filter(Boolean).join('\n');
  const chip = (
    <Chip tone={severityTone(item.stateSeverity)} tabIndex={detail ? 0 : undefined} aria-label={detail ? `${stateLabel(item.stateCode)}: ${detail}` : undefined}>
      {stateLabel(item.stateCode)}
    </Chip>
  );
  if (!detail) return chip;
  return (
    <Tooltip content={<span className="al-activity-prewrap">{detail}</span>} placement="top">
      {chip}
    </Tooltip>
  );
}

/** "↓ 1.2 MiB/s" over "↑ 30 KiB/s", or a dash without live numbers. */
export function SpeedCell({ item }: { item: QueueItem }) {
  if (!item.live) return <>—</>;
  return (
    <span className="al-queue-speed" aria-label={t('activity.queueDetail.speedAria', { down: formatRate(item.live.downloadRate), up: formatRate(item.live.uploadRate) })}>
      <span>↓ {formatRate(item.live.downloadRate)}</span>
      <span className="al-activity-muted">↑ {formatRate(item.live.uploadRate)}</span>
    </span>
  );
}

/** Connected peers with seeds in brackets ("4 (1)"), or a dash when the client does not say. */
export function formatPeers(live: QueueItem['live']): string {
  if (!live || live.connectedPeers === undefined) return '—';
  return live.connectedSeeds === undefined ? String(live.connectedPeers) : `${live.connectedPeers} (${live.connectedSeeds})`;
}

export type EngineBannerKind = 'lockdown' | 'vpnDown' | 'flapping';

/** Which banner (if any) the queue shows: lockdown beats VPN down beats a flapping kill switch. */
export function engineBannerKind(engine: TorrentSessionStatus | undefined, vpn: VpnStatus | undefined): EngineBannerKind | null {
  if (engine?.state === 'lockdown') return 'lockdown';
  if (vpn?.enabled && !vpn.connected) return 'vpnDown';
  if ((engine?.lockdownsLastHour ?? 0) >= FLAPPING_THRESHOLD) return 'flapping';
  return null;
}

/**
 * Banner above the queue while the built-in engine is locked down by the VPN kill switch, the
 * VPN is down, or the kill switch keeps engaging. Null when all is well.
 */
export function EngineBanner({ engine, vpn, now = Date.now() }: { engine?: TorrentSessionStatus | undefined; vpn?: VpnStatus | undefined; now?: number }) {
  const kind = engineBannerKind(engine, vpn);
  if (kind === 'lockdown' && engine) {
    const since = engine.lockdownSince;
    return (
      <Banner tone="danger">
        <strong>{t('activity.queueBanner.lockdownTitle')}</strong>{' '}
        {t('activity.queueBanner.lockdownBody', { reason: (engine.lockdownReason ?? t('activity.queueBanner.vpnDown')).replace(/[.\s]+$/, '') })}{' '}
        {since ? (
          <time dateTime={since} title={formatDateTime(since)}>
            {t('activity.queueBanner.since', { when: relativeTime(since, now) })}
          </time>
        ) : null}{' '}
        {engine.killSwitchPaused ? t('activity.queueBanner.pausedCount', { count: engine.killSwitchPaused }) : null}
      </Banner>
    );
  }
  if (kind === 'vpnDown' && vpn) {
    const since = vpn.lastChanged;
    return (
      <Banner tone="warn">
        <strong>{t('activity.queueBanner.vpnDownTitle')}</strong> {vpn.error ? `${vpn.error.replace(/[.\s]+$/, '')}. ` : ''}
        {since ? (
          <time dateTime={since} title={formatDateTime(since)}>
            {t('activity.queueBanner.since', { when: relativeTime(since, now) })}
          </time>
        ) : null}
      </Banner>
    );
  }
  if (kind === 'flapping') {
    return <Banner tone="warn">{t('activity.queueBanner.flapping', { count: engine?.lockdownsLastHour ?? 0 })}</Banner>;
  }
  return null;
}

const EVENT_TONE: Record<QueueSeverity, TimelineItem['tone']> = { ok: 'default', info: 'default', warning: 'warn', error: 'danger' };

/** Timeline entries for the Arclight Timeline component, newest first. */
export function timelineItems(events: readonly DownloadEvent[]): TimelineItem[] {
  return [...events].reverse().map((e) => ({
    id: String(e.id),
    date: <time dateTime={e.time}>{formatDateTime(e.time)}</time>,
    title: t(`activity.timeline.${e.type}`),
    description: e.message,
    tone: EVENT_TONE[e.severity],
  }));
}

function DownloadTimelineView({ id }: { id: number }) {
  const timeline = useQueueTimeline(id);
  if (timeline.isPending) return <Skeleton lines={3} />;
  if (timeline.isError) {
    return (
      <ErrorBlock title={t('activity.queueDetail.couldntLoadTimeline')} onRetry={() => void timeline.refetch()}>
        {errorMessage(timeline.error)}
      </ErrorBlock>
    );
  }
  if (timeline.data.events.length === 0) return <EmptyState title={t('activity.queueDetail.noEventsYet')} />;
  return <Timeline items={timelineItems(timeline.data.events)} />;
}

const PEER_COLUMNS: Column<TorrentPeer>[] = [
  { key: 'client', get header() { return t('activity.torrentDrawer.client'); }, cell: (p) => p.client || '—' },
  { key: 'address', get header() { return t('common.address'); }, mono: true, muted: true, cell: (p) => p.address },
  { key: 'connection', get header() { return t('activity.torrentDrawer.connection'); }, cell: (p) => <PeerConnectionBadges peer={p} /> },
  { key: 'down', get header() { return t('common.down'); }, mono: true, align: 'right', cell: (p) => formatRate(p.downloadRate) },
  { key: 'up', get header() { return t('activity.torrentDrawer.up'); }, mono: true, align: 'right', cell: (p) => formatRate(p.uploadRate) },
];

/** Peer list of a built-in engine torrent, polled while the panel is open. */
function EnginePeers({ downloadId }: { downloadId: string }) {
  const detail = useTorrentDetail(downloadId);
  if (detail.isPending) return <Skeleton lines={2} />;
  const peers = detail.data?.peers ?? [];
  if (peers.length === 0) return <EmptyState title={t('activity.torrentDrawer.noPeersConnected')} />;
  return <Table caption={t('common.peers')} columns={PEER_COLUMNS} rows={peers} rowKey={(p) => p.address} sortable={false} />;
}

function liveStats(item: QueueItem): KeyValueItem[] {
  const live = item.live;
  const rows: KeyValueItem[] = [];
  if (live) {
    rows.push(
      { key: 'down', label: t('activity.queueDetail.downloadRate'), value: formatRate(live.downloadRate) },
      { key: 'up', label: t('activity.queueDetail.uploadRate'), value: formatRate(live.uploadRate) },
    );
    if (live.connectedPeers !== undefined) {
      rows.push({
        key: 'peers',
        label: t('activity.queueDetail.connectedPeers'),
        value: t('activity.queueDetail.peersSeeds', { peers: live.connectedPeers, seeds: live.connectedSeeds ?? 0 }),
      });
    }
    if (live.swarmSeeds !== undefined || live.swarmLeechers !== undefined) {
      rows.push({
        key: 'swarm',
        label: t('activity.queueDetail.swarm'),
        value: t('activity.queueDetail.swarmValue', { seeds: live.swarmSeeds ?? 0, leechers: live.swarmLeechers ?? 0 }),
      });
    }
    if (live.ratio !== undefined) rows.push({ key: 'ratio', label: t('activity.torrentDrawer.ratio'), value: live.ratio.toFixed(2) });
    if (live.transports) {
      rows.push({ key: 'transport', label: t('activity.queueDetail.transport'), value: `TCP ${live.transports.tcp} · uTP ${live.transports.utp}` });
    }
    if (live.encryptedPeers !== undefined) {
      rows.push({ key: 'enc', label: t('activity.queueDetail.encryptedPeers'), value: String(live.encryptedPeers) });
    }
  }
  rows.push(
    { key: 'left', label: t('activity.queueDetail.remaining'), value: `${formatSize(item.sizeLeftBytes)} / ${formatSize(item.sizeBytes)}` },
    { key: 'eta', label: t('activity.queue.eta'), value: formatEta(item.eta) },
  );
  if (item.stalledSince) {
    rows.push({ key: 'stalled', label: t('activity.queueDetail.lastData'), value: formatDateTime(item.stalledSince) });
  }
  if (item.outputPath) rows.push({ key: 'path', label: t('common.path'), value: <span className="al-activity-break">{item.outputPath}</span> });
  return rows;
}

/**
 * Expanded queue row: why it is (not) moving, live stats, a pieces/progress bar, the peers of
 * a built-in engine torrent and the download's timeline.
 */
export function QueueItemDetail({ item, builtin, id }: { item: QueueItem; builtin: boolean; id: string }) {
  const live = item.live;
  const pieces = live?.pieceCount ? live.piecesHave ?? 0 : undefined;
  const value = live?.pieceCount && pieces !== undefined ? (pieces / live.pieceCount) * 100 : item.progress * 100;
  return (
    <section id={id} className="al-queue-detail" aria-label={t('activity.queueDetail.detailsOf', { title: item.title })}>
      {item.stateReason ? (
        <p className="al-queue-detail__reason">
          <QueueStateChip item={item} /> <span>{item.stateReason}</span>
        </p>
      ) : null}
      <div className="al-queue-detail__grid">
        <div className="al-activity-stack-xs">
          <SectionLabel>{t('activity.queueDetail.liveStats')}</SectionLabel>
          <Trail
            value={value}
            state={trailState(queueChip(item))}
            showValue
            label={pieces !== undefined ? t('activity.queueDetail.piecesOf', { have: pieces, total: live?.pieceCount ?? 0 }) : t('activity.queue.progressOfTitle', { title: item.title })}
          />
          {pieces !== undefined ? (
            <span className="al-activity-muted al-num">{t('activity.queueDetail.piecesOf', { have: pieces, total: live?.pieceCount ?? 0 })}</span>
          ) : null}
          <KeyValue items={liveStats(item)} />
        </div>
        <div className="al-activity-stack-xs">
          <SectionLabel>{t('activity.queueDetail.timeline')}</SectionLabel>
          <DownloadTimelineView id={item.id} />
        </div>
      </div>
      <DownloadTransferHistory id={item.id} title={item.title} />
      {builtin ? (
        <div className="al-activity-stack-xs">
          <SectionLabel>{t('common.peers')}</SectionLabel>
          <EnginePeers downloadId={item.downloadId} />
        </div>
      ) : null}
    </section>
  );
}

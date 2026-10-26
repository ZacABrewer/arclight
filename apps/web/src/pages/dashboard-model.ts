import type { CalendarItem, HealthCheck, QueueItem, RootFolder, VpnStatus } from '@arclight/shared';
import type { TrailState } from '../arclight/index.js';
import { formatBytes, formatClock, formatSpan } from './system/format.js';
import { t } from '../i18n/index.js';

// Pure view models for the dashboard panes (Page 01), tested without rendering.

export interface UpcomingRow {
  key: string;
  time: string;
  title: string;
  detail: string;
  href: { to: '/library/series/$id' | '/library/movie/$id'; params: { id: string } };
}

const RELEASE_LABEL = { get cinema() { return t('common.inCinemas'); }, get digital() { return t('dashboard.digitalRelease'); }, get physical() { return t('dashboard.physicalRelease'); } } as const;

/** Calendar items airing in [from, from + 24h), soonest first. */
export function upcomingRows(items: readonly CalendarItem[] | null | undefined, from: Date, hours = 24): UpcomingRow[] {
  if (!items) return [];
  const start = from.getTime();
  const end = start + hours * 3_600_000;
  return items
    .map((it) => {
      const when = it.type === 'episode' ? (it.episode.airDateUtc ?? it.date) : it.date;
      return { it, at: new Date(when).getTime(), when };
    })
    .filter(({ at }) => Number.isFinite(at) && at >= start && at < end)
    .sort((a, b) => a.at - b.at)
    .map(({ it, when }): UpcomingRow => {
      if (it.type === 'episode') {
        const e = it.episode;
        const code = `S${String(e.seasonNumber).padStart(2, '0')}E${String(e.episodeNumber).padStart(2, '0')}`;
        const network = it.series?.network;
        return {
          key: `e-${e.id}`,
          time: formatClock(when),
          title: it.seriesTitle,
          detail: [code, network].filter(Boolean).join(' · '),
          href: { to: '/library/series/$id', params: { id: String(it.seriesId) } },
        };
      }
      return {
        key: `m-${it.movie.id}-${it.releaseKind}`,
        time: formatClock(when),
        title: it.movie.title,
        detail: [RELEASE_LABEL[it.releaseKind], it.movie.studio].filter(Boolean).join(' · '),
        href: { to: '/library/movie/$id', params: { id: String(it.movie.id) } },
      };
    });
}

export interface VpnSummary {
  state: 'off' | 'up' | 'down';
  /** "Zürich · WireGuard" */
  headline: string;
  port?: number | undefined;
  /** "3d 7h" since the tunnel last changed state. */
  uptime?: string | undefined;
  /** Cause shown when down. */
  cause?: string | undefined;
}

const PROVIDER_LABEL: Record<NonNullable<VpnStatus['provider']>, string> = {
  get gluetun() {
    return t('dashboard.gluetun');
  },
  get 'wireguard-windows'() {
    return t('dashboard.wireguard');
  },
  get 'interface-binding'() {
    return t('dashboard.interfaceBinding');
  },
};

export function vpnSummary(vpn: VpnStatus | undefined, now: number = Date.now()): VpnSummary | undefined {
  if (!vpn) return undefined;
  if (!vpn.enabled) return { state: 'off', headline: t('common.vpnOff') };
  const place = vpn.city ?? vpn.country ?? vpn.region ?? vpn.publicIp ?? t('dashboard.unknownLocation');
  const provider = vpn.provider ? PROVIDER_LABEL[vpn.provider] : undefined;
  const headline = [place, provider].filter(Boolean).join(' · ');
  if (!vpn.connected || vpn.leak) {
    return {
      state: 'down',
      headline,
      cause: vpn.leak ? t('dashboard.trafficIsLeavingOutsideThe') : (vpn.error ?? t('dashboard.theTunnelIsDownDownloads')),
    };
  }
  const since = vpn.lastChanged ? now - new Date(vpn.lastChanged).getTime() : undefined;
  return { state: 'up', headline, port: vpn.forwardedPort, uptime: since !== undefined && since >= 0 ? formatSpan(since) : undefined };
}

/** Below this much free space a root folder is flagged (orange). */
export const LOW_DISK_BYTES = 100 * 1024 ** 3;

export interface StorageRow {
  key: number;
  path: string;
  free: string;
  low: boolean;
  accessible: boolean;
}

export function storageRows(folders: readonly RootFolder[] | undefined): StorageRow[] {
  return (folders ?? []).map((f) => ({
    key: f.id,
    path: f.path,
    free: f.accessible ? (f.freeSpaceBytes != null ? `${formatBytes(f.freeSpaceBytes)} free` : t('dashboard.freeSpaceUnknown')) : t('common.notReachable'),
    low: !f.accessible || (f.freeSpaceBytes != null && f.freeSpaceBytes < LOW_DISK_BYTES),
    accessible: f.accessible,
  }));
}

/** Health checks needing attention, errors first. */
export function attentionChecks(checks: readonly HealthCheck[] | undefined): HealthCheck[] {
  return (checks ?? []).filter((c) => c.status !== 'ok').sort((a, b) => (a.status === b.status ? 0 : a.status === 'error' ? -1 : 1));
}

export interface QueueRowModel {
  key: number;
  title: string;
  /** "qBittorrent · 6.0 GB" */
  detail: string;
  pct: number;
  pctLabel: string;
  eta: string;
  trail: TrailState;
  /** Chip for rows that need attention (stalled / failed carry their cause). */
  chip?: { status: 'stalled' | 'failed' | 'paused' | 'queued' | 'importing'; cause?: string | undefined } | undefined;
}

function firstMessage(item: QueueItem): string | undefined {
  return item.statusMessages.flatMap((m) => m.messages)[0] ?? item.statusMessages[0]?.title;
}

export function queueRow(item: QueueItem): QueueRowModel {
  const pct = Math.round(Math.min(1, Math.max(0, item.progress)) * 100);
  const cause = firstMessage(item);
  let trail: TrailState = 'active';
  let chip: QueueRowModel['chip'];
  if (item.trackedStatus === 'error' || item.status === 'failed' || item.trackedState === 'failedPending') {
    trail = 'failed';
    chip = { status: 'failed', cause: cause ?? t('dashboard.downloadClientReportedAnError') };
  } else if (item.trackedStatus === 'warning' || item.status === 'warning') {
    trail = 'stalled';
    chip = { status: 'stalled', cause: cause ?? t('dashboard.noProgress') };
  } else if (item.trackedState === 'importing' || item.trackedState === 'importPending') {
    trail = 'complete';
    chip = { status: 'importing' };
  } else if (item.status === 'paused') {
    trail = 'paused';
    chip = { status: 'paused' };
  } else if (item.status === 'queued' || item.trackedState === 'pending') {
    trail = 'queued';
    chip = { status: 'queued' };
  } else if (item.status === 'completed' || item.status === 'seeding') {
    trail = 'complete';
  }
  return {
    key: item.id,
    title: item.title,
    detail: [item.downloadClientName, formatBytes(item.sizeBytes)].filter(Boolean).join(' · '),
    pct,
    pctLabel: `${pct}%`,
    eta: trail === 'active' && item.eta != null ? formatSpan(item.eta) : trail === 'complete' ? 'done' : '—',
    trail,
    chip,
  };
}

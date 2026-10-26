import type { DownloadItemPhase } from '@arclight/download-clients';
import type {
  QueueItemClientStatus,
  QueueItemLive,
  QueueItemStateCode,
  QueueSeverity,
  QueueStatusMessage,
  TrackedDownloadState,
  TrackedDownloadStatus,
} from '@arclight/shared';

// "Why is this download not moving?" One pure function from everything the queue knows about
// a tracked download to a machine code, a severity and one plain-English sentence. The order
// of the checks is the order of precedence: a download paused by the kill switch is reported
// as such even though its client status is just "paused".

export interface StateInput {
  state: TrackedDownloadState;
  clientStatus: QueueItemClientStatus;
  trackedStatus: TrackedDownloadStatus;
  statusMessages: readonly QueueStatusMessage[];
  phase?: DownloadItemPhase | null | undefined;
  live?: QueueItemLive | null | undefined;
  progress: number;
  /** ISO-8601, set while stalled. */
  stalledSince?: string | null | undefined;
  /** Minutes without data that count as stalled (for the sentence). */
  stallMinutes?: number | undefined;
  /** Bytes missing on the save volume, > 0 when the download will not fit. */
  diskShortfall?: number | null | undefined;
  clientName?: string | null | undefined;
  /** The client's last poll failed with this message. */
  clientError?: string | undefined;
  /** An import copying the file into the library (no hard link possible). */
  importCopy?: { copiedBytes: number; totalBytes: number; bytesPerSecond: number } | undefined;
  /** The built-in engine is still starting up (its last poll may have failed because of it). */
  engineStarting?: boolean | undefined;
  /** Paused by the built-in engine's VPN kill switch, with the engine's lockdown reason. */
  killSwitch?: { reason?: string | undefined } | undefined;
  /** Active-download limit of the client, when known (for "queued" sentences). */
  maxActiveDownloads?: number | null | undefined;
}

export interface StateReason {
  code: QueueItemStateCode;
  severity: QueueSeverity;
  reason: string;
}

export const STATE_SEVERITY: Readonly<Record<QueueItemStateCode, QueueSeverity>> = {
  downloading: 'ok',
  pendingGrab: 'info',
  metadata: 'info',
  checking: 'info',
  moving: 'info',
  queued: 'info',
  paused: 'info',
  killSwitch: 'error',
  noPeers: 'warning',
  stalled: 'warning',
  diskSpace: 'error',
  clientUnavailable: 'error',
  missing: 'warning',
  warning: 'warning',
  error: 'error',
  completed: 'ok',
  importPending: 'info',
  importBlocked: 'warning',
  importing: 'info',
};

/** Codes under which a download is not expected to receive data (the stall clock stands still). */
export const NOT_TRANSFERRING: ReadonlySet<QueueItemStateCode> = new Set<QueueItemStateCode>([
  'pendingGrab',
  'metadata',
  'checking',
  'moving',
  'queued',
  'paused',
  'killSwitch',
  'clientUnavailable',
  'missing',
  'error',
  'completed',
  'importPending',
  'importBlocked',
  'importing',
]);

export function deriveState(input: StateInput): StateReason {
  const r = (code: QueueItemStateCode, reason: string, severity: QueueSeverity = STATE_SEVERITY[code]): StateReason => ({
    code,
    severity,
    reason,
  });
  const first = firstMessage(input.statusMessages);
  const client = input.clientName ?? 'The download client';

  switch (input.state) {
    case 'pending':
      return r('pendingGrab', first ?? 'Waiting to be sent to a download client.', input.trackedStatus === 'ok' ? 'info' : 'warning');
    case 'importing':
      if (input.importCopy) {
        const c = input.importCopy;
        return r(
          'importing',
          `Copying into the library: ${formatBytes(c.copiedBytes)} of ${formatBytes(c.totalBytes)} (${formatBytes(c.bytesPerSecond)}/s). ` +
            'A hard link was not possible, so the file is copied; see the hard link health check.',
        );
      }
      return r('importing', 'Importing into the library.');
    case 'importPending':
      if (input.trackedStatus !== 'ok' || input.statusMessages.length > 0) {
        return r('importBlocked', first ?? 'The import is blocked; it is retried automatically.');
      }
      return r('importPending', 'Download complete, waiting for import.');
    case 'failedPending':
    case 'failed':
      return r('error', first ?? 'The download failed.');
    default:
      break;
  }

  if (input.engineStarting) {
    return r('checking', 'The built-in engine is starting up and checking the files already on disk; this download continues when it is done.');
  }
  if (input.clientError !== undefined) return r('clientUnavailable', `${client} is unreachable: ${input.clientError}`);
  if (input.clientStatus === 'unknown') return r('missing', `${client} no longer reports this download.`);
  if (input.clientStatus === 'failed') return r('error', first ?? `${client} reported this download as failed.`);
  if (input.killSwitch) {
    const why = input.killSwitch.reason ? ` (${trimDot(input.killSwitch.reason)})` : '';
    return r('killSwitch', `Paused by the VPN kill switch${why}. It resumes on its own when the VPN reconnects.`);
  }
  if (input.diskShortfall && input.diskShortfall > 0) {
    return r('diskSpace', `Not enough free disk space to finish: ${formatBytes(input.diskShortfall)} short on the download volume.`);
  }
  if (input.clientStatus === 'completed' || input.clientStatus === 'seeding') {
    if (input.trackedStatus !== 'ok' && first) return r('warning', first);
    return r('completed', 'Download complete.');
  }
  if (input.clientStatus === 'paused') return r('paused', `Paused in ${client}.`);
  if (input.phase === 'checking') return r('checking', 'Checking existing data on disk.');
  if (input.phase === 'metadata') {
    const peers = input.live?.connectedPeers;
    return r('metadata', `Waiting for the torrent metadata from peers${peers !== undefined ? ` (${plural(peers, 'peer')} connected)` : ''}.`);
  }
  if (input.phase === 'moving') return r('moving', `${client} is moving the files.`);
  if (input.clientStatus === 'queued') {
    const limit = input.maxActiveDownloads;
    return r('queued', limit ? `Queued: waiting for a free download slot (at most ${limit} active).` : `Queued in ${client}.`);
  }
  if (input.stalledSince) {
    const minutes = input.stallMinutes ? ` for ${input.stallMinutes}+ minutes` : '';
    return r('stalled', `No new data received${minutes}.${peerSentence(input.live)}`);
  }
  const live = input.live;
  if (live && live.connectedPeers === 0 && input.progress < 1) {
    const swarm = live.swarmSeeds !== undefined ? ` Trackers report ${plural(live.swarmSeeds, 'seed')} in the swarm.` : '';
    return r('noPeers', `No peers connected yet.${swarm}`);
  }
  if (input.clientStatus === 'warning' || input.trackedStatus !== 'ok') {
    return r('warning', first ?? `${client} reported a problem with this download.`);
  }
  if (live && live.connectedPeers !== undefined) {
    const seeds = live.connectedSeeds !== undefined ? ` (${plural(live.connectedSeeds, 'seed')})` : '';
    return r('downloading', `Downloading from ${plural(live.connectedPeers, 'peer')}${seeds}.`);
  }
  return r('downloading', 'Downloading.');
}

function peerSentence(live: QueueItemLive | null | undefined): string {
  if (!live || live.connectedPeers === undefined) return '';
  const seeds = live.connectedSeeds !== undefined ? `, ${plural(live.connectedSeeds, 'seed')}` : '';
  return ` ${plural(live.connectedPeers, 'peer')} connected${seeds}.`;
}

function firstMessage(messages: readonly QueueStatusMessage[]): string | undefined {
  for (const m of messages) {
    const text = m.messages.find((entry) => entry.trim());
    if (text) return text;
  }
  return undefined;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function trimDot(s: string): string {
  return s.replace(/[.\s]+$/, '');
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

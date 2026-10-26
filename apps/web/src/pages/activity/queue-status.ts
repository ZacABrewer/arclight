import type { QueueItem } from '@arclight/shared';
import type { StatusKey, TrailState } from '../../arclight/index.js';
import { t } from '../../i18n/index.js';

// Pure mapping from a queue row to the Arclight status vocabulary (handoff §7: warn/failed rows
// explain the cause in the chip) and to the matching light-trail state. Kept free of React so
// it can be unit tested.

export type QueueChipStatus = Extract<StatusKey, 'downloaded' | 'downloading' | 'importing' | 'queued' | 'paused' | 'stalled' | 'failed'>;

export interface QueueChip {
  status: QueueChipStatus;
  /** Plain-words cause; always set for failed and stalled. */
  cause?: string | undefined;
  /** Every status message, for the chip's tooltip. */
  detail?: string | undefined;
}

type ChipInput = Pick<QueueItem, 'status' | 'trackedState' | 'trackedStatus' | 'statusMessages' | 'downloadId' | 'downloadClientId'>;

const MAX_CAUSE = 48;

/** Short causes for messages we know; anything else is the first message, trimmed. */
const KNOWN_CAUSES: ReadonlyArray<[RegExp, string]> = [
  [/\bsample\b/i, 'sample only'],
  [/no (connected |active )?(peers|seeds|seeders)|stalled/i, 'no peers'],
  [/unknown (series|show)/i, 'unknown series'],
  [/unknown movie/i, 'unknown movie'],
  [/not enough (free )?(disk )?space|disk (is )?full/i, 'disk full'],
  [/(missing|no) (video )?files?|no files found/i, 'no video files'],
  [/unpack/i, 'still unpacking'],
  [/password|encrypted/i, 'password protected'],
  [/not an upgrade/i, 'not an upgrade'],
];

/** Turn a status message into a short, sentence-case cause ("Sample file" → "sample only"). */
export function causeFromMessage(text: string | undefined): string | undefined {
  const raw = text?.trim();
  if (!raw) return undefined;
  for (const [re, cause] of KNOWN_CAUSES) if (re.test(raw)) return cause;
  let s = raw.replace(/[.\s]+$/, '');
  // Lower-case the first letter unless the first word is an acronym ("VPN down").
  if (!/^[A-Z]{2,}/.test(s)) s = s.charAt(0).toLowerCase() + s.slice(1);
  return s.length > MAX_CAUSE ? `${s.slice(0, MAX_CAUSE - 1).trimEnd()}…` : s;
}

function firstMessage(item: Pick<QueueItem, 'statusMessages'>): string | undefined {
  for (const m of item.statusMessages) {
    const text = m.messages.find((entry) => entry.trim()) ?? m.title;
    if (text.trim()) return text;
  }
  return undefined;
}

function allMessages(item: Pick<QueueItem, 'statusMessages'>): string | undefined {
  const lines = item.statusMessages.flatMap((m) => (m.messages.length ? m.messages.map((row) => (m.title ? `${m.title}: ${row}` : row)) : [m.title]));
  return lines.length ? lines.join('\n') : undefined;
}

/** Status chip for a queue row: label from the fixed vocabulary plus a cause when it needs one. */
export function queueChip(item: ChipInput): QueueChip {
  const detail = allMessages(item);
  const msgCause = causeFromMessage(firstMessage(item));
  const failed = item.trackedState === 'failed' || item.trackedState === 'failedPending' || item.status === 'failed' || item.trackedStatus === 'error';
  if (failed) {
    const fallback = item.trackedState === 'failedPending' ? t('activity.queueStatus.importFailed') : item.status === 'failed' ? t('activity.queueStatus.clientError') : t('activity.queueStatus.downloadFailed');
    return { status: 'failed', cause: msgCause ?? fallback, detail };
  }
  const blocked = item.trackedState === 'importPending' && (item.trackedStatus === 'warning' || item.statusMessages.length > 0);
  if (item.trackedStatus === 'warning' || item.status === 'warning' || blocked) {
    const fallback = item.trackedState === 'importPending' ? t('activity.queueStatus.importBlocked') : t('activity.queueStatus.noPeers');
    return { status: 'stalled', cause: msgCause ?? fallback, detail };
  }
  if (item.trackedState === 'pending' || item.downloadClientId === null || item.downloadId.startsWith('pending:')) return { status: 'queued', detail };
  if (item.trackedState === 'imported') return { status: 'downloaded', detail };
  if (item.trackedState === 'importing' || item.trackedState === 'importPending') return { status: 'importing', detail };
  switch (item.status) {
    case 'paused':
      return { status: 'paused', detail };
    case 'queued':
    case 'unknown':
      return { status: 'queued', detail };
    case 'completed':
    case 'seeding':
      return { status: 'importing', detail };
    default:
      return { status: 'downloading', detail };
  }
}

const TRAIL_STATES: Record<QueueChipStatus, TrailState> = {
  downloading: 'active',
  importing: 'complete',
  downloaded: 'complete',
  queued: 'queued',
  paused: 'paused',
  stalled: 'stalled',
  failed: 'failed',
};

/** Trail state that matches a chip: only a live download glows. */
export function trailState(chip: QueueChip | QueueChipStatus): TrailState {
  return TRAIL_STATES[typeof chip === 'string' ? chip : chip.status];
}

/** Resolution + source from a release title ("1080p WEB-DL"), or null when it names neither. */
export function qualityFromTitle(title: string): string | null {
  const res = /\b(2160p|1080p|720p|576p|480p|4k)\b/i.exec(title)?.[1];
  // Remux wins over the BluRay it was cut from.
  const src = /\b(remux)\b/i.exec(title)?.[1] ?? /\b(blu-?ray|web-?dl|webrip|hdtv|dvdrip|dvd)\b/i.exec(title)?.[1];
  const norm: Record<string, string> = { bluray: 'BluRay', 'blu-ray': 'BluRay', webdl: 'WEB-DL', 'web-dl': 'WEB-DL', webrip: 'WEBRip', hdtv: 'HDTV', remux: 'Remux', dvdrip: 'DVDRip', dvd: 'DVD' };
  const parts = [res ? (res.toLowerCase() === '4k' ? '2160p' : res.toLowerCase()) : null, src ? (norm[src.toLowerCase()] ?? src) : null].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

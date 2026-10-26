import { normalizeEta } from '../http.js';
import { joinRemotePath } from '../paths.js';
import type { DownloadItem, DownloadItemStatus } from '../types.js';
import type { RTorrentTorrent } from './schemas.js';

/**
 * Labels live in `d.custom1`. ruTorrent URI-encodes labels when it writes them and decodes
 * them when it reads, so Media-Tron writes `encodeURIComponent(label)` too: a label set by
 * either side then shows the same in ruTorrent. For plain ASCII labels such as "tv" or
 * "media-tron" the encoded and plain forms are identical.
 */
export function encodeLabel(label: string): string {
  return encodeURIComponent(label);
}

/** Decodes a `d.custom1` value; values that are not valid URI encoding are returned as-is. */
export function decodeLabel(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

interface StateMapping {
  status: DownloadItemStatus;
  message?: string;
}

/**
 * Maps rTorrent's flags to a normalized status.
 *
 * rTorrent has two "not running" notions: stopped (`d.state` 0, via d.stop) and paused
 * (started but `d.is_active` 0, via d.pause). A finished torrent that is stopped has no
 * seeding left to do as far as we can see; a finished torrent that is merely paused will
 * seed again on resume, so it stays `seeding` (import-ready but read-only).
 */
export function mapRTorrentState(torrent: RTorrentTorrent): StateMapping {
  const message = torrent.message.trim();
  if (torrent.hashChecking) {
    return { status: 'queued', message: 'rTorrent is checking the data' };
  }
  if (!torrent.started) {
    return torrent.complete ? { status: 'completed' } : { status: 'paused' };
  }
  if (!torrent.active) {
    return torrent.complete ? { status: 'seeding', message: 'Seeding is paused' } : { status: 'paused' };
  }
  if (torrent.complete) {
    return message === '' ? { status: 'seeding' } : { status: 'seeding', message };
  }
  if (torrent.sizeBytes === 0) {
    // A magnet link whose metadata has not arrived yet.
    return { status: 'queued', message: 'Downloading metadata' };
  }
  if (message !== '') {
    // Tracker errors are often transient and DHT/PEX may still deliver peers: warn only
    // while nothing is downloading, never fail.
    return torrent.downRate === 0 ? { status: 'warning', message } : { status: 'downloading', message };
  }
  return { status: 'downloading' };
}

/**
 * Where the content lives. `d.base_path` is only set while the torrent is open; otherwise
 * it is rebuilt from `d.directory`, which for multi-file torrents already is the torrent's
 * own folder and for single-file torrents is the containing folder.
 */
export function outputPathOf(torrent: RTorrentTorrent): string {
  if (torrent.basePath !== '') return torrent.basePath;
  return torrent.isMultiFile ? torrent.directory : joinRemotePath(torrent.directory, torrent.name);
}

/**
 * Converts one `d.multicall2` row to a `DownloadItem`.
 *
 * rTorrent's API has no per-torrent seed ratio/time limits (those live in ratio groups or
 * scheduler commands in .rtorrent.rc). We therefore assume that whatever stops a finished
 * torrent is the user's seeding policy: finished + stopped is `completed` and removable;
 * finished + still started (seeding or paused) is read-only.
 */
export function mapTorrent(torrent: RTorrentTorrent): DownloadItem {
  const mapped = mapRTorrentState(torrent);
  const totalBytes = torrent.sizeBytes;
  const remainingBytes = Math.min(totalBytes, torrent.complete ? 0 : torrent.leftBytes);
  const downloadedBytes = totalBytes - remainingBytes;
  const progress = totalBytes > 0 ? Math.min(1, downloadedBytes / totalBytes) : torrent.complete ? 1 : 0;
  const finished = torrent.complete && !torrent.hashChecking;
  const removable = finished && !torrent.started;

  const item: DownloadItem = {
    id: torrent.hash.toLowerCase(),
    title: torrent.name,
    category: decodeLabel(torrent.label),
    totalBytes,
    remainingBytes,
    downloadedBytes,
    progress,
    status: mapped.status,
    outputPath: outputPathOf(torrent),
    isReadOnly: finished && !removable,
    canMoveFiles: removable,
    canBeRemoved: removable,
  };
  if (mapped.message !== undefined) item.statusMessage = mapped.message;
  const eta = finished
    ? 0
    : torrent.started && torrent.active && torrent.downRate > 0
      ? normalizeEta(remainingBytes / torrent.downRate)
      : undefined;
  if (eta !== undefined) item.etaSeconds = eta;
  return item;
}

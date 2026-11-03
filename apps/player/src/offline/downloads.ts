import type { PluginListenerHandle } from '@capacitor/core';
import type { PlayableItem } from '@arclight/shared';
import { appPlaybackApi } from '../core/api';
import { absoluteUrl } from '../core/session';
import { qualityRequest, type AppSettings, type StreamQuality } from '../core/settings';
import type { ArclightPlayerPlugin, DownloadTask } from '../native/definitions';
import { DownloadIndex, entryStatus, type DownloadEntry, type DownloadedFile } from './download-index';

// Offline copies: asks the server for download links, hands them to the native downloader
// (which keeps going in the background), and keeps the index in step with its events.

const GB = 1024 ** 3;

export class DownloadError extends Error {
  constructor(
    readonly code: 'unavailable' | 'storage-limit' | 'no-space' | 'not-signed-in',
    message: string,
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

export interface DownloadDeps {
  /** The native plugin, or null when this build has no downloads. */
  plugin: ArclightPlayerPlugin | null;
  index: DownloadIndex;
  settings: () => AppSettings;
  /** The server's bitrate cap (PlayerCapabilities.maxBitrateKbps). */
  maxBitrateKbps?: () => number | null | undefined;
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, '-');

function extensionFor(item: PlayableItem, partIndex: number, quality: StreamQuality): string {
  if (quality !== 'original') return 'm4a';
  const p = item.parts[partIndex];
  const c = (p?.container || p?.codec || '').toLowerCase();
  if (/^[a-z0-9]{2,5}$/.test(c)) return c === 'mp4' ? 'm4a' : c;
  return 'audio';
}

/** "/api/v1/playback/artwork/album/12?u=…" → "album-12" (shared by every track of the album). */
export function artworkKey(url: string): string | null {
  const m = /\/playback\/artwork\/([a-z]+)\/(\d+)/.exec(url);
  return m ? `${m[1]}-${m[2]}` : null;
}

export class DownloadManager {
  private handles: PluginListenerHandle[] = [];

  constructor(private readonly deps: DownloadDeps) {}

  get available(): boolean {
    return this.deps.plugin !== null;
  }

  /** Subscribes to native download events and reconciles the index with what native has. */
  async start(): Promise<void> {
    const plugin = this.deps.plugin;
    await this.deps.index.load();
    if (!plugin) return;
    this.handles.push(
      await plugin.addListener('downloadProgress', (e) => void this.deps.index.updateTask(e.id, { status: 'running', bytesWritten: e.bytesWritten, totalBytes: e.totalBytes })),
      await plugin.addListener('downloadCompleted', (e) =>
        void this.deps.index.updateTask(e.id, { status: 'completed', path: e.path, uri: e.uri, bytesWritten: e.sizeBytes, totalBytes: e.sizeBytes }),
      ),
      await plugin.addListener('downloadFailed', (e) => void this.deps.index.updateTask(e.id, { status: 'failed', error: e.message })),
    );
    await this.applyPolicy();
    await this.reconcile();
  }

  async stop(): Promise<void> {
    for (const h of this.handles) await h.remove();
    this.handles = [];
  }

  /** Wi-Fi-only rule for downloads already queued. */
  async applyPolicy(): Promise<void> {
    await this.deps.plugin?.setDownloadPolicy({ wifiOnly: this.deps.settings().downloadsWifiOnly });
  }

  /** Native's task list is the truth for status (events may have been missed while the app was closed). */
  async reconcile(): Promise<void> {
    const plugin = this.deps.plugin;
    if (!plugin) return;
    const { tasks } = await plugin.listDownloads();
    for (const t of tasks) await this.deps.index.updateTask(t.id, fromTask(t));
  }

  /** Space used by downloads and free on the device; null without the native plugin. */
  async storageInfo(): Promise<{ usedBytes: number; freeBytes: number } | null> {
    const plugin = this.deps.plugin;
    if (!plugin) return null;
    try {
      return await plugin.getStorageInfo();
    } catch {
      return null;
    }
  }

  private async checkSpace(extraBytes: number): Promise<void> {
    const plugin = this.deps.plugin;
    if (!plugin) return;
    const s = this.deps.settings();
    const info = await plugin.getStorageInfo();
    if (s.storageLimitGb > 0 && info.usedBytes + extraBytes > s.storageLimitGb * GB) throw new DownloadError('storage-limit', 'Over the download storage limit');
    if (info.freeBytes > 0 && info.freeBytes - extraBytes < s.keepFreeGb * GB) throw new DownloadError('no-space', 'Not enough free space on this device');
  }

  /** Downloads items (tracks or audiobooks) for an account. Already-downloaded items are skipped. */
  async download(accountId: string, itemKeys: readonly string[]): Promise<DownloadEntry[]> {
    const plugin = this.deps.plugin;
    if (!plugin) throw new DownloadError('unavailable', 'Downloads need the native app');
    await this.deps.index.load();
    const wanted = itemKeys.filter((k) => {
      const e = this.deps.index.get(accountId, k);
      return !e || entryStatus(e) === 'failed';
    });
    if (wanted.length === 0) return [];
    const items: PlayableItem[] = [];
    for (let i = 0; i < wanted.length; i += 200) items.push(...(await appPlaybackApi.items(wanted.slice(i, i + 200))));
    const expected = items.reduce((n, it) => n + it.parts.reduce((m, p) => m + (p.sizeBytes ?? 0), 0), 0);
    await this.checkSpace(expected);

    const s = this.deps.settings();
    const quality = s.downloadQuality;
    const req = qualityRequest(quality, this.deps.maxBitrateKbps?.());
    const out: DownloadEntry[] = [];
    for (const item of items) {
      const links = await appPlaybackApi.streamLinks(item.itemKey, { ...req, download: true });
      const parts: DownloadedFile[] = [];
      for (let i = 0; i < item.parts.length; i++) {
        const part = item.parts[i]!;
        const link = links.links.find((l) => l.fileId === part.fileId) ?? links.links[i];
        if (!link) throw new Error(`No download link for ${item.itemKey} part ${i}`);
        const taskId = `${accountId}:${item.itemKey}#${i}`;
        const destName = `${safe(accountId)}/${safe(item.itemKey)}-${i}.${extensionFor(item, i, quality)}`;
        const { task } = await plugin.enqueueDownload({
          id: taskId,
          url: absoluteUrl(link.url),
          destName,
          wifiOnly: s.downloadsWifiOnly,
          title: item.title,
          ...(quality === 'original' && part.sizeBytes ? { expectedBytes: part.sizeBytes } : {}),
        });
        parts.push({ taskId, destName, ...fromTask(task) });
      }
      let artwork: DownloadedFile | null = null;
      const art = item.artworkUrl ? artworkKey(item.artworkUrl) : null;
      if (item.artworkUrl && art) {
        const taskId = `${accountId}:art:${art}`;
        const destName = `${safe(accountId)}/art-${art}.img`;
        try {
          const { task } = await plugin.enqueueDownload({ id: taskId, url: item.artworkUrl, destName, wifiOnly: s.downloadsWifiOnly });
          artwork = { taskId, destName, ...fromTask(task) };
        } catch {
          artwork = null;
        }
      }
      const entry: DownloadEntry = { accountId, itemKey: item.itemKey, item, parts, artwork, quality, addedAt: new Date().toISOString() };
      await this.deps.index.put(entry);
      out.push(entry);
    }
    return out;
  }

  /** Deletes an item's files (the cover stays while another download uses it). */
  async remove(accountId: string, itemKey: string): Promise<void> {
    const e = this.deps.index.get(accountId, itemKey);
    if (!e) return;
    const plugin = this.deps.plugin;
    const files = [...e.parts, ...(e.artwork ? [e.artwork] : [])];
    for (const f of files) {
      if (this.deps.index.isShared(f.taskId, e)) continue;
      try {
        if (f.status === 'completed') await plugin?.deleteDownload({ destName: f.destName });
        else await plugin?.cancelDownload({ id: f.taskId });
      } catch {
        /* already gone */
      }
    }
    await this.deps.index.remove(accountId, itemKey);
  }

  async removeAll(accountId: string): Promise<void> {
    for (const e of this.deps.index.all(accountId)) await this.remove(accountId, e.itemKey);
  }

  /** Retry the failed parts of an entry with fresh links. */
  async retry(accountId: string, itemKey: string): Promise<void> {
    await this.remove(accountId, itemKey);
    await this.download(accountId, [itemKey]);
  }

  async pause(accountId: string, itemKey: string): Promise<void> {
    const e = this.deps.index.get(accountId, itemKey);
    for (const p of e?.parts ?? []) if (p.status !== 'completed') await this.deps.plugin?.pauseDownload({ id: p.taskId });
  }

  async resume(accountId: string, itemKey: string): Promise<void> {
    const e = this.deps.index.get(accountId, itemKey);
    for (const p of e?.parts ?? []) if (p.status === 'paused') await this.deps.plugin?.resumeDownload({ id: p.taskId });
  }
}

function fromTask(t: DownloadTask): Omit<DownloadedFile, 'taskId' | 'destName'> {
  return {
    status: t.status === 'queued' ? 'queued' : t.status,
    bytesWritten: t.bytesWritten,
    totalBytes: t.totalBytes,
    ...(t.path ? { path: t.path } : {}),
    ...(t.reason && t.status === 'failed' ? { error: t.reason } : {}),
  };
}

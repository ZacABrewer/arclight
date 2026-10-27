import { z } from 'zod';
import { DownloadClientError, type ClientRuntime } from '../types.js';
import { QbtCategories, QbtPreferences, tolerantList } from './schemas.js';
import { QBittorrentSession } from './session.js';

/**
 * Read access to a whole qBittorrent instance, for importers: every torrent with its transfer
 * totals, limits and dates, categories, preferences, the file list and the .torrent export.
 * The only writes are `pause` and `removeKeepFiles`, which an importer calls after an explicit
 * user confirmation.
 */

export const QbtInventoryTorrent = z.object({
  hash: z.string(),
  name: z.string(),
  category: z.string().optional(),
  /** Comma separated (API 2.0.2+). */
  tags: z.string().optional(),
  save_path: z.string(),
  content_path: z.string().optional(),
  /** Incomplete-download folder (qBittorrent 4.4+); empty when not used. */
  download_path: z.string().optional(),
  /** Bytes selected for download. */
  size: z.number(),
  /** Bytes of the whole torrent. */
  total_size: z.number().optional(),
  progress: z.number(),
  amount_left: z.number().optional(),
  state: z.string(),
  /** Unix seconds. */
  added_on: z.number().optional(),
  /** Unix seconds; -1 or a value before added_on when not completed. */
  completion_on: z.number().optional(),
  /** All-time bytes. */
  uploaded: z.number().optional(),
  downloaded: z.number().optional(),
  /** -2 = global limit, -1 = none. */
  ratio_limit: z.number().optional(),
  /** Minutes. -2 = global limit, -1 = none. */
  seeding_time_limit: z.number().optional(),
  /** Effective limits after resolving -2. */
  max_ratio: z.number().optional(),
  max_seeding_time: z.number().optional(),
  /** Seconds. */
  seeding_time: z.number().optional(),
  /** Seconds. */
  time_active: z.number().optional(),
  tracker: z.string().optional(),
  private: z.boolean().optional(),
});
export type QbtInventoryTorrent = z.infer<typeof QbtInventoryTorrent>;

export const QbtInventoryFile = z.object({
  name: z.string(),
  size: z.number(),
  progress: z.number().optional(),
  /** 0 = do not download, 1 normal, 6 high, 7 maximal. */
  priority: z.number().optional(),
  /** API 2.8.2+: position in the torrent. */
  index: z.number().optional(),
});
export type QbtInventoryFile = z.infer<typeof QbtInventoryFile>;

export interface QBittorrentInventoryOptions {
  /** WebUI root, e.g. `http://qbittorrent:8080`. */
  baseUrl: string;
  username: string;
  password: string;
}

type ApiVersion = readonly [number, number, number];

function parseVersion(text: string): ApiVersion {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(text.trim());
  if (!m) throw new DownloadClientError('bad-response', `Unrecognised qBittorrent API version "${text}".`);
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

function atLeast(v: ApiVersion, major: number, minor: number, patch: number): boolean {
  if (v[0] !== major) return v[0] > major;
  if (v[1] !== minor) return v[1] > minor;
  return v[2] >= patch;
}

export class QBittorrentInventory {
  private readonly session: QBittorrentSession;
  private api: ApiVersion | undefined;

  constructor(opts: QBittorrentInventoryOptions, runtime: ClientRuntime) {
    this.session = new QBittorrentSession({ baseUrl: opts.baseUrl.replace(/\/+$/, ''), username: opts.username, password: opts.password }, runtime);
  }

  private async apiVersion(): Promise<ApiVersion> {
    this.api ??= parseVersion(await this.session.requestText('/api/v2/app/webapiVersion'));
    return this.api;
  }

  /** qBittorrent version (e.g. `5.0.2`) and Web API version (e.g. `2.11.2`). Logs in when needed. */
  async version(): Promise<{ app: string; api: string }> {
    const api = await this.apiVersion();
    const app = (await this.session.requestText('/api/v2/app/version')).trim().replace(/^v/, '');
    return { app, api: api.join('.') };
  }

  torrents(): Promise<QbtInventoryTorrent[]> {
    return this.session.requestJson('/api/v2/torrents/info', tolerantList(QbtInventoryTorrent));
  }

  categories(): Promise<QbtCategories> {
    return this.session.requestJson('/api/v2/torrents/categories', QbtCategories);
  }

  preferences(): Promise<QbtPreferences> {
    return this.session.requestJson('/api/v2/app/preferences', QbtPreferences);
  }

  files(hash: string): Promise<QbtInventoryFile[]> {
    return this.session.requestJson('/api/v2/torrents/files', z.array(QbtInventoryFile), { query: { hash: hash.toLowerCase() } });
  }

  /** The torrent's .torrent file. Needs qBittorrent 4.5 or newer (Web API 2.8.14). */
  async exportTorrent(hash: string): Promise<Uint8Array> {
    const api = await this.apiVersion();
    if (!atLeast(api, 2, 8, 14)) {
      throw new DownloadClientError('not-supported', 'Exporting .torrent files needs qBittorrent 4.5 or newer; read its BT_backup folder instead (files mode).');
    }
    return this.session.requestBytes('/api/v2/torrents/export', { query: { hash: hash.toLowerCase() } });
  }

  /** Pauses (qBittorrent 4) or stops (qBittorrent 5) the torrents. */
  async pause(hashes: readonly string[]): Promise<void> {
    if (hashes.length === 0) return;
    const api = await this.apiVersion();
    const path = atLeast(api, 2, 11, 0) ? '/api/v2/torrents/stop' : '/api/v2/torrents/pause';
    await this.session.requestText(path, { body: { hashes: hashes.map((h) => h.toLowerCase()).join('|') } });
  }

  /** Resumes (qBittorrent 4) or starts (qBittorrent 5) the torrents; used to undo a pause after a failed hand-over. */
  async resume(hashes: readonly string[]): Promise<void> {
    if (hashes.length === 0) return;
    const api = await this.apiVersion();
    const path = atLeast(api, 2, 11, 0) ? '/api/v2/torrents/start' : '/api/v2/torrents/resume';
    await this.session.requestText(path, { body: { hashes: hashes.map((h) => h.toLowerCase()).join('|') } });
  }

  /** Removes the torrents from qBittorrent and keeps their files on disk. */
  async removeKeepFiles(hashes: readonly string[]): Promise<void> {
    if (hashes.length === 0) return;
    await this.session.requestText('/api/v2/torrents/delete', { body: { hashes: hashes.map((h) => h.toLowerCase()).join('|'), deleteFiles: 'false' } });
  }
}

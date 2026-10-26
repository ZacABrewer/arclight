import { QBittorrentClient, QBittorrentSettings } from './qbittorrent/client.js';
import type { ClientRuntime, DownloadClient } from './types.js';

export {
  DownloadClientError,
  type AddTorrentInput,
  type AddTorrentResult,
  type ClientRuntime,
  type DownloadClient,
  type DownloadClientErrorCode,
  type DownloadClientStatus,
  type DownloadClientTestResult,
  type DownloadItem,
  type DownloadItemStatus,
} from './types.js';
export { QBittorrentSettings } from './qbittorrent/client.js';
export { hashFromMagnet, hashFromTorrentFile, TorrentParseError } from './torrent-hash.js';

const DEFAULT_RUNTIME: ClientRuntime = {
  fetch: (input, init) => globalThis.fetch(input, init),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  requestTimeoutMs: 30_000,
};

/**
 * Creates a qBittorrent (WebUI API v2, qBittorrent 4.1+) client. Settings are validated;
 * an invalid shape throws a ZodError. `runtime` overrides are for tests and tuning.
 */
export function createQBittorrentClient(
  settings: QBittorrentSettings,
  runtime: Partial<ClientRuntime> = {},
): DownloadClient {
  const parsed = QBittorrentSettings.parse(settings);
  return new QBittorrentClient(parsed, { ...DEFAULT_RUNTIME, ...runtime });
}

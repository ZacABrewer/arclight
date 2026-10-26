import { z } from 'zod';
import { BuiltinClient, type SessionSource } from './builtin/client.js';
import { BuiltinSettings, type BuiltinSettingsInput } from './builtin/settings.js';
import { DelugeClient } from './deluge/client.js';
import { DelugeSettings, type DelugeSettingsInput } from './deluge/settings.js';
import { NzbgetClient } from './nzbget/client.js';
import { NzbgetSettings, type NzbgetSettingsInput } from './nzbget/settings.js';
import { QBittorrentClient, QBittorrentSettings } from './qbittorrent/client.js';
import { RTorrentClient } from './rtorrent/client.js';
import { RTorrentSettings, type RTorrentSettingsInput } from './rtorrent/settings.js';
import { SabnzbdClient } from './sabnzbd/client.js';
import { SabnzbdSettings, type SabnzbdSettingsInput } from './sabnzbd/settings.js';
import { TransmissionClient } from './transmission/client.js';
import { TransmissionSettings, type TransmissionSettingsInput } from './transmission/settings.js';
import type { ClientRuntime, DownloadClient, DownloadProtocol } from './types.js';

export {
  DownloadClientError,
  type AddNzbInput,
  type AddNzbResult,
  type AddTorrentInput,
  type AddTorrentResult,
  type ClientRuntime,
  type DownloadClient,
  type DownloadClientErrorCode,
  type DownloadClientStatus,
  type DownloadClientTestResult,
  type DownloadItem,
  type DownloadItemStatus,
  type DownloadProtocol,
  type UsenetPriority,
} from './types.js';
export { QBittorrentSettings } from './qbittorrent/client.js';
export { TransmissionPriority, TransmissionSettings, type TransmissionSettingsInput } from './transmission/settings.js';
export { DelugePriority, DelugeSettings, type DelugeSettingsInput } from './deluge/settings.js';
export { RTorrentPriority, RTorrentSettings, type RTorrentSettingsInput } from './rtorrent/settings.js';
export { SabnzbdPriority, SabnzbdSettings, type SabnzbdSettingsInput } from './sabnzbd/settings.js';
export { NzbgetSettings, type NzbgetSettingsInput } from './nzbget/settings.js';
export { BuiltinSettings, type BuiltinSettingsInput } from './builtin/settings.js';
export { BuiltinClient, type SessionSource } from './builtin/client.js';
export { hashFromMagnet, hashFromTorrentFile, TorrentParseError } from './torrent-hash.js';

const DEFAULT_RUNTIME: ClientRuntime = {
  fetch: (input, init) => globalThis.fetch(input, init),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  requestTimeoutMs: 30_000,
};

function runtimeWith(overrides: Partial<ClientRuntime>): ClientRuntime {
  return { ...DEFAULT_RUNTIME, ...overrides };
}

/**
 * Creates a qBittorrent (WebUI API v2, qBittorrent 4.1+) client. Settings are validated;
 * an invalid shape throws a ZodError. `runtime` overrides are for tests and tuning.
 */
export function createQBittorrentClient(
  settings: QBittorrentSettings,
  runtime: Partial<ClientRuntime> = {},
): DownloadClient {
  const parsed = QBittorrentSettings.parse(settings);
  return new QBittorrentClient(parsed, runtimeWith(runtime));
}

/** Transmission RPC (2.80+, rpc-version 14+). Labels are used from rpc-version 16. */
export function createTransmissionClient(
  settings: TransmissionSettingsInput,
  runtime: Partial<ClientRuntime> = {},
): DownloadClient {
  return new TransmissionClient(TransmissionSettings.parse(settings), runtimeWith(runtime));
}

/** Deluge Web UI JSON-RPC (1.3+/2.x) with the Label plugin for categories. */
export function createDelugeClient(settings: DelugeSettingsInput, runtime: Partial<ClientRuntime> = {}): DownloadClient {
  return new DelugeClient(DelugeSettings.parse(settings), runtimeWith(runtime));
}

/** rTorrent XML-RPC over HTTP (0.9.6+), label in d.custom1 (ruTorrent compatible). */
export function createRTorrentClient(settings: RTorrentSettingsInput, runtime: Partial<ClientRuntime> = {}): DownloadClient {
  return new RTorrentClient(RTorrentSettings.parse(settings), runtimeWith(runtime));
}

/** SABnzbd HTTP API (1.0+, 3.0+ recommended). */
export function createSabnzbdClient(settings: SabnzbdSettingsInput, runtime: Partial<ClientRuntime> = {}): DownloadClient {
  return new SabnzbdClient(SabnzbdSettings.parse(settings), runtimeWith(runtime));
}

/** NZBGet JSON-RPC (16+). */
export function createNzbgetClient(settings: NzbgetSettingsInput, runtime: Partial<ClientRuntime> = {}): DownloadClient {
  return new NzbgetClient(NzbgetSettings.parse(settings), runtimeWith(runtime));
}

/**
 * The in-process torrent engine. `session` is the api's Session, or a getter returning it
 * (null while the engine is disabled/stopped). The client never starts or stops the Session.
 */
export function createBuiltinClient(settings: BuiltinSettingsInput, session: SessionSource): DownloadClient {
  return new BuiltinClient(BuiltinSettings.parse(settings), session);
}

/** Every client implementation this package can drive. */
export const DownloadClientKind = z.enum(['qbittorrent', 'transmission', 'deluge', 'rtorrent', 'sabnzbd', 'nzbget', 'builtin']);
export type DownloadClientKind = z.infer<typeof DownloadClientKind>;

/** Settings schema per kind, for validation and for rendering settings forms. */
export const downloadClientSettingsSchemas = {
  qbittorrent: QBittorrentSettings,
  transmission: TransmissionSettings,
  deluge: DelugeSettings,
  rtorrent: RTorrentSettings,
  sabnzbd: SabnzbdSettings,
  nzbget: NzbgetSettings,
  builtin: BuiltinSettings,
} as const satisfies Record<DownloadClientKind, z.ZodType>;

/** Accepted (pre-default) settings shape for a kind. */
export type DownloadClientSettingsInput<K extends DownloadClientKind> = z.input<(typeof downloadClientSettingsSchemas)[K]>;

export const downloadClientProtocols: Readonly<Record<DownloadClientKind, DownloadProtocol>> = {
  qbittorrent: 'torrent',
  transmission: 'torrent',
  deluge: 'torrent',
  rtorrent: 'torrent',
  sabnzbd: 'usenet',
  nzbget: 'usenet',
  builtin: 'torrent',
};

/** In-process dependencies some kinds need (in addition to the HTTP `runtime`). */
export interface DownloadClientDeps {
  /** The api's torrent engine Session (or a getter; null when stopped). */
  torrentSession?: SessionSource;
}

/**
 * Creates a client of the given kind. Settings are validated with that kind's schema; an
 * invalid shape or an unknown kind throws a ZodError. A `builtin` client without
 * `deps.torrentSession` throws `DownloadClientError('unreachable')` from every method.
 */
export function createDownloadClient<K extends DownloadClientKind>(
  kind: K,
  settings: DownloadClientSettingsInput<K>,
  runtime: Partial<ClientRuntime> = {},
  deps: DownloadClientDeps = {},
): DownloadClient {
  const parsedKind: DownloadClientKind = DownloadClientKind.parse(kind);
  // Narrowing `kind` does not narrow the generic `settings`, so each branch validates the
  // raw value with its own schema.
  const raw: unknown = settings;
  switch (parsedKind) {
    case 'qbittorrent':
      return createQBittorrentClient(QBittorrentSettings.parse(raw), runtime);
    case 'transmission':
      return createTransmissionClient(TransmissionSettings.parse(raw), runtime);
    case 'deluge':
      return createDelugeClient(DelugeSettings.parse(raw), runtime);
    case 'rtorrent':
      return createRTorrentClient(RTorrentSettings.parse(raw), runtime);
    case 'sabnzbd':
      return createSabnzbdClient(SabnzbdSettings.parse(raw), runtime);
    case 'nzbget':
      return createNzbgetClient(NzbgetSettings.parse(raw), runtime);
    case 'builtin':
      return createBuiltinClient(BuiltinSettings.parse(raw), deps.torrentSession ?? (() => null));
  }
}

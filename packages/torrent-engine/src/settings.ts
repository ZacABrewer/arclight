import { DEFAULT_BOOTSTRAP_NODES } from './dht/dht.js';
import type { EncryptionMode } from './peer/mse.js';

export interface CategoryConfig {
  /** Where torrents of this category download to. */
  savePath: string;
  /** Optional move-on-completion target for this category. */
  completedSavePath?: string;
}

/** Session settings. Every field has a default; see `DEFAULT_SETTINGS`. */
export interface SessionSettings {
  /** TCP (peers) and UDP (DHT) port. 0 picks a random free port. */
  listenPort: number;
  /**
   * Address to bind every socket to: the peer listener, outgoing peer connections, DHT and
   * tracker requests. Set it to the VPN interface address so traffic cannot leave through
   * another interface (if the VPN drops, sockets fail instead of leaking). null = all interfaces.
   */
  listenAddress: string | null;
  maxConnections: number;
  maxConnectionsPerTorrent: number;
  /**
   * Outgoing connection attempts in flight at once, across all torrents. Every attempt is a
   * socket (and a NAT/conntrack entry in a VPN container); hundreds at once flooded gluetun
   * until its control API and DNS stopped answering.
   */
  maxHalfOpenConnections: number;
  /** New outgoing peer connection attempts per second, session-wide (libtorrent's connection_speed). */
  connectionsPerSecond: number;
  /** DHT upload budget in bytes/s (0 = unlimited; libtorrent's dht_upload_rate_limit). */
  dhtUploadRateLimit: number;
  /** Global upload limit in bytes/s (0 = unlimited). */
  uploadLimit: number;
  /** Global download limit in bytes/s (0 = unlimited). */
  downloadLimit: number;
  dht: boolean;
  pex: boolean;
  /**
   * Message Stream Encryption. `preferred`: outgoing connections try MSE first and fall back
   * to plaintext; incoming accept both. `required`: only encrypted (RC4) connections.
   * `disabled`: plaintext only.
   */
  encryption: EncryptionMode;
  /** Accept and open TCP peer connections. */
  tcp: boolean;
  /** Accept and open uTP (BEP 29) peer connections on the UDP listen port (shared with the DHT). */
  utp: boolean;
  /** Listen on IPv6 too (`::`) when available and `listenAddress` is null; use IPv6 peers. */
  ipv6: boolean;
  /** Concurrent HTTP requests to web seeds (BEP 19) per torrent. 0 disables web seeds. */
  webSeedConnectionsPerTorrent: number;
  /** Base back-off after a web seed error, doubled per consecutive failure. */
  webSeedRetryMs: number;
  /** Default share ratio after which seeding stops (null = unlimited). */
  seedRatioLimit: number | null;
  /** Default seeding time after which seeding stops, in ms (null = unlimited). */
  seedTimeLimitMs: number | null;
  /** What happens when a seed limit is reached. The `seedLimitReached` event fires either way. */
  seedLimitAction: 'pause' | 'remove' | 'none';
  /** 8-character Azureus-style peer id prefix. */
  peerIdPrefix: string;
  /** Client name sent in the extension handshake and tracker User-Agent. */
  userAgent: string;
  /** Default download directory. */
  savePath: string;
  /** Global move-on-completion target (null = keep in place). */
  completedSavePath: string | null;
  categories: Record<string, CategoryConfig>;
  /** Directory for fast-resume data and saved .torrent files (null = no persistence). */
  resumeDataDir: string | null;
  /** Max torrents downloading at once (-1 = unlimited). Others wait in `queued`. */
  maxActiveDownloads: number;
  /** Max torrents seeding at once (-1 = unlimited). */
  maxActiveSeeds: number;
  dhtBootstrapNodes: string[];
  announceToAllTiers: boolean;
  /** Suffix for files still downloading (null = none). */
  incompleteExtension: string | null;
  /** Unchoke slots per torrent (including the optimistic one). */
  uploadSlotsPerTorrent: number;
  chokeIntervalMs: number;
  requestTimeoutMs: number;
  connectTimeoutMs: number;
  /** Lower bound for tracker re-announces in seconds. */
  trackerMinIntervalSec: number;
  /** Base delay before retrying a failed tracker in seconds. */
  trackerRetrySec: number;
  dhtAnnounceIntervalMs: number;
  pexIntervalMs: number;
  /** Torrent housekeeping period (connect, request, timeouts, stats). */
  tickIntervalMs: number;
  /** Delay before reconnecting to a peer that failed or disconnected. */
  peerRetryMs: number;
  /** Block cache per torrent in bytes. */
  cacheBytesPerTorrent: number;
  /** How often resume data is written while running (ms). */
  resumeSaveIntervalMs: number;
}

export const DEFAULT_SETTINGS: SessionSettings = {
  listenPort: 6881,
  listenAddress: null,
  maxConnections: 200,
  maxConnectionsPerTorrent: 50,
  maxHalfOpenConnections: 20,
  connectionsPerSecond: 10,
  dhtUploadRateLimit: 8000,
  uploadLimit: 0,
  downloadLimit: 0,
  dht: true,
  pex: true,
  encryption: 'preferred',
  tcp: true,
  utp: true,
  ipv6: true,
  webSeedConnectionsPerTorrent: 4,
  webSeedRetryMs: 30_000,
  seedRatioLimit: null,
  seedTimeLimitMs: null,
  seedLimitAction: 'pause',
  peerIdPrefix: '-AL0100-',
  userAgent: 'Arclight/0.1.0',
  savePath: 'downloads',
  completedSavePath: null,
  categories: {},
  resumeDataDir: null,
  maxActiveDownloads: 3,
  maxActiveSeeds: 5,
  dhtBootstrapNodes: DEFAULT_BOOTSTRAP_NODES,
  announceToAllTiers: true,
  incompleteExtension: null,
  uploadSlotsPerTorrent: 4,
  chokeIntervalMs: 10_000,
  requestTimeoutMs: 30_000,
  connectTimeoutMs: 10_000,
  trackerMinIntervalSec: 60,
  trackerRetrySec: 30,
  dhtAnnounceIntervalMs: 15 * 60_000,
  pexIntervalMs: 60_000,
  tickIntervalMs: 1000,
  peerRetryMs: 30_000,
  cacheBytesPerTorrent: 32 * 1024 * 1024,
  resumeSaveIntervalMs: 5 * 60_000,
};

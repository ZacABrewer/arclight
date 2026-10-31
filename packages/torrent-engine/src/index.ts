/**
 * `@arclight/torrent-engine`: a clean-room BitTorrent client library built on Node
 * built-ins only.
 *
 * Most callers need just `Session`:
 *
 * ```ts
 * const session = new Session({ settings: { savePath: '/downloads', listenAddress: '10.8.0.2' } });
 * await session.start();
 * const torrent = await session.addTorrent({ magnet, category: 'tv' });
 * session.onCompleted((t) => console.log(t.getStats().contentPath));
 * ```
 *
 * The lower layers (bencode, metainfo, trackers, DHT, peer wire, storage, picker) are
 * exported for tools and tests.
 */

// ---- session and torrents -------------------------------------------------------------------

/** Manages many torrents: listener, DHT, rate limits, queueing, persistence, events. */
export { Session, generatePeerId, ipv6Available, torrentFileFromInfo } from './session.js';
export type { AddTorrentOptions, DiskStats, QueueMove, SessionEvents, SessionOptions, SessionStats } from './session.js';
/** One torrent's state machine; obtained from `Session.addTorrent` / `getTorrent`. */
export { Torrent } from './torrent.js';
export type { FileStats, PeerSource, PeerStats, TorrentEvents, TorrentRateLimits, TorrentState, TorrentStats } from './torrent.js';
export { DEFAULT_SETTINGS } from './settings.js';
export type { CategoryConfig, SessionSettings } from './settings.js';
export { TorrentEngineError } from './errors.js';
export type { TorrentEngineErrorCode } from './errors.js';

// ---- metadata -------------------------------------------------------------------------------

/** Bencode encoder/decoder (Buffers for byte strings, strict validation). */
export { decode as bdecode, decodePrefix as bdecodePrefix, encode as bencode } from './bencode.js';
export type { BDict, BEncodable, BValue, DecodeOptions } from './bencode.js';
/** .torrent parsing (v1; v2/hybrid info-hashes computed) and creation. */
export { metainfoFromInfo, parseInfoDict, parseTorrent } from './metainfo.js';
export type { Metainfo, MetainfoVersion, TorrentFileEntry } from './metainfo.js';
export { choosePieceLength, createTorrent, createTorrentFromPath } from './create.js';
export type { CreateTorrentFile, CreateTorrentOptions } from './create.js';
/** Magnet URI parsing/formatting (btih hex/base32, btmh, dn, tr, x.pe, ws). */
export { parseMagnet, toMagnetUri } from './magnet.js';
export type { MagnetLink } from './magnet.js';
export { Bitfield } from './bitfield.js';
export {
  addressKey,
  decodeCompactPeers,
  decodeCompactPeers6,
  encodeCompactPeers,
  encodeCompactPeers6,
  hostFamily,
  normalizeHost,
} from './compact.js';
export type { PeerAddress } from './compact.js';

// ---- discovery ------------------------------------------------------------------------------

/** HTTP(S) and UDP (BEP 15) tracker clients plus the BEP 12 tier manager. */
export { HttpTracker, nodeHttpRequester } from './tracker/http-tracker.js';
export type { HttpRequester, HttpRequestOptions, HttpResponse } from './tracker/http-tracker.js';
export { UdpTracker } from './tracker/udp-tracker.js';
export type { UdpSocketFactory } from './tracker/udp-tracker.js';
export { TrackerManager, createTrackerClient } from './tracker/tracker-manager.js';
export type { TrackerClientFactoryOptions, TrackerState, TrackerStatus } from './tracker/tracker-manager.js';
export type { AnnounceEvent, AnnounceParams, AnnounceResponse, ScrapeResponse, TrackerClient } from './tracker/types.js';
/** In-process trackers for tests and local experiments. */
export { startHttpTracker, startUdpTracker } from './tracker/test-trackers.js';
/** Kademlia DHT node (BEP 5). */
export { DHT, DEFAULT_BOOTSTRAP_NODES } from './dht/dht.js';
export type { DhtOptions, LookupResult } from './dht/dht.js';

// ---- peer wire, storage, selection -----------------------------------------------------------

export { PeerConnection, connectTcp } from './peer/connection.js';
export type { PeerConnectionOptions, PeerTransport } from './peer/connection.js';
export { PeerListener } from './peer/listener.js';
export type { IncomingInfo } from './peer/listener.js';
export { openPeerStream } from './peer/connect.js';
export type { OpenedPeer, OpenPeerOptions } from './peer/connect.js';
export { PEX_FLAG } from './peer/extensions.js';
export type { PexMessage, PexPeer } from './peer/extensions.js';
/** Message Stream Encryption (MSE/PE): DH key exchange, RC4, both handshake roles. */
export { CipherStream, dhKeyPair, dhSecret, MSE_PRIME, mseInitiate, mseReq2, mseRespond } from './peer/mse.js';
export type { CryptoMethod, EncryptionMode, MseResult } from './peer/mse.js';
export { RC4 } from './peer/rc4.js';
/** uTP (BEP 29) over UDP with LEDBAT congestion control. */
export { UtpManager } from './utp/manager.js';
export type { UtpManagerOptions } from './utp/manager.js';
export { UtpSocket } from './utp/socket.js';
export type { UtpSocketOptions } from './utp/socket.js';
/** BEP 19 web seeds. */
export { WebSeedManager, webSeedFileUrl } from './webseed.js';
export type { WebSeedStats } from './webseed.js';
export { Choker } from './peer/choker.js';
export { TokenBucket, RateMeter } from './rate.js';
export { Storage } from './storage/storage.js';
export { DiskIo, Semaphore } from './storage/io.js';
export type { StorageOptions } from './storage/storage.js';
export { PieceLayout } from './storage/layout.js';
export { loadResumeData, saveResumeData, ResumeDataSchema } from './storage/resume.js';
export type { ResumeData } from './storage/resume.js';
export { PiecePicker } from './picker.js';
export type { PickerOptions } from './picker.js';

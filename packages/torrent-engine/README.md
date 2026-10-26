# @arclight/torrent-engine

A clean-room BitTorrent client library in TypeScript, so Arclight can download torrents
itself instead of driving an external qBittorrent. It uses Node built-ins only (`node:net`,
`node:dgram`, `node:crypto`, `node:fs/promises`, `node:dns`, `node:events`, `node:http(s)`),
plus `zod` to validate resume files. Target runtime: Node 24.

```ts
import { Session } from '@arclight/torrent-engine';

const session = new Session({
  settings: { savePath: '/data/downloads', listenPort: 6881, listenAddress: '10.8.0.2', resumeDataDir: '/config/torrents' },
});
await session.start();                      // binds the listener and DHT, restores saved torrents
const t = await session.addTorrent({ magnet, category: 'tv' });
session.onCompleted((torrent) => console.log(torrent.getStats().contentPath));
await session.bindTo('10.8.0.3');            // VPN address changed: rebind everything
await session.shutdown();                    // saves resume data, announces "stopped"
```

## Architecture

Each layer depends only on the ones above it, so each can be tested on its own.

| Layer | Files | What it does |
| --- | --- | --- |
| Encoding | `bencode.ts`, `bitfield.ts`, `compact.ts` | Strict bencode (Buffers, raw-span access for info-hashing), bitfields, compact peers and nodes |
| Metadata | `metainfo.ts`, `magnet.ts`, `create.ts` | .torrent parsing (v1; info-hashes for v2 and hybrid), path sanitising, BEP 47 pad files, magnets (btih hex/base32, btmh, dn, tr, x.pe), torrent creation |
| Trackers | `tracker/` | HTTP(S) client (compact peers, key, trackerid, intervals, failure/warning), UDP client (BEP 15 connect/announce/scrape with retransmission backoff), `TrackerManager` with BEP 12 tiers, in-process test trackers |
| DHT | `dht/` | KRPC transport, routing table with splitting k-buckets, iterative `find_node`/`get_peers`, `announce_peer` with rotating tokens, peer store, bucket refresh, configurable bootstrap |
| Peer wire | `peer/` | Handshake and all core messages, BEP 6 fast extension, BEP 10 extension handshake, BEP 9 metadata, BEP 11 PEX, adaptive request pipelining, snub detection, tit-for-tat choker with optimistic unchoke, token-bucket rate limits (per connection and global), listener bound to `listenAddress` |
| Storage | `storage/` | Piece/file mapping, sparse preallocation, write-through block cache, SHA-1 verification, re-check, fast resume (bitfield + file size/mtime), `.parts` file for skipped files, optional incomplete suffix, move and delete |
| Selection | `picker.ts` | Rarest first with random first pieces, sequential mode, file priorities, in-flight tracking, timeouts, endgame duplicates with cancels |
| Orchestration | `torrent.ts`, `session.ts`, `settings.ts` | Torrent state machine and stats; the session runs the listener, DHT, limits, queueing, seed limits, persistence and runtime rebinding |

### Torrent states

`checking` → `downloadingMetadata` (magnets) → `downloading` → `seeding`, plus `paused`,
`queued` (waiting for a `maxActiveDownloads`/`maxActiveSeeds` slot) and `error`. The
session emits `stateChange`, `completed`, `error` (only when something listens),
`metadata`, `seedLimitReached`, `torrentAdded` and `torrentRemoved`. `onStateChange`,
`onCompleted` and `onError` are shortcuts that return an unsubscribe function.

### Network binding (VPN)

`listenAddress` applies to every socket: the TCP listener, outgoing peer connections
(`localAddress`), the DHT UDP socket and tracker requests (HTTP `localAddress`, UDP bind).
Bind to the VPN interface address. If the VPN drops, sockets fail rather than leak traffic
through another interface. `bindTo(address | null)` and `setListenPort(port)` rebind at
runtime. They drop existing peers, and torrents reconnect and re-announce. `null` means
all interfaces.

### Persistence

With `resumeDataDir` set, each torrent writes `<infohash>.torrent` and
`<infohash>.resume.json` (bitfield, totals, times, priorities, file sizes and mtimes).
Writes go through a temporary file and a rename. On restart the saved bitfield is trusted
only if every file's size and mtime still match; otherwise the torrent is re-checked.
Magnets that never received metadata are restored from the saved magnet URI.

## Testing

`pnpm --filter @arclight/torrent-engine test` runs everything over localhost with no
internet access. The suite covers the in-process HTTP and UDP trackers, DHT networks of
several nodes, and two or more `Session`s exchanging a generated multi-file torrent via a
tracker, via DHT only, and via magnets with metadata exchange and PEX. The full suite takes
about 6 seconds.

## Not implemented yet (deliberately)

- **MSE/PE encryption.** `encryption` only accepts `'disabled'`. Peers that require
  encryption cannot connect.
- **uTP (BEP 29).** TCP only.
- **IPv6.** No IPv6 peers, `peers6`, or DHT IPv6 (BEP 32). Compact formats are IPv4 only.
- **Web seeds (BEP 19/17).** `url-list` is parsed but not used for downloading.
- **v2 downloads (BEP 52).** v2 and hybrid info-hashes are computed and hybrids download
  through their v1 data. v2-only torrents go to the `error` state.
- **Super-seeding**, **BEP 42 secure DHT node ids**, **DHT read-only mode/BEP 44**,
  **UPnP/NAT-PMP port mapping**, **IP filter file formats.** The blocklist is a callback,
  `isBlocked(ip)`.
- **Fast extension details.** Incoming `suggest` and `allowed fast` messages are accepted
  and ignored. We never send allowed-fast sets.
- **Per-torrent rate limits.** Limits are global and per connection. Per-torrent limits
  are not implemented.

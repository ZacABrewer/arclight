# @arclight/torrent-engine

A clean-room BitTorrent client library in TypeScript, so Arclight can download torrents
itself instead of driving an external qBittorrent. It uses Node built-ins only (`node:net`,
`node:dgram`, `node:crypto`, `node:fs/promises`, `node:dns`, `node:events`, `node:http(s)`,
`node:stream`, `node:os`),
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
| Peer wire | `peer/` | Handshake and all core messages, BEP 6 fast extension, BEP 10 extension handshake, BEP 9 metadata, BEP 11 PEX (IPv4 and IPv6, `added.f` flags), adaptive request pipelining, snub detection, tit-for-tat choker with optimistic unchoke, token-bucket rate limits (per connection, per torrent and global), listener bound to `listenAddress` |
| Encryption | `peer/mse.ts`, `peer/rc4.ts`, `peer/connect.ts` | MSE/PE: 768-bit DH with 160-bit private keys, RC4 with 1024 bytes discarded, `req1/req2/req3` obfuscation, `crypto_provide`/`crypto_select` (plaintext or RC4), padding, VC sync, initiator and receiver roles; outgoing fallback to plaintext |
| uTP | `utp/` | BEP 29 over `node:dgram`: SYN/STATE/DATA/FIN/RESET state machine, selective ACKs, fast and early retransmit, RTT-based timeouts, LEDBAT (100 ms target), 1400-byte packets; shares the DHT's UDP socket |
| Web seeds | `webseed.ts` | BEP 19 (`url-list`, GetRight style) HTTP range requests through `node:http(s)` bound to `listenAddress`, a per-torrent connection cap, exponential back-off |
| Storage | `storage/` | Piece/file mapping, sparse preallocation, write-through block cache, SHA-1 verification, re-check, fast resume (bitfield + file size/mtime), `.parts` file for skipped files, optional incomplete suffix, move and delete |
| Selection | `picker.ts` | Rarest first with random first pieces, sequential mode, file priorities, in-flight tracking, timeouts, endgame duplicates with cancels |
| Orchestration | `torrent.ts`, `session.ts`, `settings.ts` | Torrent state machine and stats, BEP 16 super-seeding; the session runs the listener, DHT (IPv4 and IPv6), uTP, limits, queueing, seed limits, persistence and runtime rebinding |

### Torrent states

`checking` → `downloadingMetadata` (magnets) → `downloading` → `seeding`, plus `paused`,
`queued` (waiting for a `maxActiveDownloads`/`maxActiveSeeds` slot) and `error`. The
session emits `stateChange`, `completed`, `error` (only when something listens),
`metadata`, `seedLimitReached`, `torrentAdded` and `torrentRemoved`. `onStateChange`,
`onCompleted` and `onError` are shortcuts that return an unsubscribe function.

### Network binding (VPN)

`listenAddress` applies to every socket: the TCP listener, outgoing peer connections
(`localAddress`), the DHT/uTP UDP socket, tracker requests (HTTP `localAddress`, UDP bind) and
web seed requests (HTTP `localAddress`).
Bind to the VPN interface address. If the VPN drops, sockets fail rather than leak traffic
through another interface. `bindTo(address | null)` and `setListenPort(port)` rebind at
runtime. They drop existing peers, and torrents reconnect and re-announce. `null` means
all interfaces.

### Transports and encryption

Incoming connections arrive over TCP or uTP. The listener reads the first bytes: `BitTorrent
protocol` is a plaintext handshake, anything else starts an MSE key exchange.

| `encryption` | Outgoing | Incoming |
| --- | --- | --- |
| `preferred` (default) | MSE first, offering RC4 and plaintext; on failure reconnect in plaintext (remembered per peer) | plaintext and MSE |
| `required` | MSE offering RC4 only, no fallback | MSE with RC4 only |
| `disabled` | plaintext | plaintext only |

Outgoing connections use TCP first and uTP as a fallback, except for peers that advertised uTP
(PEX flag `0x04`, or an earlier uTP connection), which get uTP first. `tcp: false` or `utp: false`
turns a transport off in both directions. uTP runs on the UDP listen port, sharing the socket with
the DHT (uTP datagrams start with version nibble 1; KRPC starts with `d`). `PeerStats` reports
`encrypted` and `transport` for each peer.

### IPv6

With `listenAddress: null` and `ipv6: true` (the default), the TCP listener binds `::` in
dual-stack mode, and a second UDP socket on `::` carries an IPv6 DHT (BEP 32, `nodes6`) and IPv6
uTP. A specific `listenAddress` limits the session to that address family. Trackers (`peers6`),
PEX (`added6`/`dropped6`) and the DHT all exchange 18-byte compact IPv6 peers. Peer keys use the
`[addr]:port` form.

### Per-torrent options

`addTorrent` accepts `superSeeding` (BEP 16: the seed advertises one piece per peer and reveals
the next one once another peer reports having it, or right away when that peer is the only
leecher), `uploadLimit` and `downloadLimit` (a torrent-wide token bucket on top of the global one),
and `peerUploadLimit` and `peerDownloadLimit` (per connection). `Torrent.setSuperSeeding()` and
`Torrent.setRateLimits()` change them at runtime. They are saved in the resume data.

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
tracker, via DHT only, and via magnets with metadata exchange and PEX. Other suites cover RC4
vectors, DH agreement, both MSE roles, policy enforcement and plaintext fallback, uTP transfers
under injected packet loss, uTP-only and IPv6 (`::1`) downloads, web seeds from an in-process
HTTP server, super-seeding and per-torrent limits. IPv6 tests skip when `::1` is unavailable.
The full suite takes about 7 seconds.

## Limits and not implemented yet

- **MSE**: we never send an initial payload (IA) and pad at most 64 bytes in steps 3 and 4.
  Handshakes that time out count as "MSE unsupported" and fall back after `connectTimeoutMs`.
- **uTP**: no path-MTU discovery (fixed 1400-byte datagrams), no delayed-ACK timer (we ACK every
  second packet at once) and no clock-drift correction for the LEDBAT base delay. The minimum
  timeout is 500 ms. Receive window 1 MiB per connection.
- **IPv6**: no BEP 7 `ipv6=` announce parameter, no BEP 32 `want` handling (each DHT answers in
  its own family), and UDP trackers use IPv6 only for literal IPv6 hosts.
- **Web seeds**: GetRight style (BEP 19) only. Hoffman-style (BEP 17 `httpseeds`) is not
  supported. A server that ignores `Range` is only usable for ranges that start at byte 0.
- **v2 downloads (BEP 52).** v2 and hybrid info-hashes are computed and hybrids download
  through their v1 data. v2-only torrents go to the `error` state.
- **BEP 42 secure DHT node ids**, **DHT read-only mode/BEP 44**, **UPnP/NAT-PMP port mapping**,
  **IP filter file formats.** The blocklist is a callback, `isBlocked(ip)`.
- **Fast extension details.** Incoming `suggest` and `allowed fast` messages are accepted
  and ignored. We never send allowed-fast sets.

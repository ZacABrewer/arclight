# @media-tron/download-clients

Clients for external download clients. Each one implements `DownloadClient` from `src/types.ts`
and reports its queue as normalized `DownloadItem`s. The api's downloads module never needs to
know which client it is talking to. Clients use only the injected `fetch` (the `ClientRuntime`).
They have no dependencies besides zod.

| Kind (`DownloadClientKind`) | Protocol | Transport | Factory |
|---|---|---|---|
| `qbittorrent` | torrent | WebUI API v2, SID cookie (4.1+) | `createQBittorrentClient` |
| `transmission` | torrent | JSON RPC, `X-Transmission-Session-Id` 409 handshake, optional Basic auth (rpc 14+ / 2.80+) | `createTransmissionClient` |
| `deluge` | torrent | Web UI JSON-RPC (`auth.login`, `web.connect` to the first daemon host), Label plugin | `createDelugeClient` |
| `rtorrent` | torrent | XML-RPC over HTTP (own encoder/decoder in `rtorrent/xmlrpc.ts`), optional Basic auth (0.9.6+) | `createRTorrentClient` |
| `sabnzbd` | usenet | HTTP API with `apikey` (1.0+, 3.0+ recommended) | `createSabnzbdClient` |
| `nzbget` | usenet | JSON-RPC with Basic auth (16+) | `createNzbgetClient` |

`createDownloadClient(kind, settings, runtime?)` dispatches on the kind. Each kind has a settings
schema (`TransmissionSettings`, `DelugeSettings`, ...; all of them are in
`downloadClientSettingsSchemas`). Every field in the new schemas has a `.describe()` text for the
UI, and defaults are filled in. `downloadClientProtocols` maps each kind to its protocol.

Torrent clients implement `addTorrent`. When they get an NZB through `addNzb`, they throw
`DownloadClientError('not-supported')`. Usenet clients do the reverse. Every client sets
`protocol`. On the interface `protocol` is optional, so test doubles elsewhere keep compiling.

## Settings fields

Every client has these: `host`, `port`, `useSsl`, `urlBase`, `category` (default `media-tron`)
and `postImportCategory`. Each client adds its own fields:

- **transmission**: port 9091, urlBase `/transmission/` (`rpc` is appended), username,
  password, `directory`, `recentPriority`/`olderPriority` (`last`|`first`, queue-move-top),
  `addPaused`.
- **deluge**: port 8112, password only, `recentPriority`/`olderPriority` (`last`|`first`,
  queue_top), `addPaused`. The category is lowercased.
- **rtorrent**: port 8080, urlBase `RPC2`, username, password, `directory`, `addPaused`,
  `recentPriority`/`olderPriority` (`off`|`low`|`normal`|`high`).
- **sabnzbd**: port 8080, `apiKey`, username and password (legacy fallback),
  `recentPriority`/`olderPriority` (`default`|`paused`|`low`|`normal`|`high`|`force`).
- **nzbget**: port 6789, username (`nzbget`), password, `addPaused`,
  `recentPriority`/`olderPriority` (`veryLow`|`low`|`normal`|`high`|`veryHigh`|`force`).

## State mapping

The api treats `completed` and `seeding` as ready to import (`importPending`). It treats `failed`
as a failed download, which leads to a blocklist and a re-search. So a client:

- never reports completed while it is still verifying, moving, unpacking or post-processing;
- reports transient or unclear problems as `warning`.

### Torrents

| | queued | downloading | paused | seeding (read-only) | completed (removable) | warning |
|---|---|---|---|---|---|---|
| qBittorrent | queuedDL, checking*, metaDL | downloading, forcedDL, moving | pausedDL/stoppedDL | uploading, stalledUP, queuedUP, forcedUP | pausedUP/stoppedUP, or seed limit reached | stalledDL, error, missingFiles |
| Transmission | check-wait, checking, download-wait | downloading | stopped, not finished | seed-wait, seeding | stopped after download, or `isFinished` / ratio or idle limit reached | error 1–3 |
| Deluge | Queued, Checking, Allocating | Downloading, Moving | Paused, not finished | Seeding (and Queued once finished) | Paused + finished, or stop ratio reached | Error |
| rTorrent | hash checking, metadata | started + active | stopped or paused, incomplete | complete + started (including paused) | complete + stopped | tracker message with no download rate |

Torrent seeding rules:

- Finished but seeding obligations are not met: `isReadOnly`. The importer must copy or
  hardlink, not move.
- Seed limit reached (per torrent overriding global, where the client has limits): `completed`,
  movable and removable.
- A torrent stopped with no limit is removable only when it is known to be public (qBittorrent,
  Transmission).
- rTorrent has no per-torrent limits in its API. Whatever stops a finished torrent counts as the
  seeding policy.

### Usenet

| | SABnzbd | NZBGet |
|---|---|---|
| queued | Queued, Grabbing, Fetching, Propagating | QUEUED, FETCHING |
| paused | Paused, or the whole queue is paused | PAUSED, or downloads are paused globally |
| downloading | Downloading, Checking/QuickCheck; history Verifying, Repairing, Extracting, Moving, Running, Queued (post-processing) | DOWNLOADING; PP_QUEUED, LOADING_PARS, VERIFYING_*, REPAIRING, RENAMING, UNPACKING, MOVING, EXECUTING_SCRIPT, PP_FINISHED |
| completed | history Completed (`storage` = outputPath) | history SUCCESS/* (FinalDir or DestDir) |
| failed | history Failed | FAILURE/*, DELETED/HEALTH, BAD, SCAN, MarkStatus BAD |
| warning | Failed because a script failed or a disk/permission problem | WARNING/*, DELETED/MANUAL, DUPE, COPY, GOOD |

Usenet history items can be moved and removed. Queue items cannot.

## Tests

Every client has an in-memory fake server (`src/<kind>/fake-<kind>.ts`, built on
`src/fake-http.ts`) and hand-written fixtures in `fixtures/<kind>/`. Tests never hit a live
service. Run `pnpm --filter @media-tron/download-clients test`.

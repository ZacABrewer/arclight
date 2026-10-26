# Remote engine

Arclight's built-in torrent engine can run on a different machine from Arclight itself: a
seedbox, a VPS, or another Arclight. The main Arclight drives it through a **Remote Engine**
download client. Grabs, the queue, pausing, removing and importing all work the way they do with
any other client.

```
 main Arclight (NAS)                              seedbox / VPS
 ┌──────────────────────────┐   HTTP + WebSocket   ┌─────────────────────────────┐
 │ Remote Engine client      │ ───────────────────▶ │ engine agent (agent.mjs)    │
 │  - queue polling          │   token in header    │  - torrent engine (Session)  │
 │  - pull mode: range GET   │ ◀─────────────────── │  - bound to tun0 (Gluetun)   │
 │    + SHA-256 check        │   completed files    │  - follows forwarded port    │
 └──────────────────────────┘                      └─────────────────────────────┘
```

There are two kinds of agent:

- **The standalone agent**: `docker/Dockerfile.agent`, a single Node file (`agent.mjs`) with no
  database or web UI. You configure it with environment variables.
- **Another Arclight**: any Arclight serves the same protocol under `/api/v1/engine-agent` once
  you turn on `engineAgent.enabled`. Callers authenticate with that instance's API key.

## Set up the agent on a seedbox

1. Generate a token: `openssl rand -hex 32`.
2. Copy `docker/docker-compose.agent.yml` next to a checkout of this repository on the seedbox,
   then fill in `AGENT_TOKEN` and your VPN credentials (the example uses ProtonVPN WireGuard
   through Gluetun):

   ```sh
   AGENT_TOKEN=... PROTON_WIREGUARD_KEY=... docker compose -f docker/docker-compose.agent.yml up -d
   ```

3. Let the main Arclight reach port 7879, and nothing else. Good options are a private network
   (WireGuard, Tailscale), a firewall rule that only admits your home IP, or a TLS reverse proxy
   (then use `https://` in the client URL). The token travels in a header, so never expose plain
   HTTP to the internet.
4. In the main Arclight, go to **Settings > Download Clients > Add > Remote Engine**:
   - **Agent URL**: `http://seedbox:7879` (standalone agent) or
     `http://other-arclight:7878/api/v1/engine-agent` (another Arclight).
   - **Token**: the `AGENT_TOKEN`, or the other Arclight's API key.
   - **Pull Mode** and **Local Download Folder**: see below.
   - **Test** checks the connection, the protocol version, whether the agent is listening, the
     state of its VPN interface and, in pull mode, whether the local folder is writable.

Without Docker, run `pnpm --filter @arclight/engine-agent build`, then start the agent with
`AGENT_TOKEN=... node packages/engine-agent/dist/agent.mjs`.

### Agent environment

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_TOKEN` | (required, at least 16 chars) | Shared secret every request must present |
| `AGENT_PORT` / `AGENT_HOST` | `7879` / `0.0.0.0` | HTTP API |
| `AGENT_DOWNLOADS` | `/downloads` | Download root. Every save path must stay inside it |
| `AGENT_DATA` | `/data` | `resume/` holds fast-resume data and saved .torrent files, so torrents survive restarts |
| `AGENT_LISTEN_PORT` | `6881` | Peer port (TCP and UDP) |
| `AGENT_LISTEN_ADDRESS` | all interfaces | Bind every torrent socket to this address |
| `AGENT_LISTEN_INTERFACE` | (none) | Follow this interface's IPv4 address (e.g. `tun0`). Takes precedence over `AGENT_LISTEN_ADDRESS` |
| `AGENT_PORT_FILE` | (none) | File holding the VPN's forwarded port. The listener follows it, and remote port changes are refused |
| `AGENT_NETWORK_POLL_MS` | `15000` | How often the interface and the port file are re-read |
| `AGENT_ENCRYPTION` | `preferred` | `preferred`, `required` or `disabled` (MSE/PE) |
| `AGENT_UTP` / `AGENT_TCP` / `AGENT_DHT` / `AGENT_PEX` | `1` | Transports and peer sources |
| `AGENT_MAX_CONNECTIONS` | `200` | Peer connections across all torrents |
| `AGENT_MAX_ACTIVE_DOWNLOADS` / `AGENT_MAX_ACTIVE_SEEDS` | `3` / `5` | Queue limits (`-1` = unlimited) |
| `AGENT_DOWNLOAD_LIMIT_KBPS` / `AGENT_UPLOAD_LIMIT_KBPS` | `0` | Global limits in KiB/s |
| `AGENT_SEED_RATIO` / `AGENT_SEED_TIME_MINUTES` | unlimited | Default seed goals |
| `AGENT_SEED_LIMIT_ACTION` | `pause` | `pause`, `remove` or `none` when a seed goal is met |

On `SIGTERM` or `SIGINT` the agent stops accepting requests, saves resume data, announces
`stopped` to trackers and exits. The compose file allows 30 s for this. A second signal exits
immediately.

## Shared storage vs pull mode

**Shared storage** (pull mode off) works when the main Arclight can see the agent's download
folder: an NFS or SMB mount, or the same disk. Items are reported with the agent's paths. If the
main Arclight mounts the folder somewhere else, add a **Remote Path Mapping** whose host is the
host name from the agent URL (`seedbox` for `http://seedbox:7879`), for example
`/downloads/` → `/mnt/seedbox/downloads/`. Imports then copy or hardlink from the mount, as they
would for a remote qBittorrent.

**Pull mode** is for agents whose storage Arclight cannot see:

1. The agent finishes a torrent and keeps seeding it.
2. The Remote Engine client starts copying the payload into **Local Download Folder** (for
   example `/downloads/remote`). It reacts to the agent's `completed` event right away, and the
   queue poll picks up anything missed.
3. Each file is fetched with HTTP range requests into `<file>.arclight-part`. An interrupted
   copy resumes from the bytes already on disk.
4. Each file is checked against the SHA-256 the agent computes. On a mismatch the copy is
   discarded and fetched again.
5. While this runs, the queue shows the item as downloading ("Copying from the remote engine
   (42%)") with progress and ETA. A failed attempt shows a warning and retries with backoff (30 s,
   doubling up to 10 min).
6. Once every file is verified, a manifest is written to
   `<Local Download Folder>/.arclight-pull/<info-hash>.json`. The item is then reported as
   completed at its local path, and the importer handles it like any local download. It may move
   the files, because the copy belongs to Arclight while the agent keeps seeding its own.
7. When the item is removed (after import, when seeding goals allow it), the torrent is removed
   on the agent. With "delete data", the local copy and the manifest are deleted too.

**Copy Limit (KiB/s)** throttles step 3 so it does not saturate your home connection. Agent-side
download and upload limits are set with the `AGENT_*_LIMIT_KBPS` variables.

## VPN

The agent runs in Gluetun's network namespace (`network_mode: service:gluetun`), so all of its
traffic leaves through the tunnel and Gluetun's firewall blocks everything else. Two settings
add belt and braces:

- `AGENT_LISTEN_INTERFACE=tun0` binds every engine socket (peer listener, outgoing peer
  connections, DHT, trackers) to the tunnel address. If the interface disappears, the engine
  rebinds to `127.0.0.1` (a kill switch) until it comes back. `/status` reports
  `vpn: { interface, up }`, and the client's **Test** warns while it is down.
- `AGENT_PORT_FILE=/tmp/gluetun/forwarded_port` makes the listener follow the port your
  provider forwards. Gluetun writes this file, and the compose file shares it through a volume.

**Follow VPN Port** on the client applies the *main* Arclight's forwarded port (Settings > VPN) to
the agent. Turn it on only when the agent sits behind the same VPN connection as the main
Arclight. An agent with its own VPN follows its own port file and refuses remote changes. For
another Arclight acting as agent, the port always belongs to that instance.

## Health

`RemoteEngineUnreachable` (error) is raised for each enabled Remote Engine whose agent did not
answer the last queue poll, or a live status request when no poll has run yet. While an agent is
unreachable, its downloads are neither tracked nor imported. They pick up again when it answers.

## Protocol

Protocol version 1 is JSON over HTTP. Paths are relative to the agent URL. The Zod schemas live
in `packages/engine-agent/src/protocol.ts`.

| Method | Path | |
|---|---|---|
| GET | `/status` | `protocolVersion`, `agentVersion`, `kind` (`standalone` / `arclight`), `running`, `listenPort`, `listenAddress`, `vpn`, `portManaged`, `downloadsRoot`, `seedLimitAction`, counts and rates |
| PUT | `/listen-port` | `{ port }`; 409 when the agent manages its port |
| GET | `/torrents?category=` | Torrents with full statistics plus `isComplete`, `isPrivate`, effective seed limits, `seedLimitsMet`, `trackerError` |
| POST | `/torrents` | JSON `{ magnet, category, savePath?, paused?, seedRatioLimit?, seedTimeLimitMinutes? }`, or multipart with a `torrent` file part and an `options` JSON part. 201 `{ id, duplicate: false }`, or 200 with `duplicate: true` |
| GET / DELETE | `/torrents/:id` | One torrent / remove it (`?deleteData=true`) |
| POST | `/torrents/:id/pause`, `/resume` | 204 |
| PUT | `/torrents/:id/category` | `{ category }` |
| PUT | `/torrents/:id/save-path` | `{ savePath }`: moves the payload. Must be inside the downloads root (403 otherwise) |
| GET | `/torrents/:id/files` | `[{ index, path, length, priority, progress, complete }]`. `path` is `/`-separated and starts with the torrent name |
| GET / HEAD | `/torrents/:id/files/:index/content` | File bytes. `Range: bytes=a-b`, `a-` and `-n` give 206. Refused with 409 `incomplete` until the file is complete |
| GET | `/torrents/:id/files/:index/sha256` | `{ index, length, sha256 }`, cached per size and modification time |
| GET (WS) | `/events` | `hello` (with status) first, then `added`, `removed`, `stateChange`, `completed`, `metadata`, `listenPort` |

The standalone agent reads the token from `x-agent-token` or `Authorization: Bearer`. An Arclight
reads `x-api-key`. The client sends the token in both headers. Errors are
`{ error, code }`, where `code` is one of `unauthorized` (401), `forbidden` (403), `not-found`
(404), `bad-request` (400), `conflict` and `incomplete` (409), `range` (416), `not-running`
(503) or `internal` (500). The client's event stream reconnects with exponential backoff
(0.5 s up to 30 s). Each reconnection starts with a fresh `hello`.

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
  you turn on **Act as remote engine** (Settings > Download Clients). Callers authenticate with
  that instance's **agent token**, shown in the same section. The token opens only the
  `/engine-agent/*` routes, never the rest of the API, and **Regenerate** replaces it.

## Set up the agent on a seedbox

1. Generate a token: `openssl rand -hex 32`.
2. Copy `docker/docker-compose.agent.yml` next to a checkout of this repository on the seedbox,
   then fill in `AGENT_TOKEN` and your VPN credentials (the example uses ProtonVPN WireGuard
   through Gluetun):

   ```sh
   AGENT_TOKEN=... PROTON_WIREGUARD_KEY=... docker compose -f docker/docker-compose.agent.yml up -d
   ```

3. Let the main Arclight reach port 7879, and nothing else. Good options are a private network
   (WireGuard, Tailscale), a firewall rule that only admits your home IP, TLS on the agent itself
   (`AGENT_TLS_CERT` / `AGENT_TLS_KEY`, see [TLS](#tls)), or a TLS reverse proxy. With TLS, use
   `https://` in the client URL. The token travels in a header, so never expose plain HTTP to the
   internet. An agent bound to a non-loopback address without TLS logs a `SECURITY` warning at
   every start; set `AGENT_INSECURE_OK=1` once the port is reachable only over a private network
   or through a TLS proxy.
4. In the main Arclight, go to **Settings > Download Clients > Add > Remote Engine**:
   - **Agent URL**: `http://seedbox:7879` (standalone agent) or
     `http://other-arclight:7878/api/v1/engine-agent` (another Arclight).
   - **Token**: the `AGENT_TOKEN`, or the other Arclight's agent token (its **Settings >
     Download Clients > Remote engine > Token**).
   - **Pull Mode** and **Local Download Folder**: see below.
   - **Test** checks the connection, the protocol version, whether the agent is listening, the
     state of its VPN interface and, in pull mode, whether the local folder is writable. It warns
     when the URL is plain `http://` to a host other than this machine, and when the other
     Arclight accepted its API key instead of the agent token (see [Upgrading from
     0.23](#upgrading-from-023)).

Without Docker, run `pnpm --filter @arclight/engine-agent build`, then start the agent with
`AGENT_TOKEN=... node packages/engine-agent/dist/agent.mjs`.

### Agent environment

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_TOKEN` | (required, at least 16 chars) | Shared secret every request must present. A token with fewer than 3 distinct characters is refused; a placeholder, a repeated pattern or fewer than 8 distinct characters starts with a warning |
| `AGENT_PORT` / `AGENT_HOST` | `7879` / `0.0.0.0` | HTTP API |
| `AGENT_TLS_CERT` / `AGENT_TLS_KEY` | (none) | PEM certificate and key files. Set both to serve HTTPS (and `wss://` events) |
| `AGENT_INSECURE_OK` | (off) | `1` silences the plain-HTTP warning for a non-loopback `AGENT_HOST` (private network or TLS proxy in front) |
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

### TLS

Set `AGENT_TLS_CERT` and `AGENT_TLS_KEY` to PEM files (mounted into the container, readable by
user 1000) and the agent serves HTTPS on `AGENT_PORT`. The client URL becomes
`https://seedbox:7879`. A certificate from a public CA works as is. For a self-signed certificate
or a private CA, give the main Arclight the CA certificate with `NODE_EXTRA_CA_CERTS=/path/ca.pem`
(an environment variable on its container); the client verifies certificates and never skips
that check. The container health check switches to HTTPS on its own.

### Failed sign-ins

After 5 wrong tokens from one address, further requests from it are answered `429` with a
`Retry-After` header: 1 s, doubling with each failure up to 15 minutes. A correct token clears
the count, as does 15 minutes without failures. Another Arclight acting as agent applies the
same back-off to its `/engine-agent/*` routes.

On `SIGTERM` or `SIGINT` the agent stops accepting requests, saves resume data, announces
`stopped` to trackers and exits. The compose file allows 30 s for this. A second signal exits
immediately.

## Upgrading from 0.23

Before 0.24, an Arclight acting as remote engine accepted its full admin API key as the token,
and the client sent it in both `x-agent-token` and `x-api-key` and followed redirects. From 0.24:

- Each Arclight has a separate, random **agent token** that opens only `/api/v1/engine-agent/*`.
  It is generated on first use, kept out of config exports, and shown (admins only) under
  **Settings > Download Clients > Remote engine**.
- An instance that already had **Act as remote engine** on keeps **Also accept the API key
  (deprecated)** on, so remotes configured with its API key keep working without changes.
  Answers to those requests carry `x-agent-deprecation: api-key`, the remote's **Test** shows a
  warning, the instance logs a warning (at most hourly), and the section shows when a remote last
  signed in that way.
- To switch: copy the agent token into each remote's Remote Engine client (Token field), run
  **Test**, then turn **Also accept the API key** off. New setups start with it off.
- The client now sends only the header the agent needs (`x-agent-token`) and does not follow
  redirects, so the token cannot be forwarded to another host. Against an Arclight still on 0.23
  (which reads only `x-api-key`), a client configured with that instance's API key retries once
  with `x-api-key` and warns on **Test** until the remote is upgraded.

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
   Paths from the agent are checked before anything is written: no `..`, empty or `.`
   segments, backslashes or NUL. On Windows, `:` (an NTFS alternate data stream) and device
   names such as `CON`, `NUL`, `COM1` or `LPT1` (with or without an extension) are refused too.
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
| PUT | `/torrents/:id/save-path` | `{ savePath }`: moves the payload. Must be inside the downloads root (403 otherwise), compared by real path so a symlink inside the root cannot lead out of it |
| GET | `/torrents/:id/files` | `[{ index, path, length, priority, progress, complete }]`. `path` is `/`-separated and starts with the torrent name |
| GET / HEAD | `/torrents/:id/files/:index/content` | File bytes. `Range: bytes=a-b`, `a-` and `-n` give 206. Refused with 409 `incomplete` until the file is complete |
| GET | `/torrents/:id/files/:index/sha256` | `{ index, length, sha256 }`, cached per size and modification time |
| GET (WS) | `/events` | `hello` (with status) first, then `added`, `removed`, `stateChange`, `completed`, `metadata`, `listenPort` |

Both kinds of agent read the token from `x-agent-token` or `Authorization: Bearer`; the client
sends only `x-agent-token` and treats any redirect as an error. While an Arclight still accepts
its API key (see [Upgrading from 0.23](#upgrading-from-023)) it also takes the key in
`x-api-key`. Errors are `{ error, code }`, where `code` is one of `unauthorized` (401),
`forbidden` (403), `not-found` (404), `bad-request` (400, also for a malformed `%` escape in the
path), `conflict` and `incomplete` (409), `range` (416), `rate-limited` (429, with
`Retry-After`), `not-running` (503) or `internal` (500). SHA-256 results are cached for the 512
most recently checked files. The client's event stream reconnects with exponential backoff
(0.5 s up to 30 s). Each reconnection starts with a fresh `hello`.

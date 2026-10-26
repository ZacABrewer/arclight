# Media-Tron

One content-acquisition service for a home media stack, written from scratch.
Media-Tron does the jobs of Sonarr (TV), Radarr (movies), Prowlarr (indexers), Bazarr
(subtitles) and Seerr (requests) in a single application: one database, one API, one
login, one UI, one background scheduler. It drives an external download client
(qBittorrent by default) and notifies your media server (Jellyfin, Emby, Plex) when
content lands. It is not a media server.

Status: **Phase 1 in progress** (library, metadata, profiles, indexers and download-client
plumbing work; the release/import pipeline and most UI pages are still being built; no
authentication yet). See [docs/ROADMAP.md](docs/ROADMAP.md) and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Deploy

The recommended layout runs Media-Tron and qBittorrent behind [Gluetun](https://github.com/qdm12/gluetun)
with ProtonVPN over WireGuard. Both containers use `network_mode: "service:gluetun"`, so all
their traffic leaves through the tunnel and Gluetun's firewall drops anything else.

```yaml
# docker-compose.yml
services:
  gluetun:
    image: qmcgaw/gluetun:latest
    container_name: gluetun
    cap_add: [NET_ADMIN]
    devices: [/dev/net/tun:/dev/net/tun]
    environment:
      - VPN_SERVICE_PROVIDER=protonvpn
      - VPN_TYPE=wireguard
      - WIREGUARD_PRIVATE_KEY=${PROTON_WIREGUARD_KEY}
      - SERVER_COUNTRIES=${VPN_COUNTRIES}
      - VPN_PORT_FORWARDING=on
      - FIREWALL_OUTBOUND_SUBNETS=${LAN_SUBNET}
      - HTTP_CONTROL_SERVER_ADDRESS=:8000
      - HTTP_CONTROL_SERVER_LOG=off
      - TZ=America/New_York
    ports:
      - 7878:7878   # Media-Tron
      - 8080:8080   # qBittorrent
    healthcheck:
      test: ["CMD", "/gluetun-entrypoint", "healthcheck"]
      interval: 30s
      start_period: 60s
    restart: unless-stopped

  media-tron:
    image: ghcr.io/media-tron/media-tron:latest
    network_mode: "service:gluetun"
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=America/New_York
      - MEDIATRON_VPN_CONTROL_URL=http://localhost:8000
    volumes:
      - ./config:/config
      - /volume1/media/tv:/tv
      - /volume1/media/movies:/movies
      - /volume1/downloads:/downloads
    depends_on:
      gluetun: { condition: service_healthy }
    restart: unless-stopped

  qbittorrent:
    image: lscr.io/linuxserver/qbittorrent:latest
    network_mode: "service:gluetun"
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=America/New_York
      - WEBUI_PORT=8080
    volumes:
      - ./qbittorrent:/config
      - /volume1/downloads:/downloads
    depends_on:
      gluetun: { condition: service_healthy }
    restart: unless-stopped
```

`docker/docker-compose.yml` is the build-from-source variant (with healthchecks on all three
services). It reads `PUID`, `PGID`, `TZ`, `CONFIG_ROOT`, `TV_ROOT`, `MOVIES_ROOT`,
`DOWNLOADS_ROOT`, `PROTON_WIREGUARD_KEY`, `VPN_COUNTRIES` and `LAN_SUBNET` from your
environment or a `.env` file; copy `docker/.env.example` to start.

### Getting the Proton WireGuard key

1. Sign in at account.proton.me and open **VPN → Downloads → WireGuard configuration**.
2. Name the config, pick a platform (any), and enable **NAT-PMP (port forwarding)**. Pick a
   server in a country that allows P2P (the same country as `VPN_COUNTRIES`).
3. Create it and copy the `PrivateKey = ...` value from the `[Interface]` section into
   `PROTON_WIREGUARD_KEY` in your `.env`. Keep it secret: anyone with it can use your tunnel.

### How qBittorrent gets the forwarded port

Proton forwards one incoming port per session and Gluetun reports it on its control server.
Media-Tron polls Gluetun every minute (Settings → VPN, provider *Gluetun*, enabled) and, when
the port changes, sets it as qBittorrent's listening port (`/api/v2/app/setPreferences`,
random port off) on every enabled qBittorrent client. Because the three containers share one
network namespace, add qBittorrent in Media-Tron with host `localhost`, port `8080`. With
**Pause grabs when down** on (default), Media-Tron stops grabbing while the VPN is down or
its public IP equals your **home public IP**; the dashboard card and the `VpnDisconnected`
health check show the state. Newer Gluetun releases protect the control server: create an
API key per the Gluetun wiki and enter it (or username/password) in Settings → VPN.

### Built-in torrent engine (no qBittorrent)

Media-Tron ships its own BitTorrent engine, so the stack can run without a qBittorrent
container: `docker compose -f docker/docker-compose.builtin.yml up -d` starts only Gluetun and
Media-Tron (7878 published on Gluetun; no 6881 publish, since Proton forwards a port dynamically
and Media-Tron moves the engine's listener onto it). On first start a **Built-in** download
client is registered when none exists; engine options (limits, queue, seed goals, download
folder `/downloads`) are under Settings → Torrent Engine. With **Bind to VPN** on (default) and
the VPN integration enabled, the engine binds to the tunnel and, while the VPN is down or
leaking, pauses every torrent and binds to 127.0.0.1 until it reconnects; set
`MEDIATRON_TORRENT_ENGINE=0` to keep the engine from starting at all.

### Without a VPN

Use the plain layout: `docker compose -f docker/docker-compose.novpn.yml up -d` (Media-Tron on
7878, qBittorrent on 8080 and peer port 6881, no Gluetun). Leave Settings → VPN disabled.

### Native Windows VPN

Running Media-Tron directly on Windows (no Docker), pick a provider in Settings → VPN:

- **WireGuard for Windows**: install the official client (wireguard.com), download a Proton
  WireGuard `.conf` (steps above; keep NAT-PMP on), save it under a short name such as
  `C:\vpn\proton-nl.conf`, and point Media-Tron at it. Media-Tron installs the tunnel service
  (`wireguard.exe /installtunnelservice`), reads `wg show <name>` for handshake, endpoint and
  transfer, and finds the adapter's IPv4 (the bind address the built-in torrent engine uses).
  It must run elevated (Administrator, or as a service under LocalSystem). With **auto-start**
  it reinstalls a missing tunnel (at most every 5 minutes; a manual Disconnect suspends this).
  With **kill switch** on, grabs stop and a `vpn` event tells the torrent engine to close its
  sockets whenever the adapter disappears or the handshake goes stale.
- **Interface binding**: you run the VPN yourself (e.g. the ProtonVPN app); name its adapter
  (e.g. `ProtonVPN`) and Media-Tron watches its IPv4 and exposes it as the bind address.

Limitation: Node's `fetch` cannot bind to a local address, so the native public IP check
(`publicIpCheckUrl`, default `https://api.ipify.org?format=json`) follows the OS routing
table. With a full-tunnel config (`AllowedIPs = 0.0.0.0/0`) that is the tunnel; with a split
tunnel it may not be. Set **home public IP** so a check that leaves through your ISP is
flagged as a leak instead of passing silently.

There is no login yet: keep port 7878 on a trusted network.

## Develop

Requirements: Node 24, pnpm 10.

```bash
pnpm install
pnpm dev          # api on :7878 (tsx watch), web on :5173 proxying /api to it
pnpm build        # api -> apps/api/dist, web -> apps/web/dist
pnpm test         # vitest in every workspace project
pnpm typecheck    # tsc --noEmit in every workspace project
pnpm db:generate  # drizzle-kit generate: new migration in apps/api/drizzle
```

Parser fixture report (pass rate per fixture file, first failures):

```bash
pnpm --filter @media-tron/parser report              # all fixtures
pnpm --filter @media-tron/parser report -- quality   # only paths containing "quality"
pnpm --filter @media-tron/parser report -- --all     # list every failure
```

If port 7878 is already in use (Radarr uses 7878 too),
start the api with another port: `MEDIATRON_PORT=7979 pnpm dev`. The Vite proxy target is
hard-coded to `http://localhost:7878` in `apps/web/vite.config.ts` (there is no
`VITE_API_TARGET`), so change the target there when you move the api.

Local data (SQLite database, logs) goes in `./config` unless `MEDIATRON_CONFIG` is set.
See [docs/DEVELOPING.md](docs/DEVELOPING.md) for how to add modules and packages and
[docs/API.md](docs/API.md) for the routes.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `MEDIATRON_CONFIG` | `/config` in Docker, else `./config` | Config dir: `media-tron.db`, `logs/` |
| `MEDIATRON_PORT` | `7878` | HTTP port |
| `MEDIATRON_HOST` | `0.0.0.0` | Bind address |
| `MEDIATRON_LOG_LEVEL` | `info` | pino log level |
| `MEDIATRON_DOCKER` | auto (`/.dockerenv`) | Force Docker path defaults with `1` |
| `MEDIATRON_WEB_DIST` | unset | Built web app to serve (set to `/app/web` in the image) |
| `MEDIATRON_VERSION` | `0.1.0-dev` | Version reported by `/system/status` (set at image build) |
| `MEDIATRON_TMDB_API_KEY` | unset | TMDB key fallback when none is stored in Settings |
| `MEDIATRON_VPN_CONTROL_URL` | `http://localhost:8000` | Gluetun control server default when none is stored in Settings → VPN |
| `MEDIATRON_TORRENT_ENGINE` | `1` | `0` keeps the built-in torrent engine from starting (and from auto-registering its client) at boot |

The image also takes `PUID` and `PGID` (handled in `docker/entrypoint.sh`); compose passes `TZ`.

## Licence

GPL-3.0. Media-Tron is an independent implementation; see [NOTICE.md](NOTICE.md) for
the projects whose behaviour informed it.

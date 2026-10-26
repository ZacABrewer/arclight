# Arclight

One content-acquisition service for a home media stack, written from scratch.
Arclight does the jobs of Sonarr (TV), Radarr (movies), Prowlarr (indexers), Bazarr
(subtitles) and Seerr (requests) in a single application: one database, one API, one
login, one UI, one background scheduler. It drives an external download client
(qBittorrent by default) and notifies your media server (Jellyfin, Emby, Plex) when
content lands. It is not a media server.

## Documentation

**Full documentation: [docs/README.md](docs/README.md).** Install guides for Docker on Linux, Synology, UGREEN, Unraid, TrueNAS SCALE, QNAP, Windows, macOS, Raspberry Pi and Portainer; a first-run walkthrough; one page per area of the app; [Troubleshooting](docs/TROUBLESHOOTING.md), [FAQ](docs/FAQ.md) and [Glossary](docs/GLOSSARY.md). The sections below are a short summary for contributors; the docs are the authoritative guide for users.

Status: **early release.** The full pipeline works end to end (requests, search, download,
import, subtitles, notifications) with login and API keys; expect rough edges and report
them in [Issues](https://github.com/ZacABrewer/arclight/issues). Design notes:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), plans: [docs/ROADMAP.md](docs/ROADMAP.md).

## Deploy

The recommended layout runs Arclight and qBittorrent behind [Gluetun](https://github.com/qdm12/gluetun)
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
      - TZ=Etc/UTC
    ports:
      - 7878:7878   # Arclight
      - 8080:8080   # qBittorrent
    healthcheck:
      test: ["CMD", "/gluetun-entrypoint", "healthcheck"]
      interval: 30s
      start_period: 60s
    restart: unless-stopped

  arclight:
    image: ghcr.io/zacabrewer/arclight:latest
    network_mode: "service:gluetun"
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Etc/UTC
      - ARCLIGHT_VPN_CONTROL_URL=http://localhost:8000
      - ARCLIGHT_FLARESOLVERR_URL=http://localhost:8191
    volumes:
      - ./config:/config
      # One share holding downloads/, media/tv/ and media/movies/: imports are hard links.
      - /path/to/data:/data
    depends_on:
      gluetun: { condition: service_healthy }
    restart: unless-stopped

  qbittorrent:
    image: lscr.io/linuxserver/qbittorrent:latest
    network_mode: "service:gluetun"
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Etc/UTC
      - WEBUI_PORT=8080
    volumes:
      - ./qbittorrent:/config
      - /path/to/data:/data
    depends_on:
      gluetun: { condition: service_healthy }
    restart: unless-stopped

  flaresolverr:
    image: ghcr.io/flaresolverr/flaresolverr:latest
    network_mode: "service:gluetun"
    environment:
      - LOG_LEVEL=info
      - TZ=Etc/UTC
    depends_on:
      gluetun: { condition: service_healthy }
    restart: unless-stopped
```

`docker/docker-compose.yml` is the build-from-source variant (with healthchecks on all three
services). The image runs a single esbuild bundle (`node dist/server.mjs`) with only the
`better-sqlite3` addon installed beside it: about 80 MB to pull and about 220 MB unpacked
(the Node 24 binary is 127 MB of that), and it answers HTTP within about 2 seconds of
`docker run`. Every compose variant also runs [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr)
for Cloudflare-protected indexers: in the VPN layouts it shares Gluetun's namespace (its
browser traffic is tunnelled too; port 8191 stays internal), without a VPN Arclight reaches it
at `http://flaresolverr:8191`. Arclight reads `ARCLIGHT_FLARESOLVERR_URL` and registers a
**FlareSolverr (bundled)** indexer proxy tagged `cloudflare` on boot; indexers whose definition
needs a solver use it automatically. Running natively on Windows, the built-in solver drives a
local Edge/Chrome instead; see [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md). It reads `PUID`, `PGID`, `TZ`, `CONFIG_ROOT`, `DATA_ROOT` (one share holding `downloads/`,
`media/tv/` and `media/movies/`, so imports are instant hard links), `PROTON_WIREGUARD_KEY`, `VPN_COUNTRIES` and `LAN_SUBNET` from your
environment or a `.env` file; copy `docker/.env.example` to start.

**Whisper (opt-in).** Every compose file has a `whisper` service
(`onerahmet/openai-whisper-asr-webservice`, `ASR_MODEL=base`, faster-whisper on the CPU; a GPU
variant is commented in) behind the `whisper` profile: `docker compose -f <file> --profile whisper
up -d`. Arclight's `ARCLIGHT_WHISPER_URL=http://whisper:9000` is probed on boot and hourly
(`WhisperAutoDetect`, HEAD `/docs` or `/asr`); when it answers, the Whisper provider is added as
the lowest-priority subtitle provider with "only when no other result" on, and the
`WhisperUnreachable` health check warns if it later stops answering
(`GET /api/v1/subtitle/whisper/status` shows the state). Without a VPN, `http://whisper:9000`
resolves through Docker's DNS. In the VPN layouts Arclight lives in Gluetun's network namespace,
so whisper (not tunnelled) gets a fixed address on a fixed compose subnet
(`ARCLIGHT_SUBNET`, default `172.30.53.0/24`; `WHISPER_IP`, default `172.30.53.200`), gluetun
maps the name with `extra_hosts` and allows the subnet in `FIREWALL_OUTBOUND_SUBNETS`; the same
`http://whisper:9000` works, and `http://172.30.53.200:9000` is the fallback if a Gluetun
version ignores the hosts file. Existing VPN stacks need one `docker compose down` to recreate
the network with the fixed subnet. On a bare install, point it at any Whisper ASR service.

### Getting the Proton WireGuard key

1. Sign in at account.proton.me and open **VPN → Downloads → WireGuard configuration**.
2. Name the config, pick a platform (any), and enable **NAT-PMP (port forwarding)**. Pick a
   server in a country that allows P2P (the same country as `VPN_COUNTRIES`).
3. Create it and copy the `PrivateKey = ...` value from the `[Interface]` section into
   `PROTON_WIREGUARD_KEY` in your `.env`. Keep it secret: anyone with it can use your tunnel.

### How qBittorrent gets the forwarded port

Proton forwards one incoming port per session and Gluetun reports it on its control server.
Arclight polls Gluetun every minute (Settings → VPN, provider *Gluetun*, enabled) and, when
the port changes, sets it as qBittorrent's listening port (`/api/v2/app/setPreferences`,
random port off) on every enabled qBittorrent client. Because the three containers share one
network namespace, add qBittorrent in Arclight with host `localhost`, port `8080`. With
**Pause grabs when down** on (default), Arclight stops grabbing while the VPN is down or
its public IP equals your **home public IP**; the dashboard card and the `VpnDisconnected`
health check show the state. Current Gluetun releases protect the control server with an
API key. Run `scripts/gluetun-auth.sh` (or `scripts\gluetun-auth.ps1` on Windows) once: it
generates a key, writes `${CONFIG_ROOT}/gluetun/auth/config.toml` for Gluetun and stores
`GLUETUN_API_KEY` in `docker/.env`; the compose files pass it to Arclight as
`ARCLIGHT_VPN_API_KEY`, so nothing needs typing into Settings → VPN. Then
`docker compose down && docker compose up -d` (containers that share Gluetun's network
must be recreated whenever Gluetun restarts).

### Built-in torrent engine (no qBittorrent)

Arclight ships its own BitTorrent engine, so the stack can run without a qBittorrent
container: `docker compose -f docker/docker-compose.builtin.yml up -d` starts only Gluetun and
Arclight (7878 published on Gluetun; no 6881 publish, since Proton forwards a port dynamically
and Arclight moves the engine's listener onto it). On first start a **Built-in** download
client is registered when none exists; engine options (limits, queue, seed goals, download
folder `/data/downloads`) are under Settings → Torrent Engine. With **Bind to VPN** on (default) and
the VPN integration enabled, the engine binds to the tunnel and, while the VPN is down or
leaking, pauses every torrent and binds to 127.0.0.1 until it reconnects; set
`ARCLIGHT_TORRENT_ENGINE=0` to keep the engine from starting at all.

### Without a VPN

Use the plain layout: `docker compose -f docker/docker-compose.novpn.yml up -d` (Arclight on
7878, qBittorrent on 8080 and peer port 6881, no Gluetun). Leave Settings → VPN disabled.

### Self-update (Docker socket)

Settings → Updates can recreate labelled containers (`arclight.autoupdate=true`) on a new image
through the Docker API. Mount the socket into the Arclight container:

```yaml
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
```

The image starts as root only long enough for `docker/entrypoint.sh` to add the app user
(`PUID`) to the socket's group (its gid is read from the mounted socket and created as
`docker-sock` if the image has no such group), then drops to `PUID:PGID`. On hosts where the
socket belongs to `root:root` (Docker Desktop, some NAS builds) that group is gid 0. Without the
mount the update check still works and only "Update now" is unavailable.
`ARCLIGHT_DOCKER_SOCKET` points at a different socket path.

### Native Windows VPN

Running Arclight directly on Windows (no Docker), pick a provider in Settings → VPN:

- **WireGuard for Windows**: install the official client (wireguard.com), download a Proton
  WireGuard `.conf` (steps above; keep NAT-PMP on), save it under a short name such as
  `C:\vpn\proton-nl.conf`, and point Arclight at it. Arclight installs the tunnel service
  (`wireguard.exe /installtunnelservice`), reads `wg show <name>` for handshake, endpoint and
  transfer, and finds the adapter's IPv4 (the bind address the built-in torrent engine uses).
  It must run elevated (Administrator, or as a service under LocalSystem). With **auto-start**
  it reinstalls a missing tunnel (at most every 5 minutes; a manual Disconnect suspends this).
  With **kill switch** on, grabs stop and a `vpn` event tells the torrent engine to close its
  sockets whenever the adapter disappears or the handshake goes stale.
- **Interface binding**: you run the VPN yourself (e.g. the ProtonVPN app); name its adapter
  (e.g. `ProtonVPN`) and Arclight watches its IPv4 and exposes it as the bind address.

Limitation: Node's `fetch` cannot bind to a local address, so the native public IP check
(`publicIpCheckUrl`, default `https://api.ipify.org?format=json`) follows the OS routing
table. With a full-tunnel config (`AllowedIPs = 0.0.0.0/0`) that is the tunnel; with a split
tunnel it may not be. Set **home public IP** so a check that leaves through your ISP is
flagged as a leak instead of passing silently.

Arclight has its own login (set up in the first-run wizard) and API keys. Before exposing it
outside your network, read [Exposing Arclight outside your home](docs/getting-started/exposing-outside-home.md).

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
pnpm --filter @arclight/parser report              # all fixtures
pnpm --filter @arclight/parser report -- quality   # only paths containing "quality"
pnpm --filter @arclight/parser report -- --all     # list every failure
```

If port 7878 is already in use (Radarr uses 7878 too),
start the api with another port: `ARCLIGHT_PORT=7979 pnpm dev`. The Vite proxy target is
hard-coded to `http://localhost:7878` in `apps/web/vite.config.ts` (there is no
`VITE_API_TARGET`), so change the target there when you move the api.

Local data (SQLite database, logs) goes in `./config` unless `ARCLIGHT_CONFIG` is set.
See [docs/DEVELOPING.md](docs/DEVELOPING.md) for how to add modules and packages and
[docs/API.md](docs/API.md) for the routes.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `ARCLIGHT_CONFIG` | `/config` in Docker, else `./config` | Config dir: `arclight.db`, `logs/` |
| `ARCLIGHT_PORT` | `7878` | HTTP port |
| `ARCLIGHT_HOST` | `0.0.0.0` | Bind address |
| `ARCLIGHT_LOG_LEVEL` | `info` | pino log level |
| `ARCLIGHT_DOCKER` | auto (`/.dockerenv`) | Force Docker path defaults with `1` |
| `ARCLIGHT_WEB_DIST` | unset | Built web app to serve (set to `/app/web` in the image) |
| `ARCLIGHT_VERSION` | `0.1.0-dev` | Version reported by `/system/status` (set at image build) |
| `ARCLIGHT_TMDB_API_KEY` | unset | TMDB key fallback when none is stored in Settings |
| `ARCLIGHT_VPN_CONTROL_URL` | `http://localhost:8000` | Gluetun control server default when none is stored in Settings → VPN |
| `ARCLIGHT_ASSET_ROOT` | unset (the bundle sets it to its own folder) | Where the bundled server finds `drizzle/` migrations and `definitions/builtin/`; unset under `tsx`, which reads them from the sources |
| `ARCLIGHT_TORRENT_ENGINE` | `1` | `0` keeps the built-in torrent engine from starting (and from auto-registering its client) at boot |

| `ARCLIGHT_DOCKER_SOCKET` | `/var/run/docker.sock` | Docker API socket for container self-update (the entrypoint grants the app user its group) |
| `ARCLIGHT_FFPROBE` | `ffprobe` on `PATH` (`/usr/bin/ffprobe` in the image) | ffprobe binary for media analysis and sample detection |
| `ARCLIGHT_FFMPEG` | `ffmpeg` next to `ARCLIGHT_FFPROBE`, else on `PATH` | ffmpeg binary for transcode/remux rules |
| `ARCLIGHT_CONFIG_FILE` | unset | Managed-mode config file applied at boot (see docs/OPERATIONS.md) |
| `ARCLIGHT_WHISPER_URL` | unset (`http://whisper:9000` in compose) | Whisper ASR service auto-registered as the last subtitle provider when it answers |

The image also takes `PUID` and `PGID` (handled in `docker/entrypoint.sh`); compose passes `TZ`.

Transcode rules with VAAPI hardware encoding (Intel/AMD) need the render device passed through
to the container: add `devices: - /dev/dri:/dev/dri` to the Arclight service (and make sure
`PGID` or the container user can read `/dev/dri/renderD128`). ffmpeg is already in the image.

## Licence

GPL-3.0. Arclight is an independent implementation; see [NOTICE.md](NOTICE.md) for
the projects whose behaviour informed it.

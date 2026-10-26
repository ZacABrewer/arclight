# Requirements

This page lists what you need before installing Arclight: the host, the folders, the network ports and the browser. Read it first if you are choosing between Docker, a NAS and a Windows PC. It only states what the project ships or enforces. Arclight does not publish a CPU or RAM minimum, and this page does not make one up.

## What you need at a glance

| You need | Why |
|---|---|
| A machine that stays on (NAS, home server, mini PC) | Arclight searches, downloads and imports in the background, on a schedule. |
| Docker with Compose v2 (`docker compose`), or Node 24 and pnpm 10 for a native Windows install | Docker is the main way to run it. See [install-other-platforms.md](install-other-platforms.md) to choose a guide. |
| A TMDB API key (free) | Arclight reads all series and movie information from TMDB. See [first-run-wizard.md](first-run-wizard.md#step-3-connect-tmdb). |
| One way to download | The built-in torrent engine, which is included and already set up. External clients such as qBittorrent are optional. |
| Optional: a Proton VPN account | Only for the VPN layouts. The bundled Docker files are written for Proton over WireGuard with Gluetun; other providers are covered in [install-docker.md](install-docker.md#other-vpn-providers). |
| Optional: indexers | Arclight ships site definitions; you still add the indexers you have access to. |

## Hardware

The project does not state minimum CPU, RAM or disk figures, and none are enforced in code. What can be said from the Dockerfile, the README and the release notes:

- The image is small: about 80 MB to pull and about 220 MB unpacked, and it answers HTTP within a couple of seconds of starting.
- Release images are built for `linux/amd64` and `linux/arm64` (see [RELEASING.md](../RELEASING.md)).
- Arclight keeps one SQLite database and its logs in the config folder (`arclight.db`, `logs/`, plus `backups/`, `definitions/` and `torrents/` as you use them). Put the config folder on storage that survives reboots.
- Each extra container costs memory. FlareSolverr runs a headless browser, and the optional Whisper container runs a speech model on the CPU by default, so those are the heavy ones. If a small machine struggles, drop the optional extras first.
- Disk space is mostly your media. A download stays in the downloads folder until it is imported, and longer if you seed.

## Operating systems

| Platform | Guide |
|---|---|
| Linux with Docker | [install-docker.md](install-docker.md), the reference guide |
| Synology, UGREEN, Unraid, TrueNAS SCALE, QNAP | [install-synology.md](install-synology.md), [install-ugreen-nas.md](install-ugreen-nas.md), [install-unraid.md](install-unraid.md), [install-truenas-scale.md](install-truenas-scale.md), [install-qnap.md](install-qnap.md) |
| Windows (Docker, or native without Docker) | [install-windows.md](install-windows.md) |
| macOS, Raspberry Pi | [install-macos.md](install-macos.md), [install-raspberry-pi.md](install-raspberry-pi.md) |
| Portainer users | [install-portainer.md](install-portainer.md) |

The full list is in [install-other-platforms.md](install-other-platforms.md).

For the VPN layouts the host must provide `/dev/net/tun` and let the Gluetun container use the `NET_ADMIN` capability. If Gluetun fails to start, see [Troubleshooting: container restarting](../TROUBLESHOOTING.md#container-restarting).

## Folders and permissions

Arclight needs two places on disk. In Docker they are mounted into the containers:

| Host folder (your `.env` variable) | Inside the container | Holds |
|---|---|---|
| `CONFIG_ROOT` (a parent folder; Arclight uses `<CONFIG_ROOT>/arclight`) | `/config` | The database, logs, backups, torrent resume data |
| `DATA_ROOT` (one share) | `/data` | `downloads/`, `media/tv/` and `media/movies/` |

Arclight mounts `DATA_ROOT` at `/data` (so does qBittorrent, if you add it), and your root folders in Arclight are `/data/media/tv` and `/data/media/movies`. One mount matters: Linux cannot hard-link between two different mounts, even on one disk, so separate mounts for downloads and library make every import a slow full copy that needs double the space. One mount gives instant hard links and seeding keeps working. See [install-docker.md](install-docker.md#the-folder-layout-one-share-one-mount) and [folders-and-hardlinks.md](folders-and-hardlinks.md).

The containers run as the numeric user and group you give them (`PUID` and `PGID`), so that user must be able to read and write both folders.

## Network ports

| Port | Used by | Published? | Notes |
|---|---|---|---|
| 7878/tcp | Arclight web UI and API | Yes, in every layout | Change the host side of the mapping (`"7979:7878"`) if another app already uses 7878. |
| 8080/tcp | qBittorrent web UI | Only if you start the optional `qbittorrent` profile | Not used by the built-in engine. In VPN layouts the port line on `gluetun` is commented out until you need it. |
| 6881/tcp and udp | Torrent peer port | Only for qBittorrent in the no-VPN layout (or if you publish the built-in engine's port yourself) | In the VPN layouts no peer port is published: Proton forwards a port at runtime and Arclight moves the built-in engine's listener (and qBittorrent's, if used) onto it. |
| 8000/tcp | Gluetun control server | No (internal) | Arclight reads VPN status at `http://localhost:8000`. |
| 8191/tcp | FlareSolverr | No (internal) | Solves Cloudflare challenges for indexers. |
| 9000/tcp | Whisper (optional) | No (internal) | Only with the `whisper` profile. |

In the VPN layouts every published port is published on the `gluetun` container, because Arclight (and qBittorrent, if used) shares its network. You still open the UI at `http://<your-host>:7878`.

Arclight does not serve HTTPS itself. If you expose it beyond your home, put it behind a TLS reverse proxy and keep sign-in on (see [users-and-security.md](../using/users-and-security.md)).

## Accounts and keys

| Item | Needed for | Where it comes from |
|---|---|---|
| TMDB v3 API key | Required: series and movie data | Free account at themoviedb.org, under Settings > API |
| Proton WireGuard private key | The Gluetun VPN layouts | Your Proton account. See [install-docker.md](install-docker.md#4-get-your-vpn-credentials-vpn-layouts) |
| Indexer logins or API keys | Searching | From each indexer you use |

## Browser

The web UI is a single-page app for current desktop and mobile browsers. No specific browser list is published. Below 900 px wide the sidebar becomes a drawer menu, so a phone works. It is not an installable app: "Add to Home screen" only creates a shortcut that opens a normal tab, and there is no offline mode.

## Related

- [install-docker.md](install-docker.md)
- [install-other-platforms.md](install-other-platforms.md)
- [folders-and-hardlinks.md](folders-and-hardlinks.md)
- [first-run-wizard.md](first-run-wizard.md)

# Install on macOS

This page shows how to run Arclight on a Mac using Docker Desktop. It is for someone trying Arclight on a Mac or using a Mac mini as a home server. A Mac works, but it is not the best home for an always-on setup, and a VPN is trickier than on Linux. Read the caveats before you decide.

## Read this first

| Topic | What to expect |
|---|---|
| Docker on macOS | Docker runs inside a small Linux virtual machine. Containers see your Mac folders through a file-sharing layer. |
| Speed | Reads and writes to Mac folders are slower than on Linux. Large libraries and heavy torrent activity feel it most. |
| Hardlinks | One shared mount holding downloads and library lets Arclight hard-link inside the container. Whether that link survives on the Mac file-sharing layer depends on your Docker Desktop version and settings. Test it (below). If it does not work, imports copy instead. |
| VPN | The Gluetun layouts need a TUN device and `NET_ADMIN` inside the container. Docker Desktop's Linux VM normally provides both, so the VPN layouts often work, but this is not tested by the project. Fall back to a VPN app on the Mac with the no-VPN layout if Gluetun fails. |
| Always on | Docker Desktop stops when you log out or the Mac sleeps. Set the Mac not to sleep and start Docker Desktop at login. |
| Apple Silicon | The published image is built for `linux/arm64` as well as `linux/amd64`, so it runs natively on M-series Macs. |

## Prerequisites

1. Docker Desktop for Mac, installed and running.
2. A TMDB API key (free). See [requirements.md](requirements.md).
3. For a VPN layout, a Proton WireGuard key: [install-docker.md](install-docker.md#get-your-proton-wireguard-key).

## 1. Create the folders

One parent folder holds everything:

```sh
mkdir -p ~/arclight/config ~/arclight/data/downloads ~/arclight/data/media/tv ~/arclight/data/media/movies
```

```
~/arclight/data
  downloads/
  media/
    tv/
    movies/
```

Keep the data on the Mac's internal disk or a fast external drive. A network share mounted on the Mac is not a good place for downloads. If you use an external drive, give Docker Desktop access to it and make sure the drive's format supports permissions and hardlinks (APFS or HFS+ do; exFAT and FAT do not).

In Docker Desktop's settings, check under Resources > File sharing (the exact label differs by version) that the folders you use are shared. Folders under your home directory usually are.

## 2. Configure

Get the compose files and `.env.example` from the repository's `docker/` folder. Copy `.env.example` to `.env` and set:

| Variable | Example | Meaning |
|---|---|---|
| `CONFIG_ROOT` | `/Users/you/arclight/config` | Config for each container (use your real home path) |
| `DATA_ROOT` | `/Users/you/arclight/data` | The single data mount, mapped to `/data` |
| `TZ` | `Etc/UTC` | Time zone, for example `America/New_York` |
| `PUID` / `PGID` | `1000` / `1000` | Container user. On macOS any value works for bind mounts; the Docker file-sharing layer maps ownership to your Mac user |

For a VPN layout also set `PROTON_WIREGUARD_KEY`, `VPN_COUNTRIES` and `LAN_SUBNET`, then run `sh scripts/gluetun-auth.sh` once from the repository root. Choose your layout from [install-docker.md](install-docker.md#1-choose-a-layout). Because the VPN layouts are least certain on a Mac, start with the no-VPN built-in layout first to prove the rest works.

## 3. Start

From the `docker/` folder:

```sh
docker compose -f docker-compose.release.novpn.yml up -d
```

(or the VPN file you chose). Then open `http://localhost:7878`. The setup wizard starts: [first-run-wizard.md](first-run-wizard.md). Set the root folders to `/data/media/tv` and `/data/media/movies`. The built-in engine's download folder defaults to `/data/downloads`; confirm it under Settings > Torrent Engine.

## 4. Verify

- `docker compose ps` shows everything running; `docker compose logs arclight` shows "Arclight starting as ...".
- After one download imports, run `ls -li` on the library file and on the file in `downloads` (when still seeding). The same inode number means a hardlink. Different numbers mean a copy; imports still work but use twice the disk space. See [hardlinks not working](../TROUBLESHOOTING.md#hardlinks-not-working).
- Using VPN: the dashboard VPN card shows Connected and a public IP that is not your home address.

## Using a VPN app on the Mac instead

If Gluetun does not work, run your VPN app on the Mac and use a no-VPN layout. Be aware that the VPN app then covers the whole Mac, but Docker Desktop's VM may or may not route container traffic through it, depending on the app and Docker version. Verify with the public IP shown in Arclight (Settings > VPN) or from the container before trusting it. Arclight cannot bind the engine to a macOS network adapter from inside a Docker container. If you need that, run Arclight natively instead (see the native steps in [install-windows.md](install-windows.md), which use Node 24 and pnpm 10; the Mac equivalent has the same commands with shell syntax), using Settings > VPN with provider "Interface binding" and your VPN adapter's name.

## Gotchas

| Symptom | Likely cause and fix |
|---|---|
| Containers vanish after reboot | Docker Desktop not set to start at login |
| Everything stops at night | The Mac went to sleep; change Energy settings |
| "Mounts denied" or empty folders | The folder is not shared with Docker Desktop |
| Imports copy instead of linking | File-sharing layer or an exFAT drive; see above |
| Slow scans | Use a faster file-sharing implementation if Docker Desktop offers one, or keep data on the internal disk |
| Port 7878 in use | Change the left side of the port mapping |
| Gluetun keeps restarting | See [VPN will not connect](../TROUBLESHOOTING.md#vpn-wont-connect) |
| Other devices cannot reach Arclight | macOS firewall may block Docker; allow it, then browse to `http://<mac-ip>:7878` |

## Related

- [requirements.md](requirements.md)
- [install-docker.md](install-docker.md)
- [install-windows.md](install-windows.md)
- [folders-and-hardlinks.md](folders-and-hardlinks.md)
- [first-run-wizard.md](first-run-wizard.md)
- [../using/vpn.md](../using/vpn.md)
- [../TROUBLESHOOTING.md](../TROUBLESHOOTING.md)

# Install on Windows

This page covers two ways to run Arclight on a Windows PC: in Docker Desktop (with WSL2), or natively with Node. It is for someone using a Windows machine as a home server or just trying Arclight out. Pick Docker if the PC stays on and you want the same setup as everyone else; pick native if you do not want Docker, or want to use a VPN client you already run on Windows.

| | Docker Desktop (WSL2) | Native (Node) |
|---|---|---|
| Needs | Docker Desktop, WSL2 | Node 24, pnpm 10, the repository |
| VPN | Gluetun container (Proton WireGuard) | WireGuard for Windows, or a VPN app you run |
| Cloudflare solver | FlareSolverr container | Built in, drives your Edge or Chrome |
| Updates | Pull a new image | Pull the source and rebuild |
| Best for | Always-on server | Trying it out, single PC |

## Option A: Docker Desktop with WSL2

### Prerequisites

1. Windows 10 or 11 with virtualization enabled in the BIOS.
2. Docker Desktop, set to use the WSL2 backend (the default on recent versions).
3. A TMDB API key (free). See [requirements.md](requirements.md).
4. For a VPN layout, a Proton WireGuard key; see [install-docker.md](install-docker.md#get-your-proton-wireguard-key).

### Where to keep your files

This choice decides speed and whether hardlinks work.

- **Best:** keep the data folder inside the WSL Linux filesystem (for example `\\wsl$\Ubuntu\home\you\arclight\data`, which is `/home/you/arclight/data` from Linux). It is fast and behaves like a normal Linux disk, so hardlinks work. Downside: your media sits inside the WSL virtual disk, not as a normal Windows folder.
- **Simple:** use a Windows folder such as `D:\Arclight\data`, mounted as `/mnt/d/Arclight/data` in WSL. It works, but file access through that bridge is noticeably slower, and large libraries and heavy torrent I/O may suffer. Whether hardlinks work across it depends on your Docker Desktop and Windows version; test with the check below.

Whichever you pick, use **one** folder that holds everything and mount it once as `/data`:

```
data/
  downloads/
  media/
    tv/
    movies/
```

Separate mounts for downloads and media force a full copy per import and break seeding, because Linux cannot hard-link across two mounts, even on one disk. See [folders-and-hardlinks.md](folders-and-hardlinks.md).

### Set up the files

1. In a WSL terminal (or PowerShell), create the folders:

   ```sh
   mkdir -p ~/arclight/config ~/arclight/data/downloads ~/arclight/data/media/tv ~/arclight/data/media/movies
   ```

2. Get the compose files and `.env.example` from the repository's `docker/` folder (or the latest release). Copy `.env.example` to `.env` and set:

   | Variable | Example | Meaning |
   |---|---|---|
   | `CONFIG_ROOT` | `/home/you/arclight/config` | Config for each container |
   | `DATA_ROOT` | `/home/you/arclight/data` | The one data mount |
   | `TZ` | `Etc/UTC` | Time zone, for example `Europe/London` |
   | `PUID` / `PGID` | `1000` / `1000` | Owner ids. Inside WSL, `id -u` and `id -g` show yours |

   If you chose a Windows folder, use the Linux-style form of it: `D:\Arclight\data` becomes `/mnt/d/Arclight/data` when the compose command runs inside WSL. Run `docker compose` from the same place you wrote the paths for.
3. Choose a layout (VPN or not; the built-in engine is the default) in [install-docker.md](install-docker.md#1-choose-a-layout). For a VPN layout, also set `PROTON_WIREGUARD_KEY`, `VPN_COUNTRIES` and `LAN_SUBNET`, then run `.\scripts\gluetun-auth.ps1` once (PowerShell, repository root).
4. Start it from the `docker/` folder:

   ```sh
   docker compose -f docker-compose.release.yml up -d
   ```

### First start and checks

1. Open `http://localhost:7878`. The setup wizard appears: [first-run-wizard.md](first-run-wizard.md). Set root folders to `/data/media/tv` and `/data/media/movies`.
2. `docker compose ps` should show every container running; `docker compose logs arclight` shows "Arclight starting as ...".
3. To use Arclight from other devices, allow TCP 7878 in Windows Defender Firewall, and browse to `http://<pc-ip>:7878`.
4. The VPN card on the dashboard should show Connected if you use a VPN layout. Gluetun needs the TUN device and the `NET_ADMIN` capability, which Docker Desktop's Linux VM normally provides. If Gluetun restarts in a loop, see [VPN will not connect](../TROUBLESHOOTING.md#vpn-wont-connect).
5. Hardlink check after a first import: in WSL, `stat -c %h <imported file>` should print 2. If 1, see [hardlinks not working](../TROUBLESHOOTING.md#hardlinks-not-working).

### Docker Desktop gotchas

| Symptom | Cause and fix |
|---|---|
| Containers stop when you log out or reboot | Docker Desktop only runs while it runs. Enable "Start Docker Desktop when you sign in" and sign in automatically, or use a real server for 24/7. |
| Slow imports and listings on `/mnt/c` or `/mnt/d` | The Windows-to-WSL bridge is slow; move data into the WSL filesystem. |
| WSL uses lots of memory | Limit it in `.wslconfig` (memory and processors). FlareSolverr and Whisper are the heavy containers. |
| Port 7878 already in use | Change the left side of the port mapping. |
| `permission denied` | Folder not writable by `PUID:PGID`; see [permission denied](../TROUBLESHOOTING.md#permission-denied). |
| WSL virtual disk grows | It does not shrink on its own; keep media outside it if space is tight. |

## Option B: Native install (no Docker)

Native Windows runs from the source repository; there is no installer. For an always-on server, Docker is the better-tested route.

### Prerequisites

- Node 24 from nodejs.org and pnpm 10 (`corepack enable` or install pnpm separately).
- The repository (clone or download).
- ffprobe/ffmpeg on `PATH` if you want media analysis; without it, see [ffprobe-missing](../TROUBLESHOOTING.md#ffprobe-missing).
- A Microsoft Edge, Chrome, Brave or Chromium install for the built-in Cloudflare solver (Edge ships with Windows).

### Build and run

In PowerShell, from the repository folder:

```powershell
pnpm install
pnpm build
```

Then start the server, with its settings in environment variables. The web app folder must be given, or you only get the API:

```powershell
$env:ARCLIGHT_CONFIG   = "D:\Arclight\config"
$env:ARCLIGHT_WEB_DIST = "$PWD\apps\web\dist"
Set-Location apps\api
node dist\server.mjs
```

Open `http://localhost:7878`. Settings you may use:

| Variable | Default | What it does |
|---|---|---|
| `ARCLIGHT_CONFIG` | `.\config` next to where you start it | Database and logs. Set a fixed folder so it does not depend on the current directory. |
| `ARCLIGHT_WEB_DIST` | unset | Folder with the built web app (`apps\web\dist`). |
| `ARCLIGHT_PORT` | `7878` | HTTP port. |
| `ARCLIGHT_HOST` | `0.0.0.0` | Listen address. Use `127.0.0.1` to allow only this PC. |
| `ARCLIGHT_LOG_LEVEL` | `info` | Log detail. |
| `ARCLIGHT_TMDB_API_KEY` | unset | TMDB key used when none is saved in the UI. |
| `ARCLIGHT_TORRENT_ENGINE` | `1` | `0` stops the built-in torrent engine. |

There is no `/data` folder here. In the wizard you enter real Windows paths for your root folders (for example `D:\Media\TV` and `D:\Media\Movies`); network paths such as `\\nas\share` are accepted. The built-in engine's download folder defaults to a `downloads` folder next to the config folder; change it under Settings > Torrent Engine. Keep downloads and libraries on the same drive so imports can hard-link (NTFS supports it; a network share generally does not link across to a local drive). Run Arclight as a user that can read and write them.

`scripts\local-test.ps1` in the repository starts a throwaway test instance on its own port with its own config. It is for development, not for your real library.

### Start at login

Arclight has no installer or Windows service of its own. Use Task Scheduler to run the commands above at logon or boot, with the environment variables set. If you use the WireGuard for Windows option below, the task must run with administrator rights.

### VPN on native Windows

Gluetun is not available here. Arclight offers two options under Settings > VPN. The full reference is [vpn.md](../using/vpn.md).

**WireGuard for Windows (native):** Arclight installs and watches the tunnel for you.

1. Install the official WireGuard for Windows client from wireguard.com. Default location: `C:\Program Files\WireGuard\wireguard.exe`.
2. From your provider (for Proton, a WireGuard configuration with NAT-PMP port forwarding on), download the `.conf` file. Save it under a short name without spaces, for example `C:\vpn\proton-nl.conf`. The name without `.conf` is the tunnel name.
3. Start Arclight from an elevated PowerShell (Run as administrator), or from a task that runs with administrator rights. Installing a tunnel service needs them.
4. In Settings > VPN pick the provider **WireGuard for Windows (native)** and fill in:

   | Setting | Default | What it does |
   |---|---|---|
   | WireGuard config (.conf) | empty | Full path to the `.conf` file |
   | wireguard.exe | empty, meaning the default path above | Only if installed elsewhere |
   | Auto-start | on | Installs the tunnel service when it is not running (at most every 5 minutes; a manual Disconnect pauses this) |
   | Kill switch | on | Stops grabs and makes the torrent engine close its sockets when the adapter disappears or the handshake goes stale |
   | Public IP check URL | `https://api.ipify.org?format=json` | Where Arclight asks for its public IP |

5. Turn on Enable VPN monitoring, click Test, then Save. The state should read Connected and the public IP should not be your home address.

**Interface binding:** you run the VPN yourself (for example a VPN app) and give Arclight the adapter name as Windows shows it, such as `ProtonVPN` or `wg0`. Arclight watches the adapter's IPv4 address and binds the built-in torrent engine to it. It cannot start, stop or reconnect that VPN.

For either option:

- Set **Home public IP** to your ISP address (look it up while the VPN is off) so a check that reports it is flagged as a leak.
- The public IP check follows Windows routing, so it is only reliable with a full tunnel (`AllowedIPs = 0.0.0.0/0`).
- Keep Bind to VPN on (the default) in Settings > Torrent Engine.
- Only the torrent engine is bound to the VPN. Indexer searches and metadata use your normal connection.

### Native gotchas

| Symptom | Fix |
|---|---|
| Blank page or API only | `ARCLIGHT_WEB_DIST` not set or wrong |
| "Access denied" installing the tunnel | Not running as administrator |
| Settings vanish after restart | `ARCLIGHT_CONFIG` differs between runs |
| Cloudflare-protected indexer fails | No Edge/Chrome found; see [CLOUDFLARE.md](../CLOUDFLARE.md) |

Native installs have no login protection until you set it up. Arclight asks you to create an admin in the wizard; see [users-and-security.md](../using/users-and-security.md).

## Related

- [requirements.md](requirements.md)
- [install-docker.md](install-docker.md)
- [folders-and-hardlinks.md](folders-and-hardlinks.md)
- [first-run-wizard.md](first-run-wizard.md)
- [../using/vpn.md](../using/vpn.md)
- [../CLOUDFLARE.md](../CLOUDFLARE.md)
- [../TROUBLESHOOTING.md](../TROUBLESHOOTING.md)
- [../using/hardware-transcoding.md](../using/hardware-transcoding.md)

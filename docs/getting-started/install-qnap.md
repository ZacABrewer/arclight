# Install on a QNAP NAS

This page shows how to run Arclight on a QNAP NAS using Container Station, QNAP's Docker app. It is for someone with a QNAP that can run containers (an x86 or ARM64 model with Container Station installed). QNAP changes the Container Station screens between versions, so the steps describe what to look for, not exact menu text. The compose contents and environment variables are exact.

## What you will end up with

- One shared folder for all data: downloads and your TV and movie libraries.
- One folder for Arclight's configuration.
- Arclight and FlareSolverr running from a compose file in Container Station, reachable on port 7878.

## Before you start

1. Install Container Station from the App Center if it is not there, and open it once so it finishes setting up.
2. A TMDB API key (free). See [requirements.md](requirements.md).
3. Check your NAS can run the published image: it is built for `linux/amd64` and `linux/arm64` (see [requirements.md](requirements.md)). Older 32-bit ARM models cannot.
4. For a VPN layout, use the compose files from the repository's `docker/` folder and follow [install-docker.md](install-docker.md) for the Proton key and the Gluetun key script. That requires SSH access to run the script. The example here has no VPN.

## 1. Create the folders

In File Station (or Control Panel > Shared Folders), create:

| Folder | Example path | Used for |
|---|---|---|
| One shared folder `data` | `/share/data` | `DATA_ROOT`, the parent of everything below |
| `downloads` inside it | `/share/data/downloads` | Torrent downloads |
| `media/tv` and `media/movies` inside it | `/share/data/media/tv`, `/share/data/media/movies` | Libraries |
| Config folder | `/share/appdata/arclight` | Database, logs, settings |

The real path of a QNAP shared folder can look like `/share/CACHEDEV1_DATA/data` on some models, with `/share/data` as a link to it. Use whichever path Container Station's folder picker or an SSH `ls` shows to be real. If you are unsure, SSH in and run `ls -l /share` to see where the shared folders point.

Why one share holding everything: Arclight imports finished downloads with hardlinks, which only work inside one filesystem and one container mount. A share for downloads and another for media, mounted separately, forces a full copy for every import and breaks seeding. See [folders-and-hardlinks.md](folders-and-hardlinks.md).

## 2. Find the user and group IDs

`PUID` and `PGID` are the numeric ids of the user that should own the files. Over SSH:

```sh
id youruser
```

Use the `uid` and `gid` it prints. QNAP administrator accounts often have uid 0 or 500-ish values depending on the model; do not run the app as root if you can avoid it, but a dedicated user you create under Control Panel > Users is best. Make sure that user has read and write access to the `data` shared folder and the config folder (Shared Folders > Edit Shared Folder Permissions). Details: [Troubleshooting: permission denied](../TROUBLESHOOTING.md#permission-denied).

## 3. Create the application

In Container Station choose to create an application (the option that takes a compose / YAML file), name it `arclight`, and paste:

```yaml
services:
  arclight:
    image: ghcr.io/zacabrewer/arclight:latest
    container_name: arclight
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Etc/UTC
      - ARCLIGHT_FLARESOLVERR_URL=http://flaresolverr:8191
    volumes:
      - /share/appdata/arclight:/config
      - /share/data:/data
    ports:
      - "7878:7878"
      - "6881:6881"
      - "6881:6881/udp"
    restart: unless-stopped
    depends_on:
      - flaresolverr

  flaresolverr:
    image: ghcr.io/flaresolverr/flaresolverr:latest
    container_name: flaresolverr
    environment:
      - LOG_LEVEL=info
      - TZ=Etc/UTC
    restart: unless-stopped
```

Replace the two host paths, `PUID`, `PGID` and `TZ` (for example `America/New_York`). Container Station may not read a `.env` file; if yours does not, typing values straight into the file as above is the simplest approach.

| Item | What it does |
|---|---|
| `/config` | Arclight's database and settings. Back it up ([backup-restore.md](backup-restore.md)). |
| `/data` | The one data mount. Do not add separate mounts for downloads or media. |
| `6881` tcp and udp | The built-in torrent engine's default port. Remove these lines if you use only qBittorrent or usenet. |
| Port `7878` | The web UI. If QNAP or another app already uses it, change the left number. |

### Using qBittorrent instead

Add this service and use the same `/data` mount. In qBittorrent, open Options > Downloads and set the default save path to `/data/downloads`:

```yaml
  qbittorrent:
    image: lscr.io/linuxserver/qbittorrent:latest
    container_name: qbittorrent
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Etc/UTC
      - WEBUI_PORT=8080
    volumes:
      - /share/appdata/qbittorrent:/config
      - /share/data:/data
    ports:
      - "8080:8080"
    restart: unless-stopped
```

Then add it in Arclight under Settings > Download Clients with host `qbittorrent` and port 8080 ([download-clients.md](../using/download-clients.md)). If both engines run, give them different peer ports.

## 4. First start

1. Create the application and wait for both containers to show as running.
2. Open the Arclight container's logs. You should see "Arclight starting as ... (PUID:PGID)".
3. Browse to `http://<your-nas-ip>:7878`. You land in the setup wizard: [first-run-wizard.md](first-run-wizard.md). There is no default login.
4. Set the root folders to `/data/media/tv` and `/data/media/movies`. The built-in engine's download folder defaults to `/data/downloads` when `/data` exists; confirm it under Settings > Torrent Engine.

## 5. Verify it works

- No red health warnings on the dashboard.
- After one download imports, the file in the library and the one in downloads should share an inode (link count 2: `stat -c %h <file>` over SSH). If not, see [hardlinks not working](../TROUBLESHOOTING.md#hardlinks-not-working).

## Common gotchas

| Symptom | Likely cause |
|---|---|
| Container restarts at once | `/config` not writable by `PUID:PGID`. See [container restarting](../TROUBLESHOOTING.md#container-restarting). |
| "Permission denied" | The shared folder permissions do not include your user. |
| Imports copy instead of link | Downloads and media mounted as separate volumes, or on different shared folders. |
| Port 7878 refused from another PC | NAS firewall or Container Station network mode; only TCP 7878 is needed. |
| Image will not pull | NAS has no internet access to `ghcr.io`, or an unsupported CPU. |
| Folders you created appear empty inside the container | You used a path that is a link to a different volume; use the real path. |

## Updating

Pull the new image and recreate the application in Container Station (see [updating.md](updating.md)). Settings stay in `/config`.

## Related

- [requirements.md](requirements.md)
- [install-docker.md](install-docker.md)
- [install-portainer.md](install-portainer.md)
- [folders-and-hardlinks.md](folders-and-hardlinks.md)
- [first-run-wizard.md](first-run-wizard.md)
- [../TROUBLESHOOTING.md](../TROUBLESHOOTING.md)

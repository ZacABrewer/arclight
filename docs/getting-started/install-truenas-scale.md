# Install on TrueNAS SCALE

This page shows how to run Arclight on TrueNAS SCALE as a custom app (a Docker Compose app). It is for someone who already has a TrueNAS SCALE box with a storage pool and wants Arclight beside their media. TrueNAS changes its Apps screens between releases, so the steps below describe what to look for rather than exact menu text. Everything you put into Arclight itself (the compose file, the environment variables) is exact.

## What you will end up with

- One dataset for all your data, holding downloads and your TV and movie libraries.
- One dataset for Arclight's configuration.
- A user and group that own both datasets, with matching `PUID` and `PGID` in the app.
- Arclight (plus FlareSolverr, and optionally qBittorrent or a VPN) running as a custom app, reachable on port 7878.

## Before you start

1. A SCALE release that can install a custom app from a compose file (the Apps section has an option to install a custom app, or to paste YAML). Older releases only offer a form-based "custom app" and no compose; if that is you, update TrueNAS first.
2. A TMDB API key (free). See [requirements.md](requirements.md).
3. Decide on a VPN. For the VPN layouts, use the compose files in the repository's `docker/` folder and read [install-docker.md](install-docker.md) for the Proton key and the Gluetun key script. The example below has no VPN.

## 1. Create the datasets

Use Datasets in the TrueNAS web UI. Create these under your pool:

| Dataset | Example path | Used for |
|---|---|---|
| `data` | `/mnt/tank/data` | `DATA_ROOT`: the single parent of everything below |
| `data/downloads` | `/mnt/tank/data/downloads` | Torrent downloads |
| `data/media` | `/mnt/tank/data/media` | Libraries |
| `appdata/arclight` | `/mnt/tank/appdata/arclight` | `CONFIG_ROOT/arclight`: database, logs, settings |

Then make the library folders inside `data/media`: `tv` and `movies` (an ordinary folder created by the Shell, or a share, is fine).

Why this shape: Arclight imports finished downloads with hardlinks, which only work when the downloads folder and the library are on the same filesystem and in the same container mount. On TrueNAS, separate child datasets are separate filesystems, and a hardlink cannot cross them. The simplest way to keep hardlinks working is to make `downloads` and `media` plain folders inside the one `data` dataset, rather than separate datasets. If you prefer separate datasets for snapshots, you give up hardlinks and imports copy instead (see [folders-and-hardlinks.md](folders-and-hardlinks.md)).

Only one mount, `${DATA_ROOT}:/data`, goes into the container. Inside it you will have `/data/downloads`, `/data/media/tv` and `/data/media/movies`.

## 2. Pick the user and permissions

Arclight runs as the numeric user and group you give it in `PUID` and `PGID`. That user must be able to read and write both datasets.

1. In Credentials > Local Users, create a user for the apps (for example `arclight`) or use the built-in `apps` user. Note its numeric UID and its group's GID. TrueNAS commonly uses 568 for `apps`; check yours, do not assume.
2. Put those numbers in `PUID` and `PGID` below.
3. Set the dataset permissions so that user (or its group) owns the dataset and has write access. In the dataset's Permissions editor, set owner and group to that user and group and apply recursively.

Notes on ACLs:

- Datasets on SCALE use either POSIX or NFSv4 ACLs. If you mix ACL types between your pool, SMB shares and the container, you will get "permission denied". Pick a dataset preset suited to apps and SMB (the "Generic" or "SMB" presets are the usual choice), and edit the ACL rather than the plain Unix mode if the dataset uses NFSv4 ACLs.
- If you will also share `data` over SMB so you can browse files or feed Jellyfin, add the SMB user to the ACL as well, otherwise files created by Arclight are unreadable to it.

Details and fixes are in [Troubleshooting: permission denied](../TROUBLESHOOTING.md#permission-denied).

## 3. Create the app

In Apps, choose the option to install a custom app from YAML / a compose file, name it `arclight`, and paste this. Replace the three paths and IDs with your own values.

```yaml
services:
  arclight:
    image: ghcr.io/zacabrewer/arclight:latest
    container_name: arclight
    environment:
      - PUID=568
      - PGID=568
      - TZ=Etc/UTC
      - ARCLIGHT_FLARESOLVERR_URL=http://flaresolverr:8191
    volumes:
      - /mnt/tank/appdata/arclight:/config
      - /mnt/tank/data:/data
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

What each part is for:

| Item | What it does |
|---|---|
| `PUID` / `PGID` | The numeric user and group the app runs as. The container log confirms them with "Arclight starting as ..." |
| `TZ` | Time zone, for example `Europe/London`. |
| `/config` | The database and settings. Back it up ([backup-restore.md](backup-restore.md)). |
| `/data` | The one data mount. Never mount `/data/downloads` and `/data/media` as two separate volumes. |
| `6881` tcp and udp | The built-in torrent engine's default port. Remove these two lines if you only use usenet or an external client. |
| FlareSolverr | Lets indexers behind a Cloudflare challenge work. No settings needed; Arclight registers it automatically. |

Port 7878 on the host must be free. TrueNAS uses 80 and 443 for its own UI, so 7878 is normally fine; if another app uses it, change the left side, for example `"7979:7878"`.

If your TrueNAS version asks for host paths to be selected through a "host path" form instead of free text, add the same two paths there.

### Optional: qBittorrent

The built-in engine is all you need. If you also want qBittorrent, add a second service and mount the same `/data`:

```yaml
  qbittorrent:
    image: lscr.io/linuxserver/qbittorrent:latest
    container_name: qbittorrent
    environment:
      - PUID=568
      - PGID=568
      - TZ=Etc/UTC
      - WEBUI_PORT=8080
    volumes:
      - /mnt/tank/appdata/qbittorrent:/config
      - /mnt/tank/data:/data
    ports:
      - "8080:8080"
      - "6881:6881"
      - "6881:6881/udp"
    restart: unless-stopped
```

If both engines run, give them different peer ports. In qBittorrent, open Options > Downloads and set the default save path to `/data/downloads`. Then add it in Arclight under Settings > Download Clients with host `qbittorrent` and port 8080 (see [download-clients.md](../using/download-clients.md)). Keep qBittorrent on your LAN only.

## 4. First start

1. Deploy the app and wait for both containers to show as running.
2. Open the app's logs. Arclight prints "Arclight starting as ... (PUID:PGID)" and then starts listening.
3. Browse to `http://<your-truenas-ip>:7878`. On a fresh install you land in the setup wizard: [first-run-wizard.md](first-run-wizard.md). There is no default login; you create the admin in the wizard.
4. In the wizard, set your root folders to `/data/media/tv` and `/data/media/movies`.
5. The built-in engine saves to `/data/downloads` by default when `/data` exists. Check it under Settings > Torrent Engine.

## 5. Verify it works

- The dashboard shows no red health warnings. Root folder warnings point to [Troubleshooting](../TROUBLESHOOTING.md#empty-root-folder) pages.
- Add a series, let one download finish and import, then check that the library file and the download share a link count of 2 (in the TrueNAS Shell: `stat -c %h <file>`). If it is 1, see [hardlinks not working](../TROUBLESHOOTING.md#hardlinks-not-working).

## Common gotchas

| Symptom | Likely cause |
|---|---|
| Container restarts at once | The `/config` dataset is not writable by the user. See [container restarting](../TROUBLESHOOTING.md#container-restarting). |
| "Permission denied" on import | ACL or ownership mismatch on `data`. See [permission denied](../TROUBLESHOOTING.md#permission-denied). |
| Imports copy instead of link | `downloads` and `media` are separate datasets, or mounted as separate volumes. |
| Apps do not start after a TrueNAS update or pool change | The pool for apps is not selected or is unavailable; fix in the Apps settings. |
| Reaching the UI from another VLAN fails | Firewall or network rules; Arclight needs TCP 7878 only. |

## Updating

Pull the new image by redeploying or updating the app (see [updating.md](updating.md)). Your `/config` dataset keeps all settings.

## Related

- [requirements.md](requirements.md)
- [install-docker.md](install-docker.md)
- [install-portainer.md](install-portainer.md)
- [folders-and-hardlinks.md](folders-and-hardlinks.md)
- [first-run-wizard.md](first-run-wizard.md)
- [updating.md](updating.md)
- [../TROUBLESHOOTING.md](../TROUBLESHOOTING.md)

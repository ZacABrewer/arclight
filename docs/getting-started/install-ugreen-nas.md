# Install on a UGREEN NAS (UGOS)

This page walks through installing Arclight on a UGREEN NAS running UGOS, using its Docker app. It is for someone who has never used Docker on a NAS, and it is complete on its own. UGREEN changes menu names between UGOS versions, so each step says what you are trying to do and what to look for rather than quoting exact menu text. If a label here does not match your screen, look for the closest one. The compose files and `.env` values are exact.

## What you will end up with

- One data folder on the NAS with `downloads`, `media/tv` and `media/movies` inside it.
- One folder for container settings (Arclight's database, Gluetun, and so on).
- A numeric user and group id (`PUID` and `PGID`) that owns all of it.
- A Docker project running Arclight, plus Gluetun and FlareSolverr (and qBittorrent if you pick that layout).

## Why a single data folder

Arclight and qBittorrent both mount one folder, `DATA_ROOT`, at `/data`. Downloads live in `/data/downloads` and the library in `/data/media/tv` and `/data/media/movies`. When a download finishes, Arclight imports it by hard link: instant, no extra space, and the torrent keeps seeding. Linux cannot hard-link between two different mounts, even on the same disk, so separate mounts for downloads and library force a full copy on every import (slow, and double the space). Keep all three folders inside one data folder on the same volume. See [folders-and-hardlinks.md](folders-and-hardlinks.md).

## Before you start

1. Pick a layout in the chooser in [install-docker.md](install-docker.md#1-choose-a-layout). On a NAS with a VPN, "VPN + built-in engine" needs the fewest containers.
2. For a VPN layout, get your VPN credentials first. Proton is the documented default: [how to get the key](install-docker.md#4-get-your-vpn-credentials-vpn-layouts). Other providers: [notes](install-docker.md#other-vpn-providers).
3. Make sure the Docker app is installed and running (look in the NAS's app store or app center).

## Create the folders

Use the NAS's file manager or shared-folder settings to create:

| Folder | Example path | Used for |
|---|---|---|
| Data share | `/volume1/data` | `DATA_ROOT` |
| Downloads | `/volume1/data/downloads` | Torrent downloads (`/data/downloads` in the containers) |
| TV library | `/volume1/data/media/tv` | `/data/media/tv` |
| Movie library | `/volume1/data/media/movies` | `/data/media/movies` |
| Container settings | `/volume1/docker/appdata` | `CONFIG_ROOT` |

These paths are examples. Your volume may not be named `volume1`. To find the real path, connect over SSH (next section) and run `ls /`, or look at the folder's properties in the file manager. Use the path Linux sees, not the share name you see from Windows.

## Find your PUID and PGID

The containers run as a numeric user and group so the files they create belong to a real NAS user.

1. Turn on SSH. In the UGOS settings look for an SSH or terminal option under the system, network or services area (the name depends on your version).
2. From your computer connect: `ssh <your-nas-user>@<nas-ip>` (for example `ssh admin@192.168.1.x`).
3. Run `id <the-user-who-should-own-the-media>`. Example output: `uid=1000(media) gid=10(users) groups=10(users)`.
4. The number after `uid=` is your `PUID`; the number after `gid=` is your `PGID`.

Tip: create a dedicated NAS user for media and use its numbers. If a media server (Jellyfin, Plex, Emby) reads the same files, give it the same group so it can read what Arclight writes.

## Set folder permissions

The `PUID` user must be able to read and write everything under both the data folder and the settings folder. Either:

- **Use the NAS permission screens.** Give that user read and write on the data share and the settings folder and apply it to subfolders (look for an "apply to all subfolders" option).
- **Or use SSH** (replace the numbers and paths with yours; `1000:10` is `PUID:PGID`):

  ```sh
  sudo mkdir -p /volume1/data/downloads /volume1/data/media/tv /volume1/data/media/movies /volume1/docker/appdata
  sudo chown -R 1000:10 /volume1/data /volume1/docker/appdata
  sudo chmod -R u+rwX,g+rwX /volume1/data /volume1/docker/appdata
  ```

Create the folders yourself before starting. If a mounted folder is missing, Docker creates it owned by `root` and Arclight then cannot write to it. System > Health shows [`docker-puid-pgid-mismatch`](../TROUBLESHOOTING.md#docker-puid-pgid-mismatch) or [`permissions-error`](../TROUBLESHOOTING.md#permissions-error).

## Get the compose file and `.env` onto the NAS

Choose one way.

**A. Over SSH (most predictable).**

1. Copy the Arclight repository (or the release download) to the NAS, for example to `/volume1/docker/arclight-stack`. A VPN layout needs the whole repository because the helper script is in `scripts/`. Without a VPN, the compose file and `.env.example` from the release are enough.
2. In the `docker/` folder copy `.env.example` to `.env` and fill it in:

   ```ini
   PUID=1000
   PGID=10
   TZ=Etc/UTC
   CONFIG_ROOT=/volume1/docker/appdata
   DATA_ROOT=/volume1/data
   PROTON_WIREGUARD_KEY=<your-key>
   VPN_COUNTRIES=Netherlands
   LAN_SUBNET=192.168.1.0/24
   GLUETUN_API_KEY=
   ```

   Every variable is explained in [install-docker.md](install-docker.md#3-create-the-env-file). Set `LAN_SUBNET` to your own network and `TZ` to your time zone. Leave the VPN lines out of a no-VPN setup.
3. VPN layouts: from the repository root run `sh scripts/gluetun-auth.sh`. It fills in `GLUETUN_API_KEY` in `docker/.env` and writes `/volume1/docker/appdata/gluetun/auth/config.toml`. Details: [install-docker.md](install-docker.md#5-set-up-the-gluetun-control-key-vpn-layouts).
4. Start it:

   ```sh
   cd /volume1/docker/arclight-stack/docker
   docker compose -f docker-compose.release.yml up -d
   ```

   If your NAS shell only has the older `docker-compose` command, use that.

**B. Through the Docker app.** Look for a Projects, Compose or "create from YAML" feature. In it:

1. Create a project named `arclight`.
2. Point it at a folder on the NAS or paste in the contents of the compose file you chose.
3. Make the `.env` values available: put a `.env` file in the project folder, or, if the app only takes pasted YAML, replace every `${VARIABLE:-default}` with your real value.
4. Deploy or start the project.

Method A avoids pasting and is easier to repeat when you update.

## Open Arclight

1. Wait a minute or two. In a VPN layout Gluetun needs up to a minute to connect before the others start.
2. In the Docker app, check the containers are running (Gluetun healthy). Each container's log view is your first stop if one is not.
3. Browse to `http://<nas-ip>:7878`. In a VPN layout the port is published by the `gluetun` container, but the address is still the NAS.
4. You land in the setup wizard: [first-run-wizard.md](first-run-wizard.md). Use `/data/media/tv` and `/data/media/movies` as the root folders.
5. qBittorrent users: in qBittorrent's web UI (`http://<nas-ip>:8080`) set Tools > Options > Downloads > **Default Save Path** to `/data/downloads`, and add it in Arclight with host `localhost` (VPN layout) or `qbittorrent` (no-VPN layout), port `8080`.

## Common problems

| Symptom | Likely cause | What to do |
|---|---|---|
| Port 7878 does not open | Still starting, or another app uses 7878 | Wait for Gluetun to be healthy, or change the host side of the mapping (`"7979:7878"`) |
| Containers keep restarting | VPN key missing or wrong, or no `/dev/net/tun` | [container restarting](../TROUBLESHOOTING.md#container-restarting), [VPN won't connect](../TROUBLESHOOTING.md#vpn-wont-connect) |
| Health message about the container user | `PUID`/`PGID` do not own the folders | Re-check with `id`, fix the numbers or `chown`, restart the containers |
| Imports fail with "permission denied" | The user cannot write to the library folder | [permission denied](../TROUBLESHOOTING.md#permission-denied) |
| Imports copy instead of hard-linking | Downloads and library are on different mounts or volumes | [folders-and-hardlinks.md](folders-and-hardlinks.md) |

## Moving from an older install

If you started with separate `/tv`, `/movies` and `/downloads` mounts, follow [Migrating from the old three-mount layout](install-docker.md#migrating-from-the-old-three-mount-layout).

## Related

- [requirements.md](requirements.md)
- [install-docker.md](install-docker.md)
- [install-other-platforms.md](install-other-platforms.md)
- [folders-and-hardlinks.md](folders-and-hardlinks.md)
- [first-run-wizard.md](first-run-wizard.md)
- [../TROUBLESHOOTING.md](../TROUBLESHOOTING.md)

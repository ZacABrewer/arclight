# Install on a Raspberry Pi

This page shows how to run Arclight on a Raspberry Pi (or another ARM64 single-board computer) with Docker. It is for someone who wants a small, quiet, low-power box. It works, but a Pi has limited memory and slow storage, so the choices below matter more than on a bigger machine.

## What you need

| Item | Why |
|---|---|
| A Pi with a 64-bit CPU (Pi 4, Pi 5, Pi 400 or Compute Module 4/5) | The published image is built for `linux/arm64` and `linux/amd64` only (see [RELEASING.md](../RELEASING.md)). A 32-bit-only board cannot run it. |
| A 64-bit OS | Raspberry Pi OS Lite (64-bit) or Ubuntu Server for ARM64. Check with `uname -m`: it must print `aarch64`. A 32-bit OS on a 64-bit Pi will not pull the image. |
| Storage that is not the SD card | Use an SSD or a good USB hard drive for the data and config. See below. |
| A TMDB API key (free) | [requirements.md](requirements.md) |
| Docker with Compose v2 | Install from Docker's official instructions for Debian or Ubuntu |

## Resources: be realistic

The project publishes no minimum CPU or RAM figure. Practical points:

- Arclight itself is small (the image is about 80 MB). The heavy containers are FlareSolverr (a headless browser) and the optional Whisper speech model. On a Pi with 2 GB of RAM or less, consider skipping both. A Pi 4 or 5 with 4 GB or more is more comfortable.
- If a container is killed for memory, add swap or remove an optional container first. See [container restarting](../TROUBLESHOOTING.md#container-restarting).
- Whisper on a Pi CPU is very slow. Leave its profile off.
- The first start after an update runs database migrations; give it a minute.

## Storage: use an SSD

An SD card wears out quickly under the constant small writes of a database, logs and torrent traffic, and it is slow for seeding. Put both the config (`CONFIG_ROOT`) and the data (`DATA_ROOT`) on an SSD or a hard drive attached by USB 3 (use a powered hub or drive if it browns out the Pi).

1. Format the drive as ext4 (not exFAT or NTFS: they lack Linux permissions and good hardlink support).
2. Mount it at a fixed path through `/etc/fstab` using the drive's UUID, for example `/mnt/ssd`, so it mounts on every boot. Ensure the containers start after the mount (a missing mount makes Docker create empty folders on the SD card).
3. Create the folders:

   ```sh
   sudo mkdir -p /mnt/ssd/appdata /mnt/ssd/data/downloads /mnt/ssd/data/media/tv /mnt/ssd/data/media/movies
   sudo chown -R 1000:1000 /mnt/ssd/appdata /mnt/ssd/data
   ```

The layout is one parent, `data`, holding `downloads` and `media`. It is mounted once as `/data`, which is what lets imports hard-link instantly instead of copying and keeps seeding working. See [folders-and-hardlinks.md](folders-and-hardlinks.md).

If your media lives on a network share (NAS over NFS or SMB), downloads must be on the same share to hard-link. Mount that share once and point `DATA_ROOT` at it.

## PUID and PGID

Run `id` as the user who owns the folders. The default Raspberry Pi OS first user is usually 1000:1000, but check. Put the numbers in `PUID` and `PGID`. The container log shows "Arclight starting as ... (PUID:PGID)".

## Set up and start

1. Get the compose files and `.env.example` from the repository's `docker/` folder (or from the latest release). Copy `.env.example` to `.env` next to the compose file:

   ```
   PUID=1000
   PGID=1000
   TZ=Etc/UTC
   CONFIG_ROOT=/mnt/ssd/appdata
   DATA_ROOT=/mnt/ssd/data
   ```

2. Choose a layout in [install-docker.md](install-docker.md#1-choose-a-layout). For a VPN layout also set `PROTON_WIREGUARD_KEY`, `VPN_COUNTRIES` and `LAN_SUBNET` and run `sh scripts/gluetun-auth.sh` once. Gluetun needs `/dev/net/tun`; on Raspberry Pi OS it exists by default. If not, `sudo modprobe tun`.
3. Start it with a release file (published image):

   ```sh
   docker compose -f docker-compose.release.novpn.yml up -d
   ```

   Do not use the build-from-source files on a Pi: building the image there takes a long time and a lot of memory, and the published ARM64 image already exists.
4. Watch the first start: `docker compose logs -f arclight`. The first image pull is slow on a Pi. Allow several minutes.
5. Browse to `http://<pi-ip>:7878`. The setup wizard starts: [first-run-wizard.md](first-run-wizard.md). Root folders: `/data/media/tv` and `/data/media/movies`. The built-in engine saves to `/data/downloads` by default when `/data` exists.

## Verify

- `docker compose ps` shows every container up.
- The dashboard has no red warnings; storage warnings about low space refer to your SSD.
- After a first import, `stat -c %h <library file>` prints 2 when hardlinks work. If not, see [hardlinks not working](../TROUBLESHOOTING.md#hardlinks-not-working).
- With a VPN: the dashboard VPN card shows Connected.

## Gotchas

| Symptom | Likely cause and fix |
|---|---|
| `exec format error` or "no matching manifest" | 32-bit OS, or an image that is not arm64. Use a 64-bit OS and the published image. |
| Everything is slow or the Pi hangs | Running from an SD card, or too little RAM. Move to an SSD; drop FlareSolverr/Whisper. |
| Folders empty after reboot | The SSD was not mounted when Docker started. Mount with fstab and delay Docker or the containers until it is up. |
| "Permission denied" | Folder owner does not match `PUID:PGID`. See [permission denied](../TROUBLESHOOTING.md#permission-denied). |
| Pi reboots while downloading | Power supply or an unpowered USB drive. |
| Overheating | Add a heatsink or fan; sustained transcode or hashing load is real work for a Pi. |
| Slow engine start | See [slow engine start](../TROUBLESHOOTING.md#slow-engine-start). |

## Related

- [requirements.md](requirements.md)
- [install-docker.md](install-docker.md)
- [folders-and-hardlinks.md](folders-and-hardlinks.md)
- [first-run-wizard.md](first-run-wizard.md)
- [updating.md](updating.md)
- [../TROUBLESHOOTING.md](../TROUBLESHOOTING.md)
- [../using/hardware-transcoding.md](../using/hardware-transcoding.md)

# Install with Docker Compose (Linux)

This is the reference install for Arclight: Docker Compose on an ordinary Linux machine (a home server, a mini PC, a VM, a Raspberry Pi-class board with 64-bit Linux). You pick one ready-made compose file from the `docker/` folder, fill in a small `.env` file, optionally set up a VPN, and start the stack. This page is complete on its own. The NAS and platform guides ([Synology](install-synology.md), [UGREEN](install-ugreen-nas.md), [Unraid](install-unraid.md), and the others listed in [install-other-platforms.md](install-other-platforms.md)) use the same files and settings with platform-specific clicks.

Check [requirements.md](requirements.md) first.

## The folder layout: one share, one mount

Arclight (and qBittorrent, if you opt in to it) mounts one folder from your machine, `DATA_ROOT`, at `/data` inside the container. Inside it, lay out three folders:

```
<DATA_ROOT>/
  downloads/        torrents land here
  media/
    tv/             TV root folder     (Arclight sees /data/media/tv)
    movies/         movie root folder  (Arclight sees /data/media/movies)
```

Every path Arclight (and qBittorrent, if used) talks about starts with `/data`. In Arclight you add `/data/media/tv` and `/data/media/movies` as root folders (the wizard does this, see [first-run-wizard.md](first-run-wizard.md)).

**Why one mount and not three?** When a download finishes, Arclight puts it in your library by creating a hard link: a second name for the same file on disk. That is instant, uses no extra space, and lets the torrent keep seeding the original. Linux cannot create a hard link between two different mounts, even when they are on the same disk. If downloads and the library are mounted separately (`/downloads` and `/tv`, for example), every import silently falls back to a full copy: slow, and it needs double the space until you delete the original. One mount that contains both makes hard links work. More detail and how to test it: [folders-and-hardlinks.md](folders-and-hardlinks.md).

Keep `downloads/`, `media/tv` and `media/movies` on the same disk or volume, too, since a hard link also cannot cross filesystems.

The built-in torrent engine downloads to `/data/downloads` when `/data` exists in the container; installs created before this layout keep their old `/downloads` folder until you change it under Settings > Torrent Engine.

**If you use qBittorrent:** in qBittorrent, open Tools > Options > Downloads and set **Default Save Path** to `/data/downloads`. Then Arclight and qBittorrent report identical paths and you need no remote path mapping.

## 1. Choose a layout

Do you want a VPN? Every layout uses Arclight's built-in torrent engine by default; qBittorrent is an optional extra (see [Optional: qBittorrent](#optional-qbittorrent)).

| Layout | Containers started by default | Published ports | Published-image file | Build-from-source file |
|---|---|---|---|---|
| VPN + built-in engine | gluetun, flaresolverr, arclight | 7878 (on gluetun) | `docker-compose.release.yml` | `docker-compose.yml` (`docker-compose.builtin.yml` is the same stack) |
| No VPN, built-in engine | arclight, flaresolverr | 7878 | `docker-compose.release.novpn.yml` | `docker-compose.novpn.yml` |

Notes:

- **VPN layouts** put Arclight (and qBittorrent, if you add it) inside Gluetun's network (`network_mode: "service:gluetun"`). All their traffic leaves through the WireGuard tunnel, and Gluetun's firewall blocks everything else, so a dropped tunnel cuts them off. Arclight also pauses grabs and pauses the built-in engine's torrents. See [vpn.md](../using/vpn.md).
- **Built-in engine** means torrents run inside Arclight, so there is no download client container. On the first start, when no download client exists, Arclight adds one called **Built-in**. See [download-clients.md](../using/download-clients.md).
- **Release vs build-from-source.** The `release` files pull the ready-made image (`ghcr.io/zacabrewer/arclight`, tag `latest` by default). The other files build the image from the repository on your machine, which takes several minutes and needs the whole repository. Use a release file unless you are changing the code. Build-from-source Arclight containers are not offered for self-update.
- **No VPN: peer port.** The no-VPN files publish only the web UI (7878). For better incoming connectivity with the built-in engine, publish its peer port (default 6881, tcp and udp) on the `arclight` service. If you also start qBittorrent without a VPN, it publishes 6881 itself, so give the two different peer ports.
- Without a VPN leave Settings > VPN disabled.

<a id="optional-qbittorrent"></a>
### Optional: qBittorrent

The compose files include a `qbittorrent` service behind the compose profile `qbittorrent`. Arclight does not depend on it and it does not start unless you ask:

```sh
docker compose -f docker-compose.release.yml --profile qbittorrent up -d
```

In the VPN layouts the WebUI port line (`8080`) on the `gluetun` service is commented out; uncomment it to reach the qBittorrent WebUI from your LAN. In the no-VPN layouts the service publishes 8080 and 6881 itself. Then follow [Using qBittorrent](#using-qbittorrent) after the stack is up. If you install through a tool that cannot use profiles, copy the `qbittorrent` service block out of the compose file instead.

The compose files and `.env.example` are attached to every GitHub release and live in the repository's `docker/` folder. The helper scripts in `scripts/` are only in the repository, so download or clone the whole repository for a VPN layout.

## 2. Create the folders

Pick two locations on your machine and create them. The examples use `/srv/arclight`:

```sh
sudo mkdir -p /srv/arclight/appdata
sudo mkdir -p /srv/arclight/data/downloads /srv/arclight/data/media/tv /srv/arclight/data/media/movies
```

Find the numeric user and group that should own the files: run `id <username>`; `uid=` is `PUID` and `gid=` is `PGID`. Then give that user ownership:

```sh
sudo chown -R 1000:1000 /srv/arclight
```

Do this before the first start. If a mounted folder does not exist, Docker creates it owned by `root`, and Arclight then cannot write to it ([Troubleshooting: permission denied](../TROUBLESHOOTING.md#permission-denied)).

## 3. Create the `.env` file

Copy `docker/.env.example` to `docker/.env` (next to the compose file) and edit it. Compose reads it automatically.

| Variable | Default if unset | What it does |
|---|---|---|
| `PUID` | `1000` | Numeric user id the containers run as. Must own your folders. |
| `PGID` | `1000` | Numeric group id for the same purpose. |
| `TZ` | `UTC` | Time zone for schedules and the calendar, for example `Etc/UTC` or `Europe/London`. |
| `CONFIG_ROOT` | `./data` | Parent folder for each container's settings: `<CONFIG_ROOT>/arclight`, `/gluetun`, and `/qbittorrent` and `/whisper` if you enable those. Example: `/srv/arclight/appdata`. |
| `DATA_ROOT` | `./data/share` | The one share mounted at `/data`. Contains `downloads`, `media/tv`, `media/movies`. Example: `/srv/arclight/data`. |
| `PROTON_WIREGUARD_KEY` | none (required in VPN layouts) | The `PrivateKey` from a Proton WireGuard configuration. Treat it like a password. |
| `VPN_COUNTRIES` | `Netherlands` | Comma-separated Proton server countries. Use a country that allows P2P. |
| `LAN_SUBNET` | `192.168.1.0/24` | Your home network, so you can still reach the web UIs through Gluetun's firewall. Change it if your network is not `192.168.1.x`. |
| `GLUETUN_API_KEY` | empty | Key for Gluetun's control server. Written for you by the helper script in step 5. |

Advanced variables you normally leave alone:

| Variable | Default | What it does |
|---|---|---|
| `ARCLIGHT_IMAGE` | the project's published image, `latest` | Release files only. Pin a version, for example `ghcr.io/zacabrewer/arclight:v0.2.0`, to stop the image moving. |
| `ARCLIGHT_SUBNET` | `172.30.53.0/24` | VPN layouts: fixed Docker subnet so Gluetun's firewall can allow it and the optional Whisper container can have a fixed address. Change only if it collides with another Docker network. |
| `ARCLIGHT_SUBNET_DYNAMIC` | `172.30.53.0/25` | Lower half of that subnet, used for automatically assigned addresses. |
| `WHISPER_IP` | `172.30.53.200` | VPN layouts: fixed address of the optional Whisper container. |

Changing a subnet value needs one `docker compose down`, because Docker recreates the network.

## 4. Get your VPN credentials (VPN layouts)

<a id="get-your-proton-wireguard-key"></a>
### Proton (the documented default)

The compose files are written for Proton VPN over WireGuard with port forwarding. You need a configuration with port forwarding switched on, otherwise torrents cannot receive incoming connections.

1. Sign in at account.proton.me and open **VPN > Downloads > WireGuard configuration**.
2. Name the configuration, pick any platform, and turn on **NAT-PMP (port forwarding)**. Pick a server in a country that allows P2P, and use that country in `VPN_COUNTRIES`.
3. Create it, then copy the value after `PrivateKey =` in the `[Interface]` section into `PROTON_WIREGUARD_KEY` in `.env`.
4. Keep it secret: do not paste it in support requests or screenshots.

Gluetun connects with this key itself; you do not import the rest of the file.

### Other VPN providers

Gluetun, the VPN container used here, supports many providers besides Proton (Mullvad, AirVPN, Private Internet Access, Windscribe, NordVPN and others). The compose files ship configured for Proton only. To use another provider, edit the `gluetun` service's `environment:` block in your compose file:

| Setting | Proton (as shipped) | Another provider |
|---|---|---|
| `VPN_SERVICE_PROVIDER` | `protonvpn` | The provider's name as listed in the Gluetun wiki |
| `VPN_TYPE` | `wireguard` | `wireguard` or `openvpn`, as your provider allows |
| Credentials | `WIREGUARD_PRIVATE_KEY=${PROTON_WIREGUARD_KEY}` | Whatever the Gluetun wiki page for that provider lists (for example a WireGuard key plus address, or OpenVPN user and password) |
| `SERVER_COUNTRIES` | `${VPN_COUNTRIES}` | Same setting, using that provider's country names |
| `VPN_PORT_FORWARDING` | `on` | Only if your provider supports port forwarding through Gluetun |

Things to know:

- **Port forwarding support differs by provider.** Only Proton port forwarding is set up and tested by these files. For any other provider, check the Gluetun wiki page for that provider and your provider's own documentation. If it is not supported, remove the `VPN_PORT_FORWARDING=on` line. Torrents still download without a forwarded port, but you may connect to fewer peers.
- The rest of the setup does not change: Arclight (and qBittorrent, if you use it) still shares Gluetun's network, and the control key from step 5 still applies.
- Do not put secrets from another provider into the repository files you share; keep them in `.env` or an environment-specific copy.
- Arclight reports the forwarded port only if Gluetun does. In Settings > VPN the forwarded port stays empty when the provider offers none ([vpn.md](../using/vpn.md)).

<a id="4-set-up-the-gluetun-control-key-vpn-layouts-only"></a>
## 5. Set up the Gluetun control key (VPN layouts)

Current Gluetun releases protect their control server with an API key. Arclight reads VPN status, your public IP and the forwarded port from it. A helper script generates a key and writes everything both sides need. Run it once, from the repository root:

| Platform | Command |
|---|---|
| Linux, macOS, NAS shell | `sh scripts/gluetun-auth.sh` |
| Windows PowerShell | `.\scripts\gluetun-auth.ps1` |

It does three things:

1. Creates `docker/.env` from `docker/.env.example` if it does not exist.
2. Generates a random key and stores it as `GLUETUN_API_KEY` in `docker/.env`. Running it again keeps the existing key.
3. Writes `<CONFIG_ROOT>/gluetun/auth/config.toml` for Gluetun, with a read-only role for Arclight. `CONFIG_ROOT` is read from `docker/.env`; pass a folder as the first argument (`-ConfigRoot` on Windows) to override.

Set `CONFIG_ROOT` in `.env` before running it so the file lands in the folder Gluetun mounts. The compose files hand `GLUETUN_API_KEY` to Arclight as `ARCLIGHT_VPN_API_KEY`, so you type nothing into Settings > VPN. If you change the key later, run `docker compose down` and `docker compose up -d`, because containers that share Gluetun's network must be recreated whenever Gluetun restarts.

## 6. Start the stack

From the `docker/` folder, with the file you chose:

```sh
docker compose -f docker-compose.release.yml up -d
```

For a build-from-source file add `--build`. Gluetun has up to a minute to connect; the other containers wait for it to be healthy. Check progress:

```sh
docker compose -f docker-compose.release.yml ps
docker compose -f docker-compose.release.yml logs -f arclight
docker compose -f docker-compose.release.yml logs -f gluetun
```

Press Ctrl+C to stop following. The Arclight log should include `Arclight starting as <user>:<group> (<PUID>:<PGID>)`, which confirms your ids were applied. If a container keeps restarting, see [container restarting](../TROUBLESHOOTING.md#container-restarting); for VPN trouble see [VPN won't connect](../TROUBLESHOOTING.md#vpn-wont-connect).

Open `http://<your-host>:7878`. On a fresh install you land in the setup wizard: [first-run-wizard.md](first-run-wizard.md). There is no default login; you create the admin account there.

The built-in engine is already registered as a download client, so there is nothing more to set up for downloads.

<a id="using-qbittorrent"></a>
**Using qBittorrent (optional).** If you started the `qbittorrent` profile, open its web UI at `http://<your-host>:8080`, set the login it asks for, and set **Default Save Path** to `/data/downloads` as described above. Then add it in Arclight under Settings > Download Clients with host `localhost` and port `8080` (VPN layout) or host `qbittorrent` and port `8080` (no-VPN layout).

| Task | Command |
|---|---|
| Restart Arclight only | `docker restart arclight` |
| Stop everything (data stays) | `docker compose -f <file> down` |
| Pull newer images and recreate | `docker compose -f <file> pull && docker compose -f <file> up -d` |

## FlareSolverr (Cloudflare challenges)

Every compose file runs FlareSolverr so indexers behind a Cloudflare challenge still work. You do not configure it. Arclight receives its address through `ARCLIGHT_FLARESOLVERR_URL` and, shortly after boot, adds an indexer proxy called **FlareSolverr (bundled)** tagged `cloudflare`. In the VPN layouts it shares Gluetun's network, so its traffic also goes through the tunnel; port 8191 is never published. See [indexers.md](../using/indexers.md) and [CLOUDFLARE.md](../CLOUDFLARE.md).

## Whisper (optional subtitles from speech)

Every compose file has a `whisper` service that is off by default. It generates subtitles from audio when no subtitle provider has a result. Enable it with the profile:

```sh
docker compose -f docker-compose.release.yml --profile whisper up -d
```

Arclight finds it through `ARCLIGHT_WHISPER_URL` (`http://whisper:9000`, already set), checks on boot and hourly, and adds Whisper as the lowest-priority subtitle provider when it answers. The default model is `base` on the CPU; a GPU variant is included as commented lines in the file. On a VPN stack created before the fixed subnet existed, run `docker compose down` once so the network is recreated. See [subtitles.md](../using/subtitles.md).

## Self-update (optional)

The release files label their containers `arclight.autoupdate=true`. To let Arclight pull a new image and recreate those containers from Settings > Updates, uncomment this line in the Arclight service's `volumes:` list:

```yaml
      - /var/run/docker.sock:/var/run/docker.sock
```

That gives Arclight control of the Docker host, so it is off by default and Arclight stays in "notify only" mode. Without it, update checks still work and only the "Update now" button is unavailable. `ARCLIGHT_DOCKER_SOCKET` points at a different socket path. Full procedure, including the manual way: [updating.md](updating.md).

## Migrating from the old three-mount layout

Earlier versions mounted three separate folders: `/tv`, `/movies` and `/downloads`. If you installed that way, every import has been a full copy. To switch to one share:

1. **Back up first.** Make a backup from System > Backups ([backup-restore.md](backup-restore.md)) and note your current folder paths.
2. **Stop the stack:** `docker compose -f <file> down`. Pause or finish active downloads first; a stopped client does not lose them, but moving a folder under a running torrent breaks it.
3. **Build the single share.** On the same disk or volume, create `data/` and move your folders into it so you end up with `data/downloads`, `data/media/tv` and `data/media/movies`. Moving a folder within one volume is instant (`mv`); across disks it copies, so plan the target on the disk with the most free space. Keep ownership as `PUID:PGID`.
4. **Update the compose file and `.env`.** Use the current compose file from the release (it has one `${DATA_ROOT}:/data` mount per service). In `.env` remove `TV_ROOT`, `MOVIES_ROOT` and `DOWNLOADS_ROOT`, and add `DATA_ROOT=<path to the data folder>`.
5. **Start the stack** and open Arclight.
6. **Add the new root folders.** In Settings > Media Management add `/data/media/tv` (TV) and `/data/media/movies` (movies).
7. **Point existing titles at them.** In the Library, select your titles, use the **Root folder** action in the selection bar and choose the new root folder. Arclight rebuilds each title's path from the new root plus the title folder. Folders that Arclight created have matching names; folders that came from another app may have a different name, so open one title and check that its path matches the folder on disk. Then remove the old `/tv` and `/movies` root folders from Media Management.
8. **Rescan.** Refresh and rescan your titles (from the title's page, or the scheduled tasks under System > Tasks) so Arclight re-reads the files at their new location. Files that still show as missing after a rescan mean the title's path does not match the folder on disk.
9. **Download folder.** Under Settings > Torrent Engine set the download folder to `/data/downloads` (older installs keep `/downloads`). If you use qBittorrent, set **Default Save Path** to `/data/downloads` in Tools > Options > Downloads. Torrents that were saved under `/downloads` need to be moved to the new path (set the location in the client) or removed and re-added.
10. **Check hard links.** Import something small, then follow the test in [folders-and-hardlinks.md](folders-and-hardlinks.md).

## What to do next

1. Finish the [first-run wizard](first-run-wizard.md).
2. Add your indexers ([indexers.md](../using/indexers.md)) and check the VPN card on the dashboard ([vpn.md](../using/vpn.md)).
3. Make a backup once things work ([backup-restore.md](backup-restore.md)).

## Related

- [requirements.md](requirements.md)
- [install-other-platforms.md](install-other-platforms.md)
- [first-run-wizard.md](first-run-wizard.md)
- [folders-and-hardlinks.md](folders-and-hardlinks.md)
- [updating.md](updating.md)
- [backup-restore.md](backup-restore.md)
- [../using/vpn.md](../using/vpn.md)
- [../TROUBLESHOOTING.md](../TROUBLESHOOTING.md)

# Install on Unraid

This page installs Arclight on Unraid. Unraid's own Docker tab works with templates, while Arclight ships Docker Compose files, so there are two routes: the Docker Compose Manager plugin (recommended, uses the supplied files unchanged) or the command line. It is complete on its own. Menu names change between Unraid versions, so steps describe the purpose and give typical labels.

## Why one data share

Arclight (and qBittorrent, if you add it) mounts one folder, `DATA_ROOT`, at `/data`: downloads in `/data/downloads`, library in `/data/media/tv` and `/data/media/movies`. A finished download is imported by hard link (instant, no extra space, seeding continues). Linux cannot hard-link between two different mounts, even on the same disk, so separate mounts force a full copy on every import. On Unraid there is a second catch: a share can span several array disks, and a hard link cannot cross disks. Use one share (for example `data`) for downloads and media, and set it so new files stay together (for example a split level that keeps a title's files on one disk, or a single-disk or pool-only share). See [folders-and-hardlinks.md](folders-and-hardlinks.md).

## 1. Choose a layout

Use the chooser in [install-docker.md](install-docker.md#1-choose-a-layout). For a VPN layout get your credentials first: [Proton steps](install-docker.md#4-get-your-vpn-credentials-vpn-layouts), [other providers](install-docker.md#other-vpn-providers).

## 2. Create the shares

1. In the Shares tab create a share named `data`. Inside it, from the Unraid terminal or a file manager, create `downloads`, `media/tv` and `media/movies`:

   ```sh
   mkdir -p /mnt/user/data/downloads /mnt/user/data/media/tv /mnt/user/data/media/movies
   ```

2. Container settings go in `/mnt/user/appdata` (the usual Unraid location), with a subfolder per container created automatically.
3. Find the user ids. Unraid's usual container user is `nobody:users`, normally `PUID=99` and `PGID=100`. Confirm with `id nobody` in the terminal.
4. Make that user the owner:

   ```sh
   chown -R nobody:users /mnt/user/data
   chmod -R u+rwX,g+rwX /mnt/user/data
   ```

## 3. Install a way to run compose

**Docker Compose Manager plugin (recommended).** In the Apps tab (Community Applications) search for "Compose Manager" and install the Docker Compose Manager plugin. It adds a Compose section to the Docker tab where you create a stack and paste a compose file and its environment values.

**Command line.** If your Unraid version provides `docker compose` in the terminal, you can run the files there as shown in [install-docker.md](install-docker.md#6-start-the-stack). If it does not, use the plugin.

## 4. Create the stack

1. In the plugin, add a new stack named `arclight`.
2. Paste the contents of the compose file you chose (for example `docker-compose.release.yml`).
3. Open the stack's environment (`.env`) editor and enter:

   ```ini
   PUID=99
   PGID=100
   TZ=Etc/UTC
   CONFIG_ROOT=/mnt/user/appdata
   DATA_ROOT=/mnt/user/data
   PROTON_WIREGUARD_KEY=<your-key>
   VPN_COUNTRIES=Netherlands
   LAN_SUBNET=192.168.1.0/24
   GLUETUN_API_KEY=
   ```

   Variable meanings: [install-docker.md](install-docker.md#3-create-the-env-file). Set `LAN_SUBNET` to your network and `TZ` to your time zone. Leave the VPN lines out for a no-VPN layout.
4. VPN layouts: generate the Gluetun control key. The helper script is in the repository's `scripts/` folder; run `sh scripts/gluetun-auth.sh /mnt/user/appdata` on any machine that has the repository, then copy the `GLUETUN_API_KEY=` line into the stack's `.env` and the file it wrote (`gluetun/auth/config.toml`) into `/mnt/user/appdata/gluetun/auth/`. See [the script](install-docker.md#5-set-up-the-gluetun-control-key-vpn-layouts).
5. Start ("Compose Up") the stack. Gluetun needs up to a minute to connect; the other containers wait for it.

If you prefer not to use the plugin, put the same compose file and `.env` in a folder on the flash drive or an appdata subfolder and run `docker compose -f <file> up -d` from there.

## 5. Open Arclight

1. Browse to `http://<unraid-ip>:7878`. In a VPN layout the ports are published by the `gluetun` container, but the address is your server.
2. Complete the [setup wizard](first-run-wizard.md). Root folders are `/data/media/tv` and `/data/media/movies`.
3. Optional: qBittorrent. The built-in engine is already set up, so you only need this if you want qBittorrent too. Start the stack with the `qbittorrent` profile (or paste the `qbittorrent` service from the compose file), open `http://<unraid-ip>:8080`, set Tools > Options > Downloads > **Default Save Path** to `/data/downloads`, and add the client in Arclight with host `localhost` (VPN) or `qbittorrent` (no VPN), port `8080`. In VPN layouts uncomment the `8080` port line on `gluetun` first.

Unraid's web UI normally uses ports 80 and 443, so 7878 (and 8080, if you use qBittorrent) are free unless another container took them. If a port is taken, change the left side of the mapping, for example `"7979:7878"`. A VPN layout needs the `tun` device (normally present on Unraid); no-VPN layouts do not.

## Common problems

| Symptom | Likely cause | What to do |
|---|---|---|
| Health message about the container user | `PUID`/`PGID` do not own the share | Use 99/100 or the owner of `data`; `chown` and restart ([docker-puid-pgid-mismatch](../TROUBLESHOOTING.md#docker-puid-pgid-mismatch)) |
| Imports copy instead of hard-linking | Downloads and library on different disks, or different mounts | Keep one share on one disk; [folders-and-hardlinks.md](folders-and-hardlinks.md) |
| Containers keep restarting | Wrong VPN key, or Gluetun cannot start | [container restarting](../TROUBLESHOOTING.md#container-restarting), [VPN won't connect](../TROUBLESHOOTING.md#vpn-wont-connect) |

Moving from an older install with separate `/tv`, `/movies` and `/downloads` mounts: [migration steps](install-docker.md#migrating-from-the-old-three-mount-layout).

## Related

- [requirements.md](requirements.md)
- [install-docker.md](install-docker.md)
- [install-other-platforms.md](install-other-platforms.md)
- [folders-and-hardlinks.md](folders-and-hardlinks.md)
- [first-run-wizard.md](first-run-wizard.md)
- [updating.md](updating.md)

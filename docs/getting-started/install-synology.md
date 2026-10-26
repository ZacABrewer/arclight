# Install on a Synology NAS (DSM)

This page installs Arclight on a Synology NAS using DSM's Container Manager and its Project feature, or SSH if you prefer the command line. It is complete on its own and written for someone new to Docker. DSM menu names change between versions, so steps are described by purpose and the names are given as typical labels, not guarantees. The compose files and `.env` values are exact.

## What you need

- DSM 7.2 or newer with the Container Manager package (older DSM calls it Docker and has no Projects; use SSH there).
- A volume with free space, and an account that can use SSH (an administrator).
- For a VPN layout: credentials from your VPN provider ([Proton steps](install-docker.md#4-get-your-vpn-credentials-vpn-layouts), [other providers](install-docker.md#other-vpn-providers)).

## Why one data folder

Arclight and qBittorrent both mount one folder, `DATA_ROOT`, at `/data`: downloads in `/data/downloads`, library in `/data/media/tv` and `/data/media/movies`. A finished download is imported by hard link (instant, no extra space, seeding continues). Linux cannot hard-link between two different mounts, even on one disk, so separate mounts for downloads and library force a full copy on every import. Keep all three folders inside one shared folder on one volume. More in [folders-and-hardlinks.md](folders-and-hardlinks.md).

## 1. Choose a layout

Use the chooser in [install-docker.md](install-docker.md#1-choose-a-layout). "VPN + built-in engine" is the smallest VPN stack; "No VPN, with qBittorrent" is the simplest.

## 2. Create the folders

1. In Control Panel > Shared Folder (or File Station) create one shared folder for your data, for example `data`. Inside it create `downloads`, `media/tv` and `media/movies`.
2. Create a shared folder for container settings, for example `docker`, with a subfolder `appdata`.
3. Create or pick a user that should own the files. Give it Read/Write on both shared folders (Control Panel > Shared Folder > Edit > Permissions, or the equivalent in your version).

The Linux paths are normally `/volume1/data` and `/volume1/docker/appdata`, but your volume may be named differently. Confirm over SSH with `ls /`.

## 3. Find PUID and PGID

1. Enable SSH in Control Panel > Terminal & SNMP (the label may vary).
2. Connect: `ssh <admin-user>@<nas-ip>`.
3. Run `id <the-owner-user>`. Example: `uid=1026(media) gid=100(users)`. The `uid=` number is `PUID`, the `gid=` number is `PGID`.

## 4. Check the TUN device (VPN layouts only)

Gluetun needs `/dev/net/tun`. Run `ls -l /dev/net/tun` over SSH. If it is missing, some Synology models only provide it after the `tun` kernel module is loaded, usually by a boot-time task running as root. Check your model's notes. This is a host setting, not an Arclight setting. No-VPN layouts do not need it.

## 5. Put the files on the NAS

1. Download the release files (compose file and `.env.example`) into `/volume1/docker/arclight-stack`. For a VPN layout copy the whole repository instead, because the helper script lives in `scripts/`.
2. In the `docker/` folder (or beside the compose file) copy `.env.example` to `.env` and edit:

   ```ini
   PUID=1026
   PGID=100
   TZ=Etc/UTC
   CONFIG_ROOT=/volume1/docker/appdata
   DATA_ROOT=/volume1/data
   PROTON_WIREGUARD_KEY=<your-key>
   VPN_COUNTRIES=Netherlands
   LAN_SUBNET=192.168.1.0/24
   GLUETUN_API_KEY=
   ```

   Variable meanings: [install-docker.md](install-docker.md#3-create-the-env-file). Set `LAN_SUBNET` to your own network, and `TZ` to your time zone.
3. VPN layouts: from the repository root run `sudo sh scripts/gluetun-auth.sh`. It fills in `GLUETUN_API_KEY` and writes `/volume1/docker/appdata/gluetun/auth/config.toml`. See [step 5](install-docker.md#5-set-up-the-gluetun-control-key-vpn-layouts).

## 6. Start the stack

**With Container Manager Projects (typical labels):**

1. Open Container Manager and go to Project, then Create.
2. Give the project a name, set the path to the folder that holds the compose file and `.env`, and choose to use the existing compose file.
3. Continue through the wizard and start the project.

**Or over SSH:**

```sh
cd /volume1/docker/arclight-stack/docker
sudo docker compose -f docker-compose.release.yml up -d
```

Gluetun needs up to a minute to connect; the other containers wait for it. In Container Manager, the Container view shows each container's status and logs. If one keeps restarting, see [container restarting](../TROUBLESHOOTING.md#container-restarting).

## 7. Open Arclight

1. Browse to `http://<nas-ip>:7878`. In a VPN layout the ports are published by the `gluetun` container, but the address is the NAS.
2. Complete the [setup wizard](first-run-wizard.md). Root folders are `/data/media/tv` and `/data/media/movies`.
3. qBittorrent users: open `http://<nas-ip>:8080`, and set Tools > Options > Downloads > **Default Save Path** to `/data/downloads`. In Arclight add the client with host `localhost` (VPN layout) or `qbittorrent` (no-VPN), port `8080`.

DSM's own services may already use ports 7878 or 8080 in rare cases. If a port is taken, change the left side of the mapping, for example `"7979:7878"`.

## Common problems

| Symptom | Likely cause | What to do |
|---|---|---|
| Health message about the container user | `PUID`/`PGID` do not own the folders | Re-check with `id`; fix the numbers or the share permissions; restart containers ([docker-puid-pgid-mismatch](../TROUBLESHOOTING.md#docker-puid-pgid-mismatch)) |
| "Permission denied" on import | The user lacks write access to the shared folder | [permission denied](../TROUBLESHOOTING.md#permission-denied) |
| Gluetun restarts in a loop | Missing TUN device or wrong key | Step 4 above; [VPN won't connect](../TROUBLESHOOTING.md#vpn-wont-connect) |
| Imports are slow and use double space | Downloads and library on different mounts | [folders-and-hardlinks.md](folders-and-hardlinks.md) |

Moving from an older install with separate `/tv`, `/movies` and `/downloads` mounts: [migration steps](install-docker.md#migrating-from-the-old-three-mount-layout).

## Related

- [requirements.md](requirements.md)
- [install-docker.md](install-docker.md)
- [install-other-platforms.md](install-other-platforms.md)
- [folders-and-hardlinks.md](folders-and-hardlinks.md)
- [first-run-wizard.md](first-run-wizard.md)
- [updating.md](updating.md)

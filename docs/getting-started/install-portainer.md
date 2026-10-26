# Install with Portainer

This page shows how to run Arclight as a Portainer stack: you paste a compose file into Portainer's web editor, fill in environment variables, and deploy. It is for anyone who manages Docker through Portainer on a NAS or server and prefers clicking to typing commands. The example uses the published image, a VPN (Gluetun) and Arclight's built-in torrent engine. Portainer's menu names change slightly between versions, so look for the nearest label.

## Before you start

1. Portainer running and connected to your Docker host (the "local" environment).
2. Folders on the host. Create one parent that holds everything:

   ```
   /path/to/data
     downloads/
     media/
       tv/
       movies/
   /path/to/appdata
   ```

   Only `/path/to/data` is mounted into the containers, as `/data`. Do not mount downloads and media as separate volumes: Linux cannot hard-link across two mounts even on one disk, so every import becomes a full copy and seeding breaks. See [folders-and-hardlinks.md](folders-and-hardlinks.md).
3. The folders must be writable by your `PUID` and `PGID` (run `id` on the host for yours). See [permission denied](../TROUBLESHOOTING.md#permission-denied).
4. For the VPN: a Proton WireGuard key with port forwarding on ([how](install-docker.md#get-your-proton-wireguard-key)). No VPN? Use the second example below.
5. A TMDB API key (free).

## The Gluetun control key

Current Gluetun versions protect the control server with an API key. The repository helper script (`scripts/gluetun-auth.sh`) normally creates the key and the auth file under `<CONFIG_ROOT>/gluetun/auth/config.toml`. In Portainer you can run that script once on the host over SSH, or use a non-VPN stack. If you skip it, Arclight still runs, but its VPN status may show errors; see [install-docker.md](install-docker.md#4-set-up-the-gluetun-control-key-vpn-layouts-only) for the details.

## Create the stack (VPN + built-in engine)

1. In Portainer open Stacks > Add stack, name it `arclight`, and choose the Web editor.
2. Paste this:

```yaml
services:
  gluetun:
    image: qmcgaw/gluetun:latest
    container_name: gluetun
    cap_add:
      - NET_ADMIN
    devices:
      - /dev/net/tun:/dev/net/tun
    environment:
      - VPN_SERVICE_PROVIDER=protonvpn
      - VPN_TYPE=wireguard
      - WIREGUARD_PRIVATE_KEY=${PROTON_WIREGUARD_KEY}
      - SERVER_COUNTRIES=${VPN_COUNTRIES:-Netherlands}
      - VPN_PORT_FORWARDING=on
      - FIREWALL_OUTBOUND_SUBNETS=${LAN_SUBNET:-192.168.1.0/24}
      - HTTP_CONTROL_SERVER_ADDRESS=:8000
      - HTTP_CONTROL_SERVER_LOG=off
      - TZ=${TZ:-Etc/UTC}
    volumes:
      - ${CONFIG_ROOT}/gluetun:/gluetun
    ports:
      - "7878:7878" # Arclight, published on gluetun
    healthcheck:
      test: ["CMD", "/gluetun-entrypoint", "healthcheck"]
      interval: 30s
      timeout: 10s
      start_period: 60s
      retries: 3
    restart: unless-stopped

  flaresolverr:
    image: ghcr.io/flaresolverr/flaresolverr:latest
    container_name: flaresolverr
    network_mode: "service:gluetun"
    environment:
      - LOG_LEVEL=info
      - TZ=${TZ:-Etc/UTC}
    restart: unless-stopped
    depends_on:
      gluetun:
        condition: service_healthy

  arclight:
    image: ghcr.io/zacabrewer/arclight:latest
    container_name: arclight
    network_mode: "service:gluetun"
    environment:
      - PUID=${PUID:-1000}
      - PGID=${PGID:-1000}
      - TZ=${TZ:-Etc/UTC}
      - ARCLIGHT_VPN_CONTROL_URL=http://localhost:8000
      - ARCLIGHT_VPN_API_KEY=${GLUETUN_API_KEY:-}
      - ARCLIGHT_FLARESOLVERR_URL=http://localhost:8191
    volumes:
      - ${CONFIG_ROOT}/arclight:/config
      - ${DATA_ROOT}:/data
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:7878/api/v1/system/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      start_period: 20s
      retries: 3
    restart: unless-stopped
    depends_on:
      gluetun:
        condition: service_healthy
      flaresolverr:
        condition: service_started
```

3. Scroll to Environment variables. Add each (Advanced mode lets you paste them as `NAME=value` lines):

| Variable | Example | Meaning |
|---|---|---|
| `PUID` | `1000` | Numeric user that owns your folders |
| `PGID` | `1000` | Numeric group |
| `TZ` | `Etc/UTC` | Time zone, for example `America/New_York` |
| `CONFIG_ROOT` | `/path/to/appdata` | Parent of each container's config |
| `DATA_ROOT` | `/path/to/data` | The single data mount, `/data` in the container |
| `PROTON_WIREGUARD_KEY` | `<your-key>` | Proton WireGuard private key. Treat like a password |
| `VPN_COUNTRIES` | `Netherlands` | Proton countries that allow P2P |
| `LAN_SUBNET` | `192.168.1.0/24` | Your home network, so you can reach the UI through the VPN firewall |
| `GLUETUN_API_KEY` | `<your-key>` | Control-server key from the helper script; may be empty |

4. Click Deploy the stack.

If you use the helper script's auth file with a different key layout than this example, copy the extra lines from `docker/docker-compose.release.yml` in the repository (it also shows the optional fixed subnet and Whisper service).

## No VPN: the simple stack

Replace the whole file with:

```yaml
services:
  arclight:
    image: ghcr.io/zacabrewer/arclight:latest
    container_name: arclight
    environment:
      - PUID=${PUID:-1000}
      - PGID=${PGID:-1000}
      - TZ=${TZ:-Etc/UTC}
      - ARCLIGHT_FLARESOLVERR_URL=http://flaresolverr:8191
    volumes:
      - ${CONFIG_ROOT}/arclight:/config
      - ${DATA_ROOT}:/data
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
      - TZ=${TZ:-Etc/UTC}
    restart: unless-stopped
```

It needs only `PUID`, `PGID`, `TZ`, `CONFIG_ROOT` and `DATA_ROOT`. Leave Settings > VPN disabled in Arclight.

## First start and checks

1. Under Stacks > arclight every container should show running (healthy for gluetun and arclight). Click a container and open Logs to read its output. The Arclight log has "Arclight starting as ... (PUID:PGID)".
2. Browse to `http://<your-host>:7878`. The wizard appears: [first-run-wizard.md](first-run-wizard.md). Root folders: `/data/media/tv` and `/data/media/movies`.
3. Confirm Settings > Torrent Engine saves to `/data/downloads` (the built-in engine's default when `/data` exists). In the VPN stack, in Settings > VPN choose provider Gluetun, enable monitoring, and in Settings > Torrent Engine keep Bind to VPN on. See [vpn.md](../using/vpn.md).
4. If the stack is stuck on gluetun, see [VPN will not connect](../TROUBLESHOOTING.md#vpn-wont-connect). A restart loop is covered in [container restarting](../TROUBLESHOOTING.md#container-restarting).

## Updating the stack

1. Open the stack and click Update the stack (or Editor, then Update).
2. Turn on the option to re-pull the image (wording varies: "Re-pull image and redeploy"), then confirm. This downloads the newest `latest` image and recreates the containers. Your settings stay in `CONFIG_ROOT`.
3. To control the version, replace `latest` with a release tag such as `v0.2.0` in the file.
4. In a VPN stack, recreate the whole stack rather than one container: containers sharing gluetun's network must be recreated whenever gluetun restarts.

Arclight can also update its own containers from Settings > Updates, but that needs the Docker socket mounted into it, which gives it full control of the host. It is off by default. See [updating.md](updating.md) before enabling it. Back up first: [backup-restore.md](backup-restore.md).

## Gotchas

| Symptom | Cause and fix |
|---|---|
| "Variable is not set" or blank value | Add it under Environment variables, not only in the YAML |
| Containers recreated but Arclight cannot reach the VPN | Redeploy the stack as a whole |
| Imports copy instead of linking | Downloads and media are mounted separately; use the single `DATA_ROOT:/data` mount |
| Empty library after redeploy | A different `CONFIG_ROOT` or `DATA_ROOT` value was used |
| Permission errors | Wrong `PUID`/`PGID` |

## Related

- [install-docker.md](install-docker.md)
- [install-truenas-scale.md](install-truenas-scale.md)
- [folders-and-hardlinks.md](folders-and-hardlinks.md)
- [updating.md](updating.md)
- [backup-restore.md](backup-restore.md)
- [../using/vpn.md](../using/vpn.md)
- [../TROUBLESHOOTING.md](../TROUBLESHOOTING.md)

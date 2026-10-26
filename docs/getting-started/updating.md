# Updating Arclight

This page covers how Arclight finds new versions, how to update it (automatically or by hand), how to stay on a specific version, and how to go back if an update goes wrong. Everyone who runs Arclight needs it sooner or later.

## How updates work

Arclight can do two things about updates:

| Mode | What happens | What you need |
|---|---|---|
| **Notify only** (default) | Arclight tells you a new version exists (a health warning and the System > Updates page). You update it yourself. | Nothing |
| **Update automatically** | Arclight pulls the new image and restarts its containers for you, once a day, inside a time window you choose. | The Docker socket mounted into the Arclight container (see below) |

Automatic updates only exist for Docker installs. A native install (for example on Windows) is always notify only.

## Settings > Updates

Open Settings > Updates. These are the options:

| Setting | Default | What it does |
|---|---|---|
| Check for updates (toggle "Ask GitHub for new releases") | On | Turns the version check on or off. |
| Channel | Stable | **Stable** = tagged releases only. **Develop** = pre-releases and the develop image (every push to the main branch; may break). |
| Check every | 24 hours | How often to look for a new version. 1 to 168 hours. |
| Health warning (toggle "Show a health warning while updates wait") | On | Shows a warning on System > Health while an update is available. |
| Mode | Notify only | "Notify only" or "Update automatically". The automatic choice is greyed out when the Docker socket is not available. |
| Update window | 03:00 to 06:00 | Local time. Automatic updates run once a day between these hours. The window can cross midnight. Equal start and end hours mean any time of day. |
| Repository (advanced view only) | The project's GitHub repository | Where releases are looked up. Leave it alone unless you run your own fork. |

System > Updates shows the current and latest version and the list of containers (see below).

## Release channels and image tags

The Docker image is published as `ghcr.io/zacabrewer/arclight` with these tags:

| Tag | What it is |
|---|---|
| `vX.Y.Z` (for example `v0.1.0`) | One exact release. Never changes. |
| `X.Y` | The newest patch release of that minor version. |
| `latest` | The newest stable release. This is what the compose files use by default. |
| `develop` | Built from every push to the main branch. Can break. |

Choosing the **Develop** channel only changes which versions Arclight announces. The image you run is whatever your compose file names. For the develop image, set `ARCLIGHT_IMAGE` (see [Pin a version](#pin-a-version)).

## Update by hand (Docker)

This always works, with or without the Docker socket.

1. Back up first (optional but wise): see [backup-restore.md](backup-restore.md).
2. Open a terminal in the folder with your compose file. The shipped files are `docker-compose.release.yml` (with the VPN) and `docker-compose.release.novpn.yml` (without it).
3. Pull and recreate:

   ```sh
   docker compose pull
   docker compose up -d
   ```

   To update only Arclight and leave the other containers alone:

   ```sh
   docker compose pull arclight && docker compose up -d arclight
   ```

   If you use the no-VPN file, add `-f docker-compose.release.novpn.yml` to each command.
4. Open Arclight. Migrations of the database run on start; the first load may take a few seconds.
5. Check System > Status for the new version.

Your data lives in the `/config` mount, so nothing is lost when the container is recreated.

## Automatic updates through the Docker socket

> Security note: mounting the Docker socket gives Arclight root-equivalent control of the Docker host. Only do this if you accept that. If you do not, stay on notify only and update by hand.

To turn it on:

1. In your compose file, under the Arclight service `volumes:`, uncomment the line

   ```yaml
   - /var/run/docker.sock:/var/run/docker.sock
   ```

2. Recreate the container: `docker compose up -d`.
3. Go to Settings > Updates, set **Mode** to "Update automatically", and check the **Update window**.

If the socket is not there, Arclight tells you why on the Updates page:

- "Notify only: the Docker socket is not mounted at /var/run/docker.sock. Update by pulling the image."
- "Notify only: Arclight is not running in Docker. Install new releases from GitHub."

The container entrypoint adds Arclight's user to the socket's group on start, so no extra permission setup is normally needed. If your socket is somewhere else, set `ARCLIGHT_DOCKER_SOCKET` to its path.

### What the container labels do

Arclight only updates containers that carry the label `arclight.autoupdate=true`. In the shipped release compose files that label is on Arclight itself, Gluetun, FlareSolverr and (when you enable them) qBittorrent and Whisper. Remove the label from any container you want left alone, or add it to one that is missing.

On the System > Updates page the containers pane lists each labelled container with these columns: Container, Image, Network, Digest, State. States are "Up to date", "Update available", "Not updatable" and "Check failed". Buttons: "Check now", "Update all" and a per-container "Update now".

A container is not updatable when:

- It is pinned to a digest ("Pinned to a digest; not updated").
- It was built locally and has no registry image to compare ("Built locally; there is no registry image to compare").

### How an automatic update runs

1. Arclight checks labelled containers once a day (hourly job that skips if the last check is under 20 hours old) and only inside the update window. It compares the registry digest of each image.
2. For each container with a newer image it pulls the image, creates the new container next to the old one, stops the old one, swaps the names, starts the new one and removes the old one. If something fails, it rolls back to the old container.
3. Containers that share another container's network (the VPN setup, where Arclight uses the Gluetun network) are recreated after the container they depend on.
4. When Arclight updates itself, a short-lived helper container named `arclight-updater-<number>` does the swap. Expect Arclight to be unreachable for a few seconds.

You can also press "Check now", "Update all" or "Update now" at any time to skip the schedule.

## Pin a version

To stay on one version and never move by accident:

1. Open your `.env` file next to the compose file.
2. Set the image to an exact tag:

   ```
   ARCLIGHT_IMAGE=ghcr.io/zacabrewer/arclight:v0.1.0
   ```

3. Recreate: `docker compose up -d`.

When you want to move, change the tag and run `docker compose pull && docker compose up -d`.
## Roll back

Database changes made by a newer version are not undone when you go back. So the safe order is:

1. Stop Arclight.
2. Restore a backup taken before the update ([backup-restore.md](backup-restore.md)), or copy back your `/config` folder if you saved it.
3. Pin the older version in `.env` as shown above.
4. `docker compose up -d`.

An older Arclight refuses to restore a backup made by a newer version, so always keep a backup from before you updated.

## Native install (Windows)

1. Download the new release from the project's GitHub releases page.
2. Stop Arclight.
3. Replace the program files with the new ones.
4. Start Arclight. Your config folder is kept and migrated on start.

## Troubleshooting

| Problem | Likely cause |
|---|---|
| "Update available" warning will not go away | You are not updating, or the image tag is pinned. Pull the new image or turn off **Health warning** |
| Mode "Update automatically" is greyed out | Docker socket not mounted |
| A container shows "Not updatable" | Pinned to a digest, or built locally |
| Arclight stays down after an update | See [Container restarting](../TROUBLESHOOTING.md#container-restarting) |

The two related health checks are "Update available" and "Container updates available" (System > Health).

## Related

- [Install with Docker](install-docker.md)
- [Back up and restore](backup-restore.md)
- [System pages](../using/system.md)
- [Release process](../RELEASING.md)
- [Container restarting](../TROUBLESHOOTING.md#container-restarting)

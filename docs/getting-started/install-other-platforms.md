# Choose your install guide

Arclight runs the same way everywhere: a Docker Compose stack (or, on Windows, a native install) with one data folder, a few settings in a `.env` file, and the web UI on port 7878. This page helps you pick the guide that matches your hardware. Every guide is complete on its own.

| Your setup | Guide |
|---|---|
| Any Linux machine or VM with Docker (the reference guide, with every setting explained) | [install-docker.md](install-docker.md) |
| Synology NAS (DSM, Container Manager) | [install-synology.md](install-synology.md) |
| UGREEN NAS (UGOS Docker app) | [install-ugreen-nas.md](install-ugreen-nas.md) |
| Unraid | [install-unraid.md](install-unraid.md) |
| TrueNAS SCALE | [install-truenas-scale.md](install-truenas-scale.md) |
| QNAP NAS | [install-qnap.md](install-qnap.md) |
| Windows (Docker Desktop or native) | [install-windows.md](install-windows.md) |
| macOS | [install-macos.md](install-macos.md) |
| Raspberry Pi | [install-raspberry-pi.md](install-raspberry-pi.md) |
| You manage containers with Portainer | [install-portainer.md](install-portainer.md) |
| You want to reach Arclight from outside your home | [exposing-outside-home.md](exposing-outside-home.md) |

Not sure? Read [requirements.md](requirements.md) first, then use [install-docker.md](install-docker.md) if your platform is not listed: anything that can run Docker Compose can run Arclight.

## What every install has in common

- One data folder mounted at `/data`, containing `downloads`, `media/tv` and `media/movies`. This is what makes imports instant hard links instead of slow full copies. See [install-docker.md](install-docker.md#the-folder-layout-one-share-one-mount) and [folders-and-hardlinks.md](folders-and-hardlinks.md).
- A settings folder (`CONFIG_ROOT`) for the database and each container's configuration.
- A `PUID` and `PGID` that own those folders.
- Optionally a VPN (Gluetun) and FlareSolverr, included in the compose files.
- Afterwards, the [first-run wizard](first-run-wizard.md).

## Related

- [requirements.md](requirements.md)
- [first-run-wizard.md](first-run-wizard.md)
- [updating.md](updating.md)
- [backup-restore.md](backup-restore.md)

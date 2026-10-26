# Arclight documentation

Arclight is one self-hosted app that finds, requests, downloads, imports and subtitles your TV
shows and movies. It does the jobs of Sonarr, Radarr, Prowlarr, Bazarr and Seerr/Overseerr, and
downloads with its own built-in BitTorrent engine, so no separate download client is needed. It tells Jellyfin, Emby or Plex when new
files arrive. It is **not** a media server.

These docs are written for people who run their own home server and are comfortable copying a
Docker Compose file, but are not developers. Every page is task-oriented: what the thing is, how
to set it up, what can go wrong.

## Start here

1. Check the [requirements](getting-started/requirements.md).
2. Pick the install guide for your device (list below) and follow it from top to bottom.
3. Walk through the [first-run wizard](getting-started/first-run-wizard.md).
4. Read [folders and hard links](getting-started/folders-and-hardlinks.md) before you move any
   media. It is the single most common source of problems.
5. Add a series or movie ([Library](using/library.md)) and watch it in
   [Activity](using/activity.md).
6. If something looks wrong, open [Troubleshooting](TROUBLESHOOTING.md) or the [FAQ](FAQ.md).

## Getting started

| Page | What it covers |
|---|---|
| [Requirements](getting-started/requirements.md) | Hardware, ports, what you need before you begin |
| [Docker Compose on Linux](getting-started/install-docker.md) | The reference install: VPN or no VPN, built-in engine by default (qBittorrent optional), Proton key, `.env` |
| [Synology (Container Manager)](getting-started/install-synology.md) | DSM install |
| [UGREEN NAS (UGOS Docker)](getting-started/install-ugreen-nas.md) | UGOS install |
| [Unraid](getting-started/install-unraid.md) | Template or compose |
| [TrueNAS SCALE](getting-started/install-truenas-scale.md) | Custom app / compose |
| [QNAP (Container Station)](getting-started/install-qnap.md) | QNAP install |
| [Windows](getting-started/install-windows.md) | Docker Desktop, or native |
| [macOS](getting-started/install-macos.md) | Docker Desktop |
| [Raspberry Pi and ARM64](getting-started/install-raspberry-pi.md) | ARM notes |
| [Portainer](getting-started/install-portainer.md) | Deploy as a stack |
| [Platform chooser](getting-started/install-other-platforms.md) | Not sure which guide? Start here |
| [First-run wizard](getting-started/first-run-wizard.md) | Admin account, TMDB key, folders, indexers, client, VPN |
| [Folders and hard links](getting-started/folders-and-hardlinks.md) | The one-share layout and why it matters |
| [Exposing it outside your home](getting-started/exposing-outside-home.md) | Reverse proxy, Cloudflare Tunnel, Tailscale |
| [Updating](getting-started/updating.md) | Self-update vs notify-only, channels, rollback |
| [Backup and restore](getting-started/backup-restore.md) | What is backed up and how to restore |
| [Moving from Sonarr, Radarr, Prowlarr, Bazarr, Overseerr](getting-started/migrating.md) | The importer |

## Using Arclight

These pages follow the app's navigation.

| Area | Page |
|---|---|
| Library (TV, Movies, Collections, Add New, Retention, Hygiene) | [library.md](using/library.md) |
| Discover, Requests, Issues, Watchlist, Discord bot | [discover-and-requests.md](using/discover-and-requests.md) |
| Calendar | [calendar.md](using/calendar.md) |
| Activity (Queue, History, Blocklist, Pending, Manual import) | [activity.md](using/activity.md) |
| Wanted (Missing, Cutoff unmet) | [wanted.md](using/wanted.md) |
| Interactive search and "why this release" | [interactive-search.md](using/interactive-search.md) |
| Subtitles | [subtitles.md](using/subtitles.md) |
| Media management and naming | [media-management.md](using/media-management.md) |
| Quality profiles, custom formats, TRaSH sync | [quality-profiles.md](using/quality-profiles.md) |
| Indexers, proxies, challenge solver, cross-seed | [indexers.md](using/indexers.md) |
| Download clients and the built-in torrent engine | [download-clients.md](using/download-clients.md) |
| VPN and kill switch | [vpn.md](using/vpn.md) |
| Notifications | [notifications.md](using/notifications.md) |
| Media servers (Jellyfin, Emby, Plex) | [media-servers.md](using/media-servers.md) |
| Users and security | [users-and-security.md](using/users-and-security.md) |
| System (health, tasks, logs, metrics, config as code) | [system.md](using/system.md) |

## When something goes wrong

- [Troubleshooting](TROUBLESHOOTING.md): organised by symptom, plus one section for every
  health check the app can raise.
- [FAQ](FAQ.md): short answers to the questions people ask most.
- [Glossary](GLOSSARY.md): what "indexer", "hardlink", "cutoff" and "kill switch" mean.
- [Known limitations](qa/99-known-limitations.md).

## Reference and advanced

| Page | For |
|---|---|
| [Operations](OPERATIONS.md) | Config as code, environment overrides, metrics, audit log |
| [Cloudflare challenges](CLOUDFLARE.md) | Indexers behind Cloudflare, FlareSolverr, built-in solver |
| [Remote engine](REMOTE-ENGINE.md) | Running the torrent engine on a different machine |
| [API](API.md) | REST API and the Sonarr/Radarr-compatible API |
| [Translating](TRANSLATING.md) | Adding a language |
| [Releasing](RELEASING.md), [Architecture](ARCHITECTURE.md), [Developing](DEVELOPING.md), [Roadmap](ROADMAP.md) | Contributors |
| [QA checklists](qa/README.md) | Manual test procedures |

> Some features are still being built (stall auto-recovery, speed schedules, seeding rules,
> download alerts and others). Pages will mention them as "Coming soon" until they ship.

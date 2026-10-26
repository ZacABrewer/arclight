# Frequently asked questions

Short answers to the questions people ask before and after installing Arclight, grouped by theme. Each answer links to the page with the full steps. If your question is "something is broken", start at [Troubleshooting](TROUBLESHOOTING.md); for unfamiliar words see the [Glossary](GLOSSARY.md).

Contents: [About](#about) | [Install](#install) | [VPN and privacy](#vpn-and-privacy) | [Downloading](#downloading) | [Library and quality](#library-and-quality) | [Requests and users](#requests-and-users) | [Updates and data](#updates-and-data) | [Security](#security) | [Performance on a NAS](#performance-on-a-nas)

## About

### What is Arclight?
One self-hosted app that does the jobs of Sonarr (TV), Radarr (movies), Prowlarr (indexers), Bazarr (subtitles) and Seerr/Overseerr (requests), with its own optional torrent engine and VPN integration. You get one login, one database and one web UI. See the [documentation home](README.md).

### Is Arclight a media server?
No. It finds, downloads, imports, renames and fetches subtitles for your TV and movies, then tells Jellyfin, Emby or Plex to rescan. You still watch through your media server. See [Media servers](using/media-servers.md).

### Does it replace Sonarr, Radarr, Prowlarr, Bazarr and Overseerr?
Yes, each of those jobs is built in: [Library](using/library.md) (Sonarr/Radarr), [Indexers](using/indexers.md) (Prowlarr), [Subtitles](using/subtitles.md) (Bazarr) and [Discover and requests](using/discover-and-requests.md) (Seerr). It does not replace a media server, and it has no music or book management (the known gaps are in [known limitations](qa/99-known-limitations.md)).

### Can I run it next to my existing Sonarr and Radarr while I try it?
Yes, but let only one app download, or they will fight over the same titles. Radarr also uses port 7878, so give Arclight another host port (`ARCLIGHT_PORT`, or the left side of the `7878:7878` mapping in compose). See [Migrating](getting-started/migrating.md).

### Can I import my existing setup?
Yes. System > Import reads the databases of Sonarr, Radarr, Prowlarr, Bazarr and Seerr and lets you choose what to copy, with path mappings for different mount points. See [Migrating](getting-started/migrating.md).

### What does it cost, and what is the licence?
It is free software under the GPL-3.0 licence ([LICENSE](../LICENSE)). It is an independent implementation; [NOTICE.md](../NOTICE.md) lists the projects whose behaviour informed it.

## Install

### What do I need to install it?
Docker is the supported way to run it, plus a free TMDB API key and one data folder that holds your downloads and your TV and movie libraries. See [Requirements](getting-started/requirements.md) and [Install with Docker](getting-started/install-docker.md).

### Can it run without Docker?
Technically yes: it is a Node 24 app, and the repository includes a native Windows route (`scripts/local-test.ps1`) that the user guide describes as meant for trying Arclight, development and testing. For a long-running server use Docker. See [Install on other platforms](getting-started/install-other-platforms.md).

### Does it work on my NAS or computer?
Any machine that can run Docker Compose can run it. Pick the guide for your platform; each one ends with the same folder layout and first-run steps.

| Platform | Guide |
|---|---|
| Generic Linux server | [Install with Docker](getting-started/install-docker.md) |
| Synology | [Install on Synology](getting-started/install-synology.md) |
| UGREEN NAS | [Install on a UGREEN NAS](getting-started/install-ugreen-nas.md) |
| Unraid | [Install on Unraid](getting-started/install-unraid.md) |
| TrueNAS SCALE | [Install on TrueNAS SCALE](getting-started/install-truenas-scale.md) |
| QNAP | [Install on QNAP](getting-started/install-qnap.md) |
| Windows | [Install on Windows](getting-started/install-windows.md) |
| macOS | [Install on macOS](getting-started/install-macos.md) |
| Raspberry Pi | [Install on a Raspberry Pi](getting-started/install-raspberry-pi.md) |
| Portainer (any host) | [Install with Portainer](getting-started/install-portainer.md) |

Set `PUID` and `PGID` to the user that owns your data folder.

### Which install guide should I follow?
Use the one that matches the machine that will run it. If your NAS is not listed but runs Docker Compose, use the generic Linux guide. If you already manage containers through Portainer, use the Portainer guide. Running it somewhere you can reach from outside your home is a separate step: see [Can I expose it to the internet?](#can-i-expose-it-to-the-internet).

### Which ports does it use?
The web UI and API use 7878 (change it with `ARCLIGHT_PORT`). In the compose files qBittorrent's web UI is on 8080 and the peer port is 6881 (TCP, plus UDP for DHT); the built-in engine also defaults to 6881, though a port forwarded by the VPN takes precedence. FlareSolverr (8191) and the Gluetun control server (8000) are only used inside the stack, and Whisper (9000) only if you enable it. See [Install with Docker](getting-started/install-docker.md).

### Do I need a TMDB key, and can I use a free one?
You need one, and the free key from themoviedb.org (Settings > API, the v3 key) is what Arclight expects. Titles, posters and episode data all come from TMDB. You enter it in the [first-run wizard](getting-started/first-run-wizard.md) or later in Settings > General, or you can set `ARCLIGHT_TMDB_API_KEY`.

### Which languages is the interface available in?
English only for now. German, French, Spanish and Dutch files exist, but their strings are untranslated placeholders (each starts with a marker such as `[de]`), so choosing them shows English text with markers. Help is welcome: see [Translating Arclight](TRANSLATING.md). The language picker is under Settings > General.

### Can I use it on my phone?
Yes. The layout collapses to a menu drawer below 900 px wide, and Arclight ships a web app manifest and a service worker, so a browser can install it to your home screen. Browser push notifications need HTTPS (or localhost); on iPhone and iPad add it to the home screen first. See [Notifications](using/notifications.md).

## VPN and privacy

### Does it need a VPN?
No. The VPN is off by default, and there is a no-VPN compose layout. If you download torrents you almost certainly want one; usenet does not need one. See [VPN](using/vpn.md).

### Which VPNs are supported?
The shipped compose files use Gluetun with ProtonVPN over WireGuard, and Arclight reads Gluetun's status and forwarded port. Natively on Windows there are two other providers: WireGuard for Windows (needs an elevated process) and interface binding for a VPN you run yourself. Other VPN clients are not integrated. See [VPN](using/vpn.md).

### Can I use a VPN provider other than Proton?
Yes. The shipped compose files are set up for Proton, but Gluetun supports many providers; edit the Gluetun service environment to use yours (see the Gluetun documentation for your provider's settings). Port forwarding depends on the provider: check that yours offers it, because without a forwarded port you will be able to download but may get fewer incoming connections. Arclight only reads Gluetun's status and forwarded port, so the rest of the setup is unchanged. See [VPN](using/vpn.md).

### What does the kill switch do?
With the Gluetun layout, Arclight and the torrent engine share Gluetun's network, so Gluetun's firewall blocks everything that is not going through the tunnel. On top of that, "Pause grabs when down" (on by default) stops new grabs while the VPN is down or leaking, and the engine's "Bind to VPN" (on by default) pauses torrents until it is back. See [VPN](using/vpn.md) and [paused by the VPN kill switch](TROUBLESHOOTING.md#paused-by-vpn-kill-switch).

### Does Arclight phone home or collect telemetry?
No analytics or telemetry are in the code. It makes outbound requests only for things it needs, listed in the next answer, and your own indexers, clients and notification targets. See [Users and security](using/users-and-security.md).

### Exactly what does it contact on the internet?
TMDB (metadata, and your browser loads posters from TMDB's image server); GitHub and the GitHub container registry for the update check (anonymous, can be switched off in Settings > Updates); the project's GitHub repository for the indexer definition feed (on by default, every 12 hours, can be set to manual or off in Settings > Indexer Options); and, only if you enable them, the TRaSH guides repository for [guides sync](using/quality-profiles.md), a public IP check service such as api.ipify.org for native VPN providers, subtitle providers, import lists and notification services. See [Updating](getting-started/updating.md).

### Can I stop it checking for updates?
Yes. Turn off update checks in Settings > Updates; nothing else about Arclight depends on it. See [Updating](getting-started/updating.md).

## Downloading

### Do I have to use qBittorrent?
No, and you can keep it if you like it. Arclight can use its built-in torrent engine, or drive qBittorrent, Transmission, Deluge, rTorrent, SABnzbd or NZBGet; you can have several clients at once. The built-in engine has some gaps compared with qBittorrent (see [known limitations](qa/99-known-limitations.md)), so keep qBittorrent if you depend on those. See [Download clients](using/download-clients.md).

### Can I keep my existing qBittorrent?
Yes. Add it under Settings > Download Clients, give Arclight its own category (such as `tv`) so it can tell its downloads from yours, and press Test. If it runs behind Gluetun, Arclight can also push the VPN's forwarded port into it. See [Download clients](using/download-clients.md).

### Does it support usenet?
Yes. Add Newznab indexers under Settings > Indexers and a SABnzbd or NZBGet download client. The usenet clients have only been tested with stubs, not end to end against a real server, so please report issues. See [Indexers](using/indexers.md) and [Download clients](using/download-clients.md).

### Which indexers can I use?
Torznab and Newznab endpoints (for example from Jackett or a usenet provider), plus built-in site definitions for a few public trackers. Those definitions have not been verified against the live sites, and public sites move often. Cloudflare-protected sites need FlareSolverr. See [Indexers](using/indexers.md) and [Cloudflare challenges](CLOUDFLARE.md).

### Why is nothing downloading?
Check Settings > Download Clients > Test, whether the VPN is paused, and that the release has seeders. See [download stuck](TROUBLESHOOTING.md#download-stuck), [no peers](TROUBLESHOOTING.md#no-peers) and [nothing found](TROUBLESHOOTING.md#nothing-found).

### Can the torrent engine run on a different machine?
Yes, a seedbox or VPS can run the engine and the main Arclight drives it through a Remote Engine client. See [Remote engine](REMOTE-ENGINE.md).

## Library and quality

### Why hardlinks, and what do I need for them?
A hardlink makes the imported file appear in your library without a second copy, so the torrent keeps seeding and uses no extra space. It only works when the downloads folder and the library are on the same filesystem and, in Docker, under one mount. The compose files mount a single share, `${DATA_ROOT}:/data`, with `/data/downloads`, `/data/media/tv` and `/data/media/movies` inside it. The switch is Settings > Media Management > "Use hardlinks instead of copy" (on by default). See [Folders and hardlinks](getting-started/folders-and-hardlinks.md) and [hardlinks not working](TROUBLESHOOTING.md#hardlinks-not-working).

### Why does the compose file mount one /data folder instead of separate /tv, /movies and /downloads?
Linux cannot create a hardlink between two different mounts, even when both folders sit on the same physical disk. With separate `/tv`, `/movies` and `/downloads` mounts, every import falls back to a full copy: slower, and it uses double the space while the torrent keeps seeding. With one `/data` mount, imports are instant hardlinks and seeding keeps working. Arclight's root folders are `/data/media/tv` and `/data/media/movies`. See [Folders and hardlinks](getting-started/folders-and-hardlinks.md).

### Imports are slow or use double the disk space. Why?
Arclight is copying instead of hardlinking, almost always because downloads and media are not under one mount, or because the folders are on different filesystems. Check that your compose file has the single `${DATA_ROOT}:/data` mount and that your download client saves under `/data/downloads`. See [hardlinks not working](TROUBLESHOOTING.md#hardlinks-not-working) and [hard links not possible](TROUBLESHOOTING.md#hard-links-not-possible).

### I installed with three mounts (/tv, /movies, /downloads). How do I migrate?
Move your folders under one parent, switch the compose file to the single `${DATA_ROOT}:/data` mount (and remove `TV_ROOT`, `MOVIES_ROOT` and `DOWNLOADS_ROOT` from `.env`), then change your Arclight root folders to `/data/media/tv` and `/data/media/movies` and re-point your series and movies. The full steps are in [Folders and hardlinks](getting-started/folders-and-hardlinks.md#moving-an-existing-library).

### What save path should qBittorrent use, and do I need a remote path mapping?
In qBittorrent go to Options > Downloads and set the default save path to `/data/downloads`. Because Arclight and qBittorrent both see the same `/data` mount, the paths match and no remote path mapping is needed. The built-in torrent engine defaults to `/data/downloads` when `/data` exists; older installs that already use `/downloads` keep it. See [Download clients](using/download-clients.md) and [Folders and hardlinks](getting-started/folders-and-hardlinks.md#remote-path-mappings).

### Can I keep 4K and 1080p of the same title?
Yes, two ways. On a series or movie page, add Versions (each with its own tag and quality profile; the editor allows up to 8) and Arclight searches and upgrades each version separately. For requests, turn on "Enable 4K requests" in Settings > Requests; 4K requests use their own root folder and profile so both copies live side by side. See [Library](using/library.md) and [Discover and requests](using/discover-and-requests.md).

### What are quality profiles and custom formats?
A quality profile says which qualities you accept and when to stop upgrading; custom formats score releases on things like codec or release group. See [Quality profiles](using/quality-profiles.md).

### Can I sync TRaSH guides?
Yes, guides sync is off by default. Enable it under Settings > Guides, map guide profiles to your own, and choose whether it only notifies you or applies changes. See [Quality profiles](using/quality-profiles.md).

### Does it handle subtitles?
Yes, it replaces Bazarr, with providers such as OpenSubtitles.com and SubDL, optional Whisper (you provide the service), and a language profile per title. Some providers are best-effort or untested against the live service. See [Subtitles](using/subtitles.md).

### Do other apps work with it, like LunaSea or Recyclarr?
Arclight serves a Sonarr and Radarr v3 compatible API under `/api/v3`, and [API.md](API.md#authentication) lists Overseerr/Jellyseerr, Bazarr, Prowlarr, Notifiarr, Homarr, Recyclarr, LunaSea, nzb360 and dashboards as tools that can point at it. Recyclarr can sync quality profiles but not every setting, and the calendar is episode-only (so movies may not show in Radarr-only apps). Tools not on that list are untested. Details are in [API.md](API.md) and [known limitations](qa/99-known-limitations.md).

## Requests and users

### Can my family use it without admin rights?
Yes. Create accounts under Settings > Users; the role `user` can browse, request titles, report issues and keep a watchlist, but cannot see Activity, Indexers, Settings or System. Fine-grained rights (request, 4K, auto-approve) are permission switches per user. See [Discover and requests](using/discover-and-requests.md) and [Users and security](using/users-and-security.md).

### Can people sign in with their Jellyfin, Emby or Plex account?
Yes, when a media server is configured with sign-in enabled, the login page offers it, and imported media-server accounts become Arclight users who sign in with their media-server password. See [Media servers](using/media-servers.md).

### Do requests need approval?
That is up to you. Users with an auto-approve permission are approved automatically; everyone else's requests wait for an admin in Requests. Quotas and approval rules are in Settings > Requests. See [Discover and requests](using/discover-and-requests.md).

## Updates and data

### How do updates work?
Arclight checks GitHub for new releases (every 24 hours by default, stable channel) and shows a notice on Settings > Updates and System > Updates. By default it only notifies you; update by pulling the new image, or mount the Docker socket and use "Update now" or the automatic mode (3:00 to 6:00 by default) for containers labelled `arclight.autoupdate=true`. It migrates its own database when it starts, so take a backup first. See [Updating](getting-started/updating.md).

### Where is my data?
In the config folder: `/config` in Docker (the `arclight` folder under `CONFIG_ROOT` in the compose files), `./config` natively, or whatever `ARCLIGHT_CONFIG` points to. It holds the SQLite database `arclight.db`, `logs/`, `backups/`, and `torrents/` if you use the built-in engine. Your media stays in your own folders. See [Backup and restore](getting-started/backup-restore.md).

### How do I back up?
Backups run daily at 04:00 by default (keeping 7, and deleting automatic ones older than 28 days) and are listed under System > Backups, where you can also create, download, upload and restore. See [Backup and restore](getting-started/backup-restore.md).

### How do I move to a new machine?
Back up (System > Backups), install Arclight on the new machine, then restore the backup there and restart. Keep the same media paths, or fix them afterwards. Copying the whole config folder works too. See [Migrating](getting-started/migrating.md).

## Security

### How do I reset the admin password?
Another admin can do it under Settings > Users > Reset password, and any user can change their own on their profile page. If you lost the only admin password there is no command-line reset: restore a backup from before the change, or stop Arclight, move `arclight.db` aside and run the first-run wizard again (you lose settings, not media). Advanced: your API key grants admin rights, so `PUT /api/v1/user/<id>` with a new `password` also works. See [locked out](TROUBLESHOOTING.md#locked-out).

### Can I expose it to the internet?
Only behind HTTPS with sign-in on; never turn the method to None for an internet-facing install. Reverse proxy, Cloudflare Tunnel and Tailscale are walked through in [Exposing Arclight outside your home](getting-started/exposing-outside-home.md). Failed logins are rate limited (10 per address per 15 minutes), and there is no two-factor sign-in. See [Users and security](using/users-and-security.md) and [Cloudflare](CLOUDFLARE.md).

### What is the "None on the local network" option?
In Settings > Security, the authentication Method can be a login page, a browser prompt (HTTP Basic), or None on the local network. With the last one, only loopback and private-range addresses skip sign-in; public addresses always need credentials. Behind a reverse proxy that does not forward `X-Forwarded-For`, every visitor can look local. See [Users and security](using/users-and-security.md).

### Where is the API key, and do I share it?
In Settings > Security. There is one key per install and it grants admin access, so give it only to apps you trust (Prowlarr, Recyclarr, dashboards). Regenerating it breaks every app using the old one. See [Users and security](using/users-and-security.md).

## Performance on a NAS

### How much RAM and CPU does it need?
The image is about 80 MB to pull and about 220 MB on disk, and answers HTTP within about two seconds of starting. The project's own smoke test expects the process to stay under roughly 1 GB of RAM when idle with 500 titles; that figure comes from the checklist, not a guarantee. See [Requirements](getting-started/requirements.md).

### Will it slow my NAS down?
Background work is scheduled (RSS sync, refreshes, backups; see System > Tasks) and the built-in engine's limits are adjustable under Settings > Torrent Engine (connections, download and upload limits). Optional extras such as Whisper transcription and transcode rules are the heavy parts, and both are opt-in. See [System](using/system.md) and [Download clients](using/download-clients.md).

### Why is the first search slow?
Cloudflare-protected indexers go through FlareSolverr, which opens a browser for each solve, and indexers are rate limited individually. See [Cloudflare challenges](CLOUDFLARE.md) and [slow engine start](TROUBLESHOOTING.md#slow-engine-start).

## Related

- [Documentation home](README.md)
- [Troubleshooting](TROUBLESHOOTING.md)
- [Glossary](GLOSSARY.md)
- [Requirements](getting-started/requirements.md)
- [Folders and hardlinks](getting-started/folders-and-hardlinks.md)
- [Known limitations](qa/99-known-limitations.md)

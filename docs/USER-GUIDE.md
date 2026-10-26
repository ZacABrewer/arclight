# Arclight user guide

Arclight is one self-hosted service that finds, downloads, organises and tracks TV series and
movies, and also does the jobs of an indexer manager, a subtitle fetcher and a request portal.
It replaces Sonarr, Radarr, Prowlarr, Bazarr and Seerr with a single install, a single login and
a single database. It drives a download client (the built-in engine, qBittorrent, Transmission,
Deluge, rTorrent, SABnzbd or NZBGet) and tells your media server (Jellyfin, Emby, Plex) when new
files arrive. It is **not** a media server and does not play anything.

This guide is for the person running the server. If you only want to request shows, jump to
[Requesting titles as a user](#requesting-titles-as-a-user). For test procedures see
[qa/README.md](qa/README.md). For things that are known not to work see
[qa/99-known-limitations.md](qa/99-known-limitations.md).

Contents

1. [How it works in one page](#1-how-it-works-in-one-page)
2. [Installing](#2-installing)
3. [First run](#3-first-run)
4. [Concepts](#4-concepts)
5. [Day-to-day tasks](#5-day-to-day-tasks)
6. [Requesting titles as a user](#requesting-titles-as-a-user)
7. [Migrating from your existing apps](#7-migrating-from-your-existing-apps)
8. [Using other tools with Arclight (compat API)](#8-using-other-tools-with-arclight-compat-api)
9. [Troubleshooting](#9-troubleshooting)
10. [FAQ](#10-faq)

---

## 1. How it works in one page

```
 You / requesters            Indexers                 Download client
 -----------------      ---------------------      ---------------------
 add title or request -> search + RSS sync      ->  grab release
        |                    |                            |
        v                    v                            v
    Library  <---- decision engine ----> Queue (progress, tracked state)
        ^           (quality, custom               |
        |            formats, delay,               v
        |            blocklist, size)         completed download
        |                                            |
   rename + move  <------ import (match to episode / movie)
        |
        +--> History entry --> notifications --> media server refresh
        +--> subtitle search (if a language profile is set)
        +--> request marked available, requester notified
```

Everything in the picture happens inside one process. The sidebar follows the same order:
Library (what you own), Discover and Requests (what people want), Calendar and Wanted (what is
coming and missing), Activity (what is happening now), Subtitles, Search and Indexers (where
releases come from) and Settings and System (how it is configured and whether it is healthy).
Admins see all of it; ordinary users see Dashboard, Library, Discover, Requests, Issues,
Watchlist, Calendar and Wanted.

A background scheduler runs the recurring work: RSS sync, queue polling, metadata refresh,
searches for missing items, subtitle searches, request status sync, backups. You can watch and
trigger every job at System -> Tasks.

---

## 2. Installing

You need three things on the host: somewhere to keep Arclight's config, a TV folder, a movies
folder and a downloads folder. The container runs as a normal user (`PUID`/`PGID`), so that user
must be able to read and write all four.

### 2.1 Pick a Docker layout

| You want | Use | Result |
|---|---|---|
| All traffic through ProtonVPN, with qBittorrent | `docker/docker-compose.yml` | gluetun + arclight + qbittorrent; the other two share gluetun's network so a dropped tunnel cuts them off (a kill switch by construction) |
| All traffic through ProtonVPN, no extra client | `docker/docker-compose.builtin.yml` | gluetun + arclight; torrents run in Arclight's own engine |
| No VPN | `docker/docker-compose.novpn.yml` | arclight + qbittorrent, with qBittorrent's peer port 6881 published |
| Pre-built image instead of building | `docker/docker-compose.release.yml` or `docker/docker-compose.release.novpn.yml` | Same stacks, pulled from the image registry. Pin a version with `ARCLIGHT_IMAGE=ghcr.io/<owner>/arclight:vX.Y.Z` in `.env`. |

The first three build the image from this repository (`--build`). The release files pull it.

### 2.2 Configure `.env`

Copy `docker/.env.example` to `docker/.env` and edit:

| Variable | Meaning | Example |
|---|---|---|
| `PUID`, `PGID` | Numeric user and group that own your media folders | `1000`, `1000` |
| `TZ` | Time zone for schedules and the calendar | `America/New_York` |
| `CONFIG_ROOT` | Parent for the `arclight`, `qbittorrent` and `gluetun` config folders | `/volume1/docker` |
| `TV_ROOT` | Mounted at `/tv` in the container | `/volume1/media/tv` |
| `MOVIES_ROOT` | Mounted at `/movies` | `/volume1/media/movies` |
| `DOWNLOADS_ROOT` | Mounted at `/downloads` | `/volume1/downloads` |
| `PROTON_WIREGUARD_KEY` | VPN stacks only: the `PrivateKey` from a Proton WireGuard file | (secret) |
| `VPN_COUNTRIES` | VPN stacks only: comma-separated Proton server countries | `Netherlands` |
| `LAN_SUBNET` | VPN stacks only: your LAN, so the web UIs stay reachable | `192.168.1.0/24` |

Put TV, movies and downloads under **one** parent share on the NAS when you can (for example
`/volume1/media` and `/volume1/downloads` on the same volume). Arclight hardlinks finished
torrents into the library instead of copying them, which only works within one filesystem.

### 2.3 Start it

```bash
cd docker
docker compose -f docker-compose.builtin.yml up -d --build     # or the file you chose
docker compose -f docker-compose.builtin.yml logs -f arclight
```

Open `http://<host>:7878`. With a VPN layout the ports are published by the `gluetun` container,
so that is still the host address.

Useful commands: `docker restart arclight`, `docker compose -f <file> pull && docker compose -f
<file> up -d` (release files), `docker compose -f <file> down` (stop; data stays).

### 2.4 Getting the Proton WireGuard key

1. Sign in at account.proton.me and open **VPN -> Downloads -> WireGuard configuration**.
2. Give the config a name, choose any platform, and switch on **NAT-PMP (port forwarding)**. Pick
   a server in a P2P-friendly country (the same country you put in `VPN_COUNTRIES`).
3. Create it and copy the `PrivateKey = ...` value from the `[Interface]` section into
   `PROTON_WIREGUARD_KEY`. Treat it as a password.

Proton forwards one incoming port per session. Gluetun reports it, and Arclight copies it into
the download client (see [4.9 VPN providers and the kill switch](#49-vpn-providers-and-the-kill-switch)).

### 2.5 Installing on a NAS (Synology and similar)

1. Create shared folders: `docker` (config), `media/tv`, `media/movies`, and `downloads`.
2. Find the numeric id of the user that should own the files (over SSH: `id username`) and put
   it in `PUID`/`PGID`.
3. Give that user Read/Write on all four shares.
4. Copy the `docker` folder from this repository to the NAS, create `.env` as above with the
   `/volume1/...` paths, and run the compose command over SSH, or paste the compose file into
   Container Manager's Project feature.
5. Open `http://<nas-address>:7878`.

If Arclight starts but cannot write, System -> Health shows a "Docker permissions" message; fix
the share permissions or the `PUID`/`PGID` values and restart the container.

### 2.6 Installing natively on Windows

Native Windows is intended for trying Arclight, development and testing; use Docker for a
long-running server.

Requirements: Node 24, pnpm 10, this repository.

```powershell
cd "C:\NAS Setup\media-tron"
pnpm install
.\scripts\local-test.ps1            # builds the web app and starts on http://localhost:17878
```

The script keeps everything in `C:\NAS Setup\test-env` (config, `tv`, `movies`, `downloads`) so it
never touches other installs. Options: `-NoBuild`, `-Reset` (wipe the config for a fresh
database), `-Port 17979`. For your own native install run the API directly with environment
variables set (table below); the web app must be built first (`pnpm build`) and its folder given
in `ARCLIGHT_WEB_DIST`.

For a VPN on native Windows use the **WireGuard for Windows** provider (see 4.9); that needs an
elevated (Administrator) PowerShell.

### 2.7 Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `ARCLIGHT_CONFIG` | `/config` in Docker, else `./config` | Where `arclight.db`, `logs/`, `backups/`, `definitions/` and `torrents/` live |
| `ARCLIGHT_PORT` | `7878` | HTTP port |
| `ARCLIGHT_HOST` | `0.0.0.0` | Bind address (the local test script uses `127.0.0.1`) |
| `ARCLIGHT_LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error`, `fatal` |
| `ARCLIGHT_WEB_DIST` | unset | Folder with the built web app (`/app/web` in the image) |
| `ARCLIGHT_TMDB_API_KEY` | unset | TMDB key used when none is saved in Settings |
| `ARCLIGHT_VPN_CONTROL_URL` | `http://localhost:8000` | Default Gluetun control URL |
| `ARCLIGHT_TORRENT_ENGINE` | `1` | `0` stops the built-in engine from starting or registering its client |
| `ARCLIGHT_DOCKER` | auto | Force Docker path defaults with `1` |
| `ARCLIGHT_VERSION` | `0.1.0-dev` | Version reported by the app (set at image build) |
| `ARCLIGHT_IMAGE` | `ghcr.io/zacheryabrewer/arclight:latest` | Release compose files only: which image to pull |
| `PUID`, `PGID`, `TZ` | `1000`, `1000`, `UTC` | Handled by the container entrypoint |

### 2.8 Exposing it outside your home

Do not publish port 7878 to the internet directly. Put a reverse proxy with HTTPS in front
(Caddy, Nginx Proxy Manager, Traefik). Arclight trusts `X-Forwarded-For` and `X-Forwarded-Proto`,
marks its session cookie `Secure` when it sees https, and never lets a public address bypass
sign-in, even when the method is "None on the local network". Keep the authentication method on
"Login page".

---

## 3. First run

Open the address. A fresh install sends you to `/setup`, a six-step wizard. Each step saves as
you go, so closing the tab and coming back resumes where you stopped.

| Step | What you do |
|---|---|
| **Admin account** | Choose a username (2+ characters), password (8+), optional email. You are signed in immediately. |
| **TMDB key** | Paste a free TMDB v3 API key (themoviedb.org -> Settings -> API). Click **Test** ("Key works" appears). Titles, posters and episode data all come from TMDB, so nothing works without it. |
| **Root folders** | Enter one absolute path for TV and a different one for movies, for example `/tv` and `/movies` in Docker. "Create folders that do not exist" is on by default. |
| **Download client** (optional) | The same list as Settings -> Download Clients. A **Built-in** client is registered automatically on first start, so you can skip this. |
| **Indexer** (optional) | The same list as Settings -> Indexers. Skip and add later if you are unsure. |
| **Done** | Pick the authentication method and click **Finish setup**. |

Authentication choices:

- **Login page (recommended)**: everyone signs in with a username and password.
- **Browser prompt (HTTP Basic)**: the browser asks for credentials; handy for simple reverse
  proxies and some apps.
- **None on the local network**: machines on loopback, private (192.168.x.x, 10.x.x.x,
  172.16-31.x.x) and link-local addresses skip sign-in; public addresses always need to.

After the wizard, work through this order, because each step needs the one before:

1. Settings -> Media Management: check the root folders and the naming formats.
2. Settings -> Profiles: choose or tweak a quality profile (the defaults Any, SD, HD-720p,
   HD-1080p, HD-720p/1080p and Ultra-HD are created for you).
3. Settings -> Indexers: add at least one indexer and press **Test**.
4. Settings -> Download Clients: add or confirm a client and press **Test**.
5. Settings -> Notifications and Settings -> VPN as needed.
6. Library -> Add New: add your first series or movie.

Your API key lives at Settings -> Security. You need it for other apps (section 8).

---

## 4. Concepts

### 4.1 Library, root folders and what "monitored" means

The **Library** has two tabs, TV and Movies. Each title belongs to a **root folder**, a top-level
folder you registered (`/tv`, `/movies`). Arclight creates one subfolder per title inside it
(`/tv/Severance (2022)`), and season folders under that.

**Monitored** is the central switch. A monitored episode or movie is one you want: Arclight
searches for it when it is missing, keeps searching for upgrades until the quality profile's
cutoff is met, and shows it in Calendar and Wanted. An unmonitored one is remembered but left
alone. Series, seasons and individual episodes can each be monitored separately.

Series have a **type**: Standard (S01E01), Daily (date-based shows) or Anime (absolute
numbering). Movies have a **minimum availability** (Announced, In cinemas, Released) that stops
Arclight from grabbing a movie before it is out. Titles can carry **tags**, which link them to
delay profiles, release profiles and proxies.

Add titles at Library -> Add New: search TMDB, click a result, choose root folder, quality
profile, what to monitor, and whether to start searching. Everything else about a title is under
its details page (Seasons and episodes, Files, Search).

### 4.2 Metadata

All titles, images and episode lists come from TMDB. Two scheduled jobs (`RefreshSeries` at 03:00
and `RefreshMovie` at 04:30) pull updates every night so new episodes appear on their own. The
language and region used for titles are in Settings -> General under "Metadata (TMDB)".

### 4.3 Quality profiles, quality definitions and custom formats

A **quality profile** is a ranked list of acceptable qualities (for example WEBDL-1080p above
WEBDL-720p) with:

- which qualities are **allowed**,
- a **cutoff**: once you own a file at or above this, quality upgrades stop,
- **upgrades allowed** on or off,
- **custom format scores** and a minimum score (below),
- **language**.

**Quality definitions** (Settings -> Quality) give each quality a minimum, preferred and maximum
size in megabytes per minute of runtime. Releases outside the range are rejected, which keeps
you from grabbing a 90 GB remux of a sitcom or a 100 MB fake.

A **custom format** is a named set of rules that look at the release title and tags (for
example "contains HDR10", "release group is X", "has a bad group name"). Each profile assigns
every custom format a **score**: positive to prefer, negative to avoid, a very low number to ban.
Between two releases of the same quality, the higher total score wins, and a file is also
upgraded when a new release has a higher score. Build formats in Settings -> Custom Formats. The
editor has a **test box**: paste a release name and see which formats match. You can import a
format as JSON, for example from the TRaSH Guides, and export your own.

### 4.4 Delay profiles and release profiles

A **delay profile** makes Arclight wait before it grabs, in the hope that a better release shows
up. Settings -> Profiles has the list. A profile has a preferred protocol (usenet or torrent), a
usenet delay and a torrent delay in minutes, and exceptions: grab at once if the release is the
highest quality in the profile, or if its custom format score reaches a chosen minimum. Delay
profiles can be limited to tagged titles, and are checked in order; the untagged default is
last. Releases being held show up at Activity -> Pending, where you can **grab now** or remove
them.

A **release profile** adds plain-text rules: terms a release **must contain**, terms it **must
not contain**, and **preferred** terms with a score. Use them for things like "never grab
releases with `HDTV`" or "prefer `Atmos`" on specific tagged titles.

### 4.5 Indexers, definitions and proxies

An **indexer** is a place Arclight searches for releases. There are three kinds:

- **Torznab** (torrents) and **Newznab** (usenet): any Jackett, a private tracker, or a usenet
  indexer exposing that API. You enter a URL, API key and categories.
- **From the catalogue (definition)**: a built-in site definition (`1337x`, `eztv`,
  `limetorrents`, `nyaa`, `thepiratebay`, `torlock`, `torrentgalaxy`, `yts`) that Arclight scrapes
  itself, with no Jackett in between. You can filter the catalogue by privacy (public, semi-private,
  private), protocol and language; set the "site link" to use a mirror; fill in the site's settings
  (login, cookie, API key); then Test. Add your own YAML definitions to `<config>/definitions/`
  (the folder is watched) or via the API.

An **indexer proxy** (Settings -> Indexer Proxies) sits between Arclight and a site: FlareSolverr
for Cloudflare-protected sites, or an HTTP or SOCKS5 proxy. A proxy applies to an indexer either
by choosing it on the indexer or by sharing a **tag** with it.

Each indexer has an RSS switch, automatic-search switch, interactive-search switch, priority (lower
number wins ties), a minimum seeders figure for torrents, and seed ratio/time goals. Failing
indexers back off automatically: after repeated errors Arclight stops using them for longer and
longer, and shows it on the Indexers page and in System -> Health. Indexers -> Stats charts
queries, grabs, failures and response times for 1 to 90 days.

**Indexer Options** (Settings -> Indexer Options) apply to all indexers: minimum age (wait for
usenet propagation), retention, maximum size, and the **RSS sync interval** (0 turns scheduled
RSS off, otherwise 10 to 1440 minutes; the default is 15). Changing it re-schedules the `RssSync`
job at once.

The **Search** page in the sidebar searches every enabled indexer at once for any text, shows the
results with a download-torrent link (or magnet) and a Grab button. If a result does not match
anything in your library, grabbing is refused unless you force it, in which case it goes to the
default client untracked (Arclight cannot import what it cannot match).

### 4.6 Download clients and the built-in engine

A **download client** is the program that actually fetches files. Supported kinds:

| Kind | Protocol | Notes |
|---|---|---|
| Built-in | torrent | Arclight's own engine; no extra container. Configure under Settings -> Torrent Engine. |
| qBittorrent | torrent | WebUI v2. Arclight can set its listening port from the VPN-forwarded port. |
| Transmission | torrent | |
| Deluge | torrent | |
| rTorrent | torrent | Via its XML-RPC endpoint |
| SABnzbd | usenet | API key |
| NZBGet | usenet | |

Each client has a **category** (a label such as `tv`) so Arclight can tell its downloads from
yours, a **priority**, and options such as initial state and content layout. The category, and
the optional **post-import category**, can be set per client. Press **Test** after every change;
Test All checks every client at once.

**Completed download handling**: when a download finishes, Arclight finds the files, matches
them to the episode or movie, moves or hardlinks them into the root folder, renames them, and
removes the download from the client if "remove completed" is on. **Failed download handling**
blocklists a failed release and automatically searches for a different one.

**Built-in engine** - what to know:

- It speaks BitTorrent over TCP with DHT, PEX, magnet links and trackers (HTTP and UDP).
  It does not do encrypted connections, uTP, IPv6 or web seeds (see the known-limitations file),
  so a few swarms and some trackers will not work with it. Keep qBittorrent as a second client if
  you need those.
- Settings -> Torrent Engine has the listen port, connection limits, speed limits, active
  downloads and seeds, default seed ratio and time, queueing, the downloads folder and **Bind to
  VPN**. Resume data lives in the config folder under `torrents/`.
- With **Bind to VPN** on (default) and the VPN integration enabled, the engine binds to the
  tunnel's address, moves its listener to the forwarded port, and pauses everything if the VPN
  goes down.
- Set `ARCLIGHT_TORRENT_ENGINE=0` to keep the engine from starting at all.

**Remote path mappings** (Settings -> Download Clients, lower card): needed only when the client
sees the download folder under a different path than Arclight does. Example: qBittorrent in another
container reports `/downloads/complete/Show`, but Arclight sees the same folder as
`/data/torrents/complete/Show`. Add a mapping with the client's host, the remote path and the local
path. Without it the queue shows "no files found" or a remote-path health error. In the compose
stacks provided, Arclight and qBittorrent both mount the downloads folder at `/downloads`, so no
mapping is needed.

### 4.7 Import lists

An **import list** (Settings -> Import Lists) adds titles for you from outside sources on a
schedule: TMDB lists (popular, trending, a specific list, a collection, a person's credits, a
keyword), Trakt (popular, a list, a user's watchlist), a Plex watchlist, an IMDb list, a generic
RSS/JSON feed and StevenLu's popular movies. Each list has a root folder, quality profile, monitor
mode and "add automatically" and "search on add" switches. The `ImportListSync` job runs it, and
**Sync now** does it on demand. **List exclusions** stop a title from ever being re-added, and
removing a title from the library with "add exclusion" puts it there. **Options** includes a
"clean library" level that can unmonitor or remove titles that disappeared from every list;
leave it on "disabled" or "log only" until you trust it. Trakt sign-in uses a device code: Arclight
shows a short code to enter at trakt.tv/activate.

### 4.8 Requests, permissions and quotas

Arclight has its own request portal, replacing a separate Seerr. Create people at
Settings -> Security (Add user: username, password, role), then tune what they may do at
Settings -> Users -> Manage.

- **Roles**: `admin` does everything. `user` can read most pages and do only what the permissions
  allow.
- **Permissions** are individual switches: Request (movies and/or TV), Request 4K, auto-approve
  (movies, TV, 4K), advanced requests (choose profile/folder), view all requests, manage requests,
  manage issues / create issues / view issues, manage users, manage settings, auto-request from a
  Plex watchlist, view the watchlist.
- **Quotas**: a limit of N movies and N series seasons per D days, globally (Settings ->
  Requests) with per-user overrides (Manage -> Quota). Declined requests are refunded.
- **Auto-approve**: globally per type (Settings -> Requests), per permission, or by an **override
  rule**.
- **Override rules** (Settings -> Requests): match on user, genre, language or keyword to send a
  request to a different quality profile, root folder, tags, or to approve it automatically.
- **Approval**: an admin (or anyone with Manage requests) approves under Requests. Approving adds
  the title to the library (for a series, only the requested seasons are monitored) and searches.
  A decline can carry a reason. A failed approval can be retried.
- **Availability**: the `RequestsStatusSync` job (every 5 minutes) marks a request available
  when the files are in the library, and the requester is notified through their personal agents
  (Profile -> notifications). Optionally Arclight also asks a Jellyfin/Emby connection.
- **Issues**: a user can report a problem with a title (wrong audio, missing subtitles). Admins
  see them under Issues, comment, and mark them resolved.
- **Watchlist**: users keep a list of titles they care about; Plex watchlists can sync in and
  auto-request.

### 4.9 VPN providers and the kill switch

At Settings -> VPN pick a provider:

| Provider | Where | What Arclight does |
|---|---|---|
| **Gluetun (Docker)** | The Docker VPN stacks | Polls Gluetun's control server (default `http://localhost:8000`) for state, public IP and forwarded port. Pushes the port to qBittorrent (if "Sync forwarded port" is on) and to the built-in engine. |
| **WireGuard for Windows (native)** | Native Windows, elevated | Installs and monitors a tunnel service from a `.conf` file (for example a Proton WireGuard file saved as `C:\vpn\proton-nl.conf`), reads handshake and transfer from `wg`, and finds the adapter address the engine should bind to. Auto-start reinstalls a missing tunnel; **Kill switch** blocks grabs and tells the engine to close sockets when the adapter vanishes or the handshake goes stale. |
| **Interface binding (any OS)** | Anywhere | You run the VPN yourself (for example the Proton app). You name its network adapter and Arclight watches its address and uses it as the bind address. |

Common settings: **Enable VPN monitoring**, **Public IP check URL**, **Pause grabs when down**
(on by default), **Home public IP** (your ISP address, so a check that reports it is flagged as a
leak) and **Poll interval**. Newer Gluetun releases protect the control server: create an API key
following Gluetun's wiki and enter it (or username and password) here.

How the **kill switch** works in the Docker stacks: the containers share Gluetun's network
namespace, and Gluetun's firewall only lets traffic out through the tunnel. If the tunnel drops,
nothing leaks. On top of that, Arclight sees the VPN as down, stops grabbing (so nothing new is
queued while nothing can download), pauses every engine torrent, and raises a **VpnDisconnected**
health error. When the tunnel returns it resumes automatically.

The dashboard shows a VPN card (Connected / Disconnected / Leak) when monitoring is on.

### 4.10 Subtitles

Settings -> Subtitles has four parts. **Language profiles** say which languages you want for each
title, with a mode for forced and hearing-impaired subtitles (never / also / only), a cutoff
language, and optional must-contain / must-not-contain words. Assign a profile when adding or
editing a series or movie (the default profile applies when you do not choose). **Providers** are the
sources; enable one, enter its account, press **Test**. **Settings** hold search batch size, the
upgrade window, sync (ffsubsync or alass, if installed) and post-processing. Providers that need to
beat a CAPTCHA will be paused automatically (see known limitations).

Under Subtitles in the sidebar: **Wanted** (files missing a wanted language), **History**
(downloaded, upgraded, deleted, blacklisted) and **Blacklist** (subtitles you rejected). A series
or movie's own Subtitles tab lets you search by hand, see scores and matches, download, upload a
file, extract an embedded track, sync, or blacklist. The `SubtitleSearchWanted` job runs every 15
minutes, `SubtitleUpgrade` nightly and `SubtitleScan` weekly.

### 4.11 Notifications

Settings -> Notifications -> **Add connection** offers: Discord, Telegram, Webhook, Email, Custom
Script, ntfy, Gotify, Pushover, and the media-server agents Jellyfin, Emby and Plex. Each
connection has a **Notify on** list of events: Grab, Download (import), Upgrade, Series add, Movie
add, Series delete, Movie delete, File delete, Health issue, Health restored, Application
update, Manual interaction required. Press **Test** to send a sample. The media-server agents
also have an "Update library" switch: when a file is imported they ask Jellyfin, Emby or Plex to
rescan just that item. Request events (new request, approved, available) go to the requester's
personal agents on their Profile page, and to admins.

### 4.12 Backups

System -> Backups lists zip archives containing a consistent copy of the database, your settings
and the config files. **Back up now** makes one; **Download** saves it; **Restore** puts it back;
**Restore from file...** uploads one; **Delete** removes it. The Settings card sets the folder
(empty = `<config>/backups`), the interval in days (0 turns scheduled backups off; default 1), the
hour of day (default 04:00), how many automatic backups to keep (default 7) and for how many days
(default 28). Restoring replaces the database and config, keeps a copy of the old database as
`arclight.db.pre-restore`, and shows an orange **Restart required** banner; click **Restart now**
(or restart the container) to finish. Media files are not part of a backup; they live in your
media folders.

### 4.13 The compat API

For other tools, Arclight serves a Sonarr/Radarr v3 compatible API at `/api/v3`, authenticated
with your API key. See [section 8](#8-using-other-tools-with-arclight-compat-api).

---

## 5. Day-to-day tasks

### 5.1 Add a series or a movie

1. Library -> **Add New** (or use the search box in the top bar).
2. Type a name and click the right result.
3. Choose the root folder, quality profile, and what to monitor (all episodes, future only,
   first season, none, and so on; movies have a simple monitored switch).
4. Leave the search option ticked to look for what is missing straight away.
5. Click **Add**. The title appears in the Library and the first search appears under Activity.

### 5.2 Search by hand (interactive search)

Open a title, choose a season, episode or the movie, and click the search (magnifier) icon. The
result list shows every release found with quality, size, age, seeders, indexer, custom format
score and, for rejected ones, **the reason** in plain words (for example "Quality not wanted",
"Size too large", "Already blocklisted", "Not an upgrade"). Click the download icon to grab one.
If it was rejected you are asked to confirm before overriding. Use this when automatic search
keeps skipping something you know exists.

### 5.3 Watch what is happening: Activity

- **Queue**: current downloads with progress, speed, ETA, and the tracked state (Downloading,
  Importing, Completed, Failed and so on). A failed or stalled item shows an explanation; remove it
  with "blocklist" ticked to stop it coming back.
- **Pending**: releases held by a delay profile. **Grab now** or remove.
- **History**: every grab, import, failure, delete and rename.
- **Blocklist**: releases that will never be grabbed again. Entries can be deleted individually
  or in bulk.
- **Manual Import**: files in a folder that could not be matched automatically; pick the title,
  season and episode yourself and import.

### 5.4 Calendar and Wanted

**Calendar** shows upcoming episodes and movie releases and offers an iCal feed URL (use it in
Google or Apple Calendar). **Wanted** lists monitored items that are missing, with a **Search all**
button. Searching a long list can hit indexer rate limits; start with a few. The "Cutoff Unmet" view
(on disk but below the profile cutoff) is not served by the native API yet, see the known
limitations.

### 5.5 Fix a bad file

Open the title, find the file, and either **delete** it (the item becomes Missing again and is
searched for) or search interactively and grab a different release (the old file is replaced when
the new one imports). Blocklist the bad release in History if you want to be sure it does not
return.

### 5.6 Change quality for existing titles

Edit the title's quality profile. Changing the profile does not re-download anything on its own;
the next searches will upgrade files that are below the new cutoff.

### 5.7 Rename and organise

Settings -> Media Management controls the naming patterns for series, daily, anime, movies, season
folders and title folders, and whether to replace illegal characters. Use the preview to see the
result before saving. Choose between hardlink/copy (keeps seeding) and move with the hardlink
setting. Hardlinks need the download and library folders on one filesystem; otherwise Arclight
falls back to copying.

### 5.8 Subtitles

Set a default language profile in Settings -> Subtitles, enable at least one provider and
**Test** it. Arclight then fills in missing subtitles for monitored titles every 15 minutes.
Check Subtitles -> Wanted to see what is outstanding and Subtitles -> History to see what was
fetched and from where.

### 5.9 Users, quotas and approvals

Settings -> Security -> **Add user**, then Settings -> Users -> **Manage** for permissions and quota.
For a trusted family: give "Request" and "Auto-approve" so people never wait. For guests: "Request"
only with a small quota, and approve under Requests.

### 5.10 Keep it healthy

- Glance at the **Dashboard**: health banner, VPN card, queue, disk space and recent activity.
- System -> **Health** lists every warning.
- System -> **Tasks** runs any job immediately and shows last and next run times.
- System -> **Logs** shows the log with level and search filters.
- System -> **Backups**: take one before every upgrade.
- System -> **Status** shows version, runtime, database size, uptime and disk space per root folder.

### 5.11 Updating

Docker: pull a newer image (release files) or rebuild (`up -d --build`). Arclight migrates its own
database on start. Take a backup first. Native: update the repository, `pnpm install`, `pnpm build`,
restart.

### 5.12 Moving or resetting

To move Arclight to another machine, copy the whole config folder (or restore a backup into a clean
install) and keep the same paths for media. To start over, stop it and delete `arclight.db` (and
`torrents/` if you used the built-in engine); the wizard returns on the next start.

---

## Requesting titles as a user

If someone gave you an Arclight login:

1. Sign in. You land on the Dashboard.
2. **Discover** shows trending, popular and upcoming titles; search from the top bar.
3. Click a title, then **Request**. For a series choose which seasons. If you have the 4K
   permission, a separate 4K request is offered.
4. **Requests** shows your requests and their state: pending, approved, declined, processing or
   available. You are notified when it is available, if you set up a notification agent on your
   Profile page.
5. Something wrong with a title you have? Open it and report an issue. Admins reply under Issues.
6. The **Watchlist** stores titles you want to remember.

Changing your own password is currently available through the API only; ask an admin to reset it
if you need it changed.

---

## 7. Migrating from your existing apps

Arclight does not need the old apps to keep running, but it is safe to run them in parallel while
you check. Use **System -> Migrate**, a guided importer that takes a source URL and API key and lets
you pick what to copy.

| From | What can be brought across |
|---|---|
| **Sonarr / Radarr** | Quality profiles, custom formats, root folders, tags, delay profiles, indexers, download clients, notifications, import lists, series and movies (files stay where they are) |
| **Prowlarr** | Indexers and indexer proxies, with their categories, priorities and tags |
| **Bazarr** | Language profiles and provider accounts |
| **Seerr / Overseerr / Jellyseerr** | Users, requests, issues and request settings |

Suggested order: (1) set up Arclight with the same root folder paths the old apps used,
(2) migrate profiles and settings, (3) migrate indexers and **Test** each, (4) migrate the library,
(5) check a few titles' file counts, (6) migrate users and requests, (7) turn the old apps off and
point Plex/Jellyfin and your phone apps at Arclight.

Notes:

- Only one app should be downloading at a time. Pause the old ones before enabling automatic search.
- Private trackers that bind your IP need the new address added.
- Custom format JSON from the TRaSH Guides imports directly.
- Passwords are not copied. Migrated users need a password set by an admin.

---

## 8. Using other tools with Arclight (compat API)

Arclight answers the Sonarr/Radarr v3 API at `/api/v3` so phone apps and companion tools can
connect without knowing it is not Sonarr or Radarr.

1. Settings -> Security: copy the **API key**.
2. In the other tool add a Sonarr and/or Radarr instance with URL `http://<host>:7878` and that key.
3. It covers series and movie lists, lookups, adding, calendar, queue, history, profiles, root
   folders, tags, commands (search, refresh), health and system status.

Send the key as the `X-Api-Key` header or `?apikey=` in the URL. A few exotic endpoints are not
covered; check [qa/99-known-limitations.md](qa/99-known-limitations.md) before relying on a niche
feature.

Arclight's own API is under `/api/v1` and a live event stream is at `/api/v1/events` (WebSocket).

---

## 9. Troubleshooting

### 9.1 First checks

1. System -> **Health**: read every message; most problems are explained there.
2. System -> **Logs**: raise the level with `ARCLIGHT_LOG_LEVEL=debug`, restart, repeat the problem,
   then search for the title or indexer name.
3. Press **Test** on the indexer or client in question.
4. System -> **Tasks**: is the job actually running? When did it last run?

### 9.2 Health messages

| Message | Meaning | Fix |
|---|---|---|
| No indexers available | No indexer is enabled for the type of search you want | Enable at least one with RSS and automatic search on |
| Indexer(s) unavailable due to failures | An indexer failed repeatedly and is backed off | Open it, Test, fix URL/API key/Cloudflare (add FlareSolverr), then wait or re-enable |
| No download client available | None enabled, or none reachable | Settings -> Download Clients -> Test |
| Download client unavailable | The client refused or timed out | Check URL, port, credentials, and whether it is running |
| Remote path / folder not found | The client reports a path Arclight cannot see | Add a remote path mapping, or mount the same folder in both containers |
| Root folder missing or not writable | A configured root folder is gone or read-only | Mount it, fix permissions (`PUID`/`PGID`) |
| Low disk space | Free space below the threshold | Free space, or lower the minimum free space in Media Management |
| VpnDisconnected | The VPN reports down | See 9.5 |
| VPN leak | The public IP matches your Home public IP | Fix the tunnel; grabs pause until fixed |
| Metadata (TMDB) unavailable | No key or TMDB is unreachable | Settings -> General: re-enter the key and test |
| Notification connection failing | A connection's last attempt failed | Settings -> Notifications -> Test |
| Docker permissions | The container user cannot write config | Fix ownership of the config share; check `PUID`/`PGID` |

Exact wording can differ slightly by version; System -> Health is the authority.

### 9.3 "Failed - cause" vocabulary

The Queue and History show a short cause with each failure. Common ones:

| Cause | What it means | What to do |
|---|---|---|
| Import failed: no matching episode / movie | The files could not be matched to a title | Manual Import, or fix the title |
| Import failed: sample / no video files | Only samples or non-video files in the download | Blocklist; search again |
| Import failed: not an upgrade | Existing file is the same or better | Remove from queue; nothing to do |
| Import failed: not enough free space | Root folder lacks room | Free space, retry |
| Import failed: unable to move/hardlink | Permission or cross-filesystem problem | Check ownership and that download and media share one filesystem |
| Download failed: no files found | Client path not visible to Arclight | Add a remote path mapping |
| Download failed: stalled | No progress for too long | Blocklist and search again |
| Download failed: client error | The client reported an error state | Look in the client's own log |
| Download failed: removed from client | Someone deleted it in the client | Blocklist or re-search |
| Rejected: quality / size / custom format score | The decision engine said no | Interactive Search shows which rule |
| Rejected: below minimum seeders | Torrent has too few seeds | Lower the indexer minimum or wait |
| Rejected: blocklisted | A previous failure | Delete the blocklist entry if the release is wanted |
| Grab failed: indexer error | The indexer returned an error or a bad link | Test the indexer; try another release |
| Grab refused: VPN down | Pause grabs when down is on | Fix the VPN |

### 9.4 Nothing is downloading

Walk down the chain: does Interactive Search show releases (indexers working)? Does grabbing one add
a queue item (client working)? Does the client show it and make progress (VPN, port, trackers)? Does
the queue item reach Completed and then Imported (paths, permissions)? The first place it stops is
the problem.

### 9.5 VPN problems

- **Connected but no forwarded port**: check you enabled NAT-PMP when creating the Proton config and
  chose a P2P server. Look at the Gluetun log for the port line.
- **Control server refuses (401/403)**: newer Gluetun needs an API key; enter it in Settings -> VPN.
- **qBittorrent not reachable after Gluetun was recreated**: containers sharing Gluetun's network
  must be recreated too (`docker compose up -d` does this).
- **Native Windows says access denied**: start PowerShell as Administrator.
- **Built-in engine pauses everything**: expected when the VPN is down; check the VPN status.
- **Public IP check fails but the VPN is up**: change the check URL to another IP echo service.

### 9.6 Slow or missing metadata

Re-enter the TMDB key and test it, then open the title and refresh it. If a title has the wrong
episodes, check its series type (Standard, Daily, Anime). The nightly refresh jobs fix most drift.

### 9.7 Cannot sign in

If you forgot the only admin password, restore a database backup from before the change, or stop
Arclight, move `arclight.db` aside and run the wizard again (you lose settings, not media). If
sign-in loops behind a reverse proxy, make sure it forwards `X-Forwarded-Proto` and keeps the
`al_session` cookie.

### 9.8 Where the files are

| What | Where |
|---|---|
| Database | `<config>/arclight.db` |
| Logs | `<config>/logs/` |
| Backups | `<config>/backups/` (or your chosen folder) |
| Site definitions | `<config>/definitions/` |
| Built-in engine resume data | `<config>/torrents/` |

When asking for help, attach the last 200 log lines and the Health page, and remove API keys.

---

## 10. FAQ

**Is it a media server?** No. Point Jellyfin, Emby or Plex at the same folders, and add them as
Notifications connections so they rescan on import.

**Can I run it next to Sonarr and Radarr?** Yes, but only let one app download, otherwise they
will fight over the same titles.

**Do I need the VPN?** No. The no-VPN compose file and the built-in engine both work without one.
If you torrent, you almost certainly want one.

**Do I need qBittorrent?** No. The built-in engine covers normal swarms. Use qBittorrent if you
need uTP, encryption or web seeds.

**Does it do usenet?** Yes: Newznab indexers with SABnzbd or NZBGet.

**Why does it say it needs a TMDB key?** All title data comes from TMDB. A key is free.

**Is 4K supported?** Quality profiles include 2160p and the request portal has a separate 4K
permission. There is one library per title, not separate 4K and HD instances.

**What is the difference between an indexer and a definition?** An indexer is a configured entry.
A definition is the built-in recipe for scraping a particular website that an indexer can be
created from.

**Why are my first searches slow?** Cloudflare-protected sites need FlareSolverr; each indexer is
queried in parallel but limited to its own rate limit.

**How do I stop it grabbing something?** Unmonitor it, add a release profile "must not contain"
rule, or blocklist the release.

**How often does it check for new releases?** RSS every 15 minutes by default, plus searches when
you add a title or when missing items are searched on schedule.

**Can I use my own subtitles?** Yes, upload a file on the title's Subtitles tab.

**Is it safe to expose?** Behind HTTPS with the login-page method, yes. Never expose it without
sign-in.

**Does it phone home?** It contacts only what you configure: TMDB, your indexers, clients,
providers and notification targets.

**Where do I see what is not finished?** [qa/99-known-limitations.md](qa/99-known-limitations.md).

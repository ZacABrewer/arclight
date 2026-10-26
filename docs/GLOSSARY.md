# Glossary

Plain-language definitions of the words you will meet in Arclight, torrenting and the media-automation world, with where each one shows up in the app. Terms are alphabetical. If a problem uses a word you do not know, start here, then go to [Troubleshooting](TROUBLESHOOTING.md).

Jump to: [A](#a) [B](#b) [C](#c) [D](#d) [F](#f) [G](#g) [H](#h) [I](#i) [K](#k) [L](#l) [M](#m) [N](#n) [O](#o) [P](#p) [Q](#q) [R](#r) [S](#s) [T](#t) [U](#u) [V](#v) [W](#w)

## A

<a id="announce"></a>
**Announce**
A torrent client telling a tracker "I am here, this is my port, this is how much I have transferred", and getting back a list of peers. The next announce time is shown in the details of a queue item (Activity > Queue). A failing announce on a private tracker usually means a bad passkey or an account problem. See [Download clients](using/download-clients.md).

## B

**Bind to VPN**
Setting in Settings > Torrent Engine. When on (default) and the VPN integration is enabled, the built-in engine ties all its network sockets to the VPN tunnel address and pauses everything if the VPN goes down. See [VPN](using/vpn.md) and [torrent-engine-not-on-vpn](TROUBLESHOOTING.md#torrent-engine-not-on-vpn).

**Blocklist**
A list of releases Arclight will never grab again (Activity > Blocklist). A release lands there when a download fails, or when you remove a queue item with "Add to blocklist". Removing it from the list makes the release eligible again. See [Activity](using/activity.md).

## C

**Calendar**
Upcoming episode air dates and movie releases for titles in your library (Calendar). See [Calendar](using/calendar.md).

**Category (download client)**
A label such as `tv` that Arclight sets on downloads it sends to a client, so it can tell its downloads from yours. Set per download client in Settings > Download Clients. See [Download clients](using/download-clients.md).

<a id="challenge-solver"></a>
**Challenge solver**
A browser-based helper that passes the "prove you are human" page some indexers put in front of their site. In Arclight it is either the bundled FlareSolverr container (Docker) or the built-in solver (native installs, Settings > Challenge Solver). See [FlareSolverr](#flaresolverr) and [Cloudflare challenge](TROUBLESHOOTING.md#cloudflare-challenge).

**Cloudflare**
A company whose protection pages sit in front of many indexer sites. A site "behind Cloudflare" may refuse plain requests with a 403 or 503 until a browser solves a challenge. See [CLOUDFLARE.md](CLOUDFLARE.md).

**Config folder**
Where Arclight keeps its own data: the database `arclight.db`, `logs/`, `backups/`, `definitions/` and `torrents/` (resume data). `/config` in Docker, `./config` otherwise unless `ARCLIGHT_CONFIG` says otherwise. Not the same as your media folders. See [Backup and restore](getting-started/backup-restore.md).

**Cross-seed**
Seeding the same content on more than one tracker without downloading it again, by matching a file you already have to a torrent on another tracker. In Arclight see Settings > Cross-seed and Activity > Cross-seeds. Needs hardlinks or a shared folder to avoid duplicate files. See [Download clients](using/download-clients.md).

**Custom format**
A rule that looks at a release name (and sometimes size or language) and gives it a name and a score, for example "HDR", "x265" or "Dolby Atmos". A quality profile assigns points to each custom format, and the release with the best total wins. Settings > Custom Formats. Many are available ready-made through [TRaSH guides](#trash-guides). See [Quality profiles](using/quality-profiles.md).

<a id="cutoff"></a>
**Cutoff**
The quality at which Arclight stops trying to upgrade a file. Set in a quality profile. If your cutoff is "Bluray-1080p" and you have WEB-DL 720p, the item shows under Wanted > Cutoff unmet until a better file arrives. See [Wanted](using/wanted.md).

## D

**Delay profile**
A rule that makes Arclight wait for a set number of minutes (separately for torrent and usenet) before grabbing a release, in case a better one shows up. Also sets the preferred protocol. Settings > Profiles. See [Quality profiles](using/quality-profiles.md).

**DHT**
Distributed hash table: a way to find peers without a tracker. Turned on by default in Settings > Torrent Engine. Not used for private torrents. See [Peer](#peer).

**Download client**
The program that actually downloads a file: Arclight's built-in torrent engine (the default), or optionally qBittorrent, Transmission, Deluge, rTorrent, SABnzbd or NZBGet. Settings > Download Clients. See [Download clients](using/download-clients.md).

## F

<a id="flaresolverr"></a>
**FlareSolverr**
An open-source tool (a headless browser behind a small web service) that solves Cloudflare challenges. The provided Docker stacks include it. Arclight talks to it through an indexer proxy of type FlareSolverr. See [Challenge solver](#challenge-solver).

<a id="forwarded-port"></a>
**Forwarded port**
A port your VPN provider opens for incoming connections, so other peers can connect to you. Much faster downloads and seeding than with no open port. Proton hands one out via [NAT-PMP](#nat-pmp). Shown in Settings > VPN as "Port forward". See [Port forward not synced](TROUBLESHOOTING.md#port-forward-not-synced).

**Freeleech**
A torrent on a private tracker whose download does not count against your ratio. Arclight can filter for freeleech-only releases through its tracker stats module. See [Indexers](using/indexers.md).

## G

**Gluetun**
A small VPN client container. Arclight and the download clients share its network in the provided stacks, so all their traffic goes through the VPN and everything else is blocked. Arclight reads its status (connected, public IP, forwarded port) from Gluetun's control server. See [VPN](using/vpn.md).

## H

**Hardlink**
A second name for the same file on disk. After import, the file in your downloads folder and the file in your library are the same data using space once, so you can keep seeding. Works only within one filesystem and, on Linux, only within one mount: this is why the Docker stacks mount a single `/data` share that holds both downloads and media. Setting: Media Management > "Use hardlinks instead of copy". See [Folders and hardlinks](getting-started/folders-and-hardlinks.md) and [Hardlinks not working](TROUBLESHOOTING.md#hardlinks-not-working).

**Health**
System > Health: the list of problems Arclight has found in itself (over 40 kinds of check). Each has a "How to fix" link. See [Health checks](TROUBLESHOOTING.md#health-checks).

**Hygiene**
Library > Hygiene: scans your root folders for video files that no library item points at (orphans) so you can map or delete them. See [Library](using/library.md).

## I

**Import**
Moving or hardlinking a finished download into the library folder with the right name. Also: bringing titles in from another source (see [Import list](#import-list)) or adopting a Sonarr/Radarr install (System > Import). See [Media management](using/media-management.md).

<a id="import-list"></a>
**Import list**
A source Arclight reads on a schedule to add titles for you: TMDB lists, Trakt, a Plex watchlist, an IMDb list, and so on. Settings > Import Lists. See [Library](using/library.md).

<a id="indexer"></a>
**Indexer**
A search service that lists releases (torrents or NZBs). Arclight queries your indexers by RSS, automatic search and interactive search. Settings > Indexers. See [Indexers](using/indexers.md).

**Indexer proxy**
A helper attached to an indexer (matched by tag), for example a FlareSolverr entry for Cloudflare-protected sites. Settings > Indexer Proxies. See [Cloudflare challenge](TROUBLESHOOTING.md#cloudflare-challenge).

**Interactive search**
Searching by hand for a title: Arclight lists every release found, with the reason for any it would reject, and you pick one. Compare with automatic search. See [Interactive search](using/interactive-search.md).

## K

**Kill switch**
A safety stop that blocks your traffic when the VPN fails, so nothing leaks through your home IP. In Arclight: the Gluetun firewall (in the Docker stack), plus the built-in engine pausing all torrents and listening only on 127.0.0.1 ("lockdown"). Grabs are also held while the VPN is down if "Pause grabs when down" is on. See [Paused by the VPN kill switch](TROUBLESHOOTING.md#paused-by-vpn-kill-switch).

## L

**Leech / leecher**
A peer that is still downloading (it has not got the whole file yet). In the queue details "seeds / leechers" is the swarm size the tracker reports. See [Seed](#seed) and [Swarm](#swarm).

**Library**
Everything Arclight manages: your series and movies with their files. Library > TV, Movies and Collections. Arclight is not a media server; Jellyfin, Emby or Plex read the same folders. See [Library](using/library.md) and [Media servers](using/media-servers.md).

**Lockdown**
The state of the built-in torrent engine while the kill switch is holding it: all torrents paused, sockets bound to 127.0.0.1. Shown on System > Status and in the queue banner. See [torrent-engine-lockdown](TROUBLESHOOTING.md#torrent-engine-lockdown).

## M

**Magnet link**
A text link that identifies a torrent by its hash instead of a file. The engine first has to fetch the file list from peers ("Fetching metadata"). See [No peers](TROUBLESHOOTING.md#no-peers).

**Manual import**
Activity > Manual import: choose a title and episode for files Arclight could not match on its own. See [Activity](using/activity.md) and [Import blocked or failed](TROUBLESHOOTING.md#import-blocked-or-failed).

**Monitored**
A flag on a series, season, episode or movie. Arclight searches for and upgrades only what is monitored. Unmonitored items are kept in the library but ignored. See [Library](using/library.md) and [Wanted](using/wanted.md).

## N

<a id="nat-pmp"></a>
**NAT-PMP**
A protocol a VPN uses to give you a [forwarded port](#forwarded-port). With Proton you must enable "NAT-PMP (port forwarding)" when creating the WireGuard configuration and connect to a P2P server. See [VPN](using/vpn.md).

<a id="newznab"></a>
**Newznab**
The standard search API used by usenet indexers. Add one under Settings > Indexers with its URL and API key. See [Torznab](#torznab) and [Indexers](using/indexers.md).

## O

**Orphan file**
A video file in a root folder that no library item points at. Found by Library > Hygiene. At 25 or more, Health shows [orphan-files-found](TROUBLESHOOTING.md#orphan-files-found).

## P

**P2P (naming)**
Naming style used by many non-scene release groups, which may use spaces, different tags or no strict rules. See [Scene vs P2P naming](#scene-vs-p2p-naming).

<a id="peer"></a>
**Peer**
Any other client in a torrent swarm that you exchange pieces with. "Connected peers" in the queue details and on Settings > Torrent Engine. See [Swarm](#swarm).

**Peer exchange (PEX)**
Connected peers telling each other about further peers. On by default; not used for private torrents. Settings > Torrent Engine.

**Port forward**
See [Forwarded port](#forwarded-port).

**Private tracker**
A torrent site that requires an account and a personal passkey, tracks your upload/download [ratio](#ratio), and disables DHT and peer exchange for its torrents. Needs more care: do not stop seeding too early. See [Indexers](using/indexers.md).

**Proper / repack**
Re-releases that fix a faulty release. A *proper* replaces a release by another group that was broken; a *repack* is the same group fixing its own release. Media Management has a "Download propers and repacks" setting for how to treat them (default: prefer and upgrade). See [Media management](using/media-management.md).

**PUID / PGID**
User and group ids the Docker container runs as (set in `.env`, defaults 1000 and 1000). They decide who owns the files Arclight writes, so they must match the owner of your media and download folders. Find yours with `id -u` and `id -g`. See [Permission denied](TROUBLESHOOTING.md#permission-denied) and [Install with Docker](getting-started/install-docker.md).

## Q

**Quality definition**
The table of qualities (for example WEBDL-1080p, Bluray-2160p) with the minimum, preferred and maximum file size per minute of video. Settings > Quality. See [Quality profiles](using/quality-profiles.md).

**Quality profile**
Your wish list for a title: which qualities are acceptable, in what order, the [cutoff](#cutoff), whether upgrades are allowed, and the custom format scores. Assigned per series or movie. Settings > Profiles. See [Quality profiles](using/quality-profiles.md).

**Queue**
Activity > Queue: downloads in progress and finished downloads waiting to import, with their state (Downloading, Stalled, No peers, Paused, Import blocked, ...). See [Activity](using/activity.md).

## R

<a id="ratio"></a>
**Ratio**
Uploaded data divided by downloaded data on a (private) tracker. Many trackers demand a minimum. The built-in engine has "Default seed ratio" and "Default seed time" in Settings > Torrent Engine. See [Seed](#seed).

**Release**
One specific downloadable version of an episode or movie, as listed by an indexer (title, size, quality, group, seeders).

**Release group**
The team that encoded and published a release, usually the name after the last dash in the title (`...-GROUP`). Some groups are known for good or bad quality; custom formats can score them. See [Quality profiles](using/quality-profiles.md).

**Release profile**
A "must contain / must not contain / preferred" word list applied to release titles. Settings > Profiles. See [Quality profiles](using/quality-profiles.md).

**Remote path mapping**
A translation between the path a download client reports and the path Arclight uses for the same folder, needed only when they differ (client in another container or on another machine). Settings > Download Clients, lower card. See [bad-remote-path-mapping](TROUBLESHOOTING.md#bad-remote-path-mapping) and [Download clients](using/download-clients.md).

**Remote engine**
A copy of Arclight's torrent engine running on another machine (an "agent") that your Arclight controls as a download client. See [REMOTE-ENGINE.md](REMOTE-ENGINE.md).

**Request**
A viewer asking for a movie or show through the request portal (Discover, Requests). An admin or an auto-approval rule turns it into a monitored title. See [Discover and requests](using/discover-and-requests.md).

**Resume data**
What the built-in engine saves so it can continue torrents after a restart without starting over. Stored in `<config>/torrents/`. See [Slow engine start](TROUBLESHOOTING.md#slow-engine-start).

**RSS (indexer)**
A feed of the newest releases that Arclight reads on a schedule to catch new episodes without searching. A per-indexer switch. See [Indexers](using/indexers.md).

**Root folder**
A top-level folder where finished titles live, for example `/data/media/tv` or `/data/media/movies`. Each title sits in a subfolder of one root folder. Settings > Media Management. See [Media management](using/media-management.md).

## S

<a id="scene-vs-p2p-naming"></a>
**Scene vs P2P naming**
"Scene" release names follow strict rules (dots between words, a year, a quality tag, `-GROUP`). "P2P" names are looser. Arclight's parser reads both; Arclight's own naming settings decide how files are named in your library. See [Media management](using/media-management.md).

**Season pack**
One release that holds a whole season instead of one episode. Often better quality and fewer torrents; Arclight decides between a pack and single episodes using its season-pack rules in the releases settings. See [Quality profiles](using/quality-profiles.md).

<a id="seed"></a>
**Seed / seeder**
To seed is to keep uploading a finished file so others can download it. A *seeder* is a peer that has the complete file. No seeders left means the download cannot finish ([Stalled](TROUBLESHOOTING.md#stalled)). Seeding limits are Settings > Torrent Engine > "Ratio & time".

**Series type**
How a series numbers its episodes: Standard, Daily or Anime. Wrong type is a common reason searches find nothing. See [Library](using/library.md).

**Stalled**
A download that has received no new data for longer than "Stalled download after" in Settings > Media Management (default 10 minutes). See [Stalled](TROUBLESHOOTING.md#stalled).

**Subtitle provider**
A source Arclight downloads subtitles from (including an optional speech-to-text provider). Settings > Subtitles. See [Subtitles](using/subtitles.md).

<a id="swarm"></a>
**Swarm**
All peers sharing one torrent: seeds plus leechers. The queue details show "N seeds / N leechers" as reported by trackers. See [Peer](#peer).

## T

**Tag**
A label you attach to indexers, proxies, notifications, profiles and titles to link them. For example the `cloudflare` tag ties an indexer to the FlareSolverr proxy. See [Indexers](using/indexers.md).

<a id="tmdb"></a>
**TMDB**
The Movie Database: the free source of all title, season and episode data in Arclight. A free API key is required (Settings > General, or `ARCLIGHT_TMDB_API_KEY`). See [tmdb-api-key-missing](TROUBLESHOOTING.md#tmdb-api-key-missing).

<a id="torznab"></a>
**Torznab**
The standard search API used by torrent indexers (for example from Jackett). Add one under Settings > Indexers. See [Newznab](#newznab).

**Tracker**
The server a torrent announces to, which tells your client which peers exist. Private trackers also keep your ratio. Not the same as an [indexer](#indexer), which is where you search. See Indexers > Tracker stats and [Announce](#announce).

<a id="trash-guides"></a>
**TRaSH guides**
A community project recommending quality profiles and custom formats. Arclight can sync them from Settings > Guides (a data feed shown on System > Feeds). See [Quality profiles](using/quality-profiles.md).

**TVDB**
TheTVDB, a series database used by other tools for episode numbering. Arclight takes its title data from [TMDB](#tmdb); TVDB ids still appear for compatibility with tools that use them. See [Library](using/library.md).

## U

**Upgrade**
Replacing a file with a better one when a better release appears, until the [cutoff](#cutoff) is met (and, with custom formats, by score). Needs "upgrades allowed" in the profile. See [Quality profiles](using/quality-profiles.md) and [Wanted](using/wanted.md).

**uTP**
A UDP-based transport for torrents, an alternative to TCP. Settings > Torrent Engine > Transport has TCP and uTP switches; if both are off, no peer can connect.

## V

**VPN**
A tunnel that sends your traffic through another provider's address. Arclight supports Gluetun (Docker), WireGuard for Windows (native) and interface binding. Settings > VPN. See [VPN](using/vpn.md).

## W

**Wanted**
Monitored episodes and movies that are missing, or that have a file below the cutoff. Wanted > Missing and Wanted > Cutoff unmet. See [Wanted](using/wanted.md).

**WireGuard**
The modern VPN protocol Proton and others offer. In Docker, Gluetun runs it with your Proton key (`PROTON_WIREGUARD_KEY`). On native Windows, Arclight installs and watches a tunnel from a `.conf` file. See [VPN](using/vpn.md).

## Related

- [Troubleshooting](TROUBLESHOOTING.md)
- [FAQ](FAQ.md)
- [Quality profiles](using/quality-profiles.md)
- [Indexers](using/indexers.md)
- [Download clients](using/download-clients.md)
- [VPN](using/vpn.md)
- [Folders and hardlinks](getting-started/folders-and-hardlinks.md)

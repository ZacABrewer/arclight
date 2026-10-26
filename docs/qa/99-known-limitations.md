# Known limitations

These are things Arclight does not do, or does only partly, at the time of writing. They come
from the package READMEs (`packages/torrent-engine`, `packages/subtitles`,
`packages/download-clients`), the specs in `docs/spec/`, the API reference (`docs/API.md`), and
what the UI really contains compared with `docs/UI-INVENTORY.md`.

Use this file while testing: if a check fails in a way described here, record it as **Known**
rather than as a new bug. If behaviour is worse than described, that is a real bug. When a
limitation is fixed, delete its row so the file stays honest.

"Where you notice it" names the checklist file or row that touches it.

## Built-in torrent engine

The engine (`@arclight/torrent-engine`) is a from-scratch BitTorrent client written in
TypeScript. It is meant to be good enough to replace qBittorrent for ordinary public and
private-tracker use, not to match every feature.

| Limitation | Effect | Where you notice it |
|---|---|---|
| No MSE/PE (message stream) encryption. The Torrent Engine setting for encryption accepts only "disabled". | Peers that require encrypted connections cannot connect. Some swarms are slower than in qBittorrent. A tracker that forces encryption cannot be used. | 05 (engine), 06 |
| No uTP (BEP 29); TCP only. | Fewer reachable peers behind some NATs. Slower on congested links than clients with uTP. | 05, 11 |
| No IPv6 (no IPv6 peers, no `peers6`, no DHT over IPv6). | IPv6-only peers are never used. | 05 |
| No web seeds (BEP 17/19). `url-list` in a .torrent is read but ignored. | Torrents that depend on an HTTP seed with no peers stay at 0%. | 05 |
| No v2-only torrents (BEP 52). Hybrid torrents download through their v1 data; v2-only torrents go to the error state. | Rare; shows as an errored torrent. | 05 |
| No super-seeding, no secure DHT node ids (BEP 42), no read-only DHT or BEP 44, no UPnP or NAT-PMP port mapping, no IP-filter file formats. | Port forwarding must come from the VPN (Proton via Gluetun) or the router by hand. | 05, 11 |
| Fast extension is partial: incoming `suggest` and `allowed fast` messages are ignored and the engine never sends allowed-fast sets. | Slightly slower start on some swarms. | n/a |
| Rate limits are global and per connection. There are no per-torrent limits. | Cannot cap one torrent below the others. | 05 |
| Engine state lives in the config folder under `torrents/` (fast-resume data). Losing the folder loses partial-download resume points. | Torrents recheck from scratch after restoring a backup that omits it. | 13 |

## Download clients

| Limitation | Effect | Where you notice it |
|---|---|---|
| rTorrent has no per-torrent seed limits in its API; whatever stops a finished torrent counts as the seeding policy. | A stopped finished torrent is treated as "seeding complete". | 05 |
| A torrent stopped with no limit is removable only when it is known to be public (qBittorrent, Transmission). | Private-tracker torrents are left in the client after import when they have no seed limit. | 05, 06 |
| Completed-download handling, failed-download handling and auto re-search switches (`enableCompletedDownloadHandling`, `autoRedownloadFailed`) are stored in Media Management settings but have no screen. | Change them with `PUT /api/v1/settings/mediamanagement`. | 05 (DLC-25), 06 |
| The usenet clients (SABnzbd, NZBGet) need a real server and account to test end to end; automated tests use stubs only. | Usenet rows are marked optional. | 05 |

## Subtitles

| Limitation | Effect | Where you notice it |
|---|---|---|
| No CAPTCHA or Cloudflare solving. Captcha-walled providers report `captcha` and are throttled for 12 hours. Affected: Addic7ed (login reCAPTCHA), Subf2m (Cloudflare challenge), and any scraper site behind a challenge. | Provider shows throttled in Settings -> Subtitles until the throttle ends or you use "Reset throttles". | 08 |
| Podnapisi is "best effort": the upstream API shape could not be verified because the original provider was removed. Treat any result as a bonus. | May return nothing or error. | 08 |
| Providers marked implemented but not tested against live services in this build: gestdown, animetosho, jimaku, yifysubtitles, napisy24, embeddedsubtitles (needs ffprobe/ffmpeg), whisperai (needs your own Whisper-ASR web service). Only opensubtitles.com and subdl are expected to work with just an account. | Provider Test may fail for reasons outside Arclight. | 08 |
| Napisy24 requires your own credentials (no shared fallback account). Quotas for several scraper providers (Napisy24, Gestdown, Subf2m, YIFY) are unmeasured. | You may be rate-limited without a clear message. | 08 |
| rar and 7z subtitle archives are refused; Zip64 and password-protected zips are not supported. XZ support covers the LZMA2 filter only. | Some downloads fail with "unsupported archive". | 08 |
| Only text subtitle tracks are extractable (ASS, SubRip, WebVTT). Bitmap subtitles (PGS, VobSub) are never offered and there is no OCR. | Embedded PGS tracks are listed as present but cannot be extracted or synced. | 08 |
| Sync needs ffsubsync or alass installed on the host; neither ships in the Docker image. | Sync reports "tool not found"; the toggle can still be saved. | 08 |
| Subtitle translation, mods catalogue beyond the first few, and mojibake repair are not implemented. | Wrongly encoded files stay wrong. | 08 |
| Provider throttle state is held in memory by the subtitle package; the API module persists and restores it. | If persistence fails, a restart clears throttles early. | 08 |
| Blacklisting is possible only from the per-file subtitle menu; the Blacklist page lists and removes entries but cannot add one (add via `POST /api/v1/subtitle/blacklist`). | | 08 |

## Indexers and definitions

| Limitation | Effect | Where you notice it |
|---|---|---|
| Bundled public-tracker definitions (`1337x`, `eztv`, `limetorrents`, `nyaa`, `thepiratebay`, `torlock`, `torrentgalaxy`, `yts`) are untested against the live sites in this build. Public sites move domains and add challenges often. | Test may fail or return no rows; try a mirror via "site link", add a FlareSolverr proxy, or use a Torznab URL. | 04 |
| No remote definition catalogue: only the bundled set plus your own YAML files in `<config>/definitions/`. There is no "outdated definition" health check. | New trackers need a hand-written definition. | 04 |
| The definition engine does not paginate: one page per search path. Template functions beyond the documented set (`now`, pipelines, arithmetic) are not supported. Only urlencoded POST is supported through FlareSolverr. | Deep interactive searches return only the site's first page. | 04 |
| FlareSolverr is stateless: every solve is a new session, so first requests to a protected site are slow. | | 04 |
| Custom YAML definitions have no UI editor; upload and delete exist in the API only (`POST /api/v1/indexer/definition`, `DELETE /api/v1/indexer/definition/:id`, `POST .../reload`). | | 04 |
| Arclight does not expose a Torznab server for other apps and cannot push indexers to a separate Lidarr or Readarr. Other tools (Prowlarr) push into Arclight through the compat API instead. | | 14 |

## VPN

| Limitation | Effect | Where you notice it |
|---|---|---|
| Node's `fetch` cannot bind to a local address. The native public-IP check (`publicIpCheckUrl`, default `https://api.ipify.org?format=json`) follows the operating-system routing table. With a full-tunnel WireGuard config (AllowedIPs 0.0.0.0/0) it goes through the tunnel; with a split tunnel it may not. | The VPN card can show your ISP address while the engine is correctly bound. Set "home public IP" so a check that leaves via your ISP is flagged as a leak instead of passing silently. | 11 |
| The Windows WireGuard provider needs the official WireGuard for Windows client and an elevated (Administrator) process. | Without elevation, Connect fails with a permission message. | 11 |
| With the Docker VPN stacks Arclight shares Gluetun's network. Stopping Gluetun also cuts the UI. | The kill-switch drill (VPN-30) is done from the Docker host with `docker stop gluetun`, then watching the Docker host side, not through the browser. | 11 |
| Newer Gluetun releases require authentication on the control server (API key or password) and the Proton port-forward port can take about a minute to appear after connect. | Forwarded port shows empty until Gluetun reports it. | 11 |
| Only Gluetun, WireGuard for Windows and interface binding are supported. No OpenVPN management, no other VPN client integrations. | | 11 |
| Port forwarding is learnt from Gluetun only; the engine has no UPnP or NAT-PMP of its own. | | 05, 11 |

## Compatibility API (Sonarr/Radarr v3)

| Limitation | Effect | Where you notice it |
|---|---|---|
| SignalR (`/signalr/messages`) is not emulated. | Clients that wait for push updates poll or show stale data until refreshed. | 14 |
| `calendar` and `wanted/missing` on `/api/v3` are episode-only (Sonarr shape). Radarr's movie calendar is not served on the shared path. | Radarr-only apps do not show upcoming movies from Arclight. | 14 |
| Lookups are TMDB-backed: `tvdbId` is 0 unless TMDB knows it; TV Rage and TV Maze ids are always 0; `airTime` is UTC, not network time. | Some mobile apps show odd times or cannot search by TVDB id. | 14 |
| Read-only on `/api/v3`: `customformat`, `delayprofile`, `releaseprofile`, `downloadclient`, `notification`, `importlist`, `config/*`, and `system/backup` (always empty). | Recyclarr can sync quality profiles but not every setting. | 14 |
| `POST /api/v3/indexer/test` validates the body only; it does not contact the indexer. | Prowlarr's "Test" always passes. | 14 |
| Stored indexer base URLs are normalised (trailing slash removed), so Prowlarr may report a difference and resend the indexer on its next sync. | Harmless repeated updates. | 14 |
| Queue records expand multi-episode downloads into one record per episode. `languageprofile` is a single fixed "Any" profile. Custom-format specification values are best-effort translations. | | 14 |

## Requests and discover

| Limitation | Effect | Where you notice it |
|---|---|---|
| Approved requests add the title directly to the Arclight library; there are no separate Radarr/Sonarr "server" targets as in Seerr. 4K is a second profile on the same item, not a second server. | Differs from `docs/spec/requests.md` section 9. | 09 |
| The Approve button has no override options; set profile, root folder and tags by editing the pending request first (or via the API). | | 09 |
| Out of scope in this build: a Plex library scanner for availability, voting, and the "Recently added" discover slider. By default availability comes from the Arclight library only; the optional "use media server availability" setting also asks Jellyfin or Emby connections (not Plex). | A title that exists on Plex but not in Arclight shows as not available. | 09 |
| Sign-in through Jellyfin/Emby/Plex accounts is not built; users are local accounts created in Settings -> Security. | | 01, 09 |
| Seerr-style partial-request enforcement on the server for `partialRequestsEnabled` = false is unverified. | | 09 |

## User interface gaps

The inventory in `docs/UI-INVENTORY.md` lists these as planned or partly built. They are not
bugs unless the checklist for that area says otherwise.

| Area | What is missing |
|---|---|
| Library | No poster-size slider, no Overview view, no bulk Refresh/Search/Tags actions, no tag-management page, no import-exclusions screen, no "import existing library from folder". The series "Refresh" button is greyed out. No series History tab; the movie History tab shows "History is coming soon". Rename preview, rescan and library statistics are API only. |
| Calendar | Month and Agenda views only. No week or day view, no tag/type/date-kind filters, no popovers. No "regenerate token" button for the iCal feed. |
| Wanted | No filters and no monitored toggle on Missing. Cutoff Unmet shows "Cutoff unmet is not available yet" because the native API has no cutoff route (the compat API does). |
| Activity | History has no Redownload action; the Imported, Failed and Ignored filter chips use event names the API does not store, so they may show nothing. The Queue has no status filter. Blocklist cannot be cleared or added to from the UI (API only). "Mark as failed" cannot set skip-redownload. |
| Settings | Notification flags `enabled` and `includeHealthWarnings`, compat settings, and the log level have no screen. Changing your own password has no screen (API only: `PUT /api/v1/user/me/password`). Settings -> General still shows a stale "Backups are coming soon" card; backups are under System -> Backups. |
| Shell | The newer UI kit pieces (Backdrop, Rail, CommandPalette, KeyboardSheet, MobileTabBar) are not mounted in the live app. The only keyboard shortcut is `/` (focus search). No keyboard-shortcut help sheet, no command palette. |
| Mobile / PWA | No web app manifest and no service worker, so "Install app" is not offered. The layout collapses to a drawer below 900 px; there is no bottom tab bar and no push notification. |
| System | No Updates page (current/available, changelog) and no audit/events log. |

## Authentication and access

| Limitation | Effect |
|---|---|
| One API key per install, and it always grants admin. There are no per-user API keys. | Give the key only to trusted tools. |
| Roles are `admin` and `user`; finer control is through the permission bitfield managed in Settings -> Users -> Manage. | |
| No two-factor sign-in, no external identity provider. | |
| With method "None on the local network" only loopback, private-range and link-local addresses skip sign-in. If Arclight sits behind a reverse proxy on the same LAN that forwards public addresses without `X-Forwarded-For`, every visitor looks local. Put the proxy's authentication first. | |
| Failed logins are limited to 10 per address per 15 minutes (HTTP 429). The counter is in memory and resets on restart. | |

## Pipeline behaviour worth knowing

| Limitation | Effect |
|---|---|
| Multi-season packs are rejected ("Multi-season releases are not supported" by the decision engine; "Multi-season download, unable to import automatically" on import). | Grab season packs one season at a time. |
| Partial season packs and season extras are not imported automatically ("Partial season packs are not supported", "Extras are not supported"). | Use Activity -> Manual Import. |
| Archive files (.rar, .zip) in a completed download are not extracted by Arclight ("Found archive file, might need to be extracted"). | Configure the download client to unpack, or extract by hand then Manual Import. |
| Language profiles for audio language live on the quality profile; subtitle language profiles are separate (Settings -> Subtitles). | |
| Metadata comes from TMDB only (no TVDB fallback, no image caching on disk). | Series without TMDB episode data show gaps; posters load from TMDB each time. |
| Docker image does not include ffmpeg, ffprobe, ffsubsync or alass. | Media-info on import and subtitle extraction/sync are unavailable unless you install them in a derived image. |
| Docker permission and read-only-mount health checks assume a Linux container user mapping (`PUID`/`PGID`). | Native Windows reports fewer filesystem problems. |

## Documentation known to be stale

`docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/API.md` (module list and the "not built yet"
statements) and the Status paragraph in `README.md` still describe an earlier phase. The code is
the authority. `docs/UI-INVENTORY.md` marks pages as unbuilt that now exist (Discover, Requests,
Issues, Watchlist, Subtitles, Indexer Proxies, Indexer Stats, Import Lists, Backups, Import,
VPN, Torrent Engine) and lists features that do not (week view, bulk tags, command palette).

## Open questions from the specs (undecided behaviour)

| Topic | Question |
|---|---|
| Subtitle providers (`docs/spec/subtitle-providers.md`, section 5) | Podnapisi replacement; which Whisper service shape; legal and terms-of-service review for scraper providers; CAPTCHA strategy (build, require a solver, or decline). |
| Subtitles (`docs/spec/subtitles.md`, section 16) | Backoff reset when a file is replaced; tie-breaking of equal scores; embedded extraction precedence over downloads; post-processing timeout (default 60 s); history retention after item removal. |
| Indexer definitions (`docs/spec/indexer-definitions.md`, section 20) | Remote catalogue; licensing of bundled site definitions; default timezone for dates without a zone; cookie-jar fidelity; seeding-rule precedence on private trackers; whether failed queries count against query limits. |
| Health checks (`docs/spec/health-checks.md`, section 8) | Update-available logic; exact meaning of "folder empty" and "folder writable". |
| Requests (`docs/spec/requests.md`) | Whether quota windows without days mean unlimited; server-side enforcement of partial requests. |

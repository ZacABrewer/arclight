# Arclight manual QA checklists

These checklists are for a person sitting in front of a running Arclight, clicking through it
and writing down what happened. No programming knowledge is needed. Each file covers one area
(setup, library, indexers, and so on). Every row is one small check: do the step, compare what
you see with the expected result, and mark the row Pass or Fail.

## How to use a checklist

1. Pick a test environment (next section) and get Arclight running.
2. Work through the files in numeric order the first time. Later files assume earlier ones are
   done (for example, the acquisition flow needs an indexer and a download client from files 04
   and 05). When a file has a prerequisite, it says so in its first paragraph.
3. For every row, do the **Step**, then compare with **Expected result**. Type `P` (pass) or `F`
   (fail) in the last column. If you cannot run a row (missing hardware, no account), type `S`
   (skipped) and say why in your notes.
4. When a row fails, do not stop. Write the ID and a short note (what you saw, what you clicked),
   grab the logs (see "Capturing logs"), then continue. Retry once after a page reload before
   calling it a failure, because a stale page is the most common false alarm.
5. Rows marked "(Docker + VPN only)", "(Native only)" and similar apply to that environment only.
   Skip the others.
6. Rows marked "via API" use `curl` with the API key from Settings -> Security. The header is
   `X-Api-Key: <key>`.

Row IDs are stable (`SET-01`, `LIB-12`, `FAIL-07`), so quote them in bug reports.

## The checklists

| File | Area | ID prefixes |
|---|---|---|
| [01-setup-and-shell.md](01-setup-and-shell.md) | Setup wizard, login, security, users, dashboard, app shell, global search | SET, DSH, SHL |
| [02-library.md](02-library.md) | Add series and movies, grid and table, details, edit, delete, files | LIB |
| [03-metadata-and-profiles.md](03-metadata-and-profiles.md) | TMDB metadata, quality profiles, custom formats, delay and release profiles | MET, PRO |
| [04-indexers.md](04-indexers.md) | Torznab, Newznab, catalogue definitions, proxies, stats, search | IDX |
| [05-download-clients.md](05-download-clients.md) | Every client kind, built-in engine, path mappings, queue | DLC |
| [06-acquisition-flow.md](06-acquisition-flow.md) | End to end: search, grab, import, rename, notify; failure paths | TV, MOV, FAIL |
| [07-calendar-and-wanted.md](07-calendar-and-wanted.md) | Calendar, iCal feed, Wanted lists | CAL, WNT |
| [08-subtitles.md](08-subtitles.md) | Language profiles, providers, wanted, manual search, upload | SUB |
| [09-requests.md](09-requests.md) | Discover, requests, approval, quotas, issues, watchlist | DSC, REQ, ISS, WTC |
| [10-import-lists-and-notifications.md](10-import-lists-and-notifications.md) | Import lists, exclusions, notification agents | IML, NOT |
| [11-vpn.md](11-vpn.md) | Gluetun, forwarded port, kill switch, Windows WireGuard | VPN |
| [12-activity.md](12-activity.md) | Queue, history, blocklist, pending, manual import | ACT |
| [13-system.md](13-system.md) | Status, tasks, health, logs, backups, migration | SYS |
| [14-compat-api.md](14-compat-api.md) | Sonarr/Radarr-compatible API for Overseerr, Prowlarr, mobile apps | CMP |
| [15-mobile-pwa-performance.md](15-mobile-pwa-performance.md) | Phone layout, PWA, performance smoke | MOB, PRF |
| [16-security.md](16-security.md) | Authentication, roles, API key, local bypass | SEC |
| [99-known-limitations.md](99-known-limitations.md) | Things that are known not to work; do not file bugs for these | n/a |

Read [99-known-limitations.md](99-known-limitations.md) before you start. A row that exercises
a known limitation is expected to fail or show a "not available yet" message; record it as
Pass if the app behaves as the limitations file describes.

## The test environments

### 1. Native on Windows (fastest, no Docker)

Runs the API and the built web app on your PC against an isolated folder, so nothing touches
the NAS or any other *arr install.

```powershell
cd "C:\path\to\arclight"
.\scripts\local-test.ps1            # builds the web app, then starts Arclight
.\scripts\local-test.ps1 -NoBuild   # skip the web build (reuse the last build)
.\scripts\local-test.ps1 -Reset     # wipe the test config first (fresh database)
.\scripts\local-test.ps1 -Port 17979   # use another port
```

- Address: **http://localhost:17878** (bound to 127.0.0.1, so only this PC can open it).
- All data lives in `C:\path\to\test-env` (a sibling of the repo): `config\` (database
  `arclight.db`, `logs\`, `backups\`), `tv\`, `movies\`, `downloads\` (with `complete\` and
  `incomplete\`). Use these as your root folders and download folder.
- Secrets can live in `C:\path\to\test-env\.env` as `KEY=value` lines (for example
  `ARCLIGHT_TMDB_API_KEY=...`). The script loads them before starting.
- Press Ctrl+C in the PowerShell window to stop. Close the window and the app is gone.
- Needs Node 24 and pnpm 10 installed, and `pnpm install` run once.
- The Windows WireGuard checks in file 11 need PowerShell started as Administrator.

### 2. Docker Desktop (or any Docker host)

The compose files are in `docker\`. Copy `docker\.env.example` to `docker\.env` and edit it
(`PUID`, `PGID`, `TZ`, `CONFIG_ROOT`, `TV_ROOT`, `MOVIES_ROOT`, `DOWNLOADS_ROOT`, and for VPN
stacks `PROTON_WIREGUARD_KEY`, `VPN_COUNTRIES`, `LAN_SUBNET`). On Docker Desktop for Windows,
set the three root variables to Windows folders such as `C:/path/to/test-env/tv`, or leave
them unset to use `docker\data\...`.

| Stack | Command (run inside `docker\`) | What you get | Address |
|---|---|---|---|
| With VPN and qBittorrent | `docker compose -f docker-compose.yml up -d --build` | gluetun + arclight + qbittorrent; both apps share gluetun's network | Arclight http://localhost:7878, qBittorrent http://localhost:8080 |
| With VPN, built-in engine | `docker compose -f docker-compose.builtin.yml up -d --build` | gluetun + arclight only; torrents run inside Arclight | http://localhost:7878 |
| No VPN | `docker compose -f docker-compose.novpn.yml up -d --build` | arclight + qbittorrent, peer port 6881 published | Arclight http://localhost:7878, qBittorrent http://localhost:8080 |
| Published image | `docker-compose.release.yml` / `docker-compose.release.novpn.yml` | same as above, pulled from GHCR instead of built | same |

Notes:

- With a VPN stack, ports are published on the `gluetun` container because the others share its
  network. When you add qBittorrent inside Arclight, the host is `localhost` and the port is
  `8080` (same network namespace). In the no-VPN stack the host is `qbittorrent`.
- First start can take a minute while gluetun connects; Arclight waits for gluetun to be healthy.
- qBittorrent's first password is printed in its log (`docker logs qbittorrent`). Change it,
  then enter the same credentials in Arclight.
- Stop: `docker compose -f <file> down`. Data stays in the folders you configured.

### 3. NAS (Synology and similar)

Same compose files, run from the NAS shell or Container Manager. Use the `.env` values from
`docker\.env.example` (`CONFIG_ROOT=/volume1/docker`, `TV_ROOT=/volume1/media/tv`,
`MOVIES_ROOT=/volume1/media/movies`, `DOWNLOADS_ROOT=/volume1/downloads`). Use the NAS address,
for example http://nas.local:7878. Make sure the `PUID` and `PGID` user can write to all four
folders; wrong ownership is the most common NAS failure ("Docker permissions" health message).
The NAS is the only environment where media-server refresh (Jellyfin, Emby, Plex), real
hardlinks across the downloads and media shares, and long-running soak checks are meaningful.

## Prerequisites per environment

| Need | Native | Docker | NAS | Where to get it |
|---|---|---|---|---|
| TMDB v3 API key | Required | Required | Required | themoviedb.org, Settings -> API. Without it you cannot add titles. Can also be supplied as `ARCLIGHT_TMDB_API_KEY`. |
| An indexer | Required | Required | Required | A Torznab URL plus API key (Jackett, a private tracker), **or** a built-in public definition from the catalogue (`1337x`, `eztv`, `limetorrents`, `nyaa`, `thepiratebay`, `torlock`, `torrentgalaxy`, `yts`; public sites change often, expect some to be down). |
| A download client | Built-in engine (no extra install) or a local qBittorrent | Built-in engine or qBittorrent from the compose file | Same as Docker | qBittorrent WebUI enabled; a usenet client (SABnzbd, NZBGet) is optional |
| Usenet account + Newznab indexer | Optional | Optional | Optional | Only for the usenet rows in files 04, 05 and 06 |
| Proton WireGuard key with port forwarding | Only for the Windows WireGuard rows (as a `.conf`) | Required for the gluetun stacks | Required for the gluetun stacks | account.proton.me -> VPN -> Downloads -> WireGuard configuration; enable NAT-PMP (port forwarding). Put the `PrivateKey` into `PROTON_WIREGUARD_KEY`. |
| Media server (Jellyfin, Emby or Plex) | Optional | Optional | Recommended | For the refresh checks in files 06 and 10 |
| Discord webhook or similar | Recommended | Recommended | Recommended | A throwaway channel, for the notification checks |
| Subtitle provider account (OpenSubtitles.com, Subdl) | Optional | Optional | Optional | Only for file 08 |
| Trakt account, Plex token | Optional | Optional | Optional | Only for the Trakt and Plex rows in files 09 and 10 |
| A second browser or private window | Required | Required | Required | For login, role and permission checks |
| ffmpeg and ffprobe on PATH | Optional | Not in the Docker image (rows that need it are skipped) | Not in the image | Media-info and embedded-subtitle rows; without ffprobe, imports skip media-info |

Copyright note: use titles you are legally allowed to download (public-domain or
Creative-Commons releases, your own media) for the end-to-end checks.

## Resetting state

| Goal | Native | Docker / NAS |
|---|---|---|
| Brand-new install (first-run wizard again) | `.\scripts\local-test.ps1 -Reset` (deletes everything under `test-env\config`; tv, movies and downloads stay) | `docker compose -f <file> down`, delete the `arclight` config folder (`${CONFIG_ROOT}/arclight`), start again. Leave the gluetun folder alone to keep the VPN state. |
| Keep settings, drop the library | Delete the series and movies in the UI (tick "delete files" if wanted) | Same |
| Clear downloaded media | Empty `test-env\tv`, `test-env\movies`, `test-env\downloads` | Empty your TV, movies and downloads folders; then use Library -> series -> Refresh or System -> Tasks to rescan |
| Go back to a known state | Restore a backup: System -> Backups, then restart (see file 13) | Same; restart the container (`docker restart arclight`) |
| Forget a login | Delete the `al_session` cookie for the site (browser dev tools -> Application -> Cookies), or use a private window | Same |

Take a backup (System -> Backups -> create) right after a successful run of files 01 to 05. It
makes later re-runs much quicker than redoing the setup wizard.

## Capturing logs

When a row fails, attach the log lines from the minute it happened.

- **In the app:** System -> Logs. Use the level list ("error and above" and so on), the search
  box, and the "Follow" switch for a live tail. The same page lists the log files, each with a download
  link. Raise the detail first if you need to: the log level is not editable in the UI, so start
  with `ARCLIGHT_LOG_LEVEL=debug` (Native: `$env:ARCLIGHT_LOG_LEVEL='debug'` before running
  the script).
- **Docker:** `docker logs arclight --since 10m`, add `-f` to follow. For the VPN stack also
  `docker logs gluetun --since 10m`, and for qBittorrent `docker logs qbittorrent --since 10m`.
- **Native:** the same lines print in the PowerShell window; files are in
  `C:\path\to\test-env\config\logs`.
- **Browser:** press F12, open the Console tab for red errors and the Network tab for failed
  (red) requests. Save a screenshot of the failed state.
- **Health:** System -> Health lists current problems with a "Recheck" action; copy the message
  text exactly.
- **Version:** note the version and commit shown in System -> Status.

Never paste your API key, TMDB key, VPN private key or indexer keys into a bug report. The logs
already redact URLs, but check before sharing.

## Results template

Copy this table into a new file (for example `results-2026-11-02.md`) for each run. Add one
row per failed or skipped check; passes can be counted in the summary.

```
Run date:        2026-11-02
Tester:          your name
Build / commit:  version from System -> Status, plus git commit hash
Environment:     Native | Docker + VPN + qBittorrent | Docker + VPN built-in | Docker no VPN | NAS
Browser / OS:    Chrome 130 on Windows 11
Indexer used:    Torznab (Jackett) | 1337x | ...
Download client: built-in | qBittorrent 5.0 | SABnzbd ...
```

| ID | Result (pass / fail / skip) | Notes (what you saw; log line; screenshot name) | Build / commit |
|---|---|---|---|
| SET-01 | pass | | 0.1.0 / abc1234 |
| SET-02 | fail | Error text was "Required" instead of "At least 2 characters." | 0.1.0 / abc1234 |
| LIB-07 | skip | No TMDB key on this machine | 0.1.0 / abc1234 |

Summary line per file, for example: `06-acquisition-flow: 74 pass, 3 fail, 2 skip`.

## Severity guide for failures

| Severity | Meaning | Example |
|---|---|---|
| Blocker | The core loop cannot complete or data is lost | Grab works but nothing ever imports; backup restore corrupts the database |
| Major | A feature does not work, with no workaround | Cannot add an indexer of one kind |
| Minor | Works but wrong text, layout or edge case | Typo in a toast; sorting off by one |
| Known | Described in 99-known-limitations.md | Cutoff Unmet page says "not available yet" |

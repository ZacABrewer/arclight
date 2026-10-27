# System pages

The System section is where you look after Arclight itself: is it healthy, what is it doing in the background, what do the logs say, can I back it up, and is there an update. This page walks through each System page, then covers the metrics endpoint, config-as-code and where the log files live. Use it when something looks wrong or when you want to keep an eye on things.

The System menu has these items: Status, Tasks, Logs, Debugging, Backups, Health, Import, Updates, Stats, Feeds and Audit.

## Status

System > Status is the "what am I running" page.

| Section | What it shows |
|---|---|
| About | Version, started time, uptime, and whether Arclight runs in Docker |
| Runtime | Node version, platform, architecture |
| Paths | The config folder, database file and log folder |
| Torrent engine | State (running, starting, VPN lockdown, failed, disabled), download and upload speed, torrents downloading, seeding and total, peers |
| Indexers | Each indexer with an OK, "recent failures" or paused (with a retry timer) chip |

During a VPN lockdown the engine card says torrents are paused and bound to `127.0.0.1` until the VPN is back. See [vpn.md](vpn.md).

> Coming soon: speed and VPN history charts. This page will be updated when it ships.

## Tasks

System > Tasks shows everything Arclight does on a timer.

- **Scheduled tasks**: Task, Interval, State, Last run, Next run. Click "Run now" to start one immediately.
- **Task history**: every run with its Status, Trigger (scheduled or manual), when it was queued, Duration and Message. Failed runs show the reason.
- **Media analysis queue**: how many files are waiting for `ffprobe` to read their resolution and codecs. If ffprobe is missing the files stay in the queue and a hint explains how to fix it.

Examples of tasks you will see: the hourly health check, the queue refresh, RSS sync, missing-episode searches, metadata refresh, the backup job, update checks, the audit cleanup and the VPN status check. Tasks you never need to touch; "Run now" is for when you want a result sooner.

## Logs

System > Logs has two parts.

- **Log entries**: a live view. Filter by level ("{level} and above"), search messages, "Live tail" (Pause or Resume), and "Clear logs" (clears the on-screen buffer, not the files).
- **Log files**: the files on disk, each with a download link.

### Log locations and levels

| What | Where |
|---|---|
| Log file | `<config folder>/logs/arclight.log` (in Docker: `/config/logs/arclight.log`) |
| Rotation | At 10 MB, five old files kept: `arclight.log.1` to `arclight.log.5` |
| Live buffer | The most recent 5000 entries in memory |
| Container output | Also written to the container's standard output: `docker logs <container-name>` |

Levels, from most to least detailed: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. The default is `info`. To change it, set the environment variable `ARCLIGHT_LOG_LEVEL` (for example `debug`) and restart. Use `debug` only while hunting a problem; it is noisy.

## Debugging

System > Debugging collects the numbers you need when Arclight misbehaves, as text you can copy and paste. Admins only.

- **Copy debug report** (top right): runs the `report` command and copies the result. This is the thing to paste into a bug report or support thread. It contains the version, memory, active handles, torrent engine and VPN status and the last 100 log lines, with API keys, passwords, tokens and VPN keys masked and the VPN public IP left out.
- **Live snapshot**: refreshes every 5 seconds (switch it off to freeze the numbers). Process memory, memory against the container limit when Arclight runs in a container with one, JavaScript heap, event-loop lag, active handles, and one line each for the torrent engine and the VPN. **Copy** puts the snapshot on the clipboard as plain text.
- **Console**: paste or type commands, one per line, and press **Run** (or Ctrl+Enter / Cmd+Enter). Each command gets its own result block with its own **Copy** button; **Copy all** copies the whole run. Lines starting with `#` are ignored, so a pasted block can carry comments. Up arrow at the start of an empty box brings back earlier runs.
- **Logs**: the last 200 log lines with a level and text filter, **Copy** for the visible lines and **Download .txt**.

Copy also works when you open Arclight over plain `http://` on your network, where browsers normally block clipboard access.

The console is not a shell. It only knows these built-in, read-only commands; anything else answers "Unknown command".

| Command | What it shows |
|---|---|
| `help` | The command list |
| `report` | `version`, `memory`, `handles`, `engine`, `vpn` and `logs 100` in one block |
| `memory` | Process memory (rss, heap, external, ArrayBuffers), V8 heap limits, container limit and usage (cgroup v1 or v2), event-loop lag |
| `buffers` | After a garbage collection: how many ArrayBuffers are still alive, their total size, size buckets and the 15 biggest groups (size and first bytes). Useful when memory keeps growing |
| `gc` | Forces a garbage collection and shows memory before and after |
| `handles` | Open sockets, servers and timers by type, with the bytes waiting to be written |
| `engine` | Built-in torrent engine: state, listen port, torrents by state, peers, speeds, warnings, VPN binding |
| `vpn` | VPN provider, connected or not, public IP, forwarded port, last check, last error, kill switch |
| `logs [n] [text]` | The last `n` log lines (default 50, at most 500), only those containing `text` if given |
| `ping <url>` | An HTTP GET from the Arclight server (10 second timeout): status code and time, never the page body. For "can Arclight reach my Sonarr, Gluetun or Jellyfin?" |
| `dns <host>` | Resolves a host name from the Arclight server, for example a container name |
| `version` | Version, Node.js, platform, uptime |

At most 20 commands and 1 MB of output per run. Commands are not case sensitive.

## Backups

System > Backups creates, downloads and restores backups and sets the schedule. All of it is explained in [backup-restore.md](../getting-started/backup-restore.md).

## Health

System > Health runs checks and tells you what needs fixing. "Run checks" refreshes them now (they also run every 5 minutes). Each warning has a "How to fix" link to a page that explains the cause and the fix; those pages are also available in the app as System > Health docs. When all is well it says "Every health check passes."

The most common ones are covered in [Troubleshooting](../TROUBLESHOOTING.md), for example [VPN disconnected](../TROUBLESHOOTING.md#vpn-disconnected), [Empty root folder](../TROUBLESHOOTING.md#empty-root-folder) and [Update available](../TROUBLESHOOTING.md#update-available).

## Import

System > Import ("Import your existing stack") is a wizard that brings settings, libraries, history, users and running torrents over from Sonarr, Radarr, Prowlarr, Bazarr, Overseerr / Jellyseerr and qBittorrent, through their live API or their files. It starts with a dry run, takes a backup before a real run, runs as the `MigrateStack` task (System > Tasks) and can be resumed if it fails. Administrators only. See [migrating.md](../getting-started/migrating.md).

## Updates

System > Updates shows whether a new version exists and lets you update the containers if you enabled it. Options are on Settings > Updates. See [updating.md](../getting-started/updating.md).

## Stats

System > Stats is a read-only dashboard about your library:

- Library counts (series, episodes, files, movies, continuing and ended series)
- Library size over time, with the 30 and 90 day change
- Storage: free space on each root folder ("{size} free of {size}")
- Breakdowns by quality, resolution, video codec and dynamic range
- Largest series and largest movies
- Activity over the last days: grabbed, imported and failed
- Indexer stats

Stats are snapshotted once a day (task `StatsSnapshot`), so the size trend starts empty on a new install.

## Feeds

System > Feeds lists the data feeds Arclight downloads in the background (indexer definition updates, quality guides, scene mappings and similar). Each row shows the feed, its state, interval, last sync, last success and pending items.

A feed turns "Stale" when it has not synced for three intervals. The "Fix" link opens "Why {name} is stale" and "What to do". The health check "Feed stale" fires for the same reason.

## Audit

System > Audit lists who changed what ("Every change made through the api, and every sign-in"). Filter by user name or id, action and date range, and use "Export CSV" to save the list. Two settings on the page: "Record changes" and "Kept for" (days; 0 keeps everything, default 90). Only administrators can see it. More in [users-and-security.md](users-and-security.md#audit-log).

## Metrics endpoint and Grafana

Arclight exposes Prometheus metrics at `/metrics` on the server root (for example `http://<your-host>:7878/metrics`). Examples of what it reports:

| Metric | What it is |
|---|---|
| `arclight_info` | Version information |
| `arclight_http_requests_total` | Requests handled |
| `arclight_queue_items` | Items in the download queue |
| `arclight_torrent_*` | Torrent engine counters (speeds, torrents, peers) |
| `arclight_vpn_connected` | 1 when the VPN is up |

How to authenticate when scraping: send the API key as `X-Api-Key`, as `?apikey=`, with HTTP Basic, or with a session cookie. If you prefer no credentials, turn on "Allow /metrics without credentials" under Settings > General in the "Metrics" row (only on a trusted network).

A ready-made Grafana dashboard is in the repository: [grafana-dashboard.json](../grafana-dashboard.json). In Grafana choose Dashboards > Import, upload the file and pick your Prometheus data source. The full metric list and a Prometheus scrape example are in [OPERATIONS.md](../OPERATIONS.md).

## Config as code

Settings > General has a "Config as code" pane. It exports your settings to a YAML or JSON file and imports them again, which is handy for rebuilding a machine or keeping your setup in version control.

| Action | What it does |
|---|---|
| Export (YAML or JSON) | Downloads your settings. Secrets are masked as `********` unless you tick "Include secrets" |
| Import file, then "Preview changes" | Shows what would change without changing anything |
| "Apply changes" | Applies the file. It is all or nothing: if anything is invalid, nothing is applied. Items are matched by name and settings are merged |
| "Delete what the document does not list" | Off by default. Turn it on only if you want items missing from the file to be removed |

### Managed mode

If you set the environment variable `ARCLIGHT_CONFIG_FILE` (for example `/config/arclight.yml`), Arclight applies that file every time it starts. For the keys in that file the file wins over anything edited in the UI. The pane lists "Managed keys" and "Config file errors", so you can see what is locked.

Individual settings can also be forced with environment variables named `ARCLIGHT_SETTING__<section>__<key>`. Order of precedence: UI/database lowest, then the config file, then environment variables.

The export and import also work over the API (`/api/v1/config/export`, `/api/v1/config/import`). Everything in detail is in [OPERATIONS.md](../OPERATIONS.md).

## Related

- [Back up and restore](../getting-started/backup-restore.md)
- [Updating Arclight](../getting-started/updating.md)
- [Migrating](../getting-started/migrating.md)
- [Users and security](users-and-security.md)
- [Troubleshooting](../TROUBLESHOOTING.md)
- [Operations guide](../OPERATIONS.md)

# Import your existing stack

If you already run Sonarr, Radarr, Prowlarr, Bazarr, Overseerr or Jellyseerr, and qBittorrent, the import wizard brings your settings, library, history, users and even your running torrents into Arclight. This page walks through the whole wizard, says what comes over and what does not, and explains how to run it safely.

The wizard is at System > Import, titled "Import your existing stack". It is also offered at the end of the first-run setup. Only administrators can use it.

## Who this is for

You are switching from the older apps and want to keep your library, profiles, indexers, requests and seeding torrents. If you are starting fresh, skip this page.

The old apps are only read. The import never changes them and never deletes anything in Arclight. The one exception is the optional clean-up of qBittorrent at the very end, which you must confirm ([see below](#optional-tidy-up-of-qbittorrent)).

## Before you start

1. **Back up the old apps.** Copy each app's config folder somewhere safe. This is your way back if you change your mind.
2. **Decide whether the old apps keep running.** Running apps are best read through their API, so leave them running for that. For the Files option, stop the app (or copy a backup of its database) so the file is not changing while it is read.
3. **Use one shared data folder.** The recommended layout is one share mounted at `/data` in every container: `/data/downloads`, `/data/media/tv` and `/data/media/movies`. When Sonarr, Radarr, qBittorrent and Arclight all see the same paths, nothing has to be translated and no path mapping is needed. See [folders-and-hardlinks.md](folders-and-hardlinks.md).
4. **Finish Arclight's first-run setup**, including a TMDB key. Series and movies are matched by their TMDB id.
5. **Turn on the built-in torrent engine** (Settings > Torrent engine) if you want to adopt qBittorrent torrents into it.

## API or files

Each app can be read in one of two ways. You choose per app.

| | Live API | Files |
|---|---|---|
| Use it when | The app is running | The app is stopped or gone |
| Arclight needs | The base URL (including any URL base) and the API key. For qBittorrent: the WebUI URL, plus username and password | The path of the database file inside the Arclight container, and optionally the config file. For qBittorrent: the `BT_backup` folder |
| Secrets | Recent Sonarr, Radarr, Prowlarr and Bazarr hide passwords and API keys over the API (they show `********`). Those items come over without the secret, and the preview lists which fields you must re-enter | Secrets are carried over |
| Bazarr history | The API may give only relative dates such as "3 days ago". Those entries are skipped | Kept |
| qBittorrent | Needs qBittorrent 4.5 or newer to export `.torrent` files. Can pause or remove adopted torrents at the end | Works with any version. You must stop qBittorrent first |

If you have API keys that must come over, use Files for that app. If the app is still running and you do not mind re-entering a few passwords, use the API.

## Mount the old config folders (Files mode)

Arclight can only read what is mounted into its container. Add read-only mounts for the old config folders to the Arclight service in your compose file:

```yaml
services:
  arclight:
    volumes:
      - /path/to/appdata/sonarr:/import/sonarr:ro
      - /path/to/appdata/radarr:/import/radarr:ro
      - /path/to/appdata/prowlarr:/import/prowlarr:ro
      - /path/to/appdata/bazarr:/import/bazarr:ro
      - /path/to/appdata/jellyseerr:/import/jellyseerr:ro
      - /path/to/appdata/qbittorrent:/import/qbittorrent:ro
```

Then recreate the container (`docker compose up -d`).

Arclight looks in `/config`, `/import`, `/migrate`, `/mnt/import`, any folders listed in the `ARCLIGHT_MIGRATE_DIRS` environment variable, and app-named subfolders. What it finds is shown as "Detected" candidates you can click. On a native Windows or Linux install it also checks the usual locations of the old apps.

| App | File to point at | Optional config file |
|---|---|---|
| Sonarr | `sonarr.db` | `config.xml` next to it |
| Radarr | `radarr.db` | `config.xml` next to it |
| Prowlarr | `prowlarr.db` | `config.xml` (needed for indexers that keep going through Prowlarr) |
| Bazarr | `db/bazarr.db` | `config/config.yaml` or `config.ini` (needed for providers and their logins) |
| Overseerr / Jellyseerr | `db/db.sqlite3` | `settings.json` (needed for default permissions and quotas) |
| qBittorrent | The `BT_backup` folder, for example `/import/qbittorrent/qBittorrent/BT_backup` (the qBittorrent config folder that contains it also works) | |

## Where to find the API keys (API mode)

| App | Where |
|---|---|
| Sonarr, Radarr, Prowlarr | Settings > General > Security > API Key |
| Bazarr | Settings > General > Security > API Key |
| Overseerr / Jellyseerr | Settings > General > API Key |
| qBittorrent | No key. Use the WebUI username and password, or leave both empty if the WebUI skips authentication for Arclight's address |

The URL must start with `http://` or `https://`, and must be an address Arclight can reach from inside its container. On a shared Docker network use the container name, for example `http://sonarr:8989`. Include any URL base (for example `http://host:8989/sonarr`). If qBittorrent shares a VPN container's network, its WebUI is on that container (for example `http://gluetun:8080`).

## The wizard, step by step

The steps are Apps, Connect, Preview, Options, Run and Report.

### 1. Apps

"Which apps do you have?" Tick every app you run today. Use "Add another ..." for a second instance, for example a separate Sonarr for 4K, and give it a name such as "Sonarr 4K".

### 2. Connect

For each app choose "Live API" or "Files" and fill in the fields.

- **Suggestions.** On a Docker network Arclight tries the usual container names and ports (`sonarr:8989`, `radarr:7878`, `prowlarr:9696`, `bazarr:6767`, `overseerr`, `jellyseerr` or `seerr` on `5055`, `qbittorrent` or `gluetun` on `8080`). It only checks that the name resolves and the port accepts a connection, and lists the result under "Suggestions". You still enter the key and test. "Use ..." fills in the URL.
- **Test.** Press "Test ..." for each app. It reads the app's status (or the database's tables) and shows "Connected" with the version, or "Not connected" with the reason. If you pointed at the wrong app, it says which app it found.
- **Path mappings.** Open "Path mappings" only if the old app saw your folders under other paths than Arclight does, for example `/tv` to `/data/media/tv`. The longest matching prefix wins, and slashes and backslashes are treated alike. With the same `/data` share everywhere you need none.

Press "Next" when every app is connected.

### 3. Preview

Arclight reads every app (a large library through the API can take a minute) and shows a table per source. Nothing is written yet.

| Column | Meaning |
|---|---|
| Found | Items in the old app |
| New | Items Arclight will create |
| Conflicts | Items Arclight already has |
| Already imported | Items from an earlier import |
| Can't import | Items with no equivalent, with the reason |

Below the tables are warnings (for example secrets that must be re-entered), the list of conflicts ("Already in Arclight") and the reasons for "Can't be imported". Untick an area ("Include ...") to leave it out. "Read again" refreshes the preview.

Choose what happens "When an item already exists", as a default and per area:

| Policy | Effect |
|---|---|
| Skip: keep what Arclight has | The existing item is left alone |
| Overwrite: use the imported settings | The existing item's settings are replaced by the imported ones |
| Merge: keep Arclight's settings, add what is missing | Adds what is missing, such as episodes, files or links. Areas without a merge rule behave like Skip |

Nothing is ever deleted, whichever you choose.

When Prowlarr is part of the stack, the indexers it pushed into Sonarr and Radarr are not imported twice. They come from Prowlarr itself.

### 4. Options

| Option | Default | Notes |
|---|---|---|
| Dry run | On | Checks everything against Arclight inside a transaction that is rolled back. Later sources see what earlier ones would create. Torrents are only checked, never added |
| Back up Arclight first | On | A real run takes an Arclight backup before writing anything. A dry run writes nothing, so it takes none |
| qBittorrent verify mode | Recheck | See [How adoption works](#how-adoption-works) |
| Pause each torrent in qBittorrent before adopting it | Off | Needs a confirmation. See [Pausing and seeding](#pausing-and-seeding) |

Start with a dry run. Press "Start dry run" (or "Start import" for a real run).

### 5. Run

The import runs in the background as the `MigrateStack` task (System > Tasks). The page shows progress and a log, and you can leave and come back. Only one import runs at a time. The order is Prowlarr, Sonarr, Radarr, qBittorrent, Bazarr, then Overseerr or Jellyseerr.

### 6. Report

The report shows per app what was created, updated, skipped, linked or failed, with reasons. "Download report (JSON)" saves it with secrets masked. After a dry run, "Run for real" starts the real import with the same choices. To run for real after reopening the page, connect the apps again, because API keys and passwords are not kept in the browser.

## What each app brings over

### Sonarr and Radarr

| Area | Notes |
|---|---|
| Series (Sonarr), movies (Radarr) | With monitored state; Sonarr also seasons and episodes |
| Existing files | Attached where they are. Files are never copied or moved |
| Root folders, tags | |
| Quality profiles | With cutoff |
| Custom formats | With scores |
| Release profiles, delay profiles | |
| Naming, media management | |
| History | Grabs and imports |
| Blocklist | |
| Download clients | |
| Indexers | With their download-client link |
| Import lists | |
| Notifications | |
| Remote path mappings | |

Cannot come over:

- Sonarr v3 language profiles.
- The preferred terms of release profiles.
- A delay profile that disables a protocol is imported with a warning.
- Indexers that are not Torznab or Newznab.
- Download client and notification types Arclight does not have.
- Trakt lists import but must be authorised again.
- Naming tokens Arclight lacks are dropped.
- Series and movies without a TMDB id.
- Radarr collections are staged, not applied.

### Prowlarr

| Area | Notes |
|---|---|
| Indexers | Matched to Arclight's own indexer definitions (built-in and community catalogue), with credentials, cookies and settings, priorities, tags and seed settings |
| Torznab and Newznab entries | Imported directly |
| Indexer proxies | FlareSolverr, HTTP and SOCKS5. SOCKS4 is not supported |

An indexer Arclight has no definition for is reached through Prowlarr's own per-indexer endpoint, so Prowlarr must keep running for it. Prowlarr's Applications (app sync) are ignored.

### Bazarr

| Area | Notes |
|---|---|
| Language profiles | |
| Profile assignment | Per series and per movie, plus the default profiles |
| Providers | With credentials. Unsupported providers are listed |
| Subtitle history and blacklist | |
| Existing subtitle files | Files on disk are associated with the media files |

Cannot come over: tag-based profile auto-assignment and the audio-exclude flag. OpenSubtitles.com needs your own consumer API key.

### Overseerr and Jellyseerr

| Area | Notes |
|---|---|
| Users | Matched by media-server identity (Plex, Jellyfin or Emby account), then email, then username |
| Permissions, quotas | Same permission bit values |
| Requests | With status, 4K flag, seasons, requester and dates |
| Issues | With comments |
| Request settings | Default permissions and quotas, partial requests and similar |
| Discover sliders, override rules | |

Things to know:

- New users get the media-server link, so they sign in with their Jellyfin, Emby or Plex account. No password is copied, and local password login stays disabled until an admin sets one.
- The import never creates an Arclight administrator. A Seerr admin becomes a user with request and issue management permissions. Promote them yourself afterwards.
- Requests for titles not in your library keep a placeholder title such as "TMDB 12345".
- Seerr notification agents are not imported.

## Adopting qBittorrent torrents

### What you get

The wizard lists every torrent in qBittorrent with its category, tags, save path, limits, dates, totals and state. For each category ("qBittorrent categories") choose one action:

| Action | Effect |
|---|---|
| Adopt into the built-in engine (default) | The built-in engine takes over the torrent with the files where they are |
| Keep in qBittorrent (external client) | Arclight adds, or reuses, a qBittorrent download client for the category and leaves the torrents in qBittorrent. Torrents with no category are left alone |
| Skip | Nothing is done |

### How adoption works

- The built-in engine must be enabled. The `.torrent` file comes from qBittorrent's export API (qBittorrent 4.5 or newer) or, in Files mode, from `BT_backup`.
- Save paths are mapped. With the same `/data` share there is nothing to map.
- Before adding anything Arclight checks that the files exist at the mapped path. A torrent with missing or renamed files, files of the wrong size, or unfinished `.!qB` files is refused with the reason. Nothing is added and nothing re-downloads. The same goes for a partly downloaded torrent whose data cannot be found at all.
- Version 2 only torrents cannot be adopted yet and stay in qBittorrent.
- Torrents already in the engine are linked, not duplicated.
- Torrents that match a Sonarr or Radarr grab (by info-hash) get a tracked download, so imports and seeding rules keep working.
- Data is never moved or deleted.

Verify mode ("Checking existing torrent data"):

| Mode | What happens |
|---|---|
| Recheck every piece (safe), the default | The engine hashes the existing data once. Complete torrents come up seeding. Partial ones download only the missing pieces |
| Trust complete torrents (fast) | A torrent qBittorrent reports complete, whose files all exist with the right sizes, is taken as complete without hashing. Anything else is rechecked |

### Hit-and-run safety

These carry over: uploaded and downloaded totals, seeding and active time, added and completed dates, category, tags, file priorities, and ratio and seed-time limits. Limits are never lowered. A torrent set to "use global" gets qBittorrent's global limit if that was enabled, otherwise no limit. Private-tracker rules therefore keep counting from where they were.

### Pausing and seeding

Only one client may seed and write a torrent at a time.

- **Default.** Adopted torrents are added paused in Arclight. Stop qBittorrent (or its torrents), then resume them in Arclight.
- **Pause step.** Tick "Pause each torrent in qBittorrent before adopting it" and the confirmation ("I confirm: Arclight may pause these torrents in qBittorrent ..."). Arclight pauses each torrent in qBittorrent and the adopted one keeps its previous running state. In Files mode the confirmation is "I confirm qBittorrent is stopped and will not be started again with these torrents".

### Check that nothing re-downloads

- The torrent's line in the report says "verified 100%, seeding" or "verified X%, downloads only the rest".
- On the torrent engine page, the downloaded total equals qBittorrent's old total and progress is 100% right away for complete torrents.
- Disk activity during the check is reading (hashing), not writing.
- Better still, do a dry run first. It checks the files without adding anything.

### Optional tidy-up of qBittorrent

On the report, "Optional: tidy up qBittorrent" (API mode only) can pause the adopted torrents in qBittorrent ("Pause in qBittorrent") or remove them from qBittorrent while keeping every file ("Remove from qBittorrent (keep files)"). Each asks for confirmation first, and Arclight keeps seeding.

## Dry run, backup and rollback

- A dry run changes nothing. It is the best way to see conflicts and unsupported items.
- A real run takes an Arclight backup first. Its name is shown on the page and in the report.
- To undo an import, restore that backup from System > Backups. See [backup-restore.md](backup-restore.md).
- Restoring does not touch qBittorrent. If you used the pause step, resume those torrents in qBittorrent yourself.

## Resuming and re-running

A real run that failed or was interrupted (for example Arclight restarted) can be continued with "Resume". Completed sources are kept and everything already imported is skipped. Running the import again never duplicates anything, so it is safe to repeat after fixing a problem or after the old app has changed.

## After the import

1. Check System > Health.
2. Settings > Indexers and Settings > Download Clients: press the test buttons, and re-enter the passwords and API keys the preview listed.
3. Re-authorise any Trakt lists.
4. Look at the Library. Counts and paths should match the old apps. Rescan if something looks missing.
5. Resume adopted torrents once qBittorrent has let go of them, if you did not use the pause step.
6. Set a password for imported users who need local login, or let them sign in with their media-server account.
7. Keep Prowlarr running if any indexer needs it.
8. Set up anything marked staged or not importable by hand.
9. When you are happy, stop the old apps.

## Running old and new side by side

You can run both for a while, but only one of them should search and grab. Turn off RSS, automatic search and downloading in one of the two (usually the old apps), or both will grab the same releases. Give Arclight another host port if the old app uses 7878. Only one client should seed a torrent at a time.

## Related

- [Back up and restore](backup-restore.md)
- [Folders and hardlinks](folders-and-hardlinks.md)
- [Indexers](../using/indexers.md)
- [Download clients](../using/download-clients.md)
- [Subtitles](../using/subtitles.md)
- [Discover and requests](../using/discover-and-requests.md)
- [System pages](../using/system.md)
- [Import blocked or failed](../TROUBLESHOOTING.md#import-blocked-or-failed)
- [Import wizard problems](../TROUBLESHOOTING.md#import-wizard-problems)

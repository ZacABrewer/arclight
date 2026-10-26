# Back up and restore

Arclight keeps everything it knows (your library, settings, history, users, indexers, quality profiles) in one config folder. This page explains the built-in backups under System > Backups, what is inside one, how to restore it, and how to move Arclight to a new machine. Everyone should set this up once and check that it works.

Your media files are not part of a backup. Back those up separately.

## What System > Backups does

Open System > Backups. You can:

- Create a backup now ("Create backup").
- Download, restore or delete any backup in the list.
- Restore from a file you uploaded ("Restore from file").
- Change the schedule and retention ("Backup settings").

Backups are zip files named like `arclight_scheduled_2026.10.26_04.00.00.zip`. The middle word is the type (shown in the list as "Scheduled", "Manual" or "Before update"), and the timestamp in the name is UTC.

## What is inside a backup

| Item | What it is |
|---|---|
| `arclight.db` | A consistent snapshot of the database (library, history, settings, users, everything) |
| `settings.json` | A readable export of your settings |
| `manifest.json` | App name, version and database version, used to check the backup on restore |
| `config/...` | Other files from the config folder, such as indexer definitions |

Left out on purpose: log files, the backup folder itself, hidden files, cache folders, temporary and partial files (`*.log`, `*.tmp`, `*.partial`), and any single file over 100 MB.

A backup does contain secrets (your API key, indexer keys, password hashes). Treat the zip files like passwords and do not share them.

## Schedule and retention

Settings in "Backup settings" on System > Backups:

| Setting | Default | What it does |
|---|---|---|
| Folder | Empty (`<config>/backups`) | Where backups are stored. Must be an absolute path as the container sees it. |
| Interval (days) | 1 | How often a scheduled backup is made. 0 turns scheduled backups off. Range 0 to 365. |
| Hour of day | 4 | The hour (0 to 23, local time) when the scheduled backup runs. |
| Keep at most | 7 | Keep at most this many scheduled backups. 0 means no limit. |
| Keep for (days) | 28 | Delete scheduled backups older than this. 0 means no limit. |

Retention only removes scheduled backups. Backups you create by hand are never deleted automatically.

A background task named Backup checks every hour whether a backup is due (see System > Tasks).

In Docker, if you set a custom folder, make sure it is on a mount that survives the container being recreated, ideally on a different disk from the config. The default folder sits inside the config volume, which is fine as a start but is lost together with the config if that disk fails. Copy backups somewhere else now and then.

## Make a backup by hand

1. Go to System > Backups.
2. Click "Create backup".
3. When it appears in the list, click Download to keep a copy outside the machine.

Do this before every update ([updating.md](updating.md)) and before big changes.

## Restore in the UI

1. Go to System > Backups.
2. For a backup in the list, click Restore. For a file you have saved elsewhere, click "Restore from file" and choose the zip (up to 4 GiB).
3. Read the confirmation: the backup replaces the current database and config files. A copy of the current database is kept as `arclight.db.pre-restore` in the config folder.
4. Confirm. When it finishes, a banner says "Restart required. A backup was restored; restart Arclight to load it."
5. Click "Restart now", or restart the container yourself (`docker compose restart arclight`).

Restore has safety checks. It refuses a backup that:

- Is not an Arclight backup (older Media-Tron backups are still accepted).
- Has a damaged database.
- Came from a newer Arclight than the one you are running. Update Arclight first, then restore.

Restore needs an administrator account.

## Restore by hand

Use this if Arclight does not start, or you cannot log in.

1. Stop Arclight.
2. Open the backup zip with any unzip tool.
3. In your config folder (`/config` in Docker, mapped to `<CONFIG_ROOT>/arclight` on the host in the shipped compose files), rename `arclight.db` to `arclight.db.old`. Also delete `arclight.db-wal` and `arclight.db-shm` if they exist.
4. Copy `arclight.db` from the zip into the config folder.
5. Copy the contents of the zip's `config/` folder over the config folder if you want the other files back too.
6. Make sure the files belong to the same user as before (the `PUID` and `PGID` from your `.env`).
7. Start Arclight.

## Move to a new machine

1. On the old machine: create a backup and download it (or stop Arclight and copy the whole config folder).
2. Set up Arclight on the new machine (start from [install-docker.md](install-docker.md) or the page for your platform) with the same version if possible. Use the same container paths for your media (the single `/data` mount, with `/data/media/tv`, `/data/media/movies` and `/data/downloads`), so the library paths in the database still match. If the paths change, see [folders-and-hardlinks.md](folders-and-hardlinks.md#moving-an-existing-library).
3. Start it once, then stop it if you are restoring files by hand; or complete the setup wizard with any account and use "Restore from file" in System > Backups.
4. Restart and sign in with your old account.
5. Open System > Health and fix anything that points at paths or VPN settings that differ on the new machine. VPN keys and port forwarding are machine-specific.

Torrent data: if you used the built-in engine, resume data lives in the `torrents` folder inside the config folder. Copy it along with the downloaded files if you want seeding to continue; otherwise the engine will have to recheck.

## Start over

To reset Arclight completely: stop it, move `arclight.db` out of the config folder (and the `torrents` folder if you used the built-in engine), and start it. You get the setup wizard again. Your media files are untouched.

## Config as code (an alternative)

Settings can also be exported to a YAML or JSON file and imported later. This is not a full backup (no history, no library), but it is handy for rebuilding. See [System pages](../using/system.md#config-as-code).

## Related

- [Updating Arclight](updating.md)
- [Moving from Sonarr, Radarr and others](migrating.md)
- [System pages](../using/system.md)
- [Operations guide](../OPERATIONS.md)
- [Locked out](../TROUBLESHOOTING.md#locked-out)

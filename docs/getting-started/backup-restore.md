# Back up and restore

Arclight keeps everything it knows (your library, settings, history, users, indexers, quality profiles) in one config folder. This page explains the built-in backups under System > Backups, what is inside one, how to restore it, and how to move Arclight to a new machine. Everyone should set this up once and check that it works.

Your media files are not part of a backup. Back those up separately.

## What System > Backups does

Open System > Backups. You can:

- Create a backup now ("Create backup").
- Download, restore or delete any backup in the list.
- Restore from a file you uploaded ("Restore from file").
- Change the schedule and retention ("Backup settings").

Backups are zip files named like `arclight_scheduled_2026.10.26_04.00.00.zip`. The middle word is the type (shown in the list as "Scheduled", "Manual" or "Before update"), and the timestamp in the name is UTC. Encrypted backups (see [Encrypted backups](#encrypted-backups)) end in `.zip.enc` and are marked "Encrypted" in the list.

## What is inside a backup

| Item | What it is |
|---|---|
| `arclight.db` | A consistent snapshot of the database (library, history, settings, users, everything) |
| `settings.json` | A readable export of your settings |
| `manifest.json` | App name, version and database version, used to check the backup on restore |
| `config/...` | Other files from the config folder, such as indexer definitions and `secrets.key` |

Left out on purpose: log files, the backup folder itself, hidden files, cache folders, temporary and partial files (`*.log`, `*.tmp`, `*.partial`), and any single file over 100 MB.

A backup does contain secrets (your API key, indexer keys, password hashes). Treat the zip files like passwords and do not share them. Since 0.24 the stored secrets are sealed in the database (see [Secrets at rest](#secrets-at-rest)), but an unencrypted backup also holds the `secrets.key` that opens them, so anyone with the zip can still read them. Set a backup passphrase if backups leave the machine or sit on a shared folder.

A backup starts from a database snapshot that still holds every secret. Arclight writes that snapshot in the config folder, as a hidden `.snapshot-*.db` file it deletes right away. It never goes in the backup folder.

Paired phones (the [mobile app](../using/mobile-app.md)) are left out of the database snapshot, because each holds a per-phone push relay secret. After a restore, turn **Notifications on this device** off and on again in the app.

## Schedule and retention

Settings in "Backup settings" on System > Backups:

| Setting | Default | What it does |
|---|---|---|
| Folder | Empty (`<config>/backups`) | Where backups are stored. Must be an absolute path as the container sees it. |
| Interval (days) | 1 | How often a scheduled backup is made. 0 turns scheduled backups off. Range 0 to 365. |
| Hour of day | 4 | The hour (0 to 23, local time) when the scheduled backup runs. |
| Keep at most | 7 | Keep at most this many scheduled backups. 0 means no limit. |
| Keep for (days) | 28 | Delete scheduled backups older than this. 0 means no limit. |
| Backup passphrase | Empty | Encrypts new backups with this passphrase (at least 8 characters). Empty means not encrypted. See [Encrypted backups](#encrypted-backups). |

Retention only removes scheduled backups. Backups you create by hand are never deleted automatically.

A background task named Backup checks every hour whether a backup is due (see System > Tasks).

In Docker, if you set a custom folder, make sure it is on a mount that survives the container being recreated, ideally on a different disk from the config. The default folder sits inside the config volume, which is fine as a start but is lost together with the config if that disk fails. Copy backups somewhere else now and then.

When the folder is outside the config folder, Arclight logs a warning, because that folder is often a share other accounts can read. Without a backup passphrase the warning says the backups there are not encrypted.

### File permissions

Backups, the database (with its `-wal` and `-shm` files), logs, `secrets.key` and `arclight.db.pre-restore` are owner-only: files `0600`, folders `0700`. Arclight sets this on every start, so files from older versions are fixed too. Your media and download folders are not changed: those stay readable by the other apps that share them through `PUID`/`PGID`.

If a sync or backup tool copies the backup folder, run it as the same user as Arclight (the `PUID` from your `.env`) or as root, or it cannot read the files.

## Encrypted backups

Set a backup passphrase under System > Backups > Settings to encrypt every new backup. The whole zip is encrypted with AES-256-GCM, using a key made from the passphrase with scrypt. If an encrypted file has been changed, the restore detects it.

- Arclight stores the passphrase, sealed like the other secrets, so that scheduled backups work. The settings page shows it masked. Leave the mask to keep it, or clear the field to stop encrypting.
- Restoring one of your own backups uses the stored passphrase. If it does not fit (you changed it since, or this is another install), the restore dialog asks for it. "Restore from file" with a `.zip.enc` file asks right away.
- Older and unencrypted backups restore as before.
- Arclight cannot recover a forgotten passphrase. Keep it in your password manager.
- An encrypted backup can only be opened through the restore in the UI of Arclight 0.24 or newer, for example in a fresh container. There is no separate tool.

## Secrets at rest

Since 0.24, Arclight seals stored secrets in the database with AES-256-GCM. This covers:

- the API key and two-factor secrets
- the OIDC client secret, the Discord bot token and the push keys
- indexer, download client, notification and VPN credentials
- the calendar feed token and the backup passphrase

The key is in `secrets.key` in the config folder (mode `0600`). Sealing protects a copy of the database on its own, such as an old snapshot or a database file shared for debugging. It does not protect against someone who can read the whole config folder.

- Upgrading: secrets saved by older versions keep working. The first start of 0.24 seals them, and there is nothing to do.
- Restoring on the same install: works as before.
- Restoring on a new install: every backup carries its `secrets.key`. A restore adds that key to the new install's key file, so the restored secrets open. The new install keeps its own key for new values.
- If `secrets.key` is lost (for example, you restored only `arclight.db` by hand without the `config/` files), the sealed secrets read as empty, with a log warning for each.
  - Arclight replaces the API key with a new one, and you stay set up.
  - Enter the other credentials again, or put the old `secrets.key` back and restart.
- Downgrading to a version before 0.24: older versions cannot read sealed values.
  1. Start 0.24 once with the environment variable `ARCLIGHT_SECRETS_AT_REST=0`. This writes the secrets back in the clear and stops sealing new ones.
  2. Downgrade.

If you copy the config folder yourself, back up `secrets.key` along with the database.

## Make a backup by hand

1. Go to System > Backups.
2. Click "Create backup".
3. When it appears in the list, click Download to keep a copy outside the machine.

Do this before every update ([updating.md](updating.md)) and before big changes.

## Restore in the UI

1. Go to System > Backups.
2. For a backup in the list, click Restore. For a file you have saved elsewhere, click "Restore from file" and choose the zip or `.zip.enc` file (up to 4 GiB). For an encrypted backup, enter its passphrase when asked.
3. Read the confirmation: the backup replaces the current database and config files. A copy of the current database is kept as `arclight.db.pre-restore` in the config folder.
4. Confirm. When it finishes, a banner says "Restart required. A backup was restored; restart Arclight to load it."
5. Click "Restart now", or restart the container yourself (`docker compose restart arclight`).

Restore has safety checks. It refuses a backup that:

- Is not an Arclight backup (older Media-Tron backups are still accepted).
- Has a damaged database.
- Came from a newer Arclight than the one you are running. Update Arclight first, then restore.
- Has a database with triggers, views or tables Arclight never creates.
- Is encrypted and the passphrase is wrong, or the encrypted file was changed.

Restore needs an administrator account.

## Restore by hand

Use this if Arclight does not start, or you cannot log in. It works for unencrypted backups only: an encrypted `.zip.enc` file must be restored through the UI.

1. Stop Arclight.
2. Open the backup zip with any unzip tool.
3. In your config folder (`/config` in Docker, mapped to `<CONFIG_ROOT>/arclight` on the host in the shipped compose files), rename `arclight.db` to `arclight.db.old`. Also delete `arclight.db-wal` and `arclight.db-shm` if they exist.
4. Copy `arclight.db` from the zip into the config folder.
5. Copy the contents of the zip's `config/` folder over the config folder if you want the other files back too. Keep the zip's `secrets.key`: with a different key file in the config folder the restored secrets cannot be opened (see [Secrets at rest](#secrets-at-rest)). If the config folder already holds a different key file, restore through the UI instead, which merges the keys.
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

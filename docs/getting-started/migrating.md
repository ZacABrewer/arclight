# Moving from Sonarr, Radarr, Prowlarr, Bazarr and Overseerr

If you already run the older apps, Arclight can read their databases and bring your settings and library across. This page explains how System > Import works, what it does and does not bring over, and how to run it safely. It is for people switching over; if you are starting fresh, skip it.

The import is read-only on the old app. It opens the old app's database file, never changes it, and never deletes anything in Arclight.

## What you need

- The old app's database file. Keep the old app stopped while you copy it, or copy a backup of it, so the file is not changing.
- Optionally the old app's config file (it adds extra details, such as the API key Prowlarr indexers use).
- An Arclight administrator account.

| App | Database file | Optional config file |
|---|---|---|
| Sonarr | `sonarr.db` | `config.xml` |
| Radarr | `radarr.db` | `config.xml` |
| Prowlarr | `prowlarr.db` | `config.xml` |
| Bazarr | `db/bazarr.db` | `config/config.yaml` (or an `.ini`) |
| Overseerr / Jellyseerr | `db/db.sqlite3` | `settings.json` |

In the page these appear as Sonarr, Radarr, Prowlarr, Bazarr and "Overseerr / Jellyseerr".

## Make the files visible to Arclight

In Docker, Arclight can only read what is mounted into its container. The easiest way:

1. Copy the old app's config folder to a safe place on the host, for example `/path/to/import/sonarr`.
2. Add a read-only mount to the Arclight service in your compose file:

   ```yaml
   - /path/to/import:/import:ro
   ```

3. Recreate the container (`docker compose up -d`).

Arclight looks in `/config`, `/import`, `/migrate`, `/mnt/import` and any extra folders listed in the `ARCLIGHT_MIGRATE_DIRS` environment variable, plus folders named after the app. Anything it finds appears under "Detected installations" on the page. On a native Windows or Linux install it also checks the usual locations of the old apps (for example `C:\ProgramData` and `/var/lib/<app>`).

## Steps

1. Open System > Import. The page is titled "Import from existing apps".
2. Choose the "Application".
3. Pick one of the "Detected installations", or type the "Database path" (and, if you have it, the "Config file (optional)").
4. Add "Path mappings" if the old app saw your folders under different names than Arclight does (see [Path mapping](#path-mapping)).
5. Click "Analyze". Nothing is written yet. You get an "Import plan" table with these columns: Area, Found, New, Conflicts, Already imported, Unsupported. Each area has a mode: Import, Stage or Report only.
6. Read the plan and the warnings.
7. Choose "When an item already exists": "Skip it" (keep what Arclight already has) or "Overwrite it". Overwrite updates the existing item; nothing is ever deleted.
8. Optional but recommended for the first run: tick the dry run ("Run the import and roll it back, to see what would change.").
9. Click Import. It runs as a background task (visible under System > Tasks as `MigrateFromArr`) and shows progress, a log and a result.
10. Repeat for each app. Running the same import again skips items that were already imported.

Order that works well: Prowlarr (indexers), then Sonarr and Radarr, then Bazarr and Overseerr.

## Path mapping

Library items are adopted in place, with their original paths. That only works if Arclight can open those paths. If your old Sonarr saw TV at `/tv` and Arclight sees it at `/data/media/tv`, add a mapping:

| From | To |
|---|---|
| `/tv` | `/data/media/tv` |

Rules: the longest matching prefix wins; separators do not matter (`\` and `/` are treated alike); Windows paths are compared without regard to upper or lower case. Add your root folders in Arclight first (Settings > Media Management) or the library will show up with "missing root folder" warnings. See [folders-and-hardlinks.md](folders-and-hardlinks.md) for layout advice.

## What is imported

### From Sonarr and Radarr

| Area | Notes |
|---|---|
| Tags, root folders | |
| Custom formats, quality profiles | Qualities with no Arclight equivalent are dropped. Custom format conditions Arclight cannot evaluate are skipped. |
| Delay profiles, release profiles | A delay profile that disables a protocol produces a warning. The "preferred" terms of release profiles are not imported. |
| Indexers | |
| Download clients | qBittorrent, Transmission, Deluge, rTorrent, SABnzbd and NZBGet are mapped. Other types are listed as unsupported and kept aside. |
| Remote path mappings | |
| Notifications | Discord, Telegram, webhook, email, custom script, ntfy, Gotify, Pushover, Jellyfin/Emby and Plex are mapped. Other types are unsupported. |
| Import lists | Unsupported types are listed. Trakt lists must be authorised again. |
| Naming and media management settings | Naming tokens Arclight does not support are removed. |
| History and blocklist | |
| Series with episodes and files (Sonarr) or movies with files (Radarr) | Adopted in place with their original paths. |

Radarr collections are staged (stored, not applied). Sonarr v3 language profiles are not imported.

### From Prowlarr

Indexers are imported and keep going through Prowlarr, using the API key in `config.xml`. Indexer proxies and custom indexer definitions are staged. Prowlarr's "Applications" list is reported only.

### From Bazarr and Overseerr / Jellyseerr

Subtitle profiles, subtitle providers, subtitle history, users, requests, issues and request settings are read and staged: they are stored in Arclight's import staging area and shown in the plan. At the moment nothing in Arclight applies them to the Subtitles or Requests screens, so plan on setting those up by hand ([subtitles.md](../using/subtitles.md), [discover-and-requests.md](../using/discover-and-requests.md)).

## What the three modes mean

| Mode | Meaning |
|---|---|
| Import | Written into Arclight when you run the import |
| Stage | Stored for later, not active |
| Report only | Counted and shown, nothing stored |

## After the import

1. Check System > Health.
2. Open Settings > Indexers and Settings > Download Clients and use the test buttons.
3. Look at the Library: counts and paths should match the old app. Rescan if something looks missing.
4. Re-enter secrets that were not carried across, if the plan lists any, and re-authorise Trakt lists.
5. Run the old and new apps side by side only if one of them has downloads and searching turned off, otherwise both will grab the same releases.
6. When you are happy, stop the old apps.

## Tips

- Take a backup first: [backup-restore.md](backup-restore.md). Restoring is the quickest way to undo an import you do not like.
- Start with the dry run.
- Import only needs the database file, not the whole old config folder.

## Related

- [Back up and restore](backup-restore.md)
- [Folders and hardlinks](folders-and-hardlinks.md)
- [Indexers](../using/indexers.md)
- [Download clients](../using/download-clients.md)
- [System pages](../using/system.md)
- [Import blocked or failed](../TROUBLESHOOTING.md#import-blocked-or-failed)

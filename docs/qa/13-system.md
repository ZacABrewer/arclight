# System: Status, Tasks, Health, Logs, Backups, Import and General Settings

This file covers everything under the System sidebar section (Status, Tasks, Logs, Backups, Health, Import) plus Settings -> General.
Prerequisites: signed in as an admin; setup finished. For the Import checks you need a copy of a real Sonarr or Radarr database file (`sonarr.db` or `radarr.db`) on the machine running Arclight. Use a throw-away instance for the restore checks: restoring replaces the database.
Test environment: Native unless noted. After a restore, "Restart now" stops the process; on Docker and NAS the container restart policy brings it back, but on Native you must start `scripts\local-test.ps1 -NoBuild` again by hand.

## System -> Status

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| SYS-01 | Click System -> Status. | Page "Status" with three cards. "About": Version, Started (date and time), Uptime, Docker (badge yes or no). "Runtime": Node, Platform, Architecture. "Paths": Config, Database, Logs, each a file path. | |
| SYS-02 | Compare the Docker badge and Paths to your environment, then compare Version and Uptime with the Dashboard subtitle ("v... · up ..."). | Native: Docker "no" and paths under the test-env config folder (for example `C:\path\to\test-env\config`). Docker or NAS: Docker "yes" and paths such as `/config`. Version matches the Dashboard; Uptime grows when you reload a few minutes later. | |

## System -> Tasks

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| SYS-03 | Click System -> Tasks. | Two cards: "Scheduled" (columns Job, Interval, State, Last run, Next run, and a Run now button per row) and "History" (columns Job, Status, Trigger, Queued, Duration, Message). Clicking the Job header sorts A to Z, clicking again Z to A. | |
| SYS-04 | Read the Job and Interval columns of "Scheduled". | These jobs are listed: Backup, BlocklistCleanup, CutoffUnmetSearch, HealthCheck, HistoryCleanup, ImportListSync, IndexerStatsCleanup, IndexerStatusCheck, MissingEpisodeSearch, MissingMovieSearch, ProcessPendingImports, ProcessPendingReleases, RecycleBinCleanup, RefreshMovie, RefreshQueue, RefreshSeries, RequestsStatusSync, RescanAllMovies, RescanAllSeries, RssSync, SubtitleScan, SubtitleSearchWanted, SubtitleUpgrade, VpnStatusCheck, WatchlistSync. Each State badge is "enabled". Intervals include HealthCheck `*/5 * * * *`, RefreshQueue `* * * * *`, RefreshSeries `0 3 * * *`, RescanAllSeries `0 4 * * 0`. | |
| SYS-05 | On the HealthCheck row click Run now. | A toast "Started HealthCheck" with "Run #<n> is ..." appears. In "History" a new top row for HealthCheck appears without reloading: Trigger "manual", Status moving from queued or running to completed, a Duration such as 12ms. | |
| SYS-06 | Click Run now on `RefreshQueue`, then on `Backup`. | Two more History rows appear and complete. After Backup completes, System -> Backups lists a new archive. | |
| SYS-07 | Stop the Arclight process and reload System -> Tasks. | An error panel with a Retry button replaces the tables. After starting Arclight and clicking Retry the tables return. | |

## System -> Health

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| SYS-08 | Click System -> Health on a fresh install with no download client and no indexer. | Page "Health" with an overall status badge in the subtitle (warning or error) and rows, each with a badge, a bold source name and a message. Expect "No download client is available" and "No indexers enabled, ... will not return search results". Rows that have a link show "More info". | |
| SYS-09 | Add a download client and an indexer (Settings -> Download Clients, Settings -> Indexers), then click Re-check. | The Re-check button shows a spinner, then the matching rows disappear. When everything passes the card says "No issues" and "Every health check is passing." with an ok badge. | |
| SYS-10 | Add a root folder under Settings -> Media Management, delete that folder on disk, click Re-check; then recreate the folder and click Re-check. | First an error row "Missing root folder: <path>"; after recreating, the row is gone. | |

## System -> Logs

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| SYS-11 | Click System -> Logs. | Page "Logs" with tabs Events and Files; Events is open. The toolbar has a level list ("All levels"), a "Search messages..." box, a "Follow" switch (on), a Pause button, a status text ("Live"), and Refresh and Clear buttons. The table has Time, Level, Component, Message. | |
| SYS-12 | Keep Follow on and in another tab click Run now for HealthCheck on System -> Tasks. Then click Pause, trigger another job, wait, click Resume. Finally switch Follow off. | New lines appear at the top by themselves ("Live" and "N new"). While paused the status reads "Paused" and nothing is added; the button then reads "Resume (N new)" and inserts the held lines. With Follow off the status reads "Not following", Pause disappears and nothing arrives until Refresh. | |
| SYS-13 | Open the level list, then choose "error and above". | Options: All levels, trace and above, debug and above, info and above, warn and above, error and above, fatal and above. With "error and above" only error or fatal rows remain, or the table says "No log entries - Nothing matches these filters." | |
| SYS-14 | Set the level to "All levels", type `health` in the search box and wait one second. | Only rows whose message or component contains "health" remain. Clearing the box restores all rows. | |
| SYS-15 | Click a log message that has a small arrow, and use the pager if there are over 50 entries. | The row expands to show formatted JSON details. The pager moves to page 2 and back. | |
| SYS-16 | Click Clear. | The table empties: "No log entries - The in-memory log is empty." New lines begin to appear again as the app logs. | |
| SYS-17 | Click the Files tab, then Download on `arclight.log`. | Table File, Size, Last written, one row per file (`arclight.log`, and rotations `arclight.log.1`, `arclight.log.2`, ...), each with Download. The download saves `arclight.log` as readable text with recent lines. If no files exist: "No log files - Logs are written to <logs folder>." | |

## System -> Backups

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| SYS-18 | Click System -> Backups on a fresh install. | Page "Backups" with buttons "Restore from file..." and "Back up now", a table Name, Type, Size, Time (empty state: "No backups yet - Scheduled backups appear here; use "Back up now" to make one."), and a "Settings" card with Folder, "Interval (days)" (default 1), "Hour of day" (default 4), "Keep at most" (default 7), "Keep for (days)" (default 28) and Save. | |
| SYS-19 | Click Back up now. | The button spins and a row appears named like `arclight_manual_2026.10.26_14.05.09.zip` with a "Manual" badge, a size and a time. | |
| SYS-20 | Click Download on that row. | A zip with the same name is saved and opens with a zip tool. | |
| SYS-21 | Change something visible (add a tag under Settings -> Media Management), then click Restore on the backup made before the change. | A dialog "Restore backup" says the current database and config files are replaced, that a copy is kept as `arclight.db.pre-restore`, and that Arclight must be restarted. Buttons Cancel and Restore. | |
| SYS-22 | Click Restore in the dialog. | A warning toast "Backup restored" ("Restart Arclight to finish loading the restored data.") appears and an orange banner under the top bar reads "Restart required. A backup was restored; restart Arclight to load it." with a "Restart now" button. | |
| SYS-23 | Click "Restart now". | The banner changes to "Restarting Arclight... this page reloads when it is back." On Docker/NAS the page reloads on its own within about a minute; on Native restart the process manually and the page then reloads. The tag added after the backup is gone and the banner is gone. | |
| SYS-24 | Click "Restore from file...", pick a backup zip downloaded earlier, then try a non-zip file. | The zip opens the same "Restore backup" dialog naming that file and, once confirmed, shows the banner from SYS-22. A non-zip file is rejected: the chooser offers only zip files, and a forced wrong file gives an error in the dialog with nothing changed. | |
| SYS-25 | Click Delete on a backup row. | Dialog "Delete backup" says "Delete <name>? This cannot be undone." Cancel keeps it; Delete removes the row. | |
| SYS-26 | In Settings enter Interval `400`, Hour `25`, Folder `backups` and click Save. Then enter Interval `2`, Hour `3`, Keep at most `5`, Keep for `14`, empty Folder, Save and reload. | The first attempt shows "Enter a whole number from 0 to 365", "Enter a whole number from 0 to 23" and "Use an absolute path, or leave empty for the default" and saves nothing. The second shows toast "Backup settings saved" and the values persist after reload. | |
| SYS-27 | Set Folder to an existing absolute folder (for example `C:\path\to\test-env\backups`), Save, then click Back up now. | The new archive is written into that folder on disk and listed on the page. | |

## System -> Import (from existing apps)

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| SYS-28 | Click System -> Import. | Page "Import from existing apps" with subtitle "Adopt a running Sonarr, Radarr, Prowlarr, Bazarr or Seerr installation in place." A "Source" card has Application (Sonarr, Radarr, Prowlarr, Bazarr, Overseerr / Jellyseerr), "Database path", "Config file (optional)", "Path mappings" with Add mapping, and Analyze (disabled while the path is empty). | |
| SYS-29 | Enter `C:\does-not-exist\sonarr.db` and click Analyze. Then select Radarr and give it a real Sonarr database path. | First a red message "database not found: C:\does-not-exist\sonarr.db". Second a red message that it "does not look like a Radarr database (no Movies table)". | |
| SYS-30 | Select Sonarr, enter the path of a real `sonarr.db` copy and click Analyze. | A "Plan: Sonarr (schema N)" table with columns Include (checkbox), Area, Action (import, stage or report), Found, New, Conflicts, Already imported, Unsupported, Details. Areas with something to import are pre-ticked. The library is unchanged. | |
| SYS-31 | Click Add mapping, enter `/tv` and `/data/media/tv`, click Analyze again, then click Remove on the mapping. | A mapping row with two boxes and an arrow appears and Analyze still works. Remove deletes the row. | |
| SYS-32 | Scroll below the plan. | Cards for Warnings, "Conflicts with existing data" and "Not supported" list items with area badges (shown only when there are any). An "Import" card has "When an item already exists" (Skip it or Overwrite it), a "Dry run" switch and Import. | |
| SYS-33 | Switch Dry run on and click Import. | A card "Import Sonarr" shows state running then completed plus a "dry run" badge, a line "Area N of M: <area> (done/total)" with a progress bar while running, then a result table (Area, Created, Updated, Skipped, Staged, Failed). The Library is still unchanged. | |
| SYS-34 | Switch Dry run off, keep "Skip it" and click Import. Open System -> Tasks during the run. | The card runs to "completed"; Library -> TV lists the imported series; "Log (N)" expands. In Tasks a job named `MigrateFromArr` appears in History. | |
| SYS-35 | Click Analyze again with the same database and run Import again. | The plan shows counts under "Already imported" and New is 0; the second import creates no duplicates. | |

## Settings -> General

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| SYS-36 | Click Settings -> General. | Cards "Metadata (TMDB)" (TMDB API key shown masked, Metadata language, Region, Save) and "Host" (Address with the host and port you use; Port "Set with the ARCLIGHT_PORT environment variable."; Log level "Not exposed by the api yet (set ARCLIGHT_LOG_LEVEL)."; Config folder and Version matching System -> Status). A third card "Backups" still says "Backups are coming soon" (known stale text; real backups are under System -> Backups). | |
| SYS-37 | Set Region to `USA` and Save; then set it to `gb`, Save and reload. Leave the masked TMDB key untouched. | `USA` is blocked with "Use a two-letter code". After `gb` and a reload Region shows `GB` and the TMDB key is still set (Library -> Add New still returns results). | |

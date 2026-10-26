# Acquisition Flow: Search, Grab, Import

This checklist follows a release from the first search to the finished, renamed file for TV and for movies, then covers the failure and edge paths. It is the most important checklist: if these checks pass, Arclight does its core job.
Prerequisites: at least one working indexer, one working download client, a root folder for TV and one for movies, a quality profile, and (for the notification and refresh checks) a Discord or webhook test target and a Jellyfin, Emby or Plex server. Complete files 03, 04 and 05 first.
Test environments: Native (scripts\local-test.ps1 at http://localhost:17878), Docker (http://<host>:7878) and NAS. Steps below say "the app" for whichever address you use. Replace example titles with series and movies your indexer really carries.
API-only steps use the key from Settings -> Security -> API key, sent as `X-Api-Key`.

## TV: add, search and grab

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| TV-01 | Open Library -> Add New. Type "Severance" in the search box and press Enter. | Result cards appear with poster, year and a short overview. | |
| TV-02 | Click the Severance result. In the "Add Severance" dialog choose Root folder = your TV folder, Quality profile = "HD-1080p", Monitor = "All episodes", Series type = "Standard", Use season folders on. Turn OFF "Start searching for missing episodes". Click "Add series". | Toast "Added Severance". The series appears under Library -> TV. No download starts (Activity -> Queue stays empty). | |
| TV-03 | Open the series. Click the "Episodes" tab. | Seasons are listed, each with a monitor toggle and an "N wanted" badge. Every episode that has aired shows status "Missing" and a filled monitor toggle. | |
| TV-04 | Click the toggle "Unmonitor episode 2" for S01E02, then click it again ("Monitor episode 2"). | The toggle changes state each time and the "N wanted" count drops by one, then rises by one. The change is still there after a page refresh. | |
| TV-05 | Click "Unmonitor episode 3" for S01E03 and leave it unmonitored. Click "Search season" on Season 1. | Toast "Grabbed N release(s)" or "Search finished" with text like "12 found · 3 approved". S01E03 is not searched for (it is unmonitored). | |
| TV-06 | Click "Search" (aria name "Search S01E01") on a single monitored episode that is still missing. | Toast "Grabbed 1 release(s)" or "Search finished". If "Search finished" shows "0 approved", go to TV-08 to see why. | |
| TV-07 | Click "Interactive" on one episode. | A modal "Interactive search: Severance" opens, shows "Searching indexers", then lists releases with the columns Source, Age, Title, Indexer, Size, Peers, Languages, Quality, Score, Decision and a Grab button. | |
| TV-08 | In the interactive list, find a row whose Decision says "1 rejection" (or "N rejections"). Hover over the Decision badge. | A tooltip lists the reason text, for example "Only 3 minutes old, minimum age is 10 minutes" or "WEBDL-720p is not wanted in profile". A warning-coloured badge means temporary, an error-coloured badge means permanent. | |
| TV-09 | Find a row with the "Approved" badge and click "Grab". | Toast titled "Grabbed" with the release name. Open Activity -> Queue: the release is listed. | |
| TV-10 | In the interactive list, look at a permanently rejected row. | The Grab button is disabled (greyed out) and cannot be clicked. | |
| TV-11 | Search for a series with no releases (a very obscure title, or with every indexer disabled) and click "Search monitored". | Toast "Search finished" with "0 found". The interactive modal shows "No releases found". No error toast. | |

## TV: queue, import, rename and history

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| TV-12 | Open Activity -> Queue while the grab from TV-09 downloads. | Page title "Queue" with a subtitle like "1 items · 0 errors · 0 warnings · 0 unknown". The row shows Status, Title, Protocol, Client, Progress, Size, Time left and Added. Progress climbs on refresh. | |
| TV-13 | Wait for the download to finish (or click "Send now" if the row is Pending). | The row moves through "importPending" / "importing" to "imported" and then leaves the Queue. Tracked states are shown as badges in the Status column. | |
| TV-14 | Open the series -> "Files" tab. | The imported file is listed with quality and size. The episode status chip shows the episode has a file and the "N wanted" badge dropped by one. | |
| TV-15 | In the series folder on disk, look at the new file name. | Name follows the format in Settings -> Media Management -> "Standard episode format", default `{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}`, for example `Severance - S01E01 - Good News About Hell WEBDL-1080p.mkv`, inside a `Season 01` folder. | |
| TV-16 | In Settings -> Media Management turn OFF "Rename episodes", save, then import another episode (repeat TV-06). | The new file keeps the original release file name instead of the naming format. Turn the setting back ON and save afterwards. | |
| TV-17 | Open Activity -> History. | Rows for the grab ("grabbed") and the import appear for the episode, newest first, with Event, Source title, Quality and Date columns. | |
| TV-18 | Click the "Grabbed" filter chip, then "File renamed", then "All". | Each chip narrows the list to that event type. "All" restores every row. (The Imported, Failed and Ignored chips are covered in FAIL-31.) | |
| TV-19 | Click a "grabbed" history row. | A modal opens with Source title, Date, Quality, Languages, Download id, plus buttons "Mark as failed" and "Close". | |

## TV: notification and media-server refresh

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| TV-20 | In Settings -> Notifications add a Discord (or Webhook) connection pointing at your test channel, tick the events "Grab" and "Download" and save (see file 10 for details). Repeat TV-06 for a fresh episode. | A message arrives in the test channel when the release is grabbed, and another when it is imported. | |
| TV-21 | Add a Jellyfin, Emby or Plex connection with "Update library" turned on and save. Import another episode. | Within about a minute the new episode appears in the media server library without a manual scan. | |
| TV-22 | Go to Library -> Add New and add a second series with "Start searching for missing episodes" turned ON. | Toast "Added <title>" and downloads begin on their own. Releases show in Activity -> Queue within a minute. | |

## Movies: add, search and grab

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| MOV-01 | Open Library -> Add New and switch to movies. Search "Dune" and click a result. | The "Add Dune" dialog opens with Root folder, Quality profile, Monitored, Minimum availability, Tags and the toggle "Start searching for the movie". | |
| MOV-02 | Choose your movie root folder, Quality profile "HD-1080p", Minimum availability = "Released", turn OFF "Start searching for the movie". Click "Add movie". | Toast "Added Dune". Movie appears under Library -> Movies. No download starts. | |
| MOV-03 | Open the movie. Click "Search". | Toast "Grabbed 1 release(s)" or "Search finished" with "N found · N approved". | |
| MOV-04 | Click "Interactive search" on the movie. | Modal "Interactive search: Dune" lists releases with the same columns as TV. Approved rows have an enabled Grab button. | |
| MOV-05 | Add a movie that is still "In cinemas" only (not yet released digitally) with Minimum availability = "Released". Click "Search". | Automatic search rejects releases with "Movie is not available yet (minimum availability: released)" and nothing is grabbed. | |
| MOV-06 | On that same movie click "Interactive search". | Releases are listed and can be grabbed, because a manual search skips the availability rule. | |
| MOV-07 | Click "Edit" on the movie, set Minimum availability = "In cinemas" and save. Click "Search" again. | Releases are no longer rejected for availability. A matching release is grabbed or marked approved. | |
| MOV-08 | Click "Edit", untick Monitored, save, then run Wanted -> Missing -> Movies "Search all". | The unmonitored movie is not searched and is not listed on the Missing tab. Re-tick Monitored afterwards. | |
| MOV-09 | Click the movie's "Interactive search" and grab an approved release. | Toast "Grabbed" and the release is listed in Activity -> Queue. | |

## Movies: import, rename, history, notification, refresh

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| MOV-10 | Wait for the movie download in the Queue to finish. | Row goes through "importing" to "imported" and leaves the Queue. | |
| MOV-11 | Open the movie -> "Files" tab. | The file is listed with quality and size. | |
| MOV-12 | In the movie folder on disk look at the names. | Folder and file follow Settings -> Media Management "Movie folder format" and "Movie format", for example `Dune (2021)\Dune (2021) Bluray-1080p.mkv`. | |
| MOV-13 | Open Activity -> History. | A "grabbed" row and an import row for the movie are present. | |
| MOV-14 | Open the movie page and click the "History" tab. | Expected as built: the tab shows "History is coming soon" (placeholder). Use Activity -> History instead. | |
| MOV-15 | With the Discord/webhook and media-server connections from TV-20 and TV-21 in place, import one more movie. | A "Download" message arrives in the test channel and the movie shows up in Jellyfin/Emby/Plex without a manual scan. | |
| MOV-16 | Open Wanted -> Missing, Movies tab, with at least one monitored movie without a file. | Title reads "N movies". Select one movie and click "Search selected (1)": toast "Queued 1 searches". "Search all" queues one search per missing movie. | |

## Failure paths: failed download and blocklist

"Fake" below means you create the files by hand in the download client's completed folder; this needs no real release.

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| FAIL-01 | Failed download: grab an approved release, then in your download client (SABnzbd or qBittorrent) mark the job as failed or delete it together with its data. Wait up to two minutes. | The Queue row shows an error with the message "Failed download detected" (or the client's own message). Activity -> History gets a failed row. | |
| FAIL-02 | After FAIL-01 open Activity -> Blocklist. | Title "Blocklist". The failed release is listed with Source title, Quality, Protocol, Indexer, Reason and Date. | |
| FAIL-03 | After FAIL-01 look at the Queue and History again after a few minutes. | A different release for the same episode or movie is searched and grabbed automatically; the blocklisted release is not picked again. (Auto re-search is on by default. There is no screen toggle; it is API-only via the media management field `autoRedownloadFailed` at `/api/v1/settings/mediamanagement`.) | |
| FAIL-04 | Open the Blocklist and click "Remove" on the row. | The row disappears. An interactive search on the same item now shows that release as Approved instead of "Release is blocklisted". | |
| FAIL-05 | Grab a release, then in the Queue click "Remove" on its row. In the "Remove <title>?" dialog turn on "Remove from download client" and "Add release to blocklist", leave "Skip redownload" off, click Remove. | The row leaves the Queue, the job disappears from the download client, the release appears on the Blocklist, and a replacement search runs. | |
| FAIL-06 | Repeat FAIL-05 but turn on "Skip redownload". | The release is blocklisted and no replacement is grabbed. | |
| FAIL-07 | Open a "grabbed" row in Activity -> History, click "Mark as failed" and confirm "Mark as failed?". | The dialog says the release is blocklisted and a replacement is searched for. The release appears on the Blocklist and a replacement search starts. | |
| FAIL-08 | Blocklist bulk: tick two rows on the Blocklist and click "Remove selected (2)". | Both rows disappear. | |

## Failure paths: manual import of a stuck item

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| FAIL-09 | Make a stuck item: grab a release, then when it finishes rename its folder in the completed-downloads folder to "Some Random Name 2020" (Native/NAS: use File Explorer; Docker: rename on the host share). Open Activity -> Queue. | The row shows a warning, a "N message(s)" popover (for example "Series title mismatch; automatic import is not possible. Manual Import required.") and a "Manual import" button. | |
| FAIL-10 | Click "Manual import" on the stuck row. | The Manual Import page opens at step "2. Map files" and lists each file with File, Type, Series/Movie, Season, Episodes, Quality, Languages and Release group. | |
| FAIL-11 | Pick the correct Series (or Movie) and episode for each file, click "Next", choose Import mode "Auto" and click "Import". | Result card "Imported N, failed 0" with links "Back to queue" and "Import more from this source". The file is renamed per the naming format and listed on the Files tab of the series or movie. | |
| FAIL-12 | Open Activity -> Manual Import. In "From a folder" type a completed folder, for example `/downloads/complete` (Docker) or `D:\Downloads\complete` (Native), and click "List files". | Step "2. Map files" lists the video files found. An empty folder shows "No importable files found". | |
| FAIL-13 | In "From the queue" on the Manual Import page, look at the list with a stuck item present. | The stuck item is listed with a "needs import" badge. With nothing stuck the card says "No downloads with content on disk". | |

## Failure paths: upgrades, propers and delay profiles

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| FAIL-14 | Upgrade: with an episode imported at "HDTV-720p" and a profile that allows upgrades up to "WEBDL-1080p", run "Interactive" search on that episode. | A better-quality release shows Approved. Grab it. After import the old file is replaced (the Files tab shows the new quality) and History shows the upgrade. | |
| FAIL-15 | Cutoff met: with an episode already at or above the profile cutoff, run Interactive search. | Lower or equal quality releases show a rejection such as "Existing file <Quality> meets cutoff" and Grab is disabled. | |
| FAIL-16 | Turn "Upgrades allowed" OFF in the quality profile (Settings -> Profiles) and search an episode that already has a file. | Rejection "Quality profile does not allow upgrades". | |
| FAIL-17 | Custom-format upgrade: give a custom format a score (for example "x265" +50) in the profile, with an existing file lacking it, and run Interactive search. | A release with the format shows a higher Score, is Approved, and is imported as an upgrade. A release with an equal or lower score shows a "custom format score" rejection. | |
| FAIL-18 | Cutoff Unmet page: open Wanted -> Cutoff Unmet. | Expected as built: the page shows "Cutoff unmet is not available yet" because the API has no cutoff route for the web page. Use Interactive search on the item instead. The scheduled job "CutoffUnmetSearch" still exists on System -> Tasks. | |
| FAIL-19 | Proper/Repack: in Settings -> Media Management set "Propers and repacks" to "Prefer and upgrade". For an episode that already has a file, run Interactive search where a PROPER or REPACK release exists. | The proper/repack is Approved and replaces the file on import. | |
| FAIL-20 | Set "Propers and repacks" to "Do not upgrade automatically" and repeat as an automatic search ("Search"). | Automatic search does not grab it (rejection "Proper downloading is disabled" in the interactive list). A manual Interactive grab still works. Restore the setting afterwards. | |
| FAIL-21 | Delay profile: in Settings -> Profiles -> Delay profiles click add, set Preferred protocol = "Usenet", Usenet delay 0 and Torrent delay 60 minutes, save, then search an episode where only a torrent release is Approved. | Nothing is grabbed. Activity -> Pending shows the release with Reason "Delay profile" and a countdown in "Grabs in". The subtitle reads "N held back". | |
| FAIL-22 | On the Pending page click "Grab now" on the row. | Toast "Grabbed" and the release moves to the Queue. | |
| FAIL-23 | Create another pending release and click "Remove". | The row disappears and the release is not grabbed. | |
| FAIL-24 | Leave a pending release alone until its countdown shows "due". | Within about a minute (job ProcessPendingReleases) it is grabbed on its own and appears in the Queue. | |
| FAIL-25 | Delay bypass: tick "Bypass if highest quality" in the delay profile and search an episode where a release of the top quality exists. | The best-quality release is grabbed immediately and is not held in Pending. | |
| FAIL-26 | Duplicate: run Interactive search on an episode that is already in the Queue. | The same release shows "Release is already in the download queue" and Grab is disabled. | |
| FAIL-27 | Unaired: add a future episode (monitored) and click "Search" on it. | Rejection "Episode has not aired yet (airs ...)" and nothing is grabbed. | |

## Failure paths: season packs, paths, files and disk space

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| FAIL-28 | Season pack: add a series whose complete season exists on your indexer and click "Search season" on a season where no episode has a file. | A season pack is grabbed (one Queue row covering the season). After the download, one import covers every episode. | |
| FAIL-29 | After FAIL-28 open the series "Files" tab. | Each episode of the pack has its own file, each renamed per the naming format. | |
| FAIL-30 | Run Interactive search on a single episode where only a season pack is available while other episodes already have better files. | The pack shows a rejection such as "Season pack upgrades only X of Y episodes". | |
| FAIL-31 | History chips: open Activity -> History and click "Imported", "Failed" and "Ignored". | Expected as built: the page's event names (imported, failed, ignored) differ from what the API stores (downloadFolderImported, downloadFailed, downloadIgnored). If a chip shows no rows or an error although such events exist, record it as a defect. | |
| FAIL-32 | Remote path mismatch (Docker/NAS): in the download client use a download folder the app cannot see (the client reports `/data/downloads/tv` but the app has no such path). Grab a release and let it finish. | The Queue row warns "Import failed, path is not a valid local path: /data/downloads/tv/... You may need a Remote Path Mapping." | |
| FAIL-33 | Fix FAIL-32: in Settings -> Download Clients -> "Remote path mappings" add Host = your client host, Remote path = `/data/downloads/`, Local path = the path the app sees, save. Then use "Manual import" on the Queue row or wait up to two minutes. | The item imports normally and the warning is gone. | |
| FAIL-34 | Download folder missing: stop the container or unmount the share that holds the completed downloads, then let a download finish. | The Queue row shows a scan error naming the missing folder and stays in the Queue (not lost). After the folder is back it imports on retry. System -> Health may also warn. | |
| FAIL-35 | Sample file: put a small file named `Show.Name.S01E01.sample.mkv` next to a real episode file in a finished-download folder, then run Manual Import on that folder. | The sample is listed with the rejection "Sample" and is not imported. The real file imports normally. | |
| FAIL-36 | Unsupported extension: put `Show.Name.S01E01.1080p.xyz` in a finished-download folder and run Manual Import on it. | The file is rejected with "Invalid video file, unsupported extension: '.xyz'". A file ending `.exe` shows a "Caution: found executable file" message. Nothing is imported. | |
| FAIL-37 | Disk full: set Settings -> Media Management "Minimum free space (MB)" (advanced) higher than the free space on the root folder, for example 99999999, save, then search an episode. | Interactive search shows the rejection "Not enough free space: N MB free". If a release is grabbed anyway, import is rejected with "Not enough free space" and nothing is written. | |
| FAIL-38 | Set "Minimum free space (MB)" back to 100 and click "Manual import" on the stuck item from FAIL-37. | The item imports. | |
| FAIL-39 | System -> Tasks: click "Run now" next to "ProcessPendingImports" and "RefreshQueue". | Both jobs run and the "History" card lists a new entry for each with a finished status. | |
| FAIL-40 | Wanted -> Missing, Episodes tab. Select two rows and click "Search selected (2)". | Title reads "N episodes". Toast "Queued 2 searches". "Search all" queues one per missing episode. | |

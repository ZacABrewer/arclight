# Activity

This file covers the Activity section: Queue, History, Blocklist, Pending and the Manual Import wizard.
Prerequisites: signed in as an admin (Activity is admin-only), at least one download client configured (Settings -> Download Clients), at least one series or movie in the library and one working indexer. Several checks need a download in progress; start one from Search first.
Test environments: Native (http://localhost:17878), Docker (http://<host>:7878) or NAS. For API-only checks, `<key>` is the API key from Settings -> Security and `<host>` is the Arclight address.
Checks that apply to only some environments say so in the Step text.

## Queue

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| ACT-01 | With nothing downloading, open Activity -> Queue. | Page "Queue" with the empty state "Queue is empty" and the text "Grabbed releases show up here while they download and import." | |
| ACT-02 | Open Search, find a release for a library item, and click Grab. Return to Activity -> Queue. | The release is listed. The subtitle reads like "1 items · 0 errors · 0 warnings · 0 unknown". | |
| ACT-03 | Look at the columns of the new row. | Select checkbox, Status (a state badge such as downloading plus a status badge), Title, Protocol, Client, Progress, Size, Time left, Added and a row action area. | |
| ACT-04 | Watch the row for about a minute while the download runs. | Progress, Size and Time left update by themselves without reloading the page. | |
| ACT-05 | Click the column headers Title, Progress and Added. | The rows re-sort; clicking again reverses the order. | |
| ACT-06 | If a row shows "N message(s)", click it. | A popover lists the status messages for the row. | |
| ACT-07 | Click the "Show unknown" toggle. | Downloads in the client that Arclight did not grab appear in the list. Click again to hide them. | |
| ACT-08 | Queue more than 20 items (or use a client with many downloads). | A pager shows "Page 1 of N · X total" with first, previous, next and last buttons. Each page holds 20 items. | |
| ACT-09 | Click the row action "Remove" on one item. | A dialog "Remove <title>?" appears with toggles "Remove from download client", "Add release to blocklist" and "Skip redownload", and buttons Remove and Cancel. "Skip redownload" is disabled until "Add release to blocklist" is on. | |
| ACT-10 | Click Cancel in the dialog. | The dialog closes and the item stays in the queue. | |
| ACT-11 | Open Remove again, turn on "Remove from download client" only, and click Remove. | The item leaves the queue and the download is also gone from the client's own list. It is not on the Blocklist. | |
| ACT-12 | Grab another release. Click Remove with "Add release to blocklist" on and "Skip redownload" off. | The item leaves the queue and appears on Activity -> Blocklist. Arclight searches for a replacement shortly after (a new Grabbed entry in History). | |
| ACT-13 | Grab another release. Remove it with both "Add release to blocklist" and "Skip redownload" on. | The release is blocklisted and no replacement is grabbed. | |
| ACT-14 | Tick the checkboxes of two items. | The button "Remove selected (2)" becomes active. | |
| ACT-15 | Click "Remove selected (2)". | The dialog is titled "Remove 2 items?". Confirming removes both. | |
| ACT-16 | If an item has no download client yet (for example a held item), open its Remove dialog. | "Remove from download client" is disabled with the note "Not sent to a download client yet." | |
| ACT-17 | (Native or Docker with the Built-in client) Click "Details" on a Built-in engine row. | A drawer opens with the torrent's details. | |
| ACT-18 | For an item with no client yet, click "Send now" (or tick items and click "Send selected"). | The item is sent to the download client and then shows a client name. | |

## History

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| ACT-19 | Open Activity -> History on a fresh install. | Page "History" with the empty state "No history yet". After you grabbed something, rows appear. | |
| ACT-20 | Look at the filter chips at the top. | Chips: All, Grabbed, Imported, Failed, File deleted, File renamed, Ignored. "All" is highlighted by default. | |
| ACT-21 | Click "Grabbed". | Only Grabbed events are shown; the chip is highlighted and "All" is not. | |
| ACT-22 | Also click "Imported". | Both Grabbed and Imported events are shown (the chips combine). | |
| ACT-23 | Click "All". | All chips reset and every event type is shown again. | |
| ACT-24 | Look at the columns. | Event (coloured badge), Source title, Quality, Date (relative, such as "5 minutes ago"; hover for the full time). | |
| ACT-25 | Click a Grabbed row. | A dialog titled "Grabbed" opens showing Source title, Date, Quality, Download id and extra data (indexer, size, and so on), with buttons "Mark as failed" and Close. | |
| ACT-26 | Click an Imported row. | The dialog is titled "Imported" with Close but no "Mark as failed" button (that button exists for Grabbed rows only). | |
| ACT-27 | On a Grabbed row, click "Mark as failed". | A confirmation "Mark as failed?" says the release is blocklisted and, unless disabled, a replacement is searched for. | |
| ACT-28 | Confirm "Mark as failed". | The dialog closes. A Failed event appears in History, the release appears on Activity -> Blocklist, and a search for a replacement starts (a new Grabbed event follows if a result is found). | |
| ACT-29 | Via API: `curl -X POST http://<host>/api/v1/history/failed/<id> -H "X-Api-Key: <key>" -H "Content-Type: application/json" -d "{\"skipRedownload\":true}"` using a Grabbed event id. | Returns the new history records; the release is blocklisted and no replacement search happens. | |
| ACT-30 | Check the History dialog of a Failed or Grabbed row for a redownload button. | There is no redownload control in the History page. A replacement search only happens through Mark as failed or by removing a queue item with blocklist on. | |
| ACT-31 | With more than 20 history rows, use the pager at the bottom. | "Page X of Y · N total" navigates between pages. Changing a filter chip returns to page 1. | |

## Blocklist

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| ACT-32 | Open Activity -> Blocklist with nothing blocklisted. | Page "Blocklist" with the empty state "Blocklist is empty" and the text "Releases that failed or were rejected manually are listed here." The button "Remove selected" is disabled. | |
| ACT-33 | After ACT-12 or ACT-28, open Activity -> Blocklist. | The blocked release is listed with Source title, Quality, Protocol, Indexer, Reason and Date. | |
| ACT-34 | Search for the same series or movie and look at the blocked release in the Search results. | The blocked release is rejected (it is not grabbed automatically; a rejection reason mentions the blocklist). | |
| ACT-35 | Click the row button "Remove" on a blocklist entry. | The entry disappears. The release is no longer rejected for being blocklisted. | |
| ACT-36 | Tick two entries (or "Select all" in the header) and click "Remove selected (2)". | Both entries are removed and the selection resets. | |
| ACT-37 | Via API: `curl -X POST http://<host>/api/v1/blocklist/clear -H "X-Api-Key: <key>"`. | Returns `{"deleted":N}` and the Blocklist page is empty after reload. The web UI has no Clear button. | |
| ACT-38 | Via API: `curl -X POST http://<host>/api/v1/blocklist -H "X-Api-Key: <key>" -H "Content-Type: application/json" -d "{\"mediaType\":\"movie\",\"movieId\":1,\"sourceTitle\":\"Example.Movie.2020.1080p.WEB-DL\",\"quality\":{\"quality\":{\"id\":3,\"name\":\"WEBDL-1080p\"}},\"protocol\":\"torrent\"}"` (use a real movie id). | Returns the new entry (HTTP 201) and it shows on the Blocklist page. The web UI has no "Add" button. | |
| ACT-39 | With more than 25 entries, use the pager. | Pager shows "Page X of Y · N total"; 25 entries per page. | |

## Pending

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| ACT-40 | Open Activity -> Pending when nothing is held. | Page "Pending releases" with the empty state "Nothing pending" and "Releases held back by a delay profile or an unavailable download client wait here." | |
| ACT-41 | Set a delay profile with a protocol delay (Settings -> Profiles, for example 60 minutes for torrents), then grab a matching release that is not the preferred protocol. | The release appears under Pending with Reason "Delay profile" (or "Waiting for preferred protocol"), and the subtitle reads "1 held back". | |
| ACT-42 | Look at the columns. | Release, Item, Quality, Indexer, Protocol, Size, Reason, "Grabs in" (countdown) and the actions "Grab now" and "Remove". | |
| ACT-43 | Click "Grab now". | The toast "Grabbed" appears and the release moves to the Queue. | |
| ACT-44 | Hold another release (as in ACT-41) and click "Remove". | The entry leaves Pending and is not grabbed. | |
| ACT-45 | Stop your only download client so it is unavailable and grab a release. | The release is held in Pending with Reason "Download client unavailable". Start the client again; it is sent automatically, or use "Grab now". | |
| ACT-46 | Wait until a countdown reaches zero. | "Grabs in" shows "due" and the release is grabbed on the next check (within a few minutes). | |

## Manual Import

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| ACT-47 | Open Activity -> Manual Import (or click "Manual import" at the top of the Queue). | Page "Manual import", subtitle "Choose files, map them to the library, and import", step list "1. Source", "2. Map files", "3. Import". Two cards: "From a folder" and "From the queue". | |
| ACT-48 | Look at the "From a folder" card. | A Folder field (placeholder `/downloads/complete`, with a folder picker) and a "List files" button that is disabled until you type a path. | |
| ACT-49 | Put a test video file in a folder outside your library, for example `C:\import-test\Some.Show.S01E01.1080p.WEB-DL-GRP.mkv` (Native) or `/downloads/complete/Some.Show.S01E01.1080p.WEB-DL-GRP.mkv` (Docker/NAS). Enter its folder and click "List files". | Step 2 shows a table with columns File, Type, Series / Movie, Season, Episodes, Quality, Languages, Release group. The file is listed with its size. | |
| ACT-50 | Enter a folder that contains no video files, or a path that does not exist. | The empty state "No importable files found" or an error message with a Retry button. | |
| ACT-51 | In the table, leave the Series unset. | The row's checkbox is disabled (hover shows "Choose a series"), the counter reads "0 of 1 selected" and Next is disabled. | |
| ACT-52 | Choose a Series with the picker. | The Season drop-down becomes enabled (entries "Season 1", "Specials" and so on). Hover on the checkbox now says "Choose a season". | |
| ACT-53 | Choose a Season, then open the Episodes selector and tick an episode, for example E01. | The selector shows "E01"; the row is selected automatically and the counter reads "1 of 1 selected". | |
| ACT-54 | Change the Type of the row from Episode to Movie. | The series, season and episode cells are replaced by a single Movie picker. Choose a movie to make the row importable. Switch back for the next steps. | |
| ACT-55 | Change Quality, edit Languages (for example `English`) and Release group (for example `GRP`). | The values are accepted. The Quality list matches the type (series or movie qualities). | |
| ACT-56 | Hover the "N issue(s)" badge on a row that has one. | A tooltip lists the rejection messages. | |
| ACT-57 | Tick "Select all files", then untick it. | All importable rows select and deselect together; rows with missing choices stay unselected. | |
| ACT-58 | Click Next. | Card "Import options" shows "Import 1 file into the library." and an "Import mode" drop-down with Auto, Move and "Copy / hardlink". | |
| ACT-59 | Click Back, then Next again. | You return to the mapping with your choices kept. | |
| ACT-60 | Choose "Copy / hardlink" and click Import. | The card title becomes "Imported 1, failed 0" with a row marked "imported" showing the destination path in your library. The source file is still in its original folder. | |
| ACT-61 | Check the library item and Activity -> History. | The episode (or movie) shows a file, and an Imported event is in History. | |
| ACT-62 | Click "Back to queue", then return to the wizard and click "Import more from this source". | The first link goes to Activity -> Queue; the button returns to the file mapping of the same source. | |
| ACT-63 | Repeat with a new test file using the mode "Move". | After Imported, the source file is gone from the original folder and present in the library. | |
| ACT-64 | Select a file, then delete it from disk before clicking Import. | The results table shows a row marked "failed" with the error text, and the title reads "Imported 0, failed 1". | |
| ACT-65 | Click "Start over" at the top. | You return to step 1 with the Source cards. | |
| ACT-66 | In the "From the queue" card, look for a finished download that Arclight could not import automatically. | It is listed with a "needs import" badge. Clicking it opens the mapping step for that download (header shows "download <id>"). | |
| ACT-67 | In the Queue, click "Manual import" on a row that needs it. | The wizard opens directly at step 2 for that download. | |
| ACT-68 | Open `/activity/manual-import?seriesId=1` (or `?movieId=1`) in the browser address bar. | The wizard lists video files found in that series or movie folder that are not yet tracked. | |

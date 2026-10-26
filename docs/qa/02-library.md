# Library: adding, browsing and managing series and movies

This file checks the Library section of Arclight: adding a series or movie from TMDB, the TV and Movies list pages, series and movie detail pages, editing, deleting, root folders, tags, exclusions, rename, rescan and library statistics.
Prerequisites: a TMDB API key saved under Settings -> General (see 03-metadata-and-profiles.md), at least one quality profile, and folders you can use as root folders (for example `D:\media\tv` and `D:\media\movies` on Native, `/data/media/tv` and `/data/media/movies` on Docker or NAS).
Test environments: Native, Docker and NAS all apply. Steps marked "via API" use `curl` with the API key from Settings -> Security; replace `<host>` with `localhost:17878` (Native) or `<host>:7878` (Docker/NAS).
Not built in the web app (do not report as bugs): poster-size control, an Overview view, bulk Refresh/Search/Tags actions, a series History tab, a working Refresh button (it is greyed out), a tag management page, and a UI for library import exclusions (API only).

## Root folders (Settings -> Media Management)

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| LIB-01 | Open Settings -> Media Management and scroll to the "Root folders" card. | The card lists existing root folders with columns Path, Type (Series or Movies) and Free space, or shows "No root folders" with the text "Add the folders your series and movies live in." | |
| LIB-02 | In the "Root folder path" box type your TV folder (for example `D:\media\tv`), leave the type dropdown on "Series" and click "Add root folder". Then use the browse button, pick your movies folder in the "Choose a root folder" dialog, set the type to "Movies" and click "Add root folder". | Two rows appear, typed "Series" and "Movies", each with a free-space figure such as "120.4 GB". The path box empties after each add. | |
| LIB-03 | Add a Series root folder with a path that does not exist (for example `Z:\does-not-exist`), then click "Remove" on that row. | Either an error shows under the form or the row appears with a red "inaccessible" badge. After "Remove" the row disappears and your real folders remain. | |

## Adding a series (Library -> Add New)

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| LIB-04 | Click Library -> Add New in the sidebar. | The page "Add new" opens with subtitle "Search TMDB for a series or movie to add to the library", a search box (placeholder "e.g. The Expanse") and buttons All, Series, Movies. The empty state reads "Start typing to search". | |
| LIB-05 | Type `The Expanse` and wait half a second. Then try the Series, Movies and All buttons. Then type a single letter `a`, then `zzzzqqqqxx`. | Result cards appear with poster, title, year, a "Series" or "Movie" badge, a star rating, overview and an "Add..." button. Series/Movies narrow the list. One letter returns to "Start typing to search". The nonsense text shows "No results for" followed by your text in curly quotes. | |
| LIB-06 | Click "Add..." on the TV series result for The Expanse. | A dialog titled "Add The Expanse" opens with poster and overview, and fields: Root folder, Quality profile, Monitor, Series type, "Use season folders" toggle, a subtitle language profile dropdown, Tags, "Start searching for missing episodes" toggle, and a Destination preview. | |
| LIB-07 | Open the Monitor dropdown, then the Series type dropdown. | Monitor options: All episodes, Future episodes, Missing episodes, Existing episodes, First season, Latest season, Pilot episode, None. Series type options: Standard, Daily, Anime. | |
| LIB-08 | Choose your TV folder in "Root folder". In Tags type `kids` in the "New tag" box and click "Add tag". | Destination shows the root folder plus the series folder, for example `D:\media\tv\The Expanse (2015)` (before a folder is chosen it says "Choose a root folder to see the path"). A ticked checkbox "kids" appears in the tag list. | |
| LIB-09 | Set Root folder back to "Select a root folder..." and click "Add series". | The dialog stays open and shows "Choose a root folder" under the field. Nothing is added. | |
| LIB-10 | Choose a root folder and quality profile, keep Monitor on "All episodes", leave "Start searching for missing episodes" off and click "Add series". Afterwards return to Library -> Add New and search `The Expanse` again. | A toast "Added The Expanse" shows and the series detail page opens. In Add New the card now has a button "In library — view" instead of "Add...". Opening another Add dialog pre-selects the root folder and profile you used last. | |

## Adding a movie

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| LIB-11 | In Add New click "Movies", search `Blade Runner 2049` and click "Add..." on the movie. | Dialog "Add Blade Runner 2049" with Root folder (Movies folders only), Quality profile, "Monitored" toggle (on), Minimum availability (Announced, In cinemas, Released), language profile, Tags, "Start searching for the movie" toggle and Destination. No Monitor, Series type or season-folder field. | |
| LIB-12 | Choose your movies root folder and click "Add movie". | A toast "Added Blade Runner 2049" shows and the movie detail page opens. | |

## TV and Movies list pages

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| LIB-13 | Add at least three series, then click Library -> TV. | Page "TV" shows subtitle "N of N series", a TV / Movies switcher, a "Filter by title..." box, a sort dropdown with an arrow button, Posters / Table buttons, a filter row and an "Add new" button top right. Each poster card has a checkbox, monitor toggle, poster, title, progress bar, year and size on disk. | |
| LIB-14 | Click "Table", then reload the page. | Table columns: checkbox, monitor toggle, Title, Year, Status, Profile, Network, Episodes, Size, Added (on Movies: Studio and File). After reload the Table view is still selected. | |
| LIB-15 | Type `expa` in "Filter by title...", then click "Clear filters". | The list narrows to matching titles and the subtitle updates (for example "1 of 3 series"); "Clear filters" appears and restores everything. | |
| LIB-16 | Open the Sort dropdown, choose "Year", click the arrow button, then in Table view click the "Title" column heading. | Options are Title, Date added, Year, Size on disk, Progress. The order changes by year and the arrow flips (labels "Sort ascending" / "Sort descending"). Clicking a column heading re-sorts. Sort choice survives a reload. | |
| LIB-17 | Use the filter row: Monitored dropdown (All / Monitored only / Unmonitored only), "Missing files" checkbox, "Any profile", "Any tag" and "Any status" dropdowns. | Each narrows the list. If nothing matches, "Nothing matches these filters" shows with a "Clear filters" button. TV statuses: Continuing, Ended, Upcoming. Movies statuses: TBA, Announced, In cinemas, Released. | |
| LIB-18 | Click the monitor toggle on one poster card. | The card dims or un-dims; the tooltip alternates between "Monitored: click to unmonitor" and "Unmonitored: click to monitor". | |

## Select mode and bulk actions

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| LIB-19 | Tick the checkbox on two series, then click "Select all", then "Select none". | A bar reads "2 series selected" with Select all, Monitor, Unmonitor, a "Set profile..." dropdown, a "Move to root folder..." dropdown, Delete and Clear selection. "Select all" selects every visible title and the button becomes "Select none"; the bar then disappears. | |
| LIB-20 | Select two series and click "Unmonitor", then "Monitor". | Both toggles show unmonitored, then monitored again. | |
| LIB-21 | Select one series and pick another profile in "Set profile...". Then select a series with no files and pick another folder in "Move to root folder...". | The Profile column (Table view) and detail page show the new profile. The detail page Path now starts with the new root folder. | |
| LIB-22 | Select one title and click Delete in the bar, then Cancel. | Dialog "Delete 1 series" (or "Delete 1 movie") asks "Remove ... from the library?" with unticked boxes "Delete files and folder from disk" and "Add to import exclusions (prevent re-adding from lists)". Cancel leaves the library unchanged. | |

## Series detail page

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| LIB-23 | Click a series title in the TV list. | Header with poster, fanart background, monitor toggle, title, status badge, and facts: Network, Quality profile, Path, Size on disk, Episodes (for example "0 / 62"), Next airing, Type, Runtime, Genres, Tags, plus the overview. Buttons: Refresh, "Search monitored", "Interactive search", "Manual import", Edit, Delete. | |
| LIB-24 | Hover the Refresh button and look at the tabs. | Refresh is greyed out and cannot be clicked (tooltip says it has no api contract yet). Tabs are "Episodes", "Files (0)" and "Subtitles"; there is no History tab. | |
| LIB-25 | On the Episodes tab look at the seasons, and click a season heading such as "Season 1". | Seasons are newest first with "Specials" last; the newest real season starts expanded. Each header has a monitor toggle, progress bar, "N episodes" and size, a red "N wanted" badge when relevant, "Search season" and "Interactive" buttons. Clicking the heading opens or closes it. | |
| LIB-26 | Look at the episode table in an open season. | Columns: monitor toggle, #, Title, Air date, Quality, Status, and per-row "Search" and "Interactive" buttons. Status chips read Downloaded, Wanted, Missing, Unaired or TBA; an untitled episode shows "TBA". | |
| LIB-27 | Click the monitor toggle on one aired episode, then the one in the season header. | The episode chip flips between "Wanted" and "Missing". Unmonitoring the season dims it and its episodes; clicking again restores it. | |
| LIB-28 | Click "Search" on one aired episode, then "Search monitored" in the header (needs an indexer). | A toast appears, for example "Search finished" with a message like "12 found · 3 approved", or "Grabbed 1 release". Without indexers an error toast "Search failed" or a zero-result message appears. | |
| LIB-29 | Click "Interactive" on one episode. | Dialog "Interactive search: The Expanse S01E01" with a table: Source, Age, Title, Indexer, Size, Peers, Languages, Quality, Score, Decision and a Grab button. Approved rows show "Approved"; others show "N rejection(s)" and hovering lists the reasons. Without indexers: "No releases found". | |
| LIB-30 | Click "Manual import" in the header, go back, then click the "Subtitles" tab. | Manual import opens Activity -> Manual Import with this series pre-selected. The Subtitles tab loads without an error (details in 06-subtitles.md). | |

## Files tab and movie detail page

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| LIB-31 | Put a file such as `The Expanse - S01E01 - Dulcinea.mkv` in the series folder, rescan (LIB-38), and open the "Files" tab. Click "Delete" on the row, then Cancel. | The tab label reads "Files (1)" and lists Relative path, Season, Quality, Languages, Group, Size, Added and Delete. An empty series shows "No files on disk". The delete dialog "Delete file" says "This cannot be undone." with Cancel and "Delete from disk". | |
| LIB-32 | Open a movie from Library -> Movies. | Title, monitor toggle, a status badge (for example Released) and a file badge (Downloaded, Wanted, Missing or Not available). Facts: In cinemas, Digital release, Physical release, Quality profile, Minimum availability, Path, Size on disk, File, Runtime, Genres, Collection, Tags. Buttons: Refresh (greyed out), Search, "Interactive search", "Manual import", Edit, Delete. Tabs: "Files", "Subtitles", "History". | |
| LIB-33 | Click the movie "History" tab. | It shows "History is coming soon" and "Grabs, imports and failures for this movie will be listed here once the history module lands." | |
| LIB-34 | On the movie click Search, then "Interactive search". | Search gives a toast as in LIB-28. The dialog is titled "Interactive search: <movie title>" with the same table as LIB-29. | |

## Edit and delete

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| LIB-35 | On a series page click Edit. Change Series type to "Anime" and the Quality profile, click Save. Repeat with "Daily" and "Standard". | Dialog "Edit <title>" has Monitored, "Monitor new seasons" (All new seasons / None), Quality profile, language profile, Series type, "Use season folders", Path and Tags. After Save the dialog closes and the Type and Quality profile facts show the new values each time. | |
| LIB-36 | On a movie page click Edit, set Minimum availability to "Announced" and Save. | Dialog "Edit <title>" has Monitored, Quality profile, language profile, Minimum availability, Path, Tags. The fact "Minimum availability" now reads "Announced". | |
| LIB-37 | On a series page click Delete, tick "Delete files and folder from disk", then untick it, tick "Add to import exclusions (prevent re-adding from lists)" and click Delete. | Ticking the files box shows a red warning "The folder <path> and everything in it will be deleted." After Delete you land on Library -> TV and the series is gone. | |

## Rescan, rename, exclusions, tags, statistics (API only)

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| LIB-38 | Rescan via API: `curl -X POST -H "X-Api-Key: <key>" -H "Content-Type: application/json" -d "{\"seriesId\":1}" http://<host>/api/v1/command/rescan` (use `movieId` for a movie, `{}` for everything). Then preview renames: `curl -H "X-Api-Key: <key>" "http://<host>/api/v1/rename?seriesId=1"`. | The rescan returns `scanned`, `added`, `removed` and `unmapped`; a video file placed in the folder is in `added`. The rename preview returns `existingPath` / `newPath` pairs, or `[]` if names already match Settings -> Media Management formats. | |
| LIB-39 | Turn on "Rename episodes" in Settings -> Media Management and click "Save naming", then run `curl -X POST -H "X-Api-Key: <key>" -H "Content-Type: application/json" -d "{\"seriesId\":1}" http://<host>/api/v1/command/rename`. Then list exclusions: `curl -H "X-Api-Key: <key>" http://<host>/api/v1/library/exclusions`, and delete one with `curl -X DELETE ... /api/v1/library/exclusions/<id>`. | Rename returns `renamed` and `failed` lists and the file on disk has the new name. The exclusions list contains the title deleted in LIB-37 (with `tmdbId` and `mediaType`); the DELETE returns an empty 204 and the entry disappears. Settings -> Import Lists has a separate "List exclusions" card (Title, Year, Type, TMDB id). | |
| LIB-40 | Create a tag: `curl -X POST -H "X-Api-Key: <key>" -H "Content-Type: application/json" -d "{\"label\":\"anime\"}" http://<host>/api/v1/tag`, then `GET /api/v1/tag`. Then read statistics: `curl -H "X-Api-Key: <key>" http://<host>/api/v1/library/statistics`. | The POST returns the tag with an id (a duplicate label returns a conflict error) and the tag appears in the "Any tag" filter. Statistics return `seriesCount`, `monitoredSeriesCount`, `endedSeriesCount`, `continuingSeriesCount`, `episodeCount`, `episodeFileCount`, `movieCount`, `monitoredMovieCount`, `movieFileCount`, `sizeOnDisk` and `rootFolders`, matching what the TV and Movies pages show. | |

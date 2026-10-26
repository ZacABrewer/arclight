# Indexers, Proxies and Search

This file covers everything about finding releases: the Indexers list, adding Torznab/Newznab indexers and catalogue (site definition) indexers, custom YAML definitions, Indexer Proxies, Indexer Options, Indexer Stats, the cross-indexer Search page and the RSS sync job.
Prerequisites: you are signed in as an admin, and you have at least one working indexer endpoint to test against. Example values used below (replace with your own): a Torznab URL such as `http://localhost:9117/api/v2.0/indexers/all/results/torznab` with its API key, a Newznab URL such as `https://nzb.example/` with a key, and (for the proxy checks) a FlareSolverr container on port 8191.
Test environment: Native (`scripts\local-test.ps1`, http://localhost:17878) is enough for nearly everything. Docker and NAS runs behave the same; checks that need real internet access to indexers are noted.
The Indexers list is the same page at two addresses: sidebar Indexers -> Indexers (`/indexers`) and Settings -> Indexers (`/settings/indexers`).
For the API-only checks, `<key>` is the API key shown at Settings -> Security (card "API key") and `<host>` is `localhost:17878` (Native) or `<host>:7878` (Docker/NAS).

## Indexers list

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| IDX-01 | Click Indexers -> Indexers in the sidebar, then click Settings -> Indexers. | Both open a page titled "Indexers" showing exactly the same cards. | |
| IDX-02 | On a fresh install with no indexers, look at the page. | A single "+ Add indexer" card is shown. The "Test all" button in the top right is greyed out. | |
| IDX-03 | Sign in as a non-admin user (role user) and look at the sidebar. | The Activity, Search, Indexers, Settings and System sections are not shown to that user. | |

## Add a Torznab indexer

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| IDX-04 | Click "+ Add indexer". | A dialog titled "Add indexer" opens with two tabs: "Torznab/Newznab" and "Catalogue". The first tab shows two tiles, Torznab (torrent) and Newznab (usenet). | |
| IDX-05 | Click the Torznab tile. | The dialog changes to "Add Torznab indexer" with fields Name, Enable RSS, Enable automatic search, Enable interactive search, URL, API key, Categories, plus advanced fields (API path, Anime categories, Minimum seeders, Seed ratio, Seed time, Season-pack seed time, Additional parameters, Rate limit, Priority, Tags). | |
| IDX-06 | Clear the Name field and click Save. | The dialog does not close and the Name field shows a required-field error. | |
| IDX-07 | Enter Name "Test Torznab", the URL and API key of your Torznab endpoint, then click Test. | Next to the button a green box shows "Test passed" followed by "N releases returned" (and "by <server title>" if the indexer reports one). | |
| IDX-08 | Change the API key to "wrong" and click Test. | A red box shows "Test failed" with an error line ending in a code in brackets. Nothing is saved. | |
| IDX-09 | Put the correct API key back, open the Categories field and tick a parent category such as "Movies" (2000). | Ticking the parent ticks all of its subcategories (shown ticked and greyed out). Unticking removes them. A partly ticked parent shows a dash instead of a tick. | |
| IDX-10 | Click Save. | The dialog closes and a card "Test Torznab" appears showing "torznab - torrent - priority 25" and a green "ok" badge. | |
| IDX-11 | Look at the card's three toggles. | RSS, Automatic and Interactive are all switched on. | |
| IDX-12 | Switch the "RSS" toggle off, then reload the page. | The toggle is still off after the reload (the change was saved). Switch it back on. | |
| IDX-13 | Switch all three toggles off. | The card is greyed out and its badge reads "disabled" (grey). Switch them back on afterwards. | |

## Add a Newznab indexer

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| IDX-14 | Click "+ Add indexer", then the Newznab tile. | Dialog "Add Newznab indexer" opens. The torrent-only fields (Minimum seeders, Seed ratio, Seed time, Season-pack seed time) are NOT present. | |
| IDX-15 | Enter Name "Test Newznab", the URL and API key, click Test, then Save (needs a real usenet indexer). | Test shows "Test passed". The card appears with "newznab - usenet - priority 25". | |

## Add from the catalogue (site definitions)

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| IDX-16 | Click "+ Add indexer" and open the "Catalogue" tab. | A list of site definitions is shown, each with name, a privacy badge (public, semi-private or private), a protocol badge, a "tested" or "untested" badge and a language such as "en-US". Eight built-in definitions ship: 1337x, EZTV, LimeTorrents, Nyaa, The Pirate Bay, Torlock, TorrentGalaxy, YTS. | |
| IDX-17 | Type "yts" in the box with the placeholder "Search by name, description, language". | Only YTS (and anything else matching) remains. Typing "zzzz" shows "No definitions match" and "Try fewer words or another filter." | |
| IDX-18 | Clear the search box, set the Privacy drop-down to Public, then to Private. | Public shows only entries with a green "public" badge. Private shows only private ones (possibly none, which shows the "No definitions match" message). | |
| IDX-19 | Set the Protocol drop-down to Usenet, then Torrent, then Any protocol. | The list narrows each time and returns to the full list on "Any protocol". | |
| IDX-20 | Open the Language drop-down and choose one entry, then reset it to "Any language". | Only definitions whose language starts with the chosen value remain, then the full list returns. | |
| IDX-21 | Click the "Reload" button in the catalogue filters. | The button briefly shows a spinner and the list reloads without an error message. | |
| IDX-22 | Click the YTS entry. | Dialog "Add YTS" opens with privacy and protocol badges, a "tested" or orange "untested definition" badge, the description, then the fields Name, Enable RSS, Enable automatic search, Enable interactive search, the definition's own settings, Proxy (default "By tag (automatic)") and advanced Categories, Minimum seeders, Seed ratio, Seed time, Rate limit, Priority, Tags. | |
| IDX-23 | If a definition lists several mirror addresses, look for a "Site link" drop-down. | The drop-down lists each mirror URL with the help text "Mirror to use." Definitions with only one link do not show this field. | |
| IDX-24 | Open a definition that carries login help or a note (a private-tracker definition, if you have one). | A blue note box with the note's label and plain text is shown above the form. | |
| IDX-25 | Click Test and then Save on the YTS dialog (needs internet). | Test shows "Test passed" with a release count, or a clear "Test failed" message if the site is blocked. After Save, the card shows "definition - torrent - priority 25" and a second line "definition: YTS". | |
| IDX-26 | Click the new YTS card title. | The definition dialog reopens titled "Edit YTS" with a Delete button on the left. | |
| IDX-27 | Click Delete in that dialog. | A confirmation "Delete YTS?" appears. Confirming removes the card. Cancelling keeps it. | |

## Custom YAML definitions (via API only)

There is no upload screen in the app; only the catalogue Reload button exists in the UI. Custom definitions are managed with the API.

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| IDX-28 | Copy `packages\indexers\src\definitions\builtin\nyaa.yml` to a new file, change `id:` to `mysite` and `name:` to `My Site`. Upload it with `curl -X POST http://<host>/api/v1/indexer/definition -H "X-Api-Key: <key>" -H "Content-Type: application/json" -d "{\"yaml\": \"<file contents with newlines written as \\n>\"}"`. | HTTP 201 and a JSON body describing the definition. The file is stored as `mysite.yml` in the `definitions` folder inside the app's config folder. | |
| IDX-29 | Open "+ Add indexer" and the Catalogue tab. | "My Site" is listed with a blue "custom" badge. | |
| IDX-30 | Upload broken YAML (for example the text `not: [valid`) the same way. | The request is rejected with an error mentioning "invalid definition" and nothing is added to the catalogue. | |
| IDX-31 | Drop another valid `.yml` file into the `definitions` folder by hand, then run `curl -X POST http://<host>/api/v1/indexer/definition/reload -H "X-Api-Key: <key>"`. | The reply lists `total`, `builtin` and `custom` counts (custom has increased by one) and an `errors` list naming any broken files. | |
| IDX-32 | Delete the custom one: `curl -X DELETE http://<host>/api/v1/indexer/definition/mysite -H "X-Api-Key: <key>"`. | HTTP 204. "My Site" is gone from the catalogue (click the catalogue Reload button if it is still shown). Deleting a built-in id such as `yts` is refused with HTTP 404. | |

## Priority, tags, status and backoff

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| IDX-33 | Edit an indexer, open the advanced options and set Priority to 5. Then try 0 and 51. | 5 is accepted and the card shows "priority 5". 0 and 51 are refused (valid range is 1 to 50, default 25). | |
| IDX-34 | Edit an indexer and click a tag chip in Tags so it is highlighted, then Save. | The tag is saved. If no tags exist yet the field says "No tags defined yet." (create tags from a library item first). An empty selection means the indexer is used for everything. | |
| IDX-35 | Add a Torznab indexer pointing at a dead address (for example `http://localhost:1`) and click "Test all" at the top of the page. | The dead card shows a red line "Test failed: ..." with a message; working cards show "Test passed (N releases)". | |
| IDX-36 | Leave the dead indexer enabled and run a few searches on the Search page (or run System -> Tasks -> RssSync -> Run now several times). | The dead card's badge turns yellow "failing (N)" and then red "disabled for ..." (for example "disabled for 5 minutes"). Hovering shows "Disabled until ... after N failures". Each further failure lengthens the wait (5, 15, 30, 60 minutes, up to 24 hours). While disabled it is skipped by searches. | |
| IDX-37 | Fix the dead indexer's URL and save. After the wait has passed, run System -> Tasks -> IndexerStatusCheck -> Run now (otherwise it runs hourly). | The indexer is re-probed and its badge returns to green "ok". | |

## Indexer Proxies

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| IDX-38 | Open Settings -> Indexer Proxies. | Page "Indexer Proxies" with the subtitle "FlareSolverr and HTTP/SOCKS5 proxies for indexer requests" and a "+ Add proxy" card. | |
| IDX-39 | Click "+ Add proxy". | Dialog "Add indexer proxy" opens with Name, Type (FlareSolverr, HTTP, SOCKS5), Host, Port, Request timeout (advanced) and Tags. Type defaults to FlareSolverr with host `http://localhost` and port 8191. | |
| IDX-40 | Change Type to HTTP, then SOCKS5. | The port changes to 8080 for HTTP and 1080 for SOCKS5, and Username and Password fields appear. For FlareSolverr they are hidden. | |
| IDX-41 | Choose FlareSolverr, Name "FlareSolverr", Host `http://localhost`, Port 8191 with a FlareSolverr container running, and click Test. | Green "Test passed" with a message and a time in ms. With nothing listening, a red "Test failed" with the reason. | |
| IDX-42 | Click Save. | A card "FlareSolverr" appears with a blue "FlareSolverr" badge, the address `http://localhost:8191` and the line "no tags (explicit use only)". | |
| IDX-43 | Edit it, click a tag chip in Tags and Save. | The card now says "tags: <tag name>". | |
| IDX-44 | Add an HTTP proxy with a Password, save it, then reopen it. | The password is not shown in clear text (masked). Saving again without retyping keeps the stored password. | |
| IDX-45 | Edit a catalogue indexer (for example 1337x) and open the Proxy drop-down. | The choices are "By tag (automatic)" followed by each proxy as "Name (type)". Choosing one and saving makes the card show a line "proxy: <name>". | |
| IDX-46 | Edit a proxy, click Delete and confirm "Delete FlareSolverr?". | The proxy card disappears. Indexers that used it fall back to automatic tag matching. | |

## Indexer Options

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| IDX-47 | Open Settings -> Indexer Options. | Fields: Minimum age (min), Retention (days), Maximum size (MB), RSS sync interval (min), Allow hardcoded subs, Prefer indexer flags, and a Save button. The default RSS sync interval is 15. | |
| IDX-48 | Set Minimum age to -1. | The error "Enter a whole number, 0 or more" appears and Save is disabled. | |
| IDX-49 | Set RSS sync interval to 5, then 1500, then 0, then 30. | 5 and 1500 show "Use 0 (off) or 10 to 1440 minutes" and disable Save. 0 and 30 are accepted. | |
| IDX-50 | Turn "Allow hardcoded subs" off. | A field "Whitelisted subtitle tags" appears. Enter `ENG, HC.ENG`. Turning the toggle on hides the field. | |
| IDX-51 | Set Maximum size 5000, Retention 3000, RSS sync interval 30, switch Prefer indexer flags on, click Save, then reload the page. | All values are still there after the reload. | |
| IDX-52 | After saving an RSS interval of 30, open System -> Tasks and look at the "RssSync" row in the Scheduled table. Then set the interval to 0, save and look again. | The Interval column shows a 30-minute schedule (`*/30 * * * *`). With 0 the job has no schedule and only runs on demand. | |

## RSS sync

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| IDX-53 | Open System -> Tasks. In the Scheduled table find "RssSync" and click "Run now". | A new row appears in the History table: Job "RssSync", Trigger "manual", a Status that ends as completed, and a Message like "N new releases". | |
| IDX-54 | Switch off all three toggles on every indexer, then repeat IDX-53. | The run completes with "0 new releases" and does not fail. Switch the toggles back on afterwards. | |

## Indexer Stats

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| IDX-55 | Click Indexers -> Stats in the sidebar on an install that has not queried anything. | Page "Indexer Stats" with a "Window" drop-down showing "Last 30 days", and the message "No indexer activity yet" with "Stats appear once indexers have been queried." | |
| IDX-56 | After running some searches, reload the page. | Four tiles (Queries, Grabs, Failures, Avg response), a chart "Queries per indexer", a chart "Daily activity" with the legend Queries / Grabs / Failures, and a table "Per indexer" with columns Indexer, Queries, Grabs, Failures, Failure rate, Avg response. | |
| IDX-57 | Change the Window to "Last 7 days" and then "Last 90 days". | The figures reload each time. There are exactly three choices: 7, 30 and 90 days. | |
| IDX-58 | Click the "Failures" column header in the table. | Rows sort by failures; clicking again reverses the order. | |

## Search page

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| IDX-59 | Click Search in the sidebar. | Page "Search" with the subtitle "Search every indexer at once", a form (query box, Type, Categories, Indexers, Search button) and the message "Search your indexers". The Search button is disabled while the query is empty. | |
| IDX-60 | Type "ubuntu" and click Search. | A results table appears with columns Age, Title, Indexer, Size, Peers, Protocol, Categories and an actions column. The card title reads "N of N results". The address bar ends with `/search?q=ubuntu`. | |
| IDX-61 | Type "big buck bunny" in the top bar box ("Search library or indexers...") and press Enter while no library match exists. | You land on `/search?q=big%20buck%20bunny` and the search runs automatically. | |
| IDX-62 | Open `/search?q=ubuntu` directly in the address bar. | The query box is pre-filled and the search runs. | |
| IDX-63 | Set Type to "TV" and open Categories; then set Type to "Movies" and open it again. | The category list is narrowed to the 5000-range for TV and the 2000-range for Movies. Changing Type clears chosen categories. | |
| IDX-64 | Open the Indexers multi-select. | Only indexers with Interactive search enabled are listed. Choosing one restricts the results to that indexer. | |
| IDX-65 | Use the "Filter titles" box and the Protocol drop-down (Any protocol, Torrent, Usenet). | The table filters live and the heading changes to "x of N results". | |
| IDX-66 | Click the Age and Size headers. | Rows sort by that column; the default is youngest first. | |
| IDX-67 | Click the ".torrent" button on a torrent result (or "magnet" when the result is a magnet). | A .torrent file downloads, or your torrent app is offered the magnet link. On a usenet result the button reads ".nzb". | |
| IDX-68 | Click "Grab" on a result that matches a series or movie in your library. | A toast "Sent to download client" with the release title appears and the item shows up in Activity -> Queue. | |
| IDX-69 | Click "Grab" on a result that matches nothing in your library. | A dialog "Force grab?" appears saying the release does not match anything in your library, that it will go to the default client for its protocol, show as unknown in the queue and not be imported. | |
| IDX-70 | Click Cancel in that dialog. | Nothing is sent to a download client. | |
| IDX-71 | Click Grab again and confirm with "Force grab". | A toast "Force-grabbed (not tracked in the library)" appears and the download shows in Activity -> Queue as an unknown item. | |
| IDX-72 | Without the dialog: via API, run `curl -X POST http://<host>/api/v1/search/grab -H "X-Api-Key: <key>" -H "Content-Type: application/json" -d "{\"guid\":\"<guid>\",\"indexerId\":1}"` for the same unmatched result. | HTTP 409 with code NO_MATCH and a message ending "grab with force to send it anyway". Adding `"force":true` succeeds. | |
| IDX-73 | Wait more than a few minutes after a search (or restart the app), then click Grab on an old result. | A red toast "Grab failed" with a message like "Release not found; search again before grabbing". | |
| IDX-74 | Search while every indexer is disabled or failing. | The table shows "No results" with "Try fewer words, another type or more categories.", or an error panel with a Retry button. The page does not crash. | |

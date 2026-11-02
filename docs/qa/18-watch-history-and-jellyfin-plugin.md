# Watch History Sync and the Jellyfin Plugin

This file covers the read-only sync from Jellyfin or Emby into Arclight (play state, plays, accounts), the places that show it, retention using it, and the API used by the Arclight Jellyfin plugin.
Prerequisites: signed in as an admin; a TMDB key; at least one title in the library that also exists in a Jellyfin (or Emby) server; that server has two accounts, `alice` and `bob`, and you can play and mark items in it. Files 01 and 02 done. Use a test server, not your real one: the checks mark items played and unplayed.
Test environment: any. The rows marked "(plugin)" need the Arclight Jellyfin plugin installed in Jellyfin; they can be done with `curl` instead where the row says so. Rows marked "via API" use `curl` with the API key from Settings -> Security (`X-Api-Key: <key>`). `BASE` is your Arclight address, for example `http://localhost:7878`.

## Media server entry and sync

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| WHS-01 | Open Settings -> Media Servers, press "Add media server", choose Jellyfin and look at the switches. | "Sync watch history" is on by default. Choosing Plex hides or ignores it. | |
| WHS-02 | Fill in your Jellyfin URL and API key, press Test, then Save. | Test shows the server name, version and libraries. After saving, the server card has a "Watch history" panel with a "Sync" chip and buttons Sync now, Full resync, Sync users and Accounts. | |
| WHS-03 | Wait up to the sync interval (default 10 minutes) or press "Sync now". Reload the panel. | Toast "<name>: 2 users, N changes". The panel shows Last sync and Last full read with times, "Items tracked" above 0, "Accounts" "0 linked of 2" (or more accounts). | |
| WHS-04 | Press Accounts. | A dialog "Synced accounts on <name>" lists `alice` and `bob` with their state (an "Admin" badge for administrators) and "Not linked" under "Arclight user". | |
| WHS-05 | In Jellyfin, log in as alice and play a movie (that is in the Arclight library) to the end, or mark it played. In Arclight press "Sync now". | Toast with at least 1 change. Open Activity -> Watch history: a "Played" row for alice and that movie appears with the server name. | |
| WHS-06 | In Jellyfin mark that movie unplayed for alice. Press "Sync now". Then press "Full resync". | After Sync now the history may not change (an incremental read cannot see it). After Full resync a "Marked unplayed" row appears. | |
| WHS-07 | Switch "Sync watch history" off for the server, save, and look at the panel. Press Test. | The panel shows the "Sync off" chip. A manual sync is refused. Switch it on again afterwards. | |
| WHS-08 | Open the "Watch history" settings form (same section): set "Sync every (minutes)" to 5, "Full read every (hours)" to 12, "Keep plays for (days)" to 30 and Save. Reload. | Toast "Watch history settings saved"; values persist. Under System -> Tasks the `MediaServerWatchSync` interval is now `*/5 * * * *`. Restore the defaults (10, 24, 400). | |
| WHS-09 | Try "Sync every" 1 and "Keep plays for" 3, then Save. | The form refuses values outside 5 to 1440 and 7 to 3650. | |
| WHS-10 | Open System -> Tasks. | The jobs `MediaServerWatchSync` (interval from the setting), `MediaServerUserSync` (`5 * * * *`) and `WatchHistoryCleanup` (`45 4 * * *`) are listed. Run now on `MediaServerWatchSync` completes with a message like "<name>: 2 user(s), 0 change(s), 0 play(s)". | |
| WHS-11 | Stop the Jellyfin server (or change the stored URL to a wrong address and Save). Press "Sync now". | A red toast "Watch history sync failed" with a reason; the panel's chip shows "Failed". The `MediaServerWatchSync` task in History is red. Restore the server and the next sync turns the chip back to "OK". | |

## Accounts and user sync

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| WHS-12 | In Jellyfin create a third account `carol`. In Arclight press "Sync users". | Toast "Users synced: 1 new, 0 renamed, 0 gone". Accounts now lists `carol`. No Arclight user is created unless Sign-in and "Create users on sign-in" are on and new users are set to automatic. | |
| WHS-13 | In Jellyfin rename `carol` to `caroline`. Press "Sync users". | Toast "1 renamed" only if carol was linked; Accounts shows the new name. | |
| WHS-14 | Import bob: Settings -> Security (or the media server import panel) -> Import users, pick `bob`. Open the Accounts dialog. | `bob` shows his Arclight username. The history that bob had before the import now shows under his Arclight user. | |
| WHS-15 | In Jellyfin disable `bob`, then press "Sync users". If bob signs in to Arclight through Jellyfin only, he is signed out. | Accounts shows "Disabled" for bob. A signed-in session of bob (media-server-only user) is revoked. Signing in as bob through Jellyfin is refused. Re-enable him afterwards. | |
| WHS-16 | In Jellyfin delete `carol`, then press "Sync users". | Accounts shows `carol` as "Deleted". Her earlier plays are still in Activity -> Watch history (as the account name). | |

## Where the history shows

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| WHS-17 | Open Activity -> Watch history as admin. Use "Filter by user" to pick alice. | A table of plays with When, Event, user, title, Server, Device and similar columns. The filter limits it to alice. Paging works (Previous, Next, "Page 1 of N"). | |
| WHS-18 | Sign in as bob (a portal user) and open his Profile. | A "Watch history" pane lists only bob's plays. Bob has no Activity menu, and `BASE/api/v1/watchhistory?userId=<alice's id>` as bob returns only bob's records. | |
| WHS-19 | As admin open the movie that alice played, then its "Watched by" tab. | A row for alice with "Watched", play count, last played, server and a favourite marker if she favourited it. | |
| WHS-20 | Open a series page; in Jellyfin play two episodes as alice. Press "Sync now" and open its "Watched by" tab. | Alice's row reads "2 of N episodes". After she plays every present episode the row reads as watched. | |
| WHS-21 | Open a title nobody watched, "Watched by" tab. | "Nobody has watched this yet". | |
| WHS-22 (plugin) | Start playing a movie as alice in Jellyfin and leave it running. Open the Dashboard as admin. | A "Now playing" panel lists the session: title, user, device, client and position, and "Transcoding" when the stream transcodes. It disappears a few minutes after you stop playback. | |
| WHS-23 | Via API: `curl -H "X-Api-Key: <key>" "BASE/api/v1/watchhistory?pageSize=5&type=played"`, then `curl -H "X-Api-Key: <key>" BASE/api/v1/mediaserver/<server id>/sync`. | First call: `{page, pageSize, totalRecords, records[]}` with only `played` events. Second: sync status with `watchSyncEnabled: true`, `lastStatus: "ok"` and `itemsTracked`. | |
| WHS-24 | Via API: `curl -X POST -H "X-Api-Key: <key>" -H "Content-Type: application/json" -d '{"full":true}' BASE/api/v1/mediaserver/<server id>/sync`. Repeat the call twice at once from two terminals. | 200 with `status: "ok"`. The overlapping second call can answer 409 "a watch-history sync is already running". An unknown id answers 404; a Plex server answers 400. | |

## Retention with stored history

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| WHS-25 | Switch "Retention" on for the Jellyfin server. In Library -> Retention add a rule: media type Movies, condition "Watched by any user", Dry run on, Grace period 0. Press "Sweep now (dry run)". | The movie alice finished appears as a match with a reason naming alice. Nothing is staged or applied. | |
| WHS-26 | Edit the rule: use "Watched by these users" with the name `alice`; Sweep now (dry run). Repeat with alice's display name, and with the Jellyfin account name. | The movie matches for the username, the display name and the server account name. A name nobody has does not match. | |
| WHS-27 | Add a rule with the condition "Not watched by its requester in N days" (90). Request a movie as alice (file 09), let it import, and press Sweep now (dry run). | It does not match: the request is newer than 90 days. (Setting the days to 1 and waiting a day, or editing the request's date in a test database, is the only way to see a match; skip if you cannot.) | |
| WHS-28 | On a rule, switch on "Keep items a requester has not watched yet" and sweep (dry run) for a movie alice requested but never played. | The movie is not a match and the preview says a requester has not watched it yet. After alice plays it and a sync runs, it can match. | |
| WHS-29 | Stop the Jellyfin server and sweep (dry run) right after a failed sync. Then wait for the stored data to become stale (twice the full-read interval, at least 6 hours) if you can. | Rules that need watch conditions are skipped for the sweep ("server could not be read" style message); no candidate is dropped or applied. | |

## Favourites and the watchlist

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| WHS-30 | Link alice to a Jellyfin account (Profile -> media server link) and, in Jellyfin as alice, favourite a movie. Run `WatchlistSync` from System -> Tasks. | The movie appears on alice's watchlist. | |
| WHS-31 | In Jellyfin favourite an episode of a series. Run `WatchlistSync`. | The series appears on the watchlist (episodes count for their series). | |
| WHS-32 | In Jellyfin favourite a music album or an audiobook. Run `WatchlistSync`. | Nothing new appears on the watchlist (music and audiobook favourites are not mirrored). | |

## Jellyfin plugin: keys and setup

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| JFP-01 | Open Settings -> Media Servers and find the "Jellyfin plugin" card. | A repository URL `https://arclight.moviemethat.com/jellyfin/manifest.json` with a copy button, a "Plugin keys" list (empty: "No plugin keys yet") and "Plugin connection per server" rows for each Jellyfin/Emby server. | |
| JFP-02 | Press "Create plugin key", keep the default name `Jellyfin plugin` and press Create. | Toast "Plugin key created". The key (starting `alj_`) is shown once with the note that it is not shown again. After closing, the list shows only the prefix (`alj_...`), Last used and Last ping empty. | |
| JFP-03 | A server whose entry has never been tested shows "Test this server once so Arclight learns its id." Press Test on the media server entry, then reload the card. | The hint disappears; the server row shows "Not connected" until the plugin sends events. | |
| JFP-04 (plugin) | In Jellyfin: Dashboard -> Plugins -> Repositories -> add the repository URL, install the Arclight plugin, restart, then open its settings and paste the Arclight URL and the key. | The plugin reports success. In Arclight the key's Last ping fills in and the server row shows "Connected" and, after you play something, "last event <time>". | |
| JFP-05 | Press "Delete key" on the key and confirm. | The key disappears. A plugin still using it is refused (see JFP-07). Create a new key for the remaining checks. | |

## Jellyfin plugin: API (via API)

Use `PKEY` for the plugin key and `JID` for alice's Jellyfin user id (from the Jellyfin user URL). Alice must be linked to an Arclight user (WHS-14 style, or a profile link) with the Request permission.

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| JFP-06 | `curl -H "X-Api-Key: PKEY" BASE/api/v1/jellyfin/ping` | `{version, serverName, features[], linkedUsers}`; features include `events`, `status`, `search`, `title`, `request`, `languageRequest`, `issue`, `watchlist`. The key's Last ping updates on the plugin card. | |
| JFP-07 | Call `BASE/api/v1/jellyfin/ping` with a wrong key, then call `BASE/api/v1/series` and `BASE/api/v1/settings/jellyfinplugin` with the real plugin key. | Wrong key: 401. The plugin key on any other route: 403 "this key may only call /api/v1/jellyfin/*". | |
| JFP-08 | `curl -H "X-Api-Key: PKEY" "BASE/api/v1/jellyfin/search?q=matrix"` (no user header). | 400 `{code: "missing_user"}`. | |
| JFP-09 | The same with `-H "X-Arclight-Jellyfin-User: JID"`. Then with a made-up id. | First: a page of results with `status` and `canRequest`. The made-up id: 403 `{code: "not_linked"}` (unless "Create users on sign-in" with automatic new users is on and the id exists on the server; then the account is imported). | |
| JFP-10 | `curl -H "X-Api-Key: PKEY" -H "X-Arclight-Jellyfin-User: JID" BASE/api/v1/jellyfin/title/movie/<a tmdb id>` | Title detail with `status`, `canRequest`, `seasons` (empty for movies), `requests`, `onWatchlist`, `languages`. `tv` works as an alias of `series`. | |
| JFP-11 | `curl -X POST -H "X-Api-Key: PKEY" -H "X-Arclight-Jellyfin-User: JID" -H "Content-Type: application/json" -d '{"mediaType":"movie","tmdbId":<id>}' BASE/api/v1/jellyfin/request` | 201 with the request, owned by alice. It shows in Requests with alice as requester, obeys her quota, and auto-approves only if her permissions say so. Repeating it is refused as a duplicate (409). | |
| JFP-12 | POST `/jellyfin/issue` with `{"mediaType":"movie","tmdbId":<id>,"type":"video","message":"Out of sync"}`. | 201 with the issue; it appears under Issues, filed by alice. | |
| JFP-13 | POST `/jellyfin/language-request` with a subtitle language body (see `POST /request/language`) for a library title. | 201 with the language request, filed by alice; a user without the language permission gets 403. | |
| JFP-14 | POST `/jellyfin/watchlist` with `{"mediaType":"movie","tmdbId":<id>}`, then GET `/jellyfin/watchlist`. | 201; the item is on the list and on alice's Watchlist page. | |
| JFP-15 | DELETE `/jellyfin/watchlist?mediaType=movie&tmdbId=<id>`, then repeat the call. Also try `DELETE /jellyfin/watchlist` with no query. | 204; second call 404 "not on your watchlist"; the empty query 400. | |
| JFP-16 | Try to DELETE a watchlist item that was mirrored from a Jellyfin favourite (WHS-30). | 409 "this item is a Jellyfin favourite; unfavourite it in Jellyfin". | |
| JFP-17 | POST `/jellyfin/status` with `{"items":[{"id":"x","type":"Movie","providerIds":{"Tmdb":"<id of a library movie>"}}]}`. | `inLibrary: true`, `monitored`, and a `request` block if one exists. A movie not in the library gives `inLibrary: false`. | |
| JFP-18 | `curl -H "X-Api-Key: PKEY" -H "X-Arclight-Jellyfin-User: JID" "BASE/api/v1/jellyfin/status?items=<jellyfin item id>"`. | The same shape; Arclight looked the item up on Jellyfin. More than 100 ids: 400. With the Jellyfin server stopped: 502. | |

## Jellyfin plugin: events (via API)

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| JFP-19 | Find the server id: open `http://<jellyfin>/System/Info/Public` and copy `Id`. POST to `/jellyfin/events` with `{"serverId":"<Id>","events":[{"type":"playbackStart","at":"<now ISO>","jellyfinUserId":"JID","item":{"id":"abc","type":"Movie","name":"Test","providerIds":{"Tmdb":"<library movie tmdb id>"}},"sessionId":"s1"}]}`. | 202 `{"accepted":1}`. Dashboard "Now playing" shows the session; Activity -> Watch history shows a "Started" row after enabling progress. The server's "last plugin event" updates. | |
| JFP-20 | Send the same batch again. | 202 `{"accepted":1}`; no second "Started" row appears (duplicates are stored once). | |
| JFP-21 | Send a `playbackProgress` event, then another 10 seconds later with the same `sessionId`. | Both accepted; only one progress event is stored for that minute. Then send `playbackStop`: Now playing clears. | |
| JFP-22 | Send `userDataSaved` with `played: true`, `playCount: 1`, `isFavorite: true` for the library movie, then `played: false`. | The title's "Watched by" row flips to watched, then back; a "Played" and then a "Marked unplayed" event appear without waiting for a full read. | |
| JFP-23 | Send events with a made-up `serverId`. | 404 `{code: "UNKNOWN_SERVER"}` with a hint to test the connection once. | |
| JFP-24 | Send a batch of 501 events. | 400 validation error. | |
| JFP-25 | Send an event with a bad `at` (for example `"not a date"`). | The batch answers 202 but the bad event is not counted in `accepted`. | |

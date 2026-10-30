# Import Lists and Notifications

This checklist covers Settings -> Import Lists (every list kind, test, sync, exclusions, library cleaning, Trakt sign-in) and Settings -> Notifications (every agent, test button, event flags, health alerts, request alerts and media-server refresh).
Prerequisites: a root folder and quality profile for TV and movies, a TMDB-backed Arclight install, a Discord webhook URL or a webhook.site address as a test target, and optionally Jellyfin, Emby, Plex, Telegram, ntfy, Gotify, Pushover, an SMTP server and a Trakt app (client id and secret).
Test environments: Native (http://localhost:17878), Docker (http://<host>:7878) and NAS. Mark which agents you could actually reach; skip the rest and note it in the Pass/Fail cell.
Features without a screen are marked "via API" and use the API key from Settings -> Security with the header `X-Api-Key`.

## Import lists: add, test and sync

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| IML-01 | Open Settings -> Import Lists. | Title "Import Lists" with the cards "Lists", "List exclusions" and "Options", and a "Sync now" button. | |
| IML-02 | Click "Add list". | Modal "Add import list" shows the kinds: TMDB List, TMDB Popular, TMDB Collection, TMDB Person, TMDB Keyword, Trakt List, Trakt Popular, Trakt User, Plex Watchlist, IMDb List, RSS / JSON feed, StevenLu Popular Movies. Trakt kinds carry a "Trakt auth" badge. | |
| IML-03 | Choose "TMDB Popular". Name = "QA Popular Movies", Media type = Movies, List type = "Popular", Limit = 10, Root folder = movie folder, Quality profile = "HD-1080p", Monitor on, "Add automatically" OFF. Click "Test". | Text "N items found" and a "First items" table with movie titles appear. Nothing is added to the library. | |
| IML-04 | Click "Save". | The list card shows status "Enabled", a "Movies" badge, "No auto add", and "Last sync: never". | |
| IML-05 | Click "Preview items" on the card. | Dialog "Items in QA Popular Movies" lists items, each with a state badge "New", "In library" or "Excluded". | |
| IML-06 | Click "Sync now" at the top. | Toast "Synced 1 list(s)" with text like "10 fetched, 0 added, 0 already in library, 0 excluded". Because "Add automatically" is off, the library does not change. | |
| IML-07 | Edit the list, turn "Add automatically" ON, set Minimum availability = "Released", leave "Search on add" OFF, save, then click "Sync now". | Toast shows "10 fetched, N added". The new movies appear in Library -> Movies, monitored, and no search runs (Activity -> Queue unchanged). | |
| IML-08 | Edit the list, turn "Search on add" ON, change the Limit to 20 and save. Click "Sync now". | Newly added movies are searched at once; the Queue or Wanted page reflects the searches. The card badge shows "Search on add". | |
| IML-09 | Click "Sync now" again. | Toast shows 0 added and the earlier items as "already in library". | |
| IML-10 | Create a series list: kind "TMDB Popular", Media type = Series, List type = "Trending (week)", Series root folder, Monitor = "Future episodes", Series type "Standard", Season folders on. Save and sync. | Series appear in Library -> TV with only future episodes monitored. | |
| IML-11 | Create a "TMDB List" with a public TMDB list id (List id = 8268337 or any list you know). Click "Test". | Test reports the number of items. An invalid id reports an error message and does not save. | |
| IML-12 | Create a "TMDB Collection" list with Collection id = 10 (Star Wars collection). Test. | Shows the collection movies (movies only). | |
| IML-13 | Create a "TMDB Person" list with Person id = 525 (Christopher Nolan), tick "Include crew credits" and Crew jobs = "Director". Test. | Items are his directed films. | |
| IML-14 | Create a "TMDB Keyword" list with a keyword id (for example 9715, superhero). Test. | Items found are listed. | |
| IML-15 | Create an "IMDb List" with List or user id = a public list such as `ls003345613`. Test. | Items are listed, or a clear error if IMDb blocks the request. | |
| IML-16 | Create an "RSS / JSON feed" list with a Feed URL that returns movie titles with TMDB or IMDb ids. Test. | Items are listed. A bad URL gives an error and the list cannot be saved as working. | |
| IML-17 | Create a "StevenLu Popular Movies" list with its Feed URL. Test. | Items are listed; the media type is movies only. | |
| IML-18 | Create a "Plex Watchlist" list with a Plex token. Test. | Items from your Plex watchlist are listed. A wrong token gives an error. | |
| IML-19 | Switch the "Media type" of a new list to "Series & movies". | Two root folder fields appear: "Series root folder" and "Movie root folder". | |
| IML-20 | Open the list card for a list that failed to fetch (use a bad Feed URL). | Status badge "Error" with a message. Other lists still sync normally. | |

## Import lists: Trakt, exclusions, cleaning and schedule

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| IML-21 | Add a "Trakt Popular" list. Do not enter a client id; click "Authenticate with Trakt". | Message "Enter the Trakt client id first." Enter a client id only and try again: "Enter the Trakt client secret first." | |
| IML-22 | Fill both Trakt client id and secret and click "Authenticate with Trakt". | Text "Go to <url> and enter the code <code>." and "Waiting for authorization…" with a Cancel button appear. | |
| IML-23 | Open the shown URL in another browser tab, sign in to Trakt and enter the code. | The editor shows "Authorized with Trakt. Save the list to keep the tokens." The access token, refresh token and expiry fields are filled and read-only. The button now reads "Re-authenticate with Trakt". | |
| IML-24 | Click "Save", then "Test" on the saved list. | "N items found" is shown. | |
| IML-25 | Start the Trakt flow again and click "Cancel" while waiting. | Waiting text disappears, no tokens change. If you let the code expire: "The code expired before it was entered. Try again." If you deny it on Trakt: "Authorization was denied on Trakt." | |
| IML-26 | Add a "Trakt List" (Username, List name slug) and a "Trakt User" list (Username, List = Watchlist). Test each. | Items from the Trakt list or watchlist are listed. | |
| IML-27 | On the "List exclusions" card choose Exclusion type = Movie, TMDB id = 438631, Title = "Dune", Year = 2021 and click "Add exclusion". | Row appears with Title, Year, Type and TMDB id. Empty card text before: "No exclusions." | |
| IML-28 | Click "Preview items" on a list that contains an item, then click "Exclude" on one row. | The row's state changes to "Excluded" and it appears in "List exclusions". | |
| IML-29 | Remove the library copy of an excluded movie (Library -> Movies -> Delete), then click "Sync now". | The excluded movie is not re-added; toast shows it under "excluded". | |
| IML-30 | Click "Remove" on an exclusion row, then sync. | The item is added again at the next sync. | |
| IML-31 | In the "Options" card set "Sync interval (hours)" to 0 and click "Save options". | Error "Enter 1 to 168 hours" and nothing is saved. Set 6 and save: success toast. | |
| IML-32 | Set "Clean library level" = "Log only", save, remove an item from the source list (or use a list that no longer contains a library item), then "Sync now". | The library is unchanged, but a log line records the item that would be cleaned (System -> Logs). | |
| IML-33 | Set "Clean library level" = "Unmonitor" and sync again. | Items that came from the list but are no longer on it become unmonitored. When "Clean only tagged" is shown, ticking it limits this to tagged items. Cleaning only happens when all enabled lists fetched successfully; with one list in Error, nothing is cleaned. | |
| IML-34 | Open System -> Tasks. Click "Run now" beside "ImportListSync". | The job runs; the "History" card shows a new entry and the list cards show an updated "Last sync". | |
| IML-35 | On a list card click the Delete action (in the editor footer) and confirm "Delete <name>?". | The list is gone. Items it added earlier stay in the library. | |
| IML-36 | Via API run `curl -s BASE/api/v1/importlist -H "X-Api-Key: KEY"`. | JSON array with the lists you created, secrets (tokens, secret) masked. | |

## Notifications: setup and per-agent tests

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| NOT-01 | Open Settings -> Notifications. | Title "Notifications" and the subtitle "Connections notify other apps and services about grabs, imports and health issues." plus an "Add connection" card. If the page fails to load or shows an error, record it (the web form schema may not match the API). | |
| NOT-02 | Click "Add connection". | Modal "Add connection" lists Discord, Telegram, Webhook, Email, Custom Script, ntfy, Gotify, Pushover, Jellyfin, Emby and Plex Media Server. | |
| NOT-03 | Choose Discord. Name = "QA Discord", Webhook URL = your webhook, Username = "Arclight". Under "Notify on" tick Grab and Download. Click "Test". | Result "sent" (success) and the message "This is a test notification from Arclight." appears in the Discord channel. | |
| NOT-04 | Click Save. | The card "QA Discord" appears with the badges of the ticked events. A card with no events shows "no events". | |
| NOT-05 | Edit the Discord connection and look at the Webhook URL field. | The saved secret is masked as `********`. Saving without retyping keeps the stored value (test still works). | |
| NOT-06 | Add a Discord connection with a wrong webhook URL (for example `https://discord.com/api/webhooks/0/bad`) and click "Test". | A failure message is shown and the connection is not reported as sent. Delete it afterwards. | |
| NOT-07 | Add Telegram: Bot Token, Chat Id (optional Topic Id, "Send silently", "Include link"). Click "Test". | Message arrives in the chat. A wrong token shows an error. | |
| NOT-08 | Add Webhook: Url = your webhook.site address, Method = POST, optional Username/Password and a header. Click "Test". | The request shows up on webhook.site as POST with a JSON body containing the test text. Switch Method to PUT and test: it arrives as PUT. | |
| NOT-09 | Add Email: Host, Port 587, Security = "STARTTLS", Username, Password, From, To, Subject prefix "[Arclight]". Click "Test". | An email arrives with subject starting "[Arclight]". Wrong credentials show an error. | |
| NOT-10 | Add Custom Script: Path to a script that writes its arguments to a file (Native: a .ps1 or .bat; Docker/NAS: a shell script inside the container), Timeout 10000. Test. | The script runs and the output file appears. A missing path shows an error. | |
| NOT-11 | Add ntfy: Server URL (https://ntfy.sh), Topics = a random topic name, Priority 3. Test. | A push arrives in the ntfy app or web page for that topic. | |
| NOT-12 | Add Gotify: Server URL, App token, Priority 5. Test. | Message shows in Gotify. | |
| NOT-13 | Add Pushover: Api token, User key. Test. | Push arrives on the device. | |
| NOT-14 | Add Jellyfin: Host, Port 8096, Use SSL as needed, Api Key, "Update library" on. Click "Test". | Test reports success. A wrong API key reports an error. | |
| NOT-15 | Add Emby with Host, Port 8096, Api Key, "Update library" on. Test. | Success or a clear connection error. | |
| NOT-16 | Add Plex Media Server: Host, Port 32400, Auth token, "Update library" on. Test. | Success or a clear connection error. | |
| NOT-17 | Click delete on a connection and confirm "Delete <name>?". | The card disappears and no further messages are sent from it. | |

## Notifications: events, health, requests and media-server refresh

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| NOT-18 | Open the editor of the Discord connection. Look at "Notify on". | The checkboxes are Grab, Download, Upgrade, Series add, Movie add, Series delete, Movie delete, File delete, Health issue, Health restored, Application update, Manual interaction required. Rename is not offered for message agents. | |
| NOT-19 | Webhook and Custom Script connections: open their "Notify on" list. | Every event is available, including Rename. | |
| NOT-20 | Untick everything except Series add on Discord, save, then add a series. | Only one message "series added" arrives. Grabbing or importing sends nothing. | |
| NOT-21 | Tick Grab, trigger a search that grabs a release. | A grab message with the release title arrives. | |
| NOT-22 | Tick Download and Upgrade, import an episode, then import an upgrade of it. | A message for each; the upgrade message says it replaced a file. | |
| NOT-23 | Tick Series delete, delete a test series. | A message arrives naming the series. | |
| NOT-24 | Tick Health issue and Health restored. Cause a warning (for example disable the only indexer) and wait a few minutes. Re-enable it. | A health message arrives when the warning appears, and a "restored" message when it clears. System -> Health matches. | |
| NOT-24a | With Settings -> Requests -> Application URL empty, trigger a health issue notification (as NOT-24) on a connection that shows links (for example Discord). | The message has no "More Info" link. | |
| NOT-24b | Set Application URL to the address you use to open Arclight, save, and trigger a health issue again. | The message has a "More Info" link that is an absolute address. Opening it lands on the matching entry in System -> Health docs. | |
| NOT-25 | Tick Manual interaction required and make an import need manual action (see file 06, FAIL-09). | A message arrives saying manual import is needed. | |
| NOT-26 | Via API toggle health warnings: `curl -s -X PUT BASE/api/v1/notification/ID ...` with `includeHealthWarnings` true (read the current body from `GET BASE/api/v1/notification/ID` first). | Warning-level health messages are also sent. There is no screen for `enabled` or `includeHealthWarnings`. | |
| NOT-27 | Via API: `curl -s -X POST BASE/api/v1/notification/testall -H "X-Api-Key: KEY"`. | A result per connection (sent or error). | |
| NOT-28 | Tags: create a tag "family", add it to a Discord connection and add a series without that tag. | The tagged connection does not fire for the untagged series. Adding the tag to the series makes it fire. | |
| NOT-29 | With Jellyfin (Update library on): import an episode or movie. | The item is visible in Jellyfin within about a minute with no manual scan. | |
| NOT-30 | With Emby (Update library on): import and then rename or delete a file. | Emby reflects the new, renamed or removed file. | |
| NOT-31 | With Plex (Update library on): import a file. | Plex lists the new file after a short delay. | |
| NOT-32 | Open the Profile page (user menu -> Profile), card "Notifications and watchlist". | Sections Discord, Telegram, Email, "Notify me about" and Plex watchlist are shown. | |
| NOT-33 | Tick Discord Enabled, enter your Webhook URL, tick "Request approved" and "Request available", click "Save". | Toast "Notification settings saved". | |
| NOT-34 | Click "Send test". | Result line "discord: sent" and the message arrives. With nothing enabled the result says "No personal agent is enabled." | |
| NOT-35 | As a user, create a request (see file 09), then approve it as admin. | The user's Discord receives "Request approved". When it is imported and available, "Request available" arrives. | |
| NOT-36 | Tick "Request pending approval (managers)" for an admin user, then create a request as another user. | The admin gets a "pending approval" message. | |
| NOT-37 | Report an issue on a title and update it (if issues are available). | "Issue reported" goes to managers and "Issue updated" goes to the reporter, based on the "Notify me about" ticks. | |

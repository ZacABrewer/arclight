# Requests, Discover, Issues and Watchlist

This file covers the request workflow in Arclight (the part that does the job of Seerr): browsing Discover, requesting a movie or series, approving or declining it as an admin, quotas, auto-approval, override rules, personal notifications, issues, and the watchlist. It also covers user accounts and the permission matrix, because requests depend on them.
Prerequisites: a TMDB API key entered in Settings -> General (field "TMDB API key") so Discover has content; at least one root folder (Settings -> Media Management) and one quality profile (Settings -> Profiles) so approved requests can be added to the library; an admin account and a second browser (or a private window) for the requesting user. A download client and indexer are only needed for the last step of the main flow ("Available").
Test environments: Native (http://localhost:17878) is enough for everything. Docker and NAS runs should repeat the main flow once. Prefixes: DSC = Discover, REQ = requests/users/quotas/settings, ISS = issues, WTC = watchlist.

## Discover browsing

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| DSC-01 | Sign in as admin and open Discover -> Home. | Page titled "Discover" with a search box "Search movies and series". Rows (sliders) appear such as "Trending", "Popular movies", "Upcoming movies", "Popular series", plus chip rows "Movie genres", "Studios", "Series genres", "Networks". Posters show a status badge when relevant ("Available", "Processing", "Requested"). | |
| DSC-02 | Click "See all" on the "Trending" row, then use the buttons All / Movies / Series and Today / This week. | The Trending page loads a poster grid. Each button press reloads the grid; the selected button is highlighted. Scroll down: more titles load automatically (or press "Load more"). Also open the "See all" link of "Upcoming movies": it shows "Upcoming movies" and the Movies/Series buttons switch to "Upcoming series". | |
| DSC-03 | Open Discover -> Movies. Set Sort to "Rating", Genre to "Comedy", Year from "2015", Min rating "7", then press Reset. | Title "Discover movies". The grid changes with every filter and returns to popularity order after Reset. Discover -> TV shows "Discover series" with the same filters. | |
| DSC-04 | On Discover -> Home click a genre chip (for example "Action" in Movie genres), then use the Movies / Series buttons at the top right. | A page named after the genre loads; the buttons switch between movie and series results. Go back and click a studio chip (for example "Marvel Studios") and a network chip (for example "Netflix"): each opens a grid titled with that name. | |
| DSC-05 | Type "Dune" in the Discover search box and press Enter. | URL ends with /discover/search?q=Dune, the title reads "Results for “Dune”", and movie and series results appear. Opening Discover search with no text shows "Type a title in the Discover search box." | |
| DSC-06 | Click a movie poster to open its title page. | The page shows poster, title with year, a status badge (for example "Not requested"), facts (Status, Release, Runtime, Rating, Genres, Director), overview, buttons Request, Report issue, "Add to watchlist", trailer links, and rows Cast, Recommendations, Similar. Click a cast member: a person page opens with Born, a biography and "Appearances (N)". | |

## Settings -> Requests (defaults, sliders, rules)

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| REQ-01 | Open Settings -> Requests. | Page "Requests" showing cards "Movie defaults", "Series defaults", "4K movies", "4K series", "Approval and behaviour", "Default quotas", "Default permissions for new users", "Discover sliders", "Override rules". Pick a Root folder and Quality profile under Movie defaults, click "Save request settings": toast "Request settings saved", values kept after reload. The "Allow partial series requests" switch controls whether the season picker (see the request dialog check below) appears. | |
| REQ-02 | In Discover sliders turn off "Trending" (switch "Show Trending"), move "Popular series" up with the arrow button, click "Save order". | Save order is enabled only after a change. In Discover -> Home the Trending row is gone and the order matches. | |
| REQ-03 | Click "Add slider", choose type "Movies by genre", Title "My Horror", genre id "27", click Save. Then "Add slider" with type "Series by keyword" and an empty Title and click Save. | The first slider appears and a Discover row "My Horror" shows horror movies. The second shows the error "Title and data are required." Then Edit the custom slider, Delete it (confirm), and use "Reset to defaults" (confirm "Reset sliders?"): built-in sliders carry a "built-in" badge and have no Edit/Delete. | |

## Users, permissions and roles

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| REQ-04 | Open Settings -> Security, scroll to the Users card and click "Add user". Enter Username "alice", Display name "Alice", Email "alice@example.com", Role "User", Password "alice-test-pw-1", then Save. | Dialog "Add user" closes and alice appears in the Users table with role user. (Users are created here, not on Settings -> Users.) | |
| REQ-05 | In the Manage dialog look at the tabs. | Dialog "Manage Alice" with tabs Permissions, Quota, Notifications. The Permissions tab groups checkboxes: Administration, Requesting, Auto-approve, Auto-request (watchlist sync), Issues, Visibility. | |
| REQ-06 | On the Permissions tab tick "Request" and "Report issues" and untick everything else, then click "Save permissions". | Toast "Permissions saved". Reopen Manage: boxes keep their state. | |
| REQ-07 | In a second browser sign in as alice. Look at the sidebar. | Alice sees Discover, Requests (All requests, My requests), Issues, Watchlist and similar; she does not see Settings, Subtitles, Indexers or System. The user menu has a Profile entry. | |
| REQ-08 | Make sure only one admin exists, then on Settings -> Security try to edit the admin and set Role to "User", then try to delete that admin. | Both actions are refused with a message "cannot demote the only admin" / "cannot delete the only admin". | |

## Requesting, approving and fulfilling

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| REQ-09 | As alice open a series title page with several seasons (for example "Severance") and click Request. | Dialog "Request Severance" with a "Seasons" group: "All seasons" plus "Season 1", "Season 2" with episode counts. Click the primary button with nothing ticked: the error "Pick at least one season." appears. | |
| REQ-10 | Click "Request 1 season". | Toast "Request submitted for approval". The title page now shows a "Pending" badge and a Requests card listing Alice, Standard, Season 1, "Pending approval". | |
| REQ-11 | As alice open Requests -> My requests. | Entry "Severance" with a Pending approval badge and a progress list: "Requested" (done), "Awaiting approval", "Available". A "Cancel request" button exists. | |
| REQ-12 | As admin open Requests -> All requests. | Tabs Pending, Approved, Declined, Available, All and a media type filter. Alice's request is under Pending with buttons Approve, Decline, Edit, Delete. | |
| REQ-13 | Click Edit on the request. Choose another Root folder and Quality profile under their drop-downs, tick Season 2 too, click Save. | Dialog "Edit request: Severance" closes; Seasons column now shows both seasons. (This is how overrides are set before approval; the Approve button itself has no options.) | |
| REQ-14 | Click Approve. | Status changes to "Approved" and, within a minute, the title appears in Library -> TV with only the requested seasons monitored (other seasons unmonitored). The title page badge becomes "Processing". | |
| REQ-15 | After the episodes are imported (or put the files in place and import them), open System -> Tasks and click "Run now" on "RequestsStatusSync". | Task History shows a message like "1 titles checked, 1 requests completed". The request moves to the Available tab with status "Completed" and the title page shows "Available" (or "Partially available"). My requests shows "Available" done. | |
| REQ-16 | Request a movie as alice, then select it and another pending request on the admin Requests page with the checkboxes and click "Approve selected". | A bar shows "2 selected". Toast "Approved 2 requests". "Decline selected" and "Clear" also exist on the bar. | |
| REQ-17 | Request another movie as alice. As admin click Decline, type reason "Already on disc", click Decline in the dialog "Decline <title>?". | Request moves to Declined tab with the reason shown. As alice, My requests shows a Declined badge and "Reason: Already on disc". | |
| REQ-18 | Make an approval fail: remove all root folders of that type (or set an invalid one), approve a pending request, then restore the folder. On the Approved/All tab press Retry. | The failed request shows a Failed badge with a red reason; after restoring the setup Retry makes it Approved again. | |

## Quotas, blocking rules and automatic approval

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| REQ-19 | In Settings -> Requests -> "Default quotas" set Movie request limit 1 and Movie window (days) 7, save. As alice (non-admin) request one movie, then another. | The second attempt shows the error "Movie Quota exceeded." in the dialog. Alice's Profile page "Request quota" shows "1 of 1 per 7 days · 0 left". | |
| REQ-20 | Settings -> Users -> Manage alice -> Quota tab: set Movie request limit 5 and click "Save quota". | Toast "Quota saved" and the text "Effective: 5 per ..." appears; alice can request again. Blank fields mean "use the global default". Admins and users with "Manage users" show "exempt from quotas". | |
| REQ-21 | As alice try to request a movie that already has an active request (Pending or Approved), or that is already in the library. | Error "this movie already has an active request (#N)" or "this movie is already in the library". For a series where every chosen season is already requested, the season checkboxes are disabled with a badge such as "Pending approval". | |
| REQ-22 | Add an import exclusion: Settings -> Import Lists, "List exclusions", type Movie, TMDB id of a chosen title, Title, then "Add exclusion". Request that title as alice. | The request is refused with "this title is on the exclusion list". Remove the exclusion afterwards. | |
| REQ-23 | In "Approval and behaviour" tick "Auto-approve all Movies" and save; request a movie as alice. | Toast "Request approved" (not "submitted for approval") and the request is Approved immediately. Untick it again. | |
| REQ-24 | In Settings -> Requests -> Override rules click "Add rule". Name "Anime to anime folder", Media type "Series", Track "Standard only", pick Original languages "ja", choose a Root folder and Quality profile, tick "Approve automatically", Save. | The rule shows in the table with Applies to "Series (standard)", Conditions "ja" and Result "profile, root folder, auto-approve". As alice request a Japanese-language series: it is approved at once and lands in the rule's folder; after you delete the rule (Delete, confirm) matching requests are Pending again. Saving with an empty name shows "Give the rule a name." | |
| REQ-25 | Enable "Enable 4K movies", save, and as a user with the "Request 4K" permission open a movie title page and request it with the "Request in 4K" switch on. | The 4K toggle only appears when 4K is enabled and the user may request 4K. The title page shows an extra badge "4K: ..." and the request is listed with "4K". | |

## Personal notifications

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| REQ-26 | Enable Discord, paste a Discord webhook URL (or a https://webhook.site URL), tick "Request approved", "Request declined" and "Request available", click Save, then click "Send test". | Toast "Notification settings saved"; below the buttons a list shows "discord: sent". Approve a pending request of alice's as admin: a message about the approved request arrives at the webhook. | |

## Issues

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| ISS-01 | As alice (with "Report issues") open a series title page and click "Report issue". | Dialog "Report an issue with <title>" with Problem type (Video, Audio, Subtitles, Other), Season ("All seasons" or each season), Episode ("0: the whole season") and "What is wrong?". | |
| ISS-02 | Click "Report issue" with the text empty, then enter "No sound in episode 3", set type Audio, Season 1, Episode 3, and click "Report issue". | First attempt: "Describe the problem." Second: toast "Issue reported". | |
| ISS-03 | As admin open Issues. | Page "Issues" with Open / Resolved / All buttons and an "Issue type filter". The new issue is listed with Title (with "S1E3"), Type "Audio", an Open badge, reporter and comment count. The title page shows "1 open issue". | |
| ISS-04 | Click the issue title, type "Looking into it" in "New comment" and click Comment. As alice add a reply, then Edit it and Save. | Page "Audio issue: <title>" lists both comments with names and times; edited comments are marked "(edited)". | |
| ISS-05 | As alice (creator) delete a comment of her own, then try deleting the issue after more than one comment exists. As admin click Delete on the issue and confirm "Delete this issue?". | Alice cannot delete the issue once it has more than one comment (button hidden); admin can. After deletion you return to the Issues list. | |

## Watchlist

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| WTC-01 | On any title page click "Add to watchlist". | Button changes to "On watchlist - remove". Opening Watchlist shows the poster. Adding again is refused with "already on your watchlist". | |
| WTC-02 | Open Watchlist and click Remove under a poster. | Poster disappears. When empty the page shows "The watchlist is empty" with hints about adding titles or linking a Plex token. | |
| WTC-03 | (Needs a Plex account.) On Profile enter your Plex token, tick "Sync movies" and "Sync series", Save; give the user "Auto-request" permission if you want auto requests; add a title to your Plex watchlist; as admin click "Sync now" on the Watchlist page (or run job "WatchlistSync" in System -> Tasks). | Toast "Watchlists synced" with "N users - N added - N requested". Plex items appear in Watchlist labelled with their source, and auto-requests appear in Requests. | |

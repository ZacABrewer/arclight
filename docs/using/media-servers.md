# Media servers: Jellyfin, Emby and Plex

Arclight is not a media server. It finds and organises your files, then your media server plays them. This page covers how Arclight talks to Jellyfin, Emby and Plex: the Settings > Media Servers list (used for request availability, watch-history retention and sign-in), and the Jellyfin, Emby and Plex connection types under Settings > Notifications that tell your server to rescan after an import. You need it if you want new files to show up in your server quickly, want requests to show "Available on <server>", or want your server's users to sign in to Arclight.

## Two places, two jobs

| Where | What it does |
|---|---|
| Settings > Media Servers | The list of servers Arclight can read from: is this title on the server, who watched what (retention), who may sign in |
| Settings > Notifications, type Jellyfin / Emby / Plex Media Server | Sends a "rescan this folder" message to the server after imports, upgrades, renames and deletions |

They are configured separately. For fast rescans you need the notification connection. For requests, retention and sign-in you need the media server entry. Using both for the same server is normal.

## Getting an API key or token

| Server | Where to get the credential |
|---|---|
| Jellyfin | Dashboard > API Keys > New. Give it the name Arclight |
| Emby | Dashboard > API Keys > New App Key |
| Plex | The owner's `X-Plex-Token`. Arclight asks for the token, not a username and password |

Keep tokens private. Arclight stores them in its database and never shows them again after saving; leave the masked value in place when you edit to keep the stored one.

## Settings > Media Servers

Press **Add media server**, fill in the form, press **Test**, then save. The test reports the server name, version and the movie and TV libraries it found (or "The server reports no movie or series libraries").

| Setting | Default | What it does |
|---|---|---|
| Kind | - | Jellyfin, Emby or Plex |
| Name | - | Your label, shown to users as "Available on <name>" |
| URL | - | Base address including any URL base, for example `http://jellyfin.example.com:8096`. In Docker, use the container name or the NAS address, not `localhost` |
| API key (Plex: X-Plex-Token) | empty | Credential from the table above |
| Enabled | On | Off keeps the entry but nothing uses it |
| Availability | On | Requests count as available once this server has the title |
| Retention | Off | Watch history from this server feeds retention rules |
| Sync watch history | On for new Jellyfin, Emby and Plex connections | Copies every user's play state and plays into Arclight (see [Watch-history sync](#watch-history-sync)). Ignored for Audiobookshelf. A connection saved before this option existed follows its Retention switch |
| Library refresh | Off | Marks the server for post-import rescans (see the next section) |
| Sign-in | Off | Users may sign in to Arclight with their account on this server. The first enabled server with this on is used |
| Create users on sign-in | Off | A first sign-in creates a local Arclight account with the default permissions from Settings > Requests |
| Mirror Jellyfin parental controls | Off | Jellyfin and Emby only. On every user sync, each linked user's Jellyfin maximum parental rating becomes their Arclight content limits (see [What Jellyfin users can see and request](#what-jellyfin-users-can-see-and-request)). While on, limits edited in Arclight are overwritten |

Buttons per server: **Test**, **Edit**, **Delete** (the entry is removed; linked Arclight user accounts keep their link). The page also has a sign-in and user import panel (Test sign-in server, Import users).

### What each use does

- **Availability.** When a request is made, Arclight asks every enabled server flagged for Availability whether it has the title, matched by TMDB, TVDB or IMDb id (Plex has no id search, so Arclight indexes its libraries). A match shows as "Available on <name>", and the request is marked available. See [Discover and requests](discover-and-requests.md).
- **Retention.** If you use retention rules, watch history from flagged servers decides what counts as watched. Servers whose history is synced use the stored copy; others are read live. See [Library](library.md#retention).
- **Sign-in and user import.** See [Users and security](users-and-security.md). Imported accounts become Arclight users with the default permissions and sign in with their media server password. Use **Import users** to pick which server accounts to bring in; accounts already linked are marked as such.

## Library refresh: telling the server to rescan

After Arclight imports, upgrades, renames or deletes files, your server will not notice for a while unless it is told (or has real-time monitoring and can see the folder). To tell it, add a connection in Settings > Notifications: **Add connection** and pick Jellyfin, Emby or Plex Media Server. These connections only react to library changes: imports, upgrades, renames, deleted titles and files, downloaded subtitles and in-place transcodes. They do not send messages for grabs or health unless you use Emby's Notify option.

### Jellyfin and Emby

| Setting | Default | What it does |
|---|---|---|
| Host | - | Hostname or IP |
| Port | 8096 | Port |
| Use SSL | Off | HTTPS |
| URL base | empty | Sub-path when the server sits behind a reverse proxy sub-path |
| API key | - | From the Dashboard (see above) |
| Update library | On | Tell the server which folder changed, so it rescans only that. Off sends nothing |
| Notify (Emby only) | Off | Also show a notification in Emby for grabs, imports, upgrades, health issues, application updates and manual-interaction events |

How it rescans: Arclight sends the series or movie folder as a "modified" (or "deleted") update. If the event carries no folder path, it falls back to a full library refresh. The folder path must be the path **as the media server sees it**. If Arclight and your server mount the same folders at different paths (very common between containers), the server will not find the folder; keep the paths identical in both containers, see [Folders and hardlinks](../getting-started/folders-and-hardlinks.md).

### Plex Media Server

| Setting | Default | What it does |
|---|---|---|
| Host | - | Hostname or IP |
| Port | 32400 | Port |
| Use SSL | Off | HTTPS |
| Auth token | - | The owner's X-Plex-Token |

How it rescans: Arclight lists your Plex library sections, finds the TV or movie section whose folder contains the series or movie, and asks Plex to scan just that folder. If no section contains it, the notification fails with "No Plex TV library contains <path>" (or movie library). Fix this by making the library folders match what Arclight sees, or by adding the folder to the Plex library.

### Which events trigger a rescan

Switch on the same events as for any connection: On download (import), On upgrade, On rename, On series delete, On movie delete, On file delete. The connection form's Test button sends a test event and checks that the server answers.

> The "Library refresh" switch on the Media Servers page marks a server as a refresh target, but the rescans described here are sent by the notification connections. Set up a connection if you want rescans.

## Watch-history sync

For Jellyfin, Emby and Plex, Arclight can keep its own read-only copy of who watched what. The media server stays the source of truth; Arclight only reads and never writes to your server. The copy feeds the **Watch history** views, the "Watched by" tab on titles, the Now playing panel and [retention rules](library.md#retention). Audiobookshelf is not synced. Plex has a few differences, described in [Plex watch history](#plex-watch-history).

Switch **Sync watch history** on for the server. It is on by default for new Jellyfin, Emby and Plex connections; a connection saved before the option existed follows its **Retention** switch, so an upgrade only starts syncing servers that already fed retention. Each synced server shows a **Watch history** panel on **Settings > Media Servers** with its status, last sync, last full read, items tracked, linked accounts, last user sync and last plugin event (for Plex: last webhook or session), plus the buttons **Sync now**, **Full resync**, **Sync users** and **Accounts** (the server's accounts as last synced, with their Arclight user or "Not linked").

### What is read

For every account on the server Arclight reads the movies and episodes with their per-user data: played, play count, last played date, resume position and favourite. It stores the current play state per user and item, and keeps a timeline of plays. When a read sees an item flip to played, or its play count grow, Arclight adds a played event to the timeline; an item that flips back to unplayed adds an unplayed event. Music, audiobooks and anything the library does not hold are stored as "other".

Accounts are matched to Arclight users by the server's user id kept in the user's media server link (for Plex, the plex.tv account id), never by name. Every server account is kept in its own list, so history of an account with no Arclight user yet is not lost: it attaches when the account is linked or imported later.

### How often

| Setting (Settings > Media Servers > Watch history) | Default | What it does |
|---|---|---|
| Sync every (minutes) | 10 | How often the `MediaServerWatchSync` job runs (5 to 1440) |
| Full read every (hours) | 24 | How often every account is read in full again (1 to 168) |
| Keep plays for (days) | 400 | Plays older than this leave the timeline; play state itself is kept (7 to 3650) |

- The first run for an account is a full read: every movie and episode, in pages.
- After that, reads are incremental: items sorted by last played date, newest first, until the read reaches items older than the last read (minus a 10 minute margin).
- Incremental reads cannot see an item that was marked unplayed, or a favourite that changed, because those do not change the last played date. The periodic full read catches them, and so does the [Jellyfin plugin](#the-arclight-jellyfin-plugin), which reports them at once.
- Arclight deliberately does not use Jellyfin's `MinDateLastSavedForUser` filter for the incremental read. In Jellyfin's source it filters on the item's date last saved (metadata saves), not on the user's data, so it would miss plays.
- **Sync now** runs an incremental read; **Full resync** forces a full one. Only one sync runs at a time; a second request while one is running is refused.
- The `WatchHistoryCleanup` job runs daily at 04:45 and removes timeline entries older than the retention period.

### User sync

The `MediaServerUserSync` job runs hourly at five past (or press **Sync users**) and lists the accounts on each Jellyfin, Emby and Plex server:

- **New accounts** are added to the account list. An Arclight user is created for one only when the server has **Sign-in** and **Create users on sign-in** on, the sign-in policy allows that server kind, and new users are set to automatic (see [Users and security](users-and-security.md)).
- **Renamed accounts** update the username on the linked Arclight user's media server link.
- **Disabled accounts** are marked. A linked user who signs in only through the media server (no local password) has their sessions revoked. Arclight has no separate "disable user" switch; signing in through a disabled account was already refused.
- **Deleted accounts** are marked as deleted and unlinked from their Arclight user. Their history is kept.
- **Parental controls** (only with **Mirror Jellyfin parental controls** on): each linked user's Jellyfin limit is copied into their Arclight content limits. The sync result reports how many users changed.

### Where you see the history

| Where | What it shows |
|---|---|
| **Activity > Watch history** (`/activity/watchhistory`) | The timeline of plays. Admins see everyone and can filter by user; other users see only their own |
| **Profile > Watch history** | Your own plays |
| **Watched by** tab on a movie or series page (admins) | Who watched the title: played state, play count, last played, progress and favourite per user, and for series the episodes played of the total |
| **Now playing** on the dashboard (admins) | Sessions that started or reported progress in the last 5 minutes with no stop. Needs the Jellyfin plugin, or for Plex the webhook or session polling |

### Plex watch history

Plex works like Jellyfin and Emby, with these differences.

**Token.** The connection's token must be the server owner's `X-Plex-Token` (see [How to find an X-Plex-Token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/)). Arclight uses it on the server and on plex.tv, where it lists the owner's friends and Plex Home users.

**Accounts.** The user sync reads the server's own account list and adds, from plex.tv, the owner, Plex Home (managed) users and friends the server is shared with. Each account is stored by its plex.tv id, so it links to the Arclight user who signs in with that Plex account. When plex.tv cannot be reached, accounts are only added or renamed, never marked deleted, so an outage does not unlink anyone; on a first sync without plex.tv the owner is added once plex.tv answers. Parental controls are not mirrored from Plex.

**What is read for each account.**

| Account | Source | Resume position |
|---|---|---|
| The owner | The library itself (played, play count, last played, resume position) | Yes |
| A linked user who signed in to Arclight with Plex | The library, read with that user's own server token | Yes |
| Anyone else | The server's play history for that account (plays and last played) | Only from webhooks and polling |

Plex has no favourites, so the favourites sync and the "Favourite" column do not apply. Movies and episodes are matched by the `tmdb://`, `tvdb://` and `imdb://` ids of the current Plex agents. Items without them (for example from a legacy agent) are matched by title and year, or by series, season and episode number.

**Live playback.** Arclight learns about plays in two ways, and both feed the same timeline and Now playing panel as the Jellyfin plugin:

1. **Webhooks (Plex Pass).** On the Plex card in the **Watch history** panel copy the **Plex webhook URL**. In Plex open **Settings > Webhooks**, press **Add Webhook** and paste it. The URL looks like `https://arclight.example.com/api/v1/plex/webhook?token=...`; it has to be an address the Plex server can reach. The token in it is a secret for that connection only. **New webhook URL** replaces it, and the old URL stops working at once. Plex sends play, pause, resume, stop and scrobble (watched) events.
2. **Session polling.** The `PlexSessionPoll` job reads the server's playing sessions every minute, so plays show up without Plex Pass too. A session that disappears counts as stopped, and as played when it reached 90%.

A play reported by both the webhook and the poll is stored once.

### Favourites and the watchlist

The favourites sync (`WatchlistSync`) mirrors Jellyfin and Emby favourites into the watchlist of the linked user. A favourite episode counts for its series. Music and audiobook favourites are not mirrored, because the watchlist holds movies and series only. Items the plugin adds to a watchlist have source `jellyfin` and no external id; the favourites sync never removes them.

## The Arclight Jellyfin plugin

A separate plugin for Jellyfin adds Arclight to the Jellyfin interface and reports plays as they happen. It shows request status on items, lets linked users search, request, ask for subtitle and audio languages, report issues and manage their watchlist from Jellyfin, and sends playback, played and unplayed marks, favourite changes and user changes to Arclight in real time. It is optional: the watch-history sync works without it, with the delays described above.

Set it up:

1. In Arclight open **Settings > Media Servers**, find the **Jellyfin plugin** card and press **Create plugin key**. Copy the key (it starts with `alj_`); it is shown once.
2. In Jellyfin open **Dashboard > Plugins > Repositories**, add the repository URL shown on the same Arclight card (`https://arclight.moviemethat.com/jellyfin/manifest.json`), install the Arclight plugin from the catalogue and restart Jellyfin.
3. Open the plugin's settings in Jellyfin and paste your Arclight URL (for example `http://arclight.lan:7878`, an address Jellyfin can reach) and the plugin key.
4. Back in Arclight, press **Test** on the Jellyfin media server entry once. Arclight stores the server's own id (from `System/Info`) on the first successful test or sync, and the plugin names its server by that id. Until then the plugin's events are refused with `UNKNOWN_SERVER`. The plugin card says "Test this server once so Arclight learns its id" while the id is missing.

The plugin card lists each key with its prefix, last use and last ping, and per server whether the plugin is connected and when its last event arrived. **Delete key** cuts off any plugin using that key until it gets a new one.

A plugin key is limited on purpose: it may call only the `/api/v1/jellyfin/*` routes and nothing else. For the per-user features the plugin names the Jellyfin user who is acting, and Arclight runs the call as the linked Arclight user, with that user's permissions, request types and quotas. A Jellyfin user with no Arclight user is refused (`not_linked`) unless the sign-in server has **Create users on sign-in** on and the sign-in policy admits new users automatically, in which case the account is imported on first use. See the [API reference](../API.md#jellyfin-plugin).

### What Jellyfin users can see and request

Everything the plugin shows or does for a Jellyfin user is decided by the **linked Arclight account**, never by the Jellyfin account. A Jellyfin administrator is not an Arclight administrator: what counts is the linked account's role and permissions.

- **Content limits** (the user's maximum movie and TV certification and "hide adult content", Settings > Users): titles above the limits are left out of the plugin's search, Discover rows and Coming soon row. Opening one directly (title page, "Also on" streaming services) answers that it does not exist, and requesting it, asking for a language or reporting a problem is refused. Status badges for such titles show nothing beyond "not in the library". These are the same rules as the request portal, and titles without a known US rating count as unrated.
- **Permissions and request types**: the Request button appears only when the account may request that kind of title (Request, Request movies / series, Request 4K with the 4K switch on in Settings > Requests) and its request type filter allows it. Otherwise the plugin shows why: already in the library, already requested, no permission, request type turned off, or quota used up. Quality profiles are offered only to accounts with Advanced requests. Subtitle and audio-language requests appear only when the account may make them. Quotas count exactly as on the portal.
- **Seeing other people's requests**: who requested a title, and requests made by other users, are shown only to accounts with View requests or Manage requests. Everyone else sees only their own. **My requests** in Jellyfin always lists only the user's own requests, and a request can be cancelled from there only while it is pending.
- **Coming soon** lists monitored movies and episodes from Arclight's calendar, which are library titles only, filtered by the account's content limits.
- **Disabled or deleted Jellyfin accounts**: once the user sync (or a plugin event) marks a Jellyfin account disabled or deleted, the plugin is refused for it (`account_disabled`), even if it is still linked.
- **Imported accounts**: accounts created through the plugin or on sign-in get the default permissions and default request types from Settings > Requests. There are no default content limits, so set limits per user (or turn on **Mirror Jellyfin parental controls**).

**Mirror Jellyfin parental controls** (per Jellyfin/Emby server, off by default). Jellyfin 10.11 and later store a user's limit as a rating score: G, TV-Y and TV-G are 0, TV-Y7 is 7, PG and TV-PG are 10, PG-13 is 13, TV-14 is 14, R and TV-MA are 17, NC-17 is 18. Arclight maps the score to the strictest US certifications that still admit everything at or below it:

| Jellyfin maximum rating (score) | Movie limit | TV limit |
|---|---|---|
| No limit | none | none |
| 0-6 (G, TV-Y, TV-G) | G | TV-G |
| 7-9 (TV-Y7) | G | TV-Y7 |
| 10-12 (PG, TV-PG) | PG | TV-PG |
| 13 (PG-13) | PG-13 | TV-PG |
| 14-16 (TV-14) | PG-13 | TV-14 |
| 17 (R, TV-MA) | R | none |
| 18 and above (NC-17) | none | none |

Only linked users are changed, and "hide adult content" is left as it is. Jellyfin's "block unrated items" has no direct equivalent: titles without a US rating are always above an Arclight limit. While the setting is on, limits edited in Arclight are replaced on the next user sync (hourly, or **Sync users**).

## Common problems

| Symptom | Likely cause |
|---|---|
| Test says unauthorized | Wrong API key or token, or the key was deleted in the server |
| Test says network or the server did not answer | Wrong host or port, or Arclight cannot reach the server. Behind a VPN, see [VPN](vpn.md): the server may be on your LAN, which the VPN firewall must allow (`FIREWALL_OUTBOUND_SUBNETS` in the shipped Docker setup) |
| New files do not appear in the server | No Notifications connection, event switches off, or path mismatch between Arclight and the server. Turn on real-time monitoring in the server as a fallback |
| Plex: "No library contains..." | The Plex library folders differ from the paths Arclight uses |
| Request never shows "Available" | Availability is off for that server, the server has no matching library, or the title has no external id Arclight can match |
| Nobody can sign in | No enabled server has Sign-in on. See [Users and security](users-and-security.md) |
| Watch history is empty | **Sync watch history** is off for the server, or the first full read has not finished (check the Watch history panel on the server card) |
| A "mark unplayed" or favourite change is missing | Incremental reads cannot see it. It appears after the next full read (default every 24 hours) or at once with the plugin. Use **Full resync** to force it |
| Plugin events are refused with `UNKNOWN_SERVER` | Press **Test** on the Jellyfin entry once so Arclight learns the server id |
| The plugin says a user is not linked | The Jellyfin account has no Arclight user. Import or link it, or turn on **Create users on sign-in** with automatic new users |
| Plex: friends or Home users are missing | The token is not the server owner's, or plex.tv could not be reached. The user sync retries hourly |
| Plex: plays arrive only once a minute | No webhook is set up (it needs Plex Pass), or Plex cannot reach the webhook URL. Polling still records the plays |
| Plex: the webhook returns 401 | The URL's token was replaced with **New webhook URL**. Paste the current URL into Plex |
| Plex: no resume positions for a friend | Only the owner and users who signed in to Arclight with Plex can be read with their own token. For others, resume positions come from webhooks and polling |

## Bulk actions

Every card has a checkbox. Tick one or more and a bar appears at the bottom of the screen with "N selected", **Select all N** and the actions for the selection: **Enable**, **Disable**, **Test** and **Delete**. Deleting asks first and says how many items it removes. Each item is handled on its own, so one that fails (for example a test that does not connect, or a profile still in use) does not stop the rest; a message lists what worked and why the others did not, and the failed items stay selected. On a phone the actions sit in one **Actions** menu.

## Related

- [Notifications](notifications.md)
- [Discover and requests](discover-and-requests.md)
- [Users and security](users-and-security.md)
- [API reference: Jellyfin plugin](../API.md#jellyfin-plugin)
- [Folders and hardlinks](../getting-started/folders-and-hardlinks.md)
- [Library](library.md)
- [Troubleshooting](../TROUBLESHOOTING.md)

# Discover and requests

Discover is where you browse movies and series to find something new. Requests are how people ask for it: one click on a title sends a request, Arclight (or an admin) approves it, the title is added to your library, a search runs, and the requester is told when it is ready. This page covers browsing, requesting, approvals, auto-approve rules, permissions, quotas, kids content limits, issues, the watchlist, the public request portal and the Discord bot.

Most of the settings live in **Settings > Requests**, **Settings > Users** and **Settings > Discord bot**.

## Discover

**Discover** in the left menu has three tabs: **Home**, **Movies** and **TV**.

- **Home** shows a search box ("Search movies and series") and a set of sliders such as Trending, Popular movies, Upcoming series and Recently added. **See all** opens the full list for a slider.
- **Movies** and **TV** let you browse with filters.

Browse filters:

| Filter | What it does |
| --- | --- |
| Genre | Only titles in the genres you pick. |
| Min rating | Hide titles under this score. |
| Year from / to | Release year range. |
| Runtime min / max | Length range. |
| Release date / First air date | Date range. |
| Sort | Popularity, Rating, Revenue or Votes. |

Use **Load more** at the bottom to see further results. There are also list pages for Upcoming movies, Upcoming series and Trending (with a **Time window** of Today or This week).

If Home shows "No sliders enabled", an admin can turn sliders on in Settings > Requests (see [Discover sliders](#discover-sliders)).

### The title page

Click any poster to open its page. You will see the overview, **Cast**, **Similar** and **Recommendations**. Click a person to see their other work. Buttons on the page:

| Button | What it does |
| --- | --- |
| Request | Ask for the title. |
| Request 4K | Ask for a 4K version. Only shown if 4K requests are enabled and you have permission. |
| Add to watchlist / Remove from watchlist | See [Watchlist](#watchlist). |
| Report issue | See [Issues](#issues). |
| Watch trailer | Plays the trailer. |
| Open in library | Shown when the title is already in your library. |

If someone has reported a problem with the title, an "open issue" link with **Review** appears.

## Requesting a title

1. Open the title page and click **Request**.
2. For a series, choose **All seasons** or tick the seasons you want, then click **Request N seasons**. You must pick at least one season.
3. Click send. You will see "Request sent for approval", or the title is approved straight away if you are allowed to auto-approve (see [Auto-approve](#auto-approve)).

Series requests cover every season not already requested or available. Specials (season 0) can only be requested if **Allow requesting specials** is on, and picking only some seasons needs **Allow partial series requests**.

Users with the advanced request permission (and managers) can also choose the root folder, quality profile and tags for their request. Anything they leave empty is filled from [override rules](#override-rules) and the defaults in Settings > Requests.

Arclight checks the request in this order and stops at the first problem:

1. The title is on the import exclusion list.
2. The title is above the user's [content caps](#kids-caps-and-age-ratings).
3. The title already has an active request, or is already in the library (a movie gives a conflict message; for a series, seasons already requested or available are skipped, and if none remain nothing is created).
4. The user is over their [quota](#quotas) ("Movie Quota exceeded." or "Series Quota exceeded.").

### What happens after approval

When a request is approved, Arclight:

1. Adds the title to the library using the defaults in **Settings > Requests** (or the request's own choices).
2. For a movie, adds it monitored with the default minimum availability. For a series, adds it and monitors exactly the requested seasons.
3. For a 4K request, adds a second version tagged "4K" with the 4K profile and root folder, so the normal and 4K copies live side by side.
4. Runs a search if **Search on add** is on (it is on by default for requests).
5. If the title is already available, completes the request immediately.

If adding fails, the request is marked **Failed** with a reason, and a manager can retry it.

Every 5 minutes a background job (RequestsStatusSync) checks whether requested titles have arrived. When they have, the request becomes **Completed** and the requester is notified. If **Use media server availability** is on, a request only completes once your media server also shows the title.

## Request statuses

| Status | Meaning |
| --- | --- |
| Pending | Waiting for a manager to approve or decline. |
| Approved | Accepted, being added or searched for. |
| Declined | Refused. A reason may be shown to the requester. |
| Failed | Approved but could not be added. Use **Retry**. |
| Completed | The title arrived. |

The title itself also has an availability: Unknown, Pending, Processing, Partially available or Available.

## Requests pages

**Requests** has two lists:

- **All requests**: everyone's requests. Needs the permission to view requests.
- **My requests**: only yours, with **Awaiting approval**, **Partially available**, **Failed to add** and the decline reason. **Cancel request** withdraws one ("Cancel your request for {title}?"; **Keep request** backs out). You need a real user account for this page.

Filter by status (All, Pending, Approved, Processing, Unavailable, Declined, Failed, Completed, Available), by type (Movies, Series) and sort by date added or modified. Clicking a request opens its details page.

## Approving and declining

Users with **Manage requests** (and admins) can act on requests:

- **Approve** opens a dialog where you can keep or change the requested seasons, and set the root folder, quality profile, tags and which episodes are monitored. For movies you can override the minimum availability.
- **Decline** takes an optional reason ("Shown to the requester.").
- **Select all pending**, **Approve selected** and **Decline selected** work on many at once.
- **Edit** changes a request. **Delete** removes it; the title stays in the library if it was already added.
- **Retry** tries a failed request again.

The people who handle requests can also be told by notification (see [Notifications](notifications.md)). The links in those messages use the **Application URL** setting.

## Auto-approve

A request is approved automatically as soon as it is made when any of these is true, checked in this order:

1. **The user has an auto-approve permission.** There is one for everything, and separate ones for movies, series, 4K, 4K movies and 4K series. Managers of requests count too.
2. **The global toggle is on.** In Settings > Requests, **Auto-approve all {movies / series / 4K movies / 4K series}**.
3. **A matching override rule** has **Approve automatically** set.

If none of these apply, the request goes through the approval policies below, which can still approve, hold or leave it pending.

### Approval policies

These live in the Approval area of Settings > Requests and are checked in this order:

1. **Approval override** for that user: Inherit, Always auto-approve, or Never auto-approve.
2. **Approval by size** ("Auto-approve under"): approves when the best release found is smaller than the limit. Only works for titles already in your library. Leave blank to turn it off. A user can have their own **Size limit override**.
3. **Approval budgets**: approve while a budget has room (see below).
4. **Approval windows**: approve or hold depending on the time of day.

If a request is held and you want to know why, open it and look at the **Why {title} is held** panel. It lists Permissions, Global auto-approve, Override rules, User override, Size limit, Budgets and Approval windows, each marked Met, Not met or Skipped.

**Approval budgets** limit how much gets auto-approved:

| Field | What it does |
| --- | --- |
| Scope | Each user, Each role, or Everyone (shared). |
| Movies | Limit in GB of estimated size. |
| Seasons | Limit in number of seasons. |
| Period | 1 to 365 days, rolling. |
| Only requests under | Only count requests under this size. |
| Applies to | The users or role the budget covers. |

Approved and completed requests count against a budget. A user can be marked **Exempt from budgets**.

**Approval windows** are weekly schedules in the server's local time:

| Field | What it does |
| --- | --- |
| Days | Which days of the week. |
| From / Until | Time range. Can run past midnight. |
| Action | Auto-approve or Hold. |

With auto-approve windows, requests made outside them wait until one opens. Hold windows stop auto-approval while they last. A job (RequestsPolicySweep) re-checks held requests every hour.

### Override rules

**Override rules** (a card in Settings > Requests) change how requests are added when they match conditions. Each rule has:

- **Applies to**: movies or series, and standard, 4K or both.
- **Conditions**: users, genres, original languages (as two-letter codes such as `en`) and TMDB keyword ids. Every condition you fill in must match. Empty means any.
- **Then**: a quality profile, root folder, tags to add, and **Approve automatically**.

When more than one rule matches, the most specific one wins.

## Users and permissions

Accounts are created in **Settings > Security**. Request permissions, quotas and personal notifications are in **Settings > Users**: click **Manage** next to a user. See also [Users and security](users-and-security.md).

New users get the permissions in **Default permissions for new users**, which start as Request plus Report issues.

| Group | Permissions |
| --- | --- |
| Admin | Admin (bypasses every check), Manage settings, Manage users (also exempt from quotas, and can request on behalf of others), Manage requests. |
| Request | Request, Request movies, Request series, Request 4K (plus 4K movies and 4K series), Advanced requests. |
| Auto-approve | Auto-approve, plus movies, series, 4K, 4K movies and 4K series. |
| Auto-request | Auto-request, plus movies and series. Needed for watchlist requests. |
| Issues | Manage issues, Report issues, View issues. |
| View | View requests, View recently added, View watchlists, Vote. |

Vote is reserved and has no effect yet. After changing a user, click **Save permissions**.

## Quotas

A quota limits how many requests a user can make in a time window. Set it per user in **Settings > Users > Manage** and click **Save quota**.

| Setting | Default | What it does |
| --- | --- | --- |
| Movie request limit | Blank | Movies allowed in the window. |
| Movie window (days) | Blank | How many days back are counted. |
| Series request limit | Blank | Series seasons allowed in the window. |
| Series window (days) | Blank | How many days back are counted. |

Blank uses the global **Default quotas** ("Blank: no quota"). A limit of 0 or blank means unlimited. A window of 0 or blank counts all time. A series costs one per requested season. Declined requests and requests a manager marked to ignore quota do not count. Managers of users and admins are exempt. Users can see their own quota on their profile under **Request quota**.

## Kids caps and age ratings

To keep a child's account to suitable titles, open **Settings > Users > Manage > Caps and approval** and use **Content caps**, then **Save caps and approval**.

| Setting | Choices | What it does |
| --- | --- | --- |
| Highest movie rating | G, PG, PG-13, R, NC-17, NR | NR allows everything. Unrated movies are only allowed with NR. |
| Highest series rating | TV-Y, TV-Y7, TV-G, TV-PG, TV-14, TV-MA | Unrated series are hidden under any cap. |
| Hide adult titles | On / off | Hides NC-17 movies and TV-MA series. |

Titles above the cap are hidden from Discover, and requests and title pages for them are refused. Ratings come from TMDB (your region, otherwise US).

## Issues

Issues let people report that something is wrong with a title you already have, such as bad video, no audio or missing subtitles.

1. Open the title in Discover and click **Report issue**.
2. Under **What is wrong?** pick the Problem type: Video, Audio, Subtitles or Other. For a series, choose the season or episode.
3. Describe it. The description becomes the first comment.

Open **Issues** in the left menu to see them. Filter by status (open or resolved) and type. Open an issue to read the comments, add your own, **Resolve** or **Reopen** it, or **Delete issue** (its comments go too). Reporting needs the Report issues permission, seeing them needs View issues, and managing needs Manage issues.

## Watchlist

**Watchlist** in the left menu is **My watchlist**: titles you want to keep an eye on. Add from a title page with **Add to watchlist**. Users with the right permission can switch **Whose watchlist** to see someone else's.

Entries come from manual adds or from a linked media server account (Plex, Jellyfin or Emby). To sync your Plex watchlist, link your Plex token on your profile. A job (WatchlistSync) runs every 15 minutes and reports watchlists synced, users, added and requested.

Per-user settings in **Settings > Users > Manage**:

| Setting | Default | What it does |
| --- | --- | --- |
| Sync movies | See screen | Include movies from the watchlist. |
| Sync series | See screen | Include series from the watchlist. |
| Request from watchlist | On | Automatically request watchlist titles. The user needs an Auto-request permission. |

## Public request portal

The portal is a simple request page at `/portal` (for example `http://<your-host>:<port>/portal`) for people who do not use the full app. It is off by default. Turn it on in **Settings > Requests > Public request portal**:

| Setting | Default | What it does |
| --- | --- | --- |
| Public portal | Off | "Show the request portal at /portal to anyone." |
| Anonymous browsing | Off | Visitors can browse and search without signing in (rate-limited). Requesting still needs sign-in. |
| Portal message | Empty | A short note shown on the page, up to 2000 characters. |

Click **Open portal** to see it. Visitors sign in with a local account or with your media server (Plex, Jellyfin or Emby). Anonymous visitors never see adult titles. If the portal is off, visitors see "The request portal is off".

## Settings > Requests reference

You need the Manage settings permission to open this page.

| Area | What it does |
| --- | --- |
| Movie defaults / Series defaults | Root folder, quality profile and tags for new requests, plus Monitor new seasons, Season folders and Search on add. Root folder and profile start as the first one. |
| 4K | **Enable 4K requests** per kind. 4K requests use their own root folder and profile. |
| Auto-approve | The global toggles described above. |
| Allow partial series requests | Let users pick some seasons. |
| Allow requesting specials | Allow season 0. |
| Hide available titles / Hide requested titles | Remove those titles from Discover. |
| Application URL | The address used in Approve, Decline and View links in notifications. |
| Daily digest | **Digest time** (hour in server time, default 9) and **Send digest now**. A job (RequestsDigest) checks hourly. |
| Default permissions for new users | See [Users and permissions](#users-and-permissions). |
| Default quotas | See [Quotas](#quotas). |
| Approval | Size, budgets and windows. |
| Override rules | See [Override rules](#override-rules). |
| Public request portal | See above. |

### Discover sliders

The **Discover sliders** card controls the rows on Discover Home. Show or hide each one, move them up or down, then click **Save order**. The built-in sliders are Recently added, Recent requests, Watchlist, Trending, Popular movies, Movie genres, Upcoming movies, Studios, Popular TV, TV genres, Upcoming series and Networks. **Add slider** creates a custom one from a TMDB keyword, genre, search, studio or network. **Reset to defaults** removes custom sliders and restores the default order.

## Discord bot

A Discord bot lets people request and check titles from your Discord server. Set it up in **Settings > Discord bot**.

1. In the Discord developer portal, create an application, add a Bot and click Reset token to get the **Bot token**.
2. Invite the bot to your server.
3. In Arclight, paste the **Bot token**, then fill in what you need (below) and turn on **Run the bot**. Saving restarts the bot.
4. Click **Test** to check the token. It reports "Token works" or "Token rejected".

| Field | What it does |
| --- | --- |
| Bot token | Stored once saved. Leave it alone to keep it. |
| Server (guild) id | Commands appear on this server at once. Blank means global commands, which take up to an hour. |
| Request channel id | New, approved and available requests are posted here. Blank means no channel posts. |
| Admin role id | Members with this role may use `/pending` and approve or decline. Blank means only linked request managers. |

Ids are the numeric Discord ids (5 to 25 digits). The page shows the state (Off, Connecting, Reconnecting or Stopped with an error), the bot user, connected since, last error, reconnect attempts, which commands are registered and how many users are linked.

### Linking your account

1. In Arclight, open your profile and click **Create link code**. The code works once and expires.
2. In Discord, type `/link` and paste the code.

**Unlink Discord** on your profile removes the link.

### Commands

| Command | What it does |
| --- | --- |
| `/request` | Request a movie or series. Options: title, year, and 4k. |
| `/link` | Link your Discord account with a code. |
| `/status` | Show the status of your requests, optionally filtered by title. |
| `/search` | Search titles and see whether they are in the library. |
| `/pending` | List pending requests, with approve and decline buttons. Admins only. |

## Related

- [Library](library.md) - what happens to a title after it is added
- [Quality profiles](quality-profiles.md) - the profiles requests use
- [Notifications](notifications.md) - request and issue alerts
- [Media servers](media-servers.md) - sign-in and availability
- [Users and security](users-and-security.md) - accounts and roles
- [FAQ](../FAQ.md)

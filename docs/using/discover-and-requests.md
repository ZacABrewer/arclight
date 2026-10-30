# Discover and requests

Discover is where you browse movies and series to find something new. Requests are how people ask for it: one click on a title sends a request, Arclight (or an admin) approves it, the title is added to your library, a search runs, and the requester is told when it is ready. This page covers browsing, requesting, approvals, auto-approve rules, permissions, quotas, kids content limits, issues, the watchlist, the public request portal and the Discord bot.

Most of the settings live in **Settings > Requests**, **Settings > Users** and **Settings > Discord bot**. The region in **Settings > Metadata** decides which streaming services, age ratings and release dates Discover shows.

Everyone who is not an admin uses all of this in the [request portal](#public-request-portal): Discover, **My requests**, **Issues** and **Account**. The Discover, Requests and Issues pages described below with the left menu are the admin app's; users with the request or issue management permissions also get those Requests and Issues pages.

## Discover

**Discover** in the left menu is a full catalogue of movies and series from TMDB. Its tabs are **Home**, **Movies**, **TV** and **Trending**. Every poster shows where the title stands in Arclight:

| Badge | Meaning |
| --- | --- |
| Available | In your library with files. |
| Partially available | A series with some of its seasons in the library. |
| Requested | Someone asked for it and it waits for approval. |
| Processing | Approved, being added or searched for. |
| Declined | The newest request for it was declined. |

No badge means nobody has asked for it yet.

### Home

Home has a search box and a set of rows (sliders). Swipe a row on a phone, or use the arrows at its ends on a computer. **See all** opens the full list.

| Row | What it shows |
| --- | --- |
| Recently added | The newest titles in your library. Needs the View recently added permission. |
| Recent requests | Your requests (everyone's for request managers). |
| Your watchlist | See [Watchlist](#watchlist). |
| Trending | What people watch on TMDB. Switch between **Today** and **This week** above the row. |
| Popular movies, Popular TV | The most popular titles right now. |
| Upcoming movies, Upcoming series | Releases and first air dates from today on. |
| Now playing | Movies in cinemas in your region. |
| Top rated movies, Top rated series | Highest rated on TMDB. |
| Airing series | Series with episodes airing this week. |
| Movie genres, Series genres | One tile per genre, with a picture from its most popular title. |
| Studios, Networks | Logos of well-known studios and networks. |
| Streaming services | The services available in your region (Settings > Metadata > Region), most prominent first. |

An admin picks which rows show and in what order: see [Discover sliders](#discover-sliders). If Home shows "No sliders enabled", none are turned on.

### Browsing with filters

**Movies** and **TV** are grids that keep loading as you scroll; there is no last page to click to. A count under the grid shows how many titles you have seen of how many match. The same grid and filters are behind every genre, keyword, studio, network and streaming service page.

| Filter | What it does |
| --- | --- |
| Sort | Popularity, Rating, Votes, Release date (First air date for series) or Title, ascending or descending. Sorting by rating skips titles with fewer than 100 votes unless you set Min votes. |
| Year from / to | Release year range. |
| Min rating | Hide titles rated under this score (0 to 10). |
| Hide available, Hide requested | Leave out titles already in your library or already requested. |
| Genres | Tick any number. Titles in any of the ticked genres show. On a genre page, ticked genres narrow it down instead. |

**More filters** opens the rest:

| Filter | What it does |
| --- | --- |
| Rating | A minimum and a maximum score. |
| Min votes | Only titles with at least this many votes on TMDB. |
| Runtime | Length range in minutes. |
| Original language | The language the title was made in. |
| Age rating | Titles up to this rating in your region (for example up to PG-13). |
| Streaming on | Pick a region and tick services; titles on any of them show. |
| Keywords | Find TMDB keywords (such as "time travel") and tick them. |

Filters live in the address, so you can bookmark a filtered grid or send the link to someone. **Back** returns to the grid where you left it. **Clear** resets the filters.

### Searching

Type in the search box on Home (or in the portal header). Suggestions appear as you type: up to six titles and three people. Use the arrow keys and Enter, or click one. Press Enter without picking one to open the results page, which has tabs for **All**, **Movies**, **Series** and **People**, each loading more as you scroll.

### The title page

Click any poster to open its page. It shows the backdrop and poster, the overview, rating and votes, runtime, age rating, genres (click one for more of the genre), the release dates (In cinemas, Digital, Physical) for movies, and first and last air dates for series. Further down:

- **Seasons** (series): each season with its status, and a **Request** button for a season that can still be requested.
- **Part of** (movies in a collection): **View collection** opens the collection page.
- **Cast** and **Crew** rows. Click a person for their page.
- **Trailers and videos**: links that open on YouTube or Vimeo.
- **Recommendations** and **Similar** rows.
- **Studios** or **Networks**, and **Keywords**: links to grids of more titles like this one.

Buttons on the page:

| Button | What it does |
| --- | --- |
| Request | Ask for the title. |
| Request 4K | Ask for a 4K version. Only shown if 4K requests are enabled and you have permission. |
| Sign in to request | Shown to visitors of the [public request portal](#public-request-portal) who are not signed in. |
| Add to watchlist / Remove from watchlist | See [Watchlist](#watchlist). |
| Manage (admins) / Open in library | Opens the title in your library when you have it. |
| Report issue | See [Issues](#issues). |
| Watch trailer | Opens the trailer. |

If someone has reported a problem with the title, an "open issue" link with **Review** appears.

### People and collections

A person's page shows their photo, biography, a **Known for** row and every credit, split into **Appearances** and **Crew**. Use **All**, **Movies** or **Series** to narrow the credits; the grids load more as you scroll.

A collection page (for example a film series) shows every movie in it with its status. **Request all missing (N)** requests each movie in the collection that is not in your library and has not been requested, one request per movie, under the same rules as requesting one by one (quotas, approval, caps). If you run out of quota part way, Arclight stops and says which ones could not be requested. **Request all in 4K** does the same on the 4K track when 4K requests are enabled for you.

## Requesting a title

1. Open the title page and click **Request** (or **Request** next to one season in the **Seasons** list, which opens the dialog with that season ticked).
2. When 4K requests are open to you, pick **Standard** or **4K** at the top of the dialog.
3. For a series, choose **All seasons** or tick the seasons you want, then click **Request N seasons**. You must pick at least one season.
4. If you have a [quota](#quotas), the dialog shows how many requests you have left, for example "Season requests left: 4 of 6 per 30 days".
5. Click send. You will see "Request sent for approval", or the title is approved straight away if you are allowed to auto-approve (see [Auto-approve](#auto-approve)).

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

## Subtitle and language requests

Besides asking for a title, people can ask for **subtitles** or an extra **audio language** (a dub) on a title that is already in the library. These are separate from video requests and are handled by the same people.

### Asking for a language

**Request subtitles or audio** appears on a title's page when the title is in the library with files and you have the **Request subtitles & languages** permission. The plain **Request** permission includes it. It works in the app and in the [request portal](#public-request-portal).

1. Click **Request subtitles or audio**.
2. Choose **Subtitles** or **Audio language**. Audio asks for an additional language and keeps the current audio.
3. Search for and pick the language.
4. For a series, choose **All seasons** or one season. Only seasons that have files are offered.
5. For subtitles, tick **Forced only** (just the lines in another language, such as signs and foreign dialogue) and/or **Hearing impaired** (with sound descriptions). Audio has neither option.
6. Optionally add a note for whoever handles the request, up to 500 characters.
7. Send it.

The dialog also lists the audio and subtitle languages the title already has and any open requests on it, so you can see what is covered before you ask.

Arclight refuses a request when:

- the title already has that language on every file in the scope ("Already on this title");
- the same request is already open ("Already requested"). A request for the whole series covers its seasons;
- the language was already added to the title by an admin and is still being looked for;
- the title or season has no files yet.

### Approval

Subtitle requests are approved automatically by default; audio requests are not. Change this in **Settings > Requests** with **Auto-approve everyone's subtitle requests** and **Auto-approve everyone's audio language requests**. Users with an Auto-approve permission or **Manage requests** are always approved straight away. An approved request starts a search at once.

### Handling them (admins)

Language requests show on the **Requests** page under the **Subtitles & languages** filter. Users see their own in **My requests** (in the portal too).

- **Approve** a pending request. For an audio request you choose how: **Replace the file** (the default) looks for a release with all the current audio languages plus the new one and replaces the file once it imports; **Add a version** keeps the current file and adds a separate version slot that needs the new language. Subtitle requests have no such choice.
- **Decline** takes an optional reason, shown to the requester.
- **Retry** runs a failed request again.
- Tick requests to **Approve**, **Decline**, **Retry** or **Delete** many at once. The search box matches the title, year, kind, status, language, note, reasons and requester.

### Statuses

| Status | Meaning |
| --- | --- |
| Pending | Waiting for a manager. |
| Approved | Accepted and being searched for. It stays open while Arclight is still searching or has not found anything yet; searches keep running in the background. |
| Completed | The language was found, grabbed or added as a version, or the title now has it. Checked every 5 minutes and whenever the title changes. |
| Declined | Refused, with an optional reason. |
| Failed | Could not be carried out, with a reason (for example the title was removed from the library). Use **Retry**. |

### Good to know

- Language requests do not count toward [quotas](#quotas).
- Pending ones appear in the admin daily digest.
- Requesters are notified when a request is created, approved, declined and completed. There is no notification for a failed request yet.

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

**My requests** is also linked from Discover Home, and portal users find it in the portal header.

Filter by status (All, Pending, Approved, Processing, Unavailable, Declined, Failed, Completed, Available), by type (Movies, Series) and sort by date added or modified. Clicking a request opens its details page.

The search box next to the media type filter matches the title, the requester and the status; every word you type must match, upper or lower case does not matter, and dots, dashes and underscores count as spaces. The search is kept in the address bar, so a reload or a shared link keeps it. A new search starts at the first page, and selecting all rows takes only the matching rows shown.

## Approving and declining

Users with **Manage requests** (and admins) can act on requests:

- **Approve** opens a dialog where you can keep or change the requested seasons, and set the root folder, quality profile, tags and which episodes are monitored. For movies you can override the minimum availability.
- **Decline** takes an optional reason ("Shown to the requester.").
- Tick requests (the header box selects the page) to act on many at once from the bar at the bottom: **Approve**, **Decline**, **Retry** and **Delete** (asks first, with the count). Each request is checked on its own: one that is not pending, or that you may not change, is listed as failed and the rest still go through. Users without Manage requests only get **Delete**, for their own requests. Music and audiobook requests work the same way.
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
| Request | Request, Request movies, Request series, Request 4K (plus 4K movies and 4K series), Advanced requests, Request subtitles & languages (also included in Request). |
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

Open **Issues** in the left menu (or in the portal header) to see them. Users see their own issues; View issues or Manage issues shows everyone's. Filter by status (open or resolved) and type, or use the search box: it matches the title, the reporter, the problem type and the message (every word you type must match, upper or lower case does not matter, and dots, dashes and underscores count as spaces; the search is kept in the address bar, so a reload or a shared link keeps it). **Clear** in the filter row also clears the search. Open an issue to read the comments, add your own, **Resolve** or **Reopen** it, or **Delete issue** (its comments go too). Reporting needs the Report issues permission, seeing them needs View issues, and managing needs Manage issues. Tick issues in the list to **Resolve**, **Reopen** or **Delete** several at once; deleting asks first and says how many.

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

The portal is the request side of Arclight on its own: the same Discover home, browsing, search, title, person and collection pages, plus **My requests**, **Issues** and **Account**, in a simple layout without the admin menu. It is where every signed-in user who is not an admin lands, and the only part of Arclight they see unless an admin grants app access (see [App access](users-and-security.md#app-access)). Signed-in users always have it. The **public** portal (for visitors who have not signed in, on extra paths and hostnames) is off by default. Turn it on in **Settings > Requests > Public request portal**:

| Setting | Default | What it does |
| --- | --- | --- |
| Public portal | Off | "Show the request portal at /portal to anyone." |
| Anonymous browsing | Off | Visitors can browse and search without signing in. Requesting still needs sign-in. |
| Portal message | Empty | A short note shown on the portal home, up to 2000 characters. |
| Portal paths | `/portal` | Extra addresses for the portal on any hostname. See below. |
| Portal hostnames | None | Hostnames that show the portal at their root. See below. |

Click **Open portal** to see it. Visitors sign in with a local account or with your media server (Plex, Jellyfin or Emby), and come back to the page they were on. Without **Anonymous browsing**, visitors who are not signed in see the welcome and sign-in panes and nothing else. Anonymous visitors never see adult titles, never see anyone's requests, and are limited to a burst of 120 page requests, then 2 a second, per address. If the portal is off, visitors see "The request portal is off".

The portal header has **Home**, **Movies**, **Series**, **Search** and (signed in) **My requests**, **Issues** and **Account** (password, linked media-server account, notifications, sessions); on a phone they move to a tab bar at the bottom. Signed-in users also get **Sign out**, and **Open Arclight** when they may open part of the app (admins, and users with app access).

### Portal paths

The portal always answers at `/portal`. Add more paths under **Portal paths**, for example `/requests`, `/watch` or something hard to guess. Each path is one word of letters, digits, `-` or `_`; Arclight lower-cases it and adds the leading `/`. Paths the app uses itself (`/api`, `/settings`, `/library`, `/discover`, `/login`, `/assets` and the like) are refused with "Arclight uses that path itself".

A path works on every hostname Arclight answers on, and every portal page lives below it: `http://<your-host>:<port>/watch`, `/watch/movies`, `/watch/movie/603`, `/watch/search?q=dune`. Links inside the portal stay below the path you came in on, and refreshing or sharing a link works.

### Portal on its own hostname

To give the portal its own address, such as `requests.example.com`, while the full app stays on `arclight.example.com` (or only on your home network):

1. Point the new hostname at Arclight, the same way as the app's own hostname: a reverse proxy site or a Cloudflare Tunnel public hostname that forwards to Arclight's port. See [Reaching Arclight from outside your home](../getting-started/exposing-outside-home.md) for the proxy and tunnel set-up and the hardening steps.
2. Make sure the proxy passes the original hostname: the `Host` header, or `X-Forwarded-Host`. Caddy, Traefik, Nginx Proxy Manager and Cloudflare Tunnel do this by default; plain Nginx needs `proxy_set_header Host $host;`. In a tunnel, leave "HTTP Host Header" empty.
3. In **Settings > Requests > Public request portal**, add `requests.example.com` under **Portal hostnames** (type the hostname only; a pasted `https://` address is trimmed to its hostname) and save.

On that hostname the portal answers at the root: `https://requests.example.com/`, `/movies`, `/movie/603`, `/requests` (My requests). **Portal only** is on for a new hostname: any other page on that hostname (Settings, Library and so on) sends the visitor to the portal home, signed-in admins included, so the hostname never shows the admin pages. `/login` keeps working there. Turn **Portal only** off to let the rest of the app work on that hostname too (its portal pages still take precedence for `/`, `/movies`, `/search`, `/requests` and the other portal addresses).

Portal only hides the admin pages; it is not a security boundary. Every API call checks permissions whatever the hostname, so a user only ever reaches what their account allows.

**Signing in across hostnames.** The sign-in cookie belongs to the hostname it was set on, so signing in on `requests.example.com` does not sign you in on `arclight.example.com` and the other way round. Sign in once on each hostname you use. Arclight does not widen the cookie to the whole domain.

| Problem | Likely cause |
| --- | --- |
| The hostname shows the full app, not the portal | The hostname is not listed, the portal is off, or the proxy does not pass the original `Host` / `X-Forwarded-Host`. |
| Every page redirects to the portal home | **Portal only** is on for that hostname. Use the app's own address, or turn it off. |
| A portal path shows "Page not found" | The portal is off, or the path was not saved. |
| Anonymous visitors see "Too many requests" | They browsed very fast from one address (or a proxy hides client addresses, so everyone shares one). Send `X-Forwarded-For`. |

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
| Public request portal | See [Public request portal](#public-request-portal): on/off, anonymous browsing, message, portal paths and portal hostnames. |

### Discover sliders

The **Discover sliders** card controls the rows on Discover Home (in the app and in the portal). Show or hide each one, move them up or down, then click **Save order**. The built-in sliders are Recently added, Recent requests, Watchlist, Trending, Popular movies, Movie genres, Upcoming movies, Now playing, Top rated movies, Studios, Popular TV, TV genres, Upcoming series, Airing series, Top rated series, Networks and Streaming services. Sliders added in an update appear at the end of an existing order. Portal visitors who are not signed in never see Recent requests or Watchlist. **Add slider** creates a custom one from a TMDB keyword, genre, search, studio or network. **Reset to defaults** removes custom sliders and restores the default order.

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

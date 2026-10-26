# Setup, Sign-in, Dashboard and App Shell

This file covers the first-run setup wizard, signing in and out, Settings -> Security (authentication method, API key, user accounts), Settings -> Users, the Dashboard, and the "shell" around every page: sidebar, top bar, global search, mobile drawer, user menu, Profile page and session expiry.
Prerequisites: a browser. SET-01 to SET-11 need a brand-new instance with no data (on Native run `scripts\local-test.ps1 -Reset` and open http://localhost:17878; on Docker or NAS start with an empty config folder). Later checks assume setup is finished and an admin account exists.
Test environment: Native unless a step says otherwise. Steps marked "(Docker + VPN only)" need the VPN stack. Example values: admin `admin` / `Passw0rd-test1`, second account `viewer` / `Viewer-pass1`.

## Setup wizard (fresh install)

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| SET-01 | On a fresh instance open the root address (for example http://localhost:17878). | The browser goes to `/setup`. The page shows the brand name, the heading "Welcome · setup", and a step list: Admin account, TMDB key, Root folders, Download client (optional), Indexer (optional), Done. "Admin account" is highlighted as the current step. | |
| SET-02 | On the Admin account step click Create admin with Username `a`, Password `short`, Confirm password `other`, Email `foo`. | Red messages appear: "At least 2 characters." (Username), "At least 8 characters." (Password), "Passwords do not match." (Confirm password), "Not a valid email address." (Email). Change Username to `bad name!` and the message becomes "Letters, digits and . _ @ - only." Nothing is created. | |
| SET-03 | Enter Username `admin`, Password `Passw0rd-test1`, Confirm password `Passw0rd-test1`, leave Email empty, click Create admin. | The wizard moves to the "TMDB key" step and marks Admin account as done. You are already signed in (no login page appears). | |
| SET-04 | On the TMDB key step leave the box empty and click Test, then click Next. | Test shows red "Enter a key first." Next shows red "A TMDB API key is required for metadata." The wizard stays on this step. | |
| SET-05 | Type `not-a-real-key` and click Test. | A red error message from the server appears (invalid or unauthorized key). There is no green "Key works" text. | |
| SET-06 | Paste your real TMDB v3 API key and click Test, then click Next. | Test shows green "Key works (20 results for a test search)." (the number may differ). Next moves the wizard to "Root folders". | |
| SET-07 | On Root folders click Next in three cases: (a) both boxes empty, (b) TV root folder `tv` and Movies root folder `movies`, (c) `/data/media/tv` in both boxes. | (a) "Add at least one root folder." (b) "Use an absolute path." under both fields. (c) "TV and movies need different folders." under the Movies field. | |
| SET-08 | Enter two different absolute paths (Native example: `C:\NAS Setup\test-env\tv` and `C:\NAS Setup\test-env\movies`), keep "Create folders that do not exist" switched on, click Next. | The wizard moves to "Download client (optional)". The two folders now exist on disk. | |
| SET-09 | On the Download client step read the page, then click Skip. On the Indexer step click Skip. | Each optional step says "Optional." plus a hint that you can also do this later in Settings, and shows the normal Download Clients or Indexers list. The button reads Skip while nothing is configured. After the second Skip you reach "Done". | |
| SET-10 | On Done open the Authentication drop-down, keep "Login page (recommended)" and click Finish setup. | Options are "Login page (recommended)", "Browser prompt (HTTP Basic)", "None on the local network". After Finish setup the Dashboard opens. Typing `/setup` in the address bar afterwards returns you to the Dashboard. | |
| SET-11 | Reset to a fresh instance and create the admin, then close the tab at the TMDB step. Reopen the address, then repeat in a private window. | The normal window resumes at TMDB key (not the start). The private window shows "An admin account already exists. Sign in with it to continue setup." with a Sign in button; after signing in you return to `/setup`. | |

## Signing in and out

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| SET-12 | After setup, in Settings -> Security switch "Require for local addresses" on and Save. In a private window open the app, click Sign in with empty boxes, then with `admin` and a wrong password. | The browser goes to `/login`: brand, heading "Sign in", Username, Password, a "Keep me signed in" switch (on by default) and Sign in. Empty boxes give "Enter your username and password." A wrong password gives "Incorrect username or password." | |
| SET-13 | Sign in with `admin` and the correct password. Then in another private window open `/settings/security` directly and sign in. | The first sign-in opens the Dashboard and the user menu shows the letter "A" and the name admin. The direct link first goes to `/login?redirect=%2Fsettings%2Fsecurity` and after signing in opens the Security page, not the Dashboard. | |
| SET-14 | While signed in type `/login` in the address bar. Then click the user menu (top right) and click Sign out. | `/login` sends you straight back to the Dashboard. Sign out lands on `/login`; reloading any page returns to `/login`. | |
| SET-15 | Sign in with "Keep me signed in" switched off, close all browser windows, reopen the app. Repeat with the switch on. | Off: you must sign in again. On: you are still signed in. | |

## Settings -> Security and Settings -> Users

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| SET-16 | Open Settings -> Security. Open the Method list, set "Session length (days)" to `7`, click Save and reload. | Cards shown: "Authentication", "API key", "Users". Method options: "Login page", "Browser prompt (HTTP Basic)", "None on the local network". After reload the value 7 is still shown. | |
| SET-17 | In the API key card click Show, Hide, Copy, then Regenerate and confirm. | The key is dots by default; Show reveals a long monospace key, Hide hides it, Copy flashes "Copied" and pastes the same key. Regenerate opens "Regenerate the API key?" with "Every app using the current key stops working until it is given the new one." Cancel changes nothing; confirming shows a different key. (Old-key rejection: see 16-security.md.) | |
| SET-18 | In the Users card click Add user. Enter Username `viewer`, Display name `Viewer`, Email `viewer@example.com`, Role `User`, Password `Viewer-pass1`, Save. Then try Username `x` / Password `short`, and a second `viewer`. | `viewer` appears with a "user" badge and Last sign-in "never". `x` gives "Username needs at least 2 characters." and a short password "Password needs at least 8 characters." A duplicate name shows an error that it is taken and adds no row. | |
| SET-19 | On the `viewer` row click Reset password, enter `New-pass-2222`, Save. | Dialog "Reset password for viewer" with the hint "Signs the user out everywhere." Afterwards `Viewer-pass1` no longer works and `New-pass-2222` does. | |
| SET-20 | On your own admin row check Delete, then click Edit, set Role to User (you are the only admin) and Save. | Your row says "(you)" and Delete is disabled. The role change fails with an error that the only admin cannot be demoted; the role stays Admin. | |
| SET-21 | On the `viewer` row click Delete and confirm. | Dialog "Delete viewer?" says "Their sessions end immediately." The row disappears after confirming. | |
| SET-22 | Open Settings -> Users and click Manage on a user. | Table with User, Role, Permissions and a Manage button per row; the subtitle links to Settings -> Security. The "Manage <name>" dialog has tabs Permissions, Quota, Notifications. | |

## Dashboard

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| DSH-01 | Click Dashboard in the sidebar. | Title "Dashboard" with a subtitle like "v0.1.0 · up 5m" (it briefly says "connecting..." first; the version matches System -> Status). Cards: "Health" with a status badge, "Requests awaiting approval", "Scheduled jobs", "Recent runs". | |
| DSH-02 | Read the Health card and "Requests awaiting approval" on a healthy install with no requests. | Health shows "No issues" and "Every health check is passing." (when a check fails each row shows a warning or error badge, the check name and a message). Requests card shows "Nothing waiting" and its "All requests" link opens Requests. | |
| DSH-03 | In "Scheduled jobs" find `HealthCheck` and click Run now. Then click "All tasks" in the Recent runs card. | A toast "Started HealthCheck" with "Run #n is ..." appears and Recent runs gains a HealthCheck row without reloading. "All tasks" opens System -> Tasks. | |
| DSH-04 | Open the Dashboard with the built-in torrent engine enabled, then disabled (Settings -> Torrent Engine). | Enabled: a "Torrent engine" card with a state badge and rows Download, Upload, Active torrents, Peers; its "Settings" link opens Settings -> Torrent Engine. Disabled: the card is gone. | |
| DSH-05 | (Docker + VPN only) Enable VPN monitoring in Settings -> VPN and open the Dashboard. | A "VPN" card with a badge (Connected, Disconnected or Leak) and rows State, Public IP, Location, Last checked. Its "Settings" link opens Settings -> VPN. With monitoring off no VPN card appears. | |
| DSH-06 | (Docker + VPN only) Stop the VPN container and wait up to 2 minutes. | The VPN card badge turns "Disconnected" and the Health card lists a VPN error. | |

## App shell: sidebar and navigation

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| SHL-01 | Signed in as admin on a window wider than 900 px, look at the left sidebar. | Brand at the top, then in order: Dashboard, Library, Discover, Requests, Issues, Watchlist, Calendar, Activity, Wanted, Subtitles, Search, Indexers, Settings, System. Clicking the brand opens the Dashboard. | |
| SHL-02 | Click Library, then Settings, then System, then Activity, then Wanted. | The clicked section highlights and lists its children. Library: TV, Movies, Add New. Settings: Media Management, Profiles, Quality, Custom Formats, Indexers, Indexer Proxies, Indexer Options, Download Clients, Torrent Engine, Import Lists, Notifications, Subtitles, VPN, General, Security, Requests, Users. System: Status, Tasks, Logs, Backups, Health, Import. Activity: Queue, History, Blocklist, Pending, Manual Import. Wanted: Missing, Cutoff Unmet. | |
| SHL-03 | Type `/nothing-here` in the address bar, then on a loaded page press Tab once. | "Not found" page with "There is nothing at this address", the path and a working "Back to the dashboard" button. Tab shows a "Skip to content" link; Enter jumps to the main content. | |
| SHL-04 | Sign in as non-admin `viewer` (SET-18) and look at the sidebar, then type `/settings/general`. | Only Dashboard, Library, Discover, Requests, Issues, Watchlist, Calendar and Wanted show. Activity, Subtitles, Search, Indexers, Settings and System are hidden. The direct address redirects to the Dashboard. | |

## App shell: top bar, search, user menu, profile

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| SHL-05 | Click empty page space and press `/`. Then click into any text field and press `/`. | First: the "Search library or indexers..." box in the top bar gets focus. Second: a slash is simply typed. | |
| SHL-06 | With a series in the library (for example "Breaking Bad") type `break` in the top-bar search, press Down once, press Enter. Repeat but press Enter with no arrows, then repeat and press Esc. | A list shows "Breaking Bad" (year, "TV") and a last entry `Search indexers for "break"`. Down + Enter opens the highlighted title; plain Enter opens the best match (details page) and clears the box; Esc closes the list and leaves the box. | |
| SHL-07 | Type `zzzzqqq` and press Enter. | The Search page opens at `/search?q=zzzzqqq` and shows indexer results or "No results". | |
| SHL-08 | Look at the top-right indicator, then stop the Arclight process for 20 seconds and start it again. | A dot labelled "Live" (hover: "Live updates connected since <time>"). While stopped it reads "Reconnecting" (hover: "Connection lost; retrying in Ns"), and returns to "Live" without reloading the page. | |
| SHL-09 | Click the user menu in the top right, then choose "Profile and notifications". | Menu shows your name and role, "Profile and notifications", "Settings -> Security" (admins only) and "Sign out"; Esc closes it. The Profile page has cards "Account" (Username, Email, Role), "Request quota" ("You are exempt from request quotas." for admins; Movies and Series usage for others) and "Notifications and watchlist". | |
| SHL-10 | On Native set the method to "None on the local network" with "Require for local addresses" off, then open the app from the same PC and click the user menu. | The menu shows "no sign-in needed" and has no "Sign out" and no "Profile and notifications". | |

## App shell: mobile drawer and session expiry

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| SHL-11 | Narrow the browser below 900 px (or use a phone). Tap the menu button at the top left, tap a link such as Calendar, reopen it and tap the dark overlay, reopen it and press Esc. | The sidebar is replaced by the menu button. Tapping it slides the sidebar over the page with a dark overlay and the button is named "Close navigation". Tapping a link changes the page and closes the drawer; the overlay and Esc also close it. | |
| SHL-12 | Sign in, then in the browser developer tools (Application -> Cookies) delete the session cookie and click any sidebar link. As a second test sign in as the same user in browsers A and B, reset that user's password as admin, and click a link in browser A. | Both times the browser goes to `/login?redirect=<the page you were on>`; after signing in you return to that page. | |

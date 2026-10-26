# Mobile Layout, Home-Screen Install and Performance Smoke Tests

This file covers how Arclight looks and behaves on a phone or narrow window, what happens when you add it to a phone home screen, and a few "does it stay usable with a lot of data" smoke tests.
Prerequisites: signed in as an admin. Mobile checks work with a real phone on the same network (open `http://<host>:7878`) or with a desktop browser window narrowed below 900 px (in Chrome press F12, then the device toolbar icon, and pick "iPhone 12" or "Pixel 7"). Performance checks need a large dataset described in each step.
Test environment: Native for narrow-window checks; Docker or NAS for real phone checks. Timings are generous rules of thumb on an ordinary home PC or NAS, not benchmarks: if a result is 2 to 3 times slower than stated, note it in the Pass/Fail column but it is not an automatic failure.

## Mobile layout

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| MOB-01 | Open the Dashboard in a window narrower than 900 px (or on a phone). | The left sidebar is hidden. A menu button (three bars) sits at the top left of the top bar, next to the "Search library or indexers..." box. Cards stack in one column. The page does not scroll sideways. | |
| MOB-02 | Look at the right side of the top bar at phone width (under 640 px). | The connection dot is shown but its "Live" label is hidden, and the user menu shows only the round letter, not the name. | |
| MOB-03 | Tap the menu button, then tap Library. | The sidebar slides over the page with a dark overlay behind it and the button is named "Close navigation". Tapping Library opens the TV library, the drawer closes, and the Library section stays expanded the next time you open it. | |
| MOB-04 | Open the drawer and tap the dark overlay outside it. | The drawer closes. | |
| MOB-05 | Open Library -> TV on a phone. Use the "Posters" and "Table" buttons in the View group. | Posters wrap into a grid of fewer columns that fits the screen. Table view scrolls sideways inside its own box while the rest of the page stays still. | |
| MOB-06 | Open a series details page and expand a season. | The season header buttons (Search season, Interactive) wrap onto a new line rather than overflowing. The episode table scrolls sideways inside its box. | |
| MOB-07 | Tap the top-bar search box on a phone and type `break`. | The on-screen keyboard opens, the suggestion list is under the box and fully visible, tapping a suggestion opens that title. | |
| MOB-08 | Open Settings -> Download Clients, tap Add, and look at the dialog. | The dialog fits the screen width, fields are full width, the Save and Cancel buttons are reachable (scroll inside the dialog if needed). | |
| MOB-09 | Open System -> Tasks and System -> Logs at phone width. | Tables scroll sideways inside their cards; the toolbar on Logs wraps onto several lines with all controls still tappable; no text is cut off by the screen edge. | |
| MOB-10 | Open the login page (sign out first) at phone width. | The sign-in card is centered, uses almost the full width, the keyboard does not hide the Sign in button (scroll if needed), and signing in works. | |
| MOB-11 | Rotate the phone (or resize the window) from portrait to landscape and back, with the drawer open. | The layout adapts without errors. At 900 px or wider the sidebar becomes permanently visible and the menu button disappears. | |
| MOB-12 | Tap targets: on a phone tap Run now on System -> Tasks, the Show button on Settings -> Security, and a checkbox in a library table. | Each control reacts to a single normal tap without needing to zoom in. | |

## Home-screen install and offline behaviour

Arclight does not currently ship a web app manifest or a service worker. The checks below record the current behaviour so a future change is noticed.

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| MOB-13 | Open the app in Chrome on a phone or desktop and look at the address bar. | No "Install app" icon is offered in the address bar or menu (the browser only offers "Add to Home screen" as a plain shortcut). | |
| MOB-14 | In desktop Chrome press F12, open the Application tab, and look at "Manifest" and "Service workers". | "No manifest detected" and no registered service worker. | |
| MOB-15 | In the browser address bar go to `<address>/manifest.webmanifest` and `<address>/sw.js`. | Neither shows a manifest or script (you see the normal app page or a not-found page). | |
| MOB-16 | On a phone use the browser menu "Add to Home screen" and open the new icon. | The icon opens Arclight in a normal browser tab (not a standalone window) and you are still signed in. The page title shown is the app name. | |
| MOB-17 | Open the app, then switch the device to airplane mode and reload the page. | The browser's own "no internet / site cannot be reached" page appears (no cached app is shown). When the network returns and you reload, the app loads normally and you are still signed in. | |
| MOB-18 | Check the page head: in the browser developer tools open the Elements tab and look at the `<head>`. | A viewport meta (`width=device-width, initial-scale=1.0`) and `color-scheme` set to dark are present, so the page is not shown zoomed out on phones. | |

## Performance smoke tests

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| PRF-01 | Add a very long series through Library -> Add New: search `One Piece` and add it (it has over 1,000 episodes; "The Simpsons" with over 700 or "Doctor Who" are alternatives). Leave "monitor" on. | The add finishes and the series appears in Library -> TV within about 30 seconds. The progress of the metadata refresh finishes within a few minutes; the Dashboard stays responsive meanwhile. | |
| PRF-02 | Open the long series details page. | The page header shows within 3 seconds and the season list within 5 seconds. Only the latest season is expanded; others are collapsed with episode counts in their header (for example "1100 episodes"). | |
| PRF-03 | Click the header of the biggest season (Season 1 or the one with the most episodes) to expand it, then collapse it. | The episode table appears within 2 seconds and scrolling it stays smooth (no multi-second freezes). Collapsing it is instant. | |
| PRF-04 | On the same page expand 5 seasons at once. | The page stays usable: scrolling does not stutter badly and the tab does not show "page unresponsive". | |
| PRF-05 | Click the monitor toggle of one season off and on again. | The toggle changes immediately and the "wanted" badge counts update within 2 seconds. | |
| PRF-06 | Click Search season for a season with about 100 episodes. | The click returns right away with a toast; the page does not freeze while searching continues in the background (see Activity -> Queue and History). | |
| PRF-07 | Create a queue of about 50 items: with a working download client and indexer open Wanted -> Missing, make sure at least 50 episodes are listed (the page shows 50 per page), and click "Search all" (confirm if asked). Wait a few minutes. | Activity -> Queue fills. Its subtitle reads "N items" with N around 50 (with "· N errors" or warnings if any). | |
| PRF-08 | Open Activity -> Queue with 50 items. | The page loads within 3 seconds and shows 20 rows per page with a pager reading "Page 1 of 3 · 50 total". The buttons « ‹ › » move between pages in under a second each. | |
| PRF-09 | Tick "Select all" on page 1 of the queue, then un-tick it. | All 20 boxes tick and un-tick instantly; "Remove selected (20)" appears and disappears with them. | |
| PRF-10 | Keep Activity -> Queue open for 5 minutes while downloads progress. | Progress bars and ETA update by themselves about every few seconds, the page does not slow down, and the browser tab's memory stays reasonable (under about 500 MB in the browser task manager). | |
| PRF-11 | Build a library with about 500 titles (for example import a large Sonarr or Radarr database with System -> Import, or add many titles via Library -> Add New). | The import or adds finish without errors. System -> Health shows no new errors. | |
| PRF-12 | Open Library -> TV (or Movies) with about 500 titles in Posters view. | The first posters show within 3 seconds; scrolling the whole page is smooth; images load as you scroll (placeholders for the rest are fine). | |
| PRF-13 | Switch to Table view, then type `the` into "Filter by title...", then clear it. | Table renders within 2 seconds. The filter narrows rows within about 1 second after each keystroke and clearing restores all rows. | |
| PRF-14 | Change "Sort by" through three different options and flip the ▲/▼ button. | Each change re-sorts within 1 second with no flicker of an empty page. | |
| PRF-15 | Tick "Select all" in Table view with 500 titles, then click Clear selection (or the equivalent button in the bulk bar). | The selection bar shows the count (for example 500 selected) within 1 second and clearing it is just as fast. | |
| PRF-16 | Type `a` in the top-bar search with the 500-title library. | The suggestion list shows at most 8 matches within 1 second, plus the `Search indexers for "a"` entry. | |
| PRF-17 | Open System -> Logs, leave Follow on, and run "RssSync" and "RefreshQueue" from System -> Tasks several times in a row. | Log lines stream in without the table becoming sluggish; the table keeps only the newest rows (it shows at most 50 per page). | |
| PRF-18 | Open Calendar for the current month with the 500-title library. | The month grid renders within 3 seconds; switching months takes under 2 seconds. | |
| PRF-19 | Check memory after the checks above: in Chrome press Shift+Esc to open its Task Manager and look at the Arclight tab. | The tab uses less than roughly 700 MB after an hour of use. On the server, the Arclight process (Docker `docker stats`) stays under roughly 1 GB of RAM while idle with 500 titles. | |

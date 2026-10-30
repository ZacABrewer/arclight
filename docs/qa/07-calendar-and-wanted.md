# Calendar and Wanted

This file checks the Calendar page (prefix CAL), including the iCal feed, and the Wanted -> Missing and Wanted -> Cutoff Unmet pages (prefix WNT).
Prerequisites: a TMDB key and a few series and movies already in the library (see 02-library.md). For useful calendar content add at least one currently airing series (for example `Severance`) and one movie with a release date close to today. For the Wanted pages you need monitored items with no file on disk.
Test environments: Native, Docker and NAS all apply. Steps marked "via API" use `curl` with the API key from Settings -> Security; replace `<host>` with `localhost:17878` (Native) or `<host>:7878` (Docker/NAS).
The Calendar has only a Month view and an Agenda view (no week view, no tag or type filters, and no popovers: entries are links to the series or movie page). Cutoff Unmet is listed in the sidebar but the server does not yet provide the data, so that page currently shows a "not available" message; WNT-09 records that.

## Calendar page

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| CAL-01 | Click Calendar in the sidebar. | Page "Calendar" opens with an "iCal link" button top right. A header row shows "<" and ">" buttons (labels "Previous month" / "Next month"), a "Today" button, the month name and year (for example "October 2026"), a "Show unmonitored" toggle and Month / Agenda buttons. | |
| CAL-02 | Look at the month grid. | Columns are Monday to Sunday abbreviations. Whole weeks are shown, so days from the neighbouring months appear dimmed. Today's cell is highlighted. | |
| CAL-03 | Find a day with an episode of a monitored series. | A coloured chip shows the series title (with a time such as "9:00 PM" in front when the air time is known). Hovering shows a tooltip like "Severance - S02E05 · Title (Wanted)" with the status in brackets. | |
| CAL-04 | Compare chip colours for an aired episode with no file, an episode with a file, and a future episode. | Statuses are distinguishable by colour and the tooltip: Wanted (aired, monitored, no file), Downloaded (has a file), Unaired (future date), Missing (aired, not monitored), TBA (no date). | |
| CAL-05 | Click a chip for an episode. | You go to that series' detail page. Use the browser back button to return to the calendar. | |
| CAL-06 | Find a movie entry (a movie in your library with a cinema, digital or physical date in the visible month). | A chip shows the movie title; the tooltip detail reads "In cinemas", "Digital release" or "Physical release". A movie with more than one date appears once per date. Clicking opens the movie page. | |
| CAL-07 | Click ">" twice, then "<" once, then "Today". | The title changes month by month and the grid updates; a small spinner may flash while loading. "Today" returns to the current month. | |
| CAL-08 | Click "Agenda". | The grid is replaced by one section per day that has entries, each headed with the full date (for example "Friday, 10 October 2026") and a table of: time (or "All day"), title link, detail (for example "S02E05 · Title"), and a status badge. Empty months show "Nothing scheduled this month". | |
| CAL-09 | Click "Month" again. | The month grid returns. | |
| CAL-10 | Unmonitor one series (Library -> TV, click its monitor toggle), return to Calendar and check its entries. Then switch "Show unmonitored" on. | With the toggle off the unmonitored series' episodes disappear (the page refetches on load). With the toggle on they return and appear faded. Re-monitor the series afterwards. | |
| CAL-11 | Via API: `curl -H "X-Api-Key: <key>" "http://<host>/api/v1/calendar?start=2026-10-01&end=2026-10-31&includeSeries=true"`. | Returns a JSON list of items, each with `type` of "episode" (with `seriesTitle`, `episode`) or "movie" (with `releaseKind` of cinema, digital or physical) and a `date`. The items match what the grid shows for that month. | |

## iCal feed

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| CAL-12 | Click "iCal link". | A dialog "iCal feed" opens with number boxes "Past days" (7) and "Future days" (28), a toggle "Include unmonitored", a read-only "Feed URL" box (hint "Subscribe to this URL in your calendar app.") and a "Copy link" button. | |
| CAL-13 | Look at the Feed URL. | It starts with the address you are browsing (for example `http://localhost:17878`) followed by `/api/v1/calendar/feed.ics?token=` and a long random string, plus `pastDays=7` and `futureDays=28`. | |
| CAL-14 | Change Past days to `30`, Future days to `90` and switch on "Include unmonitored". | The URL updates live with `pastDays=30`, `futureDays=90` and `unmonitored=true`. | |
| CAL-15 | Click "Copy link". | The button changes to "Copied". Paste into a text editor to confirm the full URL was copied. | |
| CAL-16 | Open the copied URL in a new private browser window (no login). | A calendar file downloads or displays as text starting with `BEGIN:VCALENDAR`, containing `X-WR-CALNAME:Arclight` and events with `SUMMARY:` lines such as `Severance - S02E05 - Title` or `Movie Title (Digital release)`. | |
| CAL-17 | Change the last characters of the token in the URL and open it. | The request is refused with an unauthorized error and no calendar is returned. | |
| CAL-18 | In your calendar app (Google Calendar: Other calendars -> From URL; Outlook: Add calendar -> Subscribe from web; Apple Calendar: File -> New Calendar Subscription) paste the feed URL. | The calendar subscribes and shows the episodes and movie releases, with episode air times for series with a known air time and all-day entries for movies. The URL must be reachable from the calendar app: on Native it is only reachable on the same machine; for Google or Outlook use a URL reachable from the internet (reverse proxy) or test with an app on your LAN. | |
| CAL-19 | Compare the number of events in the subscribed calendar with the Month and Agenda views for the same period. | The same episodes and releases appear (unmonitored ones only if "Include unmonitored" was on). The feed token is the same every time you open the dialog; there is no regenerate button in the web app. | |

## Wanted -> Missing

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| WNT-01 | Click Wanted -> Missing in the sidebar. | Page "Missing" opens with two tabs: "Episodes" and "Movies". The Episodes tab shows a card titled "N episodes" with buttons "Search selected (0)" (disabled) and "Search all", and a table "Wanted episodes". | |
| WNT-02 | Look at the Episodes table. | Columns: select checkbox, Series (link), Episode (for example S02E05), Title, Air date, Status (chip). Only monitored episodes that have already aired and have no file are listed; specials are not listed. With nothing missing it shows "No missing episodes". | |
| WNT-03 | Click a series name in the table. | You go to that series' detail page. | |
| WNT-04 | Tick two episodes, then tick the header "Select all" box and untick it. | The button reads "Search selected (2)" and becomes enabled; Select all ticks every row on the page, unticking clears them. | |
| WNT-05 | With two episodes ticked click "Search selected (2)" (needs an indexer). | A toast like "Search finished" or "Grabbed 1 release" appears, with a message such as "8 found · 2 approved". Without indexers an error toast "Search failed" or zero results appear. | |
| WNT-06 | Click "Search all" (try it only with a handful of missing episodes). | One search runs for all missing episodes (up to 500) and a result toast appears. The button shows a spinner while running. | |
| WNT-07 | If there are more than 50 missing episodes, scroll to the bottom. | A pager shows "Previous", "Page 1 of N" and "Next". "Next" shows the next 50, resets the checkboxes and enables "Previous". With 50 or fewer items no pager is shown. | |
| WNT-08 | Click the "Movies" tab. | A card "N movies" with "Search selected (0)" and "Search all" and a table "Wanted movies": select checkbox, Title (link), Year, Profile, In cinemas, Digital, Physical. Only monitored movies without a file are listed; with none it shows "No missing movies". Selecting rows and clicking "Search selected" gives a toast per search as in WNT-05, and "Queued N searches" when more than one was sent. | |
| WNT-09 | Click Wanted -> Cutoff Unmet. | Page "Cutoff unmet" with tabs "Episodes" and "Movies". Because the native server does not serve these lists yet, each tab shows "Cutoff unmet is not available yet" and "The api does not serve the cutoff-unmet lists yet. They will appear here once the route lands." If a list does appear instead, check the columns match WNT-02 / WNT-08 and the empty text reads "No episodes below cutoff" / "No movies below cutoff". | |
| WNT-10 | Open a series in Library, unmonitor one missing episode (episode toggle on the Episodes tab), then reload Wanted -> Missing. | That episode is no longer listed (the Missing list only contains monitored items) and the series page shows its status as "Missing" rather than "Wanted". There is no monitor toggle on the Wanted page itself. | |
| WNT-11 | Via API: `curl -H "X-Api-Key: <key>" "http://<host>/api/v1/wanted/missing/episodes?page=1&pageSize=10"` and `.../wanted/missing/movies`. | Each returns a page object with `records` and `totalRecords`, matching the counts in the card titles. Add `&includeSpecials=true` to include season 0 episodes. | |

## Wanted release filter and unreleased items

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| WNT-12 | Open Wanted -> Missing with at least one aired and one future monitored episode. Look at the filter above the table. | "Release status" shows Released by default and lists only the aired episode; "Release date" shows "Any release date". Cutoff unmet also defaults to Released. | |
| WNT-13 | Switch "Release status" to Upcoming, then All. Repeat on the Movies tab (and on Albums and Books if enabled). | Upcoming lists only unreleased items, including ones with no date; All lists both. Each tab applies the filter to its own list, and the choice stays in the address bar after a reload. | |
| WNT-14 | Pick "Released in the last 7 days", then fill in "Released after" and "Released before". Click "Clear filters". | The dropdown reads "Custom range" once a date is typed; items with no release date drop out as soon as a date bound is set; the page returns to 1. "Clear filters" resets everything. | |
| WNT-15 | On the Upcoming list look at a row's Search button. Tick it and an aired row on All, then click "Search selected". | Upcoming rows show an "Upcoming · date" chip (or "Not released · no date") and a disabled Search button. The bulk search runs for the released row only and the toast says how many were skipped. | |
| WNT-16 | Open Interactive search on an upcoming episode or movie from its page. | A banner reads "Not released yet (expected <date>)" with a note that automatic searches and Search buttons skip it; results can still be grabbed. | |
| WNT-17 | In Settings -> Media Management open "Unreleased items". Switch on "Search unreleased items" and click Search on an upcoming movie, then set "Wait after release" to 24 and save. | With the switch on, a user-started search on an upcoming item is allowed; automatic searches still skip it. "Wait after release" accepts 0 to 168 and holds automatic searches back that many hours after the air or release time. | |

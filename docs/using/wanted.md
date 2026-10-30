# Wanted

Wanted is Arclight's to-do list. It shows everything you asked it to keep but does not have yet (**Missing**), and everything it has but in lower quality than your profile wants (**Cutoff unmet**). You use it to see why a show or movie has not shown up, and to start searches by hand instead of waiting for the automatic ones.

Find it in the left menu under **Wanted**. There are two lists, **Missing** and **Cutoff unmet**, and on each you switch between **Episodes** and **Movies**.

## What counts as wanted

### Missing

An item is on the Missing list when all of these are true:

- It is monitored. For episodes, both the episode and its series must be monitored. See [Library](library.md#what-monitored-means).
- It has no file on disk.
- It has already aired (episodes) or is available (movies).
- For episodes, it is not a special (season 0). Specials are left out of the automatic searches.

For movies, "available" depends on the movie's **minimum availability**:

| Minimum availability | A movie becomes wanted when |
| --- | --- |
| Announced | Immediately. |
| In cinemas | Its cinema date has passed (or its status is In cinemas or Released if no date is known). |
| Released | Its digital or physical release date has passed. If only a cinema date is known, 90 days after it. |

If a movie you added does not appear on the list, check the minimum availability first, then whether the release date is in the future.

An empty Missing list says "Every monitored item that has aired is on disk."

### Cutoff unmet

An item is on Cutoff unmet when it has a file, but the file's quality (or custom format score) has not reached the cutoff of the quality profile that item uses. Arclight will keep looking for upgrades until the cutoff is met. An empty list says "Every file meets its profile cutoff." See [Quality profiles](quality-profiles.md) for how cutoffs work.

A file marked **Kept by choice** (grabbed with **Grab anyway**) is not on this list and is not searched for, even below the cutoff, until you allow upgrades again. See [Interactive search](interactive-search.md#kept-by-choice).

If an item has several versions (for example a 1080p and a 4K copy, see [Library](library.md)), a **Versions** column shows each version's state.

## The lists

Episodes list columns: Series, Episode, Title, Air date, Status, Versions, and a **Search** button. Movies list columns: Title, Year, Profile, In cinemas, Digital, Physical, Status, Versions, and a **Search** button. Lists show 50 rows per page.

## Finding an item on the list

The search box at the top of the list narrows it down. It matches the series title, the episode title or an episode code such as `s01e02` (episodes), the title (movies), the album or artist (albums), and the book, author or series (books); every word you type must match, upper or lower case does not matter, and dots, dashes and underscores count as spaces. The search is kept in the address bar, so a reload or a shared link keeps it. The box is shared by the media-type switch, so switching from Episodes to Movies keeps the same search. While a search is active the count says how many items match, and **Search all** becomes **Search all matching**: it searches only the matching items. **Select all N** in the bulk bar also means "all matching items". On **Profile mismatch** the same box matches the title, the episode code, the profile, the quality and the version.

## Release filter: released and upcoming items

Both lists (Missing and Cutoff unmet), for episodes, movies, albums and books, have a release filter above the table:

- **Release status**: **Released** (the default), **Upcoming** or **All**. Released shows what is already out. Upcoming shows what is not out yet, including items with no known release date. All shows both. Cutoff unmet also defaults to released items.
- **Release date**: **Any release date**, **Released in the last 7 days**, **Released in the last 30 days** or **Released in the last year**. For a fixed range, fill in **Released after** and **Released before** (either or both); the dropdown then reads **Custom range**. Dates are whole days in UTC.

Items with no release date drop out of the list as soon as you set a date bound. **Clear filters** resets everything. The filter is kept in the address bar, so you can bookmark it or share the link, and changing it takes you back to page 1.

### What "release date" means

| Type | The release date is |
| --- | --- |
| Episode | Its air time (or the start of its air date when no time is known). |
| Movie | The date that satisfies its minimum availability. **Announced**: the movie always counts as out. **In cinemas**: the cinema date. **Released**: the earlier of the digital and physical dates, or the cinema date plus 90 days when only that is known. With no dates at all, the movie's status field decides. |
| Album, book | Its release date. A bare year or year and month counts from the start of that period. With no date, the item counts as unreleased. |

### Upcoming items and searching

An upcoming row shows an **Upcoming · date** chip, or **Not released · no date** when nothing is known, and its **Search** button is disabled. **Search selected** and **Search all** skip upcoming items, and the toast says how many were skipped. [Interactive search](interactive-search.md) still works on them, with a warning banner that the item is not released yet; anything you grab there is your call.

Automatic searches (missing and cutoff/upgrade) never look for unreleased items. Two settings under **Settings > Media management > Unreleased items** change this (see [Media management](media-management.md#unreleased-items)):

- **Search unreleased items** (off by default) lets searches you start yourself, the **Search** buttons and bulk searches, include unreleased items. Automatic searches still never do.
- **Wait after release** (0 to 168 hours, default 0) makes automatic searches wait this long after the air or release time. It helps with episodes that air late at night, before they are available.

RSS sync is not affected by these settings. It already refuses a single episode more than 60 minutes before it airs (unless unaired releases are allowed), season packs that contain unaired or undated episodes, movies before their availability, and albums or books dated more than a day ahead.

## Searching

| Button | What it does |
| --- | --- |
| Search (on a row) | Searches indexers for that one episode or movie right now. |
| Search selected | Tick rows, then search just those. On Cutoff unmet the button is **Search for upgrades**. **Select all N** in the bar takes every item on the list, on every page. The bar also has **Unmonitor**. See [Bulk actions](library.md#bulk-actions). |
| Search all | Searches every item on the list (not just the current page) in one background job. A toast says how many items were queued. |

A search asks your enabled indexers for matching releases, runs them through your quality profile and other rules, and grabs the best one if it passes. Grabbed releases appear in [Activity > Queue](activity.md). If nothing is grabbed, open the item and use [interactive search](interactive-search.md) to see every release and the reason each was rejected. For a general "nothing found" checklist, see [Nothing found](../TROUBLESHOOTING.md#nothing-found).

Searches you start here do not wait for any back-off timer (see below).

## How automatic search is scheduled

Arclight looks for wanted items in three ways. You do not have to do anything for them to work.

| Mechanism | When | What it does |
| --- | --- | --- |
| RSS sync | Every 15 minutes by default (**Settings > Indexer Options**, "RSS sync interval"; 0 means on demand only) | Reads the newest releases from your indexers and grabs the ones that match something wanted. This is how new episodes are normally picked up soon after they air. |
| Missing search | Daily at 03:00 (episodes) and 03:20 (movies) | Searches for missing items one by one. At most 200 episodes and 100 movies per run. |
| Cutoff unmet search | Daily at 03:40 | Searches for upgrades. At most 100 episodes and 100 movies per run. |
| Delayed releases | Every minute | Releases held by a delay profile are grabbed when their wait is over (see [Activity > Pending](activity.md#pending)). |

You can see these jobs and run them early under **System > Tasks** (see [System](system.md)). They are named MissingEpisodeSearch, MissingMovieSearch and CutoffUnmetSearch.

### Back-off: why a missing item is not searched every night

So that Arclight does not hammer your indexers for something that is not out there, each item has a search counter:

- The first search happens in the next nightly run.
- After each unsuccessful search, the item waits one more day before the nightly job considers it again: 1 day after the first search, 2 days after the second, and so on, up to a maximum of 7 days.
- Episodes of the same season are searched together in one request.
- When something is grabbed for the item, the counter is cleared.

Because of the per-run limits, a very large backlog is worked through over several nights.

## Common questions

**An episode aired but is not on the list.** Check that the series and the episode are monitored, and that it is not a special.

**I added a series and nothing is downloading.** The nightly searches run at 03:00. Open **Wanted > Missing** and press **Search all** (or use the search on the series page) to start right away.

**Search says nothing was found.** The release may not exist yet, your indexers may not carry it, or every release was rejected by your profile. Use [interactive search](interactive-search.md) to see the rejection reasons.

## Related

- [Library](library.md) - monitoring and what "monitored" means
- [Interactive search](interactive-search.md) - choose a release yourself
- [Activity](activity.md) - the download queue
- [Quality profiles](quality-profiles.md) - cutoffs and upgrades
- [Indexers](indexers.md)
- [Troubleshooting: nothing found](../TROUBLESHOOTING.md#nothing-found)

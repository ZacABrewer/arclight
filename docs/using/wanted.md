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

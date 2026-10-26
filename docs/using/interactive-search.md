# Interactive search

Automatic search picks a release for you. Interactive search lets you see every release the indexers returned, why each one was accepted or rejected, and choose one yourself. Use it when automatic search found nothing, grabbed something you did not want, or when you simply want a specific release.

There are two places to do it:

- **Library interactive search**: for a series, a season, an episode or a movie that is already in your library. Arclight judges every release against that item's quality profile and rules.
- **The Search page** (**Search** in the left menu): a free-text search across all your indexers, like a manual search in an indexer's website. Admin only.

## Library interactive search

### Opening it

| Where | How |
| --- | --- |
| Series page | **Interactive search** button at the top (whole series), the **Interactive** button on a season row, or the interactive search button on an episode row. |
| Movie page | **Interactive search** button at the top. |
| Series or movie page, **Search** tab | Runs the same search and shows the results inline. |

Arclight asks every indexer that has interactive search enabled. This can take several seconds while it says "Searching indexers". If nothing comes back, the table says "No releases found. Every enabled indexer was searched."

### The table

| Column | What it shows |
| --- | --- |
| Source | The protocol: torrent or usenet. |
| Title | The release name. If the indexer gave a link, the title opens its info page. |
| Indexer | Which indexer returned it. |
| Age | How old the release is (days, hours or minutes). |
| Size | File size. |
| Peers | For torrents, seeders / leechers (`?` if the indexer did not say). A dash for usenet. |
| Quality | The quality Arclight read from the name. |
| Version | Only for items with several versions (for example 1080p and 4K). Shows which version slot the release would fill. |
| Formats | Custom formats that matched, and the total custom format score. |
| Decision | **Approved**, or a count of rejections such as "2 rejections". |
| Grab | The grab button. |

Click a column header to sort. The default order puts approved releases first, then temporarily rejected, then rejected.

### Rejections

Hover (or focus) the rejections chip to see every reason. Each rejection is one of two kinds:

- **Permanent**: this release will not be accepted as it is. For example the quality is not wanted in the profile, the file is too small, or the release is blocklisted.
- **Temporary**: checked again later, so it may become acceptable. For example it is younger than the minimum age, or a delay profile is still waiting for a better release. Temporarily rejected releases are shown in amber.

Common reasons you will see, in plain words:

| Message (roughly) | What it means |
| --- | --- |
| `<quality> is not wanted in profile` | The quality profile does not allow this quality. |
| Custom Formats score is below the profile minimum | The release scores too low for the profile. |
| `<size>` is smaller than minimum allowed | Below the size limit for its quality (see [Media management](media-management.md) and [Quality profiles](quality-profiles.md)). |
| Not enough seeders | Fewer seeders than the indexer's minimum. |
| Release is blocklisted | You or Arclight blocked it before. See [Activity > Blocklist](activity.md#blocklist). |
| Release is already in the download queue | Already downloading. |
| Episode is not monitored | The episode is not monitored. |
| Episode has not aired yet | Single-episode releases before the air date are refused unless allowed. |
| Only N minutes old, minimum age is M minutes | Usenet minimum age setting. |
| Older than configured retention | Usenet retention setting. |
| Sample / Hardcoded subs found | The release looks like a sample, or has burned-in subtitles. |
| Waiting for better quality release | A delay profile is holding the grab. See [Activity > Pending](activity.md#pending). |
| Season pack upgrades only X of Y episodes | A season pack would only improve some episodes. |
| The quality or format already on disk is as good or better | Several "cutoff met" and "not an upgrade" messages. Nothing to gain. |

The wording comes from Arclight's decision engine, so you may see other messages for rarer cases.

### Grabbing a release

Click **Grab**. The release is sent to your download client and appears in [Activity > Queue](activity.md). The grab is attached to the series, episodes or movie you searched for.

The **Grab** button is only enabled for approved releases. A rejected release shows a disabled button. If you want a rejected release anyway, use the Search page below (it has no such lock), or change the profile or rule that rejected it and search again.

## Why this release

Every time Arclight searches or reads RSS for an item, it keeps a record of each release it judged, and why. Use this to answer "why did it download that one?" or "why did it skip the one I wanted?".

- On a series or movie page, open the **Decisions** tab. You will see batches, newest first. Each batch is labeled with what triggered it: Search, RSS sync, Interactive search, Release push, or Pending re-check, plus the time.
- In **Activity > History**, open a Grabbed event and click **Why this release**. This shows the batch that led to that grab.
- Each row shows a rank, the release name, quality and score, **Approved** or the list of rejections (Permanent or "Temporary, checked again later"). The one that was grabbed has a **Grabbed** chip, and the best choice among approved releases has **Best match**. A batch shows how many releases were judged, how many approved and how many rejected, and links to the grab in History.

An empty tab says "No decisions logged yet." The log is pruned automatically; by default it keeps 14 days.

## The Search page

Open **Search** in the left menu. Use it to find a release by name, including things that are not in your library.

1. Type a title or release name and click **Search**. You can also use the top bar's search; library matches show as you type.
2. Optionally narrow it with the filters: **Type** (All types, TV, Movies), **Categories** and **Indexers** (only indexers with interactive search enabled are listed).
3. Results appear in a table with Title, Indexer, Age, Size, Peers (seeders / leechers for torrents, grabs for usenet), Quality, Formats, a rejection icon and actions. Use **Filter titles** and the protocol selector (Any protocol, Torrent, Usenet) to narrow the results afterwards. The heading shows "N of M results".
4. Use the download icon to get the .torrent or .nzb file, or open the magnet link. Use **Grab** to send it to your download client.

When you click **Grab** on this page, Arclight checks whether the release matches something in your library:

- If it matches, it is grabbed and tracked like any other grab.
- If it matches nothing, you are asked **Force grab?**. Force grabbing sends it to the default client for that protocol. It will show as unknown in the queue (turn on **Show unknown**) and will not be imported. Use this for things you manage by hand.

If a result has an alert icon, hover it to read the reasons listed for that result. For the full judgment against a specific item's profile, use the library interactive search above.

## Related

- [Wanted](wanted.md) - automatic searching and what is missing
- [Activity](activity.md) - the queue, history and blocklist
- [Quality profiles](quality-profiles.md) - why releases are accepted or rejected
- [Indexers](indexers.md) - enable interactive search per indexer
- [Troubleshooting: nothing found](../TROUBLESHOOTING.md#nothing-found)

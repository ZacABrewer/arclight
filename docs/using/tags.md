# Tags and tag rules

Tags are short labels you put on movies, series, artists and authors. You can filter the library by tag and change many tags at once from the bulk bar. Tag rules add tags for you: "tag every horror film `genre:horror`", "tag everything Sam requested `requested:sam`", "tag 4K HDR files `4k-hdr`".

Open **Settings > Tags** (administrators). The page has two parts: **Tags** and **Rules**.

> **Tags change behaviour.** Tags are not only labels. Delay profiles, release profiles, indexers, indexer proxies, download clients, import lists, notifications, request override rules, retention rules and transcode rules can be limited to items with certain tags. If a rule adds a tag that one of those uses, the matching items are searched, grabbed, downloaded, announced or cleaned up differently. That is often the point (for example, a `kids` tag that sends kids' films to their own download client), but check first. Settings > Tags marks those tags **Drives behaviour**, and every preview and run lists which settings use the tags it would add or remove.

## Tags

The list shows every tag with:

- where it is used: how many movies, series, artists, authors and requests carry it, and how many indexers, profiles, download clients, notifications and other settings use it;
- **Drives behaviour** when any of those settings use it;
- the rules that add it, and how many items carry it because a rule added it.

What you can do:

| Action | What happens |
|---|---|
| Rename | Changes the label everywhere at once (labels are stored by id). |
| Merge | Moves everything tagged A to tag B, in the library, requests, settings and rules, then deletes A. |
| Delete | Removes the tag from everything that uses it. The confirmation lists where it is in use first. |
| Delete unused | Deletes every tag nothing uses, in one go. |
| Show movies / Show series | Opens the library list filtered to that tag (`/library/movies?tag=ID`, `/library/tv?tag=ID`). |

Deleting a tag also takes it out of retention and transcode rule scopes. A retention or transcode rule left with no tags in its scope is switched off rather than widened to the whole library.

## Tag rules

A rule has:

| Setting | Default | Meaning |
|---|---|---|
| Name | none | Shown in the list and in the tooltip on auto-added tags. |
| Enabled | on | Disabled rules only run when you run them by hand. |
| Applies to | movies, series | Movies, series, artists, authors, or several. |
| Match | All conditions | **All conditions** or **Any condition**. No conditions: every item of the selected types matches. |
| Conditions | none | See the list below. |
| Add tags | none | Fixed labels (`kids`) or templates (`genre:{genre}`). |
| Remove tags | none | Tags to take off matching items, whoever added them. |
| Remove when no longer matching | on | Takes this rule's tags off items it no longer matches. Tags you added by hand are never removed. |

### Conditions

Text conditions compare without regard to case. Each one uses **is any of**, **is all of**, **is none of**, **has any value** or **has no value**.

| Condition | Items | Values |
|---|---|---|
| Genre | all | Genres from metadata. Authors also get their books' genres. |
| Resolution | movies, series | `2160p`, `1080p`, `720p` … of the files on disk (from the quality, else the probed picture size). A series has the resolutions of all its episode files. |
| Quality | all | Quality names such as `Bluray-1080p`, `WEBDL-2160p`, `FLAC`. |
| Source | movies, series | `bluray`, `blurayRaw` (remux), `web`, `webRip`, `television`, `dvd` … |
| HDR | movies, series | `dv`, `hdr10+`, `hdr10`, `hlg`, `pq`, or `hdr` for HDR of an unknown kind. SDR files have no value. Needs media analysis. |
| Video codec | movies, series | `hevc`, `h264`, `av1`, `vp9`, `vc1`, `mpeg2`, `xvid`. |
| Audio codec | all | As probed, for example `eac3 atmos`, `dts-hd ma`, `flac`. |
| Audio language | movies, series | Languages of the audio tracks and of the release, lower case (`eng`, `english`, `jpn`). |
| Original language | movies, series | The language code from metadata, for example `en`, `ja`. |
| Certification | movies, series | `G`, `PG`, `PG-13`, `R`, `TV-Y`, `TV-MA` … |
| Network | series | From metadata. |
| Studio | movies | From metadata. |
| Status | movies, series, artists | `continuing`, `ended`, `upcoming`; movies `announced`, `inCinemas`, `released`. |
| Series type | series | `standard`, `daily`, `anime`. |
| Root folder | all | The root folder path. |
| Collection | movies | The movie collection's name. |
| Release group | all | Release groups of the files. |
| Album type | artists | Primary and secondary types of the artist's albums: `Album`, `EP`, `Single`, `Live`, `Compilation` … |
| Artist type | artists | `Person`, `Group` … |
| Author | authors | The author's name. |
| Narrator | authors | Narrators of the author's books. |
| Book series | authors | Series the author's books belong to. |
| Year | movies, series | Release year, a range. |
| Rating | movies, series | TMDB rating (else IMDb), 0 to 10, a range. |
| Audio channels | all | The most channels of any file, for example 2, 5.1, 7.1. |
| Size | all | Size of all files in GB. |
| Added (days ago) | all | Days since the item was added. "Added in the last 14 days" is a maximum of 14. |
| Runtime | movies, series, authors | Minutes. For authors, the length of all their books together. |
| Monitored | all | Yes or no. |
| Has file | all | Yes or no. "No" is the same as missing. |
| Quality profile | all | Pick profiles. |
| Requested by | all | Pick users, or **has any value** for "requested by anyone". Declined requests do not count. Album requests count for the artist, book requests for the author. |
| Tag | all | The item carries (or does not carry) a tag. Sees tags added by rules higher in the list. |

A range condition (year, rating …) never matches an item with no value: a movie without a rating matches neither "rating at least 7" nor "rating at most 5".

### Templates

A label in **Add tags** can contain variables in braces. Each value makes its own tag, so `genre:{genre}` on a horror comedy adds `genre:horror` and `genre:comedy`. If a variable has no value for an item, the template adds nothing to it.

| Variable | Example result |
|---|---|
| `{genre}` | `genre:science-fiction` |
| `{resolution}` | `res:2160p` |
| `{quality}`, `{source}` | `bluray-1080p`, `web` |
| `{hdr}` | `hdr:dv`, `hdr:hdr10` |
| `{codec}`, `{audiocodec}` | `hevc`, `truehd-atmos` |
| `{language}`, `{originallanguage}` | `eng`, `ja` |
| `{channels}` | `5.1` |
| `{certification}` | `pg-13` |
| `{network}`, `{studio}`, `{collection}` | `network:hbo` |
| `{status}`, `{seriestype}` | `anime` |
| `{year}`, `{decade}` | `decade:1980s` |
| `{requester}` | `requested:sam` (the user name) |
| `{qualityprofile}`, `{rootfolder}` | `hd-1080p`, `movies` (the last folder of the path) |
| `{releasegroup}` | `framestor` |
| `{albumtype}`, `{artisttype}` | `live` |
| `{author}`, `{narrator}`, `{bookseries}` | `narrator:stephen-fry` |

Labels are cleaned up the same way every time: lower case, spaces become `-`, only letters, digits and `- _ . : + &` stay, at most 100 characters. A template with two variables makes one tag per combination, at most 25 per item.

Only these variables exist. Rules are data: there is no way to run code or formulas in a rule.

### Preview

The rule editor shows a live preview while you edit: how many items match, which tags would be added to how many items (new tags are marked), which would be removed, and a few example items. **Run now** and **Run all** show the same summary first and only apply after you confirm.

### Order and conflicts

Rules run top to bottom; move them with the arrows. Their results add up:

- A later rule sees the tags earlier rules added, so a **Tag** condition can build on them.
- A rule's **Remove tags** wins over an **Add tags** of a rule above it.
- Two rules can add the same tag. It stays until neither rule produces it any more.
- Only the difference is written: an item whose tags would end up the same is not touched.

### Which tags a rule owns

Arclight remembers which rule added which tag to which item. That is how **Remove when no longer matching** can take a rule's tags off without touching yours:

- A tag you added by hand is yours. A rule that would add the same tag leaves it alone and never removes it.
- A tag a rule added, that you then remove by hand, comes back the next time the rule runs and still matches. To keep a rule away from one item, add a condition, for example **Tag is none of** `no-auto`, and tag that item `no-auto`.
- Deleting a rule asks whether to also remove the tags it added. Tags another rule also added stay.

On a movie, series, artist or author page, tags a rule added carry a small marker; hover it to see the rule's name.

### When rules run

- When an item is added, a file is imported or upgraded, metadata is refreshed, or media analysis finishes, every enabled rule runs for that item.
- When a request is made, approved or completed, rules run for the requested item if it is in the library.
- Daily at 04:15 the **ApplyTagRules** task runs every enabled rule over the whole library (System > Tasks can run it now). It also forgets records of items that were deleted.
- **Run now** on one rule runs just that rule, even when it is disabled. **Run all** runs every enabled rule.

Large libraries are handled in pages of 500 items.

### Starter rules

New installs get five rules, all switched off. Turn one on, or edit it first:

| Rule | Applies to | Does |
|---|---|---|
| Genre tags | everything | `genre:{genre}` |
| Resolution tags | movies, series with files | `res:{resolution}` |
| Requested-by tags | everything requested | `requested:{requester}` |
| 4K HDR | movies, series | `4k-hdr` when there is a 2160p file with any HDR format |
| Kids | movies, series | `kids` for certifications `G`, `PG`, `TV-Y`, `TV-Y7`, `TV-G`, `U` |

Deleted starter rules do not come back.

## Examples

- **Anime to its own root folder**: Series type is any of `anime` → add `anime`; then use the tag in a delay profile or download client.
- **Hand-picked classics**: Year at most 1979 and Rating at least 7.5 → add `classic`.
- **What friends asked for**: Requested by has any value → add `requested:{requester}`, then filter the library by `requested:sam`.
- **Space hogs**: Size at least 50 → add `big`.
- **Recently added**: Added (days ago) at most 14 → add `new`; with **Remove when no longer matching** on it drops off after two weeks.
- **Atmos**: Audio codec is any of `truehd atmos`, `eac3 atmos` → add `atmos`.

## See also

- [Library](library.md): tag filters and the bulk bar.
- [Quality profiles](quality-profiles.md), [Indexers](indexers.md), [Download clients](download-clients.md) and [Notifications](notifications.md): settings that use tags.

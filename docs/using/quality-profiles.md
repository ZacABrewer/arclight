# Quality profiles, custom formats and guides

This page explains how Arclight decides which release to grab and when to replace a file with a better one. It covers Settings > Profiles (quality profiles, delay profiles, release profiles), Settings > Quality (size limits), Settings > Custom Formats, and Settings > Guides (the TRaSH Guides sync). You need it when the wrong release gets picked, when you want 4K only, or when you want to automate the "best" settings instead of tuning them by hand.

If you only want sensible defaults, skim "Scoring explained" and then jump to [Guides sync](#guides-sync-trash-guides).

## How a release is judged

For every release an indexer returns, Arclight asks in order:

1. Is this the right episode or movie?
2. Is its **quality** (for example WEBDL-1080p) allowed by the item's quality profile?
3. Does it pass the rules: size limits, release profile terms, language, minimum seeders, blocklist, and so on?
4. Does its **custom format score** reach the profile's minimum?
5. Is it actually better than what you already have (an upgrade)?
6. Does a delay profile say to wait first?

Of the releases that pass, the best one is grabbed. "Best" means, in order: higher quality, then higher custom format score, then the preferred protocol (torrent or usenet), then indexer priority, then seeders, then size. The details are in the [decision engine spec](../spec/decision-engine.md); if a release was skipped and you do not know why, open [Interactive search](interactive-search.md), which lists every release with its rejection reason.

## Quality profiles

Settings > Profiles > **Quality profiles**. Each series and movie uses one profile. Press **Add quality profile** or click an existing one to edit it.

| Field | Default | What it does |
|---|---|---|
| Name | - | What you see when adding a series or movie |
| Qualities | - | The ordered list of qualities. Best first. Tick the ones you accept; drag to reorder; select several and press **Group selected** to make a group that ranks as one level |
| Upgrades allowed | On | Keep replacing the file with better releases until the cutoff is met |
| Upgrade until (cutoff) | - | Stop upgrading once this quality is reached. It must be one of the allowed qualities. A CUTOFF line marks it in the list |
| Minimum score | 0 | Releases whose custom format score is below this are rejected |
| Upgrade until score | 0 | Stop upgrading once the file's custom format score reaches this |
| Minimum increment | 1 | An upgrade at the same quality must beat the current score by at least this much |
| Languages | none (any) | Accepted languages. None selected means any language. "Original" means the title's original language |
| Custom format scores | all 0 | Points for each custom format (see below) |

Notes:

- With **Upgrades allowed** off, Arclight grabs the first acceptable release and never replaces it, except that a PROPER or REPACK of the same quality is still accepted unless Settings > Media Management > Propers and repacks says otherwise.
- A **group** treats several qualities as equal (for example WEBDL-1080p and WEBRip-1080p), so the custom format score decides between them.
- Qualities that exist: SDTV, DVD, WEBDL/WEBRip/Bluray at 480p, 576p, 720p, 1080p and 2160p, HDTV at 720p, 1080p, 2160p, Remux-1080p, Remux-2160p, Raw-HD (series) and BR-DISK, DVD-R, CAM, TELESYNC, TELECINE, WORKPRINT, DVDSCR, REGIONAL (movies).
- The profile's score thresholds also drive the Wanted > **Cutoff unmet** list: an item is done only when both the quality cutoff and the score cutoff are met. See [Wanted](wanted.md).

## Quality definitions (size limits)

Settings > **Quality** lists every quality with three sliders in MB per minute of runtime: **Min**, **Preferred** and **Max**. A 45-minute episode at 10 MB/min is about 450 MB. The page also shows the equivalent GB per hour.

| Field | What it does |
|---|---|
| Min | Releases smaller than this (for their runtime) are rejected as too small. 0 never rejects |
| Max | Releases larger than this are rejected. Unlimited (empty or 0) means no cap |
| Preferred | Not a filter. When several releases pass, the one whose size is closest to the preferred size wins. With no preferred size, the biggest wins |

Use it to stop 40 GB remuxes slipping into a WEBDL-1080p profile, or to reject tiny, over-compressed files. **Reset to defaults** restores the shipped values. If a release has an unknown size it is never rejected for size.

A global cap (maximum size in MB) and other knobs for the decision engine live under Settings > Indexer Options; see [Indexers](indexers.md).

## Custom formats

A custom format is a named group of conditions that recognises something in a release, for example "x265", "Dolby Vision", "German audio" or "a trusted release group". By itself a format does nothing; each quality profile gives it a score, and the scores of all matching formats are added up.

Settings > **Custom Formats** lets you add, edit, delete, import and export formats. Each format has:

| Field | What it does |
|---|---|
| Name | Shown in the profile score list |
| Conditions | One or more tests (below) |
| Include in the Custom Formats renaming token | Lets `{Custom Formats}` in a file name show this format's name |

Condition types: Release Title (regular expression), Release Group (regex), Edition (regex), Language, Source, Resolution, Quality Modifier, Size (min and max GB), Indexer Flag, Year (range), Release Type (single, multi, season pack) and Release Extras. Each condition has two switches:

- **Negate**: the condition matches when the test is false.
- **Required**: this condition must match for the format to match.

The format matches when every required condition matches and, for each kind of condition, at least one of that kind matches.

The editor has a **test box**: paste a release title and see which formats match and what each profile would score it. Tests run against saved formats, so save first. **Export JSON** and **Import custom formats** use the same JSON shape as Sonarr and Radarr/TRaSH exports (pick the source app on import, because some numeric values differ between them).

## Scoring explained

On each quality profile's **Custom format scores** list, give each format a number. Positive numbers are good, negative are bad, and a big negative number (for example -10000) effectively bans a release as long as **Minimum score** is above it.

Worked example. Profile "HD": allowed WEBDL-1080p and Bluray-1080p, cutoff Bluray-1080p, upgrades allowed, Minimum score 0, Upgrade until score 200, Minimum increment 10.

| Format | Score in profile |
|---|---|
| Trusted group | 100 |
| x265 | -50 |
| Dolby Vision | 80 |
| Bad group | -10000 |

Four releases appear for the same episode:

| Release | Quality | Matches | Total score | Result |
|---|---|---|---|---|
| A | WEBDL-1080p | Trusted group, x265 | 50 | Allowed. Passes Minimum score (50 is not below 0) |
| B | WEBDL-1080p | Trusted group | 100 | Allowed, and beats A on score at the same quality, so B is picked |
| C | WEBDL-1080p | Bad group | -10000 | Rejected: below Minimum score |
| D | HDTV-720p | none | 0 | Rejected: that quality is not allowed in the profile |

You grab B. Later release E appears: Bluray-1080p, Trusted group and Dolby Vision, score 180. It is a higher quality than B, so it is an upgrade and is grabbed; B goes to the recycling bin. The cutoff (Bluray-1080p) is now met, so the file is only replaced again by a release of the same quality whose score is at least 10 higher (Minimum increment), and only while its score is still under 200 (Upgrade until score). A score of 0 passes a Minimum score of 0 but fails a Minimum score of 1.

## Delay profiles

Settings > Profiles > **Delay profiles** make Arclight wait before grabbing, hoping a better release (or one from your preferred protocol) shows up. Profiles are checked top to bottom and the first whose tags match is used. The **Default** profile has no tags, applies to everything else, and stays last.

| Field | Default | What it does |
|---|---|---|
| Preferred protocol | Usenet | Which protocol wins ties and is not delayed by the bypass options |
| Usenet delay (minutes) | 0 | How long to wait before grabbing a usenet release |
| Torrent delay (minutes) | 0 | How long to wait before grabbing a torrent release |
| Bypass if highest quality | Off | Grab at once when the release is the profile's best allowed quality on the preferred protocol |
| Bypass if above custom format score | Off | Grab at once when the release scores at least the Minimum custom format score |
| Minimum custom format score | 0 | Threshold for the option above |
| Tags | none | Only apply to items with these tags |

Delays are skipped for searches you start yourself (interactive and manual search). Releases that are waiting appear under Activity > Pending. A common setup is to leave the default at 0 minutes and only add a delay if you use both usenet and torrents.

## Release profiles

Settings > Profiles > **Release profiles** reject or require words in the release title, regardless of quality.

| Field | What it does |
|---|---|
| Name, Enabled | Label and on/off switch |
| Must contain | At least one of these terms must appear in the title. Plain text is case-insensitive; wrap a regular expression in `/.../` |
| Must not contain | A release containing any of these terms is rejected |
| Indexer | Only apply to releases from this indexer. Default: any indexer |
| Tags | Only apply to series and movies carrying these tags. Empty applies to everything |

A profile needs at least one required or ignored term. Typical use: ignore `/\bHDR\b/` for one tagged series, or require `NF` for a show you only want from one service.

## Guides sync (TRaSH Guides)

Settings > **Guides** keeps your custom formats and profile scores in line with the TRaSH Guides repository on GitHub (or your own repository with the same layout). Rather than building formats by hand, you point a guide profile at one of your local quality profiles and Arclight fills in the formats and scores.

What it changes:

- **Creates** custom formats listed by the guide and **updates** the ones it created earlier when the guide changes.
- **Sets scores** on your mapped quality profiles for those formats.
- Never deletes anything. Formats the guide drops are listed as "Dropped by the guide" and kept until you delete them yourself.
- A custom format you made yourself with the same name is never overwritten silently. It shows as "Adopt format" and is only linked to the guide when you tick it and apply.
- Guide conditions Arclight cannot express are dropped, with a warning.

Setup:

1. Open Settings > Guides and switch on **Enabled**.
2. Choose which **Apps** to read: Series (Sonarr guide) and/or Movies (Radarr guide).
3. Under **Profile mappings**, pick a **Local profile** for each guide profile you want (for example "HD Bluray + WEB"). Create the local profile first under Settings > Profiles.
4. Press **Sync now**. Arclight fetches the guide and lists the **Pending changes**.
5. Review them, then press **Apply all** (or tick some and **Apply selected**).

Settings:

| Setting | Default | What it does |
|---|---|---|
| Enabled | Off | Turns the scheduled sync on. With it off, Sync now still fetches and compares |
| Source | TRaSH Guides | The TRaSH Guides repository, or Custom for your own |
| Repository URL | the TRaSH raw-content URL | For Custom: a raw-content base such as `https://raw.githubusercontent.com/<owner>/<repo>/`. Non-GitHub hosts must serve an `index.json` per folder |
| Branch | master | Branch to read |
| Apps | Movies (Radarr) | Guide sections to read |
| Sync interval | 24 hours | 1 to 168 hours between automatic syncs |
| Mode | Notify only | Notify only: store the changes and tell you; you apply them. Apply automatically: apply them at once (adopting your own formats still waits for you) |
| Profile mappings | none | Guide profile name to local profile |
| Include formats | none | Extra formats to sync besides those the mapped profiles use. Names or trash ids; `*` and `?` work; `*` alone syncs the whole guide |
| Exclude formats | none | Never synced, even when a mapped profile uses them |
| Score all synced formats | On | Also give every synced format its guide score on mapped profiles, not just the ones the guide profile lists |

The status panel shows last sync, last success, last applied, the number of pending changes, and any error. Syncing needs internet access to GitHub; if you route Arclight through a locked-down network, allow `raw.githubusercontent.com` and `api.github.com`.

Your own tweaks to a synced profile can be overwritten on the next apply, so keep personal preferences in a separate custom format or use **Exclude formats**.

## Related

- [Media management](media-management.md) (propers and repacks, file naming)
- [Interactive search](interactive-search.md) (see why a release was rejected)
- [Wanted](wanted.md) (cutoff unmet)
- [Indexers](indexers.md) (indexer priority, release decision settings)
- [Library](library.md)
- [Decision engine spec](../spec/decision-engine.md)
- [Glossary](../GLOSSARY.md)

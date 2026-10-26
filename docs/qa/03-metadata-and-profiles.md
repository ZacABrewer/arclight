# Metadata (TMDB) and profiles

This file checks how Arclight gets its titles, posters and dates from TMDB (prefix MET), and everything that decides which releases are good enough: quality profiles, quality size limits, custom formats, delay profiles, release profiles and file naming (prefix PRO).
Prerequisites: a free TMDB v3 API key from themoviedb.org (needed for MET-03 onward), and an admin login. At least one series should already be in the library for MET-07 and PRO checks that mention it (see 02-library.md).
Test environments: Native, Docker and NAS all apply. Steps marked "via API" use `curl` with the API key from Settings -> Security; replace `<host>` with `localhost:17878` (Native) or `<host>:7878` (Docker/NAS).
The web app has no separate screen for a custom-format "test" other than the Test box inside the custom format editor; the same test is also available as `POST /api/v1/customformat/test`.

## Metadata settings and TMDB (prefix MET)

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| MET-01 | Open Settings -> General and find the card "Metadata (TMDB)". | The card shows three fields: "TMDB API key" (a password-style box with the help text "Your TMDB v3 API key. Leave empty to use the ARCLIGHT_TMDB_API_KEY environment variable."), "Metadata language" (placeholder `en-US`) and "Region" (placeholder `US`), plus a Save button. | |
| MET-02 | Clear the Region box, type `USA` and click Save. Then change it to `US` and clear "Metadata language", click Save. | Region `USA` is refused with "Use a two-letter code". An empty Metadata language is refused as required. Nothing is saved until both are valid. | |
| MET-03 | (Only when no key is saved and ARCLIGHT_TMDB_API_KEY is not set.) With the key box empty, open Library -> Add New and search `The Expanse`. | The page shows "No TMDB API key configured" with a button "Open Settings -> Metadata" that goes to Settings -> General. | |
| MET-04 | Paste an invalid key such as `abc123` into "TMDB API key", click Save, then search in Add New. | The search fails with a "Search failed" message and a "Try again" button (the text under the heading is the error returned by TMDB). The page does not crash. | |
| MET-05 | Paste your valid TMDB key, click Save, then reload Settings -> General. | The key box now shows a masked value (dots), not the real key. Searching `The Expanse` in Add New returns results with posters. | |
| MET-06 | Open a series or movie detail page and look at the images. | The poster appears at the left of the header, a faded backdrop (fanart) sits behind the header, and search result cards in Add New show posters. No broken-image icons. A title without artwork shows a placeholder instead. | |
| MET-07 | In Settings -> General set "Metadata language" to `fr-FR`, click Save, then add a new series that has French metadata (for example search `Dix pour cent`). Afterwards set the language back to `en-US` and Save. | The newly added series shows its overview in French. Setting the language back restores English for newly added or refreshed titles. | |
| MET-08 | Open System -> Tasks. In the "Scheduled" card find `RefreshSeries` and `RefreshMovie`, then click "Run now" on `RefreshSeries`. | Both jobs are listed (daily; RefreshSeries around 03:00, RefreshMovie around 04:30) with Last run and Next run columns. After "Run now" the "History" card gains a RefreshSeries entry whose result reads like "refreshed 3 of 3 series". With no key it reads "skipped: TMDB API key not configured". | |
| MET-09 | Via API: `curl -H "X-Api-Key: <key>" "http://<host>/api/v1/metadata/search?query=breaking%20bad&type=series"`, then `curl -H "X-Api-Key: <key>" http://<host>/api/v1/metadata/series/1396` and `.../metadata/movie/603`. | Search returns a JSON list with `title`, `year`, `tmdbId`, `mediaType` "series", images and ratings. The series call returns full details (seasons, genres, overview); the movie call returns The Matrix. Without a key the calls return an error naming the missing TMDB key. | |

## Quality profiles (Settings -> Profiles)

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| PRO-01 | Open Settings -> Profiles. | Page "Profiles" with three cards: "Quality profiles", "Delay profiles", "Release profiles". On a fresh install the quality profiles are Any, SD, HD-720p, HD-1080p, HD-720p/1080p and Ultra-HD; each card shows "Cutoff: <quality>" and a badge per allowed quality. A final card reads "+ Add quality profile". | |
| PRO-02 | Click the "HD-1080p" card. | Dialog "Edit HD-1080p" opens with: Name, "Upgrades allowed" (on), "Upgrade until" (cutoff), "Minimum custom format score", "Upgrade until custom format score", "Minimum custom format score increment", Languages chips, a "Qualities" list and a "Custom format scores" section. Footer buttons: Delete, Cancel, Save. | |
| PRO-03 | Click Cancel, then click "+ Add quality profile" and click Save without typing a name. | The dialog "Add quality profile" opens pre-filled from a template. Saving with an empty name shows "Name is required" and the dialog stays open. | |
| PRO-04 | Type the name `Test 1080p`. In "Qualities" untick every quality, then click Save. | The message "Allow at least one quality" appears above the list. | |
| PRO-05 | Tick "Allow" on two or three qualities (for example Bluray-1080p). Then untick "Allow" on whichever entry is currently chosen in "Upgrade until" and click Save. | The error "The cutoff must be one of the allowed qualities" shows next to "Upgrade until" (the dropdown only lists allowed entries). Choose an allowed entry in the dropdown to clear the error. | |
| PRO-06 | In the Qualities list click the up arrow (labelled "Move <name> up") beside one row and the down arrow beside another row; then drag one row above another. | Rows move; the first row has no working up arrow and the last no working down arrow. The text above the list says "Best first. Drag to reorder (or use the arrows); tick to allow. Members of a group rank equal." | |
| PRO-07 | Tick the "Select ... for grouping" boxes of two adjacent qualities, type `Web` in "Group name" and click "Group selected (2)". Then click "Ungroup" on the new group. | The two rows merge into one group row named `Web` listing its members; "Ungroup" splits them back. The Group selected button stays disabled until two rows are ticked and a name is typed. | |
| PRO-08 | Set "Minimum custom format score increment" to `0` with "Upgrades allowed" on, and click Save. Then put it back to `1`. | The error "Must be at least 1" shows. | |
| PRO-09 | Click language chips such as "English" and "Japanese" (they turn highlighted), then Save. Reopen the profile. | The chosen languages remain highlighted. With none highlighted the hint "None selected means any language" applies. | |
| PRO-10 | Click Save on the valid `Test 1080p` profile. | The dialog closes and a new card "Test 1080p" appears showing the cutoff and allowed-quality badges (and "upgrades off" if upgrades are disabled). | |
| PRO-11 | Edit `Test 1080p`, click Delete, then in the "Delete Test 1080p?" confirmation (text "This cannot be undone.") click Delete. | The dialog closes and the card disappears. (Note: the app does not yet block deleting a profile used by a series; do not test that.) | |

## Quality definitions (Settings -> Quality)

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| PRO-12 | Open Settings -> Quality. | Page "Quality" with the subtitle "Size limits per quality in MB per minute of runtime. A 45-minute episode at 10 MB/min is about 450 MB." and a table with columns Quality, Min, Preferred, Max; each row has three sliders and shows the media types under the quality name. The Save button is disabled. | |
| PRO-13 | Drag the Max slider for "Bluray-1080p" to about `100`, then drag the Min slider above it. | The slider value shows one decimal (for example `100.0`). Raising Min past Max pushes Max (and Preferred) up so Min never exceeds Max. The Save button now reads "Save (1)". Dragging a Max or Preferred slider fully right shows "Unlimited". | |
| PRO-14 | Click "Discard". Change a slider again, click Save, and reload the page. | Discard resets sliders to the saved values and disables Save. After Save and reload the new value is still shown. | |

## Custom formats (Settings -> Custom Formats)

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| PRO-15 | Open Settings -> Custom Formats. | Page "Custom Formats" with buttons "Import" and "Export all" (disabled when there are none) and a card "+ Add custom format". A fresh install has no formats. | |
| PRO-16 | Click "+ Add custom format". In the dialog type the name `x265 HD` and open the "+ Add condition..." dropdown. | Dialog "Add custom format" has Name, a toggle "Include in {Custom Formats} renaming token", a "Conditions" section, a "Test" section and buttons Delete (edit only), "Export JSON", Cancel, Save. The condition types are: Release Title, Release Group, Edition, Language, Source, Resolution, Quality Modifier, Size, Indexer Flag, Year, Release Type, Release Extras. | |
| PRO-17 | Choose "Release Title". In the new condition set the name to `x265` and the "Regular Expression" field to `x265|HEVC`. Tick neither Negate nor Required, then click Save. | The condition card shows a condition-type dropdown, name box, Negate and Required toggles and a remove (x) button. After Save a card "x265 HD" appears with a badge `x265`. | |
| PRO-18 | Reopen `x265 HD`, add a second condition "Resolution" set to 1080p, tick "Negate" on the first condition and click Save. | The card now shows two badges; the negated one is prefixed with `not `. | |
| PRO-19 | Reopen `x265 HD` and in the Test section type `Show.Name.S01E01.1080p.WEB-DL.HEVC-GROUP`, leave the type on "Series" and click Test. | A result area shows "Matched:" with a badge `x265 HD` (green, since this is the format being edited) and the line "This format matches." (or "does not match." when it does not). If profiles give scores, lines like "Any: 0" list each profile's total score. A note says tests run against saved formats. | |
| PRO-20 | Test via API: `curl -X POST -H "X-Api-Key: <key>" -H "Content-Type: application/json" -d "{\"title\":\"Movie.2020.2160p.BluRay.REMUX-GRP\",\"mediaType\":\"movie\"}" http://<host>/api/v1/customformat/test`. | Returns JSON with `matchedFormats` (list of formats) and `scores` (one entry per quality profile with `profileName` and `score`). | |
| PRO-21 | In the format dialog click "Export JSON". | A read-only box "JSON" appears containing `name`, `includeCustomFormatWhenRenaming` and `specifications`; the button now reads "Hide JSON". On the page click "Export all". A file `custom-formats.json` downloads containing the formats as an array. | |
| PRO-22 | Click "Import". Set Source app to "Sonarr / TRaSH (series)" and paste: `{"name":"Imported WEB","includeCustomFormatWhenRenaming":false,"specifications":[{"name":"WEB-DL","implementation":"SourceSpecification","negate":false,"required":false,"fields":{"value":3}}]}`. | Under the box appears "1 format ready: Imported WEB (1 conditions)". Buttons: Cancel, "Review in editor", "Import 1". Clicking "Import 1" shows the toast "Imported 1 custom format" and a card "Imported WEB" appears. | |
| PRO-23 | Reopen a quality profile (for example `Test 1080p`) and look at "Custom format scores". Type `100` beside `x265 HD`, Save, reopen. Then run the Test box again with an x265 title. | The table lists every custom format with a number box labelled "Score for <name>". The score `100` persists. The Test result lists the profile with score `100` for a matching title. With no formats at all the section reads "No custom formats yet. Add some under Settings -> Custom Formats." | |

## Delay profiles and release profiles (Settings -> Profiles)

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| PRO-24 | In the "Delay profiles" card look at the table. | Columns Protocol, Usenet delay, Torrent delay, Bypass, Tags. A fresh install has one row "Prefer Usenet", "No delay", "No delay" with a "default" badge instead of tags. | |
| PRO-25 | Click "Add". Set Preferred protocol "Prefer Torrent", Torrent delay `60`, tick "Bypass if highest quality", leave Tags empty and click Save. | The error "Only the default profile may be untagged" shows. Add a tag such as `kids` (use the tag picker) and Save again: a new row appears with "Prefer Torrent", Torrent delay "1 h" and a "highest quality" badge. | |
| PRO-26 | Add a second tagged delay profile, then use the up and down arrow buttons on one of the tagged rows. Try the arrows on the default row. | Tagged rows swap places and the order persists after reload. The default row has no usable arrows and always stays last. | |
| PRO-27 | Edit a tagged delay profile and tick "Bypass if above custom format score". | A new field "Minimum custom format score" appears; after Save the row shows a badge like "score >= 100". The default profile's dialog shows "This is the default profile..." and has no Delete button. | |
| PRO-28 | In the "Release profiles" card click "+ Add release profile" and click Save with an empty name, then with a name but no terms. | "Name is required" and then "Add at least one required or ignored term" appear. | |
| PRO-29 | Name it `No CAM`, add `CAM` and `HDCAM` under "Must not contain", leave "Indexer" on "Any indexer", Enabled on, and click Save. | A card `No CAM` appears with "Must not contain: CAM, HDCAM". Reopen and toggle Enabled off, Save: the card is dimmed with a "disabled" badge. Delete it afterwards. | |

## Naming and language on profile (Settings -> Media Management)

| ID | Step | Expected result | Pass/Fail |
|----|------|-----------------|-----------|
| PRO-30 | Open Settings -> Media Management and find the card "Episode & movie naming". Look at the formats and the sample text under each. | Toggles "Rename episodes", "Rename movies", "Replace illegal characters"; dropdowns "Colon replacement" and "Multi-episode style"; text boxes under the headings Series and Movies such as "Standard episode format" (default `{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}`) and "Movie format". Each box has a live sample under it. | |
| PRO-31 | Edit "Standard episode format" to `{Series Title} S{season:00}E{episode:00}` and pause. Then change it to `{Series Title} - {Episode Title}`. | After about half a second the sample under the box updates to the new example name. If a format cannot be rendered, a red error message replaces the sample. Click "Reset formats" to restore defaults (the Rename toggles keep their state), then "Save naming". | |

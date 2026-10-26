# Subtitles

This file covers everything about subtitles in Arclight: the Settings -> Subtitles page (language profiles, providers, search, sync and post-processing settings), the Subtitles section in the sidebar (Wanted, History, Blacklist), the Subtitles tab on a series or movie page, and the scheduled jobs that search for subtitles.
Prerequisites: you are signed in as an admin, at least one series or movie with an imported video file exists in the library, and you have a free account or API key for at least one real provider (OpenSubtitles.com or Subdl are the easiest). Embedded Subtitles needs no account.
Test environments: Native (http://localhost:17878) is enough for most checks. Checks that need ffmpeg, ffsubsync or alass say so; those tools may be missing on Native. Repeat the Search and Sync sections on Docker and NAS.
Providers that exist: Embedded Subtitles, OpenSubtitles.com, Subdl, Addic7ed, Podnapisi, Gestdown, Subf2m, Napisy24, Animetosho, Jimaku, YIFY Subtitles, Whisper (ASR). Addic7ed (login reCAPTCHA) and Subf2m (Cloudflare challenge) cannot solve captchas and may show as throttled. Podnapisi is best effort and unverified. Napisy24 (Polish only) and Whisper (needs an external Whisper service) are untested against real services.

## Language profiles

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| SUB-01 | Open Settings -> Subtitles. | The page is titled "Subtitles" with the text "Language profiles, providers and how subtitles are searched, named and processed." Cards appear in this order: Language profiles, Providers, General, Sync, Post-processing. | |
| SUB-02 | In the Language profiles card, click the "Add language profile" tile. | A dialog titled "Add language profile" opens with fields Name, Languages (showing "No languages yet."), Cutoff, Must contain, Must not contain, and a toggle "Keep original format (do not convert to SubRip)". | |
| SUB-03 | Click Save without typing anything. | A red message "Name is required" appears and the dialog stays open. Type the name "English + Spanish" and click Save again: the message "Add at least one language" appears. | |
| SUB-04 | In the "Add language" box type "span" and click "Spanish (es)", then type "eng" and click "English (en)". | Both languages appear as rows in a table with columns Language, Forced, Hearing impaired. New rows default to Forced = Never and Hearing impaired = Also. | |
| SUB-05 | For Spanish set Forced to "Only" and Hearing impaired to "Never". | The two drop-downs on the Spanish row show those values. The options are Never, Also, Only. | |
| SUB-06 | Open the Cutoff drop-down. | It offers "None", "Any language", "Spanish" and "English". Choose "English". | |
| SUB-07 | In "Must not contain" type "HDR" and click Add; in "Must contain" type "/WEB.*DL/" and click Add. | Each term appears as a removable chip. Clicking the x on a chip removes it. | |
| SUB-08 | Click Save. | The dialog closes and a tile "English + Spanish" appears with a badge "Spanish · forced only · HI never" and a highlighted "English" badge (the cutoff). | |
| SUB-09 | Click the tile, rename it to "EN-ES", click Save, then reopen it. | The tile is renamed and all earlier values (cutoff English, both terms, language flags) are preserved. | |
| SUB-10 | Create a second profile "Temp" with one language (French), save it, reopen it and click Delete in the dialog. | A confirmation "Delete Temp?" appears. Confirming removes the tile. | |
| SUB-11 | Assign "EN-ES" to a series (see SUB-24), then try to delete "EN-ES" from Settings -> Subtitles. | The delete is refused with a message saying the language profile is in use, and the tile remains. | |

## Providers and settings

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| SUB-12 | Scroll to the Providers card. | A table lists all 12 providers with columns Order, Provider, Enabled, Status and an Edit button on each. Unconfigured ones show a red status such as "Not configured". The text "Providers are searched in this order." is shown. | |
| SUB-13 | Click Edit on OpenSubtitles.com. | A dialog "OpenSubtitles.com settings" opens with Username, Password (hidden), API key (hidden) and a Test button. | |
| SUB-14 | Enter your real username, password and API key and click Test. | A green "Test passed" with the message "OpenSubtitles.com is reachable" appears. With a wrong password, "Test failed" and the provider's error appear instead. | |
| SUB-15 | Click Apply, switch the Enabled toggle for OpenSubtitles.com on, and click Save at the top right. | A toast "Subtitle settings saved" appears and the status becomes a green "Ready". | |
| SUB-16 | Reload the page and reopen Edit for OpenSubtitles.com. | The password and API key show as masked values (not clear text) and Test still passes without retyping them. | |
| SUB-17 | Enable "Embedded Subtitles" (no credentials needed) and click Save. | Its status becomes "Ready". Moving a provider with the up and down arrows changes its row position and is kept after Save and reload. | |
| SUB-18 | Press Test in the Addic7ed dialog (internet required). | Either "Test passed" or a failure that mentions captcha. A captcha failure is expected and not a bug. | |
| SUB-19 | If a provider shows an amber "Throttled" badge with a retry time, click "Reset throttles". (If none is throttled, just click it once.) | The throttle badge disappears and the status returns to Ready or the configuration message. Nothing breaks if there was nothing to reset. | |
| SUB-20 | In the General card change "Search batch size" to 5, tick "Search on import" and "Only monitored", set "Upgrade window" to 7 days. Then click Discard. | Save and Discard are disabled until a field changes. Discard puts every field back to its saved value and disables both buttons again. | |
| SUB-21 | Change "Default series profile" and "Default movie profile" to "EN-ES", then click Save. | Toast "Subtitle settings saved". After reload both drop-downs still show "EN-ES". | |
| SUB-22 | Set "Embedded subtitles" to "Extract text tracks to files" (other options: "Count as present", "Ignore") and "Undefined track language" to English. Save and reload. | The values persist. | |
| SUB-23 | In the Sync card tick "Sync subtitles", set Sync tool to "alass", then "ffsubsync", Max offset 60 s, and Save. Look at the Post-processing card. | Values persist after reload. The Post-processing card lists the placeholders {{directory}}, {{episode}}, {{subtitles}}, {{subtitles_language}}, {{score}}, {{provider}} and others. | |

## Assigning profiles and the Subtitles tab

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| SUB-24 | Open a series in Library, click Edit, set "Language profile" to "EN-ES" and Save. | The dialog closes. Reopening Edit shows "EN-ES". The drop-down offers "None" plus every profile. | |
| SUB-25 | Do the same for a movie. Then start adding a new series or movie and look at "Language profile". | The edit works the same. In the Add dialog the drop-down defaults to "Default" (the default profile from SUB-21). | |
| SUB-26 | Open a series with imported files and click its "Subtitles" tab. | Files are grouped by season ("Season 1", "Specials" for season 0). Each row shows the episode code such as "S01E02 · Title", chips for subtitles present (ext = file on disk, emb = embedded track) and red-outlined chips for missing languages. Row buttons: Search, Manual, Upload, Rescan. Top right: "Search all" and "Rescan all". | |
| SUB-27 | Click Rescan on a file row after placing a file named like Movie.en.srt next to the video. | The English subtitle appears as a chip, and the missing chips update. | |
| SUB-28 | Click Manual on a file row (needs a working provider). | A dialog "Manual search · <episode>" opens with a Language drop-down ("All profile languages" by default) and "Search again". The table "Subtitle candidates" lists Provider, Language, Flags, Score (percent), Release, Uploader, Matches and a Download button, highest score first. If every provider is throttled a yellow notice "Every provider is throttled right now; try again later." shows. | |
| SUB-29 | Click Download on a result. | Toast "Downloaded <Language> subtitle from <provider>". After closing the dialog the row has a new solid "ext" chip and a .srt file exists next to the video. | |
| SUB-30 | Open the three-dots menu on the new chip and click Sync (needs ffsubsync or alass and Sync enabled). | Toast "Subtitle synced", or "Sync failed" with a reason such as the tool not being found. | |
| SUB-31 | Click Upload on a file row and click Upload without choosing a file. | Red message "Choose a subtitle file". | |
| SUB-32 | Pick a small .srt file, choose Language "Spanish", tick "Forced" and click Upload. | Toast "Subtitle uploaded". The row shows a Spanish chip with an F marker; the file is named like Movie.es.forced.srt. | |
| SUB-33 | On a provider-downloaded chip open the three-dots menu, click Blacklist and confirm. | Dialog "Blacklist <language> subtitle?" explains it is deleted and never downloaded again from that provider. After confirming the chip disappears and a replacement may be searched. | |
| SUB-34 | On another chip open the menu, click Delete and confirm. | Dialog "Delete <language> subtitle?" shows the file path. After confirming the chip is gone and the file is removed from disk. | |
| SUB-35 | For a video with an embedded text subtitle track (ffmpeg available), open the menu on the dashed "emb" chip and click Extract. | A solid "ext" chip appears for that language and a .srt file is created. Picture-based embedded tracks (PGS, VobSub) have no menu button. | |

## Wanted search, history and blacklist

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| SUB-36 | Open Subtitles -> Wanted. | Title "Wanted subtitles" with tabs "TV" and "Movies". Each lists files missing subtitles with columns Episode/Movie, Missing (red chips), Last search ("Never" at first), Attempts and a Search button. When nothing is missing: "Nothing wanted". | |
| SUB-37 | Click Search on one row. | Toast "Subtitle search finished" with a message like "Searched 2 language(s) in 1 file(s); 1 downloaded" or "All providers are throttled". | |
| SUB-38 | Open System -> Tasks and click "Run now" on the job "SubtitleSearchWanted". | A new row appears in the History card with status completed. Rows on the Wanted page get an updated "Last search" time. | |
| SUB-39 | Click "Run now" on "SubtitleScan" and on "SubtitleUpgrade". | Messages like "Scanned N file(s); pruned 0 orphaned subtitle row(s)" and "Upgraded 0 of 0 candidate(s)". Upgrade only acts when "Upgrade subtitles" is ticked in the General card. | |
| SUB-40 | Open Subtitles -> History. | Title "Subtitle history" with filters Media, Action and Provider. Actions from earlier checks (Manual download, Uploaded, Deleted) show colored badges, provider, score percentage and date. Choosing Action = "Uploaded" keeps only upload rows. | |
| SUB-41 | Open Subtitles -> Blacklist. | Title "Subtitle blacklist"; the subtitle from SUB-33 is listed with Item, Language, Provider, Subtitle id and Date. Click Remove on it: the row disappears. | |
| SUB-42 | Blacklist another subtitle, then click "Clear all" and confirm. | Dialog "Clear the subtitle blacklist?" appears. Afterwards the page shows "Blacklist is empty" and Clear all is disabled. | |

## Automatic behaviour and API

| ID | Step | Expected result | Pass/Fail |
|---|---|---|---|
| SUB-43 | With "Search on import" ticked and a working provider, import a new episode or movie whose profile is set. | Within a few minutes the file gets a subtitle chip (or appears under Subtitles -> Wanted if none was found) without any button press. | |
| SUB-44 | Untick "Search on import", save, and import another file. | No immediate search: the file sits under Subtitles -> Wanted until SubtitleSearchWanted runs (every 15 minutes) or you click "Run now". | |
| SUB-45 | Via API run `curl -X POST -H "X-Api-Key: <key>" -H "Content-Type: application/json" -d '{"movieId":1}' http://localhost:17878/api/v1/command/subtitlesearch` (Docker: port 7878; the key is in Settings -> Security). | JSON with files, searched, downloaded and message such as "Searched 1 language(s) in 1 file(s); 0 downloaded". | |
| SUB-46 | Sign in as a non-admin user and look at the sidebar. | The Subtitles section and Settings are not shown. | |

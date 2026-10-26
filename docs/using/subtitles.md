# Subtitles

Arclight can find, download, name and check subtitles for your library, the way Bazarr does. You tell it which languages you want in a **language profile**, enable one or more **providers** (subtitle websites), and Arclight searches for every video file that is missing a subtitle. This page is for anyone who wants subtitles managed automatically. If your media server or player already handles subtitles for you, you can skip it.

Subtitles has its own section in the left menu (administrators only) with three pages: **Wanted**, **History** and **Blacklist**. The configuration lives in **Settings > Subtitles**.

## Quick start

1. Open **Settings > Subtitles**.
2. In **Providers**, switch on at least one provider. Some need no account (for example Podnapisi), others need credentials (for example OpenSubtitles.com). Click through the provider's fields, save, and check that it shows **Ready**.
3. In **Language profiles**, click **Add language profile**, name it, add your language(s), and save.
4. Set **Default series profile** and **Default movie profile** so that new items get it automatically. Existing items need the profile assigned (see below).
5. Open **Subtitles > Wanted** to see what is missing, and watch **Subtitles > History** as subtitles arrive.

## Language profiles

A language profile says which subtitles you want for an item. You can have several (for example "English" and "English + Spanish") and give each series or movie the one it needs.

| Field | Default | What it does |
| --- | --- | --- |
| Name | none | Any name you like. |
| Profile languages (in search order) | none | One or more languages. The first is searched first. Drag to reorder, or use the move up and down buttons. |
| Forced (per language) | Never | **Never**: plain subtitles only. **Also**: both a full and a forced subtitle are wanted. **Only**: only a forced subtitle. Forced subtitles translate only foreign-language dialogue. |
| HI (per language) | Also | Hearing-impaired subtitles. **Never**: excluded. **Also**: accepted. **Only**: required. |
| Cutoff | none (every language wanted) | Pick one language: once a subtitle for it exists, nothing else is searched. **Any language** means any one item completes the profile. |
| Must contain | empty | Release info must match one of these (regex or plain text, not case sensitive) or the subtitle is rejected. |
| Must not contain | empty | Release info matching any of these is rejected. |
| Keep original format (do not convert to SubRip) | off | Keep the provider's format (for example .ass) instead of converting to .srt. |

### Assigning a profile to your library

- **New items**: the **Add new** dialog has a **Language profile** selector (choose Default, a profile, or None). Default uses what you set in **Settings > Subtitles** as **Default series profile** or **Default movie profile**.
- **Existing items**: open the series or movie, use **Edit**, and pick the **Language profile**.

An item with no language profile is not searched.

## Providers

Under **Settings > Subtitles > Subtitle providers**. Providers are searched in the order listed ("Providers are searched in this order"). Use the arrows to move one up or down. Changes apply when you save. The status shows **Ready**, **Not configured** (a required field is missing), **Failed** with the reason, or **Rate-limited** with the reason and the time to retry. **Reset throttles** clears all rate-limit waits.

| Provider | Needs an account | Covers | Notes |
| --- | --- | --- | --- |
| Embedded Subtitles | No | TV, movies | Reads text tracks already inside the video file. Uses ffprobe and ffmpeg, which are included in the Docker image. |
| OpenSubtitles.com | Yes | TV, movies | Needs an account and an API consumer key. |
| Subdl | Yes | TV, movies | Needs an API key. |
| Addic7ed | Yes | TV, movies | Needs an account or session cookies. Free accounts are limited per day. |
| Podnapisi | No | TV, movies | Best effort. |
| Gestdown | No | TV only | Addic7ed proxy. |
| Subf2m | No | TV, movies | Web scraping. |
| Napisy24 | Yes | TV, movies | Polish subtitles. |
| Animetosho | No | TV only | Anime. |
| Jimaku | Yes | TV, movies | Japanese anime subtitles. Needs an API key. |
| YIFY Subtitles | No | Movies only | |
| Whisper (ASR) | No | TV, movies | Generates subtitles from audio. Slow. See below. |

Providers are off until you enable them. The credentials you enter are stored by Arclight and shown masked afterwards. Respect each site's terms; Arclight rate-limits itself when a site tells it to slow down.

## How searching works

- A job called **SubtitleSearchWanted** runs every 15 minutes and searches up to **Search batch size** items per run (default 25).
- With **Search on import** on (default), a newly imported file is searched right away instead of waiting.
- Each missing language is searched separately across your enabled providers. Candidates are scored (below). Arclight downloads the best one that reaches the minimum score.
- **Adaptive searching** (on by default) keeps old failures from being searched forever. After the first attempt, an item is searched on every run for the **Adaptive delay** (default 21 days), then once per **Adaptive interval** (default 7 days).
- A weekly job (**SubtitleScan**, Sunday at 04:00) rescans your library for subtitles already on disk. A daily job (**SubtitleUpgrade**, 03:30) looks for better subtitles for recent downloads. Run any job early from **System > Tasks**.

### Scoring

Every candidate gets a score out of 360 for episodes and 180 for movies, based on how well its release info matches your file. The percentage is what you see in the UI.

| Match | Episode | Movie |
| --- | --- | --- |
| Series / title | 160 | 60 |
| Year | 90 | 40 |
| Season, episode | 30 each | n/a |
| Source | 25 | 30 |
| Edition | n/a | 30 |
| Release group | 20 | 15 |
| Audio codec, resolution, video codec, HI, streaming service | 1 each | 1 each |
| File hash match (counts as all of the above) | 359 | 179 |

The scoring weights are fixed and cannot be changed. What you can change is the minimum:

| Setting | Default | What it does |
| --- | --- | --- |
| Minimum score (episodes) | 90 | Percent. A subtitle below this is not downloaded automatically. 90 percent is 324 out of 360. |
| Minimum score (movies) | 70 | Percent. 70 percent is 126 out of 180. |

Manual search ignores the minimum, so you can pick a lower-scoring subtitle yourself.

## The pages

### Subtitles > Wanted

Files that are still missing a subtitle their profile asks for, split into **TV** and **Movies** tabs. Columns: the episode or movie, **Missing** languages (forced and HI flags are shown), **Last search**, **Attempts**, and a **Search** button. Select rows and use **Search selected** to search several. A toast reports how many files were searched and how many subtitles were downloaded. An empty list says "Every file has the subtitles its language profile asks for."

### Subtitles > History

Every subtitle action: downloads, manual downloads, upgrades, uploads, syncs, extractions and deletions. Filter by **Media**, **Action** and **Provider**. Columns include item, language, provider, score (percent), sync result, offset and drift, description and date.

### Subtitles > Blacklist

Subtitles you blacklisted, with provider and subtitle id. They are never downloaded again. **Remove** puts a single one back in play, and **Clear all** makes every blacklisted subtitle eligible again.

### The Subtitles tab on a series or movie

Open a series or movie and use the **Subtitles** tab to see each video file, the subtitles it has (external files or embedded tracks) and what is still missing. You can:

- **Search all** or search one language ("Search again").
- **Manual search**: list candidates from all providers with their score, what matched and what did not, uploader and flags. Pick one to download it. Candidates stay available for one hour.
- **Upload** a subtitle file of your own, setting its language, forced and hearing-impaired flags.
- **Extract** an embedded text track to a separate file.
- **Sync** a subtitle to the audio (needs the sync tool, see below) and **Check sync**.
- **Blacklist subtitle**: deletes the file, never downloads it again from that provider, and searches for a replacement.
- **Delete subtitle**.
- **Rescan** the folder for subtitle files added outside Arclight.

If every provider is rate-limited at that moment, it says "Every provider is throttled right now. Try again later."

## Other settings

All under **Settings > Subtitles**.

### Searching

| Setting | Default | What it does |
| --- | --- | --- |
| Search batch size | 25 | Items searched per wanted-subtitles run (every 15 minutes). |
| Search on import | on | Search a file as soon as it is imported. |
| Only monitored | off | Automatic searches skip unmonitored items. |
| Adaptive searching | on | Search less often for items that keep failing. |
| Adaptive delay | 21 days | Search every run for this long after the first attempt. |
| Adaptive interval | 7 days | Afterwards, search once per this interval. |
| Use scene name | on | Use the original scene release name when matching. |
| Query providers concurrently | on | Ask all providers at once instead of one by one. |

### Upgrades

| Setting | Default | What it does |
| --- | --- | --- |
| Upgrade subtitles | on | Look for a better subtitle for recently downloaded ones. |
| Upgrade window | 7 days | Only subtitles downloaded within this time are upgraded (0 to 30). |
| Upgrade manual downloads | on | Manual downloads and uploads can be upgraded too. |

### Embedded subtitles

| Setting | Default | What it does |
| --- | --- | --- |
| Count as present / Ignore / Extract text tracks to files | Count as present | Whether embedded tracks satisfy what is wanted, are ignored, or are extracted to separate files. |
| Ignore PGS, Ignore VobSub, Ignore ASS | off | Skip those track types. |
| Undefined track language | none | Language to assume for tracks tagged "und". Without one, they are skipped. |
| ffmpeg path, ffprobe path | `ffmpeg`, `ffprobe` | Where the tools are. The Docker image already has them. |

### File naming and location

| Setting | Default | What it does |
| --- | --- | --- |
| Hearing-impaired suffix | .hi | Use `.hi`, `.cc` or `.sdh` in file names. |
| Single language | off | Leave the language out of file names (one-language profiles only). |
| Subtitle folder | Next to the video | Or a subfolder of the video folder, or an absolute folder. |
| Folder path | empty | The subfolder name or absolute folder for the two modes above. |
| Encode as UTF-8 | on | Convert downloaded subtitles to UTF-8. |
| Detect HI from content | on | Bracketed cues or music symbols mark a subtitle as hearing-impaired. |
| Notify on manual actions | on | Send notifications for manual downloads and uploads too. See [Notifications](notifications.md). |

### Post-processing

**Run post-processing** (off by default) runs a command after each subtitle is saved, with placeholders such as the subtitle path and language. It runs without a shell. You can limit it to episodes or movies below a score with **Only for episodes below a score** and **Only for movies below a score**. The settings page lists the available placeholders.

## Sync and sync check

Subtitles from the internet sometimes drift out of time with your file. Arclight has two separate things here.

### Sync (fixing timing)

**Sync** under **Settings > Subtitles** aligns a subtitle to the audio using an external tool. You must install the tool yourself. The Docker image does not include ffsubsync or alass, so it only works on a host or custom image where you have installed one of them.

| Setting | Default | What it does |
| --- | --- | --- |
| Sync subtitles | off | Align downloaded subtitles to the audio. |
| Sync tool | ffsubsync | ffsubsync or alass. |
| Binary path | empty | Empty uses the tool name from PATH. |
| Max offset | 60 seconds | Largest shift the tool will correct. |
| Golden-section search | on | Tool option. |
| Do not fix framerate | on | Tool option. |
| Only sync episodes / movies below a score | off (90 / 70) | Only sync subtitles that scored below the threshold. |
| Never sync subtitles from | none | Providers to skip. |
| Sync timeout | 10 minutes | Give up on a single sync after this long. |

### Sync check (measuring timing)

**Sync check** measures how well a subtitle lines up with the audio and gives a 0 to 100 sync score, plus an offset and drift. Results appear as a badge in the Subtitles tab and in Subtitles > History: **In sync**, **Slightly off**, **Out of sync**, or **Not measurable**.

| Setting | Default | What it does |
| --- | --- | --- |
| Check sync of downloads | off | Score every downloaded subtitle against the audio, and check older ones in the background (job SubtitleSyncCheck, hourly at :20). |
| Check method | Built-in (audio activity) | Built-in uses ffmpeg to compare speech with the cues. The alternative runs the sync tool in check mode. |
| Audio detector | silencedetect | ffmpeg filter that finds speech for the built-in check (silencedetect or ebur128). |
| Audio analysed | 10 minutes | Minutes of audio compared with the cues. Long media get a second window. |
| Sync when score is below | 0 (off) | Run the sync tool when the score is below this, then check again. |
| Try another subtitle below | 0 (off) | Blacklist the subtitle and download the next candidate when the score is still below this. |
| Candidates tried per language | 2 | How many replacements to try before giving up. |
| Subtitles checked per run | 20 | Subtitles scored per background run. |

You can also check one subtitle on demand with **Check sync** in the Subtitles tab.

## Whisper (speech to text)

Whisper is an optional, opt-in way to create subtitles from the audio when no provider has one. It is slow, runs on your own hardware, and is off unless you start it.

1. Start the optional Whisper container with the compose profile: `docker compose -f <your compose file> --profile whisper up -d`. This is available in the bundled compose files (VPN and no-VPN). The first start downloads a model, which can take a while. By default it runs on the CPU.
2. Arclight's job **WhisperAutoDetect** (hourly, and once at startup) finds it through the environment variable `ARCLIGHT_WHISPER_URL` and adds a **Whisper (ASR)** provider at the lowest priority, enabled and set to **Only when no other result**.
3. Check **Settings > Subtitles**, section **Whisper (speech to text)**: it shows the endpoint, whether the provider entry was **Added automatically** or **Added by hand**, and whether it is **Reachable**. Click **Check again** to re-test.

If you add the Whisper provider by hand, give it the **Endpoint** of your own Whisper ASR web service. If it is enabled but cannot be reached, a health warning appears; see [System](system.md).

The provider setting **Only when no other result** (default on) makes Arclight transcribe only for languages where no other provider found a subtitle reaching the minimum score. Keep Whisper last in the provider list.

## Related

- [Library](library.md) - assign a language profile when adding or editing
- [Wanted](wanted.md) - the video side of "missing"
- [Notifications](notifications.md)
- [Media servers](media-servers.md) - your player reads the subtitle files Arclight saves next to the video
- [System](system.md) - run the subtitle jobs from Tasks
- [Troubleshooting](../TROUBLESHOOTING.md)

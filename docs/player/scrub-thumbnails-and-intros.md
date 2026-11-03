# Scrub thumbnails and intro detection

Two things help you move around inside a video in the [player](../using/player.md):

- **Scrub thumbnails**: small pictures above the progress bar while you drag or seek.
- **Skip Intro, Skip Recap and Skip Credits**: buttons that show up during an episode's intro, its "Previously on" recap and its credits.

Both are made on your server from the files you already have. Nothing is downloaded, and no outside service is used.

## Scrub thumbnails

Arclight takes one picture every 10 seconds of a video, 320 pixels wide, and packs 100 of them into one JPEG "sheet" (10 by 10). A two-hour movie needs 720 pictures, which fit in 8 sheets of a few megabytes in total.

### When they are made

Set this under **Settings > Player > Scrub thumbnails and intros > Scrub thumbnails**:

| Setting | What happens |
|---|---|
| Off | No scrub thumbnails. The progress bar shows only times. |
| When a video is first played (default) | The first time anyone plays a file, its sheets are queued. They are ready a few minutes later, so the first viewing may not have them. |
| Whole library (overnight) | Every night at 03:20 Arclight queues each video file that has no sheets yet, newest first. Files are also still done when they are played. |

### How hard the server works

- Only **one** ffmpeg makes background work at a time, across the whole server, at a lower process priority. It reads keyframes only, which is fast.
- Background work **waits** while every live video slot (**Settings > Player > Live video slots**) is in use, so it never slows down someone watching.
- HDR files are tone-mapped to normal colours when your ffmpeg has the `zscale` filter (the Docker image does). Without it the pictures look washed out but still help you find your place.
- A file that cannot be read is not tried again until it changes on disk.

### Where they are kept

Sheets live in `cache/player/trickplay/` inside your config folder, one folder per file. When a file is replaced (an upgrade), its old sheets are deleted and new ones are made. Folders of files that left the library are removed by the nightly job.

**Settings > Player** shows how much space the sheets use. **Clear scrub thumbnails** deletes them all. They are made again when needed.

Apps and TVs load the sheets through signed links that expire like stream links, so they work without a sign-in cookie.

## Intro, recap and credits detection

Most shows play the same intro and the same end credits music in every episode of a season, and many open with a short "Previously on" recap of clips from earlier episodes. Arclight listens for both.

### How it works

1. For each episode it reads the audio of the **start** (the first 40 %, at most 10 minutes) and the **end** (the last 35 %, at most 7 minutes), mixed down to low-quality mono.
2. It turns that audio into two compact fingerprints and compares each episode with its nearest neighbours in the season (up to three):
   - a **sound** fingerprint, which follows the exact recording, and
   - a **harmony** fingerprint, which follows the notes and chords of the music. Speech has no steady notes, so this one still matches when characters talk over the theme song.
3. A stretch of at least 15 seconds that matches near the start is the **intro** (at most 2.5 minutes). A matching stretch near the end is the **credits**; if it runs to within 5 seconds of the end, the credits run to the end of the file.
4. An episode gets a segment only when at least half of its comparisons agree. The time stored is the middle value of those comparisons.
5. The start and end of an intro or recap then move onto a **black frame or a moment of silence** when there is one within 2 seconds, since that is usually where the cut really is.

### Recaps

With recap detection on, Arclight also reads the **middle** of each episode (sound fingerprint only), so that it knows every scene of the season. A recap is found when the minutes before an episode's intro (at most 3) are made of clips from up to three earlier episodes:

- the clips must start within the first 30 seconds,
- together they must last at least 10 seconds and cover at least 40 % of the recap,
- the earlier episodes' own intros and credits never count as recap clips.

The first episodes of a season are compared with the last three episodes of the season before, once that season has been scanned.

Recap detection is **on** by default. Turn it off with **Settings > Player > Detect recaps** (it is only available while intro and credits detection is on). With it off, the middle of each episode is not read. Changing it rescans every season at the next run.

A season needs **at least two episodes with files**. Specials (season 0) are checked like any other season, but they rarely share an intro.

### When it runs

- About **10 minutes after episodes are imported**. A season pack lands as many imports, so Arclight waits for the last one.
- **Every night at 03:40** for any season whose files changed since its last scan.
- When you press **Scan now** under **Settings > Player** (the `player-segments` job), or **Scan this season** in the season's intro and credits dialog.

Seasons that did not change are skipped. Detection uses the same single background ffmpeg slot as scrub thumbnails and waits for live streams the same way.

Turn it off with **Settings > Player > Detect intros and credits**. Times already found stay in place; nothing new is scanned.

### Space and time

Fingerprints are kept in the database, so a rescan after a settings change does not read the files again unless they changed. The sound fingerprint takes about 3.75 KB per minute of audio read, the harmony fingerprint about 1.4 KB per minute. A 45-minute episode needs roughly 190 KB with recaps on (it reads all 45 minutes) and about 90 KB with them off (it reads the first 10 and last 7 minutes). Reading the middle of each episode makes a scan with recaps take longer, mostly the time ffmpeg needs to decode the extra audio.

### Where segment times come from

Each episode can have intro, credits and recap times from three places. The first that has one wins:

1. **Manual**: times you entered yourself. Once you save an episode, **only** its manual times count, so saving with empty boxes means "no skip buttons for this episode".
2. **Chapters**: chapter names in the file such as "Intro", "Opening", "Recap", "Credits" or "Ending".
3. **Detected**: the audio detection above.

Detected times belong to the exact file they came from. When a file is replaced, its detected times are dropped and the season is scanned again.

### Fixing times by hand (admins)

Open the show, find the season, and press **Intro & credits** in the season header (it shows once the season has files). The dialog lists every episode with:

- the intro and credits start and end as `m:ss` (or `h:mm:ss`, or plain seconds),
- where each came from: **Manual**, **Chapter**, **Detected** or **None**,
- **Save**, which makes that episode's times manual,
- **Reset to detected**, which drops the manual times so chapters and detection count again.

**Scan this season** queues the season for detection right away, even if nothing changed. The line under the help text says when it was last scanned, or why the last scan failed.

### What it does not catch

- Intros with **dialogue over the music** are found by the harmony fingerprint, but where the talking covers the start of the theme the intro may be found a few seconds late. Loud sound effects over the music can still hide it. Use chapters or manual times for those.
- Intros that change every episode (for example a different song each week) are not found.
- Recaps made of clips that are not in the earlier three episodes (or that were re-edited with new music) may be found shorter or not at all.
- A recap that is only a few seconds long, or that starts later than 30 seconds into the episode, is not detected.
- When an episode has more than one file (versions), only its main file is checked.
- Episodes whose length is unknown (no media info yet) are skipped until the library scan reads them.

## Troubleshooting

**No scrub thumbnails after playing a file.** They are made in the background and can take a few minutes, longer while all live video slots are busy. Check that the setting is not **Off**, and that ffmpeg is found (**System > Status**). A file ffmpeg cannot read gets none.

**Skip Intro or Skip Recap shows at the wrong time.** Open **Intro & credits** for the season, correct the times and press **Save**. If a whole season is off, check whether the files have chapters with misleading names; manual times beat chapters.

**A season never gets intro times.** It needs two or more episodes that share the intro audio. Open the dialog and look at the scan line: "Not scanned yet" means it has not run (try **Scan this season**); a failure message names the cause, often ffmpeg missing or an unreadable file.

See also: [Hardware transcoding](../using/hardware-transcoding.md) for how live video slots are used.

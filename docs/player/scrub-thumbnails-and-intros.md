# Scrub thumbnails and intro detection

Two things help you move around inside a video in the [player](../using/player.md):

- **Scrub thumbnails**: small pictures above the progress bar while you drag or seek.
- **Skip Intro and Skip Credits**: buttons that show up during an episode's intro and credits.

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

Episode thumbnails and subtitles converted for the player are kept next to them, in `cache/player/thumbs/` and `cache/player/subtitles/`. When a file changes, the copies made for its old version are deleted as the new ones are made. Every six hours the oldest of these are removed while the two folders hold more than 2 GB; they are made again when needed.

**Settings > Player** shows how much space the sheets use. **Clear scrub thumbnails** deletes them all. They are made again when needed.

Apps and TVs load the sheets through signed links that expire like stream links, so they work without a sign-in cookie.

## Intro and credits detection

Most shows play the same intro and the same end credits music in every episode of a season. Arclight listens for that.

### How it works

1. For each episode it reads the audio of the **start** (the first 40 %, at most 10 minutes) and the **end** (the last 35 %, at most 7 minutes), mixed down to low-quality mono.
2. It turns that audio into a compact "fingerprint" and compares each episode with its nearest neighbours in the season (up to three).
3. A stretch of at least 15 seconds that matches near the start is the **intro** (at most 2.5 minutes). A matching stretch near the end is the **credits**; if it runs to within 5 seconds of the end, the credits run to the end of the file.
4. An episode gets a segment only when at least half of its comparisons agree. The time stored is the middle value of those comparisons.

A season needs **at least two episodes with files**. Specials (season 0) are checked like any other season, but they rarely share an intro.

### When it runs

- About **10 minutes after episodes are imported**. A season pack lands as many imports, so Arclight waits for the last one.
- **Every night at 03:40** for any season whose files changed since its last scan.
- When you press **Scan now** under **Settings > Player** (the `player-segments` job), or **Scan this season** in the season's intro and credits dialog.

Seasons that did not change are skipped. Detection uses the same single background ffmpeg slot as scrub thumbnails and waits for live streams the same way.

Turn it off with **Settings > Player > Detect intros and credits**. Times already found stay in place; nothing new is scanned.

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

- Intros with **dialogue or sound effects over the music** that differ between episodes may match too little to count. Use chapters or manual times for those.
- Intros that change every episode (for example a different song each week) are not found.
- **Recaps** are not detected. They come from chapters or manual times only.
- When an episode has more than one file (versions), only its main file is checked.
- Episodes whose length is unknown (no media info yet) are skipped until the library scan reads them.

## Troubleshooting

**No scrub thumbnails after playing a file.** They are made in the background and can take a few minutes, longer while all live video slots are busy. Check that the setting is not **Off**, and that ffmpeg is found (**System > Status**). A file ffmpeg cannot read gets none.

**Skip Intro shows at the wrong time.** Open **Intro & credits** for the season, correct the times and press **Save**. If a whole season is off, check whether the files have chapters with misleading names; manual times beat chapters.

**A season never gets intro times.** It needs two or more episodes that share the intro audio. Open the dialog and look at the scan line: "Not scanned yet" means it has not run (try **Scan this season**); a failure message names the cause, often ffmpeg missing or an unreadable file.

See also: [Hardware transcoding](../using/hardware-transcoding.md) for how live video slots are used.

# Music: cue sheets, tags and covers

Some albums arrive as one big audio file (an "image", such as `Album.flac` or `Album.wav`) with a `.cue` sheet that lists where each track starts. This page explains how Arclight imports those, and covers the optional tagging, cover art and ReplayGain settings for music.

All of these settings sit in the **Audio import** section of Settings > Media Management, which shows while music is turned on. They are saved with that section's own **Save** button.

## Single-file albums with a cue sheet

Arclight treats a download as a cue image when its folder has a `.cue` file and far fewer audio files than the album has tracks (usually exactly one). It reads the sheet, matches the cue tracks against the album's selected edition by title, track number and length, and then follows the **Single-file albums with a cue sheet** setting:

| Choice | What happens |
|---|---|
| Split into one file per track (default) | ffmpeg cuts the image into one file per track. Lossless images (FLAC, WAV, APE, WavPack and so on) become FLAC files, and lossy images are cut without re-encoding. The new files are named and imported like any other album. The `.cue` file is not copied, because it would no longer match. The `.log` file and other extras are copied |
| Keep the image and cue sheet whole | The image is placed in the album folder under its original file name, next to its `.cue` file. Every track of the album points into that one file, so the album counts as complete. Rescans keep it that way |
| Leave for manual import | The download waits in Activity > Manual import with the message "album image with a cue sheet, Manual Import required" |

How splitting works:

- The cut happens in a hidden `.arclight-staging` folder inside the root folder. The finished files are then moved into the album folder, and the staging folder is removed. The download itself is never changed, so it can keep seeding.
- If ffmpeg cannot be found, or a cut fails, Arclight falls back to keeping the image whole and notes this in the log.
- A track starts at its `INDEX 01` and runs until the next track's `INDEX 01`. The last track runs to the end of the image. Pregaps stay at the end of the track before them, as on the CD.

Cue sheets in UTF-8, in UTF-16 with a byte-order mark, and in the older Windows-1252 encoding are all read correctly. Sheets that list several `FILE` entries (one image per disc, or one file per track) work too. A sheet whose `FILE` names a `.wav` that was later converted to `.flac` is matched by file name without the extension.

A sheet goes to manual import whatever the setting if:

- it cannot be read,
- its files cannot be found next to it,
- its track times are out of order, or
- its tracks do not match the album well enough. This uses the same **Track match threshold** as normal files.

Cue images are matched against the album's selected edition only. If the image is a different edition, change the album's edition first, or import it by hand.

## Tags, cover art and ReplayGain

By default Arclight never changes the contents of an audio file. Media servers read the tags the files came with. The four switches below are all off until you turn them on:

| Setting | What it does |
|---|---|
| Write tags | Writes title, artist, album artist, album, date, track and disc numbers with totals, genre, ISRC and the MusicBrainz IDs from the album's metadata |
| Embed cover art | Puts the album folder's cover image (`cover.jpg`, `folder.jpg`, `front.jpg` and similar) into FLAC, MP3 and M4A files |
| Save cover art | Downloads `cover.jpg` from the Cover Art Archive when the album folder has no cover. This contacts `coverartarchive.org` during import, which is why it is off by default. Most media servers fetch artwork on their own |
| Measure ReplayGain | Measures each track's loudness on import and stores the result in the library. It is also written into the file whenever the file may be changed (see below) |

### Hard links are never changed

A hard link is the same data as the file in the download folder, so changing it would also change the download and break seeding. Arclight writes tags, covers and ReplayGain only into library files that were **copied**, **moved** or **cut from a cue image**. Hard-linked files are left exactly as they are. ReplayGain is still measured for them and stored in the library. See [Hardlink, copy or move](media-management.md#hardlink-copy-or-move) for when each transfer is used.

Kept cue images are never retagged, because one file holds every track.

### How files are written

Tags are written with ffmpeg in stream-copy mode, so the audio is not re-encoded. The result goes to a hidden temporary file next to the original (`.name.arclight-tagging.ext`), and that file is renamed over the original only once ffmpeg has finished without errors. If anything fails, the original stays untouched, the temporary file is removed, and the import finishes with a warning such as "Tags not written: …".

Tag names follow the common conventions, so taggers and media servers recognise them:

| Format | Numbers | MusicBrainz IDs | ReplayGain |
|---|---|---|---|
| FLAC, Ogg Vorbis, Opus | `TRACKNUMBER`, `TRACKTOTAL`, `DISCNUMBER`, `DISCTOTAL` | `MUSICBRAINZ_TRACKID`, `MUSICBRAINZ_RELEASETRACKID`, `MUSICBRAINZ_ALBUMID`, `MUSICBRAINZ_RELEASEGROUPID`, `MUSICBRAINZ_ARTISTID`, `MUSICBRAINZ_ALBUMARTISTID` | `REPLAYGAIN_TRACK_GAIN`, `REPLAYGAIN_TRACK_PEAK` |
| MP3 (ID3v2.4) | `track` and `disc` as `n/total` | `TXXX` frames ("MusicBrainz Album Id" and so on) | `TXXX` frames |
| M4A / AAC | `track` and `disc` as `n/total` | Not written | Not written |

Opus and Vorbis files cannot carry an embedded picture through ffmpeg, so **Embed cover art** skips them. Only track gain is measured. Album gain is not calculated.

## ffmpeg

Splitting, tagging and ReplayGain need ffmpeg. The Docker image includes it. For other installs, put `ffmpeg` on the `PATH` or set `ARCLIGHT_FFMPEG` to its full path. This is the same ffmpeg used by [transcode rules](media-management.md#transcode-rules-optional). When ffmpeg is missing, splitting falls back to keeping the image, and tags, covers and ReplayGain are skipped with a warning in the log. Imports still finish.

## Music quality profiles

When music is first turned on, Arclight creates these quality profiles. All of them allow upgrades until the cutoff is reached:

| Profile | Allowed | Cutoff |
|---|---|---|
| Lossless | ALAC, FLAC, other lossless | FLAC |
| Hi-Res | Lossless plus 24-bit FLAC and ALAC | FLAC-24bit |
| High-quality lossy | MP3 V0 and 320, AAC 256 and up, Opus | MP3-320 |
| Lossless, lossy fallback | MP3 V0 and 320, AAC 256 and up, Opus, and lossless | FLAC: takes good lossy now and keeps upgrading until a lossless copy arrives |
| Portable (Opus/AAC/MP3) | MP3 256, V0 and 320, AAC 256 and up, Opus, Vorbis | MP3-VBR-V0: small files that suit phones and players |
| Any (music) | Everything from MP3 192 up | FLAC |

These profiles are created only once. Installs that already had music turned on before the **Lossless, lossy fallback** and **Portable** profiles were added do not get them automatically. You can add them by hand on Settings > Profiles with the values above. See [Quality profiles](quality-profiles.md).

## Related

- [Media management](media-management.md)
- [Activity](activity.md) (manual import)
- [Quality profiles](quality-profiles.md)
- [Folders and hardlinks](../getting-started/folders-and-hardlinks.md)

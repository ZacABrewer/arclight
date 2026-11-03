# Player

Arclight has a built-in player for your own music, audiobooks, movies and TV shows. It runs in the browser at `/player`, apart from the main app, so you can open it on a phone, a tablet or a computer and just listen.

The player plays files that Arclight already has on disk. Items without a file do not show up. Music, audiobooks, movies and TV work now. Podcasts show as "Coming soon" and are planned for later.

The player is a preview. It is off until an admin turns it on.

## Turning the player on (admins)

1. Open **Settings > General > Features** and make sure the sections you want (**Music**, **Audiobooks**, **Movies**, **TV**) are on. The player only shows the sections you have enabled.
2. Open **Settings > Player** and switch on **Turn on the player**.
3. Save.

Admins can always use the player once it is on. Everyone else needs access (see below).

### Settings > Player

| Setting | What it does | Default |
| --- | --- | --- |
| Turn on the player | Adds the player at `/player`. | Off |
| Stream outside the home network | Lets people listen while away from home. Each user also needs remote streaming on. | Off |
| Remote bitrate limit | Files above this bitrate are converted on the fly for remote listeners. `0` means no limit. | 320 kbps |
| Stream link lifetime | How long links for casting and other players keep working. 1 to 72 hours. | 6 hours |
| Playback engine | **Arclight** plays files itself. **Jellyfin** streams them through a Jellyfin or Emby server. See [Playing through Jellyfin](#playing-through-jellyfin). | Arclight |
| Jellyfin server | Which Jellyfin or Emby server to stream through. Shown when the engine is Jellyfin. | First enabled server |
| Movies & TV | Lets the player show and play movies and episodes. | On |
| Live video slots | How many videos the server may convert or repackage at once, for everyone together. Each one costs CPU or GPU time. | 3 |
| Live video slots per user | How many of those one person may use. Starting a new video replaces that person's oldest one. | 1 |

Arclight decides "remote" from the address a request comes from. A request from outside your home network counts as remote.

Remote streaming stays off until you allow it. Turn it on only if you have a safe way to reach Arclight from outside, such as a VPN or a reverse proxy with sign-in. See [Users and security](users-and-security.md).

## Giving users access (admins)

1. Open **Users** and pick a user.
2. Open the **Player** tab.
3. Set the options and press **Save player access**.

| Option | What it does |
| --- | --- |
| Can use the player | Lets this person open `/player`. Off by default. |
| Stream away from home | Lets this person listen from outside the home network. It also needs **Stream outside the home network** on in **Settings > Player**. On by default. |
| Bitrate limit | A cap for this person in kbps. `0` uses the server's limit. |

A user's own bitrate limit wins over the server's remote limit. Admins always have access. The settings on an admin's Player tab only apply if their role changes.

## Opening the player

Go to `/player` on your Arclight address. The home page shows **Continue listening**: albums and audiobooks you started, so you can pick up where you left off. The top bar has **Music**, **Books** (audiobooks), **Movies & TV** and search. Podcasts are greyed out for now.

## Music

Open **Music** for the music home. It has shelves such as **Jump back in**, **Recently played**, **On this day**, **Recently added** and **Your playlists**.

- **Albums** and **Artists** list your library. Filter by name, pick a genre, jump to a letter, sort, and switch between grid and list.
- An **album** page shows the tracklist, split by disc. Press **Play** or **Shuffle**, or play a single track.
- An **artist** page shows top tracks and albums, grouped as albums, EPs, singles and other releases.
- Each track has a menu: **Play next**, **Add to queue**, **Add to playlist**, **Go to album** and **Go to artist**.
- A **Lossless** label marks lossless files.

### Playlists

Open **Playlists** and press **New playlist**, or use **Add to playlist** on any track. You can create a new playlist right from that menu. Inside a playlist you can rename it, move tracks up and down, remove tracks and delete the playlist. Deleting a playlist never deletes the music.

## Audiobooks

Open **Books** for your audiobooks: **Continue listening**, **Recently added**, series shelves, and **All audiobooks** with a search box for title, author and narrator.

An audiobook page shows the author, the narrator, the series, the description and the chapter list. Press **Play**, or **Resume** to continue where you left off. Use **Mark finished** or **Mark unfinished** to change its state yourself. A book counts as finished once you have played 90% of it.

An audiobook is one item, even when it is made of many files. The progress bar, the chapters and the time left cover the whole book. If a book has no chapter list, it plays as one long track.

While a book plays you can:

- **Chapters**: open the chapters drawer to jump to any chapter, or use the previous and next chapter buttons.
- **Skip**: go back or forward 30 seconds.
- **Speed**: choose from 0.5x to 3.5x. Arclight remembers the speed for each book.
- **Bookmarks**: add a bookmark at the current time, with an optional note. Open the bookmarks drawer to jump to one or remove it.
- **Sleep timer**: stop after 5, 10, 15, 30, 45, 60, 90 or 120 minutes, or at the end of the chapter. The time left is shown next to the timer.

Your place is saved as you listen, so you can start on one device and continue on another.

## Search

Press the search button in the top bar. Type a song, album, artist, audiobook, author or narrator. Results cover music and audiobooks. Only items with files can be found.

## The queue, the mini-player and Now playing

When something plays, a **mini-player** stays at the bottom of every page. It shows the title, play and pause, and progress. Select it to open **Now playing**.

**Now playing** has:

- Big cover art, the title and a seek bar.
- Play, pause, previous, next, shuffle and repeat (off, all, one).
- Volume and mute.
- A **format badge** (see below).
- **Volume levelling** (ReplayGain): **Off**, **Track** or **Album**. It uses the loudness tags in your files so tracks play at a similar volume.
- The **queue**.

The queue shows what plays next and where it came from (an album, an artist, a playlist or a search). You can play any entry, move entries up and down, remove them, or **Clear upcoming**. Use **Play next** and **Add to queue** on a track to build it.

### Gapless playback

Arclight loads the next track before the current one ends, so albums that flow from one track into the next, such as live and concept albums, play without a gap.

## Keyboard, media keys and lock screen

These keys work in the player:

| Key | What it does |
| --- | --- |
| Space | Play or pause |
| Left arrow | Back 10 seconds (30 seconds for audiobooks) |
| Right arrow | Forward 10 seconds (30 seconds for audiobooks) |
| N | Next |
| P | Previous |
| M | Mute |

The player also works with your device's media controls: the keyboard's media keys, headphone buttons, the lock screen and notification shade on a phone, and the media panel in your browser. They show the title, artist and cover art, and offer play, pause, seek and stop. For music they also offer previous and next. For audiobooks they offer back and forward skips instead.

## Direct play and transcoding

The **format badge** on Now playing shows how the file reaches you:

- `FLAC · DIRECT` means the original file is sent as it is. This is the default and gives the best quality.
- `AAC · TRANSCODE` means Arclight converts the audio on the fly. It does this when the file is above your bitrate limit, which usually happens for remote listeners. It needs ffmpeg on the server.
- `· VIA JELLYFIN` at the end, for example `FLAC · DIRECT · VIA JELLYFIN`, means a Jellyfin or Emby server is sending the audio. See [Playing through Jellyfin](#playing-through-jellyfin).

Converting costs server power, so Arclight only does it when it has to. A converted stream cannot be fetched in ranges, so a seek starts a new conversion from that point. This can take a moment.

## Movies & TV

Movies and episodes play in the same player. Shows open on their next episode, and an episode can go straight on to the next one. Content restrictions on a user (certification limits, hiding adult content) hide those titles from that person everywhere, including search and links.

How a video reaches you depends on what your device can play:

- **Direct**: the original file is sent as it is, with full seeking. This is the best quality and costs the server nothing.
- **Remux**: the video and audio are fine for your device but the file type is not (often MKV). Arclight repackages it as MP4 on the fly without changing the picture. This uses little CPU.
- **Transcode**: Arclight converts the video, for example a 10-bit HEVC or HDR file for a browser, or to stay under a remote bitrate limit. HDR is turned into SDR when your screen cannot show it. Arclight uses the server's Intel graphics (Quick Sync or VAAPI) when ffmpeg can reach it, and falls back to the CPU otherwise.

The player says which one it uses and why. Remuxed and converted streams cannot be fetched in ranges, so seeking starts a new stream from that point. When every live video slot is in use, the player says the server is busy. Try again in a moment, or pick a lower quality.

Text subtitles (SRT, ASS, WebVTT, embedded or next to the file) can be turned on and off at any time. Picture subtitles (PGS, VobSub) have to be burned into the picture, which means a transcode.

To run conversions in Docker with Intel graphics, pass the GPU into the container (for example `--device /dev/dri:/dev/dri`).

## Sign in to the Arclight app

The Arclight app is the player on its own, for phones and tablets. It can keep music and books on the device to play offline. To sign it in:

1. In the player, open the account menu (top right) and choose **Sign in to the Arclight app**.
2. In the app, choose to scan a code and point the camera at the QR code. Or type the **server address** and the **code** shown under it.

The code works once and expires after five minutes. Press **New code** for another one. You can also sign in in the app with your Arclight username and password (and your authenticator code, if you use two-factor sign-in). Accounts that sign in through a media server or only with a passkey use the code.

**Your devices**, under the code, lists every phone or tablet signed in with your account. **Remove** signs that device out at once. Changing your password, or an admin resetting it, signs every device out too.

The app needs the same player access as the browser. If the player is off, or your account may not use it, the app cannot sign in.

## Sign in on a TV

The Arclight app on Android TV signs in without a keyboard:

1. On the TV, choose to sign in with a code. The TV shows a short code and an address ending in `/player/link`.
2. On your phone or computer, open that address, sign in to Arclight if asked, and type the code.
3. The TV signs in by itself within a few seconds.

The code expires after ten minutes and works once. The TV is then signed in as the person who typed the code, so it shows that person's library, restrictions and progress. It appears under **Your devices** like any other device, where **Remove** signs it out.

## Continue listening

Arclight saves your place about every 10 to 15 seconds, and when you pause, seek or close the page. The home page and the **Books** page show what is in progress. Anything with less than 2% played has nothing to resume. Anything past 90% counts as played.

## Playing through Jellyfin

The built-in player can let a Jellyfin or Emby server do the streaming and converting, while you keep using Arclight's player, queue and progress.

1. Connect the server under **Settings > Media servers** (see [Media servers](media-servers.md)). Its music and audiobook libraries need to point at the same folders as Arclight's.
2. Open **Settings > Player**. Under **Playback engine**, pick **Jellyfin**. The choice is greyed out until a Jellyfin or Emby server is set up.
3. Pick a **Jellyfin server**, or leave **First enabled server**.
4. Press **Test**. It connects to the server and tries to find one of your audio files there.
5. Press **Save changes**.

What stays the same: who may listen, remote rules, bitrate limits and stream links are still checked by Arclight first. Your Jellyfin API key stays on the server and is never sent to the browser.

How files are matched: Arclight finds each file on Jellyfin by its path. The file name and at least one folder above it must be the same on both. Paths that match more than one item are skipped. The first time Arclight looks up a file Jellyfin does not know, it may read the server's whole audio list, which can take a moment on big libraries. The list is kept for 10 minutes.

When Jellyfin cannot help: if a file is not on Jellyfin, or the server is down or refuses the request, Arclight plays the file itself instead. A warning goes to the log. The format badge then shows no `VIA JELLYFIN`.

Plex cannot be used as an engine. If you prefer to play in the Jellyfin, Emby or Plex app itself, use that app instead.

## Troubleshooting

**I picked Jellyfin, but the badge never says "VIA JELLYFIN".**
Press **Test** in **Settings > Player**. If it connects but finds no sample file, Jellyfin's library paths do not match Arclight's. Check that both see the same folders and that Jellyfin has scanned them. The log names the files that were not found.

**I cannot see the player, or it says "The player isn't turned on for your account".**
An admin has to turn it on in **Settings > Player**, and allow your account under **Users > your user > Player > Can use the player**. If you are the admin, check both.

**Music or Books is missing from the top bar.**
The matching feature is off. Turn on **Music** or **Audiobooks** in **Settings > General > Features**.

**I am away from home and playback is refused.**
Remote streaming needs two switches: **Stream outside the home network** in **Settings > Player**, and **Stream away from home** on your user's Player tab. Check both.

**Remote playback is converted, or sounds worse.**
Your remote bitrate limit is lower than the file. Raise **Remote bitrate limit** (or your user limit), or set it to `0` for no limit.

**A converted stream will not start and the server says it is busy.**
Arclight runs at most 6 conversions at once. Wait a few seconds and press play again. To need fewer conversions, raise the remote bitrate limit so more files play as they are.

**A converted stream will not start and ffmpeg is missing.**
Conversion needs ffmpeg on the server. Install it, or raise the bitrate limit so files play as they are.

**"The browser blocked playback."**
Browsers do not allow sound before you interact with the page. Press play once.

**"The stream stopped."**
The connection dropped. Check your network and press play.

**"This file cannot be played in this browser."**
The browser does not support that format. Try another browser.

**A cast or external player link stopped working.**
Stream links expire after the **Stream link lifetime**. Start again to get a new link.

See also [Music library](music-library.md), [Books](books.md), [Users and security](users-and-security.md) and [Troubleshooting](../TROUBLESHOOTING.md).
